// Umbra PDF for the desktop: serves the web core (core/dist) to this computer only (127.0.0.1), and reads text
// with ONNX Runtime for Node (native, multi-threaded). Same PP-OCRv5 models and steps as Android (PpOcr.kt),
// over the same messages as the Android bridge: binary [id, w, h, limit] (int32 LE) + RGBA, or {"id","kind":"warm"}.
// Documents never leave the computer: pages arrive from the browser on this machine and only text lines go back.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism, platform } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { detectStrips, flipStrip, parseDict, readStrips, recognise, useTensor, type OrtSession } from '../../core/src/engine/ppocr.pipeline';

type Ort = typeof import('onnxruntime-node');
const ort = createRequire(import.meta.url)('onnxruntime-node') as Ort;

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (k: string) => process.argv.includes(k);
// Optional settings.json next to server.mjs (the installed app ships one): {"port", "threads", "gpu"}. Flags win.
const SETTINGS_FILE = resolve(arg('--settings') ?? resolve(here, 'settings.json'));
const settings = ((): { port?: number; threads?: number; gpu?: boolean } => {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Ignoring ${SETTINGS_FILE}: ${(e as Error).message}`);
    return {};
  }
})();
const PORT = Number(arg('--port') ?? process.env.UMBRA_PORT ?? settings.port ?? 5180);
const PORT_TRIES = PORT === 0 ? 1 : 10; // Port taken by another program: try the next ones.
const ROOT = resolve(arg('--root') ?? resolve(here, '../../core/dist'));
const MODELS = resolve(arg('--models') ?? resolve(here, '../../core/models/ppocrv5'));
const THREADS = Math.max(1, Number(arg('--threads') ?? settings.threads ?? Math.min(8, availableParallelism())));
const GPU = flag('--gpu') || settings.gpu === true; // DirectML (Windows): try it with --gpu; the CPU is used if it can't start.
const HOST = '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.onnx': 'application/octet-stream', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile',
};
// Same policy as the page's own CSP meta (core/vite.config.ts), plus what only a header can say.
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
const SECURITY = {
  'content-security-policy': CSP,
  // Cross-origin isolation: the in-browser OCR fallback can use WASM threads.
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};
const MAX_PIXELS = 64e6;

// ---------- OCR ----------
useTensor((data, dims) => new ort.Tensor('float32', data, dims));
interface Engine { det: OrtSession; rec: OrtSession; chars: string[]; load: number; ep: string }
type Lang = 'en' | 'ch';
/** One engine per text language (English; Chinese + English). The page says which with its warm-up message. */
const engines = new Map<Lang, Promise<Engine>>();
let lang: Lang = 'en';

async function createSessions(ep: 'dml' | 'cpu', l: Lang): Promise<[OrtSession, OrtSession]> {
  const opts: import('onnxruntime-node').InferenceSession.SessionOptions = ep === 'dml'
    ? { executionProviders: ['dml'], graphOptimizationLevel: 'all', enableMemPattern: false, executionMode: 'sequential' }
    : { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: THREADS, interOpNumThreads: 1 };
  const [d, r] = await Promise.all([readFile(resolve(MODELS, 'det.onnx')), readFile(resolve(MODELS, `rec_${l}.onnx`))]);
  return Promise.all([ort.InferenceSession.create(d, opts), ort.InferenceSession.create(r, opts)]) as Promise<[OrtSession, OrtSession]>;
}

function loadEngine(l: Lang = lang): Promise<Engine> {
  let engine = engines.get(l);
  if (engine) return engine;
  engine = (async () => {
    const t0 = performance.now();
    const chars = parseDict(await readFile(resolve(MODELS, `dict_${l}.txt`), 'utf8'));
    let ep = 'cpu', sessions: [OrtSession, OrtSession] | null = null;
    if (GPU) {
      try { sessions = await createSessions('dml', l); ep = 'dml'; } catch (e) { console.warn(`GPU (DirectML) unavailable, using the CPU: ${(e as Error).message}`); }
    }
    sessions ??= await createSessions('cpu', l);
    return { det: sessions[0], rec: sessions[1], chars, load: Math.round(performance.now() - t0), ep };
  })().catch((e) => { engines.delete(l); throw e; });
  engines.set(l, engine);
  return engine;
}

// One read at a time (like Android's single OCR thread): each read already uses all the threads.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = queue.then(f, f); queue = p.catch(() => {}); return p; };

async function readImage(id: number, w: number, h: number, limit: number, px: Uint8Array): Promise<object> {
  const e = await loadEngine();
  const t0 = performance.now();
  const d = await detectStrips(e.det, { width: w, height: h, data: px }, limit);
  const t1 = performance.now();
  const r = await readStrips(d.quads, d.strips, d.widths, (s, ws, flip) => recognise(e.rec, e.chars, flip ? s.map((x, i) => flipStrip(x, ws[i])) : s, ws));
  const ms = { load: e.load, det: Math.round(t1 - t0), rec: Math.round(r.recMs), retry: Math.round(r.retryMs), lines: d.strips.length, threads: e.ep === 'dml' ? 0 : THREADS, flipped: r.flipped };
  console.log(`OCR ${w}x${h} (det ${limit}): ${Math.round(performance.now() - t0)} ms = det ${ms.det} + rec ${ms.rec} (${ms.lines} lines) + retry ${ms.retry}${r.flipped ? ', upside down' : ''}`);
  return { id, ok: true, lines: r.lines, ms };
}

async function ocr(body: Buffer, json: boolean): Promise<object> {
  let id = 0;
  try {
    if (json) {
      const m = JSON.parse(body.toString('utf8')) as { id: number; kind?: string; lang?: string };
      id = m.id;
      if (m.kind !== 'warm') throw new Error('unknown request');
      if (m.lang === 'en' || m.lang === 'ch') lang = m.lang;
      const e = await loadEngine();
      return { id, ok: true, load: e.load, threads: e.ep === 'dml' ? 0 : THREADS, ep: e.ep, lang };
    }
    if (body.length < 16) throw new Error('short request');
    id = body.readInt32LE(0);
    const w = body.readInt32LE(4), h = body.readInt32LE(8), limit = body.readInt32LE(12);
    if (w <= 0 || h <= 0 || w * h > MAX_PIXELS || body.length < 16 + w * h * 4) throw new Error('bad image size');
    return await serial(() => readImage(id, w, h, limit, body.subarray(16, 16 + w * h * 4)));
  } catch (e) {
    return { id, ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// ---------- HTTP ----------
const allowedHosts = () => [`${HOST}:${port()}`, `localhost:${port()}`];
const port = () => (server.address() as { port: number } | null)?.port ?? PORT;

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...SECURITY, 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > max) { fail(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  // Only pages opened from this computer at this address (no other site, no DNS rebinding).
  if (!allowedHosts().includes(req.headers.host ?? '')) return send(res, 403, 'Forbidden');
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) return send(res, 403, 'Forbidden');
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, 'Forbidden');
    if (url.pathname === '/api/caps' && req.method === 'GET') {
      return send(res, 200, JSON.stringify({ app: 'umbra-pdf', native: true, threads: THREADS, gpu: GPU }), 'application/json');
    }
    if (url.pathname === '/api/ocr' && req.method === 'POST') {
      try {
        const body = await readBody(req, 16 + MAX_PIXELS * 4);
        return send(res, 200, JSON.stringify(await ocr(body, /json/.test(req.headers['content-type'] ?? ''))), 'application/json');
      } catch (e) { return send(res, 413, JSON.stringify({ id: 0, ok: false, error: (e as Error).message }), 'application/json'); }
    }
    return send(res, 404, 'Not found');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  try {
    const path = resolve(ROOT, '.' + decodeURIComponent(url.pathname).replace(/\/$/, '/index.html'));
    if (path !== ROOT && !path.startsWith(ROOT + sep)) throw new Error('outside');
    let body: string | Buffer = await readFile(path);
    // The page marks itself as served here, so it asks this server for OCR (core/src/platform/localServer.ts).
    if (path === resolve(ROOT, 'index.html')) body = body.toString('utf8').replace('<head>', '<head>\n    <meta name="umbra-server" content="desktop">');
    send(res, 200, body, MIME[extname(path).toLowerCase()] ?? 'application/octet-stream');
  } catch { send(res, 404, 'Not found'); }
});

function openBrowser(url: string) {
  if (flag('--no-open')) return;
  const [cmd, args] = platform() === 'win32' ? ['explorer.exe', [url]] : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* open it by hand */ }
}

/** Is Umbra PDF already running on this port? Then just open it. */
function alreadyRunning(p: number): Promise<boolean> {
  return new Promise((ok) => {
    const r = httpRequest({ host: HOST, port: p, path: '/api/caps', headers: { host: `${HOST}:${p}` }, timeout: 1500 }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { ok((JSON.parse(s) as { app?: string }).app === 'umbra-pdf'); } catch { ok(false); } });
    });
    r.on('error', () => ok(false));
    r.on('timeout', () => { r.destroy(); ok(false); });
    r.end();
  });
}

let tryPort = PORT;
server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    if (await alreadyRunning(tryPort)) {
      console.log(`Umbra PDF is already running: http://${HOST}:${tryPort}/`);
      openBrowser(`http://${HOST}:${tryPort}/`);
      process.exit(0);
    }
    if (tryPort < PORT + PORT_TRIES - 1) {
      console.log(`Port ${tryPort} is in use by another program, trying ${tryPort + 1}.`);
      return server.listen(++tryPort, HOST);
    }
    console.error(`Port${PORT_TRIES > 1 ? `s ${PORT}-${tryPort} are` : ` ${PORT} is`} in use by other programs. ` +
      `Set another "port" in ${SETTINGS_FILE} or start with --port <number>.`);
  } else console.error(e.message);
  process.exit(1);
});

server.once('listening', () => {
  const url = `http://${HOST}:${port()}/`;
  console.log(`Umbra PDF is running at ${url}  (OCR: ${GPU ? 'GPU (DirectML) if available, else ' : ''}${THREADS} CPU threads)`);
  console.log('Only this computer can open it. Press Ctrl+C to stop.');
  void loadEngine().then((e) => console.log(`OCR engine ready in ${e.load} ms (${e.ep})`), (err) => console.error(`OCR engine failed to load: ${err.message}`));
  openBrowser(url);
});

readFile(resolve(ROOT, 'index.html')).then(
  () => server.listen(PORT, HOST),
  () => { console.error(`The web app isn't built yet (${ROOT}). Run: npm run web`); process.exit(1); },
);

// Installable web app (iPhone/iPad): serves dist-pwa/ the way GitHub Pages does (a sub-path, no special headers)
// and checks, on an iPhone-sized phone, that it installs, works with no connection, reads scanned text in the
// browser (no server), exports a verified redacted copy and saves through the iOS share sheet.
// Usage: npm run build:pwa && node tests/pwa.mjs [webkit|chromium]   (SHOTS=dir saves screenshots)
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../dist-pwa');
const engine = process.argv[2] ?? 'webkit';
const shots = process.env.SHOTS;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.json': 'application/json' };

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  [${engine}] ${msg}`); if (!cond) failed++; };

const BASE = '/UmbraPDF/';
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(BASE)) throw 0;
    p = resolve(root, '.' + p.slice(BASE.length - 1).replace(/\/$/, '/index.html'));
    if (!p.startsWith(root)) throw 0;
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'max-age=600' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${BASE}`;

const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
const total = JSON.parse(sw.match(/const CORE = (\[.*?\]);/)[1]).length + JSON.parse(sw.match(/const MORE = (\[.*?\]);/)[1]).length;

const browser = engine === 'webkit' ? await webkit.launch()
  : await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({ ...devices['iPhone 15'], serviceWorkers: 'allow' });
// The iOS share sheet: the first call has no fresh tap (NotAllowedError), so the app must ask for one more tap.
await ctx.addInitScript(() => {
  let n = 0;
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => !!d?.files?.length });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
    if (++n === 1) throw new DOMException('no user activation', 'NotAllowedError');
    window.__shared = d.files.map((f) => [f.name, f.size, f.type]);
  } });
});
// Chromium plays an older Safari: no async iteration of streams, no iterator helpers (the app fills them in).
if (engine !== 'webkit') await ctx.addInitScript(() => {
  delete ReadableStream.prototype[Symbol.asyncIterator];
  const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  for (const k of ['map', 'filter', 'flatMap', 'take', 'drop', 'some', 'every', 'find', 'forEach', 'toArray', 'reduce']) delete proto[k];
});
const page = await ctx.newPage();
page.on('requestfailed', (r) => console.log(`diag  [${engine}] request failed: ${r.url()} ${r.failure()?.errorText}`));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${engine}-${name}.png` }); } };

// 1) Install: manifest, icons, service worker, offline copy.
await page.goto(url);
const head = await page.evaluate(async () => {
  const m = document.querySelector('link[rel=manifest]');
  const man = m ? await (await fetch(m.href)).json() : null;
  const icon = await fetch(document.querySelector('link[rel=apple-touch-icon]')?.href ?? 'x');
  return { man, icon: icon.ok && icon.headers.get('content-type'), capable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content };
});
check(head.man?.display === 'standalone' && head.man.icons.length >= 2 && head.man.start_url === './', `manifest: ${JSON.stringify(head.man && { name: head.man.name, display: head.man.display })}`);
check(head.icon === 'image/png' && head.capable === 'yes', 'Home Screen icon and full-screen meta');
await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 60_000 });
console.log(`info  [${engine}] cores: ${await page.evaluate(() => navigator.hardwareConcurrency)}`);
let cached = 0;
for (const t0 = Date.now(); cached < total && Date.now() - t0 < 180_000; await new Promise((r) => setTimeout(r, 1000))) {
  cached = await page.evaluate(async () => {
    const k = (await caches.keys()).find((x) => x.startsWith('umbra-'));
    return k ? (await (await caches.open(k)).keys()).length : 0;
  });
}
check(cached >= total, `offline copy complete: ${cached}/${total} files`);
await shot('1-home');

// 2) No connection from here on: the site is gone (stopping the server works the same in every engine; WebKit's
// offline emulation fails navigations before the service worker can answer them).
await new Promise((r) => { server.close(r); server.closeAllConnections(); });
if (engine !== 'webkit') await ctx.setOffline(true);
await page.reload();
// The app is up once the splash is fading out or gone (it is removed 0.4 s after).
await page.waitForFunction(() => !!window.__umbraTest && !document.querySelector('#splash:not(.out)'), null, { timeout: 30_000 })
  .catch(async (e) => {
    console.log(`diag  [${engine}] url=${page.url()} errors=${JSON.stringify(errors)}`);
    console.log(`diag  [${engine}] ${await page.evaluate(() => `ready=${document.readyState} sw=${!!navigator.serviceWorker?.controller} body=${document.body?.className}`).catch((x) => x.message)}`);
    await shot('2-offline-failed');
    throw e;
  });
check(await page.evaluate(() => !!window.__umbraTest), 'opens with no connection');
await shot('2-offline');

// 3) Scanned page read in the browser (PaddleOCR on WebAssembly), redacted and verified, offline.
const scan = readFileSync(resolve(here, '../../samples/umbra-test-scanned.pdf'));
const r = await page.evaluate(async (b) => {
  const T = window.__umbraTest;
  T.setOcrEngine('paddle');
  await T.load(new Uint8Array(b));
  T.resetOcrStats();
  const t0 = performance.now();
  const text = await T.pageText(0);
  const ms = Math.round(performance.now() - t0);
  const hits = await T.search('public');
  T.applyAll();
  const sizes = T.sizes();
  const ex = await T.export({ dpi: 200, searchable: true }, true);
  return { text, ms, hits: hits.length, ok: ex.report.ok, issues: ex.report.issues, bytes: Array.from(ex.bytes), log: T.ocrStats().log, pages: sizes.length };
}, Array.from(scan));
console.log(`info  [${engine}] OCR page 1: ${r.ms} ms; ${r.log.join(' | ')}`);
check(!r.log.some((l) => /psm\d/.test(l)) && r.log.some((l) => /engines?\)/.test(l)), 'OCR ran on PaddleOCR in the browser (not the Tesseract fallback)');
check(r.text.trim().length > 40 && /public/i.test(r.text), `scanned page read offline (${r.text.trim().length} chars): ${JSON.stringify(r.text.slice(0, 80))}`);
check(r.hits >= 1, `search on scanned page finds "public" (${r.hits})`);
check(r.ok, `redacted export verified (${r.issues.join('; ') || 'no issues'})`);
await shot('3-document');

// 3b) A typed (text) PDF: page text straight from the file, no OCR.
const typed = await page.evaluate(async (b) => {
  const T = window.__umbraTest;
  await T.load(new Uint8Array(b));
  return T.pageText(0);
}, Array.from(readFileSync(resolve(here, '../../samples/umbra-test-text.pdf'))));
check(typed.trim().length > 20, `typed PDF text read (${JSON.stringify(typed.trim().slice(0, 60))})`);

// 4) Saving on iPhone: share sheet, with the extra tap when the first one is too old.
const saved = page.evaluate((b) => window.__umbraTest.savePdf('test-redacted.pdf', new Uint8Array(b)), r.bytes);
await page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 10_000 });
check(await saved === true, 'save: share sheet opens after one more tap');
const shared = await page.evaluate(() => window.__shared);
check(shared?.[0]?.[0] === 'test-redacted.pdf' && shared[0][1] === r.bytes.length && shared[0][2] === 'application/pdf', `save: PDF handed to the share sheet ${JSON.stringify(shared)}`);

const bad = errors.filter((e) => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(e));
check(bad.length === 0, `no page errors${bad.length ? `: ${bad.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

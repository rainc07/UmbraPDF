// Main-thread side of the PaddleOCR engine (see ppocr.worker.ts): page layout around ID cards, and conversion
// of recognised lines into positioned words with per-character boxes (the shape the rest of the app uses).
import type { PpLine, PpRec, PpRequest, PpResponse } from './ppocr.worker';
import { findCards, contentGroups, warpQuad, inQuad, turnQuad, CARD_ASPECT, type Quad } from './cards';
import { vendorUrl } from './paths';
import type { OcrWord } from './ocr';

/**
 * Engines: worker 0 detects lines and cuts strips; recognition of the strips is shared out over all workers
 * (one per spare CPU core, at most 3), since Android WebView offers no WASM threads.
 */
const POOL = typeof navigator !== 'undefined' ? Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;
interface Engine { w: Worker; queue: Promise<unknown> }
let engines: Engine[] = [];
let ready: Promise<boolean> | null = null;
let seq = 0;
const pending = new Map<number, (r: PpResponse) => void>();
const LOAD_TIMEOUT_MS = 60_000;

/** Timings of the last read, for the technical report and benchmarks. */
export const ppStats = { log: [] as string[] };

type Req = PpRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;
/** Send a request to one engine; requests to the same engine run one after another. */
function call(e: Engine, msg: Req, transfer: Transferable[] = []): Promise<PpResponse> {
  const run = () => new Promise<PpResponse>((res) => { const id = ++seq; pending.set(id, res); e.w.postMessage({ ...msg, id }, transfer); });
  const p = e.queue.then(run, run);
  e.queue = p.catch(() => {});
  return p;
}
function spawn(): Engine {
  const w = new Worker(new URL('./ppocr.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<PpResponse>) => { pending.get(ev.data.id)?.(ev.data); pending.delete(ev.data.id); };
  return { w, queue: Promise.resolve() };
}

// ---------- native engine (Android: window.UmbraOcr, see PpOcr.kt) ----------
interface NativePort { postMessage(m: string | ArrayBuffer): void; onmessage: ((e: { data: string }) => void) | null }
type NativeReply = { id: number; ok: boolean; error?: string; lines?: PpLine[]; load?: number; threads?: number;
  ms?: { load: number; det: number; rec: number; retry: number; lines: number; threads: number; flipped: boolean } };
let native: { port: NativePort; binary: boolean } | null = null;
let nativeOff = false;
const nativePending = new Map<number, (r: NativeReply) => void>();

function nativeCaps(): { port: NativePort; binary: boolean } | null {
  const w = window as unknown as { UmbraOcr?: NativePort; UmbraAndroid?: { ocrCaps?(): string } };
  if (!w.UmbraOcr || !w.UmbraAndroid?.ocrCaps) return null;
  try {
    const c = JSON.parse(w.UmbraAndroid.ocrCaps()) as { native: boolean; binary: boolean };
    if (!c.native) return null;
    w.UmbraOcr.onmessage = (e) => { const r = JSON.parse(e.data) as NativeReply; nativePending.get(r.id)?.(r); nativePending.delete(r.id); };
    return { port: w.UmbraOcr, binary: c.binary };
  } catch { return null; }
}
function nativeCall(msg: string | ArrayBuffer, id: number): Promise<NativeReply> {
  return new Promise((res) => { nativePending.set(id, res); native!.port.postMessage(msg); });
}
function b64(u8: Uint8ClampedArray): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function nativeReadLines(c: HTMLCanvasElement, limit: number): Promise<PpLine[]> {
  const t0 = performance.now();
  const img = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  const id = ++seq;
  let msg: string | ArrayBuffer;
  if (native!.binary) {
    const buf = new ArrayBuffer(16 + img.data.length);
    new Int32Array(buf, 0, 4).set([id, c.width, c.height, limit]);
    new Uint8Array(buf, 16).set(img.data);
    msg = buf;
  } else msg = JSON.stringify({ id, w: c.width, h: c.height, limit, b64: b64(img.data) });
  const r = await nativeCall(msg, id);
  if (!r.ok) throw new Error(r.error);
  const m = r.ms!;
  ppStats.log.push(`${c.width}x${c.height} (det ${limit}, native ${m.threads} threads): ${Math.round(performance.now() - t0)} ms = det ${m.det} + rec ${m.rec} (${m.lines} lines) + retry ${m.retry}${m.flipped ? ', upside down' : ''}`);
  return r.lines!;
}

/** Start loading the engine (models + runtime). Resolves false if it can't run here (then Tesseract is used). */
export function ppocrReady(): Promise<boolean> {
  if (ready) return ready;
  native = nativeOff ? null : nativeCaps();
  if (native) {
    ready = (async () => {
      const t0 = performance.now(), id = ++seq;
      const r = await nativeCall(JSON.stringify({ id, kind: 'warm' }), id);
      if (r.ok) { ppStats.log.push(`native engine load: ${Math.round(performance.now() - t0)} ms (${r.threads} threads)`); return true; }
      console.warn('[umbra] native OCR failed to load', r.error);
      native = null; nativeOff = true; ready = null;
      return ppocrReady();
    })();
    return ready;
  }
  ready = (async () => {
    const t0 = performance.now();
    const timeout = () => new Promise<PpResponse>((res) => setTimeout(() => res({ id: 0, ok: false, error: 'timeout' }), LOAD_TIMEOUT_MS));
    try {
      const first = spawn();
      const r = await Promise.race([call(first, { kind: 'init', base: vendorUrl(''), det: true }), timeout()]);
      if (!r.ok) throw new Error(r.error);
      engines = [first];
      ppStats.log.push(`engine load: ${Math.round(performance.now() - t0)} ms`);
      // Extra recognition engines load in the background; each joins the pool when ready.
      for (let i = 1; i < POOL; i++) {
        const e = spawn();
        void call(e, { kind: 'init', base: vendorUrl(''), det: false }).then((x) => { if (x.ok) engines.push(e); else e.w.terminate(); });
      }
      return true;
    } catch (e) {
      console.warn('[umbra] PaddleOCR unavailable, using Tesseract', e);
      engines.forEach((x) => x.w.terminate()); engines = [];
      return false;
    }
  })();
  return ready;
}

export function terminatePpocr(): void { engines.forEach((e) => e.w.terminate()); engines = []; ready = null; pending.clear(); }

/** Recognise strips on all engines in parallel (split by total width). */
async function recogniseAll(strips: Float32Array[], widths: number[], flip: boolean): Promise<PpRec[]> {
  const n = Math.min(engines.length, strips.length);
  if (!n) return [];
  const groups: number[][] = Array.from({ length: n }, () => []), load = new Array(n).fill(0);
  widths.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]).forEach(([w, i]) => { const k = load.indexOf(Math.min(...load)); groups[k].push(i); load[k] += w; });
  const out: PpRec[] = new Array(strips.length);
  await Promise.all(groups.map(async (g, k) => {
    const r = await call(engines[k], { kind: 'rec', strips: g.map((i) => strips[i]), widths: g.map((i) => widths[i]), flip });
    if (!r.ok) throw new Error(r.error);
    g.forEach((i, j) => { out[i] = r.recs![j]; });
  }));
  return out;
}

/** Recognise all text lines in a canvas. Lines come back in canvas pixels, corners in reading order. */
async function readLines(c: HTMLCanvasElement, limit: number): Promise<PpLine[]> {
  if (!(await ppocrReady())) throw new Error('PaddleOCR unavailable');
  if (native) return nativeReadLines(c, limit);
  const tg = performance.now();
  const img = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  const t0 = performance.now();
  ppStats.log.push(`getImageData ${c.width}x${c.height}: ${Math.round(t0 - tg)} ms`);
  const d = await call(engines[0], { kind: 'det', img, limit }, [img.data.buffer]);
  if (!d.ok) throw new Error(d.error);
  const quads = d.quads!, strips = d.strips!, widths = d.widths!;
  const t1 = performance.now();
  // Read everything as upright (the usual case). If most lines read poorly, the region is upside down:
  // read it all again turned 180°. Otherwise retry just the few weak lines turned (mixed pages).
  // (Only lines long enough to be real text count: short low-confidence boxes are specks and edges.)
  let recs = await recogniseAll(strips, widths, false);
  const long = widths.map((w, i) => (w >= 96 ? i : -1)).filter((i) => i >= 0);
  let weak = long.filter((i) => recs[i].conf < 0.7);
  const t2 = performance.now();
  let flipAll = false;
  if (long.length >= 3 && weak.length > long.length / 2) {
    const again = await recogniseAll(strips, widths, true);
    const mean = (r: PpRec[]) => long.reduce((a, i) => a + r[i].conf, 0) / long.length;
    if (mean(again) > mean(recs) + 0.1) { recs = again; flipAll = true; quads.forEach((q, i) => { quads[i] = [2, 3, 0, 1].map((j) => q[j]); }); }
    weak = [];
  }
  weak = weak.slice(0, 6);
  if (weak.length) {
    const again = await recogniseAll(weak.map((i) => strips[i]), weak.map((i) => widths[i]), true);
    weak.forEach((i, k) => { if (again[k].conf > recs[i].conf + 0.1) { recs[i] = again[k]; quads[i] = [2, 3, 0, 1].map((j) => quads[i][j]); } });
  }
  ppStats.log.push(`${c.width}x${c.height} (det ${limit}): ${Math.round(performance.now() - t0)} ms = det ${Math.round(t1 - t0)} + rec ${Math.round(t2 - t1)} (${strips.length} lines, ${engines.length} engines) + retry ${Math.round(performance.now() - t2)} (${weak.length})${flipAll ? ', upside down' : ''}`);
  return quads.map((quad, i) => ({ quad, ...recs[i] })).filter((l) => l.text.trim() && l.conf >= 0.5);
}

type P = [number, number];
const lerp = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** Point at (u along the line, v across it) inside a reading-order quad. */
const at = (q: P[], u: number, v: number): P => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), v);
const box = (ps: P[]) => {
  const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/**
 * Lines → words with character boxes, in reading order. Rows are formed in the text's own frame
 * (projected on the dominant writing direction), so sideways pages and tilted photos order correctly.
 */
export function linesToWords(lines: PpLine[]): OcrWord[] {
  if (!lines.length) return [];
  const dirs = lines.map((l) => Math.atan2(l.quad[1][1] - l.quad[0][1], l.quad[1][0] - l.quad[0][0])).sort((a, b) => a - b);
  const a = dirs[dirs.length >> 1], ca = Math.cos(a), sa = Math.sin(a);
  const proj = (p: P): P => [p[0] * ca + p[1] * sa, -p[0] * sa + p[1] * ca];
  const info = lines.map((l) => {
    const ps = l.quad.map(proj);
    const v = (ps[0][1] + ps[1][1] + ps[2][1] + ps[3][1]) / 4, h = Math.abs((ps[3][1] + ps[2][1] - ps[0][1] - ps[1][1]) / 2);
    return { l, u: Math.min(...ps.map((p) => p[0])), v, h };
  });
  info.sort((x, y) => x.v - y.v);
  const rows: (typeof info)[] = [];
  for (const it of info) {
    const row = rows.find((r) => { const rv = r.reduce((s, q) => s + q.v, 0) / r.length; return Math.abs(rv - it.v) < 0.5 * Math.min(it.h, r[0].h); });
    if (row) row.push(it); else rows.push([it]);
  }
  rows.sort((x, y) => x[0].v - y[0].v);
  const out: OcrWord[] = [];
  rows.forEach((row, n) => {
    row.sort((x, y) => x.u - y.u);
    for (const { l } of row) {
      const pad = 0.04;
      let cur: { text: string; symbols: OcrWord['symbols'] } | null = null;
      const flush = () => {
        if (!cur?.text.trim()) { cur = null; return; }
        const b = box(cur.symbols.flatMap((s) => [[s.x0, s.y0], [s.x1, s.y1]] as P[]));
        out.push({ text: cur.text, confidence: Math.round(l.conf * 100), line: n, symbols: cur.symbols, mapped: true, ...b });
        cur = null;
      };
      // CTC gives each character the time steps where it was emitted, which are narrower than the glyph.
      // Character extents: halfway to the neighbours' centres; the first and last reach the line's ends.
      const cs = l.chars, mid = cs.map((c) => (c.u0 + c.u1) / 2);
      cs.forEach((ch, k) => {
        if (ch.c === ' ') { flush(); return; }
        const u0 = k === 0 ? 0 : Math.max(0, (mid[k - 1] + mid[k]) / 2 - pad / 2);
        const u1 = k === cs.length - 1 ? 1 : Math.min(1, (mid[k] + mid[k + 1]) / 2 + pad / 2);
        const b = box([at(l.quad, u0, -0.04), at(l.quad, u1, -0.04), at(l.quad, u1, 1.04), at(l.quad, u0, 1.04)]);
        cur ??= { text: '', symbols: [] };
        cur.text += ch.c; cur.symbols.push({ text: ch.c, confidence: Math.round(l.conf * 100), ...b });
      });
      flush();
    }
  });
  return out;
}

/** Card read size: native size, kept between 640 and 1280 px wide (the text detector's sweet spot). */
const cardSize = (q: Quad): [number, number] => {
  const long = Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]));
  const W = Math.round(Math.min(1280, Math.max(640, long)));
  return [W, Math.round(W / CARD_ASPECT)];
};

const CARD_WORD = /^(?:KAD|PENGENALAN|MALAYSIA|WARGANEGARA|IDENTITY|PENDUDUK|KETUA|PENGARAH|PENDAFTARAN|MYKAD|MYPR|MYKID|MYKAS)$/i;
const PAGE_LIMIT = 1600;
/** Text detection on a card runs at this width (card text is large); recognition still uses the full-size copy. */
const CARD_DET_LIMIT = 640;

/**
 * Read a page (or a picture) with PaddleOCR. Cards are found first (no OCR) and each is read upright at its
 * own size; the rest of the page is read once with the cards blanked out. Returns canvas-pixel words.
 * `onCardWords` lets the caller post-process a card's words in the card's upright frame (W×H) before mapping.
 * `base`: the page was already read plainly (the native scan). Only the cards are read; their words replace
 * the base words inside them, and the rest of the page keeps the base read.
 */
export async function ppocrPage(
  canvas: HTMLCanvasElement,
  onCardWords: (words: OcrWord[], W: number, H: number) => OcrWord[] = (w) => w,
  base?: OcrWord[],
): Promise<OcrWord[]> {
  const W = canvas.width, H = canvas.height;
  const centre = (q: Quad): P => [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];
  const rect = (q: Quad) => box(q as P[]);
  const area = (q: Quad) => { const r = rect(q); return (r.x1 - r.x0) * (r.y1 - r.y0); };
  const overlaps = (a: Quad, b: Quad) => inQuad(a, ...centre(b)) || inQuad(b, ...centre(a));
  const t0 = performance.now();
  let shapes = findCards(canvas);
  let islands = contentGroups(canvas);
  shapes = shapes.filter((c) => !islands.some((q) => overlaps(c, q) && area(q) > 1.5 * area(c)));
  islands = islands.filter((q) => !shapes.some((c) => overlaps(c, q)));
  // An island is the card's print, not the card: widen it to card proportions (blank margins, a faint
  // header) so the whole card is read and blanked from the rest of the page.
  islands = islands.map((q) => {
    const r = rect(q);
    let x0 = r.x0, y0 = r.y0, x1 = r.x1, y1 = r.y1;
    const w = x1 - x0, h = y1 - y0;
    if (w / h > CARD_ASPECT) { const g = (w / CARD_ASPECT - h) / 2; y0 -= g; y1 += g; } else { const g = (h * CARD_ASPECT - w) / 2; x0 -= g; x1 += g; }
    const mx = 0.03 * (x1 - x0), my = 0.03 * (y1 - y0);
    x0 = Math.max(0, x0 - mx); y0 = Math.max(0, y0 - my); x1 = Math.min(W, x1 + mx); y1 = Math.min(H, y1 + my);
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Quad;
  });
  const quads = [...shapes, ...islands];
  ppStats.log.push(`locate: ${Math.round(performance.now() - t0)} ms, ${quads.length} card-like region(s)`);

  const restRead = (async () => {
  if (base) return [];
  const words: OcrWord[] = [];
  // The rest of the page, with candidate cards blanked, cropped to what is still printed. Skipped for a
  // photo of a card (the card fills much of the frame; the rest is background).
  const cardArea = quads.reduce((s, q) => s + area(q), 0);
  if (!quads.length || cardArea < 0.35 * W * H) {
    let src = canvas;
    if (quads.length) {
      src = document.createElement('canvas'); src.width = W; src.height = H;
      const g = src.getContext('2d')!;
      g.drawImage(canvas, 0, 0); g.fillStyle = '#fff';
      for (const q of quads) {
        const [cx, cy] = centre(q);
        g.beginPath(); q.forEach(([x, y], i) => { const px = cx + (x - cx) * 1.06, py = cy + (y - cy) * 1.06; if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); g.fill();
      }
    }
    // Each remaining block of print is read on its own (detection cost follows the area actually printed).
    for (const ink of inkIslands(src)) {
      const part = document.createElement('canvas');
      part.width = ink.w; part.height = ink.h;
      part.getContext('2d')!.drawImage(src, ink.x0, ink.y0, ink.w, ink.h, 0, 0, ink.w, ink.h);
      try {
        const lines = await readLines(part, Math.min(PAGE_LIMIT, Math.max(ink.w, ink.h)));
        const sh = (b: { x0: number; y0: number; x1: number; y1: number }) => ({ x0: b.x0 + ink.x0, y0: b.y0 + ink.y0, x1: b.x1 + ink.x0, y1: b.y1 + ink.y0 });
        const base = words.length ? Math.max(...words.map((w) => w.line)) + 1 : 0;
        words.push(...linesToWords(lines).map((w) => ({ ...w, ...sh(w), line: base + w.line, symbols: w.symbols.map((s) => ({ ...s, ...sh(s) })) })));
      } finally { part.width = part.height = 0; }
    }
    if (src !== canvas) src.width = src.height = 0;
  }
  return words;
  })();

  // Cards are read concurrently: detection queues on the first engine while others recognise.
  const cardReads = quads.map(async (q) => {
    const [cw, ch] = cardSize(q);
    const tw = performance.now();
    const crop = warpQuad(canvas, q, cw, ch);
    ppStats.log.push(`warp card ${cw}x${ch}: ${Math.round(performance.now() - tw)} ms`);
    let lines: PpLine[];
    try { lines = await readLines(crop, CARD_DET_LIMIT); } finally { crop.width = crop.height = 0; }
    let ws = linesToWords(lines);
    const isCard = cardLike(ws);
    // Card upside down? Most lines then needed the 180° turn: re-frame so the card's own reading order holds.
    let qq = q;
    const upside = lines.filter((l) => l.quad[0][1] > l.quad[3][1]).length;
    if (lines.length && upside > lines.length / 2) {
      qq = turnQuad(q, 2);
      const flip = (l: PpLine): PpLine => ({ ...l, quad: l.quad.map(([x, y]) => [cw - x, ch - y] as P) });
      ws = linesToWords(lines.map(flip));
    }
    if (base && !isCard) return null; // not a card: the base read of that part of the page stands
    if (isCard) {
      // MyKad-family cards are printed in capitals; a mixed-case reading is the OCR's guess.
      ws = ws.map((w) => ({ ...w, text: w.text.toUpperCase(), symbols: w.symbols.map((s) => ({ ...s, text: s.text.toUpperCase() })) }));
      ws = onCardWords(ws, cw, ch);
    }
    return { q, words: mapToPage(ws, qq, cw, ch) };
  });
  const [restWords, reads] = await Promise.all([restRead, Promise.all(cardReads)]);
  const cards = reads.filter((r) => r !== null).map((r) => r.words);
  const cardQuads = reads.filter((r) => r !== null).map((r) => r.q);
  const outside = (w: OcrWord) => !cardQuads.some((q) => inQuad(q, (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2));
  const words = base ? base.filter(outside) : [...restWords];
  let line = words.length ? Math.max(...words.map((w) => w.line)) + 1 : 0;
  for (const ws of cards) {
    for (const w of ws) words.push({ ...w, line: line + w.line });
    if (ws.length) line += Math.max(...ws.map((w) => w.line)) + 1;
  }
  return words;
}

/**
 * Words of a page read in blocks of print (the native scan, NativeScan.kt): each block's lines become words
 * on their own, in order, as ppocrPage does for the blocks it reads.
 */
export function wordsFromBlocks(blocks: PpLine[][]): OcrWord[] {
  const words: OcrWord[] = [];
  for (const lines of blocks) {
    const base = words.length ? Math.max(...words.map((w) => w.line)) + 1 : 0;
    words.push(...linesToWords(lines).map((w) => ({ ...w, line: base + w.line })));
  }
  return words;
}

/** ID card wording or an IC number: such a page is read again with the card search (ppocrPage). */
export const cardLike = (ws: OcrWord[]): boolean =>
  ws.some((w) => CARD_WORD.test(w.text.replace(/[^\p{L}]/gu, ''))) || ws.some((w) => /\d{6}-?\d{2}-?\d{4}/.test(w.text));

/** Map words from an upright warped copy (cw×ch) of quad q back to the page. */
function mapToPage(ws: OcrWord[], q: Quad, cw: number, ch: number): OcrWord[] {
  const m = (x: number, y: number): P => at(q as P[], x / cw, y / ch);
  const bb = (b: { x0: number; y0: number; x1: number; y1: number }) => box([m(b.x0, b.y0), m(b.x1, b.y0), m(b.x1, b.y1), m(b.x0, b.y1)]);
  return ws.map((w) => ({ ...w, ...bb(w), symbols: w.symbols.map((s) => ({ ...s, ...bb(s) })) }));
}

/** Blocks of print (upright boxes with a margin) on a mostly blank page, merged when close; small specks skipped. */
function inkIslands(c: HTMLCanvasElement): { x0: number; y0: number; w: number; h: number }[] {
  const S = Math.min(1, 600 / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * S)), h = Math.max(1, Math.round(c.height * S));
  const sm = document.createElement('canvas');
  sm.width = w; sm.height = h;
  const g = sm.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  sm.width = sm.height = 0;
  const R = 6; // join print within ~1% of the page
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 170 ? 1 : 0;
  // Dilate by R (separable max) so letters and words of one block connect.
  const tmp = new Uint8Array(w * h), grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R) && !v; k++) v = ink[y * w + k]; tmp[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R) && !v; k++) v = tmp[k * w + x]; grown[y * w + x] = v; }
  const label = new Int32Array(w * h), out: { x0: number; y0: number; w: number; h: number }[] = [], stack: number[] = [];
  let n = 0;
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!grown[s0] || label[s0]) continue;
    n++;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0;
    label[s0] = n; stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i / w) | 0;
      if (ink[i]) cnt++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < w * h && grown[j] && !label[j]) { label[j] = n; stack.push(j); }
    }
    if (cnt < 6) continue; // specks
    const X0 = Math.max(0, x0 / S), Y0 = Math.max(0, y0 / S), X1 = Math.min(c.width, (x1 + 1) / S), Y1 = Math.min(c.height, (y1 + 1) / S);
    out.push({ x0: Math.floor(X0), y0: Math.floor(Y0), w: Math.ceil(X1 - X0), h: Math.ceil(Y1 - Y0) });
  }
  return out;
}

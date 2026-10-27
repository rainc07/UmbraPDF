import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { vendorUrl } from './paths';
import { closePdf, openPdf, renderToCanvas } from './pdf';
import { findCards, contentGroups, wholeAsCard, warpQuad, mapBoxBack, inQuad, turnQuad, CARD_ASPECT, type Quad } from './cards';
import type { Progress, RedactionMap, VerifyReport } from './types';
import { ppocrPage, ppocrReady, ppStats } from './ppocr';

/** Which OCR engine reads pages: PaddleOCR (default) or Tesseract (fallback, and for tests/comparison). */
let engine: 'paddle' | 'tesseract' = 'paddle';
export function setOcrEngine(e: 'paddle' | 'tesseract'): void { engine = e; }
export function getOcrEngine(): 'paddle' | 'tesseract' { return engine; }
/** Start loading the default engine early (e.g. when a PDF is opened), so the first scan doesn't wait for it. */
export function warmUpOcr(): void { if (engine === 'paddle') void ppocrReady(); }

let status: (s: string) => void = () => {};
const LOAD_TIMEOUT_MS = 60_000;

/**
 * Up to two OCR engines (separate web workers): two cards, or a card and the rest of the page, are read at the
 * same time on multi-core phones. The second engine starts loading together with the first.
 */
const POOL = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 1) >= 2 ? 2 : 1;
const workers: (Promise<Worker> | null)[] = [null, null];
const busy = [false, false];
let poolSize = POOL;
const waiters: (() => void)[] = [];

function createOcr(slot: number): Promise<Worker> {
  let timer = 0;
  const created = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: vendorUrl('tesseract/worker.min.js'),
    corePath: vendorUrl('tesseract/core/'),
    langPath: vendorUrl('tesseract/lang'),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: false,
    logger: slot ? () => {} : (m: { status: string; progress: number }) => status(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`),
    errorHandler: (e: unknown) => console.error('[umbra] tesseract error', e),
  });
  const timeout = new Promise<never>((_, rej) => {
    timer = window.setTimeout(() => rej(new Error('OCR engine failed to load within 60 s (last step shown above). Export was not saved.')), LOAD_TIMEOUT_MS);
  });
  const w = Promise.race([created, timeout]).finally(() => clearTimeout(timer));
  w.catch(async () => {
    workers[slot] = null;
    if (slot) poolSize = 1; // the second engine is optional: carry on with one
    (await created.catch(() => null))?.terminate();
  });
  return w;
}

/**
 * Lazily create the fully-offline tesseract engine(s) (local worker, core and traineddata).
 * Fails (instead of hanging) if the engine is not ready within LOAD_TIMEOUT_MS.
 */
export function getOcrWorker(onStatus: (s: string) => void = () => {}): Promise<Worker> {
  status = onStatus;
  if (!workers[0]) {
    workers[0] = createOcr(0);
    if (poolSize > 1 && !workers[1]) workers[1] = createOcr(1);
  }
  return workers[0];
}

/** Run `fn` on a free engine (waiting for one if all are busy). */
async function withWorker<T>(onStatus: (s: string) => void, fn: (w: Worker) => Promise<T>): Promise<T> {
  await getOcrWorker(onStatus);
  for (;;) {
    let i = -1;
    for (let k = 0; k < poolSize; k++) if (!busy[k] && workers[k]) { i = k; break; }
    if (i >= 0) {
      busy[i] = true;
      try {
        let w: Worker;
        try { w = await workers[i]!; } catch (e) { if (i) continue; throw e; }
        return await fn(w);
      } finally {
        busy[i] = false;
        waiters.shift()?.();
      }
    }
    await new Promise<void>((r) => waiters.push(r));
  }
}

export async function terminateOcr(): Promise<void> {
  const ws = workers.splice(0, 2, null, null);
  poolSize = POOL;
  await Promise.all(ws.map(async (p) => (await p?.catch(() => null))?.terminate()));
}

const OCR_DPI = 150;
const MIN_CONF = 60;

/** Share of near-black pixels inside the region (inset by `inset` px); 0 if any pixel is clearly lighter. */
function darkShare(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, inset: number): number | null {
  const x0 = Math.max(0, Math.ceil(x + inset)), y0 = Math.max(0, Math.ceil(y + inset));
  const x1 = Math.min(ctx.canvas.width, Math.floor(x + w - inset)), y1 = Math.min(ctx.canvas.height, Math.floor(y + h - inset));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let dark = 0;
  for (let k = 0; k < d.length; k += 4) {
    const l = d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114;
    if (l > 96) return 0; // any clearly lighter pixel: not solid, let OCR decide
    if (l < 48) dark++;
  }
  return dark / (d.length / 4);
}

/** True if the region (inset by `inset` px) has no ink at all: nothing there to read. */
function blank(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, inset: number): boolean {
  const x0 = Math.max(0, Math.ceil(x + inset)), y0 = Math.max(0, Math.ceil(y + inset));
  const x1 = Math.min(ctx.canvas.width, Math.floor(x + w - inset)), y1 = Math.min(ctx.canvas.height, Math.floor(y + h - inset));
  if (x1 - x0 < 1 || y1 - y0 < 1) return true;
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  for (let k = 0; k < d.length; k += 4) if (d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114 < 200) return false;
  return true;
}

/** A region this dark (after the anti-aliased edge is trimmed) is a solid box: no readable text is possible. */
const SOLID = 0.995;

/**
 * Residual-leak check on the *exported* file. Each redacted region is first checked by its pixels:
 * a solid black region cannot show anything, so it needs no OCR (fast, and stricter than OCR).
 * Only regions that are not solid are OCR'd, and any recognised text there is a leak.
 * The OCR engine is loaded only if such a region exists.
 */
export async function ocrRedactedRegions(
  bytes: Uint8Array,
  redactions: RedactionMap,
  onProgress: Progress = () => {},
): Promise<NonNullable<VerifyReport['ocr']>> {
  const doc = await openPdf(bytes);
  const leaks: NonNullable<VerifyReport['ocr']>['leaks'] = [];
  let checkedRegions = 0, solidRegions = 0;
  const scale = OCR_DPI / 72;
  const pages = redactions.length;
  try {
    for (let i = 0; i < pages; i++) {
      const rects = redactions[i];
      if (!rects?.length || i >= doc.numPages) continue;
      onProgress(`Checking blacked-out areas, page ${i + 1}`, i / pages);
      const page = await doc.getPage(i + 1);
      const full = document.createElement('canvas');
      await renderToCanvas(page, full, scale);
      const ctx = full.getContext('2d', { willReadFrequently: true })!;
      for (const r of rects) {
        checkedRegions++;
        const share = darkShare(ctx, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 2);
        if (share === null || share >= SOLID) { solidRegions++; continue; } // too thin to hold text, or solid
        if (blank(ctx, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 2)) { solidRegions++; continue; } // empty (no-box copy)
        onProgress(`OCR check page ${i + 1}`, i / pages);
        const crop = document.createElement('canvas');
        crop.width = Math.max(8, Math.round(r.w * scale));
        crop.height = Math.max(8, Math.round(r.h * scale));
        crop.getContext('2d')!.drawImage(full, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, crop.width, crop.height);
        const { data } = await withWorker((m) => onProgress(m, i / pages), (w) => w.recognize(crop));
        const text = data.text.replace(/\s+/g, ' ').trim();
        if (text.length >= 2 && data.confidence >= MIN_CONF) leaks.push({ page: i + 1, text, confidence: data.confidence });
        crop.width = crop.height = 0;
      }
      full.width = full.height = 0;
      page.cleanup();
    }
  } finally {
    await closePdf(doc);
  }
  return { checkedRegions, solidRegions, leaks };
}

export interface OcrBox { x0: number; y0: number; x1: number; y1: number }
export interface OcrSymbol extends OcrBox { text: string; confidence: number }
export interface OcrWord extends OcrBox {
  text: string;
  confidence: number;
  line: number;          // running line index across the page (reading order)
  symbols: OcrSymbol[];  // per-glyph boxes (may be empty or not 1:1 with text)
  /** Read from a warped copy (rotated/perspective card or page): symbols are 1:1 with text, full boxes. */
  mapped?: boolean;
}

/** OCR a canvas into positioned words (with line index and glyph boxes), in canvas pixels. */
export async function recognizeWords(
  canvas: HTMLCanvasElement, onStatus: (s: string) => void = () => {}, minConfidence = 30, psm: PSM = PSM.AUTO,
  whitelist = '',
): Promise<OcrWord[]> {
  return withWorker(onStatus, async (w) => {
    const t0 = performance.now();
    if (psm !== PSM.AUTO || whitelist) await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist });
    try {
      const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
      const words: OcrWord[] = [];
      let line = 0;
      for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
        for (const wd of l.words) {
          const text = wd.text.trim();
          if (!text || wd.confidence < minConfidence || !/[\p{L}\p{N}]/u.test(text)) continue; // no letters/digits: noise
          const symbols = (wd.symbols ?? []).map((s) => ({ text: s.text, confidence: s.confidence, ...s.bbox }));
          words.push({ text, confidence: wd.confidence, line, symbols, ...wd.bbox });
        }
        line++;
      }
      lastOcrStats.log.push(`${canvas.width}x${canvas.height} psm${psm}${whitelist ? ' digits' : ''}: ${Math.round(performance.now() - t0)} ms, ${words.length} words`);
      return words;
    } finally {
      if (psm !== PSM.AUTO || whitelist) await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: '' });
    }
  });
}

/**
 * Clean-up copy for hard backgrounds (ID cards, security print, coloured paper, phone photos):
 * - max(R,G,B) makes coloured patterns (guilloche, tints) light while dark neutral text stays dark;
 * - dividing by a blurred background evens out shadows and gradients;
 * - a contrast stretch pushes the paper to white.
 */
export function preprocessForOcr(src: HTMLCanvasElement, lo = 0.25, hi = 0.82): HTMLCanvasElement {
  const W = src.width, H = src.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  const v = new Float32Array(W * H);
  for (let i = 0, k = 0; k < v.length; i += 4, k++) v[k] = Math.max(d[i], d[i + 1], d[i + 2]);
  // Background = local mean over a large window (summed-area table), lifted towards the local max by using
  // the brighter of mean and pixel, so thick text strokes don't darken their own background.
  const r = Math.max(8, Math.round(Math.min(W, H) / 40));
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += v[y * W + x]; sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + row; }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const mean = (sat[y1 * (W + 1) + x1] - sat[y0 * (W + 1) + x1] - sat[y1 * (W + 1) + x0] + sat[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const bg = Math.max(mean * 1.08, 1);
      // 0..1 where 1 = background; text far below. Stretch: anything above `hi` is paper, below `lo` is ink.
      let t = v[y * W + x] / bg;
      t = t >= hi ? 1 : Math.max(0, (t - lo) / (hi - lo));
      const o = Math.round(255 * t), i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = o; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

/**
 * Sauvola adaptive threshold: each pixel against its neighbourhood's mean and spread, so faint print under
 * glare turns black while light background patterns drop out. Input is read as grey (red channel).
 */
export function sauvola(src: HTMLCanvasElement, k = 0.15): HTMLCanvasElement {
  const W = src.width, H = src.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  const S1 = new Float64Array((W + 1) * (H + 1)), S2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const v = d[(y * W + x) * 4]; a += v; b += v * v;
      const i = (y + 1) * (W + 1) + x + 1;
      S1[i] = S1[i - W - 1] + a; S2[i] = S2[i - W - 1] + b;
    }
  }
  const r = Math.max(6, Math.round(H / 60));
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), n = (x1 - x0) * (y1 - y0);
      const A = y1 * (W + 1) + x1, B = y0 * (W + 1) + x1, C = y1 * (W + 1) + x0, D = y0 * (W + 1) + x0;
      const m = (S1[A] - S1[B] - S1[C] + S1[D]) / n, sd = Math.sqrt(Math.max(0, (S2[A] - S2[B] - S2[C] + S2[D]) / n - m * m));
      const o = (y * W + x) * 4, T = m * (1 + k * (sd / 128 - 1));
      d[o] = d[o + 1] = d[o + 2] = d[o] <= T && sd > 6 ? 0 : 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

const centreIn = (a: OcrBox, b: OcrBox) => {
  const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2;
  return cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1;
};

/**
 * Group words into lines by vertical overlap, then left-to-right; a very wide gap starts a new line
 * (so separate columns don't run together). Returns words with fresh `line` indexes in reading order.
 */
export function relineWords(words: OcrWord[]): OcrWord[] {
  const ws = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const lines: OcrWord[][] = [];
  // A word joins a line when its centre is near the line's centre (robust to boxes bloated by specks).
  const hs = ws.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const medH = hs.length ? hs[hs.length >> 1] : 1;
  const cy = (w: OcrWord) => (w.y0 + w.y1) / 2;
  for (const w of ws) {
    const h = Math.min(w.y1 - w.y0, 1.5 * medH);
    const L = lines.find((l) => {
      const c = l.reduce((a, q) => a + cy(q), 0) / l.length;
      const lh = Math.min(Math.max(...l.map((q) => q.y1 - q.y0)), 1.5 * medH);
      return Math.abs(cy(w) - c) < 0.4 * Math.min(h, lh) + 0.1 * medH;
    });
    if (L) L.push(w); else lines.push([w]);
  }
  lines.sort((a, b) => Math.min(...a.map((q) => q.y0)) - Math.min(...b.map((q) => q.y0)));
  const out: OcrWord[] = [];
  let n = 0;
  for (const l of lines) {
    l.sort((a, b) => a.x0 - b.x0);
    const h = Math.max(...l.map((q) => q.y1 - q.y0));
    l.forEach((w, k) => {
      if (k && w.x0 - l[k - 1].x1 > 4 * h) n++;
      out.push({ ...w, line: n });
    });
    n++;
  }
  return out;
}

/**
 * Where two passes read the same spot, keep the better reading: the longer one if one is a fragment of the
 * other (e.g. "900101-14-5678" vs "14-"), otherwise the more confident one. A first-pass word that the second
 * pass didn't read at all is kept (nothing better to replace it with). Not relined.
 */
function mergePasses(first: OcrWord[], second: OcrWord[]): OcrWord[] {
  const overlap = (a: OcrWord, b: OcrWord) => centreIn(a, b) || centreIn(b, a);
  const len = (w: OcrWord) => w.text.replace(/[^\p{L}\p{N}]/gu, '').length;
  const kept: OcrWord[] = [];
  const dropped = new Set<OcrWord>();
  for (const a of first) {
    const bs = second.filter((b) => overlap(a, b));
    if (!bs.length) { kept.push(a); continue; }
    const bLen = bs.reduce((n, b) => n + len(b), 0), bConf = Math.max(...bs.map((b) => b.confidence));
    if (len(a) > 1.3 * bLen || (len(a) >= bLen && a.confidence >= bConf)) { kept.push(a); bs.forEach((b) => dropped.add(b)); }
  }
  return [...kept, ...second.filter((b) => !dropped.has(b) && !kept.some((a) => overlap(a, b)))];
}

/** Words printed on MyKad-family cards (front and back), used to pick the upright orientation. */
const CARD_WORDS = /^(?:KAD|PENGENALAN|MALAYSIA|WARGANEGARA|IDENTITY|CARD|PENDUDUK|TETAP|KETUA|PENGARAH|PENDAFTARAN|NEGARA|KERAJAAN|MYKAD|MYPR|MYKID|MYKAS|LELAKI|PEREMPUAN|ISLAM)$/i;
/** An IC number, allowing common OCR slips; checked per line. */
const IC_SHAPE = /(?<![\dA-Za-z])[\dOoIl|SBZ]{6}\s?[-–—~]?\s?[\dOoIl|SBZ]{2}\s?[-–—~]?\s?[\dOoIl|SBZ]{4}(?![\dA-Za-z])/;
const IC_EXACT = /^(\d{6})-?(\d{2})-?(\d{4})(?:-\d{2}-\d{2})?$/;

const lineTexts = (words: OcrWord[]) => {
  const m = new Map<number, string[]>();
  for (const w of words) (m.get(w.line) ?? m.set(w.line, []).get(w.line)!).push(w.text);
  return [...m.values()].map((l) => l.join(' '));
};
const hasIc = (words: OcrWord[]) => lineTexts(words).some((l) => { const m = IC_SHAPE.exec(l); return !!m && m[0].replace(/\D/g, '').length >= 9; });
const cardWordCount = (words: OcrWord[]) => words.filter((w) => w.confidence >= 50 && CARD_WORDS.test(w.text.replace(/[^\p{L}]/gu, ''))).length;
/** Reading quality: confident letters and digits, with card words counting extra (orientation choice). */
const score = (words: OcrWord[]) =>
  words.reduce((a, w) => a + (w.confidence >= 60 ? w.text.replace(/[^\p{L}\p{N}]/gu, '').length : 0), 0) + 25 * cardWordCount(words);
const meanConf = (words: OcrWord[]) => (words.length ? words.reduce((a, w) => a + w.confidence, 0) / words.length : 0);

/** Per-character boxes in the word's own frame (glyph boxes when they match the text, else even split), padded. */
function charBoxes(w: OcrWord): OcrBox[] {
  if (w.mapped) return w.symbols;
  const pad = 0.06 * (w.y1 - w.y0), out: OcrBox[] = [];
  const box = (x0: number, x1: number) => out.push({ x0: x0 - pad, y0: w.y0 - pad, x1: x1 + pad, y1: w.y1 + pad });
  if (w.symbols.map((s) => s.text).join('') === w.text) {
    for (const s of w.symbols) { const n = s.text.length, cw = (s.x1 - s.x0) / n; for (let k = 0; k < n; k++) box(s.x0 + k * cw, s.x0 + (k + 1) * cw); }
  } else {
    const n = w.text.length, cw = (w.x1 - w.x0) / n;
    for (let k = 0; k < n; k++) box(w.x0 + k * cw, w.x0 + (k + 1) * cw);
  }
  return out;
}

/** Map words read from a warped copy of quad `q` (W×H) back into the source image. Keeps line numbers. */
function mapWords(words: OcrWord[], q: Quad, W: number, H: number): OcrWord[] {
  const back = mapBoxBack(q, W, H);
  return words.map((w) => {
    const chars = charBoxes(w);
    const symbols = [...w.text].map((ch, k) => ({ text: ch, confidence: w.confidence, ...back(chars[k].x0, chars[k].y0, chars[k].x1, chars[k].y1) }));
    return { ...w, ...back(w.x0, w.y0, w.x1, w.y1), symbols, mapped: true };
  });
}

/** Size of the upright copy of a quad: at least 1600 px wide (small cards are upscaled), at most 2400. */
function uprightSize(q: Quad, aspect: number): [number, number] {
  const long = Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]));
  const W = Math.round(Math.min(1800, Math.max(1600, long * 1.25)));
  return [W, Math.round(W / aspect)];
}

/**
 * Read one ID card: warp it upright and enlarged, pick 0° or 180° by which reads better, then
 * (only when needed) a plain pass on the colour copy and a digits-only pass for the IC number.
 * Returns words in source-image pixels, lines in the card's own reading order.
 */
async function ocrCard(canvas: HTMLCanvasElement, quad: Quad, onStatus: (s: string) => void, t: OcrTimings): Promise<OcrWord[] | null> {
  const [W0, H0] = uprightSize(quad, CARD_ASPECT);
  let best: { q: Quad; W: number; H: number; crop: HTMLCanvasElement; clean: HTMLCanvasElement; binary: boolean; words: OcrWord[] } | null = null;
  for (const f of [1]) {
    const W = Math.round(W0 * f), H = Math.round(H0 * f);
    for (const k of [0, 2]) {
      const q = turnQuad(quad, k);
      const crop = warpQuad(canvas, q, W, H), binary = isBinary(crop);
      // Whitened by a scanner-app filter: the background clean-up only blurs the print, so read the copy as is.
      const clean = binary ? dropThinLines(crop) : glareShare(crop) > 0.5 ? cropCanvas(crop, 0, 0, W, H) : preprocessForOcr(crop);
      onStatus(`OCR: ID card${k ? ' (upside down?)' : ''}`);
      t.passes++;
      const words = await recognizeWords(clean, onStatus, 40, PSM.SPARSE_TEXT);
      if (!best || score(words) > score(best.words)) {
        if (best) { best.crop.width = best.crop.height = best.clean.width = best.clean.height = 0; }
        best = { q, W, H, crop, clean, binary, words };
      } else { crop.width = crop.height = clean.width = clean.height = 0; }
      if (cardWordCount(words) >= 2 && hasIc(words)) break;          // clearly upright and complete
      if (k === 0 && cardWordCount(words) >= 2) break;               // clearly upright
    }
  }
  const b = best!;
  let words = b.words;
  // Nothing card-like in either orientation (a photo, a logo, a very blurry card): no more card passes;
  // the caller reads the region plainly instead.
  if (cardWordCount(words) === 0 && !hasIc(relineWords(words))) {
    b.crop.width = b.crop.height = b.clean.width = b.clean.height = 0;
    return null;
  }
  try {
    if (!hasIc(words) || meanConf(words) < 80) {
      t.passes++;
      words = mergePasses(words, await recognizeWords(b.binary ? b.clean : b.crop, onStatus, 30, PSM.AUTO));
    }
    let hard: HTMLCanvasElement | null = null;
    try {
      if (!hasIc(relineWords(words)) || b.binary || isGlare(glareShare(b.crop))) {
        // Faint print (glare, light scans): a harder contrast stretch, then a digits-only read for the number.
        hard = preprocessForOcr(b.crop, 0.55, 0.93);
        t.passes++;
        const hw = await recognizeWords(hard, onStatus, 45, PSM.SPARSE_TEXT);
        words = mergePasses(words, hw);
      }
      if (!hasIc(relineWords(words))) {
        const icOk = (w: OcrWord) => {
          const m = IC_EXACT.exec(w.text);
          return !!m && +m[1].slice(2, 4) >= 1 && +m[1].slice(2, 4) <= 12 && +m[1].slice(4, 6) >= 1 && +m[1].slice(4, 6) <= 31;
        };
        let digits: OcrWord[] = [];
        for (const mk of [() => b.clean, () => hard && sauvola(hard)]) {
          const src = mk();
          if (!src) continue;
          t.passes++;
          try {
            const raw = await recognizeWords(src, onStatus, 20, PSM.SPARSE_TEXT, '0123456789-');
            // Glare can split the number into pieces ("780912" "14-5" "539"): join runs on one line.
            const lines = new Map<number, OcrWord[]>();
            for (const w of relineWords(raw)) (lines.get(w.line) ?? lines.set(w.line, []).get(w.line)!).push(w);
            for (const ws of lines.values()) for (let a = 0; a < ws.length; a++) for (let z = a; z < Math.min(ws.length, a + 4); z++) {
              const run = ws.slice(a, z + 1), text = run.map((w) => w.text).join('');
              const c: OcrWord = { text, confidence: Math.min(...run.map((w) => w.confidence)), line: run[0].line, symbols: run.flatMap((w) => w.symbols),
                x0: Math.min(...run.map((w) => w.x0)), y0: Math.min(...run.map((w) => w.y0)), x1: Math.max(...run.map((w) => w.x1)), y1: Math.max(...run.map((w) => w.y1)) };
              if (icOk(c) && (z === a || run.every((w, i) => !i || w.x0 - run[i - 1].x1 < 1.5 * (w.y1 - w.y0)))) digits.push(c);
            }
          } finally {
            if (src !== b.clean) src.width = src.height = 0;
          }
          if (digits.length) break;
        }
        if (digits.length) words = [...words.filter((w) => !digits.some((d) => centreIn(w, d) || centreIn(d, w))), ...digits];
      }
    } finally { if (hard) hard.width = hard.height = 0; }
  } finally {
    b.crop.width = b.crop.height = b.clean.width = b.clean.height = 0;
  }
  // Letters misread as "!", "|", "1" or "0" inside capital-letter words ("BINT!" → "BINTI").
  words = words.map((w) => {
    if (!/^[A-Z][A-Z!|10'’.\/-]{2,}$/.test(w.text) || (w.text.match(/[A-Z]/g) ?? []).length < 3) return w;
    const text = w.text.replace(/[!|1]/g, 'I').replace(/0/g, 'O');
    return text === w.text ? w : { ...w, text, symbols: w.symbols.map((s) => ({ ...s, text: s.text.replace(/[!|1]/g, 'I').replace(/0/g, 'O') })) };
  });
  // Specks read as short low-confidence "words" would split the name from the IC line: drop them.
  let lined = relineWords(words.filter((w) => !(w.confidence < 70 && w.text.replace(/[^\p{L}\p{N}]/gu, '').length <= 3 && !/\d/.test(w.text))));
  // Lines of one or two stray characters (chip contacts, hologram, specks) only break up the card's fields.
  const lineLen = new Map<number, number>();
  for (const w of lined) lineLen.set(w.line, (lineLen.get(w.line) ?? 0) + w.text.replace(/[^\p{L}\p{N}]/gu, '').length);
  lined = lined.filter((w) => (lineLen.get(w.line) ?? 0) > 2);
  if (!hasIc(lined)) lined = stretchPartialIc(lined);
  if (!hasIc(lined) && !lined.some((w) => PARTIAL_IC.test(w.text))) lined = markUnreadIc(lined, b.W, b.H);
  return mapWords(lined, b.q, b.W, b.H);
}

/** Mostly pure black and white (a scanner app's B&W filter)? */
function isBinary(c: HTMLCanvasElement): boolean {
  const s = document.createElement('canvas');
  s.width = 200; s.height = Math.max(1, Math.round((200 * c.height) / c.width));
  const g = s.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = false;
  g.drawImage(c, 0, 0, s.width, s.height);
  const d = g.getImageData(0, 0, s.width, s.height).data;
  s.width = s.height = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(d[i], d[i + 1], d[i + 2]), u = Math.min(d[i], d[i + 1], d[i + 2]); if ((v < 60 || u > 200) && v - u < 30) n++; }
  return n / (d.length / 4) > 0.9;
}

/**
 * B&W filters turn the card's fine security lines into black hairlines that cross the text. Text strokes are
 * thicker than those lines: blur by about a line's width and keep only what stays dark.
 */
function dropThinLines(c: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = c.width; out.height = c.height;
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
  g.filter = `blur(${Math.max(1, c.height / 650).toFixed(2)}px)`;
  g.drawImage(c, 0, 0);
  g.filter = 'none';
  const img = g.getImageData(0, 0, out.width, out.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] + d[i + 1] + d[i + 2] < 3 * 115 ? 0 : 255;
  g.putImageData(img, 0, 0);
  return out;
}

/** Part of the card washed out to white by a highlight. */
const isGlare = (share: number) => share > 0.03 && share < 0.5; // most of the card white = a whitening filter, not glare

/** Share of the card that is washed-out white (glare or flash): card backgrounds are tinted, glare is not. */
function glareShare(c: HTMLCanvasElement): number {
  const s = document.createElement('canvas');
  s.width = 160; s.height = Math.max(1, Math.round((160 * c.height) / c.width));
  const g = s.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, s.width, s.height);
  const d = g.getImageData(0, 0, s.width, s.height).data;
  s.width = s.height = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.min(d[i], d[i + 1], d[i + 2]) > 246) n++;
  return n / (d.length / 4);
}

/**
 * Glare or wear can hide the end of the IC number ("780912-14-55"). The start alone is still personal data,
 * and the hidden digits may be readable to a person, so the word's box is stretched over the full
 * 14-character width (eating the noise words read in the glare). The text stays as read; the
 * detector flags such a prefix on ID-card pages.
 */
function stretchPartialIc(words: OcrWord[]): OcrWord[] {
  const drop = new Set<OcrWord>();
  const out = words.map((w0) => {
    // A trailing glyph from the glare ("851231-0°") is dropped from the text.
    const t = /^(\d{6}(?:[-–]\d{0,2}[-–]?\d{0,3})?)[^\p{L}\p{N}\s]{0,2}$/u.exec(w0.text);
    const w = t && t[1] !== w0.text ? { ...w0, text: t[1], symbols: w0.symbols.slice(0, t[1].length) } : w0;
    const m = /^(\d{6})(?:[-–]\d{0,2}[-–]?\d{0,3})?$/.exec(w.text);
    if (!m || w.text.length >= 14 || +m[1].slice(2, 4) < 1 || +m[1].slice(2, 4) > 12 || +m[1].slice(4, 6) < 1 || +m[1].slice(4, 6) > 31) return w;
    const cw = (w.x1 - w.x0) / w.text.length, x1 = w.x1 + (14 - w.text.length) * cw * 1.1;
    for (const o of words) if (o !== w && o.line === w.line && o.x0 >= w.x1 - cw && o.x0 < x1 + cw) drop.add(o);
    const symbols = w.symbols.map((s) => s.text).join('') === w.text && w.symbols.length
      ? w.symbols.map((s, k) => (k === w.symbols.length - 1 ? { ...s, x1 } : s)) : [];
    return { ...w, x1, symbols };
  });
  return out.filter((w) => !drop.has(w));
}

const PARTIAL_IC = /^\d{6}(?:[-–]\d{0,2}[-–]?\d{0,3})?$/;
/** Placeholder text for an IC number the OCR could not read; the detector flags it on ID-card pages. */
export const UNREAD_IC = '‹IC number›';

/**
 * The front of a MyKad-family card always carries the IC number at the left, between the header and the
 * chip. If the card's front was recognised (its header read) but the number wasn't (glare, wear, a poor
 * copy), the place where the number is printed is still personal data: add a placeholder word covering it.
 */
function markUnreadIc(words: OcrWord[], W: number, H: number): OcrWord[] {
  const front = words.some((w) => /^(?:PENGENALAN|MYKAD|MYPR|MYKID|MYKAS)$/i.test(w.text.replace(/[^\p{L}]/gu, '')))
    && !words.some((w) => /^(?:KETUA|PENGARAH|PENDAFTARAN)$/i.test(w.text.replace(/[^\p{L}]/gu, '')));
  if (!front) return words;
  const x0 = 0.03 * W, x1 = 0.56 * W, y0 = 0.17 * H, y1 = 0.33 * H;
  // Drop anything read inside that zone (fragments of the number), so the placeholder line stands alone.
  const kept = words.filter((w) => !centreIn(w, { x0, y0, x1, y1 }));
  const n = UNREAD_IC.length, cw = (x1 - x0) / n;
  const symbols = [...UNREAD_IC].map((ch, k) => ({ text: ch, confidence: 0, x0: x0 + k * cw, y0, x1: x0 + (k + 1) * cw, y1 }));
  return relineWords([...kept, { text: UNREAD_IC, confidence: 0, line: 0, symbols, x0, y0, x1, y1 }]);
}

/** Counters for the technical report / benchmarks. */
export interface OcrTimings { passes: number; cards: number; rotated: number; log: string[] }
export const lastOcrStats: OcrTimings = { passes: 0, cards: 0, rotated: 0, log: [] };
export function resetOcrStats(): void { lastOcrStats.passes = 0; lastOcrStats.cards = 0; lastOcrStats.rotated = 0; lastOcrStats.log = []; }


/** Copy of a canvas region (x, y, w, h), optionally scaled. */
function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number, k = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}
const shiftWord = (w: OcrWord, dx: number, dy: number, k = 1): OcrWord => {
  const f = (b: OcrBox) => ({ x0: b.x0 / k + dx, y0: b.y0 / k + dy, x1: b.x1 / k + dx, y1: b.y1 / k + dy });
  return { ...w, ...f(w), symbols: w.symbols.map((s) => ({ ...s, ...f(s) })) };
};
const quadBox = (q: Quad, W: number, H: number) => {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
  return { x0, y0, w: Math.min(W, Math.ceil(Math.max(...xs))) - x0, h: Math.min(H, Math.ceil(Math.max(...ys))) - y0 };
};


/** Bounding box (with a margin) of the clearly printed parts of a canvas, or null if there is almost none. */
export function inkBox(c: HTMLCanvasElement): { x0: number; y0: number; w: number; h: number } | null {
  const S = Math.min(1, 600 / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * S)), h = Math.max(1, Math.round(c.height * S));
  const sm = document.createElement('canvas');
  sm.width = w; sm.height = h;
  const g = sm.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  sm.width = sm.height = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.min(d[i], d[i + 1], d[i + 2]) < 170) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (n < 0.0004 * w * h || x1 < 0) return null;
  const m = 6;
  const X0 = Math.max(0, (x0 - m) / S), Y0 = Math.max(0, (y0 - m) / S);
  return { x0: Math.floor(X0), y0: Math.floor(Y0), w: Math.ceil(Math.min(c.width, (x1 + m + 1) / S) - X0), h: Math.ceil(Math.min(c.height, (y1 + m + 1) / S) - Y0) };
}

/** Pixel budget for reading the rest of a page around ID cards (about 200 DPI on A4). */
const AROUND_CARDS_PIXELS = 4_500_000;

/**
 * A page with (possible) ID cards. Everything runs side by side on the OCR engines:
 * - each card is read upright (see ocrCard); an island of print that doesn't read like a card is read plainly;
 * - the rest of the page is read once, with the cards blanked out and at a moderate resolution.
 */
async function readWithCards(canvas: HTMLCanvasElement, quads: { q: Quad; sure: boolean }[], onStatus: (s: string) => void, t: OcrTimings): Promise<OcrWord[]> {
  const W = canvas.width, H = canvas.height;
  const k = Math.min(1, Math.sqrt(AROUND_CARDS_PIXELS / (W * H)));
  const rest = document.createElement('canvas');
  rest.width = Math.round(W * k); rest.height = Math.round(H * k);
  const rg = rest.getContext('2d')!;
  rg.drawImage(canvas, 0, 0, rest.width, rest.height);
  rg.fillStyle = '#fff';
  for (const { q } of quads) { rg.beginPath(); q.forEach(([x, y], i) => (i ? rg.lineTo(x * k, y * k) : rg.moveTo(x * k, y * k))); rg.closePath(); rg.fill(); }
  // Only the part of the page that still has print on it is read (often nothing but a scanner-app footer).
  // A photo of a card (the card fills much of the frame) has only background around it: nothing to read.
  const cardArea = quads.reduce((a, { q }) => { const r = quadBox(q, W, H); return a + r.w * r.h; }, 0);
  const ink = cardArea < 0.35 * W * H ? inkBox(rest) : null;
  let restRead: Promise<OcrWord[]> = Promise.resolve([]);
  if (ink) {
    t.passes++;
    const part = cropCanvas(rest, ink.x0, ink.y0, ink.w, ink.h);
    restRead = recognizeWords(part, onStatus, 30).then((ws) => ws.map((w) => shiftWord(shiftWord(w, ink.x0, ink.y0), 0, 0, k)))
      .finally(() => { part.width = part.height = 0; });
  }
  rest.width = rest.height = 0;
  const cardReads = quads.map(async ({ q, sure }) => {
    if (!sure) {
      // An island of print (no card edge): read it plainly first, as part of the page. Only if that shows
      // card wording or an IC number is it read again as a card.
      const r = quadBox(q, W, H), crop = cropCanvas(canvas, r.x0, r.y0, r.w, r.h);
      t.passes++;
      let plain: OcrWord[];
      try { plain = (await recognizeWords(crop, onStatus, 30)).map((w) => shiftWord(w, r.x0, r.y0)); } finally { crop.width = crop.height = 0; }
      const lined = relineWords(plain);
      if (cardWordCount(plain) === 0 && !hasIc(lined)) return { card: false, words: plain };
      // An upright card from a scanner app that already reads cleanly (number and card wording): done.
      if (hasIc(lined) && cardWordCount(plain) >= 2 && meanConf(plain) >= 75) { t.cards++; return { card: true, words: lined }; }
    }
    const cw = await ocrCard(canvas, q, onStatus, t);
    if (cw) { t.cards++; return { card: true, words: cw }; }
    if (!sure) return { card: false, words: [] }; // its plain read above stands
    // Not readable as a card (or a very blurry one, which reads better unwarped at its own size): read the
    // region plainly on a cleaned-up copy, as part of the page.
    const r = quadBox(q, W, H), box = cropCanvas(canvas, r.x0, r.y0, r.w, r.h), clean = preprocessForOcr(box);
    t.passes++;
    try {
      return { card: false, words: (await recognizeWords(clean, onStatus, 45, PSM.SPARSE_TEXT)).map((w) => shiftWord(w, r.x0, r.y0)) };
    } finally { box.width = box.height = clean.width = clean.height = 0; }
  });
  const [restWords, reads] = await Promise.all([restRead, Promise.all(cardReads)]);
  const out = relineWords([...restWords, ...reads.filter((r) => !r.card).flatMap((r) => r.words)]);
  let line = out.length ? Math.max(...out.map((w) => w.line)) + 1 : 0;
  for (const r of reads) {
    if (!r.card || !r.words.length) continue;
    for (const w of r.words) out.push({ ...w, line: line + w.line });
    line += Math.max(...r.words.map((w) => w.line)) + 1;
  }
  return out;
}

/**
 * Robust OCR for a page or picture, in canvas pixels with reading-order line indexes:
 * 1. a normal pass over everything;
 * 2. ID cards (found by shape, any rotation or perspective) are read again upright and enlarged, and
 *    their words replace the first pass inside the card;
 * 3. without cards: a second "sparse text" pass on a cleaned-up copy for sparse or low-confidence pages;
 * 4. if the page still reads poorly, it may be sideways or upside down: 90°/180°/270° are probed on a small copy.
 * Every extra step runs only when the cheaper ones were not enough.
 */
/**
 * A page already read plainly (the native scan) that shows ID-card wording: find the cards and read just
 * them; the rest of the page keeps the plain read. Canvas pixels, same frame as `base`.
 */
export async function readCards(canvas: HTMLCanvasElement, base: OcrWord[]): Promise<OcrWord[]> {
  const t = lastOcrStats, tp = performance.now();
  ppStats.log = t.log;
  try { return await ppocrPage(canvas, (ws, W, H) => (hasIc(ws) || ws.some((w) => PARTIAL_IC.test(w.text)) ? ws : markUnreadIc(ws, W, H)), base); }
  finally { t.log.push(`cards on a natively read page: ${Math.round(performance.now() - tp)} ms`); }
}

export async function recognizeWordsRobust(canvas: HTMLCanvasElement, onStatus: (s: string) => void = () => {}, allowTurn = true): Promise<OcrWord[]> {
  const t = lastOcrStats;
  const tw = performance.now();
  if (engine === 'paddle' && await ppocrReady()) {
    t.log.push(`engine wait: ${Math.round(performance.now() - tw)} ms`);
    try {
      onStatus('Reading text…');
      ppStats.log = t.log;
      const tp = performance.now();
      try { return await ppocrPage(canvas, (ws, W, H) => (hasIc(ws) || ws.some((w) => PARTIAL_IC.test(w.text)) ? ws : markUnreadIc(ws, W, H))); } finally { t.log.push(`ppocr page total: ${Math.round(performance.now() - tp)} ms`); }
    } catch (e) {
      console.warn('[umbra] PaddleOCR failed on this page, using Tesseract', e);
    }
  }
  // Find cards first (cheap, no OCR): by edge/colour, by ink density, and islands of print (whitened cards).
  const tf = performance.now();
  const centre = (q: Quad): [number, number] => [q.reduce((a, p) => a + p[0], 0) / 4, q.reduce((a, p) => a + p[1], 0) / 4];
  const area = (q: Quad) => { const r = quadBox(q, canvas.width, canvas.height); return r.w * r.h; };
  const overlaps = (a: Quad, b: Quad) => inQuad(a, ...centre(b)) || inQuad(b, ...centre(a));
  let shapes = findCards(canvas);
  let islands = contentGroups(canvas);
  // Where an edge-found region and an island overlap, keep the larger: a dense block inside a whitened card
  // (barcode, photo) can look like a small card of its own.
  shapes = shapes.filter((c) => !islands.some((q) => overlaps(c, q) && area(q) > 1.5 * area(c)));
  islands = islands.filter((q) => !shapes.some((c) => overlaps(c, q)));
  const qs = (q: Quad) => { const r = quadBox(q, canvas.width, canvas.height); return `${r.x0},${r.y0} ${r.w}x${r.h}`; };
  t.log.push(`locate cards: ${Math.round(performance.now() - tf)} ms (edges: ${shapes.map(qs).join('; ') || '-'} | islands: ${islands.map(qs).join('; ') || '-'})`);
  if (shapes.length || islands.length) return readWithCards(canvas, [...shapes.map((q) => ({ q, sure: true })), ...islands.map((q) => ({ q, sure: false }))], onStatus, t);
  t.passes++;
  const first = await recognizeWords(canvas, onStatus, 30);
  const whole = wholeAsCard(canvas);
  if (whole && (cardWordCount(first) >= 1 || first.length < 60) && Math.max(canvas.width, canvas.height) <= 4000) {
    return readWithCards(canvas, [{ q: whole, sure: true }], onStatus, t);
  }
  let words = first;
  if (!(first.length >= 80 && meanConf(first) >= 75)) {   // a clean, dense page: the normal pass is enough
    onStatus('OCR: second pass (hard background)');
    const clean = preprocessForOcr(canvas);
    t.passes++;
    try { words = relineWords(mergePasses(first, await recognizeWords(clean, onStatus, 45, PSM.SPARSE_TEXT))); } finally { clean.width = clean.height = 0; }
  }
  if (allowTurn && score(words) < 60) {
    // Sideways or upside-down page? Probe the other orientations on a small copy, and re-read if one is much better.
    const k = Math.min(1, 1400 / Math.max(canvas.width, canvas.height));
    const small = document.createElement('canvas');
    small.width = Math.round(canvas.width * k); small.height = Math.round(canvas.height * k);
    small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
    const full: Quad = [[0, 0], [small.width, 0], [small.width, small.height], [0, small.height]];
    let base = score(await recognizeWords(small, onStatus, 30)), turn = 0;
    t.passes++;
    for (const r of [2, 1, 3]) {
      onStatus('OCR: checking page orientation');
      const [w, h] = r % 2 ? [small.height, small.width] : [small.width, small.height];
      const rot = warpQuad(small, turnQuad(full, r), w, h);
      t.passes++;
      const s = score(await recognizeWords(rot, onStatus, 30));
      rot.width = rot.height = 0;
      if (s > Math.max(40, 2 * base)) { base = s; turn = r; }
    }
    small.width = small.height = 0;
    if (turn) {
      t.rotated++;
      const q: Quad = turnQuad([[0, 0], [canvas.width, 0], [canvas.width, canvas.height], [0, canvas.height]], turn);
      const [w, h] = turn % 2 ? [canvas.height, canvas.width] : [canvas.width, canvas.height];
      const rot = warpQuad(canvas, q, w, h);
      try { return mapWords(await recognizeWordsRobust(rot, onStatus, false), q, w, h); } finally { rot.width = rot.height = 0; }
    }
  }
  return words;
}

import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { vendorUrl } from './paths';
import { closePdf, openPdf, renderToCanvas } from './pdf';
import type { Progress, RedactionMap, VerifyReport } from './types';

let worker: Promise<Worker> | null = null;
let status: (s: string) => void = () => {};
const LOAD_TIMEOUT_MS = 60_000;

/**
 * Lazily create a fully-offline tesseract worker (local worker, core and traineddata).
 * Fails (instead of hanging) if the engine is not ready within LOAD_TIMEOUT_MS.
 */
export function getOcrWorker(onStatus: (s: string) => void = () => {}): Promise<Worker> {
  status = onStatus;
  if (worker) return worker;
  let timer = 0;
  const created = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: vendorUrl('tesseract/worker.min.js'),
    corePath: vendorUrl('tesseract/core/'),
    langPath: vendorUrl('tesseract/lang'),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: false,
    logger: (m: { status: string; progress: number }) => status(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`),
    errorHandler: (e: unknown) => console.error('[umbra] tesseract error', e),
  });
  const timeout = new Promise<never>((_, rej) => {
    timer = window.setTimeout(() => rej(new Error('OCR engine failed to load within 60 s (last step shown above). Export was not saved.')), LOAD_TIMEOUT_MS);
  });
  worker = Promise.race([created, timeout]).finally(() => clearTimeout(timer));
  worker.catch(async () => {
    worker = null;
    (await created.catch(() => null))?.terminate();
  });
  return worker;
}

export async function terminateOcr(): Promise<void> {
  if (!worker) return;
  const w = await worker.catch(() => null);
  worker = null;
  await w?.terminate();
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
        onProgress(`OCR check page ${i + 1}`, i / pages);
        const w = await getOcrWorker((m) => onProgress(m, i / pages));
        const crop = document.createElement('canvas');
        crop.width = Math.max(8, Math.round(r.w * scale));
        crop.height = Math.max(8, Math.round(r.h * scale));
        crop.getContext('2d')!.drawImage(full, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, crop.width, crop.height);
        const { data } = await w.recognize(crop);
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
}

/** OCR a canvas into positioned words (with line index and glyph boxes), in canvas pixels. */
export async function recognizeWords(
  canvas: HTMLCanvasElement, onStatus: (s: string) => void = () => {}, minConfidence = 30, psm: PSM = PSM.AUTO,
): Promise<OcrWord[]> {
  const w = await getOcrWorker(onStatus);
  if (psm !== PSM.AUTO) await w.setParameters({ tessedit_pageseg_mode: psm });
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
    return words;
  } finally {
    if (psm !== PSM.AUTO) await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
}

/**
 * Clean-up copy for hard backgrounds (ID cards, security print, coloured paper, phone photos):
 * - max(R,G,B) makes coloured patterns (guilloche, tints) light while dark neutral text stays dark;
 * - dividing by a blurred background evens out shadows and gradients;
 * - a contrast stretch pushes the paper to white.
 */
export function preprocessForOcr(src: HTMLCanvasElement): HTMLCanvasElement {
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
      // 0..1 where 1 = background; text far below. Stretch: anything above 0.82 is paper.
      let t = v[y * W + x] / bg;
      t = t >= 0.82 ? 1 : Math.max(0, (t - 0.25) / (0.82 - 0.25));
      const o = Math.round(255 * t), i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = o; d[i + 3] = 255;
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
  for (const w of ws) {
    const h = w.y1 - w.y0;
    const L = lines.find((l) => {
      const top = Math.min(...l.map((q) => q.y0)), bot = Math.max(...l.map((q) => q.y1));
      return Math.min(bot, w.y1) - Math.max(top, w.y0) > 0.5 * Math.min(h, bot - top);
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
 * Robust OCR: a normal pass, then (for sparse or low-confidence pages, such as ID cards, forms and photos)
 * a second "sparse text" pass on a cleaned-up copy. Where both passes read the same spot, the more
 * confident word wins. Words are returned in canvas pixels with reading-order line indexes.
 */
export async function recognizeWordsRobust(canvas: HTMLCanvasElement, onStatus: (s: string) => void = () => {}): Promise<OcrWord[]> {
  const first = await recognizeWords(canvas, onStatus, 30);
  const mean = first.length ? first.reduce((a, w) => a + w.confidence, 0) / first.length : 0;
  if (first.length >= 80 && mean >= 75) return first; // a clean, dense page: the normal pass is enough
  onStatus('OCR: second pass (hard background)');
  const clean = preprocessForOcr(canvas);
  let second: OcrWord[] = [];
  try { second = await recognizeWords(clean, onStatus, 45, PSM.SPARSE_TEXT); } finally { clean.width = clean.height = 0; }
  // The cleaned pass is the better reader on these pages: weak first-pass words (pattern noise) are dropped.
  const kept = first.filter((a) => a.confidence >= 55 && !second.some((b) => (centreIn(a, b) || centreIn(b, a)) && b.confidence > a.confidence));
  const added = second.filter((b) => !kept.some((a) => (centreIn(a, b) || centreIn(b, a))));
  return relineWords([...kept, ...added]);
}

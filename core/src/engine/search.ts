// Text search over PDF pages with per-character geometry. Platform-agnostic (canvas only, no UI).
// Text pages: pdf.js getTextContent + canvas measureText with the page's loaded font, scaled to item.width.
// Image-only pages: OCR (tesseract) with glyph boxes.
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import { recognizeWordsRobust, readCards, lastOcrStats, getOcrEngine, type OcrWord } from './ocr';
import { OPS, renderToCanvas, Util, type PDFDocumentProxy, type PDFPageProxy } from './pdf';
import type { Rect } from './types';

/** A page's text as one string, with a box (PDF points, displayed space, top-left origin) per character. */
export interface PageText {
  page: number;              // 0-based
  text: string;
  boxes: (Rect | null)[];    // null for synthetic separators
  groups: number[];          // run id per char (text item / OCR line); -1 for separators
  source: 'text' | 'ocr';
  /**
   * A scan with its own text layer: every word OCR read from the page picture (page points), including words the
   * layer already has. Export reuses these on pages with boxes, where the layer itself isn't trusted.
   */
  scanWords?: OcrWord[];
}

export interface TextMatch { page: number; start: number; end: number; text: string; rects: Rect[] }

export interface SearchPattern {
  id: string;
  label: string;
  regex: RegExp;
  /** Extra validation (checksum, nearby keyword). `m.index` is relative to `text`; `pt` gives geometry (column headers). */
  accept?: (m: RegExpExecArray, text: string, pt?: PageText) => boolean;
  /** Narrow (or reject with null) the matched range, e.g. trim a multi-line grab to the real address. */
  refine?: (m: RegExpExecArray, text: string) => { start: number; end: number } | null;
}

export interface Hit extends TextMatch { label: string; patternId: string }

export interface ExtractOptions {
  /** 'auto': OCR only pages without a usable text layer. */
  ocr: 'auto' | 'never' | 'always';
  ocrDpi: number;
  onStatus?: (s: string) => void;
  /**
   * A scanned page already read elsewhere (the native scan): words in px at `scale`, or null to read it here.
   * `cards`: it shows ID-card wording, so the cards on it are found and read here (the rest is kept).
   */
  preread?: (index: number) => Promise<{ words: OcrWord[]; scale: number; cards: boolean } | null>;
}
const DEFAULT_EXTRACT: ExtractOptions = { ocr: 'auto', ocrDpi: 0 };
/** Page render resolution for OCR when not set: PaddleOCR reads well at 220 DPI (less to render and move), Tesseract wants 300. */
export const defaultOcrDpi = () => (getOcrEngine() === 'paddle' ? Number((globalThis as { __umbraOcrDpi?: number }).__umbraOcrDpi) || 220 : 300);
export const MIN_TEXT_CHARS = 8;        // fewer non-space chars than this => treat page as scanned
const OCR_MAX_PIXELS = 16_000_000;

// ---------- builder ----------
class Builder {
  text = '';
  boxes: (Rect | null)[] = [];
  groups: number[] = [];
  push(ch: string, box: Rect | null, group: number) { this.text += ch; this.boxes.push(box); this.groups.push(group); }
  sep(ch: string) { if (this.text && !this.text.endsWith('\n') && !this.text.endsWith(ch)) this.push(ch, null, -1); }
}

function aabb(pts: [number, number][]): Rect {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** PDF glyph positions already include any kerning (TJ), so measure without kerning/ligatures. */
function ctx2d(): CanvasRenderingContext2D {
  if (measureCtx) return measureCtx;
  const c = document.createElement('canvas').getContext('2d')!;
  const x = c as CanvasRenderingContext2D & { fontKerning?: string; textRendering?: string };
  x.fontKerning = 'none';
  x.textRendering = 'optimizeSpeed';
  return (measureCtx = c);
}

/** pdf.js registers each embedded/standard font as a FontFace whose family is item.fontName. */
function loadedFamilies(): Set<string> {
  const s = new Set<string>();
  document.fonts?.forEach((f) => s.add(f.family.replace(/^["']|["']$/g, '')));
  return s;
}

/** Cumulative advance (0..1) at each char boundary, measured with the item's font. */
function advances(str: string, family: string | null, fallback: string): number[] {
  const n = str.length;
  const uniform = () => Array.from({ length: n + 1 }, (_, k) => k / Math.max(1, n));
  if (!n) return [0];
  const c = ctx2d();
  c.font = `100px ${family ? `"${family}", ` : ''}${fallback}`;
  const pre = [0];
  for (let k = 1; k <= n; k++) pre.push(c.measureText(str.slice(0, k)).width);
  const total = pre[n];
  if (!(total > 0)) return uniform();
  // Keep monotonic (kerning can make prefixes shrink slightly).
  for (let k = 1; k <= n; k++) pre[k] = Math.max(pre[k], pre[k - 1]);
  return pre.map((v) => v / total);
}

async function ensureFonts(page: PDFPageProxy, names: string[]): Promise<void> {
  const have = loadedFamilies();
  if (names.every((n) => have.has(n))) return;
  // A cheap low-res render makes pdf.js load the page's fonts into document.fonts.
  const c = document.createElement('canvas');
  try { await renderToCanvas(page, c, 0.25); } catch { /* measurement falls back to generic family */ }
  c.width = c.height = 0;
}

async function textLayer(page: PDFPageProxy, index: number): Promise<PageText> {
  const tc = await page.getTextContent();
  const items = tc.items.filter((it): it is TextItem => 'str' in it);
  const styles = tc.styles as Record<string, TextStyle>;
  await ensureFonts(page, [...new Set(items.filter((i) => i.str).map((i) => i.fontName))]);
  const have = loadedFamilies();
  const vp = page.getViewport({ scale: 1 });
  const b = new Builder();
  let prev: { x: number; y: number; h: number } | null = null;

  items.forEach((it, gi) => {
    const str = it.str.replace(/[  -​]/g, ' ');
    const tx = Util.transform(vp.transform, it.transform) as number[];
    const h = Math.hypot(tx[2], tx[3]);
    const lenX = Math.hypot(tx[0], tx[1]);
    if (str && h > 0 && lenX > 0) {
      const dir: [number, number] = [tx[0] / lenX, tx[1] / lenX];
      const up: [number, number] = [tx[2] / h, tx[3] / h];
      const o: [number, number] = [tx[4], tx[5]];
      if (prev) {
        const dx = o[0] - prev.x, dy = o[1] - prev.y;
        const along = dx * dir[0] + dy * dir[1];
        const across = Math.abs(dx * up[0] + dy * up[1]);
        if (across > 0.5 * Math.max(h, prev.h)) b.sep('\n');
        else if (along > 0.15 * h && !/\s$/.test(b.text) && !/^\s/.test(str)) b.sep(' ');
      }
      const st = styles[it.fontName];
      let asc = st?.ascent ?? 0.8, desc = st?.descent ?? -0.2;
      if (!(asc >= 0.5 && asc <= 1.3)) asc = 0.85;
      if (!(desc <= 0 && desc >= -0.6)) desc = -0.22;
      const fam = have.has(it.fontName) ? it.fontName : null;
      const adv = advances(str, fam, st?.fontFamily || 'sans-serif');
      const W = it.width, padA = 0.08 * h, top = (asc + 0.06) * h, bot = (desc - 0.06) * h;
      const at = (s: number, v: number): [number, number] => [o[0] + dir[0] * s + up[0] * v, o[1] + dir[1] * s + up[1] * v];
      for (let k = 0; k < str.length; k++) {
        const s0 = adv[k] * W - padA, s1 = adv[k + 1] * W + padA;
        b.push(str[k], aabb([at(s0, top), at(s1, top), at(s0, bot), at(s1, bot)]), gi);
      }
      prev = { x: o[0] + dir[0] * W, y: o[1] + dir[1] * W, h };
    }
    if (it.hasEOL) { b.sep('\n'); prev = null; }
  });
  return { page: index, text: b.text, boxes: b.boxes, groups: b.groups, source: 'text' };
}

/** Append OCR words (canvas px at `scale`, offset by `off` points) to a builder as new lines. */
function pushWords(b: Builder, words: OcrWord[], scale: number, off = { x: 0, y: 0 }, groupBase = 0, skip?: (r: Rect) => boolean) {
  const toPt = (x0: number, y0: number, x1: number, y1: number): Rect =>
    ({ x: off.x + x0 / scale, y: off.y + y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale });
  let line = -1;
  for (const w of words) {
    if (skip?.(toPt(w.x0, w.y0, w.x1, w.y1))) continue;
    if (line !== -1 || b.text) b.sep(w.line !== line ? '\n' : ' ');
    line = w.line;
    const g = groupBase + w.line;
    const glyphs = w.symbols.map((s) => s.text).join('');
    if (w.mapped) {
      // Read from a turned/warped copy: one full box per character, already in image pixels.
      w.symbols.forEach((s, k) => b.push(w.text[k], toPt(s.x0, s.y0, s.x1, s.y1), g));
    } else if (glyphs === w.text) {
      for (const s of w.symbols) for (const ch of s.text) b.push(ch, toPt(s.x0, w.y0, s.x1, w.y1), g);
    } else {
      const n = w.text.length, cw = (w.x1 - w.x0) / n;
      for (let k = 0; k < n; k++) b.push(w.text[k], toPt(w.x0 + k * cw, w.y0, w.x0 + (k + 1) * cw, w.y1), g);
    }
  }
}

export function ocrScale(page: PDFPageProxy, dpi: number): number {
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const px = base.width * base.height * scale * scale;
  if (px > OCR_MAX_PIXELS) scale *= Math.sqrt(OCR_MAX_PIXELS / px);
  return scale;
}

async function ocrLayer(page: PDFPageProxy, index: number, dpi: number, onStatus: (s: string) => void, preread?: ExtractOptions['preread']): Promise<PageText> {
  const b = new Builder();
  const pre = await preread?.(index);
  if (pre && !pre.cards) {
    pushWords(b, pre.words, pre.scale);
    return { page: index, text: b.text, boxes: b.boxes, groups: b.groups, source: 'ocr' };
  }
  const scale = pre?.scale ?? ocrScale(page, dpi);
  const canvas = document.createElement('canvas');
  try {
    const tr = performance.now();
    await renderToCanvas(page, canvas, scale);
    lastOcrStats.log.push(`render ${canvas.width}x${canvas.height}: ${Math.round(performance.now() - tr)} ms`);
    pushWords(b, pre ? await readCards(canvas, pre.words) : await recognizeWordsRobust(canvas, onStatus), scale);
  } finally {
    canvas.width = canvas.height = 0;
  }
  return { page: index, text: b.text, boxes: b.boxes, groups: b.groups, source: 'ocr' };
}

/**
 * Words of a page's text (as read for search / Auto Detect), with per-character boxes, in page points.
 * Lets the copy-ready export reuse what was already read instead of running OCR again.
 */
export function pageTextWords(pt: PageText): OcrWord[] {
  const out: OcrWord[] = [];
  let line = 0, cur: OcrWord | null = null;
  const flush = () => { if (cur?.text) out.push(cur); cur = null; };
  for (let i = 0; i < pt.text.length; i++) {
    const ch = pt.text[i], r = pt.boxes[i];
    if (ch === '\n') { flush(); line++; continue; }
    if (!r || /\s/.test(ch) || (cur && pt.groups[i] !== pt.groups[i - 1])) { flush(); if (!r || /\s/.test(ch)) continue; }
    const b = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
    cur ??= { text: '', confidence: 100, line, symbols: [], ...b };
    cur.text += ch;
    cur.symbols.push({ text: ch, confidence: 100, ...b });
    cur.x0 = Math.min(cur.x0, b.x0); cur.y0 = Math.min(cur.y0, b.y0); cur.x1 = Math.max(cur.x1, b.x1); cur.y1 = Math.max(cur.y1, b.y1);
  }
  flush();
  return out;
}

/** Pictures big enough to hold readable text (e.g. a copy of an ID card pasted into a typed page). */
const MIN_IMAGE_SIDE = 72;        // points (1 inch)
const MIN_IMAGE_AREA = 0.03;      // of the page

/** Where images are painted on the page (displayed space, points, top-left origin). */
export async function imageRegions(page: PDFPageProxy): Promise<Rect[]> {
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  type M = number[];
  const mul = (m: M, n: M): M => Util.transform(m, n) as M;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const out: Rect[] = [];
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat]);
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k], a = ops.argsArray[k] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a as M);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0])) ctm = mul(ctm, a[0] as M); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (IMG.has(fn)) {
      const m = mul(vp.transform as M, ctm);
      const pts: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const r = aabb(pts);
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(vp.width, r.x + r.w), y1 = Math.min(vp.height, r.y + r.h);
      if (x1 - x0 >= MIN_IMAGE_SIDE && y1 - y0 >= MIN_IMAGE_SIDE * 0.6 && (x1 - x0) * (y1 - y0) >= MIN_IMAGE_AREA * vp.width * vp.height) {
        out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
  }
  // Drop images fully inside another (e.g. a soft mask drawn twice).
  return out.filter((r, i) => !out.some((q, j) => j !== i && q.x <= r.x && q.y <= r.y && q.x + q.w >= r.x + r.w && q.y + q.h >= r.y + r.h && (j < i || q.w * q.h > r.w * r.h)));
}

/**
 * A scanned page (one picture covering the page, no visible text): the picture's own resolution in DPI,
 * so an export doesn't render it larger than its source. Null for any other page.
 */
export async function scanDpi(page: PDFPageProxy): Promise<number | null> {
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  type M = number[];
  const mul = (m: M, n: M): M => Util.transform(m, n) as M;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const TEXT = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const OTHER_IMG = new Set([OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat]);
  let mode = 0, dpi: number | null = null;
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k], a = ops.argsArray[k] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a as M);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0])) ctm = mul(ctm, a[0] as M); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.setTextRenderingMode) mode = Number(a[0]);
    else if (TEXT.has(fn)) { if (mode !== 3) return null; } // invisible text (an earlier OCR layer) is fine
    else if (OTHER_IMG.has(fn)) return null;
    else if (fn === OPS.paintImageXObject) {
      if (dpi !== null) return null;
      const m = mul(vp.transform as M, ctm);
      const r = aabb([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as [number, number]));
      const cover = (Math.min(vp.width, r.x + r.w) - Math.max(0, r.x)) * (Math.min(vp.height, r.y + r.h) - Math.max(0, r.y));
      if (!(cover >= 0.9 * vp.width * vp.height)) return null;
      const w = Number(a[1]), h = Number(a[2]);
      const sw = Math.hypot(m[0], m[1]), sh = Math.hypot(m[2], m[3]);
      if (!(w > 0 && h > 0 && sw > 0 && sh > 0)) return null;
      dpi = Math.max(w / sw, h / sh) * 72;
    }
  }
  return dpi;
}

/** A typed page with pictures: OCR each picture and add its words after the real text. */
async function addImageText(page: PDFPageProxy, t: PageText, dpi: number, onStatus: (s: string) => void): Promise<PageText> {
  const regions = await imageRegions(page);
  if (!regions.length) return t;
  const b = new Builder();
  b.text = t.text; b.boxes = [...t.boxes]; b.groups = [...t.groups];
  const scale = ocrScale(page, dpi);
  const full = document.createElement('canvas');
  const groupBase = Math.max(0, ...t.groups) + 1000;
  const vp = page.getViewport({ scale: 1 });
  let scanWords: OcrWord[] | undefined;
  // Skip OCR words that sit on real text already in the layer (a caption over a picture).
  const onText = (r: Rect) => t.boxes.some((q) => q && r.x + r.w / 2 >= q.x && r.x + r.w / 2 <= q.x + q.w && r.y + r.h / 2 >= q.y && r.y + r.h / 2 <= q.y + q.h);
  try {
    await renderToCanvas(page, full, scale);
    for (const [k, r] of regions.entries()) {
      onStatus(`OCR: picture ${k + 1}/${regions.length}`);
      const crop = document.createElement('canvas');
      crop.width = Math.max(8, Math.round(r.w * scale)); crop.height = Math.max(8, Math.round(r.h * scale));
      crop.getContext('2d')!.drawImage(full, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, crop.width, crop.height);
      try {
        const words = await recognizeWordsRobust(crop, onStatus);
        if (words.length) { b.sep('\n'); pushWords(b, words, scale, { x: r.x, y: r.y }, groupBase + k * 10000, onText); }
        if (regions.length === 1 && r.w * r.h >= 0.9 * vp.width * vp.height) {
          const X = (v: number) => r.x + v / scale, Y = (v: number) => r.y + v / scale;
          scanWords = words.map((w) => ({
            ...w, x0: X(w.x0), y0: Y(w.y0), x1: X(w.x1), y1: Y(w.y1),
            symbols: w.symbols.map((sy) => ({ ...sy, x0: X(sy.x0), y0: Y(sy.y0), x1: X(sy.x1), y1: Y(sy.y1) })),
          }));
        }
      } finally { crop.width = crop.height = 0; }
    }
  } finally { full.width = full.height = 0; }
  return { page: t.page, text: b.text, boxes: b.boxes, groups: b.groups, source: 'text', scanWords };
}

/** Extract one page's text + geometry, OCR-ing image-only pages when allowed. */
export async function extractPageText(doc: PDFDocumentProxy, index: number, opts: Partial<ExtractOptions> = {}): Promise<PageText> {
  const o = { ...DEFAULT_EXTRACT, ...opts };
  if (!o.ocrDpi) o.ocrDpi = defaultOcrDpi();
  const page = await doc.getPage(index + 1);
  if (o.ocr !== 'always') {
    const tt = performance.now();
    const t = await textLayer(page, index);
    const tms = Math.round(performance.now() - tt);
    // A long wait here is Android pausing the page while the app was hidden (native reading carries on).
    lastOcrStats.log.push(`text layer: ${tms} ms${tms > 5000 ? ' (likely the page paused while the app was in the background)' : ''}`);
    if (o.ocr === 'never') return t;
    if (t.text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) return addImageText(page, t, o.ocrDpi, o.onStatus ?? (() => {}));
  }
  return ocrLayer(page, index, o.ocrDpi, o.onStatus ?? (() => {}), o.preread);
}

/** Per-document cache so search and detection reuse text extraction and OCR. */
export class PageTextCache {
  private m = new Map<number, Promise<PageText>>();
  constructor(readonly doc: PDFDocumentProxy, private opts: Partial<ExtractOptions> = {}) {}
  get(index: number, onStatus?: (s: string) => void): Promise<PageText> {
    let p = this.m.get(index);
    if (!p) {
      p = extractPageText(this.doc, index, { ...this.opts, onStatus });
      p.catch(() => this.m.delete(index));
      this.m.set(index, p);
    }
    return p;
  }
  /**
   * The page's text without new OCR where that can be avoided: what was already extracted, or for a scan that
   * carries its own (invisible) text layer just that layer, not a second read of the picture.
   */
  async known(index: number): Promise<PageText> {
    const p = this.m.get(index);
    if (p) return p;
    const page = await this.doc.getPage(index + 1);
    if (await scanDpi(page).catch(() => null)) {
      const t = await textLayer(page, index);
      if (t.text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) return t;
    }
    return this.get(index);
  }
}

// ---------- matching ----------
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Boxes covering text[start, end): one per run, then same-line neighbours merged; padded. */
export function rectsForRange(pt: PageText, start: number, end: number, pad = 1): Rect[] {
  const byGroup = new Map<number, Rect>();
  for (let i = start; i < end; i++) {
    const r = pt.boxes[i];
    if (!r) continue;
    const g = pt.groups[i];
    const cur = byGroup.get(g);
    byGroup.set(g, cur ? union(cur, r) : r);
  }
  const rs = [...byGroup.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    const vOverlap = last ? Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y) : 0;
    const gap = last ? r.x - (last.x + last.w) : Infinity;
    if (last && vOverlap > 0.5 * Math.min(last.h, r.h) && gap < 0.8 * Math.max(last.h, r.h)) out[out.length - 1] = union(last, r);
    else out.push(r);
  }
  return out.map((r) => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }));
}

export function findInPage(pt: PageText, p: Pick<SearchPattern, 'regex' | 'accept' | 'refine'>): TextMatch[] {
  const re = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : p.regex.flags + 'g');
  const out: TextMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(pt.text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    if (p.accept && !p.accept(m, pt.text, pt)) continue;
    let start = m.index, end = start + m[0].length;
    if (p.refine) {
      const r = p.refine(m, pt.text);
      if (!r || r.end <= r.start) { re.lastIndex = m.index + 1; continue; } // retry from the next position
      ({ start, end } = r);
      re.lastIndex = Math.max(end, m.index + 1); // allow a following match inside the discarded tail
    }
    const rects = rectsForRange(pt, start, end);
    if (rects.length) out.push({ page: pt.page, start, end, text: pt.text.slice(start, end), rects });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Literal search term -> regex (whitespace-flexible, case-insensitive unless matchCase, optional whole-word). */
export function literalPattern(query: string, matchCase = false, wholeWord = false): RegExp | null {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const body = parts.map(escapeRe).join('\\s+');
  const flags = (matchCase ? 'g' : 'gi') + 'u';
  return new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, flags);
}

/** Overlapping hits on a page collapse into the longest one; labels are combined. */
function dedupe(hits: Hit[]): Hit[] {
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Hit[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) {
      if (h.end - h.start > last.end - last.start) out[out.length - 1] = { ...h, label: mergeLabel(h.label, last.label) };
      else last.label = mergeLabel(last.label, h.label);
    } else out.push({ ...h });
  }
  return out;
}
const mergeLabel = (a: string, b: string) => (a.split(' / ').includes(b) ? a : `${a} / ${b}`);

/** The error a stopped scan ends with. */
export const isAbort = (e: unknown): boolean => (e as Error | null)?.name === 'AbortError';

/**
 * Wait for p unless the signal stops the wait first (then reject with an AbortError). The work behind p
 * isn't stopped: a page being read finishes and stays cached.
 */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  return new Promise<T>((res, rej) => {
    const stop = () => rej(new DOMException('Stopped', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    p.then(res, rej).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Run patterns over every page (OCR-ing scanned pages as needed). */
export async function searchDocument(
  cache: PageTextCache, patterns: SearchPattern[],
  onProgress: (msg: string, fraction: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Hit[]> {
  const n = cache.doc.numPages;
  const all: Hit[] = [];
  for (let i = 0; i < n; i++) {
    onProgress(`Reading page ${i + 1}/${n}`, i / n);
    const pt = await abortable(cache.get(i, (s) => onProgress(`Page ${i + 1}/${n}: ${s}`, i / n)), signal);
    const hits: Hit[] = [];
    for (const p of patterns) for (const m of findInPage(pt, p)) hits.push({ ...m, label: p.label, patternId: p.id });
    all.push(...dedupe(hits));
  }
  onProgress('Done', 1);
  return all;
}

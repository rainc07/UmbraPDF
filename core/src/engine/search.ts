// Text search over PDF pages with per-character geometry. Platform-agnostic (canvas only, no UI).
// Text pages: pdf.js getTextContent + canvas measureText with the page's loaded font, scaled to item.width.
// Image-only pages: OCR (tesseract) with glyph boxes.
import type { TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import { recognizeWords } from './ocr';
import { renderToCanvas, Util, type PDFDocumentProxy, type PDFPageProxy } from './pdf';
import type { Rect } from './types';

/** A page's text as one string, with a box (PDF points, displayed space, top-left origin) per character. */
export interface PageText {
  page: number;              // 0-based
  text: string;
  boxes: (Rect | null)[];    // null for synthetic separators
  groups: number[];          // run id per char (text item / OCR line); -1 for separators
  source: 'text' | 'ocr';
}

export interface TextMatch { page: number; start: number; end: number; text: string; rects: Rect[] }

export interface SearchPattern {
  id: string;
  label: string;
  regex: RegExp;
  /** Extra validation (checksum, nearby keyword). `m.index` is relative to `text`. */
  accept?: (m: RegExpExecArray, text: string) => boolean;
  /** Narrow (or reject with null) the matched range, e.g. trim a multi-line grab to the real address. */
  refine?: (m: RegExpExecArray, text: string) => { start: number; end: number } | null;
}

export interface Hit extends TextMatch { label: string; patternId: string }

export interface ExtractOptions {
  /** 'auto': OCR only pages without a usable text layer. */
  ocr: 'auto' | 'never' | 'always';
  ocrDpi: number;
  onStatus?: (s: string) => void;
}
const DEFAULT_EXTRACT: ExtractOptions = { ocr: 'auto', ocrDpi: 300 };
const MIN_TEXT_CHARS = 8;        // fewer non-space chars than this => treat page as scanned
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

async function ocrLayer(page: PDFPageProxy, index: number, dpi: number, onStatus: (s: string) => void): Promise<PageText> {
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const px = base.width * base.height * scale * scale;
  if (px > OCR_MAX_PIXELS) scale *= Math.sqrt(OCR_MAX_PIXELS / px);
  const canvas = document.createElement('canvas');
  const b = new Builder();
  try {
    await renderToCanvas(page, canvas, scale);
    const words = await recognizeWords(canvas, onStatus);
    const toPt = (x0: number, y0: number, x1: number, y1: number): Rect =>
      ({ x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale });
    let line = -1;
    for (const w of words) {
      if (line !== -1) b.sep(w.line !== line ? '\n' : ' ');
      line = w.line;
      const glyphs = w.symbols.map((s) => s.text).join('');
      if (glyphs === w.text) {
        for (const s of w.symbols) for (const ch of s.text) b.push(ch, toPt(s.x0, w.y0, s.x1, w.y1), w.line);
      } else {
        const n = w.text.length, cw = (w.x1 - w.x0) / n;
        for (let k = 0; k < n; k++) b.push(w.text[k], toPt(w.x0 + k * cw, w.y0, w.x0 + (k + 1) * cw, w.y1), w.line);
      }
    }
  } finally {
    canvas.width = canvas.height = 0;
  }
  return { page: index, text: b.text, boxes: b.boxes, groups: b.groups, source: 'ocr' };
}

/** Extract one page's text + geometry, OCR-ing image-only pages when allowed. */
export async function extractPageText(doc: PDFDocumentProxy, index: number, opts: Partial<ExtractOptions> = {}): Promise<PageText> {
  const o = { ...DEFAULT_EXTRACT, ...opts };
  const page = await doc.getPage(index + 1);
  if (o.ocr !== 'always') {
    const t = await textLayer(page, index);
    if (o.ocr === 'never' || t.text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) return t;
  }
  return ocrLayer(page, index, o.ocrDpi, o.onStatus ?? (() => {}));
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
    if (p.accept && !p.accept(m, pt.text)) continue;
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

/** Run patterns over every page (OCR-ing scanned pages as needed). */
export async function searchDocument(
  cache: PageTextCache, patterns: SearchPattern[],
  onProgress: (msg: string, fraction: number) => void = () => {},
): Promise<Hit[]> {
  const n = cache.doc.numPages;
  const all: Hit[] = [];
  for (let i = 0; i < n; i++) {
    onProgress(`Reading page ${i + 1}/${n}`, i / n);
    const pt = await cache.get(i, (s) => onProgress(`Page ${i + 1}/${n}: ${s}`, i / n));
    const hits: Hit[] = [];
    for (const p of patterns) for (const m of findInPage(pt, p)) hits.push({ ...m, label: p.label, patternId: p.id });
    all.push(...dedupe(hits));
  }
  onProgress('Done', 1);
  return all;
}

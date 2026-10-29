// Split a PDF into parts (MuPDF, the same on-demand engine as "Keep original text").
// Pages are copied, never re-rendered: text, fonts and image quality stay exactly as they were.
import { loadMuPdf } from './vector';
import type { Progress } from './types';

export type SplitSpec =
  /** One file per `every` pages (1: a file per page). */
  | { mode: 'every'; every: number }
  /** One file per range, e.g. "1-3, 4, 7-". */
  | { mode: 'ranges'; ranges: string }
  /**
   * One file, each page cut in two: 'lr' left|right, 'tb' top|bottom (as the page is shown, rotation included).
   * rtl: right half first (right-to-left books). widerOnly: cut only pages wider than tall ('lr') or taller than wide ('tb'),
   * so a single-page cover in a scan of spreads stays whole.
   */
  | { mode: 'half'; cut: 'lr' | 'tb'; rtl?: boolean; widerOnly?: boolean };

export interface SplitPart {
  /** Suffix for the file name, e.g. "p01", "p1-3", "halves". */
  label: string;
  /** 0-based source pages in this part. */
  pages: number[];
  bytes: Uint8Array;
}

export class SplitRangeError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SplitRangeError'; }
}

/**
 * Parse "1-3, 5, 7-" (1-based, inclusive; "7-" = to the end, "-3" = from the start) into 0-based page lists.
 * Throws SplitRangeError with a message fit for the user.
 */
export function parseRanges(text: string, n: number): number[][] {
  const out: number[][] = [];
  for (const raw of text.replace(/\s*[-–]\s*/g, '-').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)-(\d*)$/.exec(raw) ?? /^(\d+)$/.exec(raw);
    if (!m) throw new SplitRangeError(`"${raw}" isn't a page or range. Use for example 1-3, 5, 8-`);
    const single = m.length === 2;
    const a = m[1] ? Number(m[1]) : 1;
    const b = single ? a : m[2] ? Number(m[2]) : n;
    if (!m[1] && !single && !m[2]) throw new SplitRangeError('"-" needs a page on at least one side');
    if (a < 1 || b < 1 || a > n || b > n) throw new SplitRangeError(`"${raw}" is outside 1-${n}`);
    if (a > b) throw new SplitRangeError(`"${raw}" runs backwards. Write ${b}-${a}`);
    out.push(Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k));
  }
  if (!out.length) throw new SplitRangeError('Type the pages to keep together, for example 1-3, 5, 8-');
  return out;
}

/** The pages of each output part (before any file is made), for previews and checks. */
export function planSplit(spec: SplitSpec, n: number): number[][] {
  if (spec.mode === 'every') {
    const k = Math.max(1, Math.floor(spec.every));
    return Array.from({ length: Math.ceil(n / k) }, (_, i) => Array.from({ length: Math.min(k, n - i * k) }, (_, j) => i * k + j));
  }
  if (spec.mode === 'ranges') return parseRanges(spec.ranges, n);
  return [Array.from({ length: n }, (_, i) => i)];
}

const pad = (i: number, n: number) => String(i + 1).padStart(String(n).length, '0');
function label(pages: number[], n: number): string {
  const a = pages[0], b = pages[pages.length - 1];
  return pages.length === 1 ? `p${pad(a, n)}` : `p${pad(a, n)}-${pad(b, n)}`;
}

/**
 * Split `source` (password: if it's encrypted). Parts are new, unencrypted files with no document metadata.
 * Annotations and form fields are flattened into the page first: MuPDF's page copy drops them otherwise.
 */
export async function splitPdf(source: Uint8Array, password: string | undefined, spec: SplitSpec, onProgress: Progress = () => {}): Promise<SplitPart[]> {
  onProgress('Loading PDF engine…', 0);
  const m = await loadMuPdf();
  const src = m.Document.openDocument(source.slice(), 'application/pdf').asPDF();
  if (!src) throw new Error('Not a PDF');
  try {
    if (src.needsPassword() && !src.authenticatePassword(password ?? '')) throw new Error('Wrong or missing password');
    src.bake(true, true);
    const n = src.countPages();
    const plan = planSplit(spec, n);
    const save = (doc: import('mupdf').PDFDocument) => {
      doc.getTrailer().delete('Info');
      // Full rewrite, dropping objects no page of this part uses (fonts and images of other pages).
      const buf = doc.saveToBuffer('garbage=4,compress=yes');
      try { return buf.asUint8Array().slice(); } finally { buf.destroy(); }
    };

    if (spec.mode !== 'half') {
      const parts: SplitPart[] = [];
      plan.forEach((pages, i) => {
        onProgress(`Making part ${i + 1}/${plan.length}`, i / plan.length);
        const out = new m.PDFDocument();
        try {
          const g = out.newGraftMap(); // one map per part: resources shared by its pages are copied once
          for (const p of pages) g.graftPage(-1, src, p);
          parts.push({ label: label(pages, n), pages, bytes: save(out) });
        } finally { out.destroy(); }
      });
      return parts;
    }

    const out = new m.PDFDocument();
    try {
      // Both halves share the page's content and images, so the file stays about the size of the original.
      // Each half shows its part through the CropBox.
      const g = out.newGraftMap();
      const order: number[] = [];
      for (let p = 0; p < n; p++) {
        if (p % 8 === 0) onProgress(`Cutting page ${p + 1}/${n}`, p / n);
        const sp = src.loadPage(p);
        const [x0, y0, x1, y1] = sp.getBounds();
        sp.destroy();
        const w = x1 - x0, h = y1 - y0;
        if (spec.widerOnly && (spec.cut === 'lr' ? w <= h : h <= w)) {
          g.graftPage(-1, src, p); order.push(p);
          continue;
        }
        const halves: [number, number, number, number][] = spec.cut === 'lr'
          ? [[x0, y0, x0 + w / 2, y1], [x0 + w / 2, y0, x1, y1]]
          : [[x0, y0, x1, y0 + h / 2], [x0, y0 + h / 2, x1, y1]];
        if (spec.rtl && spec.cut === 'lr') halves.reverse();
        g.graftPage(-1, src, p);
        const first = out.loadPage(out.countPages() - 1) as import('mupdf').PDFPage;
        // The second half is a copy of the page dictionary: same content and resource objects, not a second graft.
        const copy = out.newDictionary();
        first.getObject().forEach((v, k) => { if (k !== 'Parent') copy.put(k, v); });
        first.destroy();
        out.insertPage(-1, out.addObject(copy));
        for (const [j, r] of halves.entries()) {
          order.push(p);
          const page = out.loadPage(out.countPages() - 2 + j) as import('mupdf').PDFPage;
          page.setPageBox('CropBox', r); // in page space as shown: MuPDF maps it through /Rotate
          const o = page.getObject();
          for (const k of ['TrimBox', 'BleedBox', 'ArtBox']) o.delete(k);
          page.destroy();
        }
      }
      onProgress('Saving', 0.95);
      return [{ label: 'halves', pages: order, bytes: save(out) }];
    } finally { out.destroy(); }
  } finally {
    src.destroy();
  }
}

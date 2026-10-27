// "Keep original text" export: true redaction with MuPDF (AGPL-3.0, loaded on demand), then a cleanup pass.
// Text, line art and image pixels under each box are removed from the PDF itself; everything else stays as
// real text and fonts. A fail-closed verification runs afterwards (verify.ts, mode 'vector').
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream,
} from 'pdf-lib';
import type { Progress, RedactionMap } from './types';

type MuPdf = typeof import('mupdf');
let mupdf: Promise<MuPdf> | null = null;
/** ~10 MB WASM, so it is only loaded when this mode is used. */
export function loadMuPdf(): Promise<MuPdf> {
  mupdf ??= import('mupdf');
  mupdf.catch(() => { mupdf = null; });
  return mupdf;
}

/** Catalog entries that can carry hidden or active content. */
const CATALOG_STRIP = ['AcroForm', 'Names', 'Outlines', 'OpenAction', 'AA', 'Dests', 'StructTreeRoot', 'MarkInfo', 'Metadata',
  'PieceInfo', 'Threads', 'SpiderInfo', 'URI', 'Perms', 'Legal', 'Collection', 'OCProperties', 'AF', 'DSS'];
const PAGE_STRIP = ['Annots', 'AA', 'Metadata', 'PieceInfo', 'Thumb', 'B', 'StructParents', 'Tabs', 'ID', 'PZ', 'SeparationInfo', 'AF'];
/** Keys removed from every object: hidden descriptions of content, metadata, scripts. */
const ANY_STRIP = ['Metadata', 'PieceInfo', 'ActualText', 'Alt', 'JS', 'JavaScript', 'AF'];

export class HiddenLayersError extends Error {
  constructor() { super('This PDF has hidden layers. Use "Image only" to export it safely.'); this.name = 'HiddenLayersError'; }
}

export class HiddenTextError extends Error {
  constructor(readonly pages: number[]) {
    super(`Page ${pages.join(', ')} has text you can't see next to your boxes. Use "Image only" to export it safely.`);
    this.name = 'HiddenTextError';
  }
}

type Box4 = [number, number, number, number];
/**
 * Does the page still hold text nobody sees: invisible (render mode 3, or 7 clipping only), fully transparent, or
 * outside the page? Such text (often an OCR layer) need not line up with what the user saw and boxed.
 */
function hasHiddenText(m: MuPdf, page: import('mupdf').PDFPage): boolean {
  const [px0, py0, px1, py1] = page.getBounds();
  const T = 2; // pt of slack at the page edge
  const outside = (b: Box4) => b[0] < px0 - T || b[1] < py0 - T || b[2] > px1 + T || b[3] > py1 + T;
  const same = (a: Box4, b: Box4) => a.every((v, k) => Math.abs(v - b[k]) < 1);
  const shown: Box4[] = [], clipped: Box4[] = [];
  let hidden = false;
  const drawn = (t: import('mupdf').Text, ctm: import('mupdf').Matrix, alpha: number) => {
    const b = t.getBounds(null as never, ctm) as Box4;
    if (alpha < 0.05 || outside(b)) hidden = true; else shown.push(b);
  };
  const dev = new m.Device({
    fillText: (t, ctm, _cs, _c, alpha) => drawn(t, ctm, alpha),
    strokeText: (t, _s, ctm, _cs, _c, alpha) => drawn(t, ctm, alpha),
    ignoreText: () => { hidden = true; },
    clipText: (t, ctm) => { clipped.push(t.getBounds(null as never, ctm) as Box4); },
    clipStrokeText: (t, _s, ctm) => { clipped.push(t.getBounds(null as never, ctm) as Box4); },
  });
  try {
    page.runPageContents(dev, m.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  // Clipping text that was also painted is render mode 4-6; on its own it is mode 7 (invisible).
  return hidden || clipped.some((c) => !shown.some((s) => same(c, s)));
}

export interface VectorOptions {
  /** Draw black boxes (default). Off only in tests, to inspect what is left under the boxes. */
  blackBoxes?: boolean;
}

export async function exportVector(
  source: Uint8Array, password: string | undefined, redactions: RedactionMap,
  onProgress: Progress = () => {}, opts: VectorOptions = {},
): Promise<Uint8Array> {
  onProgress('Loading redaction engine…', 0);
  const m = await loadMuPdf();
  const doc = m.Document.openDocument(source.slice(), 'application/pdf').asPDF();
  if (!doc) throw new Error('Not a PDF');
  let saved: Uint8Array;
  try {
    if (doc.needsPassword() && !doc.authenticatePassword(password ?? '')) throw new Error('Wrong or missing password');
    // Hidden layers (optional content switched off) hold content the user never saw, so it can't have been
    // reviewed or boxed. Refuse rather than keep it in the file; Image only drops it (renders what is visible).
    let o = doc.getTrailer().get('Root');
    for (const k of ['OCProperties', 'D', 'OFF']) { if (!o || o.isNull()) break; o = o.get(k); }
    if (o && !o.isNull() && o.isArray() && o.length > 0) throw new HiddenLayersError();
    // Form fields and annotation appearances become page content first, so boxes over them redact them too.
    doc.bake(true, true);
    const n = doc.countPages();
    const hiddenPages: number[] = [];
    for (let i = 0; i < n; i++) {
      onProgress(`Redacting page ${i + 1}/${n}`, (i / n) * 0.8);
      const page = doc.loadPage(i) as import('mupdf').PDFPage;
      const rects = redactions[i] ?? [];
      for (const r of rects) {
        const a = page.createAnnotation('Redact');
        a.setRect([r.x, r.y, r.x + r.w, r.y + r.h]);
        a.update();
      }
      if (rects.length) {
        page.applyRedactions(
          opts.blackBoxes !== false,
          m.PDFPage.REDACT_IMAGE_PIXELS,              // blank the image pixels under the box
          m.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, // drop vector shapes fully under a box
          m.PDFPage.REDACT_TEXT_REMOVE,               // drop every glyph touching a box
        );
        // Hidden text left on a page with boxes may be a copy of what was boxed, just not lined up with it.
        if (hasHiddenText(m, page)) hiddenPages.push(i + 1);
      }
      for (const a of page.getAnnotations()) page.deleteAnnotation(a);
      for (const w of page.getWidgets()) page.deleteAnnotation(w);
      const po = page.getObject();
      for (const k of PAGE_STRIP) po.delete(k);
      page.destroy();
    }
    if (hiddenPages.length) throw new HiddenTextError(hiddenPages);
    const trailer = doc.getTrailer();
    const root = trailer.get('Root');
    for (const k of CATALOG_STRIP) root.delete(k);
    trailer.delete('Info');
    onProgress('Rebuilding file', 0.85);
    // Full rewrite (never incremental: old revisions would keep the original), dropping unused objects.
    const buf = doc.saveToBuffer('garbage=4,compress=yes,clean=yes');
    saved = buf.asUint8Array().slice();
    buf.destroy();
  } finally {
    doc.destroy();
  }
  onProgress('Cleaning up', 0.92);
  return cleanup(saved);
}

/** Second pass (pdf-lib): strip metadata/scripts everywhere and ActualText/Alt from marked content. */
async function cleanup(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const k of CATALOG_STRIP) d.catalog.delete(PDFName.of(k));
  d.context.trailerInfo.Info = undefined;
  d.context.trailerInfo.ID = undefined;

  const contentRefs = new Set<PDFRef>();
  for (const p of d.getPages()) {
    for (const k of PAGE_STRIP) p.node.delete(PDFName.of(k));
    const c = p.node.get(PDFName.of('Contents'));
    if (c instanceof PDFRef) contentRefs.add(c);
    else if (c instanceof PDFArray) c.asArray().forEach((x) => { if (x instanceof PDFRef) contentRefs.add(x); });
  }
  for (const [ref, obj] of d.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!dict) continue;
    for (const k of ANY_STRIP) dict.delete(PDFName.of(k));
    const isForm = dict.get(PDFName.of('Subtype'))?.toString() === '/Form';
    if ((contentRefs.has(ref) || isForm) && obj instanceof PDFRawStream) {
      const raw = decodePDFRawStream(obj).decode();
      const cleaned = stripMarkedContentText(raw);
      if (cleaned !== raw) {
        const z = await deflate(cleaned);
        dict.delete(PDFName.of('DecodeParms'));
        dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        dict.set(PDFName.of('Length'), d.context.obj(z.length));
        d.context.assign(ref, PDFRawStream.of(dict, z));
      }
    }
  }
  d.setProducer('Umbra PDF');
  d.setCreator('Umbra PDF');
  return d.save({ useObjectStreams: true });
}

/**
 * Remove /ActualText, /Alt and /E entries (with their string values) from inline marked-content
 * property lists: they can repeat the words that were just redacted. Returns the input if unchanged.
 */
export function stripMarkedContentText(src: Uint8Array): Uint8Array {
  const s = latin1(src);
  if (!/\/(?:ActualText|Alt|E)\b/.test(s)) return src;
  let out = '', i = 0, changed = false;
  const re = /\/(ActualText|Alt|E)(?![A-Za-z0-9#])\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const j = m.index + m[0].length;
    const end = skipString(s, j);
    if (end < 0) continue; // not followed by a string: a name operand (e.g. a resource), keep it
    out += s.slice(i, m.index);
    i = end; re.lastIndex = end; changed = true;
  }
  if (!changed) return src;
  out += s.slice(i);
  return fromLatin1(out);
}

/** If s[j] starts a PDF string, return the index after it, else -1. */
function skipString(s: string, j: number): number {
  if (s[j] === '<' && s[j + 1] !== '<') { const e = s.indexOf('>', j); return e < 0 ? -1 : e + 1; }
  if (s[j] !== '(') return -1;
  let depth = 0;
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k + 1;
  }
  return -1;
}

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
const fromLatin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

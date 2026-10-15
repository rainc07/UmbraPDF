import {
  PDFDocument, PDFRawStream, PDFFont, PDFPage, StandardFonts, TextRenderingMode,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  beginText, endText, setFontAndSize, setTextRenderingMode, setCharacterSqueeze, setTextMatrix, showText,
} from 'pdf-lib';
import { recognizeWords, type OcrWord } from './ocr';
import { renderToCanvas, type PDFDocumentProxy } from './pdf';
import type { ExportOptions, ExportResult, Progress, RedactionMap, Rect } from './types';

const PT_PER_IN = 72;
const OCR_MAX_DPI = 300;

/** Pixel-snapped rect, expanded outward so partial pixels are always covered. */
function toPixels(r: Rect, scale: number, pad = 1): [number, number, number, number] {
  const x0 = Math.floor(r.x * scale) - pad;
  const y0 = Math.floor(r.y * scale) - pad;
  const x1 = Math.ceil((r.x + r.w) * scale) + pad;
  const y1 = Math.ceil((r.y + r.h) * scale) + pad;
  return [x0, y0, x1 - x0, y1 - y0];
}

const intersects = (a: [number, number, number, number], b: [number, number, number, number]) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/**
 * Words from OCR of the *redacted* image, trimmed to what is visibly outside every box.
 * A partly covered word keeps its visible letters (glyph boxes), so "Pass" stays searchable when "port" is blacked out.
 * Glyphs touching or near a box are dropped (small margin), and so is a word that can't be split per glyph.
 */
const MIN_WORD_CONF = 30;
const MIN_GLYPH_CONF = 45;
function visibleFragments(words: OcrWord[], boxesPx: [number, number, number, number][]): OcrWord[] {
  const out: OcrWord[] = [];
  for (const w of words) {
    const h = w.y1 - w.y0;
    const m = Math.max(2, h * 0.08);
    const near = (x0: number, x1: number) =>
      boxesPx.some((b) => intersects([x0 - m, w.y0 - m, x1 - x0 + 2 * m, h + 2 * m], b));
    if (!near(w.x0, w.x1)) { if (w.confidence >= MIN_WORD_CONF) out.push(w); continue; }
    if (w.symbols.map((s) => s.text).join('') !== w.text) continue;
    let run: OcrWord['symbols'] = [];
    const flush = () => {
      const text = run.map((s) => s.text).join('');
      if (/[\p{L}\p{N}]/u.test(text)) {
        out.push({ ...w, text, x0: run[0].x0, x1: run[run.length - 1].x1, symbols: run });
      }
      run = [];
    };
    for (const s of w.symbols) {
      // A word running into a box is often read with low overall confidence, so judge its glyphs one by one.
      if (near(s.x0, s.x1) || s.confidence < MIN_GLYPH_CONF) { if (run.length) flush(); } else run.push(s);
    }
    if (run.length) flush();
  }
  return out;
}

/** Keep only characters the standard (non-embedded) Helvetica can encode. */
function encodable(font: PDFFont, text: string): string {
  let s = '';
  for (const ch of text) { try { font.encodeText(ch); s += ch; } catch { s += '?'; } }
  return s;
}

/**
 * Invisible text layer (render mode 3) from OCR of the *redacted* pixels.
 * It can only contain what is visible in the output image; words near a box are dropped too.
 */
function addTextLayer(
  page: PDFPage, font: PDFFont, fontName: string, words: OcrWord[],
  pxW: number, pxH: number, ptW: number, ptH: number,
): void {
  const sx = ptW / pxW, sy = ptH / pxH;
  const ops = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of words) {
    const text = encodable(font, w.text);
    const h = (w.y1 - w.y0) * sy;
    const width = (w.x1 - w.x0) * sx;
    const natural = font.widthOfTextAtSize(text, h);
    if (h <= 0 || natural <= 0) continue;
    ops.push(
      setFontAndSize(fontName, h),
      setCharacterSqueeze((width / natural) * 100),
      setTextMatrix(1, 0, 0, 1, w.x0 * sx, ptH - w.y1 * sy + h * 0.2),
      showText(font.encodeText(text)),
    );
  }
  ops.push(endText());
  page.pushOperators(...ops);
}

/** Native zlib (FlateDecode) via CompressionStream; null if unavailable. */
async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Lossless page pixels for FlateDecode: 1 channel when the page is grey (most documents), else RGB,
 * with PNG Paeth prediction per row (PDF Predictor 15), which typically halves the compressed size.
 */
function canvasPixels(c: HTMLCanvasElement): { data: Uint8Array; colors: 1 | 3 } {
  const W = c.width, H = c.height;
  const px = c.getContext('2d')!.getImageData(0, 0, W, H).data;
  let gray = true;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (Math.abs(r - g) > 3 || Math.abs(g - b) > 3 || Math.abs(r - b) > 3) { gray = false; break; }
  }
  const colors: 1 | 3 = gray ? 1 : 3;
  const rowLen = W * colors;
  const out = new Uint8Array((rowLen + 1) * H);
  let prev = new Uint8Array(rowLen), cur = new Uint8Array(rowLen);
  for (let y = 0; y < H; y++) {
    const base = y * W * 4;
    if (gray) for (let x = 0; x < W; x++) cur[x] = px[base + x * 4 + 1];
    else for (let x = 0, j = 0; x < W; x++) { const k = base + x * 4; cur[j++] = px[k]; cur[j++] = px[k + 1]; cur[j++] = px[k + 2]; }
    const o = y * (rowLen + 1);
    out[o] = 4; // Paeth
    for (let i = 0; i < rowLen; i++) {
      const a = i >= colors ? cur[i - colors] : 0, b = prev[i], cc = i >= colors ? prev[i - colors] : 0;
      const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      out[o + 1 + i] = (cur[i] - pred) & 0xff;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { data: out, colors };
}

function canvasToBytes(c: HTMLCanvasElement, type: string, q?: number): Promise<Uint8Array> {
  return new Promise((res, rej) =>
    c.toBlob(async (b) => {
      if (!b) return rej(new Error('Canvas encode failed (page too large for this device?)'));
      res(new Uint8Array(await b.arrayBuffer()));
    }, type, q),
  );
}

/**
 * Flattened raster export: every page is rendered to pixels, redaction boxes are burned in,
 * and a brand-new PDF is built containing only one image per page. Nothing from the source
 * object graph (text, fonts, annotations, forms, attachments, metadata, JS) is carried over.
 */
export async function exportRedacted(
  src: PDFDocumentProxy,
  redactions: RedactionMap,
  opts: ExportOptions,
  onProgress: Progress = () => {},
): Promise<ExportResult> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const downscaled: ExportResult['downscaled'] = [];
  let font: PDFFont | null = null;
  let ocrWords = 0;
  const n = src.numPages;

  for (let i = 1; i <= n; i++) {
    onProgress(`Rasterizing page ${i}/${n}`, (i - 1) / n);
    const page = await src.getPage(i);
    const base = page.getViewport({ scale: 1 });

    let scale = opts.dpi / PT_PER_IN;
    const px = base.width * scale * base.height * scale;
    if (px > opts.maxPixels) {
      scale *= Math.sqrt(opts.maxPixels / px);
      downscaled.push({ page: i, dpi: Math.floor(scale * PT_PER_IN) });
    }

    const canvas = document.createElement('canvas');
    try {
      await renderToCanvas(page, canvas, scale);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#000';
      const boxesPx = (redactions[i - 1] ?? []).map((r) => toPixels(r, scale));
      for (const b of boxesPx) ctx.fillRect(...b);

      let words: OcrWord[] = [];
      if (opts.searchable) {
        onProgress(`Reading text on page ${i}/${n}`, (i - 0.75) / n);
        // OCR a copy at most 300 DPI (4x fewer pixels at 600 DPI) with the boxes painted WHITE:
        // the hidden text is just as gone, but words next to a box are read cleanly instead of merging with it.
        const k = Math.min(1, OCR_MAX_DPI / PT_PER_IN / scale);
        const src = document.createElement('canvas');
        src.width = Math.round(canvas.width * k); src.height = Math.round(canvas.height * k);
        const c2 = src.getContext('2d', { alpha: false })!;
        c2.imageSmoothingQuality = 'high';
        c2.drawImage(canvas, 0, 0, src.width, src.height);
        c2.fillStyle = '#fff';
        for (const b of boxesPx) c2.fillRect(Math.floor(b[0] * k) - 1, Math.floor(b[1] * k) - 1, Math.ceil(b[2] * k) + 2, Math.ceil(b[3] * k) + 2);
        const raw = await recognizeWords(src, (m) => onProgress(m, (i - 0.75) / n), 0);
        src.width = src.height = 0;
        const up = (v: number) => v / k;
        words = visibleFragments(k < 1 ? raw.map((w) => ({
          ...w, x0: up(w.x0), y0: up(w.y0), x1: up(w.x1), y1: up(w.y1),
          symbols: w.symbols.map((sy) => ({ ...sy, x0: up(sy.x0), y0: up(sy.y0), x1: up(sy.x1), y1: up(sy.y1) })),
        })) : raw, boxesPx);
      }

      onProgress(`Compressing page ${i}/${n}`, (i - 0.5) / n);
      const p = out.addPage([base.width, base.height]);
      // Lossless: grey or RGB pixels, PNG-predicted, native Flate (fast). Avoids pdf-lib's pure-JS PNG decode.
      const lossless = opts.format === 'png' ? canvasPixels(canvas) : null;
      const flate = lossless ? await deflate(lossless.data) : null;
      if (flate && lossless) {
        const dict = out.context.obj({
          Type: 'XObject', Subtype: 'Image', Width: canvas.width, Height: canvas.height,
          ColorSpace: lossless.colors === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: lossless.colors, BitsPerComponent: 8, Columns: canvas.width },
        });
        const name = p.node.newXObject('Im', out.context.register(PDFRawStream.of(dict, flate)));
        p.pushOperators(
          pushGraphicsState(), concatTransformationMatrix(base.width, 0, 0, base.height, 0, 0),
          drawObject(name), popGraphicsState(),
        );
      } else {
        const img = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', opts.jpegQuality));
        p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      }
      if (words.length) {
        font ??= await out.embedFont(StandardFonts.Helvetica); // standard 14: no font program embedded
        const fontName = p.node.newFontDictionary('F', font.ref).asString();
        addTextLayer(p, font, fontName, words, canvas.width, canvas.height, base.width, base.height);
        ocrWords += words.length;
      }
    } finally {
      canvas.width = canvas.height = 0; // release GPU/heap memory early
      page.cleanup();
    }
  }

  out.setProducer('Umbra PDF');
  out.setCreator('Umbra PDF');
  onProgress('Writing PDF', 1);
  return { bytes: await out.save({ useObjectStreams: true }), downscaled, ocrWords };
}

import {
  PDFDocument, PDFRawStream, PDFFont, PDFName, PDFPage, StandardFonts, TextRenderingMode,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  beginText, endText, setFontAndSize, setTextRenderingMode, setCharacterSqueeze, setTextMatrix, showText,
} from 'pdf-lib';
import { lastOcrStats, recognizeWordsRobust, type OcrWord } from './ocr';
import { renderToCanvas, type PDFDocumentProxy } from './pdf';
import { scanDpi } from './search';
import type { ExportOptions, ExportResult, Progress, RedactionMap, Rect } from './types';

const PT_PER_IN = 72;
const OCR_MAX_DPI = 300;
const MIN_SCAN_DPI = 150;

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
 * estimated: the words were read before the boxes were drawn and letter positions are estimates, so letters keep
 * a wider berth from a box (about half a letter).
 * A partly covered word keeps its visible letters (glyph boxes), so "Pass" stays searchable when "port" is blacked out.
 * Glyphs touching or near a box are dropped (small margin), and so is a word that can't be split per glyph.
 */
const MIN_WORD_CONF = 30;
const MIN_GLYPH_CONF = 45;
function visibleFragments(words: OcrWord[], boxesPx: [number, number, number, number][], estimated = false): OcrWord[] {
  const out: OcrWord[] = [];
  for (const w of words) {
    const h = w.y1 - w.y0;
    const m = Math.max(2, h * (estimated ? 0.3 : 0.08));
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

/**
 * Words (canvas pixels) with printed ink under them: some pixels clearly darker than the paper around them.
 * Text-layer words over blank paper, a flat colour (e.g. under a drawn black bar) or off the page are dropped.
 */
const INK_DELTA = 60;        // luma below the paper level that counts as ink
const MIN_INK = 0.03;        // fraction of the word box
function inkedWords(ctx: CanvasRenderingContext2D, words: OcrWord[]): OcrWord[] {
  if (!words.length) return words;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const d = ctx.getImageData(0, 0, W, H).data; // one read: per-word reads stall on a GPU canvas
  return words.filter((w) => {
    const x0 = Math.max(0, Math.floor(w.x0)), y0 = Math.max(0, Math.floor(w.y0));
    const x1 = Math.min(W, Math.ceil(w.x1)), y1 = Math.min(H, Math.ceil(w.y1));
    if (x1 - x0 < 2 || y1 - y0 < 3) return false;
    const hist = new Uint32Array(256);
    const n = (x1 - x0) * (y1 - y0);
    for (let y = y0; y < y1; y++) {
      for (let k = (y * W + x0) * 4, e = (y * W + x1) * 4; k < e; k += 4) hist[(d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) >> 8]++;
    }
    // Paper level: the 85th percentile of brightness (letters cover well under 85% of a word's box).
    let acc = 0, paper = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.85) { paper = v; break; } }
    let dark = 0;
    for (let v = 0; v < Math.max(0, paper - INK_DELTA); v++) dark += hist[v];
    return dark >= n * MIN_INK;
  });
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
 * Each line is laid out as one line of text: the same size, one straight (possibly tilted) baseline fitted through
 * its words, and real spaces between words, so viewers read, copy and search it as "Tan Chee Kin", not "TanCheeKin".
 */
function addTextLayer(
  page: PDFPage, font: PDFFont, fontName: PDFName, words: OcrWord[], boxesPx: [number, number, number, number][],
  pxW: number, pxH: number, ptW: number, ptH: number,
): void {
  const sx = ptW / pxW, sy = ptH / pxH;
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
  const ops = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (let i0 = 0; i0 < words.length;) {
    let i1 = i0 + 1;
    while (i1 < words.length && words[i1].line === words[i0].line) i1++;
    const ws = words.slice(i0, i1).map((w) => ({ w, text: encodable(font, w.text), cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, bw: w.x1 - w.x0, bh: w.y1 - w.y0 }));
    i0 = i1;
    // Baseline direction (pixels, y down): least-squares line through the word centres. A single word, or a
    // sideways line (words taller than wide), keeps its own upright box as before.
    const n = ws.length, mx = ws.reduce((a, q) => a + q.cx, 0) / n, my = ws.reduce((a, q) => a + q.cy, 0) / n;
    const sxx = ws.reduce((a, q) => a + (q.cx - mx) ** 2, 0), sxy = ws.reduce((a, q) => a + (q.cx - mx) * (q.cy - my), 0);
    const along = n > 1 && sxx > 0 && median(ws.map((q) => q.bw / Math.max(1, q.bh))) > 0.5;
    const th = along ? Math.max(-0.5, Math.min(0.5, Math.atan(sxy / sxx))) : 0;
    // Below 2° the words are written upright (still on the fitted line): readers join slightly rotated words
    // poorly (pdf.js breaks the line, poppler staircases it), and such small tilts are mostly OCR box noise.
    const turn = Math.abs(th) >= 0.035, c = turn ? Math.cos(th) : 1, s = turn ? Math.sin(th) : 0;
    // Line height across the baseline, and each word's length along it (its upright box minus the tilt).
    const H = along ? median(ws.map((q) => Math.max(0.3 * q.bh, (q.bh - q.bw * Math.abs(s)) / c))) : 0;
    const placed = ws.map((q) => {
      const h = along ? H : q.bh, L = along ? Math.max(1, (q.bw - H * Math.abs(s)) / c) : q.bw;
      const cy = along ? my + Math.tan(th) * (q.cx - mx) : q.cy; // centre on the fitted line
      const u = q.cx * c + cy * s; // position along the baseline
      return { ...q, h, cy, u, u0: u - L / 2, u1: u + L / 2 };
    });
    // A turned line gets one squeeze for all its words (pdf.js compares positions along a turned line in units
    // scaled by the squeeze, so a different squeeze per word breaks the line up). It's the tightest fit, so no
    // word with its space runs into the next one: readers lose a space where the next word starts too early.
    const fits = placed.map((q, k) => {
      const next = placed[k + 1], span = next ? next.u0 - q.u0 : 0;
      const [len, text] = span > 0 ? [span, `${q.text} `] : [q.u1 - q.u0, q.text];
      return ((len * sx) / Math.max(1e-6, font.widthOfTextAtSize(text, q.h * sy))) * 100;
    });
    const lineTz = turn ? Math.max(0.3 * median(fits), Math.min(...fits)) : 0;
    placed.forEach((q, k) => {
      const size = q.h * sy;
      if (size <= 0) return;
      // Every word but the line's last ends with a space, in the same string (readers skip a space shown on its own).
      // When nothing (no box, no column gap) lies between it and the next word, word + space span exactly up to
      // the next word: the text then runs on as one line, and the space opens a real gap between the words, which
      // readers that place spaces by gaps (poppler) need. Otherwise the word fits its own box and the space follows.
      const next = placed[k + 1];
      const text = next ? `${q.text} ` : q.text;
      let L = q.u1 - q.u0, natural = font.widthOfTextAtSize(q.text, size);
      if (next) {
        const m = Math.max(2, q.h * 0.08), gx0 = Math.min(q.w.x1, next.w.x0), gx1 = Math.max(q.w.x1, next.w.x0);
        const y0 = Math.min(q.w.y0, next.w.y0) - m, y1 = Math.max(q.w.y1, next.w.y1) + m;
        const span = next.u0 - q.u0;
        if (span > 0 && next.u0 - q.u1 < 3 * q.h && !boxesPx.some((b) => intersects([gx0, y0, gx1 - gx0, y1 - y0], b))) {
          L = span; natural = font.widthOfTextAtSize(text, size);
        }
      }
      if (natural <= 0 || L <= 0) return;
      // Start of the word on its baseline (0.3 of the line height below the centre line), in page points.
      const d = q.u0 - q.u, bx = q.cx + d * c - 0.3 * q.h * s, by = q.cy + d * s + 0.3 * q.h * c;
      ops.push(
        setFontAndSize(fontName, size),
        setCharacterSqueeze(turn ? lineTz : ((L * sx) / natural) * 100),
        setTextMatrix(c, -s, s, c, bx * sx, ptH - by * sy),
        showText(font.encodeText(text)),
      );
    });
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

/** Canvas pixels and whether the page is grey (most documents), so lossless can store 1 channel instead of 3. */
function readPixels(c: HTMLCanvasElement): { px: Uint8ClampedArray; W: number; H: number; gray: boolean } {
  const W = c.width, H = c.height;
  const px = c.getContext('2d')!.getImageData(0, 0, W, H).data;
  let gray = true;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (Math.abs(r - g) > 3 || Math.abs(g - b) > 3 || Math.abs(r - b) > 3) { gray = false; break; }
  }
  return { px, W, H, gray };
}

/**
 * Lossless page pixels for FlateDecode: 1 channel when grey, else RGB, with PNG Paeth prediction per row
 * (PDF Predictor 15), which typically halves the compressed size. `rows` limits it to those rows (a size sample).
 */
function losslessPixels({ px, W, H, gray }: ReturnType<typeof readPixels>, rows?: number[]): { data: Uint8Array; colors: 1 | 3 } {
  const colors: 1 | 3 = gray ? 1 : 3;
  const ys = rows ?? Array.from({ length: H }, (_, y) => y);
  const rowLen = W * colors;
  const out = new Uint8Array((rowLen + 1) * ys.length);
  let prev = new Uint8Array(rowLen), cur = new Uint8Array(rowLen);
  for (let n = 0; n < ys.length; n++) {
    const base = ys[n] * W * 4;
    if (gray) for (let x = 0; x < W; x++) cur[x] = px[base + x * 4 + 1];
    else for (let x = 0, j = 0; x < W; x++) { const k = base + x * 4; cur[j++] = px[k]; cur[j++] = px[k + 1]; cur[j++] = px[k + 2]; }
    const o = n * (rowLen + 1);
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

/** Auto keeps lossless (crisper text) unless it is this much bigger than the JPEG. */
const AUTO_LOSSLESS_MAX = 1.25;
/** Rows sampled to estimate the lossless size: bands of 16 rows, one in every 8. */
function sampleRows(H: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < H; y += 128) for (let k = 0; k < 16 && y + k < H; k++) out.push(y + k);
  return out;
}

/** Lossless (Flate) or JPEG bytes for the page, per opts.format. */
async function encodePage(canvas: HTMLCanvasElement, opts: ExportOptions):
  Promise<{ flate: Uint8Array; colors: 1 | 3 } | { jpeg: Uint8Array }> {
  if (opts.format === 'jpeg') return { jpeg: await canvasToBytes(canvas, 'image/jpeg', opts.jpegQuality) };
  const pix = readPixels(canvas);
  let jpeg: Uint8Array | null = null;
  if (opts.format === 'auto') {
    jpeg = await canvasToBytes(canvas, 'image/jpeg', opts.jpegQuality);
    // Scans (paper grain, photos) compress poorly without loss: skip the full lossless pass when a sample says so.
    const rows = sampleRows(pix.H);
    const est = await deflate(losslessPixels(pix, rows).data);
    if (!est) return { jpeg };
    if (est.length * (pix.H / rows.length) > jpeg.length * AUTO_LOSSLESS_MAX * 1.2) return { jpeg };
  }
  const lossless = losslessPixels(pix);
  const flate = await deflate(lossless.data);
  if (!flate) return { jpeg: jpeg ?? await canvasToBytes(canvas, 'image/jpeg', opts.jpegQuality) };
  if (jpeg && flate.length > jpeg.length * AUTO_LOSSLESS_MAX) return { jpeg };
  return { flate, colors: lossless.colors };
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
  /**
   * Already-known text of a page (page points), reused for the searchable layer instead of a new OCR pass.
   * layer: it came from the PDF's own text layer (may hold text nobody sees), not from OCR of the pixels.
   */
  textFor?: (pageIndex: number) => Promise<{ words: OcrWord[]; layer: boolean } | null>,
): Promise<ExportResult> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const downscaled: ExportResult['downscaled'] = [];
  let font: PDFFont | null = null;
  let ocrWords = 0;
  const n = src.numPages;

  for (let i = 1; i <= n; i++) {
    onProgress(`Rasterizing page ${i}/${n}`, (i - 1) / n);
    const tp = performance.now();
    let tText = 0, how = 'no text layer';
    const page = await src.getPage(i);
    const base = page.getViewport({ scale: 1 });

    // A scanned page holds no more detail than its picture: don't render it larger (min 150 DPI for OCR).
    const srcDpi = await scanDpi(page).catch(() => null);
    let scale = Math.min(opts.dpi, srcDpi ? Math.max(MIN_SCAN_DPI, Math.ceil(srcDpi)) : Infinity) / PT_PER_IN;
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
      // Reuse text already known for the page, minus everything under or near a box: OCR read for search/Auto
      // Detect (same pixels), or the PDF's own text layer. A text layer may hold text nobody sees, possibly a copy
      // of what was boxed placed elsewhere, so it's only reused on pages without boxes, and only words with
      // printed ink under them. Pages with boxes are read again from their pixels.
      const tt = performance.now();
      let known = opts.searchable && textFor ? await textFor(i - 1) : null;
      if (known?.layer && boxesPx.length) known = null;
      if (known) {
        tText = performance.now() - tt;
        onProgress(`Reading text on page ${i}/${n}`, (i - 0.75) / n);
        const px = (v: number) => v * scale;
        words = visibleFragments(known.words.map((w) => ({
          ...w, x0: px(w.x0), y0: px(w.y0), x1: px(w.x1), y1: px(w.y1),
          symbols: w.symbols.map((sy) => ({ ...sy, x0: px(sy.x0), y0: px(sy.y0), x1: px(sy.x1), y1: px(sy.y1) })),
        })), boxesPx, true); // read from the unredacted pixels
        if (known.layer) {
          const all = words.length;
          words = inkedWords(ctx, words);
          how = `text layer reused (${words.length}/${all} words on ink)`;
        } else how = 'text read before (reused)';
      } else if (opts.searchable) {
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
        // Pages with a text layer get a plain read, no card search (scans reuse what was read).
        // A whole page of print otherwise looks like one big card and is read twice.
        const raw = await recognizeWordsRobust(src, (m) => onProgress(m, (i - 0.75) / n), true, !textFor);
        tText = performance.now() - tt; how = `read now (${src.width}x${src.height})`;
        src.width = src.height = 0;
        const up = (v: number) => v / k;
        words = visibleFragments(k < 1 ? raw.map((w) => ({
          ...w, x0: up(w.x0), y0: up(w.y0), x1: up(w.x1), y1: up(w.y1),
          symbols: w.symbols.map((sy) => ({ ...sy, x0: up(sy.x0), y0: up(sy.y0), x1: up(sy.x1), y1: up(sy.y1) })),
        })) : raw, boxesPx);
      }

      onProgress(`Compressing page ${i}/${n}`, (i - 0.5) / n);
      const p = out.addPage([base.width, base.height]);
      // Lossless is written as raw Flate (native, fast), avoiding pdf-lib's pure-JS PNG decode.
      const enc = await encodePage(canvas, opts);
      if ('flate' in enc) {
        const dict = out.context.obj({
          Type: 'XObject', Subtype: 'Image', Width: canvas.width, Height: canvas.height,
          ColorSpace: enc.colors === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: enc.colors, BitsPerComponent: 8, Columns: canvas.width },
        });
        const name = p.node.newXObject('Im', out.context.register(PDFRawStream.of(dict, enc.flate)));
        p.pushOperators(
          pushGraphicsState(), concatTransformationMatrix(base.width, 0, 0, base.height, 0, 0),
          drawObject(name), popGraphicsState(),
        );
      } else {
        const img = await out.embedJpg(enc.jpeg);
        p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      }
      if (words.length) {
        font ??= await out.embedFont(StandardFonts.Helvetica); // standard 14: no font program embedded
        const fontName = p.node.newFontDictionary('F', font.ref); // a PDFName (its string form has a '/', which breaks Tf)
        addTextLayer(p, font, fontName, words, boxesPx, canvas.width, canvas.height, base.width, base.height);
        ocrWords += words.length;
      }
      lastOcrStats.log.push(`export page ${i}: ${Math.round(performance.now() - tp)} ms, text ${how} ${Math.round(tText)} ms, ${canvas.width}x${canvas.height}`);
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

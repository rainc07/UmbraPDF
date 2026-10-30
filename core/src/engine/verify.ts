import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { closePdf, openPdf } from './pdf';
import { extractPageText } from './search';
import { isUnicodeLayerFont } from './unifont';
import type { Progress, RedactionMap, VerifyReport } from './types';

const RISKY_CATALOG_KEYS = ['AcroForm', 'Names', 'Outlines', 'OpenAction', 'AA', 'Dests', 'StructTreeRoot', 'Metadata', 'JavaScript', 'EmbeddedFiles'];
const ALLOWED_INFO = new Set(['Producer', 'Creator']);
/** Keys that must not appear in any object of the output. */
const FORBIDDEN_KEYS = ['JS', 'JavaScript', 'EmbeddedFile', 'EmbeddedFiles', 'Launch', 'Metadata', 'ActualText', 'Alt'];

/**
 * Post-export check. Fails closed.
 * - image mode: no extractable text (or, when searchable, none inside a box and only the OCR text layer's fonts),
 *   only image XObjects.
 * - vector mode (original text kept): no character inside a box; fonts and form XObjects are allowed.
 * Both: no annotations, forms, attachments, outlines, scripts, metadata, or hidden ActualText/Alt descriptions.
 */
export interface VerifyContext { searchable: boolean; redactions: RedactionMap; mode?: 'image' | 'vector' }

/**
 * Only the OCR text layer's fonts are acceptable: the non-embedded standard Helvetica, and the glyphless
 * Unicode font for Chinese and other text Helvetica can't encode (unifont.ts).
 */
function isAllowedFont(d: PDFDict | undefined): boolean {
  if (!d) return false;
  if (d.get(PDFName.of('Subtype'))?.toString() === '/Type0') return isUnicodeLayerFont(d);
  return d.get(PDFName.of('Subtype'))?.toString() === '/Type1'
    && d.get(PDFName.of('BaseFont'))?.toString() === '/Helvetica'
    && d.get(PDFName.of('FontDescriptor')) === undefined;
}

export async function verifyOutput(
  bytes: Uint8Array, onProgress: Progress = () => {},
  ctx: VerifyContext = { searchable: false, redactions: [] },
): Promise<VerifyReport> {
  const issues: string[] = [];
  const vector = ctx.mode === 'vector';

  // 1) Structural inspection (pdf-lib)
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  const catalogKeys = RISKY_CATALOG_KEYS.filter((k) => d.catalog.get(PDFName.of(k)) !== undefined);
  if (catalogKeys.length) issues.push(`Catalog contains: ${catalogKeys.join(', ')}`);

  const fontPages: number[] = [];
  let annotations = 0;
  const contentRefs = new Set<PDFRef>();
  d.getPages().forEach((p, i) => {
    const res = p.node.Resources();
    const fonts = res?.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (!vector && fonts && fonts.keys().length) {
      const ok = ctx.searchable && fonts.keys().every((k) => isAllowedFont(fonts.lookupMaybe(k, PDFDict)));
      if (!ok) fontPages.push(i + 1);
    }
    if (!vector) {
      const xo = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      for (const k of xo?.keys() ?? []) {
        const sub = (xo!.lookup(k) as { dict?: PDFDict })?.dict?.get(PDFName.of('Subtype'));
        if (sub?.toString() !== '/Image') issues.push(`Page ${i + 1}: non-image XObject ${k.toString()}`);
      }
    }
    const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    annotations += annots?.size() ?? 0;
    const c = p.node.get(PDFName.of('Contents'));
    if (c instanceof PDFRef) contentRefs.add(c);
    else if (c instanceof PDFArray) c.asArray().forEach((x) => { if (x instanceof PDFRef) contentRefs.add(x); });
  });
  if (fontPages.length) issues.push(`Fonts present on pages: ${fontPages.join(', ')}`);

  // Every object: no scripts, attachments, metadata streams or hidden text descriptions.
  const forbidden = new Set<string>();
  let markedText = 0;
  for (const [ref, obj] of d.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!dict) continue;
    for (const k of FORBIDDEN_KEYS) if (dict.get(PDFName.of(k)) !== undefined) forbidden.add(k);
    if (dict.get(PDFName.of('S'))?.toString() === '/JavaScript') forbidden.add('JavaScript action');
    const isForm = dict.get(PDFName.of('Subtype'))?.toString() === '/Form';
    if ((contentRefs.has(ref) || isForm) && obj instanceof PDFRawStream) {
      try {
        const txt = new TextDecoder('latin1').decode(decodePDFRawStream(obj).decode());
        if (/\/(?:ActualText|Alt)\s*[(<]/.test(txt)) markedText++;
      } catch { issues.push('Unreadable content stream'); }
    }
  }
  if (forbidden.size) issues.push(`Forbidden entries present: ${[...forbidden].join(', ')}`);
  if (markedText) issues.push(`Hidden ActualText/Alt descriptions in ${markedText} content stream(s)`);

  const infoRef = d.context.trailerInfo.Info;
  const info = infoRef ? d.context.lookupMaybe(infoRef, PDFDict) : undefined;
  const metadataFields = (info?.keys() ?? []).map((k: PDFName) => k.decodeText()).filter((k: string) => !ALLOWED_INFO.has(k));
  if (metadataFields.length) issues.push(`Metadata fields present: ${metadataFields.join(', ')}`);

  // 2) Text extraction (pdf.js) — the definitive "can anything be copied out" test
  const doc = await openPdf(bytes);
  let textChars = 0;
  let textInBoxes = 0;
  const textPages: number[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(`Verifying page ${i}/${doc.numPages}`, i / doc.numPages);
      const boxes = ctx.redactions[i - 1] ?? [];
      const page = await doc.getPage(i);
      annotations += (await page.getAnnotations()).length;
      // Keep original text keeps the text of pages without boxes on purpose: nothing there can be inside a box.
      if (vector && !boxes.length) { page.cleanup(); continue; }
      // Character geometry (rotation-aware). A character whose centre lies inside a box is a leak.
      const pt = await extractPageText(doc, i - 1, { ocr: 'never', near: boxes });
      let c = 0;
      for (let k = 0; k < pt.text.length; k++) {
        if (!pt.text[k].trim()) continue;
        c++;
        const r = pt.boxes[k];
        if (!r) continue;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        if (boxes.some((b) => cx > b.x + 0.5 && cx < b.x + b.w - 0.5 && cy > b.y + 0.5 && cy < b.y + b.h - 0.5)) textInBoxes++;
      }
      if (c) { textChars += c; textPages.push(i); }
      page.cleanup();
    }
    if (await doc.getAttachments()) issues.push('Attachments present');
  } finally {
    await closePdf(doc);
  }
  if (textChars && !ctx.searchable && !vector) issues.push(`Extractable text: ${textChars} chars on pages ${textPages.join(', ')}`);
  if (textInBoxes) issues.push(`${textInBoxes} text character(s) located inside redaction boxes`);
  if (annotations) issues.push(`Annotations present: ${annotations}`);

  return {
    ok: issues.length === 0,
    pages: d.getPageCount(),
    textChars, textPages, textInBoxes, searchable: ctx.searchable || vector, fontPages, annotations, catalogKeys, metadataFields, issues,
  };
}

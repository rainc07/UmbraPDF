// Unicode font for the invisible OCR text layer: words Helvetica can't encode (Chinese, and other scripts).
// The text is never drawn (render mode 3), so the font has no glyph shapes. Each character is written as its
// UTF-16 code (Identity-H), every one is 1 em wide, and a ToUnicode map gives readers back the text to search
// and copy. Built the same way as Tesseract's and OCRmyPDF's glyphless text layers.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from 'pdf-lib';

/** A TrueType font with an empty .notdef and one empty 1-em glyph (620 bytes, made with fontTools). */
const GLYPHLESS_TTF =
  'AAEAAAAKAIAAAwAgT1MvMkTfRYQAAAEoAAAAYGNtYXAADABGAAABkAAAACxnbHlmAAAAAAAAAcQAAAABaGVhZC0qHjwAAACsAAAANmhoZWEDIgMiAAAA5AAAACRobXR4A+gAAAAAAYgAAAAGbG9jYQAAAAAAAAG8AAAABm1heHAAAwACAAABCAAAACBuYW1lZK6WYQAAAcgAAAB1cG9zdG1nc80AAAJAAAAALAABAAAAAQAADye6Z18PPPUAAwPoAAAAAOcJ7q4AAAAA5wnurgAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAAAPoAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwPoAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPz8/PwAAAAAAAAMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAD6AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAGAAAAAIAAgAAAAD//wAA//8AAQAAAAAAAAAAAAAAAAAAAAAABAA2AAEAAAAAAAEADgAAAAEAAAAAAAIABwAOAAMAAQQJAAEAHAAVAAMAAQQJAAIADgAxVW1icmFHbHlwaGxlc3NSZWd1bGFyAFUAbQBiAHIAYQBHAGwAeQBwAGgAbABlAHMAcwBSAGUAZwB1AGwAYQByAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAQIFYmxhbms=';

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** ToUnicode: code = UTF-16 unit, for the whole Basic Multilingual Plane except the surrogates. */
function toUnicodeCMap(): string {
  const ranges: string[] = [];
  for (let hi = 0; hi < 256; hi++) if (hi < 0xd8 || hi > 0xdf) ranges.push(`<${hex4(hi << 8)}> <${hex4((hi << 8) | 0xff)}> <${hex4(hi << 8)}>`);
  const blocks: string[] = [];
  for (let i = 0; i < ranges.length; i += 100) blocks.push(`${Math.min(100, ranges.length - i)} beginbfrange\n${ranges.slice(i, i + 100).join('\n')}\nendbfrange`);
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks.join('\n')}
endcmap
CMapName currentdict /CMapResource defineresource pop
end
end`;
}

/** Add the font to the document (once per document); returns its reference for each page's resources. */
const glyphless = () => Uint8Array.from(atob(GLYPHLESS_TTF), (c) => c.charCodeAt(0));
const NAME = 'UmbraGlyphless';

export function embedUnicodeFont(doc: PDFDocument): PDFRef {
  const ctx = doc.context;
  const ttf = glyphless();
  const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = ctx.register(ctx.obj({
    Type: 'FontDescriptor', FontName: NAME, Flags: 4, FontBBox: [0, -200, 1000, 800], ItalicAngle: 0,
    Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80, FontFile2: file,
  }));
  // Every code shows glyph 1 (the empty one), whatever it is.
  const gids = new Uint8Array(65536 * 2);
  for (let i = 1; i < gids.length; i += 2) gids[i] = 1;
  const cid = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'CIDFontType2', BaseFont: NAME,
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
    FontDescriptor: descriptor, DW: 1000, CIDToGIDMap: ctx.register(ctx.flateStream(gids)),
  }));
  return ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: NAME, Encoding: 'Identity-H',
    DescendantFonts: [cid], ToUnicode: ctx.register(ctx.flateStream(toUnicodeCMap())),
  }));
}

/** Characters outside the BMP have no code here: they become '?'. */
const bmp = (text: string) => text.replace(/[\u{10000}-\u{10FFFF}]/gu, '?');

/** Text in the Unicode font: 2 bytes per character. */
export const unicodeText = (text: string): PDFHexString => PDFHexString.of([...bmp(text)].map((c) => hex4(c.charCodeAt(0))).join(''));

/** Width in points: every character is 1 em. */
export const unicodeWidth = (text: string, size: number): number => [...bmp(text)].length * size;

/**
 * For the export check: true only for this font exactly as embedUnicodeFont writes it, with no other font
 * program than the glyphless one (so no shapes can hide anything).
 */
export function isUnicodeLayerFont(d: PDFDict): boolean {
  try {
    const n = (k: string, x: PDFDict = d) => x.get(PDFName.of(k))?.toString();
    if (n('Subtype') !== '/Type0' || n('BaseFont') !== `/${NAME}` || n('Encoding') !== '/Identity-H') return false;
    const kids = d.lookup(PDFName.of('DescendantFonts'), PDFArray);
    if (kids.size() !== 1) return false;
    const cid = kids.lookup(0, PDFDict);
    if (n('Subtype', cid) !== '/CIDFontType2' || n('BaseFont', cid) !== `/${NAME}`) return false;
    const fd = cid.lookup(PDFName.of('FontDescriptor'), PDFDict);
    if (fd.has(PDFName.of('FontFile')) || fd.has(PDFName.of('FontFile3'))) return false;
    const file = fd.lookup(PDFName.of('FontFile2'));
    if (!(file instanceof PDFRawStream)) return false;
    const got = decodePDFRawStream(file).decode(), want = glyphless();
    return got.length === want.length && got.every((b, i) => b === want[i]);
  } catch { return false; }
}

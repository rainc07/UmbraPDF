// Platform-agnostic engine: no DOM UI, no host APIs. Reused by Android, desktop (Tauri) and browser shells.
export * from './types';
export { openPdf, closePdf, pageSizes, renderToCanvas, PasswordRequiredError } from './pdf';
export type { PDFDocumentProxy } from './pdf';
export { exportRedacted } from './redact';
export { verifyOutput } from './verify';
export { ocrRedactedRegions, getOcrWorker, terminateOcr, setOcrEngine, getOcrEngine, warmUpOcr } from './ocr';
export {
  extractPageText, PageTextCache, pageTextWords, findInPage, rectsForRange, literalPattern, searchDocument,
} from './search';
export type { PageText, TextMatch, SearchPattern, Hit, ExtractOptions } from './search';
export { PRESETS, DEFAULT_PRESET_IDS, buildPatterns, compileCustom, luhn } from './detect';
export type { Preset, CustomPattern, DetectOptions } from './detect';
export { exportVector, loadMuPdf, stripMarkedContentText } from './vector';

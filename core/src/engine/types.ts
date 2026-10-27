/** Rectangle in PDF points, in the page's displayed (rotation-applied) space, origin top-left. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Displayed page size in PDF points (rotation applied). */
export interface PageSize { width: number; height: number }

/** pageIndex (0-based) -> rects */
export type RedactionMap = ReadonlyArray<ReadonlyArray<Rect>>;

export interface ExportOptions {
  dpi: number;            // default 300
  format: 'auto' | 'png' | 'jpeg'; // png = lossless; auto = per page, lossless unless JPEG is much smaller
  jpegQuality: number;    // 0..1
  maxPixels: number;      // per-page cap; DPI is reduced for oversized pages
  searchable: boolean;    // add invisible OCR text layer (visible areas only)
}

export const DEFAULT_EXPORT: ExportOptions = {
  dpi: 300,
  format: 'auto',
  jpegQuality: 0.85,
  maxPixels: 36_000_000,
  searchable: false,
};

export interface ExportResult {
  bytes: Uint8Array;
  downscaled: { page: number; dpi: number }[]; // 1-based pages rendered below requested DPI
  ocrWords: number;                            // words in the searchable text layer
}

export interface VerifyReport {
  ok: boolean;
  pages: number;
  textChars: number;
  textPages: number[];
  textInBoxes: number;     // text items overlapping a redaction box (must be 0)
  searchable: boolean;
  fontPages: number[];
  annotations: number;
  catalogKeys: string[];   // risky catalog entries found (AcroForm, Names, Outlines, OpenAction...)
  metadataFields: string[];
  ocr?: {
    checkedRegions: number;
    /** Regions proven safe by pixels alone (solid black: nothing readable can be there). */
    solidRegions?: number;
    leaks: { page: number; text: string; confidence: number }[];
  };
  issues: string[];
  notes?: string[];        // non-blocking information (e.g. optional check unavailable)
}

export type Progress = (msg: string, fraction: number) => void;

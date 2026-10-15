import { createWorker, OEM, type Worker } from 'tesseract.js';
import { vendorUrl } from './paths';
import { closePdf, openPdf, renderToCanvas } from './pdf';
import type { Progress, RedactionMap, VerifyReport } from './types';

let worker: Promise<Worker> | null = null;
let status: (s: string) => void = () => {};
const LOAD_TIMEOUT_MS = 60_000;

/**
 * Lazily create a fully-offline tesseract worker (local worker, core and traineddata).
 * Fails (instead of hanging) if the engine is not ready within LOAD_TIMEOUT_MS.
 */
export function getOcrWorker(onStatus: (s: string) => void = () => {}): Promise<Worker> {
  status = onStatus;
  if (worker) return worker;
  let timer = 0;
  const created = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: vendorUrl('tesseract/worker.min.js'),
    corePath: vendorUrl('tesseract/core/'),
    langPath: vendorUrl('tesseract/lang'),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: false,
    logger: (m: { status: string; progress: number }) => status(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`),
    errorHandler: (e: unknown) => console.error('[umbra] tesseract error', e),
  });
  const timeout = new Promise<never>((_, rej) => {
    timer = window.setTimeout(() => rej(new Error('OCR engine failed to load within 60 s (last step shown above). Export was not saved.')), LOAD_TIMEOUT_MS);
  });
  worker = Promise.race([created, timeout]).finally(() => clearTimeout(timer));
  worker.catch(async () => {
    worker = null;
    (await created.catch(() => null))?.terminate();
  });
  return worker;
}

export async function terminateOcr(): Promise<void> {
  if (!worker) return;
  const w = await worker.catch(() => null);
  worker = null;
  await w?.terminate();
}

const OCR_DPI = 150;
const MIN_CONF = 60;

/**
 * Residual-leak check: OCR every redacted region of the *exported* file and
 * flag any recognised text. Expected result: zero leaks (regions are solid black).
 */
export async function ocrRedactedRegions(
  bytes: Uint8Array,
  redactions: RedactionMap,
  onProgress: Progress = () => {},
): Promise<NonNullable<VerifyReport['ocr']>> {
  onProgress('Loading OCR engine…', 0);
  const w = await getOcrWorker((m) => onProgress(m, 0));
  const doc = await openPdf(bytes);
  const leaks: NonNullable<VerifyReport['ocr']>['leaks'] = [];
  let checkedRegions = 0;
  const scale = OCR_DPI / 72;
  try {
    for (let i = 0; i < redactions.length; i++) {
      const rects = redactions[i];
      if (!rects?.length || i >= doc.numPages) continue;
      onProgress(`OCR check page ${i + 1}`, i / redactions.length);
      const page = await doc.getPage(i + 1);
      const full = document.createElement('canvas');
      await renderToCanvas(page, full, scale);
      for (const r of rects) {
        const crop = document.createElement('canvas');
        crop.width = Math.max(8, Math.round(r.w * scale));
        crop.height = Math.max(8, Math.round(r.h * scale));
        crop.getContext('2d')!.drawImage(full, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, crop.width, crop.height);
        const { data } = await w.recognize(crop);
        checkedRegions++;
        const text = data.text.replace(/\s+/g, ' ').trim();
        if (text.length >= 2 && data.confidence >= MIN_CONF) leaks.push({ page: i + 1, text, confidence: data.confidence });
        crop.width = crop.height = 0;
      }
      full.width = full.height = 0;
      page.cleanup();
    }
  } finally {
    await closePdf(doc);
  }
  return { checkedRegions, leaks };
}

export interface OcrBox { x0: number; y0: number; x1: number; y1: number }
export interface OcrSymbol extends OcrBox { text: string; confidence: number }
export interface OcrWord extends OcrBox {
  text: string;
  confidence: number;
  line: number;          // running line index across the page (reading order)
  symbols: OcrSymbol[];  // per-glyph boxes (may be empty or not 1:1 with text)
}

/** OCR a canvas into positioned words (with line index and glyph boxes), in canvas pixels. */
export async function recognizeWords(canvas: HTMLCanvasElement, onStatus: (s: string) => void = () => {}, minConfidence = 30): Promise<OcrWord[]> {
  const w = await getOcrWorker(onStatus);
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  const words: OcrWord[] = [];
  let line = 0;
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    for (const wd of l.words) {
      const text = wd.text.trim();
      if (!text || wd.confidence < minConfidence) continue;
      const symbols = (wd.symbols ?? []).map((s) => ({ text: s.text, confidence: s.confidence, ...s.bbox }));
      words.push({ text, confidence: wd.confidence, line, symbols, ...wd.bbox });
    }
    line++;
  }
  return words;
}

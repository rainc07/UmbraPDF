import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import { vendorUrl } from './paths';
import type { PageSize } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.min.mjs');

export type { PDFDocumentProxy, PDFPageProxy };
export const AnnotationMode = pdfjs.AnnotationMode;
export const Util = pdfjs.Util;
export const OPS = pdfjs.OPS;

export class PasswordRequiredError extends Error {
  constructor(public readonly incorrect: boolean) { super(incorrect ? 'Incorrect password' : 'Password required'); }
}

/** Open a PDF fully offline. Input buffer is copied (pdf.js transfers/detaches it). */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: vendorUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
    wasmUrl: vendorUrl('pdfjs/wasm/'),
    iccUrl: vendorUrl('pdfjs/iccs/'),
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    stopAtErrors: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  try {
    return await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === 'PasswordException') {
      await task.destroy().catch(() => {});
      throw new PasswordRequiredError(err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    }
    throw e;
  }
}

/** Close a document and free its worker resources (pdf.js 6: via the loading task). */
export const closePdf = (doc: PDFDocumentProxy): Promise<void> => doc.loadingTask.destroy();

export async function pageSizes(doc: PDFDocumentProxy): Promise<PageSize[]> {
  const sizes: PageSize[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
  }
  return sizes;
}

/** Render a page into a canvas at `scale` (CSS px per point × devicePixelRatio handled by caller). */
export async function renderToCanvas(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): Promise<void> {
  const vp = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: AnnotationMode.ENABLE }).promise;
}

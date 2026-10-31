import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import { vendorUrl } from './paths';
import type { PageSize } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.compat.mjs');

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

/** Yield to the event loop without waiting for a frame (a MessageChannel task isn't throttled like timers). */
export function nextTask(): Promise<void> {
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
}

/**
 * Render a page into a canvas at `scale` (CSS px per point × devicePixelRatio handled by caller).
 * pdf.js paces rendering by animation frames, made for drawing on screen. Our canvases are never on screen, and
 * frames can be very slow: phones with a variable refresh rate (e.g. Galaxy S23) drop to 1-10 Hz while the screen
 * is still, so a page that renders in 0.2 s took many seconds unless the user touched the screen. Pace by tasks.
 */
export async function renderToCanvas(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): Promise<void> {
  const vp = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  // A CPU (software) canvas: every page we render is read back (encode, OCR, checks). In Android's WebView a GPU
  // canvas only does its work when the app draws a frame, so a still screen (1-10 Hz) stalled exports until the
  // user swiped. The other offscreen canvases in the engine are CPU canvases for the same reason.
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: AnnotationMode.ENABLE });
  const internal = (task as unknown as { _internalRenderTask?: { _useRequestAnimationFrame?: boolean } })._internalRenderTask;
  if (internal) internal._useRequestAnimationFrame = false;
  task.onContinue = (cont: () => void) => { void nextTask().then(cont); };
  await task.promise;
}

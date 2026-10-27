/// <reference lib="webworker" />
// PaddleOCR PP-OCRv5 mobile (Apache-2.0) on ONNX Runtime Web (MIT), in a dedicated worker so the UI stays smooth.
// The detection and recognition steps are in ppocr.pipeline.ts (shared with the desktop server).
// Everything is local: models and the WASM runtime are bundled under vendor/.
import * as ort from 'onnxruntime-web/wasm';
import { detectStrips, flipStrip, parseDict, recognise, useTensor, type Img, type PpLine, type PpRec } from './ppocr.pipeline';

export type { PpLine, PpRec };
export type PpRequest =
  | { id: number; kind: 'init'; base: string; det: boolean }
  | { id: number; kind: 'det'; img: ImageData; limit: number }
  | { id: number; kind: 'rec'; strips: Float32Array[]; widths: number[]; flip: boolean };
export type PpResponse =
  | { id: number; ok: true; quads?: [number, number][][]; strips?: Float32Array[]; widths?: number[]; recs?: PpRec[]; ms?: number }
  | { id: number; ok: false; error: string };

let det: ort.InferenceSession, rec: ort.InferenceSession, chars: string[];
useTensor((data, dims) => new ort.Tensor('float32', data, dims));

async function init(base: string, withDet: boolean) {
  ort.env.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const load = async (f: string) => new Uint8Array(await (await fetch(`${base}ppocr/${f}`)).arrayBuffer());
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [d, r, dict] = await Promise.all([withDet ? load('det.onnx') : null, load('rec_en.onnx'), fetch(`${base}ppocr/dict_en.txt`).then((x) => x.text())]);
  if (d) det = await ort.InferenceSession.create(d, opts);
  rec = await ort.InferenceSession.create(r, opts);
  chars = parseDict(dict);
}

let ready: Promise<void> | null = null;
const post = (r: PpResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);
self.onmessage = async (e: MessageEvent<PpRequest>) => {
  const m = e.data;
  try {
    if (m.kind === 'init') { ready ??= init(m.base, m.det); await ready; post({ id: m.id, ok: true }); return; }
    if (!ready) throw new Error('not initialised');
    await ready;
    const t0 = performance.now();
    if (m.kind === 'det') {
      const r = await detectStrips(det, m.img as Img, m.limit);
      post({ id: m.id, ok: true, quads: r.quads, strips: r.strips, widths: r.widths, ms: performance.now() - t0 }, r.strips.map((x) => x.buffer));
    } else {
      const strips = m.flip ? m.strips.map((x, i) => flipStrip(x, m.widths[i])) : m.strips;
      post({ id: m.id, ok: true, recs: await recognise(rec, chars, strips, m.widths), ms: performance.now() - t0 });
    }
  } catch (err) {
    if (m.kind === 'init') ready = null;
    post({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};

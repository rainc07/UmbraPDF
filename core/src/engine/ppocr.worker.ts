/// <reference lib="webworker" />
// PaddleOCR PP-OCRv5 mobile (Apache-2.0) on ONNX Runtime Web (MIT), in a dedicated worker so the UI stays smooth.
// Text detection (DB) finds every text line at any angle; recognition (CTC) reads each line.
// Everything is local: models and the WASM runtime are bundled under vendor/.
import * as ort from 'onnxruntime-web/wasm';

export interface PpLine {
  /** Corners in reading order of the text: start-top, end-top, end-bottom, start-bottom (input pixels). */
  quad: [number, number][];
  text: string;
  conf: number;
  /** Per character: start/end as a fraction of the line length. */
  chars: { c: string; u0: number; u1: number }[];
}
export type PpRec = Omit<PpLine, 'quad'>;
export type PpRequest =
  | { id: number; kind: 'init'; base: string; det: boolean }
  | { id: number; kind: 'det'; img: ImageData; limit: number }
  | { id: number; kind: 'rec'; strips: Float32Array[]; widths: number[]; flip: boolean };
export type PpResponse =
  | { id: number; ok: true; quads?: [number, number][][]; strips?: Float32Array[]; widths?: number[]; recs?: PpRec[]; ms?: number }
  | { id: number; ok: false; error: string };

let det: ort.InferenceSession, rec: ort.InferenceSession, chars: string[];

async function init(base: string, withDet: boolean) {
  ort.env.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const load = async (f: string) => new Uint8Array(await (await fetch(`${base}ppocr/${f}`)).arrayBuffer());
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [d, r, dict] = await Promise.all([withDet ? load('det.onnx') : null, load('rec_en.onnx'), fetch(`${base}ppocr/dict_en.txt`).then((x) => x.text())]);
  if (d) det = await ort.InferenceSession.create(d, opts);
  rec = await ort.InferenceSession.create(r, opts);
  chars = [...dict.split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1), ' '];
}

// ---------- detection ----------
type P = [number, number];

/** Convex hull (monotone chain). */
function hull(pts: P[]): P[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P[] = [], up: P[] = [];
  for (const x of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], x) <= 0) lo.pop(); lo.push(x); }
  for (let i = p.length - 1; i >= 0; i--) { const x = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], x) <= 0) up.pop(); up.push(x); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Minimum-area rectangle of a point set: centre, size along its own axes and the axis angle. */
function minRect(pts: P[]) {
  const h = hull(pts);
  if (h.length < 3) { const [x, y] = pts[0]; return { cx: x, cy: y, w: 1, h: 1, a: 0 }; }
  let best = { area: Infinity, cx: 0, cy: 0, w: 0, h: 0, a: 0 };
  for (let i = 0; i < h.length; i++) {
    const [x0, y0] = h[i], [x1, y1] = h[(i + 1) % h.length];
    const a = Math.atan2(y1 - y0, x1 - x0), c = Math.cos(a), s = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of h) { const u = x * c + y * s, v = -x * s + y * c; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      best = { area, cx: um * c - vm * s, cy: um * s + vm * c, w: u1 - u0, h: v1 - v0, a };
    }
  }
  return best;
}

/** DB post-processing: threshold, connected components, min-area rectangles, score filter, unclip. */
async function detect(img: ImageData, limit: number): Promise<{ quads: P[][]; ms: number }> {
  const { width: W, height: H, data } = img;
  const r = Math.min(1, limit / Math.max(W, H));
  const nw = Math.max(32, Math.round((W * r) / 32) * 32), nh = Math.max(32, Math.round((H * r) / 32) * 32);
  const x = new Float32Array(3 * nw * nh), plane = nw * nh;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const sx = W / nw, sy = H / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(H - 1, (y + 0.5) * sy - 0.5), iy = Math.max(0, Math.floor(fy)), ay = Math.max(0, fy - iy), iy1 = Math.min(H - 1, iy + 1);
    for (let xx = 0; xx < nw; xx++) {
      const fx = Math.min(W - 1, (xx + 0.5) * sx - 0.5), ix = Math.max(0, Math.floor(fx)), ax = Math.max(0, fx - ix), ix1 = Math.min(W - 1, ix + 1);
      const o = y * nw + xx;
      for (let k = 0; k < 3; k++) {
        const ch = 2 - k; // model channels are BGR
        const v = (1 - ay) * ((1 - ax) * data[(iy * W + ix) * 4 + ch] + ax * data[(iy * W + ix1) * 4 + ch])
          + ay * ((1 - ax) * data[(iy1 * W + ix) * 4 + ch] + ax * data[(iy1 * W + ix1) * 4 + ch]);
        x[k * plane + o] = (v / 255 - mean[k]) / std[k];
      }
    }
  }
  const t0 = performance.now();
  const out = await det.run({ x: new ort.Tensor('float32', x, [1, 3, nh, nw]) });
  const ms = performance.now() - t0;
  const prob = (Object.values(out)[0] as ort.Tensor).data as Float32Array;
  const lab = new Int32Array(plane), quads: P[][] = [], stack: number[] = [];
  let n = 0;
  for (let s = 0; s < plane; s++) {
    if (prob[s] <= 0.3 || lab[s]) continue;
    n++;
    const pts: P[] = [];
    let sum = 0;
    lab[s] = n; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, px = i % nw, py = (i / nw) | 0;
      pts.push([px + 0.5, py + 0.5]); sum += prob[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx, qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= nw || qy >= nh) continue;
        const j = qy * nw + qx;
        if (!lab[j] && prob[j] > 0.3) { lab[j] = n; stack.push(j); }
      }
    }
    if (pts.length < 10 || sum / pts.length < 0.6) continue;
    const m = minRect(pts);
    const d = (m.w * m.h * 1.5) / (2 * (m.w + m.h)); // unclip
    const w = m.w + 2 * d, h = m.h + 2 * d;
    if (Math.min(w, h) < 3) continue;
    const c = Math.cos(m.a), si = Math.sin(m.a);
    const corner = (u: number, v: number): P => [(m.cx + u * c - v * si) * sx, (m.cy + u * si + v * c) * sy];
    quads.push([corner(-w / 2, -h / 2), corner(w / 2, -h / 2), corner(w / 2, h / 2), corner(-w / 2, h / 2)]);
  }
  return { quads, ms };
}

// ---------- recognition ----------
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Corners ordered for reading: long side horizontal, starting top-left (text assumed upright; 180° checked later). */
function readingOrder(q: P[]): P[] {
  // Clockwise from the corner with the smallest x+y.
  let c = [...q];
  const cx = c.reduce((a, p) => a + p[0], 0) / 4, cy = c.reduce((a, p) => a + p[1], 0) / 4;
  c.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  for (let i = 1; i < 4; i++) if (c[i][0] + c[i][1] < c[k][0] + c[k][1]) k = i;
  c = [0, 1, 2, 3].map((i) => c[(i + k) % 4]);
  // Tall box: text runs vertically (a sideways page). Start from the corner that makes the long side the "width".
  if (dist(c[0], c[3]) > 1.5 * dist(c[0], c[1])) c = [c[3], c[0], c[1], c[2]];
  return c;
}

/** Warp a quad (reading order) to an upright strip of height 48, bilinear, BGR-normalised into `x` at column offset 0. */
function strip(img: ImageData, q: P[], outW: number): Float32Array {
  const H = 48, { width: W, height: Hh, data } = img, x = new Float32Array(3 * H * outW);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const lx = q[0][0] + (q[3][0] - q[0][0]) * v, ly = q[0][1] + (q[3][1] - q[0][1]) * v;
    const rx = q[1][0] + (q[2][0] - q[1][0]) * v, ry = q[1][1] + (q[2][1] - q[1][1]) * v;
    for (let xx = 0; xx < outW; xx++) {
      const u = (xx + 0.5) / outW;
      let fx = lx + (rx - lx) * u - 0.5, fy = ly + (ry - ly) * u - 0.5;
      fx = Math.min(Math.max(fx, 0), W - 1.001); fy = Math.min(Math.max(fy, 0), Hh - 1.001);
      const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
      const i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for (let k = 0; k < 3; k++) {
        const ch = 2 - k;
        const val = (1 - ay) * ((1 - ax) * data[i00 + ch] + ax * data[i10 + ch]) + ay * ((1 - ax) * data[i01 + ch] + ax * data[i11 + ch]);
        x[k * H * outW + y * outW + xx] = (val / 255 - 0.5) / 0.5;
      }
    }
  }
  return x;
}

/** Same strip turned 180° (planes stay planes; rows and columns reversed). */
function flipStrip(x: Float32Array, w: number): Float32Array {
  const o = new Float32Array(x.length), plane = 48 * w;
  for (let k = 0; k < 3; k++) for (let i = 0; i < plane; i++) o[k * plane + i] = x[k * plane + plane - 1 - i];
  return o;
}

/** Recognise strips in batches (similar widths together, zero-padded); greedy CTC decode with char positions. */
async function recognise(strips: Float32Array[], widths: number[]): Promise<PpRec[]> {
  const res: PpRec[] = new Array(strips.length);
  const order = widths.map((_, i) => i).sort((a, b) => widths[a] - widths[b]);
  // Batches of similar widths (padding is wasted work), at most 8 strips each.
  const batches: number[][] = [];
  for (const i of order) {
    const b = batches[batches.length - 1];
    if (b && b.length < 8 && widths[i] <= 1.3 * widths[b[0]]) b.push(i); else batches.push([i]);
  }
  for (const idx of batches) {
    const maxW = Math.max(...idx.map((i) => widths[i]));
    const x = new Float32Array(idx.length * 3 * 48 * maxW);
    idx.forEach((i, b) => {
      const one = strips[i], w = widths[i];
      for (let k = 0; k < 3; k++) for (let y = 0; y < 48; y++) {
        x.set(one.subarray(k * 48 * w + y * w, k * 48 * w + (y + 1) * w), b * 3 * 48 * maxW + k * 48 * maxW + y * maxW);
      }
    });
    const out = await rec.run({ x: new ort.Tensor('float32', x, [idx.length, 3, 48, maxW]) });
    const t = Object.values(out)[0] as ort.Tensor, [, T, C] = t.dims as number[], p = t.data as Float32Array;
    idx.forEach((i, b) => {
      const used = (widths[i] / maxW) * T; // timesteps that cover the real (unpadded) strip
      let prev = 0, text = '', confSum = 0;
      const cs: PpLine['chars'] = [];
      for (let tt = 0; tt < T; tt++) {
        let best = 0, bv = -1;
        const o = (b * T + tt) * C;
        for (let c = 0; c < C; c++) if (p[o + c] > bv) { bv = p[o + c]; best = c; }
        if (best !== 0 && best !== prev) {
          const ch = chars[best - 1] ?? '';
          text += ch; confSum += bv;
          cs.push({ c: ch, u0: Math.min(1, tt / used), u1: Math.min(1, (tt + 1) / used) });
        } else if (best !== 0 && best === prev && cs.length) cs[cs.length - 1].u1 = Math.min(1, (tt + 1) / used);
        prev = best;
      }
      res[i] = { text, conf: cs.length ? confSum / cs.length : 0, chars: cs };
    });
  }
  return res;
}

/** Detect lines and cut each into a normalised strip (height 48), ready for recognition on any worker. */
async function detectStrips(img: ImageData, limit: number) {
  const { quads } = await detect(img, limit);
  const qs = quads.map(readingOrder);
  const widths = qs.map((q) => Math.min(2400, Math.max(16, Math.round((48 * Math.max(dist(q[0], q[1]), 1)) / Math.max(dist(q[0], q[3]), 1)))));
  return { quads: qs, widths, strips: qs.map((q, i) => strip(img, q, widths[i])) };
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
      const r = await detectStrips(m.img, m.limit);
      post({ id: m.id, ok: true, quads: r.quads, strips: r.strips, widths: r.widths, ms: performance.now() - t0 }, r.strips.map((x) => x.buffer));
    } else {
      const strips = m.flip ? m.strips.map((x, i) => flipStrip(x, m.widths[i])) : m.strips;
      post({ id: m.id, ok: true, recs: await recognise(strips, m.widths), ms: performance.now() - t0 });
    }
  } catch (err) {
    if (m.kind === 'init') ready = null;
    post({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};

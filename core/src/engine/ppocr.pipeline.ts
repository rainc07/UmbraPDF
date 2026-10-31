// PaddleOCR PP-OCRv5 mobile (Apache-2.0) pipeline, shared by the browser worker (ONNX Runtime Web, ppocr.worker.ts)
// and the desktop server (ONNX Runtime for Node, web/server): text detection (DB) finds every text line at any
// angle; recognition (CTC) reads each line. The Android app runs the same steps in Kotlin (PpOcr.kt).

export interface PpLine {
  /** Corners in reading order of the text: start-top, end-top, end-bottom, start-bottom (input pixels). */
  quad: [number, number][];
  text: string;
  conf: number;
  /** Per character: start/end as a fraction of the line length. */
  chars: { c: string; u0: number; u1: number }[];
}
export type PpRec = Omit<PpLine, 'quad'>;

/** RGBA pixels (ImageData in the browser, a plain buffer on the server). */
export interface Img { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
/** The parts of an ONNX Runtime session the pipeline uses (same API in the web and Node runtimes). */
export interface OrtTensor { readonly dims: readonly number[]; readonly data: unknown }
export interface OrtSession { run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>> }

let tensor: (data: Float32Array, dims: number[]) => OrtTensor;
/** The runtime's float32 tensor constructor (set once, before the first read). */
export function useTensor(make: (data: Float32Array, dims: number[]) => OrtTensor): void { tensor = make; }

/** The recogniser's character list: the dictionary's lines, then a space. */
export const parseDict = (dict: string): string[] => [...dict.split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1), ' '];

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
async function detect(det: OrtSession, img: Img, limit: number): Promise<{ quads: P[][]; ms: number }> {
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
  const out = await det.run({ x: tensor(x, [1, 3, nh, nw]) });
  const ms = performance.now() - t0;
  const prob = Object.values(out)[0].data as Float32Array;
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
function strip(img: Img, q: P[], outW: number): Float32Array {
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
export function flipStrip(x: Float32Array, w: number): Float32Array {
  const o = new Float32Array(x.length), plane = 48 * w;
  for (let k = 0; k < 3; k++) for (let i = 0; i < plane; i++) o[k * plane + i] = x[k * plane + plane - 1 - i];
  return o;
}

/** Recognise strips in batches (similar widths together, zero-padded); greedy CTC decode with char positions. */
/** Space weight in a gap between two characters above which a space is written (the space is the last class). */
const SPACE_IN_GAP = 0.05;

export async function recognise(rec: OrtSession, chars: string[], strips: Float32Array[], widths: number[]): Promise<PpRec[]> {
  const res: PpRec[] = new Array(strips.length);
  const order = widths.map((_, i) => i).sort((a, b) => widths[a] - widths[b]);
  // Batches of similar widths (padding is wasted work), at most 8 strips each. One at a time with the Chinese
  // model: its output has 18,385 classes per step (about 20 MB per line), and batches of it ran 1.7x slower.
  const most = chars.length > 1000 ? 1 : 8;
  const batches: number[][] = [];
  for (const i of order) {
    const b = batches[batches.length - 1];
    if (b && b.length < most && widths[i] <= 1.3 * widths[b[0]]) b.push(i); else batches.push([i]);
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
    const out = await rec.run({ x: tensor(x, [idx.length, 3, 48, maxW]) });
    const t = Object.values(out)[0], [, T, C] = t.dims as number[], p = t.data as Float32Array;
    idx.forEach((i, b) => {
      const used = (widths[i] / maxW) * T; // timesteps that cover the real (unpadded) strip
      let prev = 0, text = '', confSum = 0, n = 0, gap = 0, gap0 = 0;
      const cs: PpLine['chars'] = [];
      for (let tt = 0; tt < T; tt++) {
        let best = 0, bv = -1;
        const o = (b * T + tt) * C;
        for (let c = 0; c < C; c++) if (p[o + c] > bv) { bv = p[o + c]; best = c; }
        if (best !== 0 && best !== prev) {
          const ch = chars[best - 1] ?? '';
          // The Chinese model often leaves out the space between English words ("TenancyAgreement"), but
          // still gives it some weight in the gap: a likely space there is written.
          if (gap >= SPACE_IN_GAP && ch !== ' ' && cs.length && cs[cs.length - 1].c !== ' ') {
            text += ' '; cs.push({ c: ' ', u0: Math.min(1, gap0 / used), u1: Math.min(1, tt / used) });
          }
          text += ch; confSum += bv; n++;
          cs.push({ c: ch, u0: Math.min(1, tt / used), u1: Math.min(1, (tt + 1) / used) });
          gap = 0;
        } else if (best !== 0 && best === prev && cs.length) cs[cs.length - 1].u1 = Math.min(1, (tt + 1) / used);
        else if (best === 0) { if (prev !== 0) gap0 = tt; gap = Math.max(gap, p[o + C - 1]); }
        prev = best;
      }
      res[i] = { text, conf: n ? confSum / n : 0, chars: cs };
    });
  }
  return res;
}

/**
 * Join boxes the detector split within one line of text ("Tan Chee" + "Kin"): level boxes that share most
 * of their height and are less than 1.5 line-heights apart become one box. Otherwise the line reads in
 * pieces (a name cut short, or a neighbour's letter read into the next box).
 */
function mergeLine(qs: P[][]): P[][] {
  type B = { x0: number; y0: number; x1: number; y1: number; q: P[]; level: boolean };
  const bs: B[] = qs.map((q) => {
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const a = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), q, level: Math.abs(a) < 0.1 && dist(q[0], q[1]) >= dist(q[0], q[3]) };
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < bs.length && !changed; i++) for (let j = 0; j < bs.length && !changed; j++) {
      const a = bs[i], b = bs[j];
      if (i === j || !a.level || !b.level || a.x0 > b.x0) continue;
      const ha = a.y1 - a.y0, hb = b.y1 - b.y0;
      const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ov < 0.6 * Math.min(ha, hb) || Math.max(ha, hb) > 1.6 * Math.min(ha, hb)) continue;
      if (b.x0 - a.x1 > 1.5 * Math.max(ha, hb)) continue;
      const m: B = { x0: a.x0, y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), q: [], level: true };
      m.q = [[m.x0, m.y0], [m.x1, m.y0], [m.x1, m.y1], [m.x0, m.y1]];
      bs.splice(Math.max(i, j), 1); bs.splice(Math.min(i, j), 1); bs.push(m);
      changed = true;
    }
  }
  return bs.map((b) => b.q);
}

/** Detect lines and cut each into a normalised strip (height 48), ready for recognition on any engine. */
export async function detectStrips(det: OrtSession, img: Img, limit: number) {
  const { quads } = await detect(det, img, limit);
  const qs = mergeLine(quads).map(readingOrder);
  const widths = qs.map((q) => Math.min(2400, Math.max(16, Math.round((48 * Math.max(dist(q[0], q[1]), 1)) / Math.max(dist(q[0], q[3]), 1)))));
  return { quads: qs, widths, strips: qs.map((q, i) => strip(img, q, widths[i])) };
}

/**
 * Read detected strips. Everything is read as upright first (the usual case). If most lines read poorly, the
 * region is upside down: it's read all again turned 180°. Otherwise just the few weak lines are retried turned
 * (mixed pages). Only lines long enough to be real text count: short low-confidence boxes are specks and edges.
 * `rec` reads strips (turned 180° when `flip`), on one engine or shared out over several.
 */
export async function readStrips(
  quads: P[][], strips: Float32Array[], widths: number[],
  rec: (strips: Float32Array[], widths: number[], flip: boolean) => Promise<PpRec[]>,
): Promise<{ lines: PpLine[]; flipped: boolean; retried: number; recMs: number; retryMs: number }> {
  const t1 = performance.now();
  let recs = await rec(strips, widths, false);
  const long = widths.map((w, i) => (w >= 96 ? i : -1)).filter((i) => i >= 0);
  let weak = long.filter((i) => recs[i].conf < 0.7);
  const t2 = performance.now();
  let flipped = false;
  if (long.length >= 3 && weak.length > long.length / 2) {
    const again = await rec(strips, widths, true);
    const mean = (r: PpRec[]) => long.reduce((a, i) => a + r[i].conf, 0) / long.length;
    if (mean(again) > mean(recs) + 0.1) { recs = again; flipped = true; quads.forEach((q, i) => { quads[i] = [2, 3, 0, 1].map((j) => q[j]); }); }
    weak = [];
  }
  weak = weak.slice(0, 6);
  if (weak.length) {
    const again = await rec(weak.map((i) => strips[i]), weak.map((i) => widths[i]), true);
    weak.forEach((i, k) => { if (again[k].conf > recs[i].conf + 0.1) { recs[i] = again[k]; quads[i] = [2, 3, 0, 1].map((j) => quads[i][j]); } });
  }
  const lines = quads.map((quad, i) => ({ quad, ...recs[i] })).filter((l) => l.text.trim() && l.conf >= 0.5);
  return { lines, flipped, retried: weak.length, recMs: t2 - t1, retryMs: performance.now() - t2 };
}

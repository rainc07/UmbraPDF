// Geometry for photographed / scanned ID cards: find card-shaped regions on a page image,
// and warp a quadrilateral to an upright rectangle (and map points back). No OCR here.

export type Pt = [number, number];
/** Corners in reading order of the *upright* card: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** Homography from the unit square to a quad: x = (a u + b v + c) / (g u + h v + 1), same for y with d e f. */
export type H = [number, number, number, number, number, number, number, number];

export function squareToQuad(q: Quad): H {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

export function applyH(m: H, u: number, v: number): Pt {
  const z = m[6] * u + m[7] * v + 1;
  return [(m[0] * u + m[1] * v + m[2]) / z, (m[3] * u + m[4] * v + m[5]) / z];
}

/** Inverse of a square→quad map, as a function from image point to (u, v) in the unit square. */
function inverseH(m: H): (x: number, y: number) => Pt {
  const [a, b, c, d, e, f, g, h] = m;
  const A = e - f * h, B = c * h - b, C = b * f - c * e, D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, HH = b * g - a * h, I = a * e - b * d;
  return (x, y) => { const z = G * x + HH * y + I; return [(A * x + B * y + C) / z, (D * x + E * y + F) / z]; };
}

/** Rotate a quad's corner order by k quarter turns (k=2: the card is upside down). */
export const turnQuad = (q: Quad, k: number): Quad => [0, 1, 2, 3].map((i) => q[(i + k) % 4]) as Quad;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Warp the quad region of `src` into an upright W×H canvas (bilinear). */
export function warpQuad(src: HTMLCanvasElement, q: Quad, W: number, H: number): HTMLCanvasElement {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 1), by = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const bw = Math.min(src.width, Math.ceil(Math.max(...xs)) + 2) - bx, bh = Math.min(src.height, Math.ceil(Math.max(...ys)) + 2) - by;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const og = out.getContext('2d', { willReadFrequently: true })!;
  if (bw < 2 || bh < 2) return out;
  const s = src.getContext('2d', { willReadFrequently: true })!.getImageData(bx, by, bw, bh).data;
  const m = squareToQuad(q);
  const img = og.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const [px, py] = applyH(m, (x + 0.5) / W, v);
      let fx = px - bx - 0.5, fy = py - by - 0.5;
      fx = Math.min(Math.max(fx, 0), bw - 1.001); fy = Math.min(Math.max(fy, 0), bh - 1.001);
      const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
      const i00 = (iy * bw + ix) * 4, i10 = i00 + 4, i01 = i00 + bw * 4, i11 = i01 + 4;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        d[o + k] = (1 - ay) * ((1 - ax) * s[i00 + k] + ax * s[i10 + k]) + ay * ((1 - ax) * s[i01 + k] + ax * s[i11 + k]);
      }
      d[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

/** Map a box given in warped-canvas pixels (W×H) back to the source image: the bounding box of its 4 corners. */
export function mapBoxBack(q: Quad, W: number, H: number) {
  const m = squareToQuad(q);
  return (x0: number, y0: number, x1: number, y1: number) => {
    const ps = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => applyH(m, x / W, y / H));
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
}

/** Is point p inside the (convex) quad? */
export function inQuad(q: Quad, x: number, y: number): boolean {
  const [u, v] = inverseH(squareToQuad(q))(x, y);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** Card aspect: ID-1 = 85.6 × 53.98 mm. */
export const CARD_ASPECT = 85.6 / 53.98;

/** Long side horizontal, clockwise. Returns the two upright candidates (0° and 180°). */
function landscape(q: Quad): Quad {
  // Make clockwise in image coordinates (y down): positive signed area.
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
  let c: Quad = area < 0 ? [q[0], q[3], q[2], q[1]] : q;
  // Edge 0→1 must be a long edge.
  if (dist(c[0], c[1]) + dist(c[2], c[3]) < dist(c[1], c[2]) + dist(c[3], c[0])) c = turnQuad(c, 1);
  // Of the two long edges, start with the one nearer the top (upright guess; OCR decides 0 vs 180).
  if (c[0][1] + c[1][1] > c[2][1] + c[3][1]) c = turnQuad(c, 2);
  return c;
}

function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const x of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], x) <= 0) lo.pop(); lo.push(x); }
  for (const x of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], x) <= 0) up.pop(); up.push(x); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

const polyArea = (q: Pt[]) => Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % q.length]; return a + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;

/** Largest quad on the hull: corners = extreme hull points along 4 diagonal directions, swept over angles. */
function bestQuad(h: Pt[]): Quad | null {
  if (h.length < 4) return null;
  let best: Quad | null = null, bestA = 0;
  for (let deg = 0; deg < 90; deg += 3) {
    const corners = [0, 1, 2, 3].map((k) => {
      const t = ((deg + 45 + 90 * k) * Math.PI) / 180, cx = Math.cos(t), cy = Math.sin(t);
      let bp = h[0], bv = -Infinity;
      for (const p of h) { const v = p[0] * cx + p[1] * cy; if (v > bv) { bv = v; bp = p; } }
      return bp;
    }) as Quad;
    if (new Set(corners).size < 4) continue;
    const a = polyArea(corners);
    if (a > bestA) { bestA = a; best = corners; }
  }
  return best;
}

/** Grow a quad around its centre (cards have rounded corners, so the hull quad sits slightly inside). */
function grow(q: Quad, f: number): Quad {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]) as Quad;
}

/**
 * Card-shaped regions on a page image (scans on paper, photos on a table), in canvas pixels, upright guess.
 * Works on a small copy: background = median colour of the border; foreground = pixels clearly different from it;
 * holes are filled; each large blob whose outline is a card-proportioned quadrilateral is a card.
 */
export function findCards(canvas: HTMLCanvasElement): Quad[] {
  const S = 520 / Math.max(canvas.width, canvas.height);
  const w = Math.max(16, Math.round(canvas.width * S)), h = Math.max(16, Math.round(canvas.height * S));
  const sm = document.createElement('canvas');
  sm.width = w; sm.height = h;
  const g = sm.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  sm.width = sm.height = 0;
  const px = (i: number): Pt3 => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
  type Pt3 = [number, number, number];
  const border: Pt3[] = [];
  // A ring a little inside the edge: scanner lids and blur leave dark rims right at the border.
  const ix = Math.max(2, Math.round(w * 0.025)), iy = Math.max(2, Math.round(h * 0.025));
  for (let x = ix; x < w - ix; x += 2) for (const y of [iy, h - 1 - iy]) border.push(px(y * w + x));
  for (let y = iy; y < h - iy; y += 2) for (const x of [ix, w - 1 - ix]) border.push(px(y * w + x));
  const med = (k: number) => { const v = border.map((b) => b[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg: Pt3 = [med(0), med(1), med(2)];
  const dev = border.map((b) => Math.hypot(b[0] - bg[0], b[1] - bg[1], b[2] - bg[2])).sort((a, b) => a - b);
  const T = Math.min(36, Math.max(16, 3 * dev[dev.length >> 1]));
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const [r, gg, b] = px(i); if (Math.hypot(r - bg[0], gg - bg[1], b - bg[2]) > T) fg[i] = 1; }
  const quadsFrom = (fg: Uint8Array): Quad[] => {
    // Fill holes: background = what's reachable from the border through non-foreground.
    const reach = new Uint8Array(w * h), stack: number[] = [];
    const seed = (i: number) => { if (!fg[i] && !reach[i]) { reach[i] = 1; stack.push(i); } };
    // Seed from the whole border band, not just the edge, so a dark rim doesn't wall in the page.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x <= ix || x >= w - 1 - ix || y <= iy || y >= h - 1 - iy) seed(y * w + x);
    while (stack.length) {
      const i = stack.pop()!, x = i % w;
      if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (i >= w) seed(i - w); if (i < w * (h - 1)) seed(i + w);
    }
    // Erode once (detach thin bridges such as a shadow line), then label blobs.
    const solid = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      solid[i] = !reach[i] && !reach[i - 1] && !reach[i + 1] && !reach[i - w] && !reach[i + w] ? 1 : 0;
    }
    const label = new Int32Array(w * h);
    const out: Quad[] = [];
    let n = 0;
    for (let s = 0; s < w * h; s++) {
      if (!solid[s] || label[s]) continue;
      n++;
      const pts: Pt[] = [];
      let area = 0;
      stack.push(s); label[s] = n;
      while (stack.length) {
        const i = stack.pop()!, x = i % w, y = (i / w) | 0;
        area++;
        let edge = false;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j < 0 || j >= w * h) { edge = true; continue; }
          if (!solid[j]) edge = true;
          else if (!label[j]) { label[j] = n; stack.push(j); }
        }
        if (edge) pts.push([x + 0.5, y + 0.5]);
      }
      if (area < 0.012 * w * h) continue;
      const q = bestQuad(hull(pts));
      if (!q) continue;
      const qa = polyArea(q);
      if (area / qa < 0.86 || qa > 0.985 * w * h) continue;   // not a filled quadrilateral, or the whole frame
      const L = landscape(q);
      const long = (dist(L[0], L[1]) + dist(L[2], L[3])) / 2, short = (dist(L[1], L[2]) + dist(L[3], L[0])) / 2;
      const ar = long / short;
      if (ar < 1.3 || ar > 1.95 || short < 18) continue;
      out.push(grow(L.map(([x, y]) => [x / S, y / S]) as Quad, 1.015));
    }
  return out;
  };
  const found = quadsFrom(fg);
  {
    // Scanner-app filters (CamScanner "B&W"/"Magic Color") can whiten the card so it matches the paper.
    // The card is still *busy* (security print, photo, text): use local ink density instead of colour.
    const ink = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { const [r, gg, b] = px(i); ink[i] = (bg[0] + bg[1] + bg[2] - r - gg - b) / 3 > 28 ? 1 : 0; }
    const R = Math.max(3, Math.round(Math.max(w, h) / 90));
    const dens = boxMean(ink, w, h, R);
    const busy = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) busy[i] = dens[i] > 0.12 ? 1 : 0;
    // Close small gaps between busy areas (dilate, then erode) before reading blobs.
    const grown = boxMean(busy, w, h, R);
    for (let i = 0; i < w * h; i++) busy[i] = grown[i] > 0 ? 1 : 0;
    const shrunk = boxMean(busy, w, h, R);
    for (let i = 0; i < w * h; i++) busy[i] = shrunk[i] > 0.999 ? 1 : 0;
    // Add cards the colour test missed (one side whitened by the filter, the other not).
    for (const q of quadsFrom(busy)) {
      const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
      if (!found.some((f) => inQuad(f, cx, cy))) found.push(q);
    }
  }
  return found;
}

/** Mean over a (2r+1)² box, clipped at the edges (summed-area table). */
function boxMean(a: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const S = new Float64Array((w + 1) * (h + 1)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += a[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** The whole image as a card, when it is card-proportioned (a tightly cropped card photo or a pasted card picture). */
export function wholeAsCard(canvas: HTMLCanvasElement): Quad | null {
  const W = canvas.width, H = canvas.height, ar = Math.max(W, H) / Math.min(W, H);
  if (ar < 1.47 || ar > 1.75) return null; // not A4/Letter (1.41/1.29) pages
  const q: Quad = [[0, 0], [W, 0], [W, H], [0, H]];
  return W >= H ? q : turnQuad(q, 3); // portrait: card turned 90° (OCR tries 180° too)
}

const MAX_CARD_ROWS = 24;
/** Rows of print in a box of the ink map (columns if `cols`): runs of inked lines between blank ones. */
function printRows(ink: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number, cols: boolean): number {
  const [a0, a1, b0, b1] = cols ? [x0, x1, y0, y1] : [y0, y1, x0, x1];
  const len = Math.max(1, b1 - b0 + 1);
  let rows = 0, inRow = false;
  for (let a = a0; a <= a1; a++) {
    let n = 0;
    for (let b = b0; b <= b1; b++) n += cols ? ink[b * w + a] : ink[a * w + b];
    const f = n / len;
    if (!inRow && f > 0.02) { inRow = true; rows++; } else if (inRow && f <= 0.005) inRow = false;
  }
  return rows;
}

/**
 * Groups of printed content separated by blank paper, as upright rectangles grown by a small margin.
 * For scanner-app pages ("ID card" mode) whose filter whitened the card so its edge is gone: each side of the
 * card is still a tight island of print. Callers must confirm a group is a card (e.g. card words inside).
 */
export function contentGroups(canvas: HTMLCanvasElement): Quad[] {
  const S = 520 / Math.max(canvas.width, canvas.height);
  const w = Math.max(16, Math.round(canvas.width * S)), h = Math.max(16, Math.round(canvas.height * S));
  const sm = document.createElement('canvas');
  sm.width = w; sm.height = h;
  const g = sm.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  sm.width = sm.height = 0;
  // Paper = the brightest common colour; ink = anything clearly darker or clearly coloured.
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
    ink[i] = Math.min(r, gg, b) < 200 || Math.max(r, gg, b) - Math.min(r, gg, b) > 40 ? 1 : 0;
  }
  const R = Math.max(4, Math.round(Math.max(w, h) / 40));
  const near = boxMean(ink, w, h, R);
  const grp = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) grp[i] = near[i] > 0 ? 1 : 0;
  const label = new Int32Array(w * h), out: Quad[] = [], stack: number[] = [];
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (!grp[s] || label[s]) continue;
    n++;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    stack.push(s); label[s] = n;
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < w * h && grp[j] && !label[j]) { label[j] = n; stack.push(j); }
    }
    // The closing grew the group by R on each side; take it back, then add a card margin.
    x0 += R; y0 += R; x1 -= R; y1 -= R;
    const bw = x1 - x0, bh = y1 - y0;
    if (bw < 20 || bh < 12) continue;
    const ar = Math.max(bw, bh) / Math.min(bw, bh);
    if (ar < 1.25 || ar > 2.2 || bw * bh > 0.6 * w * h || bw * bh < 0.01 * w * h) continue;
    // A block of many lines of print (a page of text) is not a card: a card holds a dozen lines or so.
    if (Math.max(printRows(ink, w, x0, y0, x1, y1, false), printRows(ink, w, x0, y0, x1, y1, true)) > MAX_CARD_ROWS) continue;
    const mx = 0.05 * bw, my = 0.07 * bh;
    const q: Quad = [[x0 - mx, y0 - my], [x1 + mx, y0 - my], [x1 + mx, y1 + my], [x0 - mx, y1 + my]];
    out.push((bw >= bh ? q : turnQuad(q, 3)).map(([x, y]) => [Math.max(0, Math.min(canvas.width, x / S)), Math.max(0, Math.min(canvas.height, y / S))]) as Quad);
  }
  return out;
}

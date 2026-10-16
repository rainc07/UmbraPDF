// Hard, realistic FAKE Malaysian ID-card scenes (MyKad / MyPR / MyKid, front and back) for OCR recall tests.
// Every name, number and address here is invented. Never put real IC data in this file.
//
// Cards are drawn at 300 DPI (1012x638 px) with a MyKad-like layout: header, IC number, chip, name, address,
// photo and ghost photo, guilloche. Scenes then place them like real documents: photocopies on A4 at
// several resolutions, rotated pages, phone photos with perspective, glare, blur and JPEG.

export const PEOPLE = {
  a: { nric: '851231-08-5014', name: ['LEE CHONG HUAT'], address: ['NO 8 JALAN SS 2/55', 'TAMAN BAHAGIA', '47300 PETALING JAYA', 'SELANGOR'], sex: 'LELAKI' },
  b: { nric: '010315-10-0887', name: ['NUR AISYAH BINTI', 'ABDULLAH'], address: ['LOT 1203 KAMPUNG BARU', 'JALAN SUNGAI MERAB', '43000 KAJANG', 'SELANGOR'], sex: 'PEREMPUAN', religion: 'ISLAM' },
  c: { nric: '780912-14-5539', name: ['MUTHU A/L RAMASAMY'], address: ['22 LORONG PERDA 5', 'TAMAN PERDA', '14000 BUKIT MERTAJAM', 'PULAU PINANG'], sex: 'LELAKI' },
  d: { nric: '150606-01-3346', name: ['TAN XIN YI'], address: ['15 JALAN PUTERI 7/3', 'BANDAR PUTERI', '47100 PUCHONG', 'SELANGOR'], sex: 'PEREMPUAN' },
};

/**
 * Scene recipes. card: {who, kind: mykad|mypr|mykid, side: front|back}; place: where each card goes.
 * page: 'a4' (dpi) or 'photo' (w,h). Back sides only carry the IC number.
 */
export const VARIANTS = [
  { id: 'a4-300-front', note: 'A4 300 DPI photocopy, front, 1.5° skew', page: { a4: 300 }, cards: [{ who: 'a', kind: 'mykad', side: 'front', at: [0.12, 0.08], scale: 1, rot: 1.5 }] },
  { id: 'a4-150-both', note: 'A4 150 DPI, front + back, JPEG 50', page: { a4: 150 }, quality: 0.5, cards: [{ who: 'a', kind: 'mykad', side: 'front', at: [0.25, 0.1], scale: 1, rot: -0.8 }, { who: 'a', kind: 'mykad', side: 'back', at: [0.25, 0.45], scale: 1, rot: 0.6 }] },
  { id: 'a4-100-small', note: 'A4 100 DPI, small card (70%)', page: { a4: 100 }, quality: 0.6, cards: [{ who: 'b', kind: 'mykad', side: 'front', at: [0.1, 0.1], scale: 0.7, rot: 0 }] },
  { id: 'a4-rot90', note: 'A4 200 DPI, card sideways (90°)', page: { a4: 200 }, cards: [{ who: 'c', kind: 'mykad', side: 'front', at: [0.3, 0.2], scale: 1, rot: 90 }] },
  { id: 'a4-rot180', note: 'A4 200 DPI, page upside down, front + back', page: { a4: 200 }, rotatePage: 180, cards: [{ who: 'b', kind: 'mykad', side: 'front', at: [0.2, 0.1], scale: 1, rot: 0.5 }, { who: 'b', kind: 'mykad', side: 'back', at: [0.2, 0.42], scale: 1, rot: -0.5 }] },
  { id: 'a4-270-glare', note: 'A4 200 DPI, card at 270°, glare + blur', page: { a4: 200 }, blur: 1.2, cards: [{ who: 'a', kind: 'mykad', side: 'front', at: [0.35, 0.3], scale: 1, rot: 270, glare: [0.45, 0.62, 0.22] }] },
  { id: 'photo-persp', note: 'Phone photo 1600x1200, perspective, glare, table', page: { photo: [1600, 1200] }, blur: 0.9, quality: 0.7, cards: [{ who: 'c', kind: 'mykad', side: 'front', quad: [[0.14, 0.17], [0.88, 0.1], [0.92, 0.86], [0.1, 0.8]], glare: [0.3, 0.35, 0.3] }] },
  { id: 'photo-lowres', note: 'Phone photo 960x720, perspective, blur', page: { photo: [960, 720] }, blur: 1.0, quality: 0.6, cards: [{ who: 'a', kind: 'mykad', side: 'front', quad: [[0.08, 0.14], [0.9, 0.1], [0.93, 0.9], [0.06, 0.86]] }] },
  { id: 'photo-portrait', note: 'Portrait photo 1200x1600, card ~90° + perspective', page: { photo: [1200, 1600] }, quality: 0.7, cards: [{ who: 'd', kind: 'mykad', side: 'front', quad: [[0.85, 0.1], [0.88, 0.9], [0.13, 0.86], [0.12, 0.13]] }] },
  // CamScanner-style "ID card" page: front + back, true size, upright, small on A4, enhanced filter, footer.
  { id: 'cs-magic', note: 'CamScanner-like: front+back on A4, "Magic Color" filter', page: { a4: 200 }, filter: 'magic', footer: true, quality: 0.7, cards: [{ who: 'c', kind: 'mykad', side: 'front', at: [0.28, 0.12], scale: 1, rot: 0.3 }, { who: 'c', kind: 'mykad', side: 'back', at: [0.28, 0.5], scale: 1, rot: -0.2 }] },
  { id: 'cs-bw', note: 'CamScanner-like: front+back on A4, B&W filter', page: { a4: 200 }, filter: 'bw', footer: true, quality: 0.7, cards: [{ who: 'b', kind: 'mykad', side: 'front', at: [0.28, 0.12], scale: 1, rot: 0 }, { who: 'b', kind: 'mykad', side: 'back', at: [0.28, 0.5], scale: 1, rot: 0.4 }] },
  { id: 'cs-magic-150', note: 'CamScanner-like, 150 DPI, glare on front', page: { a4: 150 }, filter: 'magic', footer: true, quality: 0.6, cards: [{ who: 'a', kind: 'mykad', side: 'front', at: [0.28, 0.12], scale: 1, rot: 0, glare: [0.35, 0.4, 0.25] }, { who: 'a', kind: 'mykad', side: 'back', at: [0.28, 0.5], scale: 1, rot: 0 }] },
  { id: 'glare-on-ic', note: 'A4 200 DPI, front + back, strong glare wiping the front IC number', page: { a4: 200 }, cards: [{ who: 'd', kind: 'mykad', side: 'front', at: [0.28, 0.12], scale: 1, rot: 0, glare: [0.22, 0.25, 0.22, 1.6] }, { who: 'd', kind: 'mykad', side: 'back', at: [0.28, 0.5], scale: 1, rot: 0 }] },
  { id: 'mypr', note: 'MyPR front, A4 200 DPI', page: { a4: 200 }, cards: [{ who: 'c', kind: 'mypr', side: 'front', at: [0.15, 0.12], scale: 1, rot: -1 }] },
  { id: 'mykid', note: 'MyKid front + back, A4 200 DPI', page: { a4: 200 }, cards: [{ who: 'd', kind: 'mykid', side: 'front', at: [0.2, 0.08], scale: 1, rot: 0.7 }, { who: 'd', kind: 'mykid', side: 'back', at: [0.2, 0.42], scale: 1, rot: 0 }] },
];

/** Expected items per variant: every IC number shown (front and back), and the name + address on fronts. */
export function expected(v) {
  const out = [];
  for (const c of v.cards) {
    const p = PEOPLE[c.who];
    out.push({ kind: 'nric', side: c.side, value: p.nric });
    if (c.side === 'front') { out.push({ kind: 'name', value: p.name.join(' ') }); out.push({ kind: 'address', value: p.address }); }
  }
  return out;
}

/** Render one scene in the browser page. Returns { jpeg: number[], w, h } (image pixels). */
export async function drawScene(page, v) {
  return page.evaluate(async ({ v, PEOPLE }) => {
    let seed = 1;
    for (const ch of v.id) seed = (seed * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

    // ---------- the card (300 DPI) ----------
    function drawCard(p, kind, side) {
      const W = 1012, H = 638, c = mk(W, H), g = c.getContext('2d');
      const pal = { mykad: ['#cfe3f5', '#e9eef7', '#f3d7e3', '#1d3f8a'], mypr: ['#f6c9cf', '#f9e4e1', '#efc0c8', '#8a1d2b'], mykid: ['#fdf1c4', '#e8f3fb', '#d7ecd2', '#1d5a8a'] }[kind];
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, pal[0]); bg.addColorStop(0.55, pal[1]); bg.addColorStop(1, pal[2]);
      g.save(); g.beginPath(); g.roundRect(0, 0, W, H, 38); g.clip();
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      g.lineWidth = 1.3;
      for (let k = 0; k < 48; k++) {
        g.strokeStyle = k % 3 === 0 ? 'rgba(120,160,210,0.5)' : k % 3 === 1 ? 'rgba(210,140,175,0.42)' : 'rgba(150,190,140,0.35)';
        g.beginPath();
        for (let x = 0; x <= W; x += 4) {
          const y = k * 14 + 18 * Math.sin(x / 37 + k * 0.7) + 7 * Math.sin(x / 11 + k);
          x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
      // Rosette (hibiscus-like) watermark in the middle.
      g.strokeStyle = 'rgba(200,90,120,0.28)'; g.lineWidth = 2;
      for (let a = 0; a < 5; a++) { g.beginPath(); g.ellipse(520, 330, 95, 38, a * Math.PI / 5, 0, Math.PI * 2); g.stroke(); }
      const ink = '#1c2633';
      const text = (t, x, y, font, color = ink) => { g.font = font; g.fillStyle = color; g.fillText(t, x, y); };
      if (side === 'front') {
        text('KAD PENGENALAN', 52, 64, 'bold 38px sans-serif', pal[3]);
        if (kind === 'mypr') text('PENDUDUK TETAP', 52, 104, 'bold 30px sans-serif', pal[3]);
        else text('MALAYSIA', 52, 104, 'bold 32px sans-serif', pal[3]);
        text('IDENTITY CARD', 470, 62, 'italic 26px sans-serif', pal[3]);
        text(kind === 'mykad' ? 'MyKad' : kind === 'mypr' ? 'MyPR' : 'MyKid', 820, 66, 'bold italic 44px sans-serif', pal[3]);
        // Flag stripes
        for (let s = 0; s < 7; s++) { g.fillStyle = s % 2 ? '#fff' : '#c8202f'; g.fillRect(650, 90 + s * 6, 70, 6); }
        g.fillStyle = '#1c3c8a'; g.fillRect(650, 90, 34, 24);
        text(p.nric, 52, 178, 'bold 46px sans-serif');
        // Chip between the number and the name (as on a real MyKad).
        const cg = g.createLinearGradient(60, 210, 170, 300); cg.addColorStop(0, '#e2c26a'); cg.addColorStop(1, '#a8862f');
        g.fillStyle = cg; g.beginPath(); g.roundRect(64, 208, 112, 88, 10); g.fill();
        g.strokeStyle = '#7a5f1f'; g.lineWidth = 2;
        for (const yy of [230, 252, 274]) { g.beginPath(); g.moveTo(64, yy); g.lineTo(176, yy); g.stroke(); }
        g.beginPath(); g.moveTo(120, 208); g.lineTo(120, 296); g.stroke();
        if (kind !== 'mykid') {
          // Photo (a faceless silhouette) and a faded ghost copy.
          const ph = (x, y, w, h, a) => {
            g.globalAlpha = a; g.fillStyle = '#8d9aa8'; g.fillRect(x, y, w, h);
            g.fillStyle = '#5b6672'; g.beginPath(); g.ellipse(x + w / 2, y + h * 0.38, w * 0.24, h * 0.2, 0, 0, Math.PI * 2); g.fill();
            g.beginPath(); g.ellipse(x + w / 2, y + h * 0.95, w * 0.45, h * 0.32, 0, Math.PI, 0); g.fill(); g.globalAlpha = 1;
          };
          ph(742, 150, 222, 280, 1); ph(600, 250, 95, 120, 0.25);
        }
        let y = 372;
        for (const n of p.name) { text(n, 52, y, 'bold 31px sans-serif'); y += 40; }
        y += 4;
        for (const a of p.address) { text(a, 52, y, '28px sans-serif'); y += 36; }
        text(kind === 'mypr' ? 'PENDUDUK TETAP' : 'WARGANEGARA', 560, 606, 'bold 24px sans-serif');
        if (p.religion) text(p.religion, 760, 576, 'bold 24px sans-serif');
        text(p.sex, 820, 606, 'bold 24px sans-serif');
      } else {
        text('KETUA PENGARAH', 60, 70, 'bold 22px sans-serif', pal[3]);
        text('PENDAFTARAN NEGARA', 60, 96, 'bold 22px sans-serif', pal[3]);
        g.strokeStyle = '#223'; g.lineWidth = 3; g.beginPath(); g.moveTo(80, 140);
        for (let x = 80; x < 330; x += 12) g.lineTo(x, 140 + 18 * Math.sin(x / 9) * Math.cos(x / 31));
        g.stroke();
        text(`${p.nric}-02-01`, 52, 250, 'bold 34px sans-serif');
        text('Kad ini adalah hak milik Kerajaan Malaysia.', 52, 560, '20px sans-serif');
        text('Jika dijumpai, sila serahkan kepada pihak berkuasa.', 52, 588, '20px sans-serif');
        // Barcode-ish block and a second chip.
        for (let x = 600; x < 960; x += 3 + Math.floor(rnd() * 4)) { g.fillStyle = '#111'; g.fillRect(x, 330, 1 + Math.floor(rnd() * 3), 140); }
        g.fillStyle = '#c9a54a'; g.fillRect(740, 120, 120, 90);
      }
      g.restore();
      return c;
    }

    // ---------- the scene ----------
    let W, H;
    const a4 = v.page.a4;
    if (a4) { W = Math.round(8.27 * a4); H = Math.round(11.69 * a4); } else [W, H] = v.page.photo;
    const out = mk(W, H), g = out.getContext('2d', { willReadFrequently: true });
    if (a4) {
      g.fillStyle = '#f5f5f2'; g.fillRect(0, 0, W, H);
      const sh = g.createLinearGradient(0, 0, W, 0); sh.addColorStop(0, 'rgba(0,0,0,0.06)'); sh.addColorStop(0.1, 'rgba(0,0,0,0)');
      g.fillStyle = sh; g.fillRect(0, 0, W, H);
    } else {
      // Wooden table: warm gradient with grain lines.
      const tg = g.createLinearGradient(0, 0, W, H); tg.addColorStop(0, '#6b4a2f'); tg.addColorStop(1, '#8a6544');
      g.fillStyle = tg; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(40,25,10,0.25)';
      for (let k = 0; k < 60; k++) { g.lineWidth = 1 + rnd() * 3; g.beginPath(); const y0 = rnd() * H; g.moveTo(0, y0); g.bezierCurveTo(W / 3, y0 + rnd() * 40 - 20, 2 * W / 3, y0 + rnd() * 40 - 20, W, y0 + rnd() * 30 - 15); g.stroke(); }
    }
    const img = g.getImageData(0, 0, W, H), d = img.data;

    // Homography from the unit card (u,v in 0..1) to a quad, inverted per pixel; bilinear sampling.
    function warp(card, quad, glare) {
      const cw = card.width, ch = card.height;
      const src = card.getContext('2d').getImageData(0, 0, cw, ch).data;
      const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
      // Square -> quad (Heckbert): maps (0,0),(1,0),(1,1),(0,1) to the quad corners.
      const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
      const den = dx1 * dy2 - dx2 * dy1;
      const g7 = (sx * dy2 - dx2 * sy) / den, h8 = (dx1 * sy - sx * dy1) / den;
      const a = x1 - x0 + g7 * x1, b = x3 - x0 + h8 * x3, c = x0, dd = y1 - y0 + g7 * y1, e = y3 - y0 + h8 * y3, f = y0;
      // Inverse (adjugate) of [[a,b,c],[dd,e,f],[g7,h8,1]].
      const A = e - f * h8, B = c * h8 - b, C = b * f - c * e, D = f * g7 - dd, E = a - c * g7, F = c * dd - a * f, G = dd * h8 - e * g7, Hh = b * g7 - a * h8, I = a * e - b * dd;
      const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
      const bx0 = Math.max(0, Math.floor(Math.min(...xs))), bx1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
      const by0 = Math.max(0, Math.floor(Math.min(...ys))), by1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
      for (let py = by0; py <= by1; py++) for (let px = bx0; px <= bx1; px++) {
        const X = px + 0.5, Y = py + 0.5, z = G * X + Hh * Y + I;
        const u = (A * X + B * Y + C) / z, w = (D * X + E * Y + F) / z;
        if (u < 0 || u > 1 || w < 0 || w > 1) continue;
        const fx = u * (cw - 1), fy = w * (ch - 1), ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
        const i00 = (iy * cw + ix) * 4, i10 = i00 + (ix < cw - 1 ? 4 : 0), i01 = i00 + (iy < ch - 1 ? cw * 4 : 0), i11 = i01 + (ix < cw - 1 ? 4 : 0);
        const alpha = ((1 - ax) * (1 - ay) * src[i00 + 3] + ax * (1 - ay) * src[i10 + 3] + (1 - ax) * ay * src[i01 + 3] + ax * ay * src[i11 + 3]) / 255;
        if (alpha <= 0) continue;
        const o = (py * W + px) * 4;
        let gl = 0;
        if (glare) { const r = Math.hypot(u - glare[0], (w - glare[1]) * 0.63) / glare[2]; gl = Math.min(1, Math.max(0, 1 - r * r) * (glare[3] ?? 0.85)); }
        for (let k = 0; k < 3; k++) {
          let s = (1 - ax) * (1 - ay) * src[i00 + k] + ax * (1 - ay) * src[i10 + k] + (1 - ax) * ay * src[i01 + k] + ax * ay * src[i11 + k];
          s = s + (255 - s) * gl;
          d[o + k] = d[o + k] * (1 - alpha) + s * alpha;
        }
      }
    }

    for (const c of v.cards) {
      const card = drawCard(PEOPLE[c.who], c.kind, c.side);
      let quad;
      if (c.quad) quad = c.quad.map(([x, y]) => [x * W, y * H]);
      else {
        const k = (a4 / 300) * c.scale, cw = 1012 * k, ch = 638 * k;
        const t = (c.rot * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t);
        const rotSz = Math.abs(c.rot % 180) > 45; // sideways: the anchor is the rotated box's top-left
        const bw = rotSz ? ch : cw, bh = rotSz ? cw : ch;
        const cx = c.at[0] * W + bw / 2, cy = c.at[1] * H + bh / 2;
        quad = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]].map(([x, y]) => [cx + x * cs - y * sn, cy + x * sn + y * cs]);
      }
      warp(card, quad, c.glare);
    }
    g.putImageData(img, 0, 0);

    // Camera/scanner: blur, noise, optional whole-page rotation, JPEG.
    let fin = mk(W, H);
    const fg = fin.getContext('2d', { willReadFrequently: true });
    fg.filter = `blur(${v.blur ?? 0.6}px)`; fg.drawImage(out, 0, 0); fg.filter = 'none';
    const id = fg.getImageData(0, 0, W, H), q = id.data, amp = v.noise ?? 22;
    for (let i = 0; i < q.length; i += 4) { const n = (rnd() - 0.5) * amp; q[i] += n; q[i + 1] += n; q[i + 2] += n; }
    fg.putImageData(id, 0, 0);
    if (v.filter) {
      // Scanner-app enhancement: "magic" = levels + saturation (card tint mostly washed to white);
      // "bw" = grey + local threshold (guilloche turns into speckle, edges thin).
      const id2 = fg.getImageData(0, 0, W, H), e = id2.data;
      if (v.filter === 'magic') {
        for (let i = 0; i < e.length; i += 4) {
          const l = (e[i] + e[i + 1] + e[i + 2]) / 3;
          for (let k = 0; k < 3; k++) {
            const c = l + (e[i + k] - l) * 1.4;
            e[i + k] = Math.max(0, Math.min(255, ((c - 45) * 255) / (205 - 45)));
          }
        }
      } else {
        const gr = new Float32Array(W * H);
        for (let i = 0, k = 0; k < gr.length; i += 4, k++) gr[k] = 0.3 * e[i] + 0.59 * e[i + 1] + 0.11 * e[i + 2];
        const r = Math.round(a4 / 12), S = new Float64Array((W + 1) * (H + 1));
        for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gr[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
          const m = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
          const o = (y * W + x) * 4, val = gr[y * W + x] < m - 14 ? 20 : 250;
          e[o] = e[o + 1] = e[o + 2] = val;
        }
      }
      fg.putImageData(id2, 0, 0);
    }
    if (v.footer) {
      fg.font = `${Math.round(a4 / 9)}px sans-serif`; fg.fillStyle = '#9a9a9a';
      fg.fillText('Scanned with CamScanner', W * 0.62, H * 0.975);
    }
    if (v.rotatePage) {
      const r = mk(W, H), rg = r.getContext('2d');
      rg.translate(W / 2, H / 2); rg.rotate((v.rotatePage * Math.PI) / 180); rg.drawImage(fin, -W / 2, -H / 2);
      fin = r;
    }
    const jpeg = await new Promise((r) => fin.toBlob(async (b) => r(Array.from(new Uint8Array(await b.arrayBuffer()))), 'image/jpeg', v.quality ?? 0.75));
    return { jpeg, w: W, h: H };
  }, { v, PEOPLE });
}

/** Image-only PDF with the scene filling one page (A4 for scans, photo aspect for photos). */
export async function makeScenePdf(PDFDocument, img, v) {
  const d = await PDFDocument.create();
  const [pw, ph] = v.page.a4 ? [595, 842] : [img.w * 0.48, img.h * 0.48];
  const p = d.addPage([pw, ph]);
  p.drawImage(await d.embedJpg(Uint8Array.from(img.jpeg)), { x: 0, y: 0, width: pw, height: ph });
  return d.save();
}

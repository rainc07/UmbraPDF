// Synthetic (FAKE) Malaysian ID card image for OCR/detection tests. No real person's data.
// Drawn in the browser page: patterned colour background, guilloche lines, photo block, noise, blur, JPEG.
export const CARD = {
  nric: '900101-14-5678',
  name: ['TAN WEI MING'],
  address: ['12 JALAN CONTOH 3', 'TAMAN CONTOH JAYA', '52100 KEPONG', 'KUALA LUMPUR'],
};

/** Returns { jpeg: number[], w, h, lines: {text, x, y, w, h}[] } in image pixels (300 DPI card). */
export async function drawCard(page, card = CARD, opts = {}) {
  return page.evaluate(async ({ card, opts }) => {
    const W = 1012, H = 638;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#cfe3f5'); bg.addColorStop(0.55, '#e9eef7'); bg.addColorStop(1, '#f3d7e3');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // Guilloche: interleaved sine curves across the whole card (the hard part for OCR).
    g.lineWidth = 1.4;
    for (let k = 0; k < 46; k++) {
      g.strokeStyle = k % 2 ? 'rgba(120,160,210,0.55)' : 'rgba(210,140,175,0.45)';
      g.beginPath();
      for (let x = 0; x <= W; x += 4) {
        const y = k * 14 + 18 * Math.sin(x / 37 + k * 0.7) + 7 * Math.sin(x / 11 + k);
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    // Photo block + chip
    g.fillStyle = '#9aa7b4'; g.fillRect(730, 150, 230, 290);
    g.fillStyle = '#c9a54a'; g.fillRect(70, 180, 110, 85);
    const lines = [];
    const text = (t, x, y, font, color = '#1c2633') => {
      g.font = font.replace('sans-serif', opts.family ?? 'sans-serif'); g.fillStyle = color; g.fillText(t, x, y);
      const m = g.measureText(t);
      lines.push({ text: t, x, y: y - m.actualBoundingBoxAscent, w: m.width, h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent });
    };
    text('KAD PENGENALAN', 70, 70, 'bold 40px sans-serif', '#1d3f8a');
    text('MALAYSIA', 70, 115, 'bold 34px sans-serif', '#1d3f8a');
    text('IDENTITY CARD', 470, 70, 'italic 28px sans-serif', '#1d3f8a');
    text(card.nric, 70, 330, 'bold 50px sans-serif');
    let y = 395;
    for (const n of card.name) { text(n, 70, y, 'bold 34px sans-serif'); y += 46; }
    y += 6;
    for (const a of card.address) { text(a, 70, y, '30px sans-serif'); y += 40; }
    text('WARGANEGARA', 560, 600, 'bold 26px sans-serif');
    text('LELAKI', 860, 600, 'bold 26px sans-serif');
    // Scanner look: blur, noise, JPEG
    const o = document.createElement('canvas'); o.width = W; o.height = H;
    const og = o.getContext('2d');
    og.filter = `blur(${opts.blur ?? 0.7}px)`; og.drawImage(c, 0, 0); og.filter = 'none';
    const id = og.getImageData(0, 0, W, H); const d = id.data;
    let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const amp = opts.noise ?? 26;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * amp; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    og.putImageData(id, 0, 0);
    const jpeg = await new Promise((r) => o.toBlob(async (b) => r(Array.from(new Uint8Array(await b.arrayBuffer()))), 'image/jpeg', opts.quality ?? 0.6));
    return { jpeg, w: W, h: H, lines };
  }, { card, opts });
}

/**
 * Two PDFs with the card: `scan` = image-only A4 page (card at top-left, like a photocopy),
 * `mixed` = typed text + the card image (Word-style "copy of IC" page, which has a text layer).
 * Returns expected rects (PDF points, top-left origin) for the NRIC, name and address lines.
 */
export async function makeCardPdfs(PDFDocument, StandardFonts, img) {
  const out = {};
  for (const kind of ['scan', 'mixed']) {
    const d = await PDFDocument.create();
    const p = d.addPage([595, 842]);
    const im = await d.embedJpg(Uint8Array.from(img.jpeg));
    const cw = 243, ch = cw * img.h / img.w; // 85.6 mm card at true size
    const x0 = 72, top = kind === 'scan' ? 60 : 160;
    if (kind === 'mixed') {
      const font = await d.embedFont(StandardFonts.Helvetica);
      p.drawText('Salinan Kad Pengenalan / Copy of identity card', { x: 72, y: 842 - 90, size: 14, font });
      p.drawText('Attached as requested for account opening.', { x: 72, y: 842 - 112, size: 11, font });
    }
    p.drawImage(im, { x: x0, y: 842 - top - ch, width: cw, height: ch });
    const k = cw / img.w;
    out[kind] = { bytes: await d.save(), rect: (l) => ({ x: x0 + l.x * k, y: top + l.y * k, w: l.w * k, h: l.h * k }) };
  }
  return out;
}

// End-to-end test: builds a PDF full of leak vectors, redacts it in real Chromium, verifies output.
// Usage: npm run build && npm test   (CHROMIUM_PATH overrides the browser binary)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { drawCard, makeCardPdfs, CARD } from './fixtures-card.mjs';
import { PDFDocument, StandardFonts, PDFName, PDFString, PDFOperator, PDFRawStream, PDFStream, PDFDict, decodePDFRawStream, degrees, rgb, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextRenderingMode, moveText, showText, TextRenderingMode } from 'pdf-lib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.gz': 'application/gzip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };

async function makeFixture() {
  const d = await PDFDocument.create();
  d.setTitle('Confidential HR file'); d.setAuthor('Jane Leak'); d.setKeywords(['secret']);
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(`SECRET ACCOUNT 99${i}`, { x: 72, y: 700, size: 24, font });   // to redact
    p.drawText('PUBLIC HEADING', { x: 72, y: 600, size: 24, font });           // positive OCR control
    p.drawText('tiny hidden text', { x: 300, y: 100, size: 2, font });          // will be rasterized away
  }
  // Link annotation + attachment as additional leak vectors
  const p0 = d.getPage(0);
  const link = d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 690, 300, 720],
    A: { S: 'URI', URI: PDFString.of('https://evil.example/') } });
  p0.node.set(PDFName.of('Annots'), d.context.obj([d.context.register(link)]));
  await d.attach(new TextEncoder().encode('ssn=123-45-6789'), 'notes.txt', { mimeType: 'text/plain' });
  const form = d.getForm(); const tf = form.createTextField('ssn'); tf.setText('123-45-6789'); tf.addToPage(p0, { x: 72, y: 400, width: 200, height: 24 });
  return d.save();
}

const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(root)) throw 0;
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const external = [];
await page.route('**/*', (r) => {
  const u = new URL(r.request().url());
  if (u.hostname !== '127.0.0.1') { external.push(u.href); return r.abort(); }
  return r.continue();
});
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/index.html`);
const fixture = await makeFixture();

const result = await page.evaluate(async (arr) => {
  const T = window.__umbraTest;
  const src = new Uint8Array(arr);
  await T.load(src);
  const sizes = T.sizes();
  // Box over "SECRET ACCOUNT 99x" baseline y=700 (PDF bottom-left) -> top-left space
  const secret = (h) => ({ x: 66, y: h - 728, w: 260, h: 36 });
  const pub = (h) => ({ x: 66, y: h - 628, w: 260, h: 36 });
  T.setBoxes(sizes.map((s) => [secret(s.height)]));
  const srcReport = await T.verify(src);
  const geo = await T.verify(src, sizes.map((s) => [secret(s.height)]));
  const out = await T.export({ dpi: 150 }, true);
  const control = await T.ocrRegions(out.bytes, sizes.map((s) => [pub(s.height)]));
  const s = await T.export({ dpi: 200, searchable: true }, false);
  const sText = await T.text(s.bytes);
  return { srcReport, report: out.report, control, size: out.bytes.length, out: Array.from(out.bytes),
    sReport: s.report, sText, sWords: s.ocrWords, geoInBoxes: geo.textInBoxes };
}, Array.from(fixture));

check(!result.srcReport.ok && result.srcReport.textChars > 0, `negative control: source PDF flagged (${result.srcReport.issues.length} issues)`);
check(result.report.ok, `export verified clean: ${result.report.issues.join('; ') || 'no issues'}`);
check(result.report.textChars === 0, 'no extractable text in output');
check(result.report.fontPages.length === 0, 'no fonts in output');
check(result.report.annotations === 0, 'no annotations in output');
check(result.report.catalogKeys.length === 0, 'no AcroForm/Names/Outlines in output');
check(result.report.metadataFields.length === 0, 'no Title/Author/Keywords in output');
check(result.report.ocr?.checkedRegions === 2 && result.report.ocr.leaks.length === 0, 'OCR finds nothing under redaction boxes');
check(result.control.leaks.length === 2 && /PUBLIC/.test(result.control.leaks[0].text), `positive control: OCR reads unredacted text ("${result.control.leaks[0]?.text}")`);

check(result.geoInBoxes >= 2, `negative control: text under boxes in source is detected (${result.geoInBoxes} items)`);
check(result.sReport.ok && result.sReport.textInBoxes === 0, `searchable export verified: ${result.sReport.issues.join('; ') || 'no issues'} (${result.sWords} words)`);
check(/PUBLIC/.test(result.sText) && /HEADING/.test(result.sText), 'searchable export: visible text is selectable');
check(!/SECRET|ACCOUNT|99[01]/.test(result.sText), `searchable export: redacted text absent from text layer`);

// Independent byte-level check in Node
const outBytes = Buffer.from(result.out);
const latin = outBytes.toString('latin1');
check(!/SECRET|123-45-6789|Jane Leak|evil\.example|notes\.txt/.test(latin), 'no secret strings in raw output bytes');
const outDoc = await PDFDocument.load(outBytes);
check(outDoc.getPageCount() === 2 && outDoc.getTitle() === undefined, `2 pages, no title (${(result.size / 1024).toFixed(0)} KB)`);

// ---------------- Phase 2: search & redact, auto-detect personal data ----------------
const PII = [ // [prefix, value, preset label] drawn on page 1 of the text fixture
  ['NRIC: ', '900101-14-5678', 'NRIC'],
  ['Mobile: ', '+60 12-345 6789', 'Phone'],
  ['Office: ', '03-2161 2345', 'Phone'],
  ['Email: ', 'siti.aminah@example.com', 'Email'],
  ['Card: ', '4111 1111 1111 1111', 'Card'],
  ['Bank account no: ', '1234-5678-9012', 'Bank'],
  ['Passport: ', 'A12345678', 'Passport'],
  ['Date of birth: ', '01/01/1990', 'Date of birth'],
  ['Company: Contoh Sdn Bhd ', '202001012345', 'Company'],
  ['Old reg: ', '1234567-K', 'Company'],
  ['Vehicle: ', 'WXY 1234', 'Vehicle'],
  ['Staff ID: ', 'EMP-00042', 'Staff ID'],
  ['Name: ', 'Siti Aminah binti Ali', 'Name'],
  ['Tenant: ', 'YAP KON SEN', 'Name'],
  ['Encik ', 'Ahmad Faizal', 'Name'],
  ['Address: ', '12 Jalan Contoh, 52100 Kepong, KL', 'Address'],
];
const DECOYS = ['Amount due: RM 2700.00', 'Not a card: 4111 1111 1111 1112', 'Report date: 15/10/2026', 'Page total: 42 items',
  'Storage Lot N 32 at the back', 'Bank name: MAYBANK BANK BERHAD', 'Invoice no 12345 dated today', 'The Tenant shall pay the rent'];

async function makeTextFixture() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const size = 12, H = 792, expected = [];
  const p = d.addPage([612, H]);
  let y = 740;
  p.drawText('Confidential customer record', { x: 72, y, size: 16, font }); y -= 30;
  for (const t of DECOYS.slice(0, 1)) { p.drawText(t, { x: 72, y, size, font }); y -= 22; }
  for (const [pre, val, label] of PII) {
    p.drawText(pre + val, { x: 72, y, size, font });
    const x = 72 + font.widthOfTextAtSize(pre, size);
    expected.push({ page: 0, value: val, label, rect: { x, y: H - (y + 0.7 * size), w: font.widthOfTextAtSize(val, size), h: 0.7 * size } });
    y -= 22;
  }
  for (const t of DECOYS.slice(1)) { p.drawText(t, { x: 72, y, size, font }); y -= 22; }
  // Page 2: repeated search term + an NRIC split across two text objects
  const p2 = d.addPage([612, H]);
  p2.drawText('Confidential', { x: 72, y: 700, size, font });
  p2.drawText('This page is confidential. Really CONFIDENTIAL.', { x: 72, y: 670, size, font });
  const a = 'ID 880202-', b = '10-1234';
  p2.drawText(a, { x: 72, y: 640, size, font });
  p2.drawText(b, { x: 72 + font.widthOfTextAtSize(a, size), y: 640, size, font });
  // Keyword-gated detectors must only use the label on the value's own line.
  p2.drawText('Date of birth: 02/02/1980', { x: 72, y: 610, size, font });
  p2.drawText('Issued: 03/03/2020', { x: 72, y: 588, size, font });
  p2.drawText('Bank account no:', { x: 72, y: 560, size, font });
  p2.drawText('5566 7788 9900', { x: 72, y: 540, size, font });
  p2.drawText('Ref no: 1122 3344 5566', { x: 72, y: 520, size, font });
  for (const [val, label, y, pre] of [['02/02/1980', 'Date of birth', 610, 'Date of birth: '], ['5566 7788 9900', 'Bank', 540, '']]) {
    expected.push({ page: 1, value: val, label,
      rect: { x: 72 + font.widthOfTextAtSize(pre, size), y: H - (y + 0.7 * size), w: font.widthOfTextAtSize(val, size), h: 0.7 * size } });
  }
  // The same name again with no label: found as a repeat of the labelled one on page 1.
  p2.drawText('YAP KON SEN', { x: 300, y: 610, size, font });
  expected.push({ page: 1, value: 'YAP KON SEN', label: 'Name',
    rect: { x: 300, y: H - (610 + 0.7 * size), w: font.widthOfTextAtSize('YAP KON SEN', size), h: 0.7 * size } });
  // NRIC vs new SSM number: same 12-digit shape, decided by the words on the line.
  p2.drawText('Syarikat Maju Sdn Bhd 201001012345', { x: 72, y: 500, size, font });
  p2.drawText('IC No: 201002023456', { x: 72, y: 480, size, font });
  expected.push({ page: 1, value: '201001012345', label: 'Company', not: 'NRIC',
    rect: { x: 72 + font.widthOfTextAtSize('Syarikat Maju Sdn Bhd ', size), y: H - (500 + 0.7 * size), w: font.widthOfTextAtSize('201001012345', size), h: 0.7 * size } });
  expected.push({ page: 1, value: '201002023456', label: 'NRIC', not: 'Company',
    rect: { x: 72 + font.widthOfTextAtSize('IC No: ', size), y: H - (480 + 0.7 * size), w: font.widthOfTextAtSize('201002023456', size), h: 0.7 * size } });
  // Two-line address without a label (street line + postcode line)
  p2.drawText('Lot 5, Pusat Perniagaan Slim Perdana,', { x: 72, y: 450, size, font });
  p2.drawText('35800 Slim River, Perak.', { x: 72, y: 434, size, font });
  const x2 = 72 + font.widthOfTextAtSize('ID ', size);
  expected.push({ page: 1, value: '880202-10-1234', label: 'NRIC',
    rect: { x: x2, y: H - (640 + 0.7 * size), w: font.widthOfTextAtSize('880202-10-1234', size), h: 0.7 * size } });
  return { bytes: await d.save(), expected };
}

const SCAN_LINES = [ // [prefix, value, label]; rendered to pixels -> image-only PDF
  ['NRIC: ', '850505-08-1234', 'NRIC'],
  ['Phone: ', '012-987 6543', 'Phone'],
  ['Email: ', 'ahmad@example.com', 'Email'],
  ['Passport: ', 'H87654321', 'Passport'],
  ['Card: ', '5555 5555 5555 4444', 'Card'],
];

async function makeScanFixture() {
  const img = await page.evaluate(async (lines) => {
    const scale = 150 / 72, c = document.createElement('canvas');
    c.width = Math.round(612 * scale); c.height = Math.round(792 * scale);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000'; g.font = '34px sans-serif'; g.textBaseline = 'alphabetic';
    const expected = [];
    let y = 220;
    g.fillText('Public line stays visible', 150, 150);
    // Partial box: cover only "ble" of "visible" -> "visi" must stay searchable, "visible" must not appear.
    const px = 150 + g.measureText('Public line stays visi').width, pm = g.measureText('ble');
    const partial = { x: (px + 2) / scale, y: (150 - pm.actualBoundingBoxAscent - 4) / scale, w: (pm.width + 4) / scale, h: (pm.actualBoundingBoxAscent + 10) / scale };
    for (const [pre, val, label] of lines) {
      g.fillText(pre + val, 150, y);
      const x = 150 + g.measureText(pre).width, m = g.measureText(val);
      expected.push({ page: 0, value: val, label,
        rect: { x: x / scale, y: (y - m.actualBoundingBoxAscent) / scale, w: m.width / scale, h: m.actualBoundingBoxAscent / scale } });
      y += 70;
    }
    const png = await new Promise((r) => c.toBlob(async (b) => r(Array.from(new Uint8Array(await b.arrayBuffer()))), 'image/png'));
    return { png, expected, partial };
  }, SCAN_LINES);
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  p.drawImage(await d.embedPng(Uint8Array.from(img.png)), { x: 0, y: 0, width: 612, height: 792 });
  return { bytes: await d.save(), expected: img.expected, partial: img.partial };
}

const covers = (hits, e, tol) => {
  const hs = hits.filter((h) => h.page === e.page && h.text.replace(/\s/g, '').includes(e.value.replace(/\s/g, '')));
  return hs.some((h) => {
    const x0 = Math.min(...h.rects.map((r) => r.x)), y0 = Math.min(...h.rects.map((r) => r.y));
    const x1 = Math.max(...h.rects.map((r) => r.x + r.w)), y1 = Math.max(...h.rects.map((r) => r.y + r.h));
    const r = e.rect;
    return x0 <= r.x + tol && y0 <= r.y + tol && x1 >= r.x + r.w - tol && y1 >= r.y + r.h - tol
      && x1 - x0 <= r.w + 12 && h.label.includes(e.label) && !(e.not && h.label.includes(e.not));
  });
};

const textFx = await makeTextFixture();
const scanFx = await makeScanFixture();
const ALL_PRESETS = ['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company', 'plate', 'name', 'address'];
const CUSTOM = [{ label: 'Staff ID', source: 'EMP-\\d{5}', ignoreCase: true }];

const p2 = await page.evaluate(async ({ text, scan, presets, custom, partial }) => {
  const T = window.__umbraTest;
  const strip = (hs) => hs.map(({ id, page, text, label, rects, on }) => ({ id, page, text, label, rects, on }));
  const total = () => T.boxes().reduce((n, b) => n + b.length, 0);
  const out = {};
  // 1) Search & redact (text PDF)
  await T.load(new Uint8Array(text));
  out.caseCount = (await T.search('CONFIDENTIAL', true)).length;
  out.partial = (await T.search('confid')).length;
  out.partialWhole = (await T.search('confid', false, true)).length;
  out.whole = (await T.search('confidential', false, true)).length;
  await T.search('confidential');
  out.terms2 = await T.addTerm('Really');
  out.terms1 = await T.removeTerm(1);
  const found = strip(await T.search('confidential'));
  out.searchCount = found.length;
  out.searchPages = [...new Set(found.map((h) => h.page))];
  T.applyOne(found[0].id); out.afterOne = total();
  T.undo(); out.afterUndo = total();
  T.applyAll(); out.afterAll = total();
  out.afterRedactSearch = (await T.search('confidential')).length; // already redacted -> not offered again
  // 2) Detect (text PDF)
  await T.load(new Uint8Array(text));
  const hits = strip(await T.detect(presets, custom));
  out.textHits = hits;
  T.applyAll();
  out.textBoxes = T.boxes();
  out.rescan = (await T.detect(presets, custom)).length;          // all already redacted -> nothing offered again
  out.boxesAfterRescan = T.boxes().reduce((n, b) => n + b.length, 0);
  out.dirty = T.state().dirty;
  T.back(); out.afterBack1 = T.state();                            // closes the panel
  T.back(); out.afterBack2 = T.state();                            // unsaved -> asks to leave
  T.back(); out.afterBack3 = T.state();                            // Back dismisses the question, document stays
  const ex = await T.export({ dpi: 150 }, true);
  out.textReport = ex.report;
  const vx = await T.export({}, true, 'vector');
  out.vecCheck = { ocr: vx.report.ocr, ok: vx.report.ok, timings: vx.timings };
  const sx = await T.export({ dpi: 200, searchable: true }, false);
  out.textSReport = sx.report;
  out.textLayer = await T.text(sx.bytes);
  // By type: remove a whole category
  await T.load(new Uint8Array(text));
  const before = (await T.detect(presets, custom)).length;
  const afterType = T.removeType('Vehicle plate');
  out.typeRemoved = { before, after: afterType.length, plates: afterType.filter((h) => h.label === 'Vehicle plate').length };
  // Redacted tab: untick removes the item's boxes, tick puts them back
  T.applyAll();
  const nb = () => T.boxes().reduce((n, b) => n + b.length, 0);
  const a0 = nb(); const first = T.applied()[0];
  T.toggleApplied(first.id, false); const a1 = nb();
  T.toggleApplied(first.id, true); const a2 = nb();
  out.second = { a0, a1, a2, applied: T.applied().length };
  // 3) Detect + search (scanned PDF, OCR path)
  await T.load(new Uint8Array(scan));
  out.scanSearch = strip(await T.search('public')).length;
  out.scanHits = strip(await T.detect(['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company']));
  T.applyAll();
  T.setBoxes(T.boxes().map((b, i) => (i === 0 ? [...b, partial] : b)));
  const sc = await T.export({ dpi: 200, searchable: true }, true);
  out.scanReport = sc.report;
  out.scanLayer = await T.text(sc.bytes);
  out.scanWords = sc.ocrWords;
  const t6 = performance.now();
  const s6 = await T.export({ dpi: 600, searchable: true }, false); // OCR runs on a 300 DPI copy
  out.ms600 = Math.round(performance.now() - t6);
  out.layer600 = await T.text(s6.bytes);
  out.ok600 = s6.report.ok;
  return out;
}, { text: Array.from(textFx.bytes), scan: Array.from(scanFx.bytes), presets: ALL_PRESETS, custom: CUSTOM, partial: scanFx.partial });

check(p2.searchCount === 4 && p2.searchPages.length === 2, `search: 4 matches of "confidential" across 2 pages (got ${p2.searchCount})`);
check(p2.afterOne === 1 && p2.afterUndo === 0 && p2.afterAll === 4, `search: redact one (${p2.afterOne}), undo (${p2.afterUndo}), redact all (${p2.afterAll})`);
check(p2.partial === 4 && p2.partialWhole === 0 && p2.whole === 4, `search: whole word (partial ${p2.partial}, partial+whole ${p2.partialWhole}, whole ${p2.whole})`);
check(p2.terms2.terms === 2 && p2.terms2.hits === 5 && p2.terms1.terms === 1 && p2.terms1.hits === 4, `find: terms as filters, add/remove (${JSON.stringify([p2.terms2, p2.terms1])})`);
check(p2.second.a1 < p2.second.a0 && p2.second.a2 === p2.second.a0 && p2.second.applied > 0, `Redacted tab: un-redact and re-redact one item ${JSON.stringify(p2.second)}`);
check(p2.typeRemoved.after === p2.typeRemoved.before - 1 && p2.typeRemoved.plates === 0, `detect: remove a type (${JSON.stringify(p2.typeRemoved)})`);
check(p2.afterRedactSearch === 0, `search: already-redacted matches are not offered again (${p2.afterRedactSearch})`);
check(p2.caseCount === 1, `search: match case finds only "CONFIDENTIAL" (${p2.caseCount})`);
for (const e of textFx.expected) check(covers(p2.textHits, e, 0.5), `detect (text): ${e.label} "${e.value}" found and boxed`);
const bad = p2.textHits.filter((h) => /1112|15\/10\/2026|03\/03\/2020|1122|RM 2700|N 32|MAYBANK|12345 dated|shall pay|\b42\b/.test(h.text));
const addr2 = p2.textHits.find((h) => h.label.includes('Address') && /Slim Perdana/.test(h.text) && /35800 Slim River/.test(h.text));
check(!!addr2 && addr2.rects.length >= 2, `detect (text): two-line unlabelled address found (${addr2?.text.replace(/\n/g, ' / ')})`);
check(bad.length === 0, `detect (text): decoys not flagged ${bad.map((h) => `${h.label}:${h.text}`).join(', ')}`);
check(p2.rescan === 0 && p2.boxesAfterRescan === p2.textBoxes.reduce((n, b) => n + b.length, 0), `detect: re-scan offers nothing already redacted (${p2.rescan} offered)`);
check(p2.dirty && !p2.afterBack1.panel && p2.afterBack2.modal && p2.afterBack2.hasDoc && !p2.afterBack3.modal && p2.afterBack3.hasDoc,
  `back: panel -> leave prompt (unsaved) -> dismiss ${JSON.stringify([p2.afterBack1, p2.afterBack2, p2.afterBack3])}`);
check(p2.textHits.every((h) => h.on), 'detect: suggestions start selected, applied only via Apply');
check(p2.textReport.ocr?.solidRegions === p2.textReport.ocr?.checkedRegions && p2.textReport.ocr.checkedRegions > 10, `speed: every black box proven solid by pixels, no OCR needed (image: ${p2.textReport.ocr?.solidRegions}/${p2.textReport.ocr?.checkedRegions})`);
check(p2.vecCheck.ok && p2.vecCheck.ocr?.solidRegions === p2.vecCheck.ocr?.checkedRegions, `speed: same for Keep original text (${p2.vecCheck.ocr?.solidRegions}/${p2.vecCheck.ocr?.checkedRegions})`);
console.log(`INFO  export timings (vector, ${p2.vecCheck.ocr?.checkedRegions} boxes): ${p2.vecCheck.timings.map(([n, ms]) => `${n} ${Math.round(ms)} ms`).join(', ')}`);
check(p2.textReport.ok && p2.textReport.ocr?.leaks.length === 0, `detect (text): export verified clean, OCR check ${p2.textReport.ocr?.checkedRegions} regions: ${p2.textReport.issues.join('; ') || 'no issues'}`);
check(p2.textSReport.ok, `detect (text): searchable export verified: ${p2.textSReport.issues.join('; ') || 'no issues'}`);
const leaked = [...PII.map((x) => x[1]), '880202'].filter((v) => p2.textLayer.replace(/\s/g, '').includes(v.replace(/\s/g, '')));
check(leaked.length === 0, `detect (text): no planted PII in searchable text layer ${leaked.join(', ')}`);
check(/Report/.test(p2.textLayer), 'detect (text): unflagged text still searchable');

check(p2.scanSearch === 1, `search (scanned/OCR): finds "public" (${p2.scanSearch})`);
for (const e of scanFx.expected) check(covers(p2.scanHits, e, 1.5), `detect (scanned): ${e.label} "${e.value}" found and boxed`);
check(p2.scanReport.ok && p2.scanReport.ocr?.leaks.length === 0, `detect (scanned): export verified clean: ${p2.scanReport.issues.join('; ') || 'no issues'}`);
const sLeaked = SCAN_LINES.map((x) => x[1]).filter((v) => p2.scanLayer.replace(/\s/g, '').includes(v.replace(/\s/g, '')));
check(sLeaked.length === 0 && /Public/.test(p2.scanLayer), `detect (scanned): PII absent from OCR text layer, public text kept (${p2.scanWords} words)`);
check(/stays\s*vis/.test(p2.scanLayer) && !/visible/.test(p2.scanLayer), `searchable: visible part of a partly redacted word is kept ("${(p2.scanLayer.match(/stays\s*\S*/) || [''])[0]}")`);
check(p2.ok600 && /Public/.test(p2.layer600) && !/850505|ahmad@|H87654321/.test(p2.layer600), `600 DPI searchable export: verified, text layer correct (${p2.ms600} ms)`);
if (failed) console.log('debug hits:', JSON.stringify({ text: p2.textHits.map((h) => [h.label, h.text]), scan: p2.scanHits.map((h) => [h.label, h.text]) }));

// ---------------- "Keep original text" (MuPDF true redaction) ----------------
async function makeVectorFixture() {
  // Start from the leak-vector fixture (links, attachment, form field, metadata, SECRET ACCOUNT on 2 pages).
  const d = await PDFDocument.load(await makeFixture());
  const font = await d.embedFont(StandardFonts.Helvetica);
  const f = d.getPage(0).node.newFontDictionary('FV', font.ref);
  const p0 = d.getPage(0);
  // Invisible text (like an OCR layer) and marked content with an ActualText copy of a secret
  p0.pushOperators(
    beginText(), setFontAndSize(f, 14), setTextRenderingMode(TextRenderingMode.Invisible), moveText(72, 540),
    showText(font.encodeText('INVISIBLE SECRET 555')), endText(),
    PDFOperator.of('BDC', [PDFName.of('Span'), d.context.obj({ ActualText: PDFString.of('SECRET ALT 777') })]),
    beginText(), setFontAndSize(f, 14), moveText(72, 500), showText(font.encodeText('Hidden word')), endText(),
    PDFOperator.of('EMC'),
  );
  // Text inside a Form XObject
  const other = await PDFDocument.create();
  const op = other.addPage([300, 40]);
  op.drawText('XOBJ SECRET 888', { x: 2, y: 12, size: 14, font: await other.embedFont(StandardFonts.Helvetica) });
  const [emb] = await d.embedPdf(await other.save());
  p0.drawPage(emb, { x: 72, y: 440 });
  // An image that contains secret text
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 80;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 80);
    g.fillStyle = '#000'; g.font = 'bold 44px sans-serif'; g.fillText('IMG SECRET 4321', 12, 58);
    return await new Promise((r) => c.toBlob(async (b) => r(Array.from(new Uint8Array(await b.arrayBuffer()))), 'image/png'));
  });
  const img = await d.embedPng(Uint8Array.from(png));
  p0.drawImage(img, { x: 72, y: 300, width: 300, height: 40 });
  // Rotated page with a crop box offset
  const pr = d.addPage([612, 792]);
  pr.drawText('ROT SECRET 999', { x: 100, y: 600, size: 18, font });
  pr.drawText('ROT PUBLIC', { x: 100, y: 500, size: 18, font });
  pr.setCropBox(20, 30, 560, 740);
  pr.setRotation(degrees(90));
  return d.save();
}

const vfx = await makeVectorFixture();
const ocgDoc = await (async () => {
  const d = await PDFDocument.create(); const p = d.addPage([300, 300]);
  p.drawText('visible', { x: 20, y: 200, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
  const ocg = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden') }));
  d.catalog.set(PDFName.of('OCProperties'), d.context.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
  return d.save();
})();
const ocgRes = await page.evaluate(async (arr) => {
  const T = window.__umbraTest; await T.load(new Uint8Array(arr));
  try { await T.export({}, false, 'vector'); return 'exported'; } catch (e) { return String(e.message); }
}, Array.from(ocgDoc));
check(/hidden layers/i.test(ocgRes), `vector: refuses PDFs with hidden layers ("${ocgRes}")`);
const V = await page.evaluate(async (arr) => {
  const T = window.__umbraTest;
  const src = new Uint8Array(arr);
  await T.load(src);
  const sizes = T.sizes();
  await T.search('SECRET ACCOUNT');
  for (const t of ['INVISIBLE SECRET 555', 'Hidden word', 'XOBJ SECRET 888', 'ROT SECRET 999']) await T.addTerm(t);
  const found = T.state();
  T.applyAll();
  const imgBox = { x: 68, y: sizes[0].height - 344, w: 308, h: 48 }; // image drawn at y=300..340 (PDF space)
  const boxes = T.boxes().map((b, i) => (i === 0 ? [...b, imgBox] : [...b]));
  T.setBoxes(boxes);
  const t0 = performance.now();
  const out = await T.export({}, true, 'vector');
  const ms = Math.round(performance.now() - t0);
  const text = await T.text(out.bytes);
  const img = await T.export({ dpi: 300 }, false, 'image');
  // Without black boxes: what is left under them must be blank (image pixels, text)
  const nb = await T.exportVectorRaw(boxes, false);
  const under = await T.ocrRegions(nb, boxes.map((b, i) => (i === 0 ? [imgBox] : [])));
  const control = await T.ocrRegions(src, boxes.map((b, i) => (i === 0 ? [imgBox] : [])));
  const nbText = await T.text(nb);
  const neg = await T.verifyVector(src, boxes); // the untouched source must fail the vector check
  return { report: out.report, text, ms, size: out.bytes.length, imgSize: img.bytes.length, out: Array.from(out.bytes),
    under, control, nbText, neg, nBoxes: boxes.map((b) => b.length) };
}, Array.from(vfx));

check(V.nBoxes[0] >= 5 && V.nBoxes[2] >= 1, `vector: boxes from Find on normal, invisible, Form XObject and rotated text (${V.nBoxes})`);
check(!V.neg.ok && V.neg.textInBoxes > 0 && V.neg.annotations > 0, `vector: negative control, source fails the check (${V.neg.issues.length} issues: ${V.neg.issues.join('; ').slice(0, 160)})`);
check(V.report.ok, `vector: export verified clean (${V.ms} ms): ${V.report.issues.join('; ') || 'no issues'}`);
check(!/SECRET|555|777|888|999|4321|Hidden/.test(V.text), `vector: no redacted text extractable ("${V.text.replace(/\s+/g, ' ').slice(0, 120)}")`);
check(/PUBLIC HEADING/.test(V.text) && /ROT PUBLIC/.test(V.text), 'vector: text outside the boxes is kept and selectable (incl. rotated page)');
check(!/SECRET|555|888|999|Hidden/.test(V.nbText), 'vector: text removed from the file, not just covered (no-box variant)');
check(V.control.leaks.some((l) => /SECRET|4321/.test(l.text)) && V.under.leaks.length === 0,
  `vector: image pixels under the box are blanked (control "${V.control.leaks[0]?.text}", after: ${V.under.leaks.map((l) => l.text).join('|') || 'nothing'})`);
check(V.size < V.imgSize / 3, `vector: much smaller than image export (${(V.size / 1024).toFixed(0)} KB vs ${(V.imgSize / 1024).toFixed(0)} KB)`);
{
  // Node-side: decode every stream and look for secrets, metadata, attachments, scripts.
  const od = await PDFDocument.load(Uint8Array.from(V.out));
  let blob = '';
  for (const [, obj] of od.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) { try { blob += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1'); } catch { blob += '?'; } }
    else blob += obj.toString();
  }
  const raw = blob + Buffer.from(V.out).toString('latin1');
  check(!/SECRET ALT 777|Jane Leak|evil\.example|notes\.txt|ssn=|\/T\s*\(ssn\)/.test(raw), 'vector: no secrets, ActualText, form field, attachment, link or metadata in any decoded stream');
  // A filled-in form field that is not under a box stays visible on the page (now as plain page content).
  check(/123-45-6789/.test(V.text), 'vector: visible (unredacted) form value is kept as page text, the form itself is removed');
  check(od.getTitle() === undefined && od.getAuthor() === undefined, 'vector: no Title/Author');
}

// ---------------- 1.1: TIN, stronger Name / Account No., tables, ID cards ----------------
{
  const ALL = ['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company', 'tin', 'name', 'address'];
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  const put = (t, x, y) => p.drawText(t, { x, y, size: 10, font });
  const want = [ // [value, label] that must be found with exactly this text
    ['IG12345678090', 'TIN'], ['SG 10234567890', 'TIN'], ['C2584563202', 'TIN'], ['D4800990020', 'TIN'],
    ['tan wei ming', 'Name'], ['LIM SIEW LING', 'Name'], ['Nurul Huda binti Hassan', 'Name'],
    ['8001234567', 'Bank'], ['1-2345-6789-0', 'Bank'], ['ACC-00012345678', 'Bank'],
    ['CHONG MEI LING', 'Name'], ['Muhammad Hafiz bin Ismail', 'Name'], ['Ravi Kumar s/o Subramaniam', 'Name'],
    ['7612345678', 'Bank'], ['11223344556', 'Bank'], ['00998877665544', 'Bank'],
    ['Tan Kok Keong', 'Name'], ['Mohd Azman Ismail', 'Name'], ['5141 2345 6789', 'Bank'],
    ['Tan Chee Kiat', 'Name'], ['Lee Kah Wai', 'Name'],
  ];
  const decoys = ['Account No', 'Account Holder', 'IC Number', 'Raja Muda Abdul Aziz', 'See Below Note', 'Tan Sri Example', 'INV-2024-0001', 'Name Of Applicant', 'Nama Penuh Seperti Dalam Kad'];
  let y = 750;
  for (const t of ['TIN: IG12345678090', 'No. Cukai Pendapatan: SG 10234567890', 'Company income tax no. C2584563202 (LHDN)', 'Partnership TIN D4800990020',
    'Name: tan wei ming', 'NAME     LIM SIEW LING', 'Nama Pemegang Akaun: Nurul Huda binti Hassan', 'Account No.: 8001234567',
    'No. Akaun: 1-2345-6789-0', 'Account No: ACC-00012345678', 'Please contact Tan Kok Keong for details.', 'Signed by Mohd Azman Ismail on behalf of the company.',
    'Office: 8 Jalan Raja Muda Abdul Aziz, Kampung Baru', 'See Below Note', 'Tan Sri Example Foundation', 'Tax invoice no: INV-2024-0001',
    'Name Of Applicant', 'Nama Penuh Seperti Dalam Kad', 'Account Holder:', 'Account No.', '5141 2345 6789', 'Name', 'IC Number',
    'Please contact Tan Chee Kiat for details.', 'Lee Kah Wai to sign the form.']) { put(t, 72, y); y -= 18; }
  // A table: header row, then data rows (no labels in the rows).
  y -= 10;
  const cols = [72, 100, 260, 360, 470];
  ['No', 'Name', 'IC No.', 'Account No.', 'Branch'].forEach((h, k) => put(h, cols[k], y)); y -= 16;
  for (const row of [['1', 'CHONG MEI LING', '880808-08-8888', '7612345678', 'Kepong'],
    ['2', 'Muhammad Hafiz bin Ismail', '900202-10-1111', '11223344556', 'Ipoh'],
    ['3', 'Ravi Kumar s/o Subramaniam', '850303-07-2222', '00998877665544', 'Klang']]) { row.forEach((c, k) => put(c, cols[k], y)); y -= 16; }
  const img = await drawCard(page, CARD);
  const cards = await makeCardPdfs(PDFDocument, StandardFonts, img);
  const R = await page.evaluate(async ({ text, scan, mixed, ALL }) => {
    const T = window.__umbraTest;
    const strip = (hs) => hs.map(({ page, text, label }) => ({ page, text: text.replace(/\s+/g, ' ').trim(), label }));
    await T.load(new Uint8Array(text));
    const t = strip(await T.detect(ALL));
    const out = { t };
    for (const [k, b] of [['scan', scan], ['mixed', mixed]]) {
      await T.load(new Uint8Array(b));
      out[k] = strip(await T.detect(ALL));
      out[k + 'Page'] = await T.pageText(0);
      T.applyAll();
      const ex = await T.export({}, true, 'vector');
      out[k + 'Report'] = ex.report;
      out[k + 'Text'] = await T.text(ex.bytes);
    }
    return out;
  }, { text: Array.from(await d.save()), scan: Array.from(cards.scan.bytes), mixed: Array.from(cards.mixed.bytes), ALL });
  for (const [v, l] of want) check(R.t.some((h) => h.text === v && h.label.includes(l)), `1.1 detect: ${l} "${v}"${R.t.some((h) => h.text.includes(v)) ? '' : ' (not found)'} ${R.t.filter((h) => h.text.includes(v.split(' ')[0])).map((h) => `[${h.label}: ${h.text}]`).join(' ')}`);
  const fp = R.t.filter((h) => decoys.some((x) => x.includes(h.text) || h.text.includes(x)));
  check(fp.length === 0, `1.1 detect: decoys not flagged ${fp.map((h) => `${h.label}:${h.text}`).join(', ')}`);
  for (const k of ['scan', 'mixed']) {
    const hs = R[k];
    check(hs.some((h) => h.label.includes('NRIC') && h.text.replace(/[^\dA-Z]/g, '').length >= 12), `ID card (${k}): IC number found ${hs.map((h) => `[${h.label}: ${h.text}]`).join(' ')} | OCR: ${JSON.stringify(R[k + 'Page'] ?? '').slice(0, 400)}`);
    check(hs.some((h) => h.label.includes('Name') && h.text === CARD.name.join(' ')), `ID card (${k}): name found ${hs.map((h) => `[${h.label}: ${h.text}]`).join(' ')}`);
    check(hs.some((h) => h.label.includes('Address') && CARD.address.every((a) => h.text.includes(a))), `ID card (${k}): full address found`);
    check(R[k + 'Report'].ok, `ID card (${k}): redacted export verified: ${R[k + 'Report'].issues.join('; ') || 'ok'}`);
  }
  check(/Salinan Kad Pengenalan/.test(R.mixedText) && !/TAN WEI MING|900101/.test(R.mixedText), 'ID card (mixed): typed text kept, card details gone from the exported text');
}

{
  // Size benchmark: 7 pages of contract-like text (not a pass/fail check, printed for reference)
  const d = await PDFDocument.create();
  const tr = await d.embedFont(StandardFonts.TimesRoman), tb = await d.embedFont(StandardFonts.TimesRomanBold);
  const para = 'The Tenant shall upon execution of this Agreement pay the Landlord the sum stipulated in Schedule Section G by way of deposit as security for due observance and performance by the Tenant of the terms and conditions of this Agreement.';
  for (let i = 0; i < 7; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`TENANCY AGREEMENT - PAGE ${i + 1}`, { x: 70, y: 780, size: 16, font: tb });
    for (let l = 0; l < 44; l++) p.drawText(para.slice((l * 7) % 60, (l * 7) % 60 + 85), { x: 70, y: 740 - l * 15, size: 11, font: tr });
  }
  const B = await page.evaluate(async (arr) => {
    const T = window.__umbraTest; await T.load(new Uint8Array(arr));
    T.setBoxes(T.sizes().map((s) => [{ x: 70, y: 100, w: 200, h: 14 }]));
    const kb = (b) => Math.round(b.length / 1024);
    const r = {};
    for (const [k, o, m] of [['vector', {}, 'vector'], ['png300', { dpi: 300 }, 'image'], ['png600', { dpi: 600 }, 'image'], ['jpeg300', { dpi: 300, format: 'jpeg' }, 'image']]) {
      const t0 = performance.now(); const e = await T.export(o, false, m); r[k] = `${kb(e.bytes)} KB / ${Math.round(performance.now() - t0)} ms`;
    }
    return r;
  }, Array.from(await d.save()));
  console.log('INFO  size benchmark, 7 text pages:', JSON.stringify(B));
}

check(external.length === 0, `no external network requests ${external.join(', ')}`);
check(consoleErrors.length === 0, `no console errors ${consoleErrors.join(' | ')}`);

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);

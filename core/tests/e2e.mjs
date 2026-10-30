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
    const body = await readFile(path); // before the headers: a missing file (e.g. api/caps) answers 404
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
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

// UMBRA_URL: run against another server, e.g. the desktop app's (web/).
await page.goto(process.env.UMBRA_URL ?? `http://127.0.0.1:${port}/index.html`);
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
  out.scanRaw = await T.text(sc.bytes, true);
  out.scanBytes = Array.from(sc.bytes);
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
check(/stays\s*v/.test(p2.scanLayer) && !/visible/.test(p2.scanLayer), `searchable: visible part of a partly redacted word is kept ("${(p2.scanLayer.match(/stays\s*\S*/) || [''])[0]}")`);
check(/Public line stays/.test(p2.scanRaw), `searchable: real spaces between OCR words, phrase search works ("${(p2.scanRaw.match(/Public[^\n]*/) || [''])[0]}")`);
{
  // Every font the text layer names must be in the page's resources (a stray '/' once broke this).
  const d = await PDFDocument.load(new Uint8Array(p2.scanBytes));
  const bad = [];
  for (const pg of d.getPages()) {
    const fonts = pg.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const have = new Set((fonts?.keys() ?? []).map((k) => k.asString()));
    const c = pg.node.Contents();
    const streams = c instanceof PDFStream ? [c] : (c?.asArray() ?? []).map((r) => d.context.lookup(r));
    for (const st of streams) {
      const src = new TextDecoder('latin1').decode(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents());
      for (const [, n] of src.matchAll(/(\/[^\s/\[\]()<>]+)\s+[\d.]+\s+Tf/g)) if (!have.has(n)) bad.push(n);
    }
  }
  check(bad.length === 0, `searchable: text layer fonts resolve${bad.length ? ` (missing ${[...new Set(bad)].join(', ')})` : ''}`);
}
check(p2.ok600 && /Public/.test(p2.layer600) && !/850505|ahmad@|H87654321/.test(p2.layer600), `600 DPI searchable export: verified, text layer correct (${p2.ms600} ms)`);
if (failed) console.log('debug hits:', JSON.stringify({ text: p2.textHits.map((h) => [h.label, h.text]), scan: p2.scanHits.map((h) => [h.label, h.text]) }));

// ---------------- Short block of print on a blank page (once read as a skewed "card") ----------------
{
  const BLOCK = ['Name: Tan Chee Kin', 'Address: 12 Jalan Contoh, Kepong', 'The quick brown fox jumps over the lazy dog.', 'Monthly salary: RM 8,500 paid on 25th'];
  const fx = await page.evaluate(async (lines) => {
    const c = document.createElement('canvas'); c.width = 1700; c.height = 2200;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111';
    g.font = '44px Arial';
    const k = 612 / 1700, want = [];
    lines.forEach((l, i) => {
      const y = 200 + i * 80; g.fillText(l, 150, y);
      let at = 0;
      for (const w of l.split(' ')) {
        const pre = l.slice(0, l.indexOf(w, at)); at = pre.length + w.length;
        const a = 150 + g.measureText(pre).width, m = g.measureText(w);
        want.push({ text: w, x0: a * k, x1: (a + m.width) * k, y0: (y - m.actualBoundingBoxAscent) * k, y1: (y + m.actualBoundingBoxDescent) * k });
      }
    });
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return { jpg: Array.from(new Uint8Array(await b.arrayBuffer())), want };
  }, BLOCK);
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawImage(await d.embedJpg(Uint8Array.from(fx.jpg)), { x: 0, y: 0, width: 612, height: 792 });
  const got = await page.evaluate(async (a) => { const T = window.__umbraTest; await T.load(new Uint8Array(a)); return T.pageWords(0); }, Array.from(await d.save()));
  const norm = (t) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  // Each printed word is read, and its box sits on the word (centre inside the printed word, 3 pt slack).
  const off = fx.want.filter((e) => !got.some((w) => norm(w.text) === norm(e.text)
    && Math.abs((w.x0 + w.x1) / 2 - (e.x0 + e.x1) / 2) <= (e.x1 - e.x0) / 2 + 3 && Math.abs((w.y0 + w.y1) / 2 - (e.y0 + e.y1) / 2) <= (e.y1 - e.y0) / 2 + 3));
  check(off.length === 0, `short block on a blank page: every word read where it is printed${off.length ? ` (missing or misplaced: ${off.map((e) => e.text).join(' ')}; read: ${got.map((w) => w.text).join(' ')})` : ''}`);
}

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
  const dark = (await T.boxDarkness(out.bytes, boxes)).flat();
  return { dark, report: out.report, text, ms, size: out.bytes.length, imgSize: img.bytes.length, out: Array.from(out.bytes),
    under, control, nbText, neg, nBoxes: boxes.map((b) => b.length) };
}, Array.from(vfx));

check(V.nBoxes[0] >= 5 && V.nBoxes[2] >= 1, `vector: boxes from Find on normal, invisible, Form XObject and rotated text (${V.nBoxes})`);
check(!V.neg.ok && V.neg.textInBoxes > 0 && V.neg.annotations > 0, `vector: negative control, source fails the check (${V.neg.issues.length} issues: ${V.neg.issues.join('; ').slice(0, 160)})`);
check(V.dark.length > 5 && V.dark.every((d) => d > 0.97), `vector: every box is solid black where it was drawn, incl. rotated page (${V.dark.map((d) => d.toFixed(2)).join(' ')})`);
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

// ---------------- "Keep original text": shapes under a box, hidden text next to a box ----------------
// "PUBLIC SECRET 42" drawn as one filled path (text converted to outlines, DejaVu Sans Bold 28 pt).
const OUTLINED = 'M2.6 0L2.6-20.4L11.3-20.4Q15.2-20.4 17.3-18.7Q19.4-17 19.4-13.8L19.4-13.8Q19.4-10.5 17.3-8.8Q15.2-7.1 11.3-7.1L11.3-7.1L7.8-7.1L7.8 0L2.6 0ZM10.7-16.6L7.8-16.6L7.8-10.9L10.7-10.9Q12.3-10.9 13.1-11.6Q13.9-12.4 13.9-13.8L13.9-13.8Q13.9-15.1 13.1-15.9Q12.3-16.6 10.7-16.6L10.7-16.6ZM23.1-8.2L23.1-20.4L28.4-20.4L28.4-8.2Q28.4-5.6 29.2-4.6Q30-3.5 31.9-3.5L31.9-3.5Q33.8-3.5 34.6-4.6Q35.4-5.6 35.4-8.2L35.4-8.2L35.4-20.4L40.7-20.4L40.7-8.2Q40.7-3.8 38.5-1.7Q36.3 0.4 31.9 0.4L31.9 0.4Q27.4 0.4 25.3-1.7Q23.1-3.8 23.1-8.2L23.1-8.2ZM51.1-12.5L54-12.5Q55.2-12.5 55.9-13.1Q56.5-13.6 56.5-14.7L56.5-14.7Q56.5-15.7 55.9-16.3Q55.2-16.8 54-16.8L54-16.8L51.1-16.8L51.1-12.5ZM51.1-3.6L54.2-3.6Q55.8-3.6 56.6-4.3Q57.4-4.9 57.4-6.3L57.4-6.3Q57.4-7.6 56.6-8.3Q55.8-8.9 54.2-8.9L54.2-8.9L51.1-8.9L51.1-3.6ZM59.1-10.9L59.1-10.9Q60.8-10.4 61.7-9.1Q62.6-7.8 62.6-5.9L62.6-5.9Q62.6-2.9 60.6-1.4Q58.6 0 54.6 0L54.6 0L45.8 0L45.8-20.4L53.7-20.4Q58-20.4 59.9-19.1Q61.8-17.8 61.8-15L61.8-15Q61.8-13.5 61.1-12.5Q60.4-11.4 59.1-10.9ZM67.2 0L67.2-20.4L72.4-20.4L72.4-4L81.7-4L81.7 0L67.2 0ZM85 0L85-20.4L90.3-20.4L90.3 0L85 0ZM111.6-5.3L111.6-1.1Q110.2-0.4 108.6 0Q107 0.4 105.3 0.4L105.3 0.4Q100.2 0.4 97.2-2.5Q94.3-5.3 94.3-10.2L94.3-10.2Q94.3-15.1 97.2-17.9Q100.2-20.8 105.3-20.8L105.3-20.8Q107-20.8 108.6-20.4Q110.2-20 111.6-19.3L111.6-19.3L111.6-15Q110.2-16 108.7-16.5Q107.3-17 105.7-17L105.7-17Q102.9-17 101.3-15.2Q99.7-13.4 99.7-10.2L99.7-10.2Q99.7-7 101.3-5.2Q102.9-3.4 105.7-3.4L105.7-3.4Q107.3-3.4 108.7-3.9Q110.2-4.3 111.6-5.3L111.6-5.3ZM139.9-19.8L139.9-19.8L139.9-15.4Q138.3-16.2 136.7-16.6Q135.1-17 133.6-17L133.6-17Q131.7-17 130.8-16.4Q129.9-15.9 129.9-14.8L129.9-14.8Q129.9-14 130.5-13.6Q131.2-13.1 132.8-12.8L132.8-12.8L135-12.3Q138.4-11.6 139.8-10.2Q141.3-8.8 141.3-6.3L141.3-6.3Q141.3-2.9 139.3-1.3Q137.3 0.4 133.2 0.4L133.2 0.4Q131.2 0.4 129.3 0Q127.3-0.3 125.3-1.1L125.3-1.1L125.3-5.5Q127.3-4.5 129.1-3.9Q130.9-3.4 132.6-3.4L132.6-3.4Q134.4-3.4 135.3-4Q136.2-4.6 136.2-5.6L136.2-5.6Q136.2-6.6 135.6-7.1Q135-7.6 133.1-8L133.1-8L131.1-8.5Q128-9.1 126.6-10.6Q125.2-12 125.2-14.5L125.2-14.5Q125.2-17.5 127.1-19.1Q129.1-20.8 132.8-20.8L132.8-20.8Q134.5-20.8 136.3-20.5Q138-20.3 139.9-19.8ZM145.9 0L145.9-20.4L160.1-20.4L160.1-16.4L151.2-16.4L151.2-12.6L159.6-12.6L159.6-8.7L151.2-8.7L151.2-4L160.4-4L160.4 0L145.9 0ZM181.2-5.3L181.2-1.1Q179.8-0.4 178.2 0Q176.6 0.4 174.9 0.4L174.9 0.4Q169.8 0.4 166.8-2.5Q163.8-5.3 163.8-10.2L163.8-10.2Q163.8-15.1 166.8-17.9Q169.8-20.8 174.9-20.8L174.9-20.8Q176.6-20.8 178.2-20.4Q179.8-20 181.2-19.3L181.2-19.3L181.2-15Q179.7-16 178.3-16.5Q176.9-17 175.3-17L175.3-17Q172.5-17 170.9-15.2Q169.3-13.4 169.3-10.2L169.3-10.2Q169.3-7 170.9-5.2Q172.5-3.4 175.3-3.4L175.3-3.4Q176.9-3.4 178.3-3.9Q179.7-4.3 181.2-5.3L181.2-5.3ZM190.8-11.4L193-11.4Q194.7-11.4 195.4-12Q196.1-12.6 196.1-14L196.1-14Q196.1-15.4 195.4-16Q194.7-16.6 193-16.6L193-16.6L190.8-16.6L190.8-11.4ZM192.3-7.7L190.8-7.7L190.8 0L185.6 0L185.6-20.4L193.6-20.4Q197.6-20.4 199.5-19.1Q201.4-17.7 201.4-14.8L201.4-14.8Q201.4-12.8 200.4-11.5Q199.4-10.2 197.5-9.5L197.5-9.5Q198.6-9.3 199.4-8.4Q200.3-7.6 201.1-5.8L201.1-5.8L204 0L198.4 0L195.9-5.1Q195.2-6.6 194.4-7.2Q193.6-7.7 192.3-7.7L192.3-7.7ZM207.1 0L207.1-20.4L221.3-20.4L221.3-16.4L212.4-16.4L212.4-12.6L220.8-12.6L220.8-8.7L212.4-8.7L212.4-4L221.6-4L221.6 0L207.1 0ZM223.8-16.4L223.8-20.4L242.6-20.4L242.6-16.4L235.9-16.4L235.9 0L230.6 0L230.6-16.4L223.8-16.4ZM262.8-7.5L262.8-16.1L257.1-7.5L262.8-7.5ZM253.8-8.2L262-20.4L267.8-20.4L267.8-7.5L270.7-7.5L270.7-3.7L267.8-3.7L267.8 0L262.8 0L262.8-3.7L253.8-3.7L253.8-8.2ZM284.4-7.7L280.1-3.9L289.1-3.9L289.1 0L274.2 0L274.2-3.9L281.7-10.4Q282.7-11.3 283.2-12.2Q283.6-13.1 283.6-14L283.6-14Q283.6-15.4 282.7-16.3Q281.7-17.2 280.1-17.2L280.1-17.2Q278.9-17.2 277.4-16.7Q276-16.1 274.3-15.1L274.3-15.1L274.3-19.6Q276.1-20.2 277.8-20.5Q279.5-20.8 281.2-20.8L281.2-20.8Q284.9-20.8 286.9-19.2Q288.9-17.6 288.9-14.7L288.9-14.7Q288.9-13 288.1-11.6Q287.2-10.1 284.4-7.7L284.4-7.7Z';
const outlineDoc = await (async () => {
  const d = await PDFDocument.create(); const p = d.addPage([612, 400]);
  p.drawSvgPath(OUTLINED, { x: 72, y: 200 });
  return d.save();
})();
const hiddenDoc = await (async () => {
  const d = await PDFDocument.create(); const p = d.addPage([612, 400]);
  const font = await d.embedFont(StandardFonts.Helvetica);
  p.drawText('Name: TAN AH KOW', { x: 72, y: 300, size: 18, font });
  // An OCR-style invisible copy that doesn't line up with the visible line (40 pt lower)
  const f = p.node.newFontDictionary('FH', font.ref);
  p.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(f, 18), setTextRenderingMode(TextRenderingMode.Invisible),
    moveText(72, 260), showText(font.encodeText('Name: TAN AH KOW')), endText(), popGraphicsState());
  return d.save();
})();
const SH = await page.evaluate(async ([outl, hid]) => {
  const T = window.__umbraTest;
  await T.load(new Uint8Array(outl));
  const H = T.sizes()[0].height;
  T.setBoxes([[{ x: 186, y: H - 228, w: 186, h: 34 }]]); // over "SECRET 42" only
  const vec = await T.export({}, false, 'vector');
  const img = await T.export({ dpi: 200 }, false, 'image');
  await T.load(new Uint8Array(hid));
  const H2 = T.sizes()[0].height;
  T.setBoxes([[{ x: 70, y: H2 - 322, w: 200, h: 28 }]]); // over the visible line only
  let hidden;
  try { await T.export({}, false, 'vector'); hidden = 'exported'; } catch (e) { hidden = `${e.name}: ${e.message}`; }
  T.setBoxes([[{ x: 70, y: H2 - 322, w: 200, h: 28 }, { x: 70, y: H2 - 282, w: 200, h: 28 }]]); // both lines boxed
  const both = await T.export({}, false, 'vector');
  return { vec: vec.report, img: img.report, hidden, both: both.report };
}, [Array.from(outlineDoc), Array.from(hiddenDoc)]);
check(!SH.vec.ok && SH.vec.issues.some((i) => /under 1 box/.test(i)),
  `vector: outlined text left under a box is caught, nothing saved (${SH.vec.issues.join('; ').slice(0, 140)}; OCR "${SH.vec.ocr?.leaks.map((l) => l.text).join('|')}")`);
check(SH.img.ok, `vector: same file exports fine as Image only (${SH.img.issues.join('; ') || 'no issues'})`);
check(/HiddenTextError/.test(SH.hidden), `vector: invisible text not lined up with the boxes is refused ("${SH.hidden}")`);
check(SH.both.ok, `vector: invisible text fully under boxes is removed and exports (${SH.both.issues.join('; ') || 'no issues'})`);

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

// ---------- Scanned names whose words the text detector may split ("Tan Chee" + "Kin") ----------
{
  const rows = [['Tan Chee', 'Kin', 0, 30], ['Tan Chee', 'Kin', 4, 40], ['Tan Chee', 'Kin', 8, 25], ['Tan Chee', 'Kin', 0, 60], ['Name: Tan', 'Chee Kin', 0, 35]];
  const img = await page.evaluate(async (rows) => {
    const c = document.createElement('canvas'); c.width = 1654; c.height = 2339; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '30px serif';
    const ends = [];
    rows.forEach(([a, b, dy, gap], i) => {
      g.fillText(a, 150, 200 + i * 60);
      const x = 150 + g.measureText(a).width + gap;
      g.fillText(b, x, 200 + i * 60 + dy);
      ends.push((x + g.measureText(b).width) * 595 / 1654); // right end of the name, in points
    });
    const bl = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return { jpeg: Array.from(new Uint8Array(await bl.arrayBuffer())), ends };
  }, rows);
  const d = await PDFDocument.create(); const p = d.addPage([595, 842]);
  p.drawImage(await d.embedJpg(Uint8Array.from(img.jpeg)), { x: 0, y: 0, width: 595, height: 842 });
  const hits = await page.evaluate(async (b) => {
    const T = window.__umbraTest; await T.load(new Uint8Array(b));
    return (await T.detect(['name'])).map((h) => ({ text: h.text, x1: Math.max(...h.rects.map((r) => r.x + r.w)), y: h.rects[0].y }));
  }, Array.from(await d.save()));
  hits.sort((a, b) => a.y - b.y);
  rows.forEach((_, i) => check(hits[i]?.text === 'Tan Chee Kin' && hits[i].x1 >= img.ends[i] - 1, `scanned name with a split line ${i + 1}: "${hits[i]?.text}" covers the whole name (${Math.round(hits[i]?.x1 ?? 0)} >= ${Math.round(img.ends[i])})`));
}

// Settings → "Always redact" on a scanned page (OCR): any case, across a line break, whole words only.
{
  const img = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1654; c.height = 2339; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '30px serif';
    ['Agreement signed by TAN CHEE', 'KIN as the buyer of the unit.', 'Office: Kuala Lumpur Sentral', 'Lumpurville Holdings is unrelated.'].forEach((t, i) => g.fillText(t, 150, 200 + i * 60));
    const bl = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return Array.from(new Uint8Array(await bl.arrayBuffer()));
  });
  const d = await PDFDocument.create(); const p = d.addPage([595, 842]);
  p.drawImage(await d.embedJpg(Uint8Array.from(img)), { x: 0, y: 0, width: 595, height: 842 });
  const hits = await page.evaluate(async (b) => {
    const T = window.__umbraTest; await T.load(new Uint8Array(b));
    T.setAlways(['tan chee kin', 'Kuala Lumpur', 'Lumpur']);
    const h = (await T.detect([])).map((x) => ({ label: x.label, text: x.text.replace(/\s+/g, ' '), boxes: x.rects.length }));
    T.setAlways([]);
    return h;
  }, Array.from(await d.save()));
  const texts = hits.filter((h) => h.label === 'Always redact').map((h) => h.text).sort();
  check(JSON.stringify(texts) === '["Kuala Lumpur","TAN CHEE KIN"]', `always redact (scanned): name split over two lines and the place found, not inside "Lumpurville" (${JSON.stringify(hits)})`);
}

// Settings → English + 中文: a scanned page in Simplified and Traditional Chinese (with English) is read, labelled
// Chinese names and addresses are found, and the copy-ready export keeps the Chinese text searchable.
{
  const lines = ['租赁合约 Tenancy Agreement', '姓名：陈志强', '地址：吉隆坡甲洞路十二号', '繁體中文：臺灣銀行帳戶', '公开内容 Public line stays'];
  const img = await page.evaluate(async (lines) => {
    const c = document.createElement('canvas'); c.width = 1654; c.height = 2339; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '40px "WenQuanYi Zen Hei", "Noto Sans CJK SC", sans-serif';
    lines.forEach((t, i) => g.fillText(t, 150, 200 + i * 80));
    const bl = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return Array.from(new Uint8Array(await bl.arrayBuffer()));
  }, lines);
  const d = await PDFDocument.create(); const p = d.addPage([595, 842]);
  p.drawImage(await d.embedJpg(Uint8Array.from(img)), { x: 0, y: 0, width: 595, height: 842 });
  const r = await page.evaluate(async (b) => {
    const T = window.__umbraTest;
    T.setOcrLang('ch');
    try {
      await T.load(new Uint8Array(b));
      const text = await T.pageText(0);
      const found = (await T.search('臺灣銀行')).length;
      const hits = (await T.detect(['name', 'address'])).map((h) => ({ label: h.label, text: h.text }));
      T.applyAll();
      const ex = await T.export({ dpi: 200, searchable: true }, true);
      return { text, hits, found, ok: ex.report.ok, issues: ex.report.issues, raw: await T.text(ex.bytes, true) };
    } finally { T.setOcrLang('en'); }
  }, Array.from(await d.save()));
  const flat = r.text.replace(/\s+/g, '');
  // Spaces between English words on a line that also has Chinese can be lost with this model ("PublicLine").
  check(['陈志强', '甲洞路', '臺灣銀行帳戶', '公开内容', 'Publiclinestays', 'TenancyAgreement'].every((w) => flat.includes(w)), `Chinese OCR: Simplified + Traditional read (${JSON.stringify(r.text)})`);
  check(r.hits.some((h) => h.label === 'Name' && h.text === '陈志强') && r.hits.some((h) => h.label === 'Address' && h.text.includes('吉隆坡')), `Chinese OCR: labelled name and address found (${JSON.stringify(r.hits)})`);
  check(r.found === 1, `Chinese OCR: Find "臺灣銀行" (${r.found})`);
  check(r.ok && !r.raw.includes('陈志强') && !r.raw.includes('吉隆坡') && r.raw.replace(/\s+/g, '').includes('繁體中文：臺灣銀行帳戶') && r.raw.includes('公开内容'),
    `Chinese OCR: copy-ready export verified, Chinese text searchable, redacted name gone (${r.issues.join('; ') || 'no issues'}; ${JSON.stringify(r.raw)})`);
}

// ---------------- Split ----------------
{
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 5; i++) {
    const p = d.addPage(i === 3 ? [595, 842] : [842, 595]); // page 3: a single portrait page among spreads
    p.drawText(`LEFT${i}`, { x: 60, y: 300, size: 28, font: f });
    if (i !== 3) p.drawText(`RIGHT${i}`, { x: 500, y: 300, size: 28, font: f });
  }
  d.setTitle('Split secret title');
  const src = await d.save();
  const r = await page.evaluate(async (arr) => {
    const T = window.__umbraTest;
    await T.load(new Uint8Array(arr), 'book.pdf');
    const every = await T.split({ mode: 'every', every: 1 });
    const ranges = await T.split({ mode: 'ranges', ranges: '1-2, 4-' });
    const [halves] = await T.split({ mode: 'half', cut: 'lr', widerOnly: true });
    const [rtl] = await T.split({ mode: 'half', cut: 'lr', rtl: true, widerOnly: false });
    const pageTexts = async (b) => (await T.text(new Uint8Array(b))).trim().split('\n').map((l) => l.trim());
    let badRange = '';
    try { await T.split({ mode: 'ranges', ranges: '4-2' }); } catch (e) { badRange = e.message; }
    return {
      every: await Promise.all(every.map(async (p) => ({ label: p.label, text: await pageTexts(p.bytes) }))),
      ranges: ranges.map((p) => p.label),
      halves: await pageTexts(halves.bytes), halvesSize: halves.bytes.length,
      rtl: (await pageTexts(rtl.bytes)).slice(0, 2),
      badRange,
      bytes: every[0].bytes,
    };
  }, Array.from(src));
  check(r.every.length === 5 && r.every.every((p, i) => p.text.length === 1 && p.text[0].includes(`LEFT${i + 1}`)) && r.every[0].label === 'p1',
    `split every page: 5 one-page files in order (${r.every.map((p) => p.label).join(', ')})`);
  check(JSON.stringify(r.ranges) === '["p1-2","p4-5"]', `split ranges "1-2, 4-": ${JSON.stringify(r.ranges)}`);
  check(JSON.stringify(r.halves) === JSON.stringify(['LEFT1', 'RIGHT1', 'LEFT2', 'RIGHT2', 'LEFT3', 'LEFT4', 'RIGHT4', 'LEFT5', 'RIGHT5']),
    `cut in half, wide pages only: each half shows its own side, the portrait page stays whole (${r.halves.join(' ')})`);
  check(r.halvesSize < src.length * 1.6 + 4000, `cut in half: halves share the page content (${r.halvesSize} bytes from ${src.length})`);
  check(JSON.stringify(r.rtl) === '["RIGHT1","LEFT1"]', `cut in half, right page first: ${r.rtl.join(' ')}`);
  check(/backwards/.test(r.badRange), `bad range is refused: "${r.badRange}"`);
  check(!/Split secret title/.test(Buffer.from(r.bytes).toString('latin1')), 'split parts carry no document metadata');
}

// Export → Split: the redacted, checked copy is split, never the original. Saved through the folder picker.
{
  let parts = await page.evaluate(async (arr) => {
    const T = window.__umbraTest;
    await T.load(new Uint8Array(arr), 'hr.pdf');
    const h = T.sizes()[0].height;
    T.setBoxes(T.sizes().map(() => [{ x: 66, y: h - 728, w: 260, h: 36 }]));
    const saved = [];
    window.showDirectoryPicker = async () => ({
      getFileHandle: async (name, o) => {
        if (!o?.create) throw new DOMException('missing', 'NotFoundError');
        return { createWritable: async () => ({ write: async (b) => saved.push({ name, bytes: Array.from(new Uint8Array(b.buffer ?? b)) }), close: async () => {} }) };
      },
    });
    const exportSplit = () => {
      document.querySelector('#btn-export').click();
      document.querySelector('#sp-mode [data-m="every"]').click();
      document.querySelector('#x-go').click();
    };
    exportSplit();
    for (let t = 0; t < 600 && !document.querySelector('#r-save'); t++) await new Promise((r) => setTimeout(r, 100));
    document.querySelector('#r-save')?.click();
    for (let t = 0; t < 100 && saved.length < 2; t++) await new Promise((r) => setTimeout(r, 100));
    // Split again with the same boxes: the checked redacted copy is reused, not made again.
    T.setAdvanced(true);
    exportSplit();
    for (let t = 0; t < 600 && !document.querySelector('#r-save'); t++) await new Promise((r) => setTimeout(r, 100));
    const again = document.querySelector('#modal').textContent;
    document.querySelector('#r-close').click();
    T.setAdvanced(false);
    delete window.showDirectoryPicker;
    return { files: saved, again };
  }, Array.from(fixture));
  check(/Redacted copy reused/.test(parts.again), 'splitting again with the same boxes reuses the checked redacted copy');
  parts = parts.files;
  check(parts.length === 2 && parts[0].name === 'hr-redacted-p1.pdf', `split with boxes saves the redacted copy's pages to a folder (${parts.map((p) => p.name).join(', ')})`);
  check(parts.every((p) => !/SECRET|123-45-6789|Jane Leak|evil\.example|notes\.txt/.test(Buffer.from(p.bytes).toString('latin1'))), 'split parts of a redacted file hold no secret strings');
}

// Image only + searchable on a scan with the scanner's own invisible text layer: the layer is reused on pages
// without boxes (no OCR), but only words with printed ink under them. Pages with boxes are read again.
{
  const scan = await makeScanFixture();
  const src = await PDFDocument.load(scan.bytes);
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const pg of await d.copyPages(src, [0, 0])) {
    const p = d.addPage(pg);
    p.drawRectangle({ x: 300, y: 80, width: 200, height: 40, color: rgb(0, 0, 0) }); // a drawn bar, not a box
    const f = p.node.newFontDictionary('FH', font.ref);
    const put = (t, x, y, size) => p.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(f, size),
      setTextRenderingMode(TextRenderingMode.Invisible), moveText(x, y), showText(font.encodeText(t)), endText(), popGraphicsState());
    put('Public line stays visible', 72, 792 - 72, 16.3); // lines up with the printed line
    SCAN_LINES.forEach(([pre, val], j) => put(pre + val, 72, 792 - (220 + 70 * j) * 72 / 150, 16.3));
    put('GHOSTWORD', 100, 40, 14);   // over blank paper
    put('BARWORD', 320, 92, 14);     // under the drawn black bar
  }
  const r = await page.evaluate(async ([arr, box]) => {
    const T = window.__umbraTest;
    await T.load(new Uint8Array(arr));
    T.setBoxes([[], [box]]);
    T.resetOcrStats();
    const t0 = performance.now();
    const s = await T.export({ dpi: 200, searchable: true }, false);
    const ms = Math.round(performance.now() - t0);
    const pages = (await T.text(s.bytes)).split('\n');
    const log = T.ocrStats().log.filter((l) => /^export page/.test(l));
    // After Auto Detect / search has read the pages, the page with boxes reuses that read of its picture.
    await T.pageText(0); await T.pageText(1);
    T.resetOcrStats();
    const s2 = await T.export({ dpi: 200, searchable: true }, false);
    const pages2 = (await T.text(s2.bytes)).split('\n');
    return { ok: s.report.ok, issues: s.report.issues, pages, log, ms,
      ok2: s2.report.ok, pages2, log2: T.ocrStats().log.filter((l) => /^export page/.test(l)) };
  }, [Array.from(await d.save()), scan.expected[0].rect]);
  const [p1, p2] = r.pages.length >= 2 ? r.pages : [r.pages.join(''), ''];
  check(r.ok, `text layer reuse: export verified (${r.issues.join('; ') || 'no issues'}, ${r.ms} ms)`);
  check(/text layer reused/.test(r.log[0] ?? '') && /read now/.test(r.log[1] ?? ''), `text layer reused on the page without boxes, page with boxes read again (${r.log.join(' | ')})`);
  check(/Public line stays visible/.test(p1) && /ahmad@example\.com/.test(p1), 'text layer reuse: printed words stay searchable');
  check(!/GHOSTWORD|BARWORD/.test(r.pages.join(' ')), 'text layer reuse: words over blank paper or under a drawn bar are dropped');
  check(!/850505/.test(p2) && /Public/.test(p2), 'page with boxes: boxed value absent, rest read by OCR');
  check(r.ok2 && /picture read before/.test(r.log2[1] ?? '') && /text layer reused/.test(r.log2[0] ?? ''), `after the pages were read, the page with boxes reuses that OCR (${r.log2.join(' | ')})`);
  check(!/850505/.test(r.pages2[1] ?? '') && /Public line/.test(r.pages2[1] ?? '') && !/GHOSTWORD|BARWORD/.test(r.pages2.join(' ')), `reused OCR on the page with boxes: boxed value absent, rest searchable ("${(r.pages2[1] ?? '').slice(0, 80)}")`);
}

// Pages render without animation frames: phones with a variable refresh rate fire them at 1-10 Hz while the
// screen is still, which made exports crawl until the user touched the screen.
{
  const r = await page.evaluate(async (arr) => {
    const T = window.__umbraTest;
    await T.load(new Uint8Array(arr));
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0; // frames never come
    try {
      const t0 = performance.now();
      const out = await Promise.race([T.export({ dpi: 150 }, false), new Promise((r) => setTimeout(() => r(null), 20000))]);
      return { done: !!out, ms: Math.round(performance.now() - t0) };
    } finally { window.requestAnimationFrame = raf; }
  }, Array.from(fixture));
  check(r.done, `export finishes without animation frames (${r.ms} ms)`);
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);

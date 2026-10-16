// ID-card recall benchmark on hard FAKE scenes (tests/fixtures-idcards.mjs).
// Usage: node tests/bench-cards.mjs [--only id,id] [--dump dir] [--json file] [--assert]
//   --assert: exit 1 if recall drops below the floors in FLOORS, or a redacted export still shows IC data.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { VARIANTS, PEOPLE, expected, drawScene, makeScenePdf } from './fixtures-idcards.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('--only')?.split(',');
const dump = arg('--dump'), jsonOut = arg('--json'), assert = process.argv.includes('--assert');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(root)) throw 0;
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => !!window.__umbraTest);

const ALL = ['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company', 'tin', 'name', 'address'];
const dig = (s) => s.replace(/[^\d]/g, '');
const norm = (s) => s.replace(/\s+/g, ' ').trim().toUpperCase();
const rows = [];
/** Levenshtein distance. */
const lev = (a, b) => {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
};
/** Is `want` inside `hay` with at most `frac` of its characters misread (OCR slips still get redacted)? */
const fuzzyIn = (want, hay, frac = 0.15) => {
  const k = Math.floor(want.length * frac);
  if (hay.includes(want)) return true;
  for (let i = 0; i + want.length - k <= hay.length; i++) for (let L = want.length - k; L <= want.length + k; L++) {
    if (i + L <= hay.length && lev(want, hay.slice(i, i + L)) <= k) return true;
  }
  return false;
};
if (dump) await mkdir(dump, { recursive: true });

for (const v of VARIANTS.filter((x) => !only || only.includes(x.id))) {
  const img = await drawScene(page, v);
  if (dump) await writeFile(`${dump}/${v.id}.jpg`, Buffer.from(img.jpeg));
  const pdf = await makeScenePdf(PDFDocument, img, v);
  const R = await page.evaluate(async ({ pdf, ALL }) => {
    const T = window.__umbraTest;
    await T.load(new Uint8Array(pdf));
    T.resetOcrStats();
    const t0 = performance.now();
    const hits = (await T.detect(ALL)).map(({ text, label }) => ({ text, label }));
    const ms = performance.now() - t0, stats = T.ocrStats();
    const ocr = await T.pageText(0);
    T.applyAll();
    const ex = await T.export({ dpi: 200 }, false, 'image');
    await T.load(ex.bytes);
    const after = await T.pageText(0);
    return { hits, ms, ocr, after, stats };
  }, { pdf: Array.from(pdf), ALL });

  const exp = expected(v);
  const res = { id: v.id, note: v.note, ms: Math.round(R.ms), stats: R.stats, nric: [0, 0], name: [0, 0], addr: [0, 0], leak: [] };
  const nricHits = R.hits.filter((h) => h.label.includes('NRIC')).map((h) => dig(h.text));
  const used = new Set();
  for (const e of exp) {
    if (e.kind === 'nric') {
      res.nric[1]++;
      // Found = read with ≤10% slips, or the start (≥8 digits) when glare hid the end (the box spans the full width; the leak check confirms).
      const k = nricHits.findIndex((h, i) => !used.has(i) && (fuzzyIn(dig(e.value), h, 0.1) || (h.length >= 8 && dig(e.value).startsWith(h))));
      if (k >= 0) { used.add(k); res.nric[0]++; }
    } else if (e.kind === 'name') {
      res.name[1]++;
      if (R.hits.some((h) => h.label.includes('Name') && fuzzyIn(norm(e.value), norm(h.text)) && norm(h.text).length <= norm(e.value).length + 4)) res.name[0]++;
    } else {
      res.addr[1] += e.value.length;
      const addr = R.hits.filter((h) => h.label.includes('Address')).map((h) => norm(h.text)).join(' | ');
      res.addr[0] += e.value.filter((l) => fuzzyIn(norm(l), addr, 0.2)).length;
    }
  }
  // Leak check: re-OCR the redacted export with the same pipeline; no IC number or name may still be readable.
  const afterDig = dig(R.after), afterTxt = norm(R.after);
  for (const c of v.cards) {
    const p = PEOPLE[c.who];
    if (afterDig.includes(dig(p.nric).slice(0, 8)) || afterDig.includes(dig(p.nric).slice(4))) res.leak.push('nric');
    if (c.side === 'front' && p.name.some((n) => afterTxt.includes(norm(n)))) res.leak.push('name');
  }
  res.hits = R.hits.map((h) => `${h.label}: ${norm(h.text)}`);
  res.ocr = R.ocr;
  rows.push(res);
  const f = (x) => `${x[0]}/${x[1]}`;
  console.log(`${v.id.padEnd(15)} NRIC ${f(res.nric)}  name ${f(res.name)}  addr ${f(res.addr).padEnd(5)} ${String(res.ms).padStart(6)} ms  ${res.stats.cards}c/${res.stats.passes}p${res.stats.rotated ? '/rot' : ''}  ${res.leak.length ? 'LEAK ' + res.leak.join(',') : ''}`);
  if (process.env.PROFILE) console.log('   ' + R.stats.log.join('\n   '));
  if (process.env.VERBOSE) console.log('   hits:', res.hits.join(' || '), '\n   ocr:', JSON.stringify(R.ocr).slice(0, 600));
}

const sum = (k) => rows.reduce((a, r) => [a[0] + r[k][0], a[1] + r[k][1]], [0, 0]);
const pct = (x) => (x[1] ? Math.round((100 * x[0]) / x[1]) : 100) + '%';
console.log(`TOTAL           NRIC ${pct(sum('nric'))}  name ${pct(sum('name'))}  addr ${pct(sum('addr'))}  ${rows.reduce((a, r) => a + r.ms, 0)} ms`);
if (jsonOut) await writeFile(jsonOut, JSON.stringify(rows, null, 1));
await browser.close(); server.close();

// Floors for --assert (CI): set from the measured results; raise as recall improves.
const FLOORS = { nric: 0.85, name: 0.7, addr: 0.8 };
if (assert) {
  let bad = 0;
  for (const k of ['nric', 'name', 'addr']) { const s = sum(k); if (s[0] / s[1] < FLOORS[k]) { console.log(`FAIL  card recall ${k} ${pct(s)} < ${FLOORS[k] * 100}%`); bad++; } }
  for (const r of rows) if (r.leak.length) { console.log(`FAIL  ${r.id}: still readable after redaction: ${r.leak.join(',')}`); bad++; }
  if (!bad) console.log('PASS  ID-card bench');
  process.exit(bad ? 1 : 0);
}

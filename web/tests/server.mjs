// Desktop server test: access rules, headers, native OCR and the desktop host (drop to open, Esc, settings).
// Usage: npm test (after npm run build:core && npm run build). Browser: CHROMIUM_PATH, else Edge on Windows.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(resolve(here, '../../core/package.json'))('playwright-core');
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `: ${info}` : ''}`); if (!ok) failed++; };

// ---------- server ----------
const srv = spawn(process.execPath, [resolve(here, '../dist/server.mjs'), '--port', '0', '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
const base = await new Promise((ok, fail) => {
  srv.stdout.on('data', (c) => { out += c; const m = /running at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) ok(m[1]); });
  srv.on('exit', (code) => fail(new Error(`server exited (${code}): ${out}`)));
});
const port = new URL(base).port;

try {
  const home = await fetch(base);
  check('serves the app', home.status === 200 && /Umbra PDF/.test(await home.text()));
  check('cross-origin isolated headers', home.headers.get('cross-origin-opener-policy') === 'same-origin' && home.headers.get('cross-origin-embedder-policy') === 'require-corp');
  check('CSP header', /default-src 'none'/.test(home.headers.get('content-security-policy') ?? '') && /frame-ancestors 'none'/.test(home.headers.get('content-security-policy') ?? ''));
  check('no caching', home.headers.get('cache-control') === 'no-store');
  check('path outside the app refused', (await fetch(`${base}..%2f..%2fpackage.json`)).status === 404);

  // Node's fetch won't let us set Host; a raw request does.
  const raw = (path, headers = {}, method = 'GET', body) => new Promise((ok) => {
    import('node:http').then(({ request }) => {
      const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => { res.resume(); ok(res.statusCode); });
      r.on('error', () => ok(0));
      r.end(body);
    });
  });
  check('other Host header refused (DNS rebinding)', (await raw('/api/caps', { host: `evil.example:${port}` })) === 403);
  check('other site refused', (await raw('/api/ocr', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'text/plain' }, 'POST', '{"id":1,"kind":"warm"}')) === 403);
  check('cross-site fetch refused', (await raw('/api/caps', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' })) === 403);

  const caps = await (await fetch(`${base}api/caps`)).json();
  check('caps', caps.app === 'umbra-pdf' && caps.native === true, JSON.stringify(caps));
  const warm = await (await fetch(`${base}api/ocr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":5,"kind":"warm"}' })).json();
  check('engine loads', warm.ok && warm.id === 5, JSON.stringify(warm));
  const warmCh = await (await fetch(`${base}api/ocr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":6,"kind":"warm","lang":"ch"}' })).json();
  check('Chinese engine loads', warmCh.ok && warmCh.lang === 'ch', JSON.stringify(warmCh));
  await fetch(`${base}api/ocr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":7,"kind":"warm","lang":"en"}' });
  const bad = new ArrayBuffer(16);
  new Int32Array(bad).set([9, 4000, 4000, 640]);
  const badR = await (await fetch(`${base}api/ocr`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bad })).json();
  check('short image rejected', !badR.ok && badR.id === 9, JSON.stringify(badR));

  // ---------- browser ----------
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH }
    : process.platform === 'win32' ? { channel: 'msedge' } : { executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], external = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.hostname !== '127.0.0.1') { external.push(u.href); return r.abort(); } return r.continue(); });
  await page.goto(base);
  await page.waitForFunction(() => !!window.__umbraTest);
  check('page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));
  check('drop hint on the start screen', await page.isVisible('.drop-hint'));

  // Drop a scanned PDF on the window: it opens.
  const scanned = await readFile(resolve(here, '../../samples/umbra-test-scanned.pdf'));
  await page.evaluate(async (a) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(a)], 'dropped.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
  }, Array.from(scanned));
  await page.waitForFunction(() => window.__umbraTest.state().hasDoc, null, { timeout: 15000 });
  check('dropped PDF opens', true, await page.textContent('#docname'));

  // Scanned page read by the server's native engine.
  const r = await page.evaluate(async () => {
    const T = window.__umbraTest;
    T.resetOcrStats();
    const t0 = performance.now();
    const hits = await T.detect(['nric', 'phone', 'email', 'name', 'address']);
    return { ms: Math.round(performance.now() - t0), labels: hits.map((h) => h.label), log: T.ocrStats().log };
  });
  const nativeLines = r.log.filter((l) => /native/.test(l));
  check('OCR runs natively on the server', nativeLines.length > 0, nativeLines[0] ?? r.log.slice(0, 3).join(' | '));
  check('scanned page: details found', r.labels.length > 0, `${r.labels.length} hit(s) in ${r.ms} ms`);

  // Esc = Android Back: closes the panel.
  check('panel open', (await page.evaluate(() => window.__umbraTest.state().panel)) === 'detect');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc closes the panel', (await page.evaluate(() => window.__umbraTest.state().panel)) == null);

  // Esc again leaves the document (nothing redacted yet, so no question), like Back on Android.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__umbraTest.state().hasDoc, null, { timeout: 5000 }).catch(() => {});
  check('Esc leaves the document', !(await page.evaluate(() => window.__umbraTest.state().hasDoc)));

  // Android-only setting hidden.
  await page.click('#btn-settings', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const settings = await page.textContent('#sheet');
  check('settings open', /Settings/.test(settings ?? ''));
  check('"Recent apps" setting hidden', !/Recent apps/.test(settings ?? ''));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc closes the dialog', !(await page.evaluate(() => window.__umbraTest.state().modal)));

  check('no network requests outside this computer', external.length === 0, external.join(', '));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
} finally {
  srv.kill();
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL SERVER CHECKS PASSED');
process.exit(failed ? 1 : 0);

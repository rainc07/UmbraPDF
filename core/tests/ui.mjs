// UI gesture test: pinch zoom, double-tap zoom, Ctrl+wheel, no stray boxes. Uses real touch events via CDP.
// Usage: npm run build && node tests/ui.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
let failed = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };

const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(root)) throw 0;
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }); res.end(body);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
}).listen(0);

const d = await PDFDocument.create();
const font = await d.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 4; i++) { const p = d.addPage([612, 792]); p.drawText(`Page ${i + 1} sample text`, { x: 72, y: 700, size: 18, font }); }
const pdf = await d.save();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.evaluate(async (a) => { await window.__umbraTest.load(new Uint8Array(a)); }, Array.from(pdf));
await page.waitForTimeout(400);
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 }); // splash covers the app at start
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
const T = (fn, ...a) => page.evaluate(([f, a]) => window.__umbraTest[f](...a), [fn, a]);
const vb = await page.evaluate(() => { const r = document.querySelector('#viewer').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const cx = vb.x + vb.w / 2, cy = vb.y + vb.h * 0.4;

async function pinchBy(f, x = cx, y = cy, gap0 = 60) {
  await touch('touchStart', [[x - gap0, y], [x + gap0, y]]);
  for (let k = 1; k <= 8; k++) { const g = gap0 * (1 + (f - 1) * k / 8); await touch('touchMove', [[x - g, y], [x + g, y]]); }
  await touch('touchEnd', []);
  await page.waitForTimeout(350);
}

for (const mode of ['draw', 'pan']) {
  await T('setMode', mode);
  const z0 = await T('zoom');
  const a0 = await T('pointAt', cx, cy);
  const boxes0 = (await T('boxes')).flat().length;
  await pinchBy(2);
  const z1 = await T('zoom');
  const a1 = await T('pointAt', cx, cy);
  check(Math.abs(z1 / z0 - 2) < 0.06, `${mode}: pinch out doubles zoom (${z0.toFixed(3)} → ${z1.toFixed(3)})`);
  check(a1.i === a0.i && Math.hypot(a1.x - a0.x, a1.y - a0.y) < 3, `${mode}: point under fingers stays put (${JSON.stringify(a0)} → ${JSON.stringify(a1)})`);
  check((await T('boxes')).flat().length === boxes0, `${mode}: pinch draws no box`);
  await pinchBy(0.5);
  const z2 = await T('zoom');
  check(Math.abs(z2 / z0 - 1) < 0.06, `${mode}: pinch in restores zoom (${z2.toFixed(3)})`);
}

// Canvas re-rendered sharp after the pinch.
await pinchBy(1.8);
await page.waitForTimeout(800);
const sharp = await page.evaluate(() => {
  const z = window.__umbraTest.zoom();
  const el = [...document.querySelectorAll('.page')].find((p) => { const r = p.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
  const c = el.querySelector('canvas');
  return { cw: c.width, want: Math.round(612 * z * Math.min(devicePixelRatio, 2)) };
});
check(Math.abs(sharp.cw - sharp.want) <= 2, `re-rendered at new zoom after lifting fingers (${sharp.cw} vs ${sharp.want} px)`);

// Double tap toggles fit <-> 2.5x fit, both modes; a single tap does nothing.
const fit = await T('fitZoom');
await T('setMode', 'pan');
await page.evaluate((f) => window.__umbraTest.setZoomForTest?.(f), fit);
const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); };
for (const mode of ['pan', 'draw']) {
  await T('setMode', mode);
  const z0 = await T('zoom');
  await tap(cx, cy); await page.waitForTimeout(450);
  check(Math.abs((await T('zoom')) - z0) < 1e-6, `${mode}: single tap leaves zoom alone`);
  await tap(cx, cy); await page.waitForTimeout(80); await tap(cx + 3, cy + 2); await page.waitForTimeout(300);
  const zA = await T('zoom');
  await tap(cx, cy); await page.waitForTimeout(80); await tap(cx, cy); await page.waitForTimeout(300);
  const zB = await T('zoom');
  check((Math.abs(zA - fit * 2.5) < 0.01 && Math.abs(zB - fit) < 0.01) || (Math.abs(zA - fit) < 0.01 && Math.abs(zB - fit * 2.5) < 0.01),
    `${mode}: double tap toggles fit/2.5x (${zA.toFixed(3)}, ${zB.toFixed(3)}; fit ${fit.toFixed(3)})`);
  check((await T('boxes')).flat().length === 0, `${mode}: taps draw no box`);
}

// One finger in draw mode still draws a box.
await T('setMode', 'draw');
await touch('touchStart', [[cx - 40, cy - 20]]);
for (let k = 1; k <= 5; k++) await touch('touchMove', [[cx - 40 + 16 * k, cy - 20 + 8 * k]]);
await touch('touchEnd', []);
await page.waitForTimeout(100);
check((await T('boxes')).flat().length === 1, 'draw: one-finger drag still draws a box');

// Ctrl + wheel (trackpad pinch on desktop)
const zw0 = await T('zoom');
await page.mouse.move(cx, cy);
await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
await page.waitForTimeout(300);
check((await T('zoom')) > zw0 * 1.3, `Ctrl+wheel zooms in (${zw0.toFixed(3)} → ${(await T('zoom')).toFixed(3)})`);

// Settings saved by 1.0.0 (no TIN detector yet): the new detector starts on, a detector the user turned off stays off.
const key = 'umbra.prefs.v1'; // platform/browser.ts PREFS_KEY
await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ theme: 'system', detect: { enabled: ['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company', 'name'], custom: [] } })), key);
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
const dp = await page.evaluate(() => window.__umbraTest.detectPrefs());
check(dp.enabled.includes('tin') && !dp.enabled.includes('address'), `update: new TIN detector switched on, user's own choices kept (${dp.enabled.join(',')})`);

check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close(); server.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL UI CHECKS PASSED');
process.exit(failed ? 1 : 0);

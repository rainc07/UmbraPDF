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
// UMBRA_URL: run against another server, e.g. the desktop app's (web/).
await page.goto(process.env.UMBRA_URL ?? `http://127.0.0.1:${server.address().port}/index.html`);
await page.evaluate(async (a) => { await window.__umbraTest.load(new Uint8Array(a)); }, Array.from(pdf));
await page.waitForTimeout(400);
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 }); // splash covers the app at start
check(await page.evaluate(() => window.__umbraTest.mode()) === 'pan', 'a document opens in Scroll mode');
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

// Redacted list follows the page; Undo / Redo / Reset.
{
  const d2 = await PDFDocument.create(); const f2 = await d2.embedFont(StandardFonts.Helvetica);
  const p2 = d2.addPage([612, 792]);
  p2.drawText('Email: siti@example.com', { x: 72, y: 700, size: 14, font: f2 });
  p2.drawText('Phone: 012-345 6789', { x: 72, y: 670, size: 14, font: f2 });
  const r = await page.evaluate(async (a) => {
    const T = window.__umbraTest; await T.load(new Uint8Array(a));
    const out = {};
    await T.detect(['email', 'phone']); T.applyAll();
    const n = () => T.boxes().flat().length, on = () => T.applied().filter((x) => x.on).length;
    out.applied = [n(), on()];
    T.deleteBox(0, 0);                       // remove one auto-detected box by hand
    out.afterDelete = [n(), on()];
    T.undo(); out.afterUndo = [n(), on(), T.canRedo()];
    T.redo(); out.afterRedo = [n(), on()];
    T.reset(); out.afterReset = [n(), on()];
    T.undo(); out.afterResetUndo = [n(), on()];
    out.redoCleared = (T.deleteBox(0, 0), !T.canRedo());
    return out;
  }, Array.from(await d2.save()));
  check(r.applied[0] === 2 && r.applied[1] === 2, `applied: 2 boxes, 2 ticked (${r.applied})`);
  check(r.afterDelete[0] === 1 && r.afterDelete[1] === 1, `deleting a box by hand unticks it in the Redacted list (${r.afterDelete})`);
  check(r.afterUndo[0] === 2 && r.afterUndo[1] === 2 && r.afterUndo[2], `undo restores box and tick, redo available (${r.afterUndo})`);
  check(r.afterRedo[0] === 1 && r.afterRedo[1] === 1, `redo removes it again (${r.afterRedo})`);
  check(r.afterReset[0] === 0 && r.afterReset[1] === 0, `reset removes every box and unticks all (${r.afterReset})`);
  check(r.afterResetUndo[0] === 1 && r.afterResetUndo[1] === 1, `undo after reset brings the boxes back (${r.afterResetUndo})`);
  check(r.redoCleared, 'a new edit clears Redo');
  const ui = await page.evaluate(() => ({
    open: !!document.querySelector('#btn-open'), settingsVisible: getComputedStyle(document.querySelector('#btn-settings')).display !== 'none',
    top: ['#btn-find', '#btn-detect', '#btn-export'].every((id) => document.querySelector('.appbar ' + id)),
    dock: ['#btn-undo', '#btn-redo', '#btn-reset'].every((id) => document.querySelector('.dock ' + id)),
  }));
  check(!ui.open && !ui.settingsVisible && ui.top && ui.dock, `document screen: Find/Auto Detect/Export on top, Undo/Redo/Reset at the bottom, no Open/Settings (${JSON.stringify(ui)})`);
}

// Landscape: side panel 20–45% wide, document beside it, swappable side, start screen doesn't scroll.
{
  await page.setViewportSize({ width: 915, height: 412 });
  await page.waitForTimeout(300);
  const L = await page.evaluate(async () => {
    const T = window.__umbraTest;
    await T.detect(['email']);
    await new Promise((r) => setTimeout(r, 500));
    const st = document.querySelector('.stage').getBoundingClientRect();
    const p = document.querySelector('#panel').getBoundingClientRect(), v = document.querySelector('#viewer').getBoundingClientRect();
    const right = { pw: p.width / st.width, panelRight: Math.abs(p.right - st.right) < 8, viewerEnds: v.right <= p.left + 2 };
    document.querySelector('#panel .side-swap').click();
    await new Promise((r) => setTimeout(r, 450));
    const p2 = document.querySelector('#panel').getBoundingClientRect(), v2 = document.querySelector('#viewer').getBoundingClientRect();
    const left = { panelLeft: Math.abs(p2.left - st.left) < 8, viewerStarts: v2.left >= p2.right - 2 };
    document.querySelector('#panel .side-swap').click();
    return { right, left };
  });
  check(L.right.pw >= 0.2 && L.right.pw <= 0.45 && L.right.panelRight && L.right.viewerEnds, `landscape: side panel on the right, ${Math.round(L.right.pw * 100)}% wide, document beside it`);
  check(L.left.panelLeft && L.left.viewerStarts, 'landscape: panel moves to the left side');
  await page.setViewportSize({ width: 412, height: 860 });
  await page.waitForTimeout(300);
}

// Bottom dock: [Scroll | Redact] at the left edge, [Undo | Redo | Reset] at the right, every button the same size.
for (const [w, h] of [[412, 860], [360, 780], [915, 412]]) {
  await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250);
  const L = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const dock = document.querySelector('.dock'), cs = getComputedStyle(dock);
    const ids = ['#mode-pan', '#mode-draw', '#btn-undo', '#btn-redo', '#btn-reset'];
    return { widths: ids.map((id) => r(id).width), heights: ids.map((id) => r(id).height), xs: ids.map((id) => r(id).left),
      left: r('#mode-seg').left - (r('.dock').left + parseFloat(cs.paddingLeft)), right: (r('.dock').right - parseFloat(cs.paddingRight)) - r('.seg.acts').right,
      rowY: Math.abs(r('#mode-seg').top - r('.seg.acts').top) };
  });
  const same = (a) => Math.max(...a) - Math.min(...a) < 0.6;
  check(same(L.widths) && same(L.heights), `dock ${w}x${h}: all five buttons the same size (${L.widths.map(Math.round)} x ${L.heights.map(Math.round)})`);
  check(Math.abs(L.left) < 1 && Math.abs(L.right) < 1 && L.rowY < 1, `dock ${w}x${h}: mode toggle at the left edge, Undo/Redo/Reset at the right (${L.left.toFixed(1)}, ${L.right.toFixed(1)})`);
  check(L.xs.every((x, i) => !i || x > L.xs[i - 1]), `dock ${w}x${h}: order Scroll, Redact, Undo, Redo, Reset`);
}
await page.setViewportSize({ width: 412, height: 860 }); await page.waitForTimeout(250);
{
  const actsOn = await page.evaluate(() => [...document.querySelectorAll('.dock .acts .tool')].some((b) => b.classList.contains('on') || b.getAttribute('aria-pressed')));
  check(!actsOn, 'Undo/Redo/Reset have no selected state');
  await T('setMode', 'pan');
  const sb = await page.evaluate(() => { const r = document.querySelector('#mode-seg').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
  const swipe = async (from, to) => { await page.mouse.move(from, sb.y); await page.mouse.down(); await page.mouse.move((from + to) / 2, sb.y); await page.mouse.move(to, sb.y); await page.mouse.up(); await page.waitForTimeout(100); };
  await swipe(sb.x + 10, sb.x + sb.w - 10);
  const m1 = await T('mode');
  await swipe(sb.x + sb.w - 10, sb.x + 10);
  const m2 = await T('mode');
  check(m1 === 'draw' && m2 === 'pan', `swiping the mode toggle switches mode (→ ${m1}, ← ${m2})`);
}

// Stop a scan: Back asks first ("Keep going" carries on), Stop ends it; the panel shows a Stop button meanwhile.
{
  const sp = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 1754; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '34px serif';
    for (let i = 0; i < 30; i++) g.fillText(`Line ${i + 1}: Tan Chee Kin, 12 Jalan Ampang, 50450 Kuala Lumpur`, 90, 120 + i * 52);
    const bl = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return Array.from(new Uint8Array(await bl.arrayBuffer()));
  });
  const sd = await PDFDocument.create();
  const img = await sd.embedJpg(Uint8Array.from(sp));
  for (let i = 0; i < 6; i++) sd.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  await page.evaluate(async (a) => { await window.__umbraTest.load(new Uint8Array(a)); }, Array.from(await sd.save()));
  await T('startDetect', ['name', 'address']);
  await page.waitForTimeout(300);
  const stopBtn = await page.evaluate(() => !!document.querySelector('#panel #p-stop'));
  await T('back');
  const asked = await page.evaluate(() => document.querySelector('#sheet h2')?.textContent);
  await page.click('#st-no'); await page.waitForTimeout(250);
  const still = await T('scanning');
  await T('back'); await page.click('#st-yes');
  await page.evaluate(() => window.__scan);
  const after = await page.evaluate(() => ({ scanning: window.__umbraTest.scanning(), status: document.querySelector('#p-status')?.textContent ?? '', stop: !!document.querySelector('#p-stop') }));
  check(stopBtn && asked === 'Stop Auto Detect?', `scan: Stop button shown, Back asks "${asked}"`);
  check(still, 'scan: "Keep going" carries on');
  check(!after.scanning && /^Stopped/.test(after.status) && !after.stop, `scan: Stop ends it (${after.status})`);
}

// Closing the panel during a scan: Auto Detect stays usable, reopening shows progress and Stop, results come back.
{
  await T('startDetect', ['name', 'address']);
  await page.waitForTimeout(300);
  await page.click('#p-close'); await page.waitForTimeout(350);
  const closed = await page.evaluate(() => ({ detect: document.querySelector('#btn-detect').disabled, find: document.querySelector('#btn-find').disabled, panel: window.__umbraTest.state().panel }));
  await page.click('#btn-detect'); await page.waitForTimeout(200);
  const reopened = await page.evaluate(() => ({ stop: !!document.querySelector('#p-stop'), status: document.querySelector('#p-status')?.textContent ?? '' }));
  await page.click('#p-close'); await page.waitForTimeout(100);
  await page.evaluate(() => window.__scan);
  const end = await page.evaluate(() => ({ panel: window.__umbraTest.state().panel, items: document.querySelectorAll('#p-results li').length, stop: !!document.querySelector('#p-stop') }));
  check(!closed.detect && closed.find && closed.panel === null, `scan: with the panel closed, Auto Detect stays usable (Find waits) (${JSON.stringify(closed)})`);
  check(reopened.stop && /page/i.test(reopened.status), `scan: reopening shows progress and Stop ("${reopened.status}")`);
  check(end.panel === 'detect' && end.items > 0 && !end.stop, `scan: results open in the panel when it finishes (${JSON.stringify(end)})`);
}

// Back closes the export result ("Safe to share").
{
  await T('showResult');
  const open = (await T('state')).modal;
  await T('back'); await page.waitForTimeout(250);
  check(open && !(await T('state')).modal, 'Back closes the "Safe to share" result');
}

// Settings saved by 1.0.0 (no TIN detector yet): the new detector starts on, a detector the user turned off stays off.
const key = 'umbra.prefs.v1'; // platform/browser.ts PREFS_KEY
await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ theme: 'system', detect: { enabled: ['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company', 'name'], custom: [] } })), key);
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
for (const [w, h] of [[412, 860], [915, 412]]) {
  await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(200);
  const sc = await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight, document.querySelector('#viewer').scrollHeight, document.querySelector('#viewer').clientHeight]);
  check(sc[0] <= sc[1] && sc[2] <= sc[3], `start screen ${w}x${h}: nothing scrolls (${sc})`);
}
const dp = await page.evaluate(() => window.__umbraTest.detectPrefs());
check(dp.enabled.includes('tin') && !dp.enabled.includes('address'), `update: new TIN detector switched on, user's own choices kept (${dp.enabled.join(',')})`);


// Settings → "Always redact": add (no duplicates, any case), persists, and Auto Detect finds the words whole-word across line breaks.
check(Array.isArray(dp.always) && dp.always.length === 0, `update: older settings get an empty "Always redact" list (${JSON.stringify(dp.always)})`);
await page.click('#btn-settings'); await page.waitForTimeout(250);
for (const w of ['Tan  Ah Kow', 'tan ah kow', 'Ali', '   ']) { await page.fill('#s-aw', w); await page.press('#s-aw', 'Enter'); }
const awUi = await page.evaluate(() => [...document.querySelectorAll('#s-aw-list .tl')].map((e) => e.textContent));
check(JSON.stringify(awUi) === '["Tan Ah Kow","Ali"]', `always redact: added, tidied, duplicates and blanks skipped (${JSON.stringify(awUi)})`);
await page.fill('#s-aw', 'Remove Me'); await page.press('#s-aw', 'Enter');
await page.click('#s-aw-list [data-rmaw="2"]');
// Settings → Text in scans: one switch per language, English on by default, the last one can't be switched off.
const langs = () => page.evaluate(() => [...document.querySelectorAll('[data-lang]')].map((x) => `${x.dataset.lang}:${x.checked}`).join(' '));
check(await langs() === 'en:true zh:false', `text in scans: English on, 中文 off by default (${await langs()})`);
await page.click('[data-lang="en"]'); await page.waitForTimeout(100);
check(await langs() === 'en:true zh:false' && await page.isVisible('#s-lang-hint'), `text in scans: the last language stays on (${await langs()})`);
await page.click('[data-lang="zh"]'); await page.click('[data-lang="en"]'); await page.waitForTimeout(100);
check(await langs() === 'en:false zh:true', `text in scans: 中文 alone (${await langs()})`);
await page.click('#s-close'); await page.waitForTimeout(250);
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
await page.click('#btn-settings'); await page.waitForTimeout(250);
check(await langs() === 'en:false zh:true' && await page.evaluate(() => window.__umbraTest.ocrLang()) === 'ch', `text in scans: saved, and 中文 uses the Chinese model (${await langs()})`);
await page.click('[data-lang="en"]'); await page.click('[data-lang="zh"]'); await page.waitForTimeout(100);
check(await page.evaluate(() => window.__umbraTest.ocrLang()) === 'en', 'text in scans: English only uses the English model');
await page.click('#s-close'); await page.waitForTimeout(250);
// 1.2 dev builds saved one choice: "English + 中文" becomes both switches on.
await page.evaluate((k) => { const v = JSON.parse(localStorage.getItem(k)); delete v.ocrLangs; v.ocrLang = 'ch'; localStorage.setItem(k, JSON.stringify(v)); }, key);
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
await page.click('#btn-settings'); await page.waitForTimeout(250);
check(await langs() === 'en:true zh:true', `text in scans: older "English + 中文" setting kept as both on (${await langs()})`);
await page.click('#s-close'); await page.waitForTimeout(250);
const awSaved = (await page.evaluate(() => window.__umbraTest.detectPrefs())).always;
check(JSON.stringify(awSaved) === '["Tan Ah Kow","Ali"]', `always redact: removing works and the list is saved (${JSON.stringify(awSaved)})`);
{
  const d3 = await PDFDocument.create(); const f3 = await d3.embedFont(StandardFonts.Helvetica);
  const p3 = d3.addPage([612, 792]);
  p3.drawText('Signed for the company by Mr TAN AH', { x: 72, y: 700, size: 14, font: f3 });
  p3.drawText('KOW on behalf of Alibaba Trading.', { x: 72, y: 682, size: 14, font: f3 });
  p3.drawText('Witness: Ali bin Abu', { x: 72, y: 650, size: 14, font: f3 });
  const hits = await page.evaluate(async (a) => {
    const T = window.__umbraTest; await T.load(new Uint8Array(a));
    return (await T.detect([])).map((h) => ({ label: h.label, text: h.text, boxes: h.rects?.length ?? 0 }));
  }, Array.from(await d3.save()));
  const al = hits.filter((h) => h.label === 'Always redact');
  check(al.length === 2 && al.every((h) => h.label === 'Always redact'), `always redact: Auto Detect finds both words, "Ali" not inside "Alibaba" (${JSON.stringify(hits)})`);
  check(al.some((h) => /^TAN AH\s+KOW$/.test(h.text) && h.boxes === 2), `always redact: phrase split across two lines is found (${JSON.stringify(al)})`);
  await T('reset');
}

// Settings: (?) opens its help under the heading; Export defaults are saved and are what Export starts with.
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
await page.click('#btn-settings'); await page.waitForTimeout(250);
const helpShut = await page.evaluate(() => document.querySelector('[data-helpbox="detect"]').hidden);
await page.click('[data-help="detect"]');
const helpOpen = await page.evaluate(() => [!document.querySelector('[data-helpbox="detect"]').hidden, document.querySelector('[data-help="detect"]').getAttribute('aria-expanded')]);
check(helpShut && helpOpen[0] && helpOpen[1] === 'true', `help: (?) opens the explanation (${helpShut}, ${helpOpen})`);
{
  // Title and search stay visible at the bottom of the list.
  const top = await page.evaluate(async () => {
    const sh = document.querySelector('#sheet'); sh.scrollTop = 1e6; await new Promise((r) => setTimeout(r, 100));
    const s = sh.getBoundingClientRect(), h = sh.querySelector('.ssearch h2').getBoundingClientRect(), i = document.querySelector('#s-search').getBoundingClientRect();
    const r = [sh.scrollTop > 50, h.top >= s.top - 1, i.bottom <= s.top + 160, document.querySelector('.ssearch').classList.contains('stuck')];
    sh.scrollTop = 0; return r;
  });
  check(top.every(Boolean), `settings: title and search stay on top when scrolled to the bottom (${top})`);
}
const imgHidden = await page.evaluate(() => document.querySelector('#x-image-opts').hidden);
{
  // Image settings open with no jump at the end: every frame's step is small, the last ones the smallest.
  const hs = await page.evaluate(async () => {
    const el = document.querySelector('#x-image-opts'), next = el.nextElementSibling ?? el.parentElement;
    const at = () => el.getBoundingClientRect().height;
    document.querySelector('#x-method [data-m="image"]').click();
    const out = []; const t0 = performance.now();
    await new Promise((r) => { const f = () => { out.push(at()); performance.now() - t0 < 500 ? requestAnimationFrame(f) : r(); }; requestAnimationFrame(f); });
    return out;
  });
  const steps = hs.slice(1).map((h, i) => Math.abs(h - hs[i])).filter((x) => x > 0.05);
  check(steps.length >= 4 && Math.max(...steps.slice(-2)) <= 4, `motion: Image settings slide open with no jump at the end (last steps ${steps.slice(-3).map((x) => x.toFixed(1)).join(', ')})`);
}
await page.selectOption('#x-dpi', '150');
await page.click('#s-close'); await page.waitForTimeout(250);
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
const xp = await page.evaluate(() => window.__umbraTest.exportPrefs());
check(imgHidden && xp.method === 'image' && xp.dpi === 150, `export defaults: saved from Settings (${imgHidden}, ${JSON.stringify(xp)})`);
{
  const d4 = await PDFDocument.create(); d4.addPage([612, 792]); d4.addPage([612, 792]);
  await page.evaluate(async (a) => { await window.__umbraTest.load(new Uint8Array(a)); }, Array.from(await d4.save()));
  await page.click('#btn-export'); await page.waitForTimeout(250);
  const dlg = await page.evaluate(() => [document.querySelector('#x-method [data-m="image"]').getAttribute('aria-pressed'), document.querySelector('#x-dpi').value,
    document.querySelector('#sp-mode [data-m="none"]').getAttribute('aria-pressed'), document.querySelector('#sp-plan').textContent]);
  check(dlg[0] === 'true' && dlg[1] === '150' && dlg[2] === 'true' && dlg[3] === '1 file, 2 pages', `export dialog starts from the defaults, one file (${dlg})`);
  await page.click('#x-method [data-m="vector"]');
  await page.click('#sp-mode [data-m="ranges"]'); await page.fill('#sp-r', '9');
  const bad = await page.evaluate(() => document.querySelector('#x-go').disabled);
  await page.click('#sp-mode [data-m="none"]');
  const good = await page.evaluate(() => !document.querySelector('#x-go').disabled);
  check(bad && good, `split: impossible range blocks Continue, One file allows it again (${bad}, ${good})`);
  await page.click('#x-cancel'); await page.waitForTimeout(250);
  const xp2 = await page.evaluate(() => window.__umbraTest.exportPrefs());
  check(xp2.method === 'image', `export dialog changes don't overwrite Settings defaults (${JSON.stringify(xp2)})`);
  await T('reset');
}

// Settings search: only matching settings stay; descriptions sit behind (?).
await page.setViewportSize({ width: 412, height: 860 });
await page.reload();
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 10000 });
await page.click('#btn-settings'); await page.waitForTimeout(250);
const visibleHints = await page.evaluate(() => [...document.querySelectorAll('#sheet .row2 small.hint')].length);
check(visibleHints === 0, `settings: row descriptions are behind (?), none shown inline (${visibleHints})`);
await page.fill('#s-search', 'dark'); await page.waitForTimeout(400);
const srch = await page.evaluate(() => [...document.querySelectorAll('#sheet .sset')].filter((x) => !x.hidden).map((x) => x.querySelector('h3').textContent.trim()));
check(JSON.stringify(srch) === '["Appearance"]', `settings search "dark" keeps only Appearance (${srch})`);
await page.fill('#s-search', 'screenshots'); await page.waitForTimeout(400);
const srch2 = await page.evaluate(() => [...document.querySelectorAll('#sheet .sitem')].filter((x) => !x.hidden && !x.closest('.sset').hidden).length);
await page.fill('#s-search', 'zzzz'); await page.waitForTimeout(400);
const none = await page.evaluate(() => !document.querySelector('#s-none').hidden);
await page.fill('#s-search', ''); await page.waitForTimeout(400);
const back = await page.evaluate(() => [...document.querySelectorAll('#sheet .sset')].every((x) => !x.hidden));
check(srch2 <= 1 && none && back, `settings search: help text matches, "no match" shown, clearing brings everything back (${srch2}, ${none}, ${back})`);
// Fluid toggles: drag the theme highlight from System to Dark and let go; drag a switch's thumb.
{
  const bx = await page.evaluate(() => { const b = document.querySelectorAll('[data-theme-opt]'); const r = (e) => { const q = e.getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; }; return [r(b[0]), r(b[2])]; });
  await page.mouse.move(...bx[0]); await page.mouse.down(); await page.mouse.move(bx[0][0] + 40, bx[0][1], { steps: 4 }); await page.mouse.move(bx[1][0] - 10, bx[1][1], { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const th = await page.evaluate(() => document.querySelector('[data-theme-opt="dark"]').getAttribute('aria-pressed'));
  const sw = await page.evaluate(() => { const e = document.querySelector('#s-adv'); e.scrollIntoView({ block: 'center' }); const q = e.getBoundingClientRect(); return [q.x + 6, q.y + q.height / 2, e.checked]; });
  await page.mouse.move(sw[0], sw[1]); await page.mouse.down(); await page.mouse.move(sw[0] + 30, sw[1], { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const sw2 = await page.evaluate(() => document.querySelector('#s-adv').checked);
  check(th === 'true' && sw[2] === false && sw2 === true, `fluid toggles: dragging picks Dark, dragging a switch turns it on (${th}, ${sw2})`);
  await page.evaluate(() => { document.querySelector('[data-theme-opt="system"]').click(); const e = document.querySelector('#s-adv'); if (e.checked) e.click(); });
}
await page.click('#s-close'); await page.waitForTimeout(250);
// Auto Detect panel: title bar above the list, drag to full and to collapsed.
{
  const d5 = await PDFDocument.create(); const f5 = await d5.embedFont(StandardFonts.Helvetica);
  const p5 = d5.addPage([612, 792]); for (let j = 0; j < 14; j++) p5.drawText(`Mail user${j}@example.com`, { x: 50, y: 740 - j * 30, size: 12, font: f5 });
  await page.evaluate(async (a) => { await window.__umbraTest.load(new Uint8Array(a)); }, Array.from(await d5.save()));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('#btn-detect').click()); await page.waitForTimeout(400);
  const st = await page.evaluate(() => { const p = document.querySelector('#panel'); return [p.dataset.snap, Math.round(p.offsetHeight / document.querySelector('.stage').clientHeight * 100), !!p.querySelector('.phead > .ph')]; });
  const g = await page.evaluate(() => { const q = document.querySelector('#p-grab').getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; });
  await page.mouse.move(...g); await page.mouse.down(); await page.mouse.move(g[0], 40, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(450);
  const full = await page.evaluate(() => [document.querySelector('#panel').dataset.snap, document.querySelector('#panel').offsetHeight === document.querySelector('.stage').clientHeight]);
  const g2 = await page.evaluate(() => { const q = document.querySelector('#p-grab').getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; });
  await page.mouse.move(...g2); await page.mouse.down(); await page.mouse.move(g2[0], 900, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(450);
  const peek = await page.evaluate(() => document.querySelector('#panel').dataset.snap);
  const tb = await page.evaluate(() => { const q = document.querySelector('#panel .ph b').getBoundingClientRect(); return [q.x + 10, q.y + q.height / 2]; });
  await page.mouse.click(...tb); await page.waitForTimeout(450);
  const half = await page.evaluate(() => document.querySelector('#panel').dataset.snap);
  check(st[0] === 'half' && st[1] >= 38 && st[1] <= 42 && st[2] && full[0] === 'full' && full[1] && peek === 'peek' && half === 'half',
    `panel: opens at 40% with the title bar above the list, drags to full and collapsed, tap brings it back (${st}, ${full}, ${peek}, ${half})`);
  // A drag only moves the sheet (translate): its height, and so its list's layout, changes once at the start, not every frame.
  await page.evaluate(() => { window.__rec = []; const p = document.querySelector('#panel'); const f = () => { window.__rec.push(p.offsetHeight); if (window.__rec.length < 60) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const g3 = await page.evaluate(() => { const q = document.querySelector('#p-grab').getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; });
  await page.mouse.move(...g3); await page.mouse.down(); await page.mouse.move(g3[0], g3[1] - 160, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(700);
  const hs = await page.evaluate(() => [...new Set(window.__rec)]);
  const rest = await page.evaluate(() => { const p = document.querySelector('#panel'); return [p.dataset.snap, p.style.translate, p.offsetHeight === parseFloat(document.querySelector('.stage').style.getPropertyValue('--sheet-h'))]; });
  check(hs.length <= 3 && rest[1] === '' && rest[2], `panel: drag moves the sheet without re-laying it out each frame, then rests at its stop (heights ${hs.join(' ')}, ${rest})`);
  await page.evaluate(() => document.querySelector('#p-close').click()); await page.waitForTimeout(300);
  await T('reset');
}

// Keep original text: the progress page shows straight after Continue, not once the redaction engine is done.
{
  const d5 = await PDFDocument.create(); const f5 = await d5.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 60; i++) { const p = d5.addPage([612, 792]); for (let y = 750; y > 50; y -= 14) p.drawText(`Page ${i + 1} line ${y} SECRET 12345 sample text`, { x: 40, y, size: 10, font: f5 }); }
  await page.evaluate(async (a) => {
    const T = window.__umbraTest; await T.load(new Uint8Array(a));
    T.setBoxes(T.sizes().map(() => Array.from({ length: 20 }, (_, k) => ({ x: 40, y: 40 + k * 35, w: 300, h: 10 }))));
  }, Array.from(await d5.save()));
  await page.click('#btn-export'); await page.waitForTimeout(250);
  await page.click('#x-method [data-m="vector"]');
  await page.waitForTimeout(3000); // redaction engine loaded while the dialog is open, as on a phone
  const fr = await page.evaluate(() => new Promise((done) => {
    const t0 = performance.now(); let first = null;
    const loop = () => { if (first === null && document.querySelector('#x-bar')) first = performance.now() - t0;
      if (document.querySelector('#r-close')) done({ first, title: document.querySelector('#sheet h2')?.textContent }); else requestAnimationFrame(loop); };
    document.querySelector('#x-go').click(); requestAnimationFrame(loop);
  }));
  check(fr.first !== null && fr.first < 500 && fr.title === 'Safe to share', `keep original text: progress shows right after Continue (${Math.round(fr.first)} ms, then "${fr.title}")`);
  await page.click('#r-close'); await page.waitForTimeout(250);
  await T('reset');
}

check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close(); server.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL UI CHECKS PASSED');
process.exit(failed ? 1 : 0);

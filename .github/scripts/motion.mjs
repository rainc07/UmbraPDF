// Measures the app's slide animations frame by frame inside the Android WebView, over DevTools.
// Usage (after `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`): node motion.mjs <out-prefix>
// Fails if a slide ends with a jump: a frame's step much bigger than the one before it, after the motion peaked.
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'motion';
// The WebView's DevTools socket can take a few seconds to answer after launch.
let target, pages;
for (let i = 0; i < 30 && !target; i++) {
  try { pages = await (await fetch('http://127.0.0.1:9222/json')).json(); target = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl); } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 1000));
}
if (!target) throw new Error(`no WebView page over DevTools: ${JSON.stringify(pages)}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d); waiting.delete(d.id); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function run(fn, ...args) {
  const d = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails));
  return d.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until `sel` exists (and is enabled); otherwise fails with what's on screen. */
async function waitFor(sel, ms = 15000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200))
    if (await run((s) => { const e = document.querySelector(s); return !!e && !e.disabled; }, sel)) return;
  const seen = await run(() => `body.${document.body.className}: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)}`);
  const errs = await run(() => window.__errs ?? []);
  throw new Error(`${sel} never appeared; on screen: ${seen}; page errors: ${JSON.stringify(errs)}`);
}

/**
 * Clicks `click`, then records every frame: `watch`'s top and the eased progress of the slide (the height
 * animation)), until it has settled.
 */
const track = (watch, click) => run(async (watch, click) => {
  const at = () => { const e = document.querySelector(watch); return e ? e.getBoundingClientRect().top : NaN; };
  const prog = () => {
    const a = document.getAnimations().find((x) => x.playState === 'running' && x.effect?.getKeyframes?.().some((k) => 'height' in k));
    return a ? a.effect.getComputedTiming().progress : null;
  };
  const ys = [at()], ps = [null], ts = [performance.now()];
  document.querySelector(click).click();
  const t0 = performance.now();
  await new Promise((r) => { const f = (t) => { ps.push(prog()); ys.push(at()); ts.push(t); t - t0 < 700 ? requestAnimationFrame(f) : r(); }; requestAnimationFrame(f); });
  await new Promise((r) => setTimeout(r, 300));
  ys.push(at()); ps.push(null); ts.push(performance.now());
  return { ys, ps, ts };
}, watch, click);

let failed = 0;
const report = {};
/**
 * Where should `watch` be at each frame? A slide's height follows its eased progress, so a frame at progress p
 * belongs at y0 + (yEnd - y0) * p. Measuring against that (not frame to frame) holds when the emulator
 * drops frames, and catches the old bug: a slide whose first or last frame isn't where the layout ends up.
 */
function judge(name, { ys, ps, ts }) {
  const y0 = ys[0], y1 = ys.at(-1), d = y1 - y0;
  let seen = false, worst = 0, at = '';
  ys.forEach((y, i) => {
    const p = ps[i];
    if (p !== null) seen = true;
    const want = p !== null ? y0 + d * p : seen ? y1 : y0;
    // Margins and a border that can't animate below 1 px bend the middle a little; the ends must be exact.
    const err = Math.abs(y - want) / (p !== null && p > 0.05 && p < 0.95 ? 3 : 1);
    if (err > worst) { worst = err; at = p !== null ? `at ${(p * 100).toFixed(0)}%` : seen ? 'after the slide' : 'before the slide'; }
  });
  const frames = ps.filter((p) => p !== null).length;
  const dts = ts.slice(1, -1).map((t, i) => t - ts[i]);
  const ok = seen && Math.abs(d) > 4 && worst <= 2;
  if (!ok) failed++;
  report[name] = { ok, moved: +d.toFixed(1), worstOff: +worst.toFixed(1), where: at, frames, longestFrameMs: +Math.max(...dts).toFixed(1), ys: ys.map((y) => +y.toFixed(1)), ps: ps.map((p) => (p === null ? null : +p.toFixed(3))) };
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: moved ${d.toFixed(0)} px in ${frames} frames, worst ${worst.toFixed(1)} px off (middle frames count 1/3) ${at || ''}${seen ? '' : ' (no slide ran)'}`);
}

const env = await run(() => ({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, w: innerWidth, dpr: devicePixelRatio, fs: getComputedStyle(document.body).fontSize, ua: navigator.userAgent }));
console.log('env', JSON.stringify(env));
if (env.reduce) { console.log('FAIL  the page prefers reduced motion, so nothing animates'); process.exit(1); }
await run(() => new Promise((r) => { const f = () => (document.getElementById('splash') || !document.querySelector('#btn-settings') ? setTimeout(f, 100) : r()); f(); }));

// Settings → Export defaults: Image settings open and close; what's below (Always redact's Add) is watched.
await run(() => document.querySelector('#btn-settings').click());
await waitFor('#x-method');
await sleep(600);
for (let i = 0; i < 2; i++) {
  const on = await run(() => !document.querySelector('#x-image-opts').hidden);
  if (on) judge(`settings: Image only -> Keep original text (${i + 1})`, await track('#s-aw-form button', '#x-method [data-m="vector"]'));
  await sleep(300);
  judge(`settings: Keep original text -> Image only (${i + 1})`, await track('#s-aw-form button', '#x-method [data-m="image"]'));
  await sleep(300);
  if (!on) judge(`settings: Image only -> Keep original text (${i + 1})`, await track('#s-aw-form button', '#x-method [data-m="vector"]'));
  await sleep(300);
}
await run(() => document.querySelector('#s-close').click());
await sleep(500);

// A document with a scanned page (a picture of text, so Auto Detect reads it with OCR) and a text page.
await run(() => { window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason?.stack ?? e.reason))); });
await run(async () => {
  const c = document.createElement('canvas'); c.width = 1275; c.height = 1650;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '34px sans-serif';
  for (let i = 0; i < 30; i++) g.fillText(`Line ${i + 1}: Ahmad bin Ali, IC 900101-14-5678, phone 012-345 6789, ali${i}@mail.com`, 60, 90 + i * 50);
  const jpg = Uint8Array.from(atob(c.toDataURL('image/jpeg', 0.85).split(',')[1]), (ch) => ch.charCodeAt(0));
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0; const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; put(`${n} 0 obj\n`); for (const b of [].concat(body)) put(b); put('\nendobj\n'); };
  const text = 'BT /F1 18 Tf 72 700 Td (Name: Siti binti Omar, IC 880202-10-1234) Tj ET';
  put('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im 4 0 R >> >> /Contents 5 0 R >>');
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream']);
  const draw = 'q 612 0 0 792 0 0 cm /Im Do Q';
  obj(5, [`<< /Length ${draw.length} >>\nstream\n`, draw, '\nendstream']);
  obj(6, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 8 0 R >>');
  obj(7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  obj(8, [`<< /Length ${text.length} >>\nstream\n`, text, '\nendstream']);
  const x = len;
  put(`xref\n0 9\n0000000000 65535 f \n${offs.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`);
  const all = new Uint8Array(len); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  try { await window.__umbraTest.load(all); } catch (e) { return `load failed: ${e?.stack ?? e}`; }
  return 'loaded';
}).then((r) => console.log(r));
await waitFor('#btn-export');
await sleep(2500);

// Export dialog: the same switch, then Split's ways (one box in place of another).
await run(() => document.querySelector('#btn-export').click());
await waitFor('#x-image-opts');
await sleep(700);
const xOn = await run(() => !document.querySelector('#x-image-opts').hidden);
const below = '#sp-mode';
if (!xOn) judge('export: Keep original text -> Image only', await track(below, '#x-method [data-m="image"]'));
await sleep(300);
judge('export: Image only -> Keep original text', await track(below, '#x-method [data-m="vector"]'));
await sleep(300);
judge('export: Keep original text -> Image only', await track(below, '#x-method [data-m="image"]'));
await sleep(300);
for (const [a, b] of [['none', 'every'], ['every', 'ranges'], ['ranges', 'half'], ['half', 'none']])
  { judge(`export: Split ${a} -> ${b}`, await track('#sp-plan', `#sp-mode [data-m="${b}"]`)); await sleep(350); }
await run(() => document.querySelector('#x-cancel').click());
await sleep(600);

// Auto Detect panel: collapse and expand while it reads the scanned page. Main-thread frame times only
// (the emulator draws in software, so this is a rough guide, not a pass/fail).
await waitFor('#btn-detect');
await run(() => document.querySelector('#btn-detect').click());
await waitFor('#p-grab');
await sleep(500);
const sheet = [];
for (let i = 0; i < 4; i++) {
  const g = await run(() => { const r = document.querySelector('#p-grab').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await run(() => {
    const p = document.querySelector('#panel'), ts = [], ys = [];
    window.__rec = new Promise((done) => {
      const t0 = performance.now();
      const f = (t) => { ts.push(t); ys.push(p.getBoundingClientRect().top); t - t0 < 600 ? requestAnimationFrame(f) : done(); };
      requestAnimationFrame(f);
    }).then(() => {
      const dts = ts.slice(1).map((t, i) => t - ts[i]);
      return { frames: ts.length, longestMs: Math.max(...dts), over34ms: dts.filter((d) => d > 34).length, ys: ys.map((y) => Math.round(y)) };
    });
  });
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g[0], y: g[1] }] });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const r = await run(() => window.__rec);
  sheet.push(r);
  console.log(`info  panel ${i % 2 ? 'expand' : 'collapse'}: ${r.frames} frames in 600 ms, longest ${r.longestMs.toFixed(0)} ms, ${r.over34ms} over 34 ms; top ${r.ys.join(' ')}`);
  await sleep(700);
}
report.panel = sheet;
report.env = env;
writeFileSync(`${out}.json`, JSON.stringify(report, null, 1));
ws.close();
if (failed) { console.log(`${failed} slide(s) jumped`); process.exit(1); }

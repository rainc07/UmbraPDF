// Export on a screen that never draws a frame (a still variable-refresh phone screen, e.g. Galaxy S23).
// Chromium only draws when asked here (--enable-begin-frame-control), so anything that waits on frames or
// frame idle time (rAF, GPU canvases, toBlob) shows up as ~1 s per page instead of milliseconds.
// Usage: npm run build && node tests/still-screen.mjs   (CHROMIUM_PATH overrides the browser binary)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

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

const PAGES = 6;
const d = await PDFDocument.create();
const font = await d.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < PAGES; i++) {
  const p = d.addPage([612, 792]);
  for (let y = 740; y > 60; y -= 14) p.drawText(`Page ${i + 1} line ${y} The quick brown fox jumps over the lazy dog 0123456789`, { x: 40, y, size: 10, font });
}
const pdf = Array.from(await d.save());
// A scan without a text layer: the OCR path (engine load, worker messages) is read fresh.
const scan = Array.from(await readFile(resolve(root, '../../samples/umbra-test-scanned.pdf')));

async function run(frames, ocr) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: frames ? [] : ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.waitForFunction(() => window.__umbraTest);
    return await page.evaluate(async ({ arr, ocr }) => {
      const T = window.__umbraTest;
      await T.load(new Uint8Array(arr));
      const t0 = performance.now();
      await T.export({ format: 'auto' }, ocr);
      return performance.now() - t0;
    }, { arr: ocr ? scan : pdf, ocr });
  } finally { await browser.close(); }
}

let failed = 0;
for (const ocr of [false, true]) {
  const still = await run(false, ocr), drawing = await run(true, ocr);
  // Same work either way; a frame-bound step adds ~1 s or more per page on the still screen
  // (before the fix: 12.8 s vs 3.4 s for the 6 pages).
  const ok = still < drawing * 1.5 + 1000;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  export${ocr ? ' + OCR' : ''}: ${Math.round(still)} ms with no frames, ${Math.round(drawing)} ms drawing`);
}
server.close();
process.exit(failed ? 1 : 0);

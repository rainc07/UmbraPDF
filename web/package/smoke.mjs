// Smoke test for a built or installed copy: starts it with its own Node.js, loads the page, warms up the OCR engine,
// and checks that a port taken by another program makes it move to the next one.
// Usage: node package/smoke.mjs <folder>   (the folder from build.mjs, or the install folder)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '');
const node = resolve(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
if (!existsSync(node)) throw new Error(`No Umbra PDF copy in ${dir}`);
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `: ${info}` : ''}`); if (!ok) failed++; };

/** Starts the copy; resolves with its URL and the process, once it is listening. */
function start(port) {
  const p = spawn(node, [resolve(dir, 'server.mjs'), '--root', resolve(dir, 'app'), '--models', resolve(dir, 'models'), '--port', String(port), '--no-open'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((ok, fail) => {
    const on = (c) => { out += c; const m = /running at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) ok({ url: m[1], p, log: () => out }); };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    p.on('exit', (code) => fail(new Error(`server exited (${code}): ${out}`)));
    setTimeout(() => fail(new Error(`no start in 30 s: ${out}`)), 30000);
  });
}

// A port another program is using.
const blocker = createServer();
await new Promise((ok) => blocker.listen(0, '127.0.0.1', ok));
const busy = blocker.address().port;

const s = await start(busy);
try {
  check('moves to the next port when taken', s.url === `http://127.0.0.1:${busy + 1}/`, s.url);
  const home = await fetch(s.url);
  check('serves the app', home.status === 200 && /umbra-server/.test(await home.text()));
  const caps = await (await fetch(`${s.url}api/caps`)).json();
  check('native OCR server', caps.app === 'umbra-pdf' && caps.native === true);
  const warm = await (await fetch(`${s.url}api/ocr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":1,"kind":"warm"}' })).json();
  check('OCR engine loads', warm.ok === true, JSON.stringify(warm));
  // Second launch while running: finds this one and exits instead of starting another.
  const again = spawn(node, [resolve(dir, 'server.mjs'), '--root', resolve(dir, 'app'), '--models', resolve(dir, 'models'), '--port', String(busy), '--no-open'], { cwd: dir });
  let out = '';
  again.stdout.on('data', (c) => (out += c));
  const code = await new Promise((ok) => again.on('exit', ok));
  check('second launch reuses the running one', code === 0 && out.includes(`already running: ${s.url}`), out.trim());
} finally {
  s.p.kill();
  blocker.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);

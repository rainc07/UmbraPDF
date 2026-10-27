// Builds the installable desktop web app: one folder with its own Node.js runtime, the server, ONNX Runtime for this
// platform only, the web core and the OCR models. No git, npm or Node needed on the target computer.
// Usage (after npm run build:core && npm run build): node package/build.mjs [--target win-x64|linux-x64] [--out <dir>]
// Output: web/release/UmbraPDF-Web-<target>/. CI turns it into the Windows installer (umbra-web.iss) and archives.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const repo = resolve(web, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

// Node.js runtime: LTS, checksums from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
const NODE = 'v24.21.0';
const TARGETS = {
  'win-x64': { archive: `node-${NODE}-win-x64.zip`, sha: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541', bin: 'node.exe', ort: 'win32/x64' },
  'linux-x64': { archive: `node-${NODE}-linux-x64.tar.xz`, sha: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6', bin: 'bin/node', ort: 'linux/x64' },
};
const target = arg('--target', process.platform === 'win32' ? 'win-x64' : 'linux-x64');
const t = TARGETS[target];
if (!t) throw new Error(`Unknown --target ${target}. One of: ${Object.keys(TARGETS).join(', ')}`);
const win = target.startsWith('win');
const out = resolve(arg('--out', resolve(web, 'release', `UmbraPDF-Web-${target}`)));

for (const f of [resolve(web, 'dist/server.mjs'), resolve(repo, 'core/dist/index.html'), resolve(web, 'node_modules/onnxruntime-node/package.json')])
  if (!existsSync(f)) throw new Error(`Missing ${f}. Run first: npm ci && npm run build:core && npm run build`);

// ---------- Node.js runtime (cached, checksum pinned) ----------
const cache = resolve(web, '.cache');
mkdirSync(cache, { recursive: true });
const archive = resolve(cache, t.archive);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
if (!existsSync(archive) || sha(archive) !== t.sha) {
  console.log(`Downloading ${t.archive}`);
  const res = await fetch(`https://nodejs.org/dist/${NODE}/${t.archive}`);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
}
if (sha(archive) !== t.sha) throw new Error(`${t.archive}: checksum mismatch`);

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'node'), { recursive: true });
const unpacked = resolve(cache, t.archive.replace(/\.(zip|tar\.xz)$/, ''));
if (!existsSync(resolve(unpacked, t.bin))) {
  // Windows' tar (bsdtar) reads zip; on Linux use unzip for the Windows zip.
  if (t.archive.endsWith('.zip') && process.platform !== 'win32') execFileSync('unzip', ['-q', '-o', archive, '-d', cache]);
  else execFileSync('tar', ['-xf', archive, '-C', cache]);
}
cpSync(resolve(unpacked, t.bin), resolve(out, 'node', win ? 'node.exe' : 'node'));
cpSync(resolve(unpacked, 'LICENSE'), resolve(out, 'node', 'LICENSE'));

// ---------- server, ONNX Runtime (this platform's binaries only), app, models ----------
cpSync(resolve(web, 'dist/server.mjs'), resolve(out, 'server.mjs'));
const ortSrc = resolve(web, 'node_modules/onnxruntime-node');
const ortOut = resolve(out, 'node_modules/onnxruntime-node');
for (const f of ['package.json', 'LICENSE', 'dist']) if (existsSync(resolve(ortSrc, f))) cpSync(resolve(ortSrc, f), resolve(ortOut, f), { recursive: true });
cpSync(resolve(ortSrc, 'bin/napi-v6', t.ort), resolve(ortOut, 'bin/napi-v6', t.ort), { recursive: true });
cpSync(resolve(web, 'node_modules/onnxruntime-common'), resolve(out, 'node_modules/onnxruntime-common'), { recursive: true });
cpSync(resolve(repo, 'core/dist'), resolve(out, 'app'), { recursive: true });
cpSync(resolve(repo, 'core/models/ppocrv5'), resolve(out, 'models'), { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(resolve(repo, f), resolve(out, f));
cpSync(resolve(here, 'settings.json'), resolve(out, 'settings.json'));

// ---------- launcher ----------
if (win) {
  cpSync(resolve(here, 'Umbra PDF.cmd'), resolve(out, 'Umbra PDF.cmd'));
  cpSync(resolve(here, 'umbra.ico'), resolve(out, 'umbra.ico'));
} else {
  cpSync(resolve(here, 'umbra-pdf.sh'), resolve(out, 'umbra-pdf.sh'));
  chmodSync(resolve(out, 'umbra-pdf.sh'), 0o755);
  chmodSync(resolve(out, 'node/node'), 0o755);
}
const version = JSON.parse(readFileSync(resolve(web, 'package.json'), 'utf8')).version;
writeFileSync(resolve(out, 'README.txt'), readFileSync(resolve(here, 'README.txt'), 'utf8')
  .replaceAll('{launcher}', win ? 'Umbra PDF (Start menu), or "Umbra PDF.cmd" in this folder' : './umbra-pdf.sh'));
console.log(`Built ${out} (Umbra PDF web ${version}, ${target}, Node.js ${NODE})`);

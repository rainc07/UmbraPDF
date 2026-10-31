// Builds the installable web app (iPhone/iPad "Add to Home Screen", works offline) from dist/ into dist-pwa/:
// the same app as Android and the desktop, plus a web manifest, icons and an offline service worker.
// Published to GitHub Pages by .github/workflows/pwa.yml. dist/ itself (and so the Android assets) is untouched.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'dist'), out = resolve(root, 'dist-pwa'), pwa = resolve(root, 'pwa');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'sw-register.js']) cpSync(resolve(pwa, f), resolve(out, f));

writeFileSync(resolve(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Umbra PDF', short_name: 'Umbra', id: './', start_url: './', scope: './',
  description: 'Redact PDFs on your device. Nothing is uploaded.',
  display: 'standalone', orientation: 'any', background_color: '#111214', theme_color: '#111214',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));

let html = readFileSync(resolve(out, 'index.html'), 'utf8');
if (!html.includes('Content-Security-Policy')) throw new Error('dist/index.html has no CSP: run the production build first');
html = html.replace("default-src 'none'", "default-src 'none'; manifest-src 'self'")
  .replace('<link rel="icon"', `<link rel="manifest" href="manifest.webmanifest">
    <link rel="apple-touch-icon" href="apple-touch-icon.png">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="Umbra">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#111214">
    <meta name="umbra-version" content="${version}">
    <script type="module" src="sw-register.js"></script>
    <link rel="icon"`);
writeFileSync(resolve(out, 'index.html'), html);

// Offline file lists. Hash of every file = cache version, so any change installs a fresh copy.
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = resolve(d, n); statSync(p).isDirectory() ? walk(p) : files.push(relative(out, p).split(sep).join('/')); } };
walk(out);
files.sort();
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(resolve(out, f)));
const later = (f) => /^vendor\/(tesseract\/|pdfjs\/(cmaps|standard_fonts|iccs)\/|ppocr\/(rec|dict)_ch)|LICENSE$/.test(f);
const core = files.filter((f) => !later(f)), more = files.filter(later);
writeFileSync(resolve(out, 'sw.js'), readFileSync(resolve(pwa, 'sw.js'), 'utf8')
  .replace('__VERSION__', `${version}-${hash.digest('hex').slice(0, 12)}`)
  .replace('__CORE__', JSON.stringify(core)).replace('__MORE__', JSON.stringify(more)));
writeFileSync(resolve(out, '.nojekyll'), '');

const mb = (l) => (l.reduce((k, f) => k + statSync(resolve(out, f)).size, 0) / 1048576).toFixed(1);
console.log(`dist-pwa: ${core.length} files (${mb(core)} MB) cached at install, ${more.length} (${mb(more)} MB) right after`);

// Copies runtime assets that must be served locally (no CDN fallbacks) into dist/vendor.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => resolve(root, 'node_modules', p);
const out = (p) => resolve(root, 'dist/vendor', p);

rmSync(out(''), { recursive: true, force: true });
const copy = (src, dst, opts = {}) => {
  mkdirSync(dirname(out(dst)), { recursive: true });
  cpSync(nm(src), out(dst), { recursive: true, ...opts });
};

// pdf.js
copy('pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');
copy('pdfjs-dist/cmaps', 'pdfjs/cmaps');
copy('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts');
copy('pdfjs-dist/iccs', 'pdfjs/iccs');
copy('pdfjs-dist/wasm', 'pdfjs/wasm', { filter: (s) => !/quickjs/.test(s) });
copy('pdfjs-dist/LICENSE', 'pdfjs/LICENSE');

// tesseract.js (LSTM-only cores; SIMD + non-SIMD fallback)
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
copy('tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract/core/tesseract-core-simd-lstm.wasm.js');
copy('tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract/core/tesseract-core-lstm.wasm.js');
copy('tesseract.js-core/LICENSE', 'tesseract/core/LICENSE');
// Stored uncompressed: Android asset packaging does not keep *.gz files intact (404 on device).
mkdirSync(out('tesseract/lang'), { recursive: true });
writeFileSync(out('tesseract/lang/eng.traineddata'),
  gunzipSync(readFileSync(nm('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))));

console.log('vendor assets copied');

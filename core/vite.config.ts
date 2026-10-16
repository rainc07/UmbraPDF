import { defineConfig, type Plugin } from 'vite';

// Strict CSP injected only into production builds (dev server needs inline HMR scripts).
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'umbra-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
});

export default defineConfig({
  base: './',
  plugins: [csp()],
  build: {
    outDir: 'dist', target: 'es2022', sourcemap: false, assetsInlineLimit: 0,
    // Stable file names: the app ships its own copy (WebView cache disabled), and updates overwrite instead of piling up.
    rollupOptions: { output: { entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
  },
  // The OCR worker (and the ONNX Runtime WASM it loads) also get stable names.
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
  },
});

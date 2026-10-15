# Umbra PDF

Offline PDF redaction. Draw boxes over sensitive content (or let Umbra find personal details), then export either a **true redaction that keeps the original text** or a **flattened, image-only PDF**. Every export gets an automatic, fail-closed safety check. Source code is GPL-3.0-or-later. The app bundles MuPDF (AGPL-3.0-or-later); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features
- **Manual redaction**: draw, select, delete, undo, zoom.
- **Find & black out**: search across all pages (match case, whole word). Scanned pages are OCR'd on the device first.
- **Find personal details**: toggleable detectors for Malaysian NRIC, phone, email, card (Luhn-checked), bank account, passport, date of birth, company registration number, labelled names, addresses and vehicle plates, plus custom regex. Results are reviewed first: amber = will be redacted, grey = skipped.
- **Two export methods**:
  - **Keep original text** (default): true redaction with MuPDF. Text, vector shapes fully under a box, and image pixels under each box are removed from the file. Forms and annotation appearances are flattened first, so boxes over them work too. Links, forms, attachments, scripts, metadata, outlines, the structure tree and ActualText/Alt descriptions are stripped. The output looks like the original, stays small and stays selectable.
  - **Image only** (maximum safety): every page is rasterized (300 DPI default, 150–600) and rebuilt as a brand-new image-only PDF. Grey pages are stored as 1 channel with PNG prediction and Flate compression.
- **Keep text selectable & searchable (OCR)**, on by default (remembered): an invisible text layer read from the *redacted* page image, so the output can be searched and copied while blacked-out parts can never be included.
- **Automatic safety check, fail-closed**: if any check fails, the app offers no save.
  - no extractable text (or, in searchable mode, none overlapping a redaction box)
  - no fonts (except the non-embedded Helvetica of the OCR layer), annotations, forms, attachments, outlines, JS or non-image XObjects
  - no Title/Author/etc. metadata
  - OCR of every redacted region finds no readable text
  - the full report is available under Settings → Advanced
- Light / dark / system theme. Android: no `INTERNET` permission, Storage Access Framework I/O, "Open with" support, backups disabled.

📖 **[User guide](docs/USER_GUIDE.md)** · 🔒 **[Security policy](SECURITY.md)**

## Layout
```
core/                     platform-agnostic web core (TypeScript, Vite)
  src/engine/             pdf.js render, export, verify, OCR (no UI, no host APIs)
  src/platform/           Host interface + android/browser impls (Tauri later)
  src/main.ts, src/ui/    UI
  tests/e2e.mjs           Chromium end-to-end leak test
app/                      Android shell (Kotlin, single WebView)
  src/main/assets/web/    built core (committed, so Android builds without Node)
```

## Build
Android only: open the project in Android Studio and run it. The built core is already in `app/src/main/assets/web`.

After changing `core/`:
```
cd core
npm ci
npm run build:android   # tsc + vite build + vendor copy + sync into app assets
npm test                # E2E leak test (needs Chromium; set CHROMIUM_PATH)
npm run dev             # browser dev server
```

## Security model
- **Network:** no INTERNET permission, so the OS blocks sockets. The WebView answers every request locally through WebViewAssetLoader or returns 403. The page also has a strict CSP (`default-src 'none'`).
- **File access:** files arrive through SAF only and are staged in `cacheDir/umbra`, which is wiped after use and on start and exit. `allowFileAccess` and `allowContentAccess` are off.
- **Export (Keep original text):** MuPDF `applyRedactions` (text: remove; images: blank pixels; line art: remove if covered). The file is then fully rewritten (never incremental, garbage-collected), and pdf-lib strips catalog/page/object entries that can carry hidden content. Verification: no character centre inside a box, plus the structural checks.
- **Export (Image only):** a brand-new PDF is built from page images. Nothing from the source object graph is copied.

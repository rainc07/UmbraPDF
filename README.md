# Umbra PDF

Offline PDF redaction. Draw boxes over sensitive content (or let Umbra find personal details), then export either a **true redaction that keeps the original text** or a **flattened, image-only PDF**. Every export gets an automatic, fail-closed safety check. Source code is GPL-3.0-or-later. The app bundles MuPDF (AGPL-3.0-or-later); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install
Download from the **[latest release](https://github.com/rainc07/UmbraPDF/releases/latest)** (under *Assets*):

| Your device | Download | Then |
|---|---|---|
| **Android** | `UmbraPDF-<version>.apk` | Open it and tap **Install**. If Play Protect warns, tap **More details → Install anyway**. |
| **Windows** 10/11 | `UmbraPDF-<version>-Windows-Setup.exe` | Run it. If SmartScreen warns, click **More info → Run anyway**. Start **Umbra PDF** from the Start menu; it opens in your browser. |
| Windows, no install | `UmbraPDF-<version>-Windows-Portable.zip` | Unzip and double-click **Umbra PDF.cmd**. |
| **Linux** (x64) | `UmbraPDF-<version>-Linux.tar.gz` | Unpack and run `./umbra-pdf.sh`. |

Nothing else is needed (no Node.js, no git). Everything runs on your own device; the Windows/Linux version only answers
this computer (`127.0.0.1`).

## Features
- **Manual redaction**: draw, select, delete, undo; pinch-zoom and double-tap zoom.
- **Find & black out**: search across all pages (match case, whole word). Scanned pages are OCR'd on the device first.
- **Find personal details**: toggleable detectors for Malaysian NRIC, phone, email, card (Luhn-checked), bank account, passport, date of birth, company registration number, LHDN tax number (TIN), names (labelled, table columns, common Malaysian names, IC cards), addresses and vehicle plates, plus custom regex. Pictures inside typed pages (e.g. a pasted IC copy) are OCR'd too. Results are reviewed first: amber = will be redacted, grey = skipped.
- **Two export methods**:
  - **Keep original text** (default): true redaction with MuPDF. Text, vector shapes fully under a box, and image pixels under each box are removed from the file. Forms and annotation appearances are flattened first, so boxes over them work too. Links, forms, attachments, scripts, metadata, outlines, the structure tree and ActualText/Alt descriptions are stripped. The output looks like the original, stays small and stays selectable.
  - **Image only** (maximum safety): every page is rasterized (300 DPI default, 150–600) and rebuilt as a brand-new image-only PDF. Grey pages are stored as 1 channel with PNG prediction and Flate compression.
- **Keep text selectable & searchable (OCR)**, on by default (remembered): an invisible text layer read from the *redacted* page image, so the output can be searched and copied while blacked-out parts can never be included.
- **Automatic safety check, fail-closed**: if any check fails, the app offers no save.
  - no extractable text (or, in searchable mode, none overlapping a redaction box)
  - no fonts (except the non-embedded Helvetica of the OCR layer), annotations, forms, attachments, outlines, JS or non-image XObjects
  - no Title/Author/etc. metadata
  - every redacted region is solid black in the output (pixel check); any region that isn't is OCR'd and must contain no readable text
  - the full report is available under Settings → Advanced
- Light / dark / system theme. Android: no `INTERNET` permission, Storage Access Framework I/O, "Open with" support, backups disabled.

📖 **[User guide](docs/USER_GUIDE.md)** · 🔒 **[Security policy](SECURITY.md)**

## Download & verify
Get the signed APK from [Releases](https://github.com/rainc07/UmbraPDF/releases). Android may warn that the app is from an unknown developer (Play Protect); tap **More details → Install anyway**.

Every official APK is signed with this certificate:
```
SHA-256: 39:5B:52:86:9F:CC:17:A9:41:78:E0:2F:5C:D4:3F:91:9D:18:A8:F5:CF:68:EB:76:15:F0:1C:DE:29:BE:1D:03
```
Check before installing (Windows PowerShell; Android SDK build-tools needed for `apksigner`):
```powershell
Get-FileHash UmbraPDF-1.1.1.apk -Algorithm SHA256   # must match the hash in the release notes
apksigner verify --print-certs UmbraPDF-1.1.1.apk    # "certificate SHA-256 digest" must match the line above
```
On Linux/macOS: `sha256sum UmbraPDF-1.1.1.apk`. If either value differs, don't install it.

## Layout
```
core/                     platform-agnostic web core (TypeScript, Vite)
  src/engine/             pdf.js render, export, verify, OCR (no UI, no host APIs)
  src/platform/           Host interface + android/browser impls (Tauri later)
  src/main.ts, src/ui/    UI
  tests/e2e.mjs           Chromium end-to-end leak test
app/                      Android shell (Kotlin, single WebView)
  src/main/assets/web/    built core (committed, so Android builds without Node)
web/                      desktop web app: local server (127.0.0.1 only) + native OCR (ONNX Runtime for Node)
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

## Desktop web app (Windows, macOS, Linux)
The same app in your browser, served from your own computer only (127.0.0.1). Text in scanned pages is read by
ONNX Runtime for Node: the same PaddleOCR models and steps as Android, natively and multi-threaded.

**Install:** see [Install](#install). The installer is per user (no admin prompt) with a Start menu shortcut and an
uninstaller; it isn't code-signed yet. Settings (port, threads, GPU) are in `settings.json` in the install folder
(Start menu → *Umbra PDF settings*). If the port is taken by another program, Umbra PDF moves to the next free one
(5181, 5182, ...).

Build the packages yourself: `cd web && npm ci && npm run build:core && npm run build && node package/build.mjs`, then
`iscc package/umbra-web.iss` ([Inno Setup](https://jrsoftware.org/isinfo.php)) for the installer. CI does this in
`.github/workflows/web-app.yml`.

**From source** (needs Node.js 20+). Windows: double-click `web\Umbra PDF.cmd` (installs and builds on first run). Or:
```
cd web
npm install             # once
npm run web             # builds core + server, starts, opens the browser
npm start               # later runs (no rebuild)
npm test                # server + desktop checks (Edge on Windows, or set CHROMIUM_PATH)
```
Options: `--port 5180` (next free port if taken), `--threads N` (CPU threads for OCR), `--gpu` (DirectML on Windows; falls back to the CPU),
`--no-open`. Closing the server window stops it. The browser falls back to its own OCR engine if the server's can't run.

## Security model
- **Network:** no INTERNET permission, so the OS blocks sockets. The WebView answers every request locally through WebViewAssetLoader or returns 403. The page also has a strict CSP (`default-src 'none'`).
- **File access:** files arrive through SAF only and are staged in `cacheDir/umbra`, which is wiped after use and on start and exit. `allowFileAccess` and `allowContentAccess` are off.
- **Export (Keep original text):** MuPDF `applyRedactions` (text: remove; images: blank pixels; line art: remove if covered). The file is then fully rewritten (never incremental, garbage-collected), and pdf-lib strips catalog/page/object entries that can carry hidden content. Verification: no character centre inside a box, plus the structural checks.
- **Export (Image only):** a brand-new PDF is built from page images. Nothing from the source object graph is copied.

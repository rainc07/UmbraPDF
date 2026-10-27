# Umbra PDF 1.1.1

## Fixes
- **Phrase search in searchable exports:** the invisible OCR text layer now has real spaces between words, so searching for several words (`Tan Chee Kin`) finds them in Chrome, Edge, Android viewers and other PDF readers. Before, only single words matched.
- **Text layer font:** the OCR layer's font is now named correctly, so strict PDF readers no longer drop the text.
- **Mostly blank pages:** a short block of print is no longer mistaken for an ID card. Before, its words could come back in the wrong place or go missing in search, Auto Detect and the text layer.
- Tilted lines in the text layer stay on one line in PDF viewers.

## Desktop web app (from source)
- The repository now has a desktop version in `web/`: a local server that opens Umbra PDF in your browser and reads scanned pages with the same native OCR as the phone. It's only reachable from your own computer. There's no installer yet: with Node.js 20 or newer, run `npm ci && npm run build` in `core/`, then `npm install && npm run build` in `web/`, then `node web/dist/server.mjs`. On Windows, after building, `web/Umbra PDF.cmd` starts it.

## Verify the download
- APK SHA-256: `5CACE7D217B6C31CC12B323616F36A95DE7B6B6B5E32F9E4DB6D47B875704FF3`
- Signing certificate SHA-256: `395b52869fcc17a94178e02f5cd43f919d18a8f5cf68eb7615f01cde29be1d03`. This is the same key as 1.0.0 and 1.1.0, so it installs over the old version.

## Install
Download `UmbraPDF-1.1.1.apk` on your phone and open it. It installs over 1.1.0 and keeps your settings. See the 1.0.0 notes if Android asks about unknown apps.

## Licence
Source: GPL-3.0-or-later. The APK bundles MuPDF, so it is distributed under AGPL-3.0-or-later; the complete source is this repository at tag `v1.1.1`. See THIRD_PARTY_NOTICES.md.

# Umbra PDF 1.0.0

First public release. Offline PDF redaction for Android (7.0+): black out sensitive content by hand or with automatic detection, then export a clean copy that passes a fail-closed safety check. No internet permission; your files never leave the device.

## Highlights
- **Manual redaction**: draw, select, delete, undo, zoom.
- **Find & redact**: search all pages (match case, whole word); scanned pages are read with on-device OCR.
- **Auto Detect**: Malaysian NRIC, phone, email, card (Luhn), bank account, passport, date of birth, company reg. no., names, addresses, vehicle plates, custom regex. Repeats of found values are caught document-wide.
- **Two export methods**:
  - **Keep original text** (default): true redaction with MuPDF. Text, images and line art under boxes are removed; links, forms, attachments, scripts and metadata are stripped. Small and still selectable.
  - **Image only**: every page is rebuilt as an image, with an optional searchable OCR text layer read from the redacted image.
- **Safety check**: if any check fails, the app won't save.
- Hide content in Recent apps, light/dark theme, "Open with" support, backups disabled.

## Install
1. Download `UmbraPDF-1.0.0.apk` below on your phone and open it.
2. Allow your browser or file manager to install unknown apps if asked.
3. If Play Protect warns about an unknown developer, tap **More details → Install anyway**. This is normal for apps outside app stores.

## Verify the download
- APK SHA-256: `E1B3446DF190940F082AB87F891581CD004DC7A47D6ED2147E9281CA8834D1A4`
- Signing certificate SHA-256: `395b52869fcc17a94178e02f5cd43f919d18a8f5cf68eb7615f01cde29be1d03`

See [Download & verify](https://github.com/rainc07/UmbraPDF#download--verify) for the commands.

## Docs
- [User guide](https://github.com/rainc07/UmbraPDF/blob/main/docs/USER_GUIDE.md)
- [Security policy / reporting a vulnerability](https://github.com/rainc07/UmbraPDF/blob/main/SECURITY.md)

## Licence
- Umbra PDF source code: [GPL-3.0-or-later](https://github.com/rainc07/UmbraPDF/blob/main/LICENSE).
- The APK bundles MuPDF (AGPL-3.0-or-later, © Artifex), so the app as distributed is under **AGPL-3.0-or-later**. The complete corresponding source is this repository at tag `v1.0.0`.
- Third-party components and licences: [THIRD_PARTY_NOTICES.md](https://github.com/rainc07/UmbraPDF/blob/main/THIRD_PARTY_NOTICES.md).

Provided as is, without warranty. Always review the exported PDF before sharing it.

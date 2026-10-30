# Umbra PDF 1.2.0

## New
- **Split into several files** (in Export): one file per page or every few pages, by page ranges (`1-3, 5, 8-`), or each page cut in half (left|right or top|bottom, with right-to-left and "wide pages only" options). It works with both "Keep original text" and "Image only". When a file has black boxes, the redacted copy is checked first and only that copy is split. On the phone you pick a folder; on the desktop it saves to a folder or one ZIP.
- **Always redact** list in Settings: words or names that are boxed automatically in every file.
- **Auto compression**: scanned pages are saved as JPEG and clean pages stay lossless. A 3-page scan went from 22.1 MB to 3.6 MB.

## Faster
- **Image only with searchable text** is much quicker. On a scan that already has a text layer (most scanner apps add one), pages without boxes reuse that text instead of reading the page again. Only words printed on the page are kept, and never anything near a box. A 21-page scanned agreement now exports in about 8 s on a desktop.
- Typed pages and dense pages of print are no longer read twice (once as if they were an ID card).
- The technical report shows OCR timings per page, with a Copy button.

## Safety
- **Keep original text** reads the boxed areas of the result again and refuses to save if text is still readable under a box.
- **Keep original text** refuses files with hidden text next to your boxes (for example, a scanner's invisible text layer that doesn't line up) and suggests "Image only".
- "Hide content in Recent apps" is on by default for new installs.

## Verify the download
- APK SHA-256: `[APK_SHA256]`
- Signing certificate SHA-256: `395b52869fcc17a94178e02f5cd43f919d18a8f5cf68eb7615f01cde29be1d03`. This is the same key as earlier versions, so it installs over them.

## Install
Download `UmbraPDF-1.2.0.apk` on your phone and open it. It installs over 1.1.1 and keeps your settings. See the 1.0.0 notes if Android asks about unknown apps.

## Licence
Source: GPL-3.0-or-later. The APK bundles MuPDF, so it is distributed under AGPL-3.0-or-later; the complete source is this repository at tag `v1.2.0`. See THIRD_PARTY_NOTICES.md.

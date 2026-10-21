# Umbra PDF 1.1.0

## New
- **Pinch to zoom** with two fingers. It works in Redact mode too, and two fingers never draw a box. **Double-tap** switches between fit-to-width and close-up. On a computer, use Ctrl + mouse wheel or a trackpad pinch.
- **Tax number (TIN) detector:** LHDN `IG…` numbers, plus the older `SG`/`OG` forms, are always found. Organisation numbers (`C`, `D`, `E`, `F`, `PT`, `TA`…) are found when they're next to "TIN", "No. Cukai", "Income tax" or "LHDN".

## Faster, smarter scanning
- **New OCR engine:** scanned pages are read with PaddleOCR (PP-OCRv5 mobile), running natively on the phone. It's faster and more accurate than the old engine, and still fully offline.
- **Reads in the background:** scanned pages start being read as soon as you open a PDF, and reading keeps going when you switch apps. A notification shows "Reading page 6 of 23", then says when the scan has finished.
- **Each page is read once,** with its text lines read side by side on the phone's fast cores, and the next page is prepared while the current one is read.
- **Stop** a scan with the Stop button, or with Back (it asks first). Pages already read are kept.
- The Auto Detect panel can be closed and reopened while a scan runs. Results open it by themselves when the scan ends.
- Notification permission is asked once, at first launch.

## Better detection
- **IC cards:**
  - Cards are found and read at any angle, including several cards on one page.
  - IC numbers with OCR slips (O/0, I/1, S/5, B/8, odd dashes) are still caught on card pages.
  - When a card's number can't be read, the IC spot is boxed anyway.
  - Scans and photos with patterned backgrounds get a second, cleaned-up OCR pass.
  - Pictures pasted into typed PDFs are now OCR'd too, for example an IC copy in a Word document.
  - The name and address lines on the card are recognised.
- **Names:**
  - Labels without a colon: `NAME   LIM SIEW LING`.
  - Any letter case after a colon: `Name: tan wei ming`.
  - More labels, such as "Nama Pemegang Akaun".
  - "Name"/"Nama" table columns.
  - Three-part names stay whole when the scan splits them ("Tan Chee" + "Kin").
  - Common Malaysian names without any label: Chinese surname + given names, Mohd/Nur/Siti… names, and s/o and d/o.
  - Street and building names, like Jalan Raja Muda…, are ignored.
- **Account numbers:**
  - The label can be on the same line, on the line above, or in an "Account No." table column.
  - Lengths of 8–17 digits.
  - After "Account No.:" any account-like value is taken, e.g. `ACC-00012345678`.
- **Passport and date of birth:** also found under table column headers.

## Easier to use
- New bottom dock: [Scroll | Redact] on the left, [Undo | Redo | Reset] on the right. Swipe the toggle to switch mode.
- Actions sit at the top, with a side panel in landscape. The Redacted list follows the page you're on.
- Back closes any open dialog or panel first.
- A smaller download: the APK carries only the phone (arm64) version of the OCR engine.
- If the app ever crashes, the report is shown once on the next start so it can be copied and sent.

## Faster export
- The final safety check now proves each black box is solid black from its pixels. OCR runs only on boxes that aren't solid, and the OCR engine isn't loaded at all when every box is solid. In tests, this check was about 7× faster.
- The redaction engine starts loading as soon as the Export dialog opens.
- The copy-ready export reuses the text already read instead of running OCR again.
- Settings → Advanced → technical report now shows how long each export step took, and the OCR timings of each scanned page.

## Verify the download
- APK SHA-256: `C6184F593375843D96DE70736EB00F9880FECB333EE20CD83BFDB541BFB5E971`
- Signing certificate SHA-256: `395b52869fcc17a94178e02f5cd43f919d18a8f5cf68eb7615f01cde29be1d03`. This is the same key as 1.0.0, so it installs over the old version.

## Install
Download `UmbraPDF-1.1.0.apk` on your phone and open it. It installs over 1.0.0 and keeps your settings. See the 1.0.0 notes if Android asks about unknown apps.

## Licence
Source: GPL-3.0-or-later. The APK bundles MuPDF, so it is distributed under AGPL-3.0-or-later; the complete source is this repository at tag `v1.1.0`. See THIRD_PARTY_NOTICES.md.

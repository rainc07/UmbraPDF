# Umbra PDF 1.1.0

## New
- **Pinch to zoom** with two fingers. It works in Redact mode too, and two fingers never draw a box. **Double-tap** switches between fit-to-width and close-up. On a computer, use Ctrl + mouse wheel or a trackpad pinch.
- **Tax number (TIN) detector:** LHDN `IG…` numbers, plus the older `SG`/`OG` forms, are always found. Organisation numbers (`C`, `D`, `E`, `F`, `PT`, `TA`…) are found when they're next to "TIN", "No. Cukai", "Income tax" or "LHDN".

## Better detection
- **IC cards:**
  - Scans and photos with patterned backgrounds get a second, cleaned-up OCR pass.
  - Pictures pasted into typed PDFs are now OCR'd too, for example an IC copy in a Word document.
  - The name and address lines on the card are recognised.
- **Names:**
  - Labels without a colon: `NAME   LIM SIEW LING`.
  - Any letter case after a colon: `Name: tan wei ming`.
  - More labels, such as "Nama Pemegang Akaun".
  - "Name"/"Nama" table columns.
  - Common Malaysian names without any label: Chinese surname + given names, Mohd/Nur/Siti… names, and s/o and d/o.
  - Street and building names, like Jalan Raja Muda…, are ignored.
- **Account numbers:**
  - The label can be on the same line, on the line above, or in an "Account No." table column.
  - Lengths of 8–17 digits.
  - After "Account No.:" any account-like value is taken, e.g. `ACC-00012345678`.
- **Passport and date of birth:** also found under table column headers.

## Faster export
- The final safety check now proves each black box is solid black from its pixels. OCR runs only on boxes that aren't solid, and the OCR engine isn't loaded at all when every box is solid. In tests, this check was about 7× faster.
- The redaction engine starts loading as soon as the Export dialog opens.
- Settings → Advanced → technical report now shows how long each export step took.

## Verify the download
- APK SHA-256: `[INSERT_SHA256]`
- Signing certificate SHA-256: `395b52869fcc17a94178e02f5cd43f919d18a8f5cf68eb7615f01cde29be1d03`. This is the same key as 1.0.0, so it installs over the old version.

## Licence
Source: GPL-3.0-or-later. The APK bundles MuPDF, so it is distributed under AGPL-3.0-or-later; the complete source is this repository at tag `v1.1.0`. See THIRD_PARTY_NOTICES.md.

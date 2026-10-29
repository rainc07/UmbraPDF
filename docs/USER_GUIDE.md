# Umbra PDF user guide

Umbra PDF blacks out (redacts) sensitive parts of a PDF and saves a clean copy. It works fully offline: your files never leave your device, and the app has no internet permission at all.

## 1. Open a PDF
Tap **Open a PDF** on the start screen. You can also use "Open with → Umbra PDF" from a file manager. Password-protected PDFs ask for the password, which is only kept in memory.

With a document open, **Find**, **Auto Detect** and **Export** are at the top right, and **←** (or the Back button) returns to the start screen. Settings are on the start screen.

## 2. Redact by hand
- A document opens in **Scroll** mode. Pick **Redact** in the bottom bar (or swipe right on the Scroll | Redact switch), then drag a box over anything you want hidden.
- Tap a box to select it, then tap **×** to remove it. **Undo** reverts your last step and **Redo** puts it back. **Reset** removes every box on every page (it asks first, and Undo brings them back).
- Switch back to **Scroll** (or swipe left on the switch) to move around the page without drawing.
- **Zoom:** pinch with two fingers (works in Redact mode too; two fingers never draw a box), double-tap to switch between fit-to-width and close-up, or use **−** / **+**. On a computer, Ctrl + mouse wheel or a trackpad pinch also zoom.

## 3. Manual find & redact (search)
Tap **Find**, type a word or phrase, and tap **Find**.
- **Match case**: only matches the exact upper/lower case.
- **Whole word**: `ali` finds "Ali" but not "Alice".
- Each search is kept as a filter chip under the box, so you can search several words in a row (for example each part of a name). Tap **×** on a chip to remove that word and its matches.
- Every match is outlined on the page. Tap **Redact** on one row, or **Redact (n)** for all selected matches (this also closes the panel).
- Matches that are already fully redacted aren't offered again, so nothing gets redacted twice.
- Scanned pages (photos or scans with no real text) are read with on-device text recognition (OCR) first, so the first search is slower.

## 4. Auto find & redact (personal details)
Tap **Auto Detect**, then **Scan document** at the top. **Advanced config** (collapsed by default) lets you turn detectors on or off and add custom patterns.

| Detector | Examples |
|---|---|
| NRIC (MyKad) | 900101-14-5678, 900101145678 |
| Phone | +60 12-345 6789, 012-3456789, 03-2161 2345 |
| Email | name@example.com |
| Card number | 13–19 digits, checked with the Luhn checksum |
| Bank account | 8–17 digits labelled "Account No.", "No. Akaun", "A/C", "akaun" or "bank": on the same line, on the line above, or as the column header of a table. After "Account No.:" any account-like value is taken, e.g. ACC-00012345678 |
| Passport | A12345678 / H… / K…, or any ID labelled "passport" (also as a table column) |
| Date of birth | dates labelled "birth", "DOB" or "lahir" (also as a table column) |
| Company reg. no. | 202001012345, 1234567-K, LLP0012345-LGN (a 12-digit number next to "Sdn Bhd / SSM / company" counts as a company number, next to "IC / NRIC / MyKad" as an NRIC) |
| Tax no. (TIN) | LHDN numbers: IG12345678090 (also old SG/OG). Organisation numbers (C, D, E, F, PT, TA…) when labelled "TIN", "No. Cukai", "Income tax" or "LHDN" |
| Name | after a label, with or without a colon ("Name:", "NAME  …", "Nama Pemegang Akaun:", "Holder:", "Tenant:"…; after a colon in any letter case), under a "Name"/"Nama" table column, after a title (Encik, Puan, Mr, Dr, Dato'…), with bin/binti/a/l/a/p/s/o/d/o, common Malaysian names without any label (e.g. Tan Kok Keong, Mohd Azman Ismail), and the name line on an IC. "Bank name:", "Company name:" and street names (Jalan Raja Muda…) are ignored |
| Address | after "Address:" / "Alamat:" / "Premises:", or street lines (Jalan, Taman, Lorong…) ending with a postcode and town, e.g. 52100 Kepong, KL, including the address block on an IC |
| Vehicle plate (off by default) | WXY 1234, VAB 123 C. Never amounts like RM 2700. By default only next to a label like "vehicle", "kenderaan" or "plate" (see Settings) |
| Custom pattern | your own regular expression, e.g. `EMP-\d{5}` |

**ID cards and other pictures:** scanned pages, photos and pictures pasted into a typed document (for example a copy of an IC in a Word file saved as PDF) are read with on-device OCR. Hard backgrounds such as the patterned print on a MyKad get a second, cleaned-up OCR pass. This takes a few extra seconds per picture.

**Scanning in the background (Android):** scanned pages start being read as soon as you open the document, and reading carries on if you switch to another app, with a progress notification. When a scan finishes while you're away, a notification says it's ready to review. To stop a scan, tap **Stop** in the panel or press Back; pages already read are kept, so scanning again picks up where it stopped.

How the review works:
- **Amber dashed box**: will be redacted.
- **Grey striped box**: skipped (out of scope); it stays visible.
- Untick a row, or tap its box on the page, to skip it. Nothing is changed until you tap **Redact**.
- **Repeats:** every detail Auto Detect finds is also searched for across the whole document, so a name found next to "Tenant:" on page 7 is also caught on the cover page where it has no label. These show as e.g. "Name · repeat".
- Scanning again only offers items that aren't redacted yet.
- **Redacted** tab: everything you redacted from Find or Auto Detect. Untick an item to remove its black box again, or tick it to put it back. It stays available until you close the document.
- The **By type** tab groups results (e.g. "Vehicle plate 3"). Tap a type to include or skip all of it, or **×** to remove it from the results.
- On small screens, tap or drag the handle at the top of the panel (or its title) to shrink it to a bar and see more of the page.
- In landscape the panel sits beside the document instead: drag its inner edge to make it wider or narrower (20–45% of the screen), and tap **⇄** to move it to the other side. Both are remembered.
- Removing an auto-detected box on the page (or with Undo/Reset) also unticks it in the **Redacted** list.

> Auto Detect is a helper, not a guarantee. Uncommon names without a label, blurry photos and unusual address layouts can be missed. Always look over every page before exporting, and use **Find** for anything it misses.

## 5. Export a redacted copy
Tap **Export** at the top right. Your choices are remembered for next time. First pick a method:

- **Keep original text** (recommended): Umbra removes the text, shapes and image parts under your boxes from the file itself and keeps everything else as it was. The copy looks exactly like the original, stays small, and all visible text can still be selected and searched. Filled-in form fields stay visible as normal text but are no longer editable. Links, attachments, comments and file details are removed.
- **Image only** (maximum safety): every page becomes a picture with the boxes burned in. Nothing else from the original file is kept. Files are larger, and text can only be searched with the OCR option below.

Image only options:
- **Quality**: 300 DPI ("High") is recommended. Lower means a smaller file and faster export. 600 DPI ("Print") makes each page four times larger, so exporting takes noticeably longer and uses more memory.
- **Compression**: "Sharp (best for text)" is lossless (grey pages are stored compactly); "Photo (JPEG)" suits pages that are mostly photos.
- **Keep text selectable & searchable (OCR)**: on by default. When on, Umbra reads the *visible* text of each finished page on your device and adds an invisible text layer, so the saved PDF can be searched and copied from like a normal PDF. Blacked-out parts are never included, because the text is read from the already-blacked-out image, and words touching a black box are dropped too. It takes longer, and recognition can make small mistakes in the selectable text (the page image itself is unaffected).

### What happens when you save
1. **Keep original text:** everything under each box is deleted from the PDF and a black box is drawn in its place; the file is then rebuilt from scratch without links, forms, attachments, scripts, hidden descriptions or file details. **Image only:** every page is turned into a picture with your black boxes burned in, and a brand-new PDF is built from those pictures.
2. Umbra then checks the new file automatically: no copyable text under the boxes (or none at all, if searchable mode is off), no fonts except the plain one used for the searchable layer, no links, forms, attachments or extra file details, and every black box is really solid black in the finished file (any box that isn't is read with OCR, and readable text there fails the check).
3. If every check passes you'll see **Safe to share**, then **Save PDF** opens the system save dialog. If anything fails, Umbra **does not save** the file.

## 6. Split into several files
In **Export**, pick **Keep original text** or **Image only** (with or without OCR) as usual, then turn on **Split into several files**:
- **Per page**: one file for every page, or for every *n* pages ("Pages in each file").
- **Ranges**: one file per range you type, for example `1-3, 5, 8-` (`8-` means page 8 to the end). Pages you don't list are left out.
- **Halves**: for scans with two pages side by side. You get one PDF with each page cut into **Left | Right** or **Top / Bottom**. **Only cut pages that are wider than tall** keeps a cover or single page whole, and **Right page first** is for books read right to left.

The parts are always cut from the redacted copy after it passed the safety check, never from the original. Cutting takes a moment: pages are copied, not rendered again, and a cut half keeps the whole page in the file and shows only its half, so the file stays about the size of the copy. Exporting again with the same boxes and settings (for example once whole, then split) reuses the checked copy, so it's almost instant.

**Saving:** on Android, pick a folder and every part is saved there. In the desktop web app, Chrome and Edge ask for a folder too (existing files are never overwritten); other browsers download one ZIP. Files are named after the document, for example `report-redacted-p01.pdf`, `report-redacted-p1-3.pdf` or `report-redacted-halves.pdf`.

**Speed tip:** for a PDF with real text (not a scan), **Keep original text** is fast and stays searchable. **Image only** with OCR reads every page again from its picture, so it takes a few seconds per page.

## 7. Going back
The Android **Back** button closes an open dialog or panel first, then returns to the start screen. If you have redactions that haven't been exported, Umbra asks before leaving.

## 8. Settings
- **Appearance**: System (default), Light or Dark.
- **Preferences**:
  - **Close the panel after Redact** (on)
  - **Ask before leaving unsaved work** (on)
  - **Remind me to check every page** (on): a reminder in the Export sheet
  - **Vehicle plates only when labelled** (on): fewer false matches
  - **Hide content in Recent apps** (off): blanks the app-switcher preview; this also blocks screenshots. It applies from the moment the app opens. On the Android emulator, the emulator's own screenshot and recording buttons capture the screen from outside Android and are not blocked; test it on a real phone or through the Recent apps screen.
- **Show technical check report** (Advanced): shows the full verification details after saving, for IT staff or troubleshooting. The checks always run; this only controls what you see.

## Privacy
- No internet permission, no accounts, no analytics, no ads.
- Temporary copies of opened files are stored in the app's private cache and deleted when you're done.
- Settings (theme, detector choices, custom patterns) are stored privately on the device and are not backed up. If you type a real name into a custom pattern, it stays on the phone.
- Screenshots are allowed, so the document can also appear in the Recent apps preview.

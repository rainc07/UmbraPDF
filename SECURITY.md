# Security policy

Umbra PDF exists to stop sensitive information from leaking, so security reports are very welcome.

## Reporting a vulnerability
Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") with:
- what you found and its impact (for example, text recoverable from an exported PDF),
- steps or a sample file to reproduce it (please use fake data),
- the app version and Android version.

You'll get an acknowledgement within 7 days. Fixes are released as soon as practical, with credit if you want it.

## Scope
In scope:
- Any way to recover redacted content from an exported PDF.
- Exported files passing verification while still carrying text, fonts, annotations, forms, attachments, scripts or metadata from the source.
- Network access of any kind, or a way for a PDF to run code or reach the Android bridge.
- Leaking document data outside the app's private storage.

Out of scope:
- Auto-detect missing an item (please open a normal issue with a fake example instead).
- Problems that need a rooted or already-compromised device.
- A custom regex that makes the app slow on your own device.

## Design summary
See [README → Security model](README.md#security-model).

# Third-party notices
Umbra PDF's own source code is GPL-3.0-or-later. The app bundles MuPDF, which is **AGPL-3.0-or-later**, so the built app (APK) as a whole is distributed under the terms of the AGPL-3.0-or-later. GPLv3 explicitly allows combining with AGPLv3 code. In practice this means anyone who distributes the app, or offers a modified version to users over a network, must also offer its complete source code, which this public repository already does.

| Component | License |
|---|---|
| MuPDF (mupdf.js 1.28.0, WebAssembly), used for "Keep original text" redaction | AGPL-3.0-or-later (© Artifex Software) |
| pdf.js (pdfjs-dist 6.3.289), incl. core-js polyfills | Apache-2.0 (core-js: MIT) |
| pdf.js wasm: OpenJPEG / JBIG2 / QCMS | BSD-2-Clause / Apache-2.0 / MIT (see `vendor/pdfjs/wasm/LICENSE_*`) |
| pdf-lib 1.17.1 | MIT |
| tesseract.js 6.0.1 | Apache-2.0 |
| tesseract.js-core 6.0.0 (Tesseract OCR, Leptonica) | Apache-2.0 / BSD-2-Clause |
| Tesseract `eng.traineddata` (4.0.0_best_int) | Apache-2.0 |
| onnxruntime-web 1.30.0 (ONNX Runtime) | MIT |
| onnxruntime-node 1.30.0 (ONNX Runtime, incl. DirectML on Windows), desktop web app only (`web/`) | MIT |
| PaddleOCR PP-OCRv5 mobile models: `PP-OCRv5_mobile_det`, `en_PP-OCRv5_mobile_rec`, `PP-OCRv5_mobile_rec` (Chinese) + dictionaries (ONNX conversions from huggingface.co/ilaylow/PP_OCRv5_mobile_onnx and huggingface.co/monkt/paddleocr-onnx) | Apache-2.0 |
| AndroidX core, activity, webkit | Apache-2.0 |

Full license texts ship with each package (`core/node_modules/*/LICENSE`, `app/src/main/assets/web/vendor/**/LICENSE*`).

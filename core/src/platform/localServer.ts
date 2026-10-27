// Umbra PDF served by the desktop server (web/): text is read by the native OCR engine there (ONNX Runtime for
// Node, same models and steps as Android's PpOcr.kt), over the same messages as the Android bridge.
// Served any other way (dev server, tests), the page has no umbra-server mark and the in-browser engine is used.
import { offerNativeOcr, type NativePort } from '../engine/ppocr';

export function useLocalServerOcr(): void {
  if (!document.querySelector('meta[name="umbra-server"]')) return;
  offerNativeOcr(async () => {
    const r = await fetch('api/caps', { cache: 'no-store' });
    if (!r.ok || !/json/.test(r.headers.get('content-type') ?? '')) return null;
    const caps = (await r.json()) as { native?: boolean };
    if (!caps.native) return null;
    const port: NativePort = {
      onmessage: null,
      postMessage(m) {
        const id = typeof m === 'string' ? (JSON.parse(m) as { id: number }).id : new Int32Array(m, 0, 1)[0];
        fetch('api/ocr', { method: 'POST', body: m, headers: { 'content-type': typeof m === 'string' ? 'application/json' : 'application/octet-stream' } })
          .then((x) => (x.ok ? x.text() : Promise.reject(new Error(`OCR server: HTTP ${x.status}`))))
          .catch((e: Error) => JSON.stringify({ id, ok: false, error: e.message || 'OCR server unreachable' }))
          .then((data) => port.onmessage?.({ data }));
      },
    };
    return { port, binary: true };
  });
}

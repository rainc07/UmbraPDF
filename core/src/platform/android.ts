import type { Host, Insets, OpenedFile } from './host';

/** Kotlin side: app.umbrapdf.UmbraBridge (@JavascriptInterface). */
interface AndroidBridge {
  ready(): void;
  pickPdf(): void;
  beginSave(): string;
  appendChunk(id: string, base64: string): boolean;
  commitSave(id: string, suggestedName: string): void;
  release(token: string): void;
  getPrefs?(): string;
  setPrefs?(json: string): void;
  systemDark?(): boolean;
  setBarStyle?(dark: boolean): void;
  insets?(): string;
  setSecure?(on: boolean): void;
}

/** Kotlin -> JS callbacks (evaluateJavascript). */
interface HostCallbacks {
  onPicked(json: string): void;
  onSaved(json: string): void;
  onInsets?(json: string): void;
  onSystemTheme?(dark: boolean): void;
  /** Called by Kotlin on Back; return value comes back through evaluateJavascript. */
  onBack?(): boolean;
}

declare global {
  interface Window { UmbraAndroid?: AndroidBridge; __umbraHost?: HostCallbacks }
}

const CHUNK = 512 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function createAndroidHost(): Host | null {
  const bridge = window.UmbraAndroid;
  if (!bridge) return null;

  let pendingPick: ((f: OpenedFile | null) => void) | null = null;
  let pendingSave: ((ok: boolean) => void) | null = null;
  let externalCb: ((f: OpenedFile) => void) | null = null;
  let insetsCb: ((i: Insets) => void) | null = null;
  let themeCb: ((dark: boolean) => void) | null = null;
  let backCb: (() => boolean) | null = null;
  const parseInsets = (json: string): Insets | null => {
    try { const v = JSON.parse(json) as Insets; return typeof v.top === 'number' ? v : null; } catch { return null; }
  };

  /** Kotlin serves picked file bytes at a same-origin URL; fetch then release. */
  async function load(msg: { url: string; name: string; token: string }): Promise<OpenedFile> {
    try {
      const r = await fetch(msg.url);
      if (!r.ok) throw new Error(`Read failed (${r.status})`);
      return { name: msg.name, bytes: new Uint8Array(await r.arrayBuffer()) };
    } finally {
      bridge!.release(msg.token);
    }
  }

  window.__umbraHost = {
    onPicked: async (json) => {
      const msg = JSON.parse(json) as { ok: boolean; url: string; name: string; token: string; external?: boolean };
      if (!msg.ok) { pendingPick?.(null); pendingPick = null; return; }
      const file = await load(msg);
      if (msg.external || !pendingPick) externalCb?.(file);
      else { pendingPick(file); pendingPick = null; }
    },
    onSaved: (json) => {
      const msg = JSON.parse(json) as { ok: boolean };
      pendingSave?.(msg.ok);
      pendingSave = null;
    },
    onInsets: (json) => { const i = parseInsets(json); if (i) insetsCb?.(i); },
    onSystemTheme: (dark) => themeCb?.(dark),
    onBack: () => (backCb ? backCb() : false),
  };

  return {
    name: 'android',
    openPdf: () => new Promise((resolve) => { pendingPick = resolve; bridge.pickPdf(); }),
    savePdf: (name, bytes) =>
      new Promise((resolve) => {
        const id = bridge.beginSave();
        for (let i = 0; i < bytes.length; i += CHUNK) {
          if (!bridge.appendChunk(id, toBase64(bytes.subarray(i, i + CHUNK)))) return resolve(false);
        }
        pendingSave = resolve;
        bridge.commitSave(id, name);
      }),
    onExternalOpen: (cb) => { externalCb = cb; bridge.ready(); },
    // Optional chaining: an older shell without these methods still works.
    loadPrefs: () => { try { return bridge.getPrefs?.() || null; } catch { return null; } },
    savePrefs: (json) => { try { bridge.setPrefs?.(json); } catch { /* ignore */ } },
    systemDark: () => { try { return bridge.systemDark ? bridge.systemDark() : null; } catch { return null; } },
    onSystemTheme: (cb) => { themeCb = cb; },
    setBarStyle: (dark) => { try { bridge.setBarStyle?.(dark); } catch { /* ignore */ } },
    onBack: (cb) => { backCb = cb; },
    setSecure: (on) => { try { bridge.setSecure?.(on); } catch { /* ignore */ } },
    onInsets: (cb) => {
      insetsCb = cb;
      try { const i = bridge.insets ? parseInsets(bridge.insets()) : null; if (i) cb(i); } catch { /* ignore */ }
    },
  };
}

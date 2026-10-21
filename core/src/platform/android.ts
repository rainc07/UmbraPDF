import type { Host, Insets, NativeScan, OpenedFile } from './host';

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
  workStart?(title: string): void;
  workProgress?(text: string, pct: number): void;
  workDone?(title: string, text: string): void;
  scanStart?(token: string, pagesJson: string): boolean;
  scanTake?(index: number): string;
  scanCancel?(): void;
  scanReset?(): void;
}

/** Kotlin -> JS callbacks (evaluateJavascript). */
interface HostCallbacks {
  onPicked(json: string): void;
  onSaved(json: string): void;
  onInsets?(json: string): void;
  onSystemTheme?(dark: boolean): void;
  /** Called by Kotlin on Back; return value comes back through evaluateJavascript. */
  onBack?(): boolean;
  /** A page of the native scan was read. */
  onScanPage?(index: number): void;
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
  let lastProgress = 0;
  // The open document's staged file stays with Kotlin while it's open, so the native scan can read it.
  let docToken: string | null = null;
  let scanCb: ((i: number) => void) | null = null;
  const dropDoc = () => {
    if (!docToken) return;
    try { bridge.scanReset?.(); } catch { /* ignore */ }
    bridge.release(docToken);
    docToken = null;
  };
  const parseInsets = (json: string): Insets | null => {
    try { const v = JSON.parse(json) as Insets; return typeof v.top === 'number' ? v : null; } catch { return null; }
  };

  /**
   * Kotlin serves picked file bytes at a same-origin URL. The file stays staged while it's the open document
   * (the native scan reads it); without native scanning it's released at once.
   */
  async function load(msg: { url: string; name: string; token: string }): Promise<OpenedFile> {
    let keep = false;
    try {
      const r = await fetch(msg.url);
      if (!r.ok) throw new Error(`Read failed (${r.status})`);
      const file = { name: msg.name, bytes: new Uint8Array(await r.arrayBuffer()) };
      if (bridge!.scanStart) { dropDoc(); docToken = msg.token; keep = true; }
      return file;
    } finally {
      if (!keep) bridge!.release(msg.token);
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
    onScanPage: (i) => scanCb?.(i),
  };

  /** Bound to one document: once another is opened (or it's closed), its pages read as failed (the page reads them). */
  const scanFor = (token: string): NativeScan => {
    const gone = () => docToken !== token;
    return {
      start: (pages) => { try { return !gone() && !!bridge.scanStart?.(token, JSON.stringify(pages)); } catch { return false; } },
      take: (i) => { if (gone()) return '{"ok":false,"error":"closed"}'; try { return bridge.scanTake?.(i) ?? ''; } catch { return ''; } },
      cancel: () => { if (!gone()) try { bridge.scanCancel?.(); } catch { /* ignore */ } },
      reset: () => { if (!gone()) try { bridge.scanReset?.(); } catch { /* ignore */ } },
      onPage: (cb) => { scanCb = cb; },
    };
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
    workStart: (title) => { lastProgress = 0; try { bridge.workStart?.(title); } catch { /* ignore */ } },
    workProgress: (text, f) => {
      const now = Date.now();
      if (now - lastProgress < 800) return; // the notification needn't update more than about once a second
      lastProgress = now;
      try { bridge.workProgress?.(text, Math.round(Math.max(0, Math.min(1, f)) * 100)); } catch { /* ignore */ }
    },
    workDone: (title, text) => { try { bridge.workDone?.(title, text); } catch { /* ignore */ } },
    nativeScan: () => (docToken && bridge.scanStart ? scanFor(docToken) : null),
    closeFile: dropDoc,
    onInsets: (cb) => {
      insetsCb = cb;
      try { const i = bridge.insets ? parseInsets(bridge.insets()) : null; if (i) cb(i); } catch { /* ignore */ }
    },
  };
}

import type { Host, OpenedFile } from './host';

const PREFS_KEY = 'umbra.prefs.v1';

/** Plain browser / dev-server host. */
export function createBrowserHost(): Host {
  return {
    name: 'browser',
    openPdf: () =>
      new Promise<OpenedFile | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf,.pdf';
        input.onchange = async () => {
          const f = input.files?.[0];
          resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
        };
        input.oncancel = () => resolve(null);
        input.click();
      }),
    savePdf: async (name, bytes) => {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    },
    onExternalOpen: () => {},
    loadPrefs: () => { try { return localStorage.getItem(PREFS_KEY); } catch { return null; } },
    savePrefs: (json) => { try { localStorage.setItem(PREFS_KEY, json); } catch { /* storage unavailable */ } },
    systemDark: () => null,
    onSystemTheme: () => {},
    setBarStyle: () => {},
    onInsets: () => {},
    onBack: () => {},
    setSecure: () => {},
  };
}

import type { Host, OpenedFile } from './host';
import { useLocalServerOcr } from './localServer';
import { zip } from './zip';

const PREFS_KEY = 'umbra.prefs.v1';

interface DirHandle {
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(b: BlobPart): Promise<void>; close(): Promise<void> }> }>;
}
type DirPicker = (o: { mode: 'readwrite'; id?: string }) => Promise<DirHandle>;
type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) =>
  Promise<{ createWritable(): Promise<{ write(b: BlobPart): Promise<void>; close(): Promise<void> }> }>;

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const opened = async (f: File): Promise<OpenedFile> => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });

function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Plain browser host: the desktop web app (web/ server), the dev server and the tests. */
export function createBrowserHost(): Host {
  useLocalServerOcr();
  const appTitle = document.title;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = appTitle; });
  return {
    name: 'browser',
    openPdf: () =>
      new Promise<OpenedFile | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf,.pdf';
        input.onchange = async () => {
          const f = input.files?.[0];
          resolve(f ? await opened(f) : null);
        };
        input.oncancel = () => resolve(null);
        input.click();
      }),
    savePdf: async (name, bytes) => {
      // A real Save As dialog where the browser has one (Chrome, Edge); otherwise a download.
      const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (pick) {
        try {
          const h = await pick({ suggestedName: name, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
          const w = await h.createWritable();
          await w.write(bytes as BlobPart);
          await w.close();
          return true;
        } catch (e) {
          if ((e as Error).name === 'AbortError') return false;
          // No permission (e.g. the click is too long ago): fall back to a download.
        }
      }
      download(name, bytes, 'application/pdf');
      return true;
    },
    saveFiles: async (zipName, files) => {
      // Chrome, Edge: save into a folder the user picks. Existing files are never overwritten ("name (2).pdf").
      const pickDir = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
      if (pickDir) {
        let dir: DirHandle | null = null;
        try { dir = await pickDir({ mode: 'readwrite', id: 'umbra-split' }); } catch (e) {
          if ((e as Error).name === 'AbortError') return false;
          // No permission (e.g. the click is too long ago): fall back to a ZIP download.
        }
        if (dir) {
          for (const f of files) {
            let name = f.name;
            for (let k = 2; await dir.getFileHandle(name).then(() => true, () => false); k++) name = f.name.replace(/(\.pdf)?$/i, ` (${k})$1`);
            const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
            await w.write(f.bytes as BlobPart);
            await w.close();
          }
          return files.length;
        }
      }
      download(zipName, zip(files), 'application/zip');
      return files.length;
    },
    // A PDF dropped on the window opens like Android's "Open with".
    onExternalOpen: (cb) => {
      const files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
      window.addEventListener('dragover', (e) => { if (files(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
      window.addEventListener('drop', async (e) => {
        if (!files(e)) return;
        e.preventDefault();
        const f = [...e.dataTransfer!.files].find(isPdf);
        if (f) cb(await opened(f));
      });
    },
    loadPrefs: () => { try { return localStorage.getItem(PREFS_KEY); } catch { return null; } },
    savePrefs: (json) => { try { localStorage.setItem(PREFS_KEY, json); } catch { /* storage unavailable */ } },
    systemDark: () => null,
    onSystemTheme: () => {},
    setBarStyle: () => {},
    onInsets: () => {},
    // Esc does what Android Back does: close the dialog or panel, stop a scan, leave the document.
    onBack: (cb) => {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !e.repeat && cb()) e.preventDefault();
      });
    },
    setSecure: () => {},
    // Long work in a background tab: progress in the tab title, a notification when it's done.
    workStart: () => {
      try { if (Notification.permission === 'default') void Notification.requestPermission().catch(() => {}); } catch { /* no notifications */ }
    },
    workProgress: (_text, f) => { if (document.hidden) document.title = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}% · ${appTitle}`; },
    workDone: (title, text) => {
      document.title = appTitle;
      if (!document.hidden) return;
      try {
        if (Notification.permission !== 'granted') return;
        const n = new Notification(title, { body: text, tag: 'umbra-work', icon: 'favicon.svg' });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* no notifications */ }
    },
  };
}

/** Host abstraction: the only place the core touches platform file I/O. */
export interface OpenedFile { name: string; bytes: Uint8Array }

/** A page for the host to read natively: bitmap size (px) and page size in points (geometry check). */
export interface ScanPage { i: number; w: number; h: number; pw: number; ph: number; n: number /* pages in the document */ }

/**
 * Native reading of scanned pages (Android), which keeps going while the app is in the background.
 * Results are lines in page pixels, grouped in blocks of print (see NativeScan.kt), taken one page at a time.
 */
export interface NativeScan {
  /** Read these pages of the document opened last (pages already read are skipped). False: not possible. */
  start(pages: ScanPage[]): boolean;
  /** A page's result as JSON, or '' if it hasn't been read (yet). */
  take(index: number): string;
  cancel(): void;
  /** Forget the open document's pages. */
  reset(): void;
  onPage(cb: (index: number) => void): void;
}

export interface Host {
  readonly name: 'android' | 'browser' | 'tauri';
  /** Ask the user for a PDF. Resolves null on cancel. */
  openPdf(): Promise<OpenedFile | null>;
  /** Ask the user where to save. Resolves false on cancel. */
  savePdf(suggestedName: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * Save several files at once (a split). Android: the user picks a folder. Browser: a folder where it can, else one ZIP.
   * Resolves the number of files saved, or false on cancel.
   */
  saveFiles?(zipName: string, files: OpenedFile[]): Promise<number | false>;
  /** Files pushed in by the host (e.g. Android "Open with"). */
  onExternalOpen(cb: (f: OpenedFile) => void): void;
  /** Small persistent settings blob (JSON string). */
  loadPrefs(): string | null;
  savePrefs(json: string): void;
  /** System dark mode, if the host knows better than prefers-color-scheme. */
  systemDark(): boolean | null;
  onSystemTheme(cb: (dark: boolean) => void): void;
  /** Tell the host which theme is showing (status/nav bar icon colours). */
  setBarStyle(dark: boolean): void;
  /** Safe-area insets in CSS px (status bar, nav bar, cutouts). null = use CSS env(). */
  onInsets(cb: (i: Insets) => void): void;
  /** System Back. Return true if handled in-app; false lets the OS act (leave the app). */
  onBack(cb: () => boolean): void;
  /** Hide content from Recent apps / screenshots (Android FLAG_SECURE). */
  setSecure(on: boolean): void;
  /**
   * Long work (scan, export): the host keeps it running if the user leaves the app and shows progress,
   * then says when it's ready. Titles/texts are generic (never document content). Optional.
   */
  workStart?(title: string): void;
  workProgress?(text: string, fraction: number): void;
  workDone?(title: string, text: string): void;
  /** Native page reading for the document opened last (only when the host can read the file itself). */
  nativeScan?(): NativeScan | null;
  /** The document opened last is closed: the host may drop its copy. */
  closeFile?(): void;
}

export interface Insets { top: number; bottom: number; left: number; right: number }

import { createAndroidHost } from './android';
import { createBrowserHost } from './browser';

export function detectHost(): Host {
  // TODO(phase-3): Tauri host via window.__TAURI__
  return createAndroidHost() ?? createBrowserHost();
}

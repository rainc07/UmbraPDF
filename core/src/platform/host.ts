/** Host abstraction: the only place the core touches platform file I/O. */
export interface OpenedFile { name: string; bytes: Uint8Array }

export interface Host {
  readonly name: 'android' | 'browser' | 'tauri';
  /** Ask the user for a PDF. Resolves null on cancel. */
  openPdf(): Promise<OpenedFile | null>;
  /** Ask the user where to save. Resolves false on cancel. */
  savePdf(suggestedName: string, bytes: Uint8Array): Promise<boolean>;
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
}

export interface Insets { top: number; bottom: number; left: number; right: number }

import { createAndroidHost } from './android';
import { createBrowserHost } from './browser';

export function detectHost(): Host {
  // TODO(phase-3): Tauri host via window.__TAURI__
  return createAndroidHost() ?? createBrowserHost();
}

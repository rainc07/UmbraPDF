// Scanned pages read by the host (Android: NativeScan.kt), so reading keeps going while the app is in the
// background. The web core takes each page's result when it needs it; ID-card pages and pages the host
// couldn't read are read here as before.
import type { PDFDocumentProxy } from '../engine/pdf';
import { defaultOcrDpi, MIN_TEXT_CHARS, ocrScale } from '../engine/search';
import { getOcrEngine, lastOcrStats, type OcrWord } from '../engine/ocr';
import { cardLike, wordsFromBlocks } from '../engine/ppocr';
import type { PpLine } from '../engine/ppocr.worker';
import type { NativeScan, ScanPage } from './host';

type Waiter = { res: (s: string) => void; rej: (e: Error) => void };
type Reply = { ok: boolean; error?: string; blocks?: PpLine[][];
  ms?: { render: number; total: number; islands: number; det: number; rec: number; retry: number; threads: number } };

export class NativeReader {
  private pages = new Map<number, ScanPage & { scale: number }>();
  private waiting = new Map<number, Waiter[]>();
  private poll = 0;
  private active = false;

  private constructor(private scan: NativeScan) {
    scan.onPage((i) => this.check(i));
  }

  /** Start reading the document's scanned pages natively. Null when there are none, or the host can't. */
  static async start(doc: PDFDocumentProxy, scan: NativeScan | null | undefined): Promise<NativeReader | null> {
    if (!scan || getOcrEngine() !== 'paddle') return null;
    const r = new NativeReader(scan);
    const dpi = defaultOcrDpi();
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      // Same test as the page text (fewer than MIN_TEXT_CHARS letters: scanned), without measuring the text.
      const tc = await page.getTextContent();
      const chars = tc.items.map((it) => ('str' in it ? it.str : '')).join('').replace(/\s/g, '').length;
      if (chars >= MIN_TEXT_CHARS) continue;
      const scale = ocrScale(page, dpi), vp = page.getViewport({ scale }), base = page.getViewport({ scale: 1 });
      r.pages.set(i, { i, w: Math.max(1, Math.ceil(vp.width)), h: Math.max(1, Math.ceil(vp.height)), pw: base.width, ph: base.height, scale });
    }
    return r.pages.size && r.resume() ? r : null;
  }

  /** (Re)start reading the pages not read yet (after a stopped scan). */
  resume(): boolean {
    return (this.active = this.scan.start([...this.pages.values()].map(({ i, w, h, pw, ph }) => ({ i, w, h, pw, ph }))));
  }

  /** Stop reading. Pages already read stay available; anyone waiting for another page gets an AbortError. */
  cancel(): void {
    this.active = false;
    this.scan.cancel();
    const ws = [...this.waiting.values()].flat();
    this.waiting.clear();
    this.stopPoll();
    ws.forEach((w) => w.rej(new DOMException('Stopped', 'AbortError')));
  }

  /** A page read natively, as words in px at `scale`; null to read it in the web core (not scanned, failed, ID card). */
  async words(i: number): Promise<{ words: OcrWord[]; scale: number } | null> {
    const p = this.pages.get(i);
    if (!p) return null;
    let s = this.scan.take(i);
    if (!s && !this.active) return null; // stopped before this page: read it here
    s ||= await new Promise<string>((res, rej) => {
      (this.waiting.get(i) ?? this.waiting.set(i, []).get(i)!).push({ res, rej });
      // Results also arrive by onPage; polling covers pages read while the page's scripts were frozen.
      this.poll ||= window.setInterval(() => [...this.waiting.keys()].forEach((k) => this.check(k)), 1000);
    });
    const r = JSON.parse(s) as Reply;
    if (!r.ok) { lastOcrStats.log.push(`page ${i + 1}: native read failed (${r.error}), reading here`); return null; }
    const m = r.ms!;
    lastOcrStats.log.push(`page ${i + 1} ${p.w}x${p.h} (native ${m.threads} threads): ${m.total} ms = render ${m.render} + ${m.islands} block(s): det ${m.det} + rec ${m.rec} + retry ${m.retry}`);
    const words = wordsFromBlocks(r.blocks!);
    if (cardLike(words)) { lastOcrStats.log.push(`page ${i + 1}: ID card wording, reading again with the card search`); return null; }
    return { words, scale: p.scale };
  }

  private check(i: number) {
    const ws = this.waiting.get(i);
    if (!ws) return;
    const s = this.scan.take(i);
    if (!s) return;
    this.waiting.delete(i);
    if (!this.waiting.size) this.stopPoll();
    ws.forEach((w) => w.res(s));
  }

  private stopPoll() { window.clearInterval(this.poll); this.poll = 0; }
}

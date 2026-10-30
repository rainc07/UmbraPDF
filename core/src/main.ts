import './ui/styles.css';
import {
  openPdf, closePdf, pageSizes, renderToCanvas, exportRedacted, verifyOutput, ocrRedactedRegions,
  PasswordRequiredError, DEFAULT_EXPORT,
  PageTextCache, pageTextWords, searchDocument, exportVector, exportVectorChecked, loadMuPdf, literalPattern, buildPatterns, compileCustom, PRESETS, DEFAULT_PRESET_IDS,
  normAlways, ALWAYS_MAX, splitPdf, planSplit, SplitRangeError,
  type PDFDocumentProxy, type PageSize, type Rect, type VerifyReport, type ExportOptions,
  type Hit, type SearchPattern, type CustomPattern, type SplitSpec, type SplitPart,
} from './engine';
import { lastOcrStats, resetOcrStats, setOcrEngine, warmUpOcr } from './engine/ocr';
import { getOcrLang, setOcrLang, type OcrLang } from './engine/ppocr';
import { abortable, isAbort } from './engine/search';
import { detectHost, type OpenedFile } from './platform/host';
import { NativeReader } from './platform/nativeRead';

const host = detectHost();
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const viewer = $('#viewer');

type Op = { type: 'add' | 'del'; page: number; rect: Rect; idx: number };
type Action = Op | { type: 'group'; ops: Op[]; sugg?: { gen: number; items: Sugg[] } };
/** A pending (not yet applied) search/detection hit, drawn as a dashed box. */
type Sugg = Hit & { id: number; on: boolean };

const S = {
  doc: null as PDFDocumentProxy | null,
  name: '',
  sizes: [] as PageSize[],
  boxes: [] as Rect[][],
  undo: [] as Action[],
  redo: [] as Action[],
  zoom: 1, // CSS px per PDF point
  mode: 'pan' as 'draw' | 'pan', // Scroll first: a stray touch shouldn't draw a box
  sel: null as { page: number; idx: number } | null,
  rendered: new Set<number>(),
  gen: 0, // invalidates in-flight renders after zoom/open
  busy: false,
  sugg: [] as Sugg[],
  panel: null as 'find' | 'detect' | null,
  texts: null as PageTextCache | null,
  native: null as NativeReader | null, // scanned pages read by the host (keeps going in the background)
  scan: null as AbortController | null, // running Find / Auto Detect scan (Stop)
  scanPanel: null as 'find' | 'detect' | null, // the panel that scan belongs to (it can be closed and opened again meanwhile)
  scanMsg: '',
  prefetch: null as AbortController | null,
  dirty: false, // unsaved redaction changes
  findTerms: [] as { q: string; matchCase: boolean; wholeWord: boolean }[],
  resTab: 'items' as 'items' | 'types' | 'done',
  applied: [] as Sugg[], // items redacted from Find/Auto Detect this session (Redacted tab: untick to un-redact)
  bytes: null as Uint8Array | null, // original file, for "Keep original text" export
  password: undefined as string | undefined,
  /** The last redacted copy that passed the safety check, and what it was made from (boxes + settings). */
  verified: null as { key: string; out: ExportOutcome } | null,
};

// ---------- UI helpers ----------
let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}
/** dismissable: tapping the dimmed background (or Back) closes it. Off for progress and must-answer dialogs. */
let modalDismissable = false;
let modalOnDismiss: (() => void) | null = null;
/** `fill`: on a phone the sheet takes the whole height, so options opening and closing inside it never resize it. */
function modal(html: string, dismissable = false, onDismiss: (() => void) | null = null, fill = false) {
  const wasOpen = !$('#modal').hidden && !$('#modal').classList.contains('closing');
  clearTimeout(modalCloseTimer); $('#modal').classList.remove('closing');
  $('#toast').classList.remove('show'); $('#sheet').innerHTML = html; $('#sheet').onscroll = null; $('#sheet').classList.toggle('fill', fill); $('#modal').hidden = false;
  // Step to step (options → progress → result): cross-fade the content instead of jumping.
  if (wasOpen) $('#sheet').animate?.([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
  modalDismissable = dismissable; modalOnDismiss = onDismiss;
}
let modalCloseTimer = 0;
/** Slide/fade out, then hide. A new modal() during the animation cancels it. */
function closeModal() {
  modalDismissable = false; modalOnDismiss = null;
  const m = $('#modal');
  if (m.hidden || m.classList.contains('closing')) return;
  m.classList.add('closing');
  modalCloseTimer = window.setTimeout(() => {
    m.hidden = true; m.classList.remove('closing'); $('#sheet').innerHTML = '';
  }, 200);
}
function dismissModal(): boolean {
  if ($('#modal').hidden || $('#modal').classList.contains('closing')) return false;
  if (!modalDismissable) return true; // swallow Back while a blocking dialog is up
  const cb = modalOnDismiss; closeModal(); cb?.();
  return true;
}
$('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) dismissModal(); });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function syncToolbar() {
  const has = !!S.doc;
  for (const id of ['#zoom-in', '#zoom-out', '#btn-export']) $<HTMLButtonElement>(id).disabled = !has || S.busy;
  // A running scan's own panel can be closed and opened again (to see progress or Stop).
  $<HTMLButtonElement>('#btn-find').disabled = !has || (S.busy && S.scanPanel !== 'find');
  $<HTMLButtonElement>('#btn-detect').disabled = !has || (S.busy && S.scanPanel !== 'detect');
  $('#btn-find').classList.toggle('on', S.panel === 'find');
  $('#btn-detect').classList.toggle('on', S.panel === 'detect');
  document.querySelectorAll<HTMLButtonElement>('#panel [data-busy]').forEach((b) => { b.disabled = S.busy; });
  $<HTMLButtonElement>('#btn-undo').disabled = !S.undo.length || S.busy;
  $<HTMLButtonElement>('#btn-redo').disabled = !S.redo.length || S.busy;
  $<HTMLButtonElement>('#btn-reset').disabled = !S.boxes.some((b) => b.length) || S.busy;
  document.body.classList.toggle('has-doc', has);
  $('#docname').textContent = has ? S.name : '';
  $('#mode-draw').classList.toggle('on', S.mode === 'draw');
  $('#mode-pan').classList.toggle('on', S.mode === 'pan');
  $('#mode-draw').setAttribute('aria-pressed', String(S.mode === 'draw'));
  $('#mode-pan').setAttribute('aria-pressed', String(S.mode === 'pan'));
  document.body.classList.toggle('draw', S.mode === 'draw');
}

// ---------- Open ----------
async function askPassword(incorrect: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    modal(`<h2>Password required</h2>
      ${incorrect ? '<p class="fail">Incorrect password.</p>' : ''}
      <input id="pw" type="password" autocomplete="off" style="width:100%">
      <div class="row"><button id="pw-cancel">Cancel</button><button id="pw-ok" class="primary">Open</button></div>`, true, () => resolve(null));
    const pw = $<HTMLInputElement>('#pw');
    pw.focus();
    const done = (v: string | null) => { closeModal(); resolve(v); };
    $('#pw-cancel').onclick = () => done(null);
    $('#pw-ok').onclick = () => done(pw.value);
    pw.onkeydown = (e) => { if (e.key === 'Enter') done(pw.value); };
  });
}

async function loadFile(file: OpenedFile) {
  let password: string | undefined;
  let doc: PDFDocumentProxy | null = null;
  for (;;) {
    try { doc = await openPdf(file.bytes, password); break; }
    catch (e) {
      if (!(e instanceof PasswordRequiredError)) { toast(`Could not open PDF: ${(e as Error).message}`, 5000); return; }
      const p = await askPassword(e.incorrect);
      if (p === null) return;
      password = p;
    }
  }
  if (S.doc) await closePdf(S.doc);
  S.doc = doc;
  S.name = file.name.replace(/\.pdf$/i, '') || 'document';
  S.bytes = file.bytes;
  S.password = password;
  S.verified = null;
  docExport = null;
  S.applied = [];
  S.sizes = await pageSizes(doc);
  S.boxes = S.sizes.map(() => []);
  S.undo = [];
  S.redo = [];
  S.dirty = false;
  S.sel = null;
  S.sugg = [];
  stopBackground();
  resetOcrStats(); // timings are kept per document: pages are read in the background before any scan
  // Scanned pages are read natively where the host can (Android): that keeps going in the background.
  const reader = NativeReader.start(doc, host.nativeScan?.()).catch(() => null);
  void reader.then((r) => { if (S.doc === doc) S.native = r; else r?.cancel(); });
  S.texts = new PageTextCache(doc, { preread: async (i) => (await reader)?.words(i) ?? null });
  warmUpOcr(); // load the OCR engine now, while the user looks at the document
  S.prefetch = new AbortController();
  void prefetchText(S.texts, S.prefetch.signal);
  closePanel();
  S.zoom = fitZoom();
  buildPages();
  syncToolbar();
}

async function pickAndLoad() {
  if (S.busy) return;
  const f = await host.openPdf();
  if (f) await loadFile(f);
}

// ---------- Layout & render ----------
function fitZoom(): number {
  const maxW = Math.max(...S.sizes.map((s) => s.width), 1);
  return Math.min(2, Math.max(0.2, (viewer.clientWidth - 24) / maxW));
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) renderPage(Number((e.target as HTMLElement).dataset.i));
}, { root: viewer, rootMargin: '600px 0px' });

const emptyEl = $('#empty');

/** Back to the start screen. */
async function closeDocument() {
  closePanel(true);
  closeModal();
  // Pages fade out, then the start screen rises in (CSS), while the tool bar slides away.
  viewer.classList.add('leaving');
  await new Promise((r) => setTimeout(r, 230));
  viewer.classList.remove('leaving');
  io.disconnect();
  stopBackground();
  host.closeFile?.();
  if (S.doc) await closePdf(S.doc);
  Object.assign(S, { doc: null, name: '', sizes: [], boxes: [], undo: [], redo: [], sel: null, sugg: [], texts: null, dirty: false, applied: [], bytes: null, password: undefined });
  S.gen++;
  viewer.replaceChildren(emptyEl);
  syncToolbar();
}

function confirmLeave(onYes: () => void) {
  modal(`<h2>Leave this document?</h2>
    <p class="hint">Your redactions haven't been exported yet. If you leave now, they'll be lost.</p>
    <div class="row"><button id="c-no">Cancel</button><button id="c-yes" class="primary">Leave</button></div>`, true);
  $('#c-no').onclick = closeModal;
  $('#c-yes').onclick = () => { closeModal(); onYes(); };
}

/** Android Back: close dialog → stop a scan (asks) → close panel → leave document (asking if unsaved) → let the OS handle it. */
function handleBack(): boolean {
  if (dismissModal()) return true;
  if (S.scan) { askStopScan(); return true; }
  if (S.busy) return true;
  if (S.panel) { closePanel(true); return true; }
  if (S.doc) {
    if (S.dirty && prefs.opts.confirmLeave) confirmLeave(() => void closeDocument());
    else void closeDocument();
    return true;
  }
  return false;
}

function buildPages() {
  io.disconnect();
  viewer.innerHTML = '';
  S.rendered.clear();
  S.gen++;
  S.sizes.forEach((_, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.i = String(i);
    el.innerHTML = `<span class="num">${i + 1}</span><canvas></canvas><div class="overlay"></div>`;
    viewer.appendChild(el);
    bindOverlay(el.querySelector('.overlay') as HTMLElement, i);
  });
  layoutPages();
}

function layoutPages() {
  viewer.style.setProperty('--z', String(S.zoom));
  viewer.querySelectorAll<HTMLElement>('.page').forEach((el, i) => {
    // Sizes follow the --z variable, so a pinch only has to change one CSS property per frame.
    el.style.width = `calc(var(--z) * ${S.sizes[i].width}px)`;
    el.style.height = `calc(var(--z) * ${S.sizes[i].height}px)`;
    drawBoxes(i);
    io.unobserve(el);
    io.observe(el);
  });
}

async function renderPage(i: number) {
  if (!S.doc || S.rendered.has(i)) return;
  S.rendered.add(i);
  const gen = S.gen;
  const page = await S.doc.getPage(i + 1);
  const tmp = document.createElement('canvas');
  // Cap preview backing store to keep memory sane on phones.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  await renderToCanvas(page, tmp, S.zoom * dpr);
  if (gen !== S.gen) return;
  const el = viewer.querySelector<HTMLElement>(`.page[data-i="${i}"]`);
  const old = el?.querySelector('canvas');
  if (old) { old.replaceWith(tmp); old.width = old.height = 0; }
}

const ZMIN = 0.2, ZMAX = 4;
const clampZoom = (z: number) => Math.min(ZMAX, Math.max(ZMIN, z));

/** The page under a viewer-relative point, and that point in PDF points on the page. */
function pointAt(cx: number, cy: number): { i: number; x: number; y: number } | null {
  const pages = [...viewer.querySelectorAll<HTMLElement>('.page')];
  if (!pages.length) return null;
  let best = pages[0], bd = Infinity;
  for (const el of pages) {
    const b = el.getBoundingClientRect();
    const d = cy < b.top ? b.top - cy : cy > b.bottom ? cy - b.bottom : 0;
    if (d < bd) { bd = d; best = el; }
    if (d === 0) break;
  }
  const b = best.getBoundingClientRect();
  return { i: Number(best.dataset.i), x: (cx - b.left) / S.zoom, y: (cy - b.top) / S.zoom };
}

/** Scroll so PDF point `a` (on page a.i) sits under client point (cx, cy). */
function scrollTo(a: { i: number; x: number; y: number }, cx: number, cy: number) {
  const el = viewer.querySelector<HTMLElement>(`.page[data-i="${a.i}"]`);
  if (!el) return;
  const b = el.getBoundingClientRect();
  viewer.scrollLeft += b.left + a.x * S.zoom - cx;
  viewer.scrollTop += b.top + a.y * S.zoom - cy;
}

/** Live zoom (no re-render): CSS stretches the current canvases. Keeps `focus` (client px) fixed if given. */
function previewZoom(z: number, focus?: { cx: number; cy: number }, anchor?: { i: number; x: number; y: number } | null) {
  const f = focus ?? (() => { const v = viewer.getBoundingClientRect(); return { cx: v.left + v.width / 2, cy: v.top + v.height / 3 }; })();
  const a = anchor ?? pointAt(f.cx, f.cy);
  S.zoom = clampZoom(z);
  viewer.style.setProperty('--z', String(S.zoom));
  if (a) scrollTo(a, f.cx, f.cy);
}

/** Re-render pages sharply at the current zoom. */
function commitZoom() {
  S.rendered.clear();
  S.gen++;
  layoutPages();
}

function setZoom(z: number, focus?: { cx: number; cy: number }) {
  previewZoom(z, focus);
  commitZoom();
}

// ---------- Pinch / double-tap / ctrl+wheel zoom ----------
const pinch = { active: false, d0: 1, z0: 1, anchor: null as { i: number; x: number; y: number } | null };
let commitTimer = 0;
const mid = (t: TouchList) => ({ cx: (t[0].clientX + t[1].clientX) / 2, cy: (t[0].clientY + t[1].clientY) / 2 });
const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;

viewer.addEventListener('touchstart', (e) => {
  if (!S.doc || e.touches.length !== 2) return;
  e.preventDefault(); // two fingers: ours, not the browser's scroll
  const m = mid(e.touches);
  Object.assign(pinch, { active: true, d0: dist(e.touches), z0: S.zoom, anchor: pointAt(m.cx, m.cy) });
  cancelDraft();
}, { passive: false });
viewer.addEventListener('touchmove', (e) => {
  if (!pinch.active || e.touches.length < 2) return;
  e.preventDefault();
  previewZoom(pinch.z0 * dist(e.touches) / pinch.d0, mid(e.touches), pinch.anchor); // also pans with the fingers
}, { passive: false });
const pinchEnd = (e: TouchEvent) => {
  if (!pinch.active || e.touches.length >= 2) return;
  pinch.active = false;
  pinchUntil = performance.now() + 250; // ignore the lifting finger as a tap/draw
  commitZoom();
};
viewer.addEventListener('touchend', pinchEnd);
viewer.addEventListener('touchcancel', pinchEnd);

// Double-tap: fit width <-> 2.5x, centred on the tap.
let lastTap = { t: 0, x: 0, y: 0 };
let pinchUntil = 0;
viewer.addEventListener('pointerdown', (e) => { (viewer as HTMLElement & { _down?: { t: number; x: number; y: number } })._down = { t: performance.now(), x: e.clientX, y: e.clientY }; });
viewer.addEventListener('pointerup', (e) => {
  const d = (viewer as HTMLElement & { _down?: { t: number; x: number; y: number } })._down;
  const now = performance.now();
  if (!S.doc || pinch.active || now < pinchUntil || !d || now - d.t > 250 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
  if ((e.target as HTMLElement).closest('.box, .sugg, button')) { lastTap.t = 0; return; }
  if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap.t = 0;
    const fit = fitZoom();
    setZoom(S.zoom > fit * 1.6 ? fit : Math.min(ZMAX, fit * 2.5), { cx: e.clientX, cy: e.clientY });
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

// Trackpad pinch / Ctrl+wheel on desktop.
viewer.addEventListener('wheel', (e) => {
  if (!S.doc || !e.ctrlKey) return;
  e.preventDefault();
  previewZoom(S.zoom * Math.exp(-e.deltaY / 300), { cx: e.clientX, cy: e.clientY });
  clearTimeout(commitTimer);
  commitTimer = window.setTimeout(commitZoom, 180);
}, { passive: false });

// ---------- Boxes ----------
function drawBoxes(i: number) {
  const ov = viewer.querySelector<HTMLElement>(`.page[data-i="${i}"] .overlay`);
  if (!ov) return;
  ov.querySelectorAll('.box:not(.draft)').forEach((b) => b.remove());
  S.boxes[i].forEach((r, idx) => {
    const b = document.createElement('div');
    const sel = S.sel?.page === i && S.sel.idx === idx;
    b.className = `box${sel ? ' sel' : ''}`;
    b.dataset.idx = String(idx);
    place(b, r);
    if (sel) b.innerHTML = '<button class="x" aria-label="Delete box">×</button>';
    ov.appendChild(b);
  });
  ov.querySelectorAll('.sugg').forEach((b) => b.remove());
  for (const sg of S.sugg) {
    if (sg.page !== i) continue;
    for (const r of sg.rects) {
      const b = document.createElement('div');
      b.className = `sugg ${sg.on ? 'on' : 'off'}`;
      b.dataset.sid = String(sg.id);
      b.title = `${sg.label}: ${sg.on ? 'will be redacted (tap to skip)' : 'skipped (tap to include)'}`;
      place(b, r);
      ov.appendChild(b);
    }
  }
}

function place(el: HTMLElement, r: Rect) {
  const c = (v: number) => `calc(var(--z) * ${v}px)`;
  Object.assign(el.style, { left: c(r.x), top: c(r.y), width: c(r.w), height: c(r.h) });
}

function select(sel: typeof S.sel) {
  const prev = S.sel;
  S.sel = sel;
  if (prev) drawBoxes(prev.page);
  if (sel && sel.page !== prev?.page) drawBoxes(sel.page);
  syncToolbar();
}

/** record: 'new' = a fresh user action (clears Redo), 'redo' = re-doing an undone one, false = undo itself. */
function apply(a: Action, record: 'new' | 'redo' | false = 'new') {
  const ops = a.type === 'group' ? a.ops : [a];
  for (const o of ops) {
    if (o.type === 'add') S.boxes[o.page].splice(o.idx, 0, o.rect);
    else S.boxes[o.page].splice(o.idx, 1);
  }
  if (record) S.undo.push(a);
  if (record === 'new') S.redo = [];
  S.dirty = true;
  S.sel = null;
  for (const p of new Set(ops.map((o) => o.page))) drawBoxes(p);
  syncApplied();
  syncToolbar();
}

/**
 * The Redacted list always mirrors the page: an item counts as redacted while any of its boxes is on the page.
 * So deleting its box by hand, Undo, Redo or Reset all update the list (and its tick) too.
 */
function syncApplied() {
  let changed = false;
  for (const it of S.applied) {
    const on = it.rects.some((r) => S.boxes[it.page]?.includes(r));
    if (on !== it.on) { it.on = on; changed = true; }
  }
  if (changed && S.panel) renderResults();
}

const invertOp = (o: Op): Op => ({ ...o, type: o.type === 'add' ? 'del' : 'add' });
const invert = (a: Action): Action =>
  a.type === 'group' ? { type: 'group', ops: a.ops.map(invertOp).reverse() } : invertOp(a);

/** Add many boxes as one undoable step. */
function addBoxes(items: { page: number; rect: Rect }[], sugg?: Sugg[]) {
  if (!items.length) return;
  const next = S.boxes.map((b) => b.length);
  apply({
    type: 'group', ops: items.map(({ page, rect }) => ({ type: 'add', page, rect, idx: next[page]++ })),
    sugg: sugg && { gen: suggGen, items: sugg },
  });
}

function deleteSelected() {
  if (!S.sel) return;
  const { page, idx } = S.sel;
  apply({ type: 'del', page, idx, rect: S.boxes[page][idx] });
}

function redo() {
  const a = S.redo.pop();
  if (!a) return;
  apply(a, 'redo');
  // Re-doing an Apply moves those items from the review list back to the Redacted list.
  if (a.type === 'group' && a.sugg) {
    const ids = new Set(a.sugg.items.map((x) => x.id));
    const had = S.sugg.length;
    S.sugg = S.sugg.filter((x) => !ids.has(x.id));
    for (const it of a.sugg.items) if (!S.applied.some((x) => x.id === it.id)) S.applied.push({ ...it, on: true });
    syncApplied();
    if (S.panel && (had !== S.sugg.length || a.sugg.items.length)) refreshSugg();
  }
}

/** Remove every box on every page (asks first; can be undone). */
function resetAll() {
  const n = S.boxes.reduce((k, b) => k + b.length, 0);
  if (!n || S.busy) return;
  modal(`<h2>Remove all redactions?</h2>
    <p class="hint">This removes all ${n} black box(es) on every page. You can still bring them back with Undo.</p>
    <div class="row"><button id="rs-no">Cancel</button><button id="rs-yes" class="primary danger">Remove all</button></div>`, true);
  $('#rs-no').onclick = closeModal;
  $('#rs-yes').onclick = () => {
    closeModal();
    const ops: Op[] = [];
    S.boxes.forEach((b, page) => { for (let idx = b.length - 1; idx >= 0; idx--) ops.push({ type: 'del', page, idx, rect: b[idx] }); });
    apply({ type: 'group', ops });
    toast('All redactions removed. Undo brings them back.');
  };
}

function undo() {
  const a = S.undo.pop();
  if (!a) return;
  S.redo.push(a);
  apply(invert(a), false);
  // Undoing an Apply puts those items back into the review list (if it is still the same scan).
  if (a.type === 'group' && a.sugg) {
    const ids = new Set(a.sugg.items.map((x) => x.id));
    S.applied = S.applied.filter((x) => !ids.has(x.id));
  }
  if (a.type === 'group' && a.sugg && a.sugg.gen === suggGen && S.panel) {
    S.sugg.push(...a.sugg.items);
    S.sugg.sort((x, y) => x.page - y.page || x.start - y.start);
    refreshSugg();
  }
}

/** Set by the overlay that is drawing; a second finger (pinch) discards the box being drawn. */
let cancelDraft: () => void = () => {};

function bindOverlay(ov: HTMLElement, page: number) {
  let start: { x: number; y: number } | null = null;
  let draft: HTMLElement | null = null;
  const pt = (e: PointerEvent) => {
    const b = ov.getBoundingClientRect();
    const s = S.sizes[page];
    return {
      x: Math.min(s.width, Math.max(0, (e.clientX - b.left) / S.zoom)),
      y: Math.min(s.height, Math.max(0, (e.clientY - b.top) / S.zoom)),
    };
  };
  const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }): Rect =>
    ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  ov.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('x')) { e.stopPropagation(); deleteSelected(); return; }
    if (t.classList.contains('sugg')) { toggleSugg(Number(t.dataset.sid)); return; }
    const box = t.closest<HTMLElement>('.box');
    if (box) { select({ page, idx: Number(box.dataset.idx) }); return; }
    if (S.sel) select(null);
    if (S.mode !== 'draw' || S.busy || e.button > 0 || pinch.active || !e.isPrimary) return;
    ov.setPointerCapture(e.pointerId);
    cancelDraft = () => { draft?.remove(); start = draft = null; };
    start = pt(e);
    draft = document.createElement('div');
    draft.className = 'box draft';
    ov.appendChild(draft);
    place(draft, { ...start, w: 0, h: 0 });
  });
  ov.addEventListener('pointermove', (e) => { if (start && draft) place(draft, rectOf(start, pt(e))); });
  const end = (e: PointerEvent) => {
    if (!start || !draft) return;
    const r = rectOf(start, pt(e));
    draft.remove();
    start = draft = null;
    if (e.type === 'pointerup' && r.w * S.zoom >= 6 && r.h * S.zoom >= 6) {
      apply({ type: 'add', page, idx: S.boxes[page].length, rect: r });
    }
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
}

// ---------- Settings (persisted through the host) ----------
type ThemePref = 'system' | 'light' | 'dark';
/** `compression` replaced 1.1.1's `format` so everyone starts on the new Auto default once. */
interface ExportPrefs { dpi: number; compression: ExportOptions['format']; searchable: boolean; method: 'vector' | 'image' }
interface Options { hideRecents: boolean; platesLabelled: boolean; confirmLeave: boolean; closeAfterRedact: boolean; reviewReminder: boolean }
const DEFAULT_OPTIONS: Options = { hideRecents: true, platesLabelled: true, confirmLeave: true, closeAfterRedact: true, reviewReminder: true };
interface Prefs { theme: ThemePref; advanced: boolean; ocrLangs: string[]; detect: { enabled: string[]; custom: CustomPattern[]; known?: string[]; always: string[] }; export: ExportPrefs; opts: Options; ui: UiPrefs }
/** Languages in scans (Settings → one switch each). Add a language here, and a model that reads it below. */
const OCR_LANGS = [
  { id: 'en', label: 'English', hint: 'Also Malay and other text in the Latin alphabet.' },
  { id: 'zh', label: '中文', hint: 'Simplified and Traditional Chinese, and English in the same scan. Scanned pages take a little longer to read.' },
] as const;
/** Recognition models, fastest first, with the languages each reads: the first that reads every language switched on is used. */
const OCR_MODELS: { model: OcrLang; reads: string[] }[] = [{ model: 'en', reads: ['en'] }, { model: 'ch', reads: ['en', 'zh'] }];
const ocrModelFor = (langs: readonly string[]): OcrLang =>
  (OCR_MODELS.find((m) => langs.every((l) => m.reads.includes(l))) ?? OCR_MODELS[OCR_MODELS.length - 1]).model;
/** Known languages in table order, at least one (English when none). 1.2 dev builds saved `ocrLang: 'ch'` for English + 中文. */
function cleanOcrLangs(v: Partial<Prefs> & { ocrLang?: unknown }): string[] {
  const raw = Array.isArray(v.ocrLangs) ? v.ocrLangs : v.ocrLang === 'ch' ? ['en', 'zh'] : [];
  const out = OCR_LANGS.map((l) => l.id).filter((id) => raw.includes(id));
  return out.length ? out : ['en'];
}
/** Landscape side panel: which side, and its width in % of the screen (20–45). */
interface UiPrefs { panelSide: 'left' | 'right'; panelW: number }
const clampPanelW = (w: number) => Math.min(45, Math.max(20, Math.round(w)));
/** Detectors added in an update start switched on (if on by default) for people with saved settings too. */
function withNewPresets(d: Prefs['detect']): Prefs['detect'] {
  const known = d.known ?? ['nric', 'phone', 'email', 'card', 'bank', 'passport', 'dob', 'company', 'name', 'address', 'plate']; // 1.0.0 set
  const added = PRESETS.filter((p) => !known.includes(p.id) && p.defaultOn && !d.enabled.includes(p.id)).map((p) => p.id);
  return { ...d, enabled: [...d.enabled, ...added], known: PRESETS.map((p) => p.id) };
}
/** Settings → "Always redact" list: tidy, no blanks or duplicates (any case), capped. */
function cleanAlways(v: unknown): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const x of Array.isArray(v) ? v : []) {
    const w = typeof x === 'string' ? normAlways(x) : '';
    if (w && !seen.has(w.toLowerCase()) && out.length < ALWAYS_MAX) { seen.add(w.toLowerCase()); out.push(w); }
  }
  return out;
}
function loadPrefs(): Prefs {
  const d: Prefs = {
    theme: 'system', advanced: false, ocrLangs: ['en'], detect: { enabled: [...DEFAULT_PRESET_IDS], custom: [], known: PRESETS.map((p) => p.id), always: [] },
    export: { dpi: DEFAULT_EXPORT.dpi, compression: DEFAULT_EXPORT.format, searchable: true, method: 'vector' },
    opts: { ...DEFAULT_OPTIONS },
    ui: { panelSide: 'right', panelW: 34 },
  };
  try {
    const v = JSON.parse(host.loadPrefs() ?? 'null') as Partial<Prefs> | null;
    if (!v) return d;
    return {
      theme: v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system',
      advanced: v.advanced === true,
      ocrLangs: cleanOcrLangs(v),
      opts: (() => {
        const raw = (v.opts ?? {}) as unknown as Record<string, unknown>;
        const o = { ...DEFAULT_OPTIONS };
        for (const k of Object.keys(o) as (keyof Options)[]) if (typeof raw[k] === 'boolean') o[k] = raw[k] as boolean;
        return o;
      })(),
      detect: v.detect && Array.isArray(v.detect.enabled) && Array.isArray(v.detect.custom)
        ? { ...withNewPresets(v.detect), always: cleanAlways(v.detect.always) } : d.detect,
      ui: { panelSide: v.ui?.panelSide === 'left' ? 'left' : 'right', panelW: Number.isFinite(v.ui?.panelW) ? clampPanelW(v.ui!.panelW) : d.ui.panelW },
      export: {
        dpi: [150, 200, 300, 400, 600].includes(Number(v.export?.dpi)) ? Number(v.export!.dpi) : d.export.dpi,
        compression: (['png', 'jpeg'] as const).find((f) => f === v.export?.compression) ?? 'auto',
        method: v.export?.method === 'image' ? 'image' : 'vector',
        searchable: typeof v.export?.searchable === 'boolean' ? v.export.searchable : d.export.searchable,
      },
    };
  } catch { return d; }
}
const prefs = loadPrefs();
const savePrefs = () => host.savePrefs(JSON.stringify(prefs));

const media = window.matchMedia?.('(prefers-color-scheme: dark)');
let hostDark = host.systemDark();
function applyTheme() {
  const sysDark = hostDark ?? media?.matches ?? false;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && sysDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  host.setBarStyle(dark);
}
media?.addEventListener?.('change', () => { if (hostDark === null) applyTheme(); });
host.onSystemTheme((d) => { hostDark = d; applyTheme(); });
host.onInsets((i) => {
  const st = document.documentElement.style;
  st.setProperty('--sat', `${i.top}px`); st.setProperty('--sab', `${i.bottom}px`);
  st.setProperty('--sal', `${i.left}px`); st.setProperty('--sar', `${i.right}px`);
});
applyTheme();
host.setSecure(prefs.opts.hideRecents);
setOcrLang(ocrModelFor(prefs.ocrLangs));

const OPTION_ROWS: Record<keyof Options, [string, string]> = {
  closeAfterRedact: ['Close Auto Detect after Redact', 'Go straight back to the document. Reopen Auto Detect to review or undo items in its Redacted tab. Find always stays open.'],
  confirmLeave: ['Ask before leaving unsaved work', 'Back or opening another file asks first if your redactions aren\'t exported.'],
  reviewReminder: ['Remind me to check every page', 'Shows a reminder when exporting. Auto Detect can miss unusual formats.'],
  platesLabelled: ['Vehicle plates only when labelled', 'Only flag plates next to words like “vehicle”, “kenderaan” or “plate”. Fewer false matches.'],
  hideRecents: ['Hide content in Recent apps', 'Blanks the app preview in the app switcher. This also blocks screenshots.'],
};
const optRows = (keys: (keyof Options)[]) => keys.filter((k) => k !== 'hideRecents' || host.name === 'android').map((k) =>
  row2(OPTION_ROWS[k][0], `<input class="switch" type="checkbox" data-opt="${k}" ${prefs.opts[k] ? 'checked' : ''}>`, `opt-${k}`, OPTION_ROWS[k][1])).join('');

// ---------- (?) help ----------
/** Longer explanations behind the (?) buttons. */
const HELP = {
  detect: `<p>Auto Detect scans every page, scanned ones too, for IC numbers, phone numbers, emails, bank accounts, addresses, labelled names and more. Nothing is blacked out until you tap Redact, and you can untick anything first.</p>
    <p>Words in “Always redact” (Settings) are found in any case, even when split across lines. To pick which types it looks for, or add your own pattern, open Auto Detect in a document and tap “Choose what to find”.</p>
    <p>It can miss unusual formats, so always look through every page.</p>`,
  get defaults() { return `<p>What Export starts with. You can still change it each time you export.</p>${this.export}`; },
  ocr: `<p>Scanned pages are pictures, so Umbra reads them on your device (OCR) before Find, Auto Detect or a searchable export can use the text. Nothing is uploaded.</p>
    <p>Each extra language makes scanned pages a little slower to read. Chinese covers Simplified and Traditional, and also reads English.</p>`,
  export: `<p>Every copy goes through a final safety check before you can save it: no hidden text, links, forms, attachments or file details, and nothing readable under the black boxes. If anything fails, Umbra won't save it.</p>
    <p><b>Keep original text</b> edits the PDF itself, so it looks like the original, stays sharp and small. If the PDF has hidden text or layers, Umbra stops and asks you to use Image only.</p>
    <p><b>Image only</b> redraws every page as a picture, so nothing from the original file can survive. Files are bigger and the text is only searchable with OCR.</p>`,
  image: `<p><b>Quality</b> is the picture resolution. 300 DPI suits most documents, 150 makes small files, 600 is for printing.</p>
    <p><b>File size</b>: Auto picks per page (lossless for clean pages, JPEG for photos and scans). Sharp is always lossless. Photo is always JPEG.</p>
    <p><b>Searchable text</b> reads the visible words on your device and adds them invisibly, so you can copy and search them. Blacked-out parts are never included.</p>`,
  split: `<p>Splitting happens after the safety check, so every file is cut from your checked, redacted copy, never from the original.</p>
    <p><b>Every N</b>: a new file every N pages (1 = one file per page).</p>
    <p><b>Ranges</b>: one file per range, for example 1-3, 4, 8- (8- means 8 to the end). Pages not listed are left out.</p>
    <p><b>Halves</b>: for scans with two pages side by side. You get one PDF with every page cut in two.</p>`,
  find: `<p>Search for any word or phrase. Each search stays as a filter you can remove with ×. Match case and Whole word narrow the results.</p>
    <p>Scanned pages are read with OCR first, so the first search on a scan can take longer.</p>`,
};
type HelpId = keyof typeof HELP;
const helpBtn = (id: string, what: string) => `<button type="button" class="qhelp" data-help="${id}" aria-expanded="false" aria-label="About ${what.replace(/<[^>]*>/g, '')}">?</button>`;
const helpBox = (id: string, html = HELP[id as HelpId]) => `<div class="helpbox" data-helpbox="${id}" hidden>${html}</div>`;
/** A labelled control; its description stays behind a (?) so the screen stays clean. */
const row2 = (title: string, control: string, id: string, help?: string, forId?: string) =>
  `<label class="row2"${forId ? ` for="${forId}"` : ''}><span class="rt">${title}${help ? helpBtn(id, title) : ''}</span>${control}</label>${help ? helpBox(id, `<p>${help}</p>`) : ''}`;
/** A heading with a (?) that opens the longer explanation right under it. */
const helpH = (tag: 'h2' | 'h3', title: string, id: HelpId) => `<${tag} class="hh">${title}${helpBtn(id, title)}</${tag}>${helpBox(id)}`;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
/** Its children's margins stay inside it, so its height while animating is the height it ends with (no jump at the end). */
function contain(el: HTMLElement) {
  for (const e of [el, el.parentElement]) {
    // The parent too: otherwise a margin next to `el` overlaps the parent's own once `el` is gone, but not while it shrinks.
    if (e && !e.hidden && !e.classList.contains('contain') && getComputedStyle(e).display === 'block') e.classList.add('contain');
  }
}
/**
 * Bottom margin for a slid-away box: gone, the margins above and below it overlap (collapse) into the larger
 * one; at zero height it still keeps them apart. This pulls them together so the last frame matches.
 */
function goneMargin(el: HTMLElement): string {
  const pd = el.parentElement ? getComputedStyle(el.parentElement).display : '';
  if (/flex|grid/.test(pd)) return '0px';
  const near = (e: Element | null, next: boolean): Element | null => { while (e && (e as HTMLElement).hidden) e = next ? e.nextElementSibling : e.previousElementSibling; return e; };
  const prev = near(el.previousElementSibling, false), next = near(el.nextElementSibling, true);
  const pm = prev ? Math.max(0, parseFloat(getComputedStyle(prev).marginBottom) || 0) : 0;
  const nm = next ? Math.max(0, parseFloat(getComputedStyle(next).marginTop) || 0) : 0;
  // A border never animates below 1 px (Chrome), so its box keeps them at height 0: pull them back too.
  const cs = getComputedStyle(el), bw = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  return `${-Math.min(pm, nm) - bw}px`;
}
/** Run a height animation on `el` (border-box, clipped), then hand it back to normal layout. */
function animateHeight(el: HTMLElement, frames: Keyframe[], duration: number, done?: () => void) {
  el.classList.add('sliding');
  const a = el.animate(frames, { duration, easing: EASE });
  a.onfinish = () => { el.classList.remove('sliding'); done?.(); };
  a.oncancel = () => el.classList.remove('sliding');
  return a;
}
/** Show or hide with a short height + fade, so what's below slides instead of jumping. `instant` for first render. */
function slide(el: HTMLElement, show: boolean, instant = false) {
  if ((el.dataset.slide ?? String(!el.hidden)) === String(show)) return;
  el.dataset.slide = String(show);
  el.getAnimations?.().forEach((a) => a.cancel());
  contain(el);
  if (instant || reduceMotion?.matches || !el.animate) { el.hidden = !show; contain(el); return; }
  el.hidden = false;
  contain(el);
  const cs = getComputedStyle(el);
  const full = { height: `${el.offsetHeight}px`, opacity: 1, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom };
  const none = { height: '0px', opacity: 0, marginTop: '0px', marginBottom: goneMargin(el), paddingTop: '0px', paddingBottom: '0px' };
  animateHeight(el, show ? [none, full] : [full, none], 240, () => { if (!show) el.hidden = true; });
}
/**
 * One box in place of another (Split's ways): the box keeps its place and changes height while the new
 * options fade in, instead of one box closing while another opens. To or from nothing, it slides.
 */
function swapBox(boxes: HTMLElement[], on: HTMLElement | null, instant = false) {
  const cur = boxes.find((b) => (b.dataset.slide ?? String(!b.hidden)) === 'true') ?? null;
  if (cur === on) return;
  if (!cur || !on || instant || reduceMotion?.matches || !on.animate) { for (const b of boxes) slide(b, b === on, instant); return; }
  // Mid-animation the old box's current height is where the new one starts.
  const h0 = cur.getBoundingClientRect().height;
  cur.getAnimations().forEach((a) => a.cancel());
  cur.hidden = true; cur.dataset.slide = 'false';
  on.getAnimations().forEach((a) => a.cancel());
  on.querySelectorAll<HTMLElement>(':scope > *').forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
  on.hidden = false; on.dataset.slide = 'true';
  contain(on);
  const h1 = on.offsetHeight;
  animateHeight(on, [{ height: `${h0}px` }, { height: `${h1}px` }], 280);
  on.querySelectorAll<HTMLElement>(':scope > *').forEach((c) =>
    c.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: 70, easing: 'ease-out', fill: 'backwards' }));
}
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-help]');
  const box = b?.closest('.sheet, #panel')?.querySelector<HTMLElement>(`[data-helpbox="${b.dataset.help}"]`);
  if (!b || !box) return;
  e.preventDefault();
  const open = b.getAttribute('aria-expanded') !== 'true';
  slide(box, open);
  b.setAttribute('aria-expanded', String(open));
});

// ---------- Fluid toggles ----------
// Segmented controls (2 or 3 ways, Scroll | Redact, result tabs) get one sliding highlight, and every
// toggle can be dragged: the thumb follows the finger and snaps to the nearest option when let go.
const SEGS = '.segctl, .subtabs, #mode-seg';
const segOn = (b: Element) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true';
const segButtons = (g: HTMLElement) => [...g.children].filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement);
function syncSeg(g: HTMLElement) {
  if (g.classList.contains('seg-drag')) return;
  const b = segButtons(g).find(segOn);
  g.style.setProperty('--seg-o', b && b.offsetWidth ? '1' : '0');
  if (!b || !b.offsetWidth) return;
  g.style.setProperty('--seg-x', `${b.offsetLeft}px`);
  g.style.setProperty('--seg-w', `${b.offsetWidth}px`);
  if (!g.classList.contains('seg-ready')) requestAnimationFrame(() => g.classList.add('seg-ready')); // no slide on first paint
}
const segSize = new ResizeObserver((es) => es.forEach((e) => syncSeg(e.target as HTMLElement)));
const segSeen = new WeakSet<HTMLElement>();
function scanSegs(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(SEGS).forEach((g) => {
    if (!segSeen.has(g)) { segSeen.add(g); g.classList.add('fluid'); segSize.observe(g); }
    syncSeg(g);
  });
}
new MutationObserver((ms) => {
  for (const m of ms) {
    if (m.type === 'attributes') { const g = (m.target as HTMLElement).parentElement?.closest<HTMLElement>(SEGS); if (g) syncSeg(g); }
    else m.addedNodes.forEach((n) => { if (n instanceof HTMLElement) { const g = n.closest<HTMLElement>(SEGS); if (g) scanSegs(g.parentElement ?? g); else scanSegs(n); } });
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected', 'hidden'] });
scanSegs();

let dragClickBlock = false;
// A drag ends with a click on whatever is under the finger: swallow that one click, the drag already chose.
document.addEventListener('click', (e) => { if (dragClickBlock) { e.stopPropagation(); e.preventDefault(); } }, true);
const blockNextClick = () => { dragClickBlock = true; setTimeout(() => { dragClickBlock = false; }, 0); };
{
  let g: HTMLElement | null = null, sw: HTMLInputElement | null = null, x0 = 0, base = 0, moved = false, pid = 0;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    sw = t.closest<HTMLInputElement>('input.switch');
    g = sw ? null : t.closest<HTMLElement>(SEGS);
    if (g && !segButtons(g).some(segOn)) g = null;
    if (!g && !sw) return;
    x0 = e.clientX; moved = false; pid = e.pointerId;
    base = sw ? (sw.checked ? 18 : 0) : parseFloat(g!.style.getPropertyValue('--seg-x')) || 0;
  }, true);
  document.addEventListener('pointermove', (e) => {
    if ((!g && !sw) || e.pointerId !== pid) return;
    const dx = e.clientX - x0;
    if (!moved && Math.abs(dx) < 6) return;
    if (!moved) { moved = true; (sw ?? g!).classList.add('seg-drag'); try { (sw ?? g!).setPointerCapture(pid); } catch { /* gone */ } }
    if (sw) { sw.style.setProperty('--sx', `${Math.min(18, Math.max(0, base + dx))}px`); return; }
    const bs = segButtons(g!), first = bs[0], last = bs[bs.length - 1];
    const w = parseFloat(g!.style.getPropertyValue('--seg-w')) || first.offsetWidth;
    const x = Math.min(last.offsetLeft + last.offsetWidth - w, Math.max(first.offsetLeft, base + dx));
    g!.style.setProperty('--seg-x', `${x}px`);
    // The option under the highlight's middle takes its width as it passes.
    const mid = x + w / 2, near = bs.find((b) => mid >= b.offsetLeft && mid <= b.offsetLeft + b.offsetWidth) ?? first;
    g!.style.setProperty('--seg-w', `${near.offsetWidth}px`);
  });
  const end = (e: PointerEvent) => {
    if ((!g && !sw) || e.pointerId !== pid) return;
    const el = sw ?? g!;
    const was = moved; const s2 = sw, g2 = g;
    g = sw = null;
    el.classList.remove('seg-drag');
    if (!was) return;
    blockNextClick();
    if (e.type === 'pointercancel' && !s2) { syncSeg(g2!); return; }
    if (s2) {
      const on = (parseFloat(s2.style.getPropertyValue('--sx')) || 0) >= 9;
      s2.style.removeProperty('--sx');
      if (on !== s2.checked) { s2.checked = on; s2.dispatchEvent(new Event('change', { bubbles: true })); }
      return;
    }
    const x = (parseFloat(g2!.style.getPropertyValue('--seg-x')) || 0) + (parseFloat(g2!.style.getPropertyValue('--seg-w')) || 0) / 2;
    const bs = segButtons(g2!);
    const pick = bs.reduce((a, b) => (Math.abs(b.offsetLeft + b.offsetWidth / 2 - x) < Math.abs(a.offsetLeft + a.offsetWidth / 2 - x) ? b : a));
    if (!pick.disabled && !segOn(pick)) { dragClickBlock = false; pick.click(); blockNextClick(); }
    syncSeg(g2!);
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

function settingsDialog() {
  if (S.busy) return;
  const seg = (v: ThemePref, l: string) => `<button data-theme-opt="${v}" aria-pressed="${prefs.theme === v}">${l}</button>`;
  const optItems = (keys: (keyof Options)[]) => keys.filter((k) => k !== 'hideRecents' || host.name === 'android')
    .map((k) => `<div class="sitem">${optRows([k])}</div>`).join('');
  modal(`<div class="ssearch"><h2>Settings</h2><input id="s-search" type="search" placeholder="Search settings" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-label="Search settings"></div>
    <p class="hint" id="s-none" hidden>No settings match.</p>
    <section class="sset"><h3>Appearance</h3>
    <div class="sitem" data-k="theme dark light mode night colour color"><div class="segctl">${seg('system', 'System')}${seg('light', 'Light')}${seg('dark', 'Dark')}</div></div></section>
    <section class="sset">${helpH('h3', 'Export defaults', 'defaults')}
    <div class="sitem" data-k="save method">${exportChoiceHtml(prefs.export)}</div></section>
    <section class="sset">${helpH('h3', 'Auto Detect', 'detect')}
    <div class="sitem" data-k="words names list">${row2('Always redact', '', 'always', 'Names, places or other words Auto Detect should always find, in any case and across line breaks. Kept on this device only.', 's-aw')}
    <form class="prow" id="s-aw-form"><input id="s-aw" placeholder="Word or phrase, e.g. Tan Ah Kow" autocomplete="off" spellcheck="false" maxlength="200" enterkeyhint="done">
      <button class="primary">Add</button></form>
    <div class="tchips" id="s-aw-list"></div></div>
    ${optItems(['platesLabelled', 'closeAfterRedact'])}</section>
    <section class="sset">${helpH('h3', 'Reading scans (OCR)', 'ocr')}
    ${OCR_LANGS.map((l) => `<div class="sitem" data-k="language ${l.id === 'zh' ? 'chinese' : 'malay'}">${row2(l.label, `<input class="switch" type="checkbox" data-lang="${l.id}" ${prefs.ocrLangs.includes(l.id) ? 'checked' : ''}>`, `lang-${l.id}`, l.hint)}</div>`).join('')}
    <p class="hint" id="s-lang-hint" hidden>Keep at least one language on.</p></section>
    <section class="sset"><h3>Safety</h3>
    ${optItems(['confirmLeave', 'reviewReminder', 'hideRecents'])}</section>
    <section class="sset"><h3>Advanced</h3>
    <div class="sitem" data-k="debug">${row2('Show technical check report', `<input id="s-adv" class="switch" type="checkbox" ${prefs.advanced ? 'checked' : ''}>`, 'adv', 'For IT and troubleshooting. The safety check always runs either way.')}</div></section>
    <section class="sset"><h3>About</h3>
    <div class="sitem" data-k="version licence privacy"><p class="hint">Umbra PDF works fully offline. Your files never leave this device. Open source under GPL-3.0.</p></div></section>
    <div class="row"><button id="s-close" class="primary">Done</button></div>`, true);
  // The title and search stay on top; a line under them once the list scrolls beneath.
  const sheet = $('#sheet'), head = $('.ssearch');
  sheet.onscroll = () => head.classList.toggle('stuck', sheet.scrollTop > 4);
  // Search: only matching settings stay; a section title match keeps its whole section.
  const sq = $<HTMLInputElement>('#s-search');
  sq.oninput = () => {
    const words = sq.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const hit = (t: string) => words.every((w) => t.includes(w));
    let any = false;
    $('#sheet').querySelectorAll<HTMLElement>('.sset').forEach((sec) => {
      const title = sec.querySelector('h3')?.textContent?.toLowerCase() ?? '';
      const all = !words.length || hit(title);
      let n = 0;
      sec.querySelectorAll<HTMLElement>('.sitem').forEach((it) => {
        const on = all || hit(`${title} ${it.textContent} ${it.dataset.k ?? ''}`.toLowerCase());
        slide(it, on); if (on) n++;
      });
      slide(sec, n > 0); any ||= n > 0;
    });
    slide($('#s-none'), !any);
  };
  bindExportChoice(prefs.export, () => savePrefs());
  $('#sheet').querySelectorAll<HTMLButtonElement>('[data-theme-opt]').forEach((b) => {
    b.onclick = () => {
      prefs.theme = b.dataset.themeOpt as ThemePref; savePrefs(); applyTheme();
      $('#sheet').querySelectorAll('[data-theme-opt]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  });
  $('#sheet').querySelectorAll<HTMLInputElement>('[data-lang]').forEach((cb) => {
    cb.onchange = () => {
      const on = [...$('#sheet').querySelectorAll<HTMLInputElement>('[data-lang]')].filter((x) => x.checked).map((x) => x.dataset.lang!);
      // Scans need at least one language: the last one can't be switched off.
      $('#s-lang-hint').hidden = on.length > 0;
      if (!on.length) { cb.checked = true; return; }
      prefs.ocrLangs = on; savePrefs(); setOcrLang(ocrModelFor(on));
    };
  });
  const aw = prefs.detect;
  const renderAlways = () => {
    $('#s-aw-list').innerHTML = aw.always.map((w, i) => `<span class="tchip on"><span class="tl">${esc(w)}</span>
      <button type="button" class="tx" data-rmaw="${i}" aria-label="Remove ${esc(w)}">×</button></span>`).join('');
  };
  renderAlways();
  $('#s-aw-form').onsubmit = (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>('#s-aw');
    aw.always = cleanAlways([...aw.always, inp.value]); savePrefs(); renderAlways();
    inp.value = ''; inp.focus();
  };
  $('#s-aw-list').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rmaw]');
    if (!b) return;
    aw.always.splice(Number(b.dataset.rmaw), 1); savePrefs(); renderAlways();
  };
  $<HTMLInputElement>('#s-adv').onchange = (e) => { prefs.advanced = (e.target as HTMLInputElement).checked; savePrefs(); };
  $('#sheet').querySelectorAll<HTMLInputElement>('[data-opt]').forEach((cb) => {
    cb.onchange = () => {
      const k = cb.dataset.opt as keyof Options;
      prefs.opts[k] = cb.checked; savePrefs();
      if (k === 'hideRecents') host.setSecure(cb.checked);
    };
  });
  $('#s-close').onclick = closeModal;
}

// ---------- Search & detect panel ----------
let suggSeq = 0;
let suggGen = 0; // bumps on every new search/scan

const stage = $('.stage');
/** Keep the document scrollable above the sheet and the zoom buttons just above it. */
const sideMode = window.matchMedia('(orientation: landscape) and (min-aspect-ratio: 4/3)');
function applyPanelUi() {
  document.body.classList.toggle('panel-left', prefs.ui.panelSide === 'left');
  stage.style.setProperty('--panel-w', `${prefs.ui.panelW}%`);
}
function updateSheetSpace() {
  const p = $('#panel');
  const open = !p.hidden && !p.classList.contains('closing');
  if (sideMode.matches) {
    // Side panel: the document shrinks beside it instead of scrolling under it.
    const w = open ? Math.round(p.offsetWidth) : 0;
    stage.style.setProperty('--sheet-h', '0px');
    stage.style.setProperty('--side-l', prefs.ui.panelSide === 'left' ? `${w}px` : '0px');
    stage.style.setProperty('--side-r', prefs.ui.panelSide === 'right' ? `${w}px` : '0px');
    return;
  }
  stage.style.setProperty('--side-l', '0px'); stage.style.setProperty('--side-r', '0px');
  const h = p.hidden || p.classList.contains('closing') ? 0 : p.offsetHeight - sheetShift(p);
  stage.style.setProperty('--sheet-h', `${Math.round(h)}px`);
}
new ResizeObserver(() => { if (!sheetDrag) updateSheetSpace(); }).observe($('#panel'));
sideMode.addEventListener('change', () => setSnap(snap, false));
new ResizeObserver(() => { if (!$('#panel').hidden && !sheetDrag) setSnap(snap, false); }).observe(stage);

// Bottom sheet stops: just the header, 40% of the screen, or covering the whole document.
type Snap = 'peek' | 'half' | 'full';
let snap: Snap = 'half';
let sheetDrag = false;
function snapHeights(): Record<Snap, number> {
  const H = stage.clientHeight;
  const head = $('#panel').querySelector<HTMLElement>('.phead')?.offsetHeight ?? 64;
  return { peek: head, half: Math.max(head, Math.round(H * 0.4)), full: H };
}
/** How far the sheet is pushed down below its height (it moves by this, so moving never re-lays out its list). */
const sheetShift = (p: HTMLElement) => parseFloat(p.style.translate.split(' ')[1] ?? '') || 0;
let settleTimer = 0;
function setSnap(to: Snap, animate = true) {
  const p = $('#panel');
  snap = to;
  p.dataset.snap = to;
  if (sideMode.matches) { clearTimeout(settleTimer); p.style.height = ''; p.style.translate = ''; updateSheetSpace(); return; }
  settleSheet(p, snapHeights()[to], animate);
}
/**
 * Glide the sheet to show `to` px. Only the compositor moves it: the sheet is made tall enough for both the
 * start and the end, slides with `translate`, and takes its final height once it has stopped.
 */
function settleSheet(p: HTMLElement, to: number, animate: boolean) {
  clearTimeout(settleTimer);
  const instant = () => {
    p.classList.add('dragging');
    p.style.height = `${to}px`; p.style.translate = '';
    void p.offsetHeight;
    p.classList.remove('dragging');
    updateSheetSpace();
  };
  const from = p.offsetHeight - sheetShift(p);
  if (!animate || p.hidden || reduceMotion?.matches || Math.abs(from - to) < 1) { instant(); return; }
  const H = Math.max(p.offsetHeight, to);
  p.classList.add('dragging');
  if (p.offsetHeight !== H) p.style.height = `${H}px`;
  p.style.translate = `0 ${H - from}px`;
  void p.offsetHeight;
  p.classList.remove('dragging');
  p.style.translate = `0 ${H - to}px`;
  updateSheetSpace(); // the document and zoom buttons move with it, once
  settleTimer = window.setTimeout(() => { if (!p.hidden) instant(); }, 360);
}

function showPanel(html: string) {
  const p = $('#panel');
  const wasOpen = !p.hidden && !p.classList.contains('closing');
  clearTimeout(panelCloseTimer);
  p.classList.remove('closing');
  p.innerHTML = `<div class="phead"><button class="grab" id="p-grab" aria-label="Collapse or expand panel"><i></i></button></div><div class="pbody">${html}</div>`;
  // The title bar sits above the scrolling list, so nothing scrolls past it.
  const ph = p.querySelector<HTMLElement>('.pbody > .ph');
  if (ph) p.querySelector('.phead')!.append(ph);
  if (!wasOpen) snap = 'half';
  setSnap(snap, wasOpen);
  if (wasOpen) {
    // Switching Find <-> Auto Detect: cross-fade the content, the sheet stays put.
    p.animate?.([{ opacity: 0.2 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  } else {
    p.classList.add('enter');
    p.hidden = false;
    void p.offsetWidth; // start below the screen, then slide up
    p.classList.remove('enter');
  }
  bindGrab(p);
  updateSheetSpace();
}

/**
 * Bottom sheet: drag the handle or title bar and it follows the finger, then settles on the nearest stop
 * (a quick flick carries it on). Tapping the handle or title collapses it, or brings it back to 40%.
 * Landscape: the handle is the inner edge, dragged to resize.
 */
function bindGrab(p: HTMLElement) {
  const head = p.querySelector<HTMLElement>('.phead')!;
  let y0: number | null = null, h0 = 0, cur = 0, moved = false, fromTitle = false, last: [number, number][] = [];
  head.onpointerdown = (e) => {
    const t = e.target as HTMLElement;
    fromTitle = !!t.closest('.ph b, .grab');
    if (t.closest('button:not(.grab), input, a')) return; // its own buttons still work
    if (sideMode.matches && !t.closest('.grab')) return;
    y0 = e.clientY; h0 = cur = p.offsetHeight - sheetShift(p); moved = false; last = [[e.clientY, e.timeStamp]];
    head.setPointerCapture(e.pointerId);
  };
  head.onpointermove = (e) => {
    if (y0 === null) return;
    if (sideMode.matches) {
      // Side panel: drag the inner edge to resize (20–45% of the screen).
      const sb = stage.getBoundingClientRect();
      const px = prefs.ui.panelSide === 'right' ? sb.right - e.clientX : e.clientX - sb.left;
      prefs.ui.panelW = clampPanelW((px / sb.width) * 100);
      applyPanelUi(); updateSheetSpace();
      return;
    }
    if (!moved && Math.abs(e.clientY - y0) < 6) return;
    const { peek, full } = snapHeights();
    if (!moved) {
      // Full height for the whole drag; only `translate` changes while the finger moves.
      moved = true; sheetDrag = true; clearTimeout(settleTimer); p.classList.add('dragging');
      h0 = p.offsetHeight - sheetShift(p);
      p.style.height = `${full}px`;
      p.style.translate = `0 ${full - h0}px`;
    }
    cur = Math.min(full, Math.max(peek, h0 - (e.clientY - y0)));
    p.style.translate = `0 ${full - cur}px`;
    last.push([e.clientY, e.timeStamp]); if (last.length > 5) last.shift();
  };
  const end = (e: PointerEvent) => {
    if (y0 === null) return;
    y0 = null;
    if (sideMode.matches) { savePrefs(); updateSheetSpace(); return; }
    p.classList.remove('dragging'); sheetDrag = false;
    if (!moved) { if (fromTitle && e.type === 'pointerup') setSnap(snap === 'peek' ? 'half' : 'peek'); return; }
    // Where a flick would carry it in ~0.2 s, then the nearest stop.
    const [ya, ta] = last[0], [yb, tb] = last[last.length - 1];
    const v = tb > ta ? (yb - ya) / (tb - ta) : 0; // px per ms, + = down
    const aim = cur - v * 200;
    const hs = snapHeights();
    const best = (Object.keys(hs) as Snap[]).reduce((a, b) => (Math.abs(hs[b] - aim) < Math.abs(hs[a] - aim) ? b : a));
    setSnap(best);
  };
  head.onpointerup = end;
  head.onpointercancel = end;
  // Landscape: move the panel to the other side.
  const close = p.querySelector<HTMLElement>('.ph .pc');
  if (close && !p.querySelector('.side-swap')) {
    close.insertAdjacentHTML('beforebegin', '<button class="pc side-swap" aria-label="Move panel to the other side" title="Move to the other side"><svg class="ico" viewBox="0 0 24 24"><path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/></svg></button>');
    p.querySelector<HTMLElement>('.side-swap')!.onclick = () => {
      prefs.ui.panelSide = prefs.ui.panelSide === 'right' ? 'left' : 'right';
      savePrefs(); applyPanelUi(); updateSheetSpace();
    };
  }
}
let panelCloseTimer = 0;
/** animate: slide down when the user closes it; instant when another panel replaces it. */
/** animate: slide the sheet down. 'replace': keep it open because another panel's content is coming. */
function closePanel(animate: boolean | 'replace' = false) {
  const p = $('#panel');
  clearTimeout(panelCloseTimer);
  if (animate === 'replace') { /* content is swapped by showPanel */ }
  else if (animate && !p.hidden) {
    p.classList.add('closing');
    panelCloseTimer = window.setTimeout(() => { p.hidden = true; p.innerHTML = ''; p.classList.remove('closing'); updateSheetSpace(); }, 260);
  } else { p.classList.remove('closing'); p.hidden = true; p.innerHTML = ''; }
  updateSheetSpace();
  S.panel = null;
  setSugg([]);
  syncToolbar();
}
function status(msg: string) {
  if (S.scan) S.scanMsg = msg;
  const el = document.getElementById('p-status'); if (el) el.textContent = msg;
}

/** The running scan's panel (opened again): its progress and the Stop button. */
function scanUi() {
  if (!S.scan || S.panel !== S.scanPanel || document.getElementById('p-stop')) return;
  status(S.scanMsg);
  const stop = document.createElement('button');
  stop.id = 'p-stop'; stop.className = 'danger'; stop.textContent = 'Stop';
  stop.onclick = askStopScan;
  document.getElementById('p-status')?.after(stop);
}

/** Settings → "Show technical check report": also show where the last scan's time went (per OCR step). */
function showTimings() {
  document.getElementById('p-timing')?.remove();
  const el = document.getElementById('p-status');
  if (!el || !prefs.advanced || !lastOcrStats.log.length) return;
  const d = document.createElement('details');
  d.id = 'p-timing'; d.className = 'hint';
  const sm = document.createElement('summary'); sm.textContent = 'OCR timings';
  const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.style.fontSize = '11px';
  pre.textContent = `${navigator.hardwareConcurrency || '?'} CPU cores\n` + lastOcrStats.log.join('\n');
  const copy = document.createElement('button');
  copy.textContent = 'Copy timings';
  copy.onclick = () => { void navigator.clipboard?.writeText(pre.textContent ?? '').then(() => toast('Copied'), () => toast('Copy failed')); };
  d.append(sm, pre, copy);
  el.after(d);
}

function setSugg(hits: Hit[]) {
  const pages = new Set([...S.sugg, ...hits].map((h) => h.page));
  S.sugg = hits.map((h) => ({ ...h, id: ++suggSeq, on: true }));
  suggGen++;
  for (const p of pages) drawBoxes(p);
  renderResults();
}

function toggleSugg(id: number, on?: boolean) {
  const sg = S.sugg.find((x) => x.id === id);
  if (!sg) return;
  sg.on = on ?? !sg.on;
  drawBoxes(sg.page);
  renderResults();
}

function applySugg(list: Sugg[]) {
  if (!list.length) return;
  addBoxes(list.flatMap((sg) => sg.rects.map((rect) => ({ page: sg.page, rect }))), list);
  const ids = new Set(list.map((x) => x.id));
  const pages = new Set(list.map((x) => x.page));
  S.sugg = S.sugg.filter((x) => !ids.has(x.id));
  S.applied.push(...list.map((x) => ({ ...x, on: true })));
  for (const p of pages) drawBoxes(p);
  renderResults();
  toast(`Redacted ${list.length} item(s)`);
}

function reveal(sg: Sugg) {
  const el = viewer.querySelector<HTMLElement>(`.page[data-i="${sg.page}"]`);
  if (!el) return;
  if (snap === 'full' && !sideMode.matches) setSnap('half'); // the document has to be visible to show the item
  const r = sg.rects[0];
  const vb = viewer.getBoundingClientRect(), eb = el.getBoundingClientRect();
  viewer.scrollTo({
    top: viewer.scrollTop + eb.top - vb.top + r.y * S.zoom - (viewer.clientHeight - (parseFloat(stage.style.getPropertyValue('--sheet-h')) || 0)) / 3,
    left: viewer.scrollLeft + eb.left - vb.left + r.x * S.zoom - 24,
    behavior: 'smooth',
  });
  el.querySelectorAll(`.sugg[data-sid="${sg.id}"]`).forEach((b) => {
    b.classList.remove('flash'); void (b as HTMLElement).offsetWidth; b.classList.add('flash');
  });
}

const MAX_ROWS = 400;
function renderResults() {
  const box = document.getElementById('p-results');
  if (!box) return;
  const detect = S.panel === 'detect';
  if (!S.sugg.length && !(detect && S.applied.length)) { box.innerHTML = ''; return; }
  if (detect && !S.sugg.length) S.resTab = 'done';
  const on = S.sugg.filter((x) => x.on).length;
  const tabs = detect
    ? `<div class="subtabs" role="tablist">
        <button role="tab" data-tab="items" aria-selected="${S.resTab === 'items'}" ${S.sugg.length ? '' : 'disabled'}>Found (${S.sugg.length})</button>
        <button role="tab" data-tab="types" aria-selected="${S.resTab === 'types'}" ${S.sugg.length ? '' : 'disabled'}>By type</button>
        <button role="tab" data-tab="done" aria-selected="${S.resTab === 'done'}">Redacted (${S.applied.filter((x) => x.on).length})</button></div>` : '';
  if (detect && S.resTab === 'done') {
    box.innerHTML = `${tabs}<div class="tabbody"><p class="hint">Changed your mind? Untick an item to remove its black box. Tick it again to put it back.</p>
      <ul class="hits">${S.applied.map((sg) => `<li data-aid="${sg.id}" class="${sg.on ? 'on' : 'off'}">
        <input type="checkbox" ${sg.on ? 'checked' : ''} aria-label="Redacted">
        <span class="tag">${esc(sg.label)}</span><span class="ht">${esc(sg.text)}</span><span class="pg">p${sg.page + 1}</span></li>`).join('')}</ul></div>`;
    syncToolbar();
    return;
  }
  const foot = `<div class="pfoot"><span class="hint">${on} of ${S.sugg.length} selected</span>
      <button id="r-all">All</button><button id="r-none">None</button>
      <button id="r-apply" class="primary" data-busy ${on ? '' : 'disabled'}>Redact (${on})</button></div>`;
  let body: string;
  if (S.panel === 'detect' && S.resTab === 'types') {
    const groups = new Map<string, { n: number; on: number }>();
    for (const sg of S.sugg) { const g = groups.get(sg.label) ?? { n: 0, on: 0 }; g.n++; if (sg.on) g.on++; groups.set(sg.label, g); }
    body = `<p class="hint">Tap a type to include or skip all of it. × removes it from the results.</p><div class="tchips">${[...groups].map(([label, g]) =>
      `<span class="tchip ${g.on ? 'on' : 'off'}" data-label="${esc(label)}"><span class="tl">${esc(label)}</span><b>${g.on}/${g.n}</b>
        <button class="tx" data-rmlabel="${esc(label)}" aria-label="Remove ${esc(label)}">×</button></span>`).join('')}</div>`;
  } else {
    body = `<ul class="hits">${S.sugg.slice(0, MAX_ROWS).map((sg) => `<li data-id="${sg.id}" class="${sg.on ? 'on' : 'off'}">
      <input type="checkbox" ${sg.on ? 'checked' : ''} aria-label="Include">
      <span class="tag">${esc(sg.label)}</span><span class="ht">${esc(sg.text)}</span><span class="pg">p${sg.page + 1}</span>
      <button class="one" data-busy>Redact</button></li>`).join('')}</ul>
      ${S.sugg.length > MAX_ROWS ? `<p class="hint">+${S.sugg.length - MAX_ROWS} more (all included in Redact)</p>` : ''}`;
  }
  box.innerHTML = `${tabs}<div class="tabbody"><div class="legend"><span><i class="l-on"></i>Will be redacted</span><span><i class="l-off"></i>Skipped</span></div>${foot}${body}</div>`;
  $('#r-all').onclick = () => { S.sugg.forEach((x) => { x.on = true; }); refreshSugg(); };
  $('#r-none').onclick = () => { S.sugg.forEach((x) => { x.on = false; }); refreshSugg(); };
  $('#r-apply').onclick = () => {
    if (S.busy) return;
    applySugg(S.sugg.filter((x) => x.on));
    // Auto Detect: a second scan finds nothing new, so close (setting). Find stays open for more searches.
    if (S.panel === 'detect' && prefs.opts.closeAfterRedact) closePanel(true);
  };
  syncToolbar();
}

/** Redacted tab: untick removes that item's boxes again (second thoughts), tick puts them back. */
function toggleApplied(id: number, on: boolean) {
  const it = S.applied.find((x) => x.id === id);
  if (!it || it.on === on) return;
  it.on = on;
  if (on) {
    const next = S.boxes.map((b) => b.length);
    apply({ type: 'group', ops: it.rects.map((rect) => ({ type: 'add' as const, page: it.page, rect, idx: next[it.page]++ })) });
  } else {
    // Delete from the end so earlier indices stay valid; boxes are the same Rect objects that were added.
    const idx = it.rects.map((r) => S.boxes[it.page].indexOf(r)).filter((k) => k >= 0).sort((x, y) => y - x);
    if (idx.length) apply({ type: 'group', ops: idx.map((k) => ({ type: 'del' as const, page: it.page, rect: S.boxes[it.page][k], idx: k })) });
  }
  renderResults();
}

/** Drop every suggestion of one type (By type ×). */
function removeType(label: string) {
  const pages = new Set(S.sugg.filter((x) => x.label === label).map((x) => x.page));
  S.sugg = S.sugg.filter((x) => x.label !== label);
  for (const p of pages) drawBoxes(p);
  renderResults();
}
function refreshSugg() { for (const p of new Set(S.sugg.map((x) => x.page))) drawBoxes(p); renderResults(); }

function bindResults() {
  const box = $('#p-results');
  box.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-tab]');
    if (tab) {
      if ((tab as HTMLButtonElement).disabled || S.resTab === tab.dataset.tab) return;
      S.resTab = tab.dataset.tab as typeof S.resTab; renderResults();
      box.querySelector('.tabbody')?.classList.add('swap');
      return;
    }
    const ali = t.closest<HTMLElement>('li[data-aid]');
    if (ali) {
      const it = S.applied.find((x) => x.id === Number(ali.dataset.aid));
      if (!it) return;
      if (t instanceof HTMLInputElement) toggleApplied(it.id, t.checked); else reveal(it);
      return;
    }
    const rmLabel = t.closest<HTMLElement>('[data-rmlabel]');
    if (rmLabel) { removeType(rmLabel.dataset.rmlabel!); return; }
    const tchip = t.closest<HTMLElement>('.tchip');
    if (tchip) {
      const label = tchip.dataset.label!;
      const group = S.sugg.filter((x) => x.label === label);
      const turnOn = !group.some((x) => x.on);
      group.forEach((x) => { x.on = turnOn; });
      refreshSugg();
      return;
    }
    const li = t.closest<HTMLElement>('li[data-id]');
    if (!li) return;
    const sg = S.sugg.find((x) => x.id === Number(li.dataset.id));
    if (!sg) return;
    if (t.classList.contains('one')) { if (!S.busy) applySugg([sg]); return; }
    if (t instanceof HTMLInputElement) { toggleSugg(sg.id, t.checked); return; }
    reveal(sg);
  });
}

/**
 * Every value Auto Detect found (a labelled name, an address…) is searched for again across the whole
 * document, so the same text is caught where it appears without a label (cover page, signature block).
 */
async function withRepeats(found: Hit[], signal?: AbortSignal): Promise<Hit[]> {
  if (!S.texts) return found;
  const seen = new Map<string, string>();
  for (const h of found) {
    const t = h.text.replace(/\s+/g, ' ').trim();
    if (t.replace(/\W/g, '').length >= 3 && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), h.label);
  }
  const pats: SearchPattern[] = [];
  [...seen].forEach(([t, label], i) => { const re = literalPattern(t, false, true); if (re) pats.push({ id: `repeat.${i}`, label, regex: re }); });
  if (!pats.length) return found;
  const more = await searchDocument(S.texts, pats, (m) => status(`Looking for the same details elsewhere… ${m}`), signal);
  const out = [...found];
  for (const h of more) {
    if (!out.some((o) => o.page === h.page && h.start < o.end && o.start < h.end)) out.push({ ...h, label: `${h.label} · repeat` });
  }
  return out.sort((a, b) => a.page - b.page || a.start - b.start);
}

/**
 * Read every page's text in the background as soon as a document is open (OCR for scanned pages), so
 * Auto Detect, Find and the copy-ready export find it done. Same cache: a scan just waits for pages in progress.
 */
async function prefetchText(cache: PageTextCache, signal: AbortSignal) {
  await new Promise((r) => setTimeout(r, 300)); // let the first pages paint
  // One page at a time, in order (two at once competed for memory and the main thread, and was slower).
  for (let i = 0; i < cache.doc.numPages; i++) {
    if (S.texts !== cache || signal.aborted) return; // another document was opened, or reading was stopped
    try { await abortable(cache.get(i), signal); } catch { return; }
  }
}

/** Stop reading the open document in the background (native scan and prefetch). Pages already read stay cached. */
function stopBackground() {
  S.prefetch?.abort(); S.prefetch = null;
  S.native?.cancel(); S.native = null;
}

/** Back or Stop during a scan: ask, then stop. Pages already read stay cached, so a new scan picks up from there. */
function askStopScan() {
  if (!S.scan) return;
  const auto = S.panel === 'detect';
  modal(`<h2>${auto ? 'Stop Auto Detect?' : 'Stop searching?'}</h2>
    <p class="hint">Pages already read are kept, so scanning again picks up where it stopped.</p>
    <div class="row"><button id="st-no">Keep going</button><button id="st-yes" class="primary danger">Stop</button></div>`, true);
  $('#st-no').onclick = closeModal;
  $('#st-yes').onclick = () => {
    closeModal();
    S.scan?.abort();
    S.prefetch?.abort(); S.prefetch = null;
    S.native?.cancel();
  };
}

/**
 * Long work that should survive leaving the app: after 1.5 s the host keeps it alive with a progress
 * notification, and says when it's done (only if the user isn't looking). Short work shows nothing.
 */
function startWork(title: string) {
  let started = false;
  const timer = window.setTimeout(() => { started = true; host.workStart?.(title); }, 1500);
  return {
    progress: (text: string, f: number) => { if (started) host.workProgress?.(text, f); },
    done: (t: string, text: string) => { window.clearTimeout(timer); if (started) host.workDone?.(t, text); },
  };
}
let work: ReturnType<typeof startWork> | null = null;

async function runScan(patterns: SearchPattern[], what: string, repeats = false) {
  if (!S.texts || S.busy) return;
  S.busy = true; syncToolbar();
  const ac = new AbortController();
  S.scan = ac; S.scanPanel = S.panel; S.scanMsg = '';
  const own = S.panel;
  scanUi();
  try {
    lastOcrStats.log.push('--- scan started');
    S.native?.resume(); // after a stopped scan: read the rest natively again
    work = startWork(`Scanning ${what}`);
    const t0 = performance.now();
    let all = await searchDocument(S.texts, patterns, (m, f) => { status(m); work?.progress(m.replace(/:.*/, ''), f); }, ac.signal);
    const t1 = performance.now();
    if (repeats) all = await withRepeats(all, ac.signal);
    lastOcrStats.log.push(`scan: read+match ${Math.round(t1 - t0)} ms, repeats ${Math.round(performance.now() - t1)} ms`);
    // Don't offer what is already redacted (each rect fully inside an existing box). Partly covered hits are still offered.
    const hits = all.filter((h) => !alreadyRedacted(h));
    const done = all.length - hits.length;
    if (S.panel !== own) { if (own === 'find') openFind(); else openDetect(); } // closed meanwhile: open it for the results
    setSugg(hits);
    const pages = new Set(hits.map((h) => h.page)).size;
    const doneMsg = done ? ` ${done} already redacted.` : '';
    const secs = ` (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
    status(hits.length ? `Found ${hits.length} ${what} on ${pages} page(s)${secs}.${doneMsg} Untick anything to keep, then tap Redact.`
      : done ? `Everything found (${done}) is already redacted.` : `No ${what} found${secs}.`);
    showTimings();
    work?.done('Scan finished', hits.length ? `${hits.length} item(s) found. Ready to review.` : 'Nothing found. Ready to review.');
    work = null;
  } catch (e) {
    if (isAbort(e)) {
      work?.done('Scan stopped', 'You stopped the scan.'); work = null;
      status('Stopped. Pages already read are kept: scanning again picks up from there.');
      return;
    }
    work?.done('Scan stopped', 'Something went wrong. Open Umbra PDF for details.'); work = null;
    status(`Failed: ${(e as Error).message}`);
    toast((e as Error).message, 5000);
  } finally {
    S.scan = null; S.scanPanel = null;
    document.getElementById('p-stop')?.remove();
    if (document.getElementById('st-yes')) closeModal(); // "Stop?" was still open: nothing left to stop
    S.busy = false; syncToolbar();
  }
}

const inside = (r: Rect, b: Rect, tol = 0.75) =>
  r.x >= b.x - tol && r.y >= b.y - tol && r.x + r.w <= b.x + b.w + tol && r.y + r.h <= b.y + b.h + tol;
const alreadyRedacted = (h: Hit) => h.rects.every((r) => (S.boxes[h.page] ?? []).some((b) => inside(r, b)));

/** Add a term (if new) and search for all current terms. */
async function runFind(q: string, matchCase: boolean, wholeWord = false) {
  const term = q.trim();
  if (!term) { status('Type something to find.'); return; }
  if (!S.findTerms.some((t) => t.q === term && t.matchCase === matchCase && t.wholeWord === wholeWord)) {
    S.findTerms.push({ q: term, matchCase, wholeWord });
  }
  await searchTerms();
}

async function searchTerms() {
  renderTerms();
  if (!S.findTerms.length) { setSugg([]); status(''); return; }
  const patterns = S.findTerms.flatMap((t, i) => {
    const re = literalPattern(t.q, t.matchCase, t.wholeWord);
    return re ? [{ id: `find.${i}`, label: `“${t.q}”`, regex: re }] : [];
  });
  await runScan(patterns, 'match(es)');
}

function renderTerms() {
  const el = document.getElementById('f-terms');
  if (!el) return;
  el.innerHTML = S.findTerms.map((t, i) => `<span class="tchip on"><span class="tl">${esc(t.q)}${t.matchCase ? ' · Aa' : ''}${t.wholeWord ? ' · word' : ''}</span>
    <button class="tx" data-rmterm="${i}" aria-label="Remove ${esc(t.q)}">×</button></span>`).join('');
}

async function runDetect(enabled: string[], custom: CustomPattern[]) {
  const patterns = buildPatterns(enabled, custom, { platesNeedLabel: prefs.opts.platesLabelled, always: prefs.detect.always });
  S.resTab = 'items';
  if (!patterns.length) { status('Turn on at least one detector.'); return; }
  await runScan(patterns, 'personal detail(s)', true);
}

function openFind() {
  if (!S.doc) return;
  closePanel('replace');
  S.panel = 'find';
  showPanel(`<div class="ph"><b>Find</b>${helpBtn('find', 'Find')}<button class="pc" id="p-close" aria-label="Close">×</button></div>${helpBox('find')}
    <form class="prow" id="f-form"><input id="f-q" type="search" placeholder="Word or phrase" enterkeyhint="search" autocomplete="off">
      <button class="primary" data-busy>Find</button></form>
    <div class="chips"><button class="chip" id="f-case" aria-pressed="false">Match case</button><button class="chip" id="f-word" aria-pressed="false">Whole word</button></div>
    <div class="tchips" id="f-terms"></div>
    <div id="p-status" class="hint" role="status"></div><div id="p-results"></div>`);
  $('#p-close').onclick = () => closePanel(true);
  for (const id of ['#f-case', '#f-word']) {
    const b = $(id);
    b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  }
  const on = (id: string) => $(id).getAttribute('aria-pressed') === 'true';
  $('#f-form').onsubmit = async (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('#f-q');
    await runFind(q.value, on('#f-case'), on('#f-word'));
    q.value = '';
  };
  $('#f-terms').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rmterm]');
    if (!b || S.busy) return;
    S.findTerms.splice(Number(b.dataset.rmterm), 1);
    void searchTerms();
  };
  renderTerms();
  bindResults();
  syncToolbar();
  scanUi();
  if (!S.scan) $<HTMLInputElement>('#f-q').focus();
}

function openDetect() {
  if (!S.doc) return;
  closePanel('replace');
  S.panel = 'detect';
  const dp = prefs.detect;
  showPanel(`<div class="ph"><b>Auto Detect</b>${helpBtn('detect', 'Auto Detect')}<button class="pc" id="p-close" aria-label="Close">×</button></div>${helpBox('detect')}
    <div class="prow"><button id="d-go" class="primary" data-busy>Scan document</button></div>
    <div id="p-status" class="hint" role="status"></div><div id="p-results"></div>
    <details id="d-cfg"><summary>Choose what to find</summary>
      <div class="grid" id="d-grid"></div>
      <div id="d-form" class="cform" hidden>
        <div class="prow"><input id="d-label" placeholder="Name, e.g. Staff ID" autocomplete="off"></div>
        <div class="prow"><input id="d-re" placeholder="Pattern (regex), e.g. EMP-\\d{5}" autocomplete="off" spellcheck="false"></div>
        <p id="d-err" class="fail hint"></p>
        <div class="prow" style="justify-content:flex-end"><button id="d-cancel">Cancel</button><button id="d-save" class="primary">Add</button></div>
      </div>
    </details>
  `);
  $('#p-close').onclick = () => closePanel(true);
  const grid = $('#d-grid');
  const render = () => {
    grid.innerHTML = PRESETS.map((p) => `<button class="tile" data-preset="${p.id}" aria-pressed="${dp.enabled.includes(p.id)}">
        <b>${esc(p.label)}</b><small>${esc(p.description)}</small></button>`).join('')
      + dp.custom.map((c, i) => `<button class="tile" data-custom="${i}" aria-pressed="true" title="${esc(c.source)}">
        <b>${esc(c.label || 'Custom')}</b><small>${esc(c.source)}</small><span class="rm" data-rm="${i}" role="button" aria-label="Remove">✕</span></button>`).join('')
      + `<button class="tile add" id="d-new">+ Custom pattern</button>`;
  };
  render();
  grid.onclick = (e) => {
    const t = e.target as HTMLElement;
    const rm = t.closest<HTMLElement>('[data-rm]');
    if (rm) { dp.custom.splice(Number(rm.dataset.rm), 1); savePrefs(); render(); return; }
    const tile = t.closest<HTMLElement>('.tile');
    if (!tile) return;
    if (tile.id === 'd-new') { $('#d-form').hidden = false; $<HTMLInputElement>('#d-label').focus(); return; }
    const id = tile.dataset.preset;
    if (!id) return;
    dp.enabled = dp.enabled.includes(id) ? dp.enabled.filter((x) => x !== id) : [...dp.enabled, id];
    tile.setAttribute('aria-pressed', String(dp.enabled.includes(id)));
    savePrefs();
  };
  const hideForm = () => { $('#d-form').hidden = true; $('#d-err').textContent = ''; $<HTMLInputElement>('#d-label').value = ''; $<HTMLInputElement>('#d-re').value = ''; };
  $('#d-cancel').onclick = hideForm;
  $('#d-save').onclick = () => {
    const c: CustomPattern = { label: $<HTMLInputElement>('#d-label').value.trim(), source: $<HTMLInputElement>('#d-re').value, ignoreCase: true };
    try { compileCustom(c); } catch (err) { $('#d-err').textContent = (err as Error).message; return; }
    dp.custom.push(c); savePrefs(); hideForm(); render();
  };
  if (S.applied.length) { // Redacted tab available straight away for second thoughts
    $('#panel').querySelector<HTMLElement>('.intro')?.setAttribute('hidden', '');
    renderResults();
  }
  $('#d-go').onclick = async () => {
    await runDetect(dp.enabled, dp.custom);
    ($('#d-cfg') as HTMLDetailsElement).open = false; // results come first after a scan
    $('#panel').querySelector<HTMLElement>('.intro')?.setAttribute('hidden', ''); // more room for results
  };
  bindResults();
  syncToolbar();
  scanUi();
}

// ---------- Export ----------
export interface ExportOutcome { bytes: Uint8Array; report: VerifyReport; downscaled: { page: number; dpi: number }[]; ocrWords: number; timings: [string, number][] }

async function runExport(opts: ExportOptions, ocr: boolean, onProgress: (m: string, f: number, step: ExportStep) => void, method: 'vector' | 'image' = 'image'): Promise<ExportOutcome> {
  if (!S.doc) throw new Error('No document');
  const timings: [string, number][] = [];
  let t0 = performance.now();
  const lap = (name: string) => { const t = performance.now(); timings.push([name, t - t0]); t0 = t; };
  const boxed = S.boxes.some((b) => b.length);
  // One bar for the whole export: each step gets its share (roughly its usual time) and the bar never goes back.
  const [made, structured] = !boxed ? [0.85, 1] : method === 'vector' ? [0.45, 0.65] : [0.8, 0.85];
  const part = (a: number, b: number, step: ExportStep) => (m: string, f: number) => onProgress(m, a + (b - a) * Math.min(1, Math.max(0, f)), step);
  const vec = method === 'vector' ? await exportVectorChecked(S.bytes!, S.password, S.boxes, part(0, made, 'make')) : null;
  const res = vec
    ? { bytes: vec.bytes, downscaled: [], ocrWords: 0 }
    : await exportRedacted(S.doc, S.boxes, opts, part(0, made, 'make'), S.texts ? (i) => S.texts!.known(i).then((pt) => ({ words: pageTextWords(pt), layer: pt.source !== 'ocr', scanWords: pt.scanWords })) : undefined);
  lap(vec ? 'Redact (MuPDF)' : 'Build pages');
  const report = await verifyOutput(res.bytes, part(made, structured, 'check'), { searchable: opts.searchable, redactions: S.boxes, mode: method });
  lap('Structure check');
  const under = part(structured, 1, 'check');
  if (vec && boxed) {
    // Keep original text leaves shapes that are only partly under a box (e.g. text drawn as outlines) in the file,
    // hidden by the black box. So the same redaction without boxes (made in the same pass) must show nothing
    // readable where the boxes go. Always run, and fail closed: the structural checks above only see real text.
    under('Checking under the black boxes', 0);
    try {
      if (!vec.bare) throw new Error('no copy without boxes');
      report.ocr = await ocrRedactedRegions(vec.bare, S.boxes, under);
      if (report.ocr.leaks.length) {
        report.ok = false;
        report.issues.push(`Readable content left under ${report.ocr.leaks.length} box(es). Use "Image only" for this file`);
      }
    } catch (e) {
      report.ok = false;
      report.issues.push(`Could not check under the black boxes: ${(e as Error).message}`);
    }
    lap('Under-box check');
  } else if (ocr && boxed) {
    try {
      under('Double-checking blacked-out areas', 0);
      report.ocr = await ocrRedactedRegions(res.bytes, S.boxes, under);
      if (report.ocr.leaks.length) {
        report.ok = false;
        report.issues.push(`OCR found text in ${report.ocr.leaks.length} redacted region(s)`);
      }
    } catch (e) {
      // The structural checks above are the hard guarantee; the OCR pass is an extra safety net.
      report.notes = [...(report.notes ?? []), `OCR double-check unavailable: ${(e as Error).message}`];
    }
    lap('Black-box check');
  }
  onProgress('Done', 1, 'check');
  const out = { bytes: res.bytes, report, downscaled: res.downscaled, ocrWords: res.ocrWords, timings };
  // Kept so Split (or Export again) with the same boxes and settings needn't redo the redaction and its checks.
  S.verified = ocr && report.ok ? { key: exportKey(opts, method), out } : null;
  return out;
}

/** 'make': building the redacted copy; 'check': proving it's safe. */
type ExportStep = 'make' | 'check';

/** What a redacted copy depends on: the boxes and the export settings that shape it. */
const exportKey = (opts: ExportOptions, method: 'vector' | 'image') =>
  JSON.stringify([method, method === 'image' ? [opts.dpi, opts.format, opts.jpegQuality, opts.maxPixels, opts.searchable] : 0, S.boxes]);

const ICON_OK = '<svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_BAD = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>';

/** Export choices this document was last exported with; Settings → Export defaults otherwise. Not saved. */
let docExport: ExportPrefs | null = null;

/** Method + image settings: shared by the Export dialog and Settings → Export defaults (never open together). */
function exportChoiceHtml(e: ExportPrefs): string {
  return `<div class="segctl" id="x-method">
      <button data-m="vector" aria-pressed="${e.method === 'vector'}">Keep original text</button>
      <button data-m="image" aria-pressed="${e.method === 'image'}">Image only</button></div>
    <div class="spbox" id="x-image-opts">
    ${helpH('h3', 'Image settings', 'image')}
    <label class="row2"><span>Quality</span><select id="x-dpi">
      ${[[150, 'Small file'], [200, 'Good'], [300, 'High (recommended)'], [400, 'Very high'], [600, 'Print']].map(([d, l]) =>
        `<option value="${d}"${d === e.dpi ? ' selected' : ''}>${l} · ${d} DPI</option>`).join('')}
    </select></label>
    <label class="row2"><span>File size</span><select id="x-fmt">
      ${([['auto', 'Auto (smallest file)'], ['png', 'Sharp (lossless, larger)'], ['jpeg', 'Photo (JPEG)']] as const).map(([v, l]) =>
        `<option value="${v}"${e.compression === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label class="row2"><span>Searchable text (OCR)</span>
      <input id="x-search" class="switch" type="checkbox" ${e.searchable ? 'checked' : ''}></label>
    </div>`;
}

/** Wire exportChoiceHtml: every change is written into `e`, then `changed` runs. */
function bindExportChoice(e: ExportPrefs, changed: () => void) {
  const show = (instant = false) => {
    slide($('#x-image-opts'), e.method === 'image', instant);
    $('#x-method').querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === e.method)));
  };
  $('#x-method').onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-m]');
    if (!b) return;
    e.method = b.dataset.m as ExportPrefs['method']; show(); changed();
  };
  $('#x-dpi').onchange = () => { e.dpi = Number($<HTMLSelectElement>('#x-dpi').value); changed(); };
  $('#x-fmt').onchange = () => { e.compression = $<HTMLSelectElement>('#x-fmt').value as ExportPrefs['compression']; changed(); };
  $('#x-search').onchange = () => { e.searchable = $<HTMLInputElement>('#x-search').checked; changed(); };
  show(true);
}

function exportDialog() {
  const total = S.boxes.reduce((n, b) => n + b.length, 0);
  const pending = S.sugg.filter((x) => x.on).length;
  const ex: ExportPrefs = { ...(docExport ?? prefs.export) };
  modal(`<div class="fillbody"><h2>Save a redacted copy</h2>
    ${total ? '' : '<p class="note">Nothing is redacted. That\'s fine: you\'ll still get a cleaned copy, searchable too if OCR is on.</p>'}
    ${pending ? `<p class="fail">${pending} found item(s) aren't redacted yet. Tap "Redact" in the panel first.</p>` : ''}
    ${prefs.opts.reviewReminder && total ? '<p class="note">Before exporting, scroll through every page. Auto Detect and Find can miss unusual formats.</p>' : ''}
    ${helpH('h3', 'How to remove content', 'export')}
    ${exportChoiceHtml(ex)}
    ${helpH('h3', 'Split into files', 'split')}
    ${splitOptionsHtml(S.sizes.length)}
    </div><div class="row"><button id="x-cancel">Cancel</button><button id="x-go" class="primary">Continue</button></div>`, true, null, true);
  const split = bindSplitOptions(S.sizes.length, $<HTMLButtonElement>('#x-go'));
  // Start loading the redaction engine (~10 MB WASM) while the user reads the dialog, after any animation
  // (loading it holds this thread for a moment).
  const warm = () => { if (ex.method === 'vector') setTimeout(() => void loadMuPdf().catch(() => {}), 400); };
  bindExportChoice(ex, warm);
  warm();
  $('#x-cancel').onclick = closeModal;
  $('#x-go').onclick = async () => {
    const method = ex.method;
    const opts: ExportOptions = { ...DEFAULT_EXPORT, dpi: ex.dpi, format: ex.compression, searchable: ex.searchable };
    docExport = ex;
    const spec = split.spec();
    modal(`<h2>Preparing your copy…</h2><p id="x-msg" class="hint">Starting</p><progress id="x-bar" max="1" value="0"></progress>`);
    S.busy = true; syncToolbar();
    const w = startWork('Preparing your redacted copy');
    try {
      await painted(); // the redaction engine blocks this thread, so show the progress page before it starts
      const xo: ExportOptions = { ...opts, searchable: method === 'image' && opts.searchable };
      // Exported already with these boxes and settings (e.g. once whole, now split): reuse that checked copy.
      const done = S.verified?.key === exportKey(xo, method) ? S.verified.out : null;
      const out = done ?? await runExport(xo, true, (m, f, step) => {
        const label = step === 'make' ? 'Making the pages' : 'Checking it\'s safe';
        const msg = document.getElementById('x-msg'); if (msg) msg.textContent = prefs.advanced ? m : `${label}…`;
        const bar = document.getElementById('x-bar') as HTMLProgressElement | null; if (bar) bar.value = f;
        w.progress(label, f);
      }, method);
      if (out.report.ok && spec) {
        // Never cut the original: only the redacted copy that just passed the safety check.
        const t0 = performance.now();
        const parts = await splitPdf(out.bytes, undefined, spec);
        const timings: [string, number][] = [...(done ? [['Redacted copy reused', 0] as [string, number]] : out.timings), ['Split', performance.now() - t0]];
        w.done('Ready to save', 'Your redacted copy passed the safety check and is split. Tap to save it.');
        splitResult(parts, timings);
        return;
      }
      w.done(out.report.ok ? 'Ready to save' : 'Not saved, to keep you safe', out.report.ok ? 'Your redacted copy passed the safety check. Tap to save it.' : 'The final check found a problem. Open Umbra PDF for details.');
      resultDialog(out);
    } catch (e) {
      w.done('Export stopped', 'Something went wrong. Open Umbra PDF for details.');
      exportFailed(e);
    } finally {
      S.busy = false; syncToolbar();
    }
  };
}

/**
 * Resolves once the page has drawn what was just put on screen: after the next frame, or after 150 ms if no
 * frame comes (a still screen on Android can stop sending frames), so work that follows never waits on one.
 */
function painted(): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, 150);
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(t); r(); }, 0));
  });
}

/** Export threw (nothing was saved): say why, and what to do. */
function exportFailed(e: unknown) {
  const hidden = (e as Error).name === 'HiddenLayersError', hiddenText = (e as Error).name === 'HiddenTextError';
  modal(`<div class="big-icon bad">${ICON_BAD}</div><h2>${hidden ? 'This PDF has hidden layers' : hiddenText ? 'This PDF has hidden text' : 'Something went wrong'}</h2>
    <p class="hint">${hidden
      ? 'Parts of this file are switched off and never shown, so they couldn\'t be reviewed. Nothing was saved. Export again with "Image only", which keeps only what you can see.'
      : hiddenText
        ? 'A page you redacted also has text you can\'t see (for example a scan\'s text layer), and it may not line up with your boxes. Nothing was saved. Export again with "Image only", which keeps only what you can see and can still make it searchable.'
        : 'Nothing was saved. Try again, or pick a lower quality if the file is very large.'}</p>
    <details><summary>Details</summary><p>${esc((e as Error).message)}</p></details>
    <div class="row"><button id="r-close">Close</button></div>`, true);
  $('#r-close').onclick = closeModal;
}

/** OCR and per-page timings (Advanced), with a Copy button: what's needed to tell where time goes. */
function ocrLogHtml(): string {
  const log = lastOcrStats.log.slice(-80);
  if (!log.length) return '';
  return `<details><summary>OCR timings</summary><pre id="ocr-log" style="white-space:pre-wrap;font-size:11px">${esc(`${navigator.hardwareConcurrency || '?'} CPU cores\n${log.join('\n')}`)}</pre>
    <button type="button" data-copy-log>Copy timings</button></details>`;
}

function technicalReport({ bytes, report, downscaled, ocrWords, timings }: ExportOutcome): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const mb = (bytes.length / 1048576).toFixed(2);
  const li = (s: string) => `<li>${esc(s)}</li>`;
  return `<ul>${[
    `${report.pages} page(s), ${mb} MB`,
    report.searchable ? `Text layer: ${ocrWords} OCR words, ${report.textInBoxes} inside redactions` : `Extractable text: ${report.textChars} chars`,
    `Fonts: ${report.fontPages.length ? `pages ${report.fontPages.join(', ')}` : 'none / allowed only'}`,
    `Annotations: ${report.annotations}; risky catalog keys: ${report.catalogKeys.join(', ') || 'none'}; metadata: ${report.metadataFields.join(', ') || 'none'}`,
    report.ocr ? `Black-box check: ${report.ocr.checkedRegions} region(s), ${report.ocr.solidRegions ?? 0} solid, ${report.ocr.checkedRegions - (report.ocr.solidRegions ?? 0)} OCR'd, ${report.ocr.leaks.length} leak(s)` : 'Black-box check: not run (no boxes)',
    `Time: ${timings.map(([n, ms]) => `${n} ${sec(ms)}`).join(', ')} (total ${sec(timings.reduce((a, [, ms]) => a + ms, 0))})`,
    ...(report.notes ?? []),
    ...downscaled.map((d) => `Page ${d.page} reduced to ${d.dpi} DPI to fit memory`),
    ...report.issues.map((i) => `ISSUE: ${i}`),
  ].map(li).join('')}</ul>${ocrLogHtml()}`;
}

function resultDialog(out: ExportOutcome) {
  const { bytes, report } = out;
  if (report.ok) {
    modal(`<div class="big-icon ok">${ICON_OK}</div><h2>Safe to share</h2>
      <p class="hint">We checked the copy: no hidden text, links, forms or file details, and nothing readable under the black boxes.${report.searchable ? ' Visible text stays searchable.' : ''}</p>
      <p class="note">${report.pages} page(s) · ${bytes.length >= 1048576 ? `${(bytes.length / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`}</p>
      ${prefs.advanced ? `<details open><summary>Technical report</summary>${technicalReport(out)}</details>` : ''}
      <div class="row"><button id="r-close">Cancel</button><button id="r-save" class="primary">Save PDF</button></div>`, true);
    $('#r-close').onclick = closeModal;
    $('#r-save').onclick = async () => {
      const ok = await host.savePdf(`${S.name}-redacted.pdf`, bytes);
      if (ok) S.dirty = false;
      closeModal();
      toast(ok ? 'Saved' : 'Save cancelled');
    };
  } else {
    // Fail closed: no save path offered.
    modal(`<div class="big-icon bad">${ICON_BAD}</div><h2>Not saved, to keep you safe</h2>
      <p class="hint">The final check found something that might reveal hidden content, so Umbra didn't save it. ${report.issues.some((i) => /Image only/.test(i))
        ? 'Export again with "Image only", which keeps only what you can see.' : 'Try again with a higher quality, or draw slightly larger boxes.'}</p>
      <details ${prefs.advanced ? 'open' : ''}><summary>Details</summary>${technicalReport(out)}</details>
      <div class="row"><button id="r-close">Close</button></div>`, true);
    $('#r-close').onclick = closeModal;
  }
}

// ---------- Split ----------
let lastSplit: SplitSpec & { every: number; ranges: string; cut: 'lr' | 'tb'; rtl: boolean; widerOnly: boolean } =
  { mode: 'every', every: 1, ranges: '', cut: 'lr', rtl: false, widerOnly: true };

const sizeText = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Split options inside the Export dialog. */
function splitOptionsHtml(n: number): string {
  const L = lastSplit;
  return `<div class="segctl" id="sp-mode">
      <button data-m="none">One file</button><button data-m="every">Every N</button><button data-m="ranges">Ranges</button><button data-m="half">Halves</button></div>
    <div class="spbox" id="sp-every">
      <label class="row2"><span>Pages in each file</span>
        <input id="sp-n" type="number" min="1" max="${n}" value="${Math.min(L.every, n)}" inputmode="numeric" style="width:6em"></label>
    </div>
    <div class="spbox" id="sp-ranges">
      <label class="row2" for="sp-r"><span>Page ranges</span></label>
      <input id="sp-r" placeholder="e.g. 1-3, 4, 8-" autocomplete="off" spellcheck="false" inputmode="text" enterkeyhint="done" value="${esc(L.ranges)}" style="width:100%">
    </div>
    <div class="spbox" id="sp-half">
      <div class="segctl" id="sp-cut"><button data-c="lr">Left | Right</button><button data-c="tb">Top / Bottom</button></div>
      ${row2('<span id="sp-wide-t">Only cut pages that are wider than tall</span>', `<input id="sp-wide" class="switch" type="checkbox" ${L.widerOnly ? 'checked' : ''}>`, 'sp-wide', 'A cover or single page in the scan stays whole.')}
      <div id="sp-rtl-row">${row2('Right page first', `<input id="sp-rtl" class="switch" type="checkbox" ${L.rtl ? 'checked' : ''}>`, 'sp-rtl', 'For books read right to left.')}</div>
    </div>
    <p class="note" id="sp-plan"></p>`;
}

/** Wire the split options; `go` is disabled while they don't make sense. `spec()` is null for one file. */
function bindSplitOptions(n: number, go: HTMLButtonElement): { spec: () => SplitSpec | null } {
  let mode: SplitSpec['mode'] | 'none' = 'none', cut = lastSplit.cut;
  const spec = (): SplitSpec | null => mode === 'none' ? null : mode === 'every'
    ? { mode, every: Math.max(1, Math.min(n, Math.floor(Number($<HTMLInputElement>('#sp-n').value) || 1))) }
    : mode === 'ranges' ? { mode, ranges: $<HTMLInputElement>('#sp-r').value }
    : { mode, cut, rtl: cut === 'lr' && $<HTMLInputElement>('#sp-rtl').checked, widerOnly: $<HTMLInputElement>('#sp-wide').checked };
  const show = (instant = false) => {
    swapBox(['every', 'ranges', 'half'].map((m) => $(`#sp-${m}`)), mode === 'none' ? null : $(`#sp-${mode}`), instant);
    $('#sp-mode').querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
    $('#sp-cut').querySelectorAll<HTMLElement>('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === cut)));
    slide($('#sp-rtl-row'), cut === 'lr', instant);
    $('#sp-wide-t').textContent = cut === 'lr' ? 'Only cut pages that are wider than tall' : 'Only cut pages that are taller than wide';
    const plan = $('#sp-plan');
    let ok = true;
    try {
      const s = spec();
      if (!s) plan.textContent = `1 file, ${n} page${n === 1 ? '' : 's'}`;
      else if (s.mode === 'half') {
        const cuts = S.sizes.filter((z) => !s.widerOnly || (s.cut === 'lr' ? z.width > z.height : z.height > z.width)).length;
        plan.textContent = cuts ? `1 file, ${n + cuts} pages (${cuts} of ${n} cut in half)` : `No page is ${s.cut === 'lr' ? 'wider than tall' : 'taller than wide'}, so nothing would be cut.`;
        ok = cuts > 0;
      } else {
        const parts = planSplit(s, n);
        const names = parts.slice(0, 4).map((p) => (p.length === 1 ? `${p[0] + 1}` : `${p[0] + 1}-${p[p.length - 1] + 1}`)).join(', ');
        plan.textContent = `${parts.length} file${parts.length === 1 ? '' : 's'}: pages ${names}${parts.length > 4 ? ', …' : ''}`;
      }
      plan.classList.remove('fail');
    } catch (e) {
      plan.textContent = e instanceof SplitRangeError ? e.message : String(e);
      plan.classList.add('fail');
      ok = false;
    }
    go.disabled = !ok;
  };
  $('#sp-mode').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
    if (!b) return;
    mode = b.dataset.m as typeof mode; show();
  };
  $('#sp-cut').onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-c]'); if (b) { cut = b.dataset.c as typeof cut; show(); } };
  for (const id of ['#sp-n', '#sp-r', '#sp-wide', '#sp-rtl']) $(id).addEventListener('input', () => show());
  show(true);
  return { spec: () => { const v = spec(); if (v) lastSplit = { ...lastSplit, ...v }; return v; } };
}

function splitResult(parts: SplitPart[], timings: [string, number][] = []) {
  const base = `${S.name}-redacted`;
  const files = parts.map((p) => ({ name: `${base}-${p.label}.pdf`, bytes: p.bytes }));
  const bytes = files.reduce((k, f) => k + f.bytes.length, 0);
  const multi = files.length > 1;
  modal(`<div class="big-icon ok">${ICON_OK}</div><h2>${multi ? `${files.length} files ready` : 'Ready'}</h2>
    <p class="hint">Cut from your redacted copy, which passed the safety check. ${multi
      ? host.name === 'android' ? 'Pick a folder and they\'re all saved there.' : 'Pick a folder, or they download as one ZIP.' : ''}</p>
    <p class="note">${multi ? `${esc(files[0].name)} … ${esc(files[files.length - 1].name)}` : esc(files[0].name)} · ${sizeText(bytes)}</p>
    ${prefs.advanced && timings.length ? `<details open><summary>Technical report</summary><ul><li>Time: ${esc(timings.map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)} s`).join(', '))}</li></ul>${ocrLogHtml()}</details>` : ''}
    <div class="row"><button id="r-close">Cancel</button><button id="r-save" class="primary">${multi ? 'Save files' : 'Save PDF'}</button></div>`, true);
  $('#r-close').onclick = closeModal;
  $('#r-save').onclick = async () => {
    let saved: number | false = false;
    try {
      saved = multi && host.saveFiles ? await host.saveFiles(`${base}-split.zip`, files)
        : multi ? await saveOneByOne(files)
        : (await host.savePdf(files[0].name, files[0].bytes)) ? 1 : false;
    } catch (e) {
      closeModal();
      toast(`Save failed: ${(e as Error).message}`, 5000);
      return;
    }
    if (saved) S.dirty = false;
    closeModal();
    toast(saved === false ? 'Save cancelled' : `Saved ${saved} file${saved === 1 ? '' : 's'}`);
  };
}

/** A host that can only save one file at a time: ask for each. */
async function saveOneByOne(files: OpenedFile[]): Promise<number | false> {
  let n = 0;
  for (const f of files) { if (!(await host.savePdf(f.name, f.bytes))) break; n++; }
  return n || false;
}

// ---------- Wiring ----------
$('#btn-close').onclick = () => { if (S.busy) return; if (S.panel) closePanel(); if (S.dirty && prefs.opts.confirmLeave) confirmLeave(() => void closeDocument()); else void closeDocument(); };
$('#btn-open-2').onclick = pickAndLoad;
$('#mode-draw').onclick = () => { S.mode = 'draw'; syncToolbar(); };
$('#mode-pan').onclick = () => { S.mode = 'pan'; syncToolbar(); };
$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#btn-reset').onclick = resetAll;
$('#btn-settings').onclick = settingsDialog;
$('#zoom-in').onclick = () => setZoom(S.zoom * 1.25);
$('#zoom-out').onclick = () => setZoom(S.zoom / 1.25);
$('#btn-export').onclick = () => S.doc && !S.busy && exportDialog();
// "Copy timings" in a technical report (inline handlers are blocked by the CSP).
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-copy-log]')) return;
  void navigator.clipboard?.writeText(document.getElementById('ocr-log')?.textContent ?? '').then(() => toast('Copied'), () => toast('Copy failed'));
});
$('#btn-find').onclick = () => (S.panel === 'find' ? closePanel(true) : openFind());
$('#btn-detect').onclick = () => (S.panel === 'detect' ? closePanel(true) : openDetect());
document.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) return;
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
});
host.onExternalOpen((f) => {
  closeModal();
  if (S.doc && S.dirty && prefs.opts.confirmLeave) confirmLeave(() => void loadFile(f)); else void loadFile(f);
});
host.onBack(handleBack);
// Desktop browsers: a PDF can also be dropped on the window (see platform/browser.ts).
if (host.name === 'browser') $('#btn-open-2').insertAdjacentHTML('afterend', '<p class="drop-hint">or drop a PDF anywhere in this window</p>');
// Closing the browser tab with redactions not exported yet: the browser asks first (like "Leave this document?").
window.addEventListener('beforeunload', (e) => { if (S.doc && S.dirty && prefs.opts.confirmLeave) e.preventDefault(); });
syncToolbar();

// The app crashed last time: show what happened once, so it can be copied into a bug report.
{
  let crash = '';
  try { crash = (window as unknown as { UmbraAndroid?: { lastCrash?(): string } }).UmbraAndroid?.lastCrash?.() ?? ''; } catch { /* old shell */ }
  if (crash) {
    setTimeout(() => {
      modal(`<h2>Umbra PDF closed unexpectedly last time</h2>
        <p class="hint">Nothing about your document is included below. Copy it and send it to the developer to get this fixed.</p>
        <pre style="white-space:pre-wrap;font-size:11px;max-height:40vh;overflow:auto">${esc(crash)}</pre>
        <div class="row"><button id="c-copy">Copy</button><button id="c-close" class="primary">OK</button></div>`, true);
      $('#c-copy').onclick = () => { void navigator.clipboard?.writeText(crash).then(() => toast('Copied'), () => toast('Copy failed')); };
      $('#c-close').onclick = closeModal;
    }, 1800);
  }
}

// Splash: ~1.5 s from launch, then fade into the app.
{
  const splash = document.getElementById('splash');
  const t0 = performance.now(); // ms since the page started loading
  window.setTimeout(() => {
    splash?.classList.add('out');
    window.setTimeout(() => splash?.remove(), 400);
  }, Math.max(400, 1500 - t0));
}

// Automation hook for E2E tests (no I/O; operates on in-memory state only).
(window as unknown as { __umbraTest: unknown }).__umbraTest = {
  load: (bytes: Uint8Array, name = 'test.pdf') => loadFile({ name, bytes }),
  setBoxes: (boxes: Rect[][]) => { S.boxes = boxes.map((b) => [...b]); S.sizes.forEach((_, i) => drawBoxes(i)); },
  sizes: () => S.sizes,
  export: (opts: Partial<ExportOptions> = {}, ocr = false, method: 'vector' | 'image' = 'image') => runExport({ ...DEFAULT_EXPORT, ...opts }, ocr, () => {}, method),
  verifyVector: (bytes: Uint8Array, boxes: Rect[][]) => verifyOutput(bytes, () => {}, { searchable: false, redactions: boxes, mode: 'vector' }),
  split: async (spec: SplitSpec) => (await splitPdf(S.bytes!, S.password, spec)).map((p) => ({ label: p.label, pages: p.pages, bytes: Array.from(p.bytes) })),
  exportVectorRaw: (boxes: Rect[][], blackBoxes = true) => exportVector(S.bytes!, S.password, boxes, () => {}, { blackBoxes }),
  applied: () => S.applied.map((x) => ({ id: x.id, on: x.on, label: x.label, text: x.text })),
  toggleApplied: (id: number, on: boolean) => toggleApplied(id, on),
  verify: (bytes: Uint8Array, boxes?: Rect[][]) =>
    verifyOutput(bytes, () => {}, boxes ? { searchable: true, redactions: boxes } : undefined),
  // raw: only the file's own spaces, a new line where pdf.js ends one (what a reader's search sees).
  text: async (bytes: Uint8Array, raw = false) => {
    const d = await openPdf(bytes);
    let t = '';
    for (let i = 1; i <= d.numPages; i++) {
      const tc = await (await d.getPage(i)).getTextContent();
      t += raw ? tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('')
        : tc.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
    }
    await closePdf(d);
    return t;
  },
  ocrRegions: (bytes: Uint8Array, boxes: Rect[][]) => ocrRedactedRegions(bytes, boxes),
  // Share of near-black pixels inside each box (rendered at 72 DPI), per page: 1 = fully blacked out.
  boxDarkness: async (bytes: Uint8Array, boxes: Rect[][]) => {
    const d = await openPdf(bytes);
    const out: number[][] = [];
    for (let i = 0; i < boxes.length; i++) {
      const c = document.createElement('canvas');
      await renderToCanvas(await d.getPage(i + 1), c, 2);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      out.push(boxes[i].map((r) => {
        const px = g.getImageData(Math.round(r.x * 2) + 2, Math.round(r.y * 2) + 2, Math.max(1, Math.round(r.w * 2) - 4), Math.max(1, Math.round(r.h * 2) - 4)).data;
        let dark = 0; for (let k = 0; k < px.length; k += 4) if (px[k] + px[k + 1] + px[k + 2] < 90) dark++;
        return dark / (px.length / 4);
      }));
    }
    await closePdf(d);
    return out;
  },
  boxes: () => S.boxes,
  zoom: () => S.zoom,
  detectPrefs: () => prefs.detect,
  exportPrefs: () => prefs.export,
  setAlways: (w: string[]) => { prefs.detect.always = cleanAlways(w); savePrefs(); return prefs.detect.always; },
  pageText: async (i: number) => (await S.texts!.get(i)).text,
  pageWords: async (i: number) => pageTextWords(await S.texts!.get(i)).map(({ text, line, x0, y0, x1, y1 }) => ({ text, line, x0, y0, x1, y1 })),
  ocrStats: () => ({ ...lastOcrStats, log: [...lastOcrStats.log] }),
  resetOcrStats: () => resetOcrStats(),
  setOcrEngine: (e: 'paddle' | 'tesseract') => setOcrEngine(e),
  setOcrLang: (l: OcrLang) => setOcrLang(l),
  ocrLang: () => getOcrLang(),
  fitZoom: () => fitZoom(),
  pointAt: (cx: number, cy: number) => pointAt(cx, cy),
  setMode: (m: 'draw' | 'pan') => { S.mode = m; syncToolbar(); },
  search: async (q: string, matchCase = false, wholeWord = false) => { if (S.panel !== 'find') openFind(); S.findTerms = []; await runFind(q, matchCase, wholeWord); return S.sugg; },
  addTerm: async (q: string) => { if (S.panel !== 'find') openFind(); await runFind(q, false, false); return { terms: S.findTerms.length, hits: S.sugg.length }; },
  removeTerm: async (i: number) => { S.findTerms.splice(i, 1); await searchTerms(); return { terms: S.findTerms.length, hits: S.sugg.length }; },
  removeType: (label: string) => { removeType(label); return S.sugg; },
  setOpt: (k: keyof Options, v: boolean) => { prefs.opts[k] = v; },
  setAdvanced: (v: boolean) => { prefs.advanced = v; },
  detect: async (enabled: string[], custom: CustomPattern[] = []) => { if (S.panel !== 'detect') openDetect(); await runDetect(enabled, custom); return S.sugg; },
  applyOne: (id: number) => applySugg(S.sugg.filter((x) => x.id === id)),
  applyAll: () => applySugg(S.sugg.filter((x) => x.on)),
  toggle: (id: number) => toggleSugg(id),
  undo,
  redo,
  deleteBox: (page: number, idx: number) => { S.sel = { page, idx }; deleteSelected(); },
  canRedo: () => S.redo.length > 0,
  reset: () => { resetAll(); ($('#rs-yes') as HTMLButtonElement | null)?.click(); },
  back: () => handleBack(),
  showResult: async () => { resultDialog(await runExport({ ...DEFAULT_EXPORT }, false, () => {})); },
  startDetect: (enabled: string[]) => { if (S.panel !== 'detect') openDetect(); (window as unknown as { __scan: Promise<void> }).__scan = runDetect(enabled, []); },
  scanning: () => !!S.scan,
  mode: () => S.mode,
  state: () => ({ hasDoc: !!S.doc, dirty: S.dirty, panel: S.panel, modal: !$('#modal').hidden && !$('#modal').classList.contains('closing') }),
};

import './ui/styles.css';
import {
  openPdf, closePdf, pageSizes, renderToCanvas, exportRedacted, verifyOutput, ocrRedactedRegions,
  PasswordRequiredError, DEFAULT_EXPORT,
  PageTextCache, searchDocument, exportVector, literalPattern, buildPatterns, compileCustom, PRESETS, DEFAULT_PRESET_IDS,
  type PDFDocumentProxy, type PageSize, type Rect, type VerifyReport, type ExportOptions,
  type Hit, type SearchPattern, type CustomPattern,
} from './engine';
import { detectHost, type OpenedFile } from './platform/host';

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
  zoom: 1, // CSS px per PDF point
  mode: 'draw' as 'draw' | 'pan',
  sel: null as { page: number; idx: number } | null,
  rendered: new Set<number>(),
  gen: 0, // invalidates in-flight renders after zoom/open
  busy: false,
  sugg: [] as Sugg[],
  panel: null as 'find' | 'detect' | null,
  texts: null as PageTextCache | null,
  dirty: false, // unsaved redaction changes
  findTerms: [] as { q: string; matchCase: boolean; wholeWord: boolean }[],
  resTab: 'items' as 'items' | 'types' | 'done',
  applied: [] as Sugg[], // items redacted from Find/Auto Detect this session (Redacted tab: untick to un-redact)
  bytes: null as Uint8Array | null, // original file, for "Keep original text" export
  password: undefined as string | undefined,
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
function modal(html: string, dismissable = false, onDismiss: (() => void) | null = null) {
  const wasOpen = !$('#modal').hidden && !$('#modal').classList.contains('closing');
  clearTimeout(modalCloseTimer); $('#modal').classList.remove('closing');
  $('#toast').classList.remove('show'); $('#sheet').innerHTML = html; $('#modal').hidden = false;
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
  for (const id of ['#zoom-in', '#zoom-out', '#btn-export', '#btn-find', '#btn-detect']) $<HTMLButtonElement>(id).disabled = !has || S.busy;
  $('#btn-find').classList.toggle('on', S.panel === 'find');
  $('#btn-detect').classList.toggle('on', S.panel === 'detect');
  document.querySelectorAll<HTMLButtonElement>('#panel [data-busy]').forEach((b) => { b.disabled = S.busy; });
  $<HTMLButtonElement>('#btn-undo').disabled = !S.undo.length || S.busy;
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
      <div class="row"><button id="pw-cancel">Cancel</button><button id="pw-ok" class="primary">Open</button></div>`);
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
  S.applied = [];
  S.sizes = await pageSizes(doc);
  S.boxes = S.sizes.map(() => []);
  S.undo = [];
  S.dirty = false;
  S.sel = null;
  S.sugg = [];
  S.texts = new PageTextCache(doc);
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
  if (S.doc) await closePdf(S.doc);
  Object.assign(S, { doc: null, name: '', sizes: [], boxes: [], undo: [], sel: null, sugg: [], texts: null, dirty: false, applied: [], bytes: null, password: undefined });
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

/** Android Back: close dialog → close panel → leave document (asking if unsaved) → let the OS handle it. */
function handleBack(): boolean {
  if (dismissModal()) return true;
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
  viewer.querySelectorAll<HTMLElement>('.page').forEach((el, i) => {
    el.style.width = `${S.sizes[i].width * S.zoom}px`;
    el.style.height = `${S.sizes[i].height * S.zoom}px`;
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

function setZoom(z: number) {
  const anchor = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  S.zoom = Math.min(4, Math.max(0.2, z));
  S.rendered.clear();
  S.gen++;
  layoutPages();
  viewer.scrollTop = anchor * viewer.scrollHeight;
}

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
  Object.assign(el.style, {
    left: `${r.x * S.zoom}px`, top: `${r.y * S.zoom}px`, width: `${r.w * S.zoom}px`, height: `${r.h * S.zoom}px`,
  });
}

function select(sel: typeof S.sel) {
  const prev = S.sel;
  S.sel = sel;
  if (prev) drawBoxes(prev.page);
  if (sel && sel.page !== prev?.page) drawBoxes(sel.page);
  syncToolbar();
}

function apply(a: Action, record = true) {
  const ops = a.type === 'group' ? a.ops : [a];
  for (const o of ops) {
    if (o.type === 'add') S.boxes[o.page].splice(o.idx, 0, o.rect);
    else S.boxes[o.page].splice(o.idx, 1);
  }
  if (record) S.undo.push(a);
  S.dirty = true;
  S.sel = null;
  for (const p of new Set(ops.map((o) => o.page))) drawBoxes(p);
  syncToolbar();
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

function undo() {
  const a = S.undo.pop();
  if (!a) return;
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
    if (S.mode !== 'draw' || S.busy || e.button > 0) return;
    ov.setPointerCapture(e.pointerId);
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
interface ExportPrefs { dpi: number; format: ExportOptions['format']; searchable: boolean; method: 'vector' | 'image' }
interface Options { hideRecents: boolean; platesLabelled: boolean; confirmLeave: boolean; closeAfterRedact: boolean; reviewReminder: boolean }
const DEFAULT_OPTIONS: Options = { hideRecents: false, platesLabelled: true, confirmLeave: true, closeAfterRedact: true, reviewReminder: true };
interface Prefs { theme: ThemePref; advanced: boolean; detect: { enabled: string[]; custom: CustomPattern[] }; export: ExportPrefs; opts: Options }
function loadPrefs(): Prefs {
  const d: Prefs = {
    theme: 'system', advanced: false, detect: { enabled: [...DEFAULT_PRESET_IDS], custom: [] },
    export: { dpi: DEFAULT_EXPORT.dpi, format: DEFAULT_EXPORT.format, searchable: true, method: 'vector' },
    opts: { ...DEFAULT_OPTIONS },
  };
  try {
    const v = JSON.parse(host.loadPrefs() ?? 'null') as Partial<Prefs> | null;
    if (!v) return d;
    return {
      theme: v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system',
      advanced: v.advanced === true,
      opts: (() => {
        const raw = (v.opts ?? {}) as unknown as Record<string, unknown>;
        const o = { ...DEFAULT_OPTIONS };
        for (const k of Object.keys(o) as (keyof Options)[]) if (typeof raw[k] === 'boolean') o[k] = raw[k] as boolean;
        return o;
      })(),
      detect: v.detect && Array.isArray(v.detect.enabled) && Array.isArray(v.detect.custom) ? v.detect : d.detect,
      export: {
        dpi: [150, 200, 300, 400, 600].includes(Number(v.export?.dpi)) ? Number(v.export!.dpi) : d.export.dpi,
        format: v.export?.format === 'jpeg' ? 'jpeg' : 'png',
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

const OPTION_ROWS: [keyof Options, string, string][] = [
  ['closeAfterRedact', 'Close Auto Detect after Redact', 'Go straight back to the document. Reopen Auto Detect to review or undo items in its Redacted tab. Find always stays open.'],
  ['confirmLeave', 'Ask before leaving unsaved work', 'Back or opening another file asks first if your redactions aren\'t exported.'],
  ['reviewReminder', 'Remind me to check every page', 'Shows a reminder when exporting. Auto Detect can miss unusual formats.'],
  ['platesLabelled', 'Vehicle plates only when labelled', 'Only flag plates next to words like “vehicle”, “kenderaan” or “plate”. Fewer false matches.'],
  ['hideRecents', 'Hide content in Recent apps', 'Blanks the app preview in the app switcher. This also blocks screenshots.'],
];

function settingsDialog() {
  if (S.busy) return;
  const seg = (v: ThemePref, l: string) => `<button data-theme-opt="${v}" aria-pressed="${prefs.theme === v}">${l}</button>`;
  modal(`<h2>Settings</h2>
    <h3>Appearance</h3>
    <div class="segctl">${seg('system', 'System')}${seg('light', 'Light')}${seg('dark', 'Dark')}</div>
    <h3>Preferences</h3>
    ${OPTION_ROWS.map(([k, t, h]) => `<label class="row2"><span>${t}<small class="hint">${h}</small></span>
      <input class="switch" type="checkbox" data-opt="${k}" ${prefs.opts[k] ? 'checked' : ''}></label>`).join('')}
    <h3>Advanced</h3>
    <label class="row2"><span>Show technical check report<small class="hint">For IT and troubleshooting. The safety check always runs either way.</small></span>
      <input id="s-adv" class="switch" type="checkbox" ${prefs.advanced ? 'checked' : ''}></label>
    <h3>About</h3>
    <p class="hint">Umbra PDF works fully offline. Your files never leave this device. Open source under GPL-3.0.</p>
    <div class="row"><button id="s-close" class="primary">Done</button></div>`, true);
  $('#sheet').querySelectorAll<HTMLButtonElement>('[data-theme-opt]').forEach((b) => {
    b.onclick = () => {
      prefs.theme = b.dataset.themeOpt as ThemePref; savePrefs(); applyTheme();
      $('#sheet').querySelectorAll('[data-theme-opt]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  });
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
function updateSheetSpace() {
  const p = $('#panel');
  const h = p.hidden || p.classList.contains('closing') ? 0
    : p.classList.contains('peek') ? parseFloat(getComputedStyle(p).getPropertyValue('--peek-h')) || 64
    : p.offsetHeight;
  stage.style.setProperty('--sheet-h', `${Math.round(h)}px`);
}
new ResizeObserver(updateSheetSpace).observe($('#panel'));

function showPanel(html: string) {
  const p = $('#panel');
  const wasOpen = !p.hidden && !p.classList.contains('closing');
  clearTimeout(panelCloseTimer);
  p.classList.remove('peek', 'closing');
  p.innerHTML = `<button class="grab" id="p-grab" aria-label="Collapse or expand panel"><i></i></button>${html}`;
  p.scrollTop = 0;
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

/** Tap the handle (or the title) to collapse the panel to its header; drag down/up does the same. */
function bindGrab(p: HTMLElement) {
  const toggle = (force?: boolean) => {
    const ph = p.querySelector<HTMLElement>('.ph');
    p.scrollTop = 0;
    if (ph) p.style.setProperty('--peek-h', `${Math.ceil(ph.getBoundingClientRect().bottom - p.getBoundingClientRect().top) + 4}px`);
    p.classList.toggle('peek', force);
    updateSheetSpace();
  };
  const grab = $('#p-grab');
  let y0: number | null = null;
  grab.onpointerdown = (e) => { y0 = e.clientY; grab.setPointerCapture(e.pointerId); };
  grab.onpointerup = (e) => {
    if (y0 === null) return;
    const dy = e.clientY - y0; y0 = null;
    if (Math.abs(dy) < 8) toggle(); else toggle(dy > 0);
  };
  p.querySelector<HTMLElement>('.ph b')?.addEventListener('click', () => toggle());
}
let panelCloseTimer = 0;
/** animate: slide down when the user closes it; instant when another panel replaces it. */
/** animate: slide the sheet down. 'replace': keep it open because another panel's content is coming. */
function closePanel(animate: boolean | 'replace' = false) {
  const p = $('#panel');
  clearTimeout(panelCloseTimer);
  if (animate === 'replace') { /* content is swapped by showPanel */ }
  else if (animate && !p.hidden) {
    p.classList.remove('peek');
    p.classList.add('closing');
    panelCloseTimer = window.setTimeout(() => { p.hidden = true; p.innerHTML = ''; p.classList.remove('closing'); updateSheetSpace(); }, 260);
  } else { p.classList.remove('closing', 'peek'); p.hidden = true; p.innerHTML = ''; }
  updateSheetSpace();
  S.panel = null;
  setSugg([]);
  syncToolbar();
}
function status(msg: string) { const el = document.getElementById('p-status'); if (el) el.textContent = msg; }

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
async function withRepeats(found: Hit[]): Promise<Hit[]> {
  if (!S.texts) return found;
  const seen = new Map<string, string>();
  for (const h of found) {
    const t = h.text.replace(/\s+/g, ' ').trim();
    if (t.replace(/\W/g, '').length >= 3 && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), h.label);
  }
  const pats: SearchPattern[] = [];
  [...seen].forEach(([t, label], i) => { const re = literalPattern(t, false, true); if (re) pats.push({ id: `repeat.${i}`, label, regex: re }); });
  if (!pats.length) return found;
  const more = await searchDocument(S.texts, pats, (m) => status(`Looking for the same details elsewhere… ${m}`));
  const out = [...found];
  for (const h of more) {
    if (!out.some((o) => o.page === h.page && h.start < o.end && o.start < h.end)) out.push({ ...h, label: `${h.label} · repeat` });
  }
  return out.sort((a, b) => a.page - b.page || a.start - b.start);
}

async function runScan(patterns: SearchPattern[], what: string, repeats = false) {
  if (!S.texts || S.busy) return;
  S.busy = true; syncToolbar();
  try {
    let all = await searchDocument(S.texts, patterns, (m) => status(m));
    if (repeats) all = await withRepeats(all);
    // Don't offer what is already redacted (each rect fully inside an existing box). Partly covered hits are still offered.
    const hits = all.filter((h) => !alreadyRedacted(h));
    const done = all.length - hits.length;
    setSugg(hits);
    const pages = new Set(hits.map((h) => h.page)).size;
    const doneMsg = done ? ` ${done} already redacted.` : '';
    status(hits.length ? `Found ${hits.length} ${what} on ${pages} page(s).${doneMsg} Untick anything to keep, then tap Redact.`
      : done ? `Everything found (${done}) is already redacted.` : `No ${what} found.`);
  } catch (e) {
    status(`Failed: ${(e as Error).message}`);
    toast((e as Error).message, 5000);
  } finally {
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
  const patterns = buildPatterns(enabled, custom, { platesNeedLabel: prefs.opts.platesLabelled });
  S.resTab = 'items';
  if (!patterns.length) { status('Turn on at least one detector.'); return; }
  await runScan(patterns, 'personal detail(s)', true);
}

function openFind() {
  if (!S.doc) return;
  closePanel('replace');
  S.panel = 'find';
  showPanel(`<div class="ph"><b>Find &amp; redact</b><button class="pc" id="p-close" aria-label="Close">×</button></div>
    <form class="prow" id="f-form"><input id="f-q" type="search" placeholder="Word or phrase" enterkeyhint="search" autocomplete="off">
      <button class="primary" data-busy>Find</button></form>
    <div class="chips"><button class="chip" id="f-case" aria-pressed="false">Match case</button><button class="chip" id="f-word" aria-pressed="false">Whole word</button></div>
    <div class="tchips" id="f-terms"></div>
    <p class="hint intro">Each search stays as a filter above. Tap × to remove it. Scanned pages are read with on-device OCR first.</p>
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
  $<HTMLInputElement>('#f-q').focus();
}

function openDetect() {
  if (!S.doc) return;
  closePanel('replace');
  S.panel = 'detect';
  const dp = prefs.detect;
  showPanel(`<div class="ph"><b>Find personal details</b><button class="pc" id="p-close" aria-label="Close">×</button></div>
    <div class="prow"><button id="d-go" class="primary" data-busy>Scan document</button></div>
    <p class="hint intro">Finds IC numbers, phones, emails, accounts, addresses and labelled names. Nothing is redacted until you confirm. Use Find for anything it misses.</p>
    <div id="p-status" class="hint" role="status"></div><div id="p-results"></div>
    <details id="d-cfg"><summary>Advanced config <small class="hint">· choose detectors, custom patterns</small></summary>
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
}

// ---------- Export ----------
export interface ExportOutcome { bytes: Uint8Array; report: VerifyReport; downscaled: { page: number; dpi: number }[]; ocrWords: number }

async function runExport(opts: ExportOptions, ocr: boolean, onProgress: (m: string, f: number) => void, method: 'vector' | 'image' = 'image'): Promise<ExportOutcome> {
  if (!S.doc) throw new Error('No document');
  const res = method === 'vector'
    ? { bytes: await exportVector(S.bytes!, S.password, S.boxes, onProgress), downscaled: [], ocrWords: 0 }
    : await exportRedacted(S.doc, S.boxes, opts, onProgress);
  const report = await verifyOutput(res.bytes, onProgress, { searchable: opts.searchable, redactions: S.boxes, mode: method });
  if (ocr && S.boxes.some((b) => b.length)) {
    try {
      onProgress('Double-checking blacked-out areas', 1);
      report.ocr = await ocrRedactedRegions(res.bytes, S.boxes, onProgress);
      if (report.ocr.leaks.length) {
        report.ok = false;
        report.issues.push(`OCR found text in ${report.ocr.leaks.length} redacted region(s)`);
      }
    } catch (e) {
      // The structural checks above are the hard guarantee; the OCR pass is an extra safety net.
      report.notes = [...(report.notes ?? []), `OCR double-check unavailable: ${(e as Error).message}`];
    }
  }
  return { bytes: res.bytes, report, downscaled: res.downscaled, ocrWords: res.ocrWords };
}

const ICON_OK = '<svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_BAD = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>';

function exportDialog() {
  const total = S.boxes.reduce((n, b) => n + b.length, 0);
  const pending = S.sugg.filter((x) => x.on).length;
  const m0 = prefs.export.method;
  modal(`<h2>Save a redacted copy</h2>
    <div class="segctl" id="x-method">
      <button data-m="vector" aria-pressed="${m0 === 'vector'}">Keep original text</button>
      <button data-m="image" aria-pressed="${m0 === 'image'}">Image only</button></div>
    <p class="hint" id="x-desc"></p>
    ${total ? '' : '<p class="note">Nothing is redacted. That\'s fine: you\'ll still get a cleaned copy, searchable too if OCR is on.</p>'}
    ${pending ? `<p class="fail">${pending} found item(s) aren't redacted yet. Tap "Redact" in the panel first.</p>` : ''}
    ${prefs.opts.reviewReminder && total ? '<p class="note">Before exporting, scroll through every page. Auto Detect and Find can miss unusual formats.</p>' : ''}
    <div id="x-image-opts">
    <label class="row2"><span>Quality</span><select id="x-dpi">
      ${[[150, 'Small file'], [200, 'Good'], [300, 'High (recommended)'], [400, 'Very high'], [600, 'Print']].map(([d, l]) =>
        `<option value="${d}"${d === prefs.export.dpi ? ' selected' : ''}>${l} · ${d} DPI</option>`).join('')}
    </select></label>
    <label class="row2"><span>Compression</span><select id="x-fmt">
      <option value="png"${prefs.export.format === 'png' ? ' selected' : ''}>Sharp (best for text)</option><option value="jpeg"${prefs.export.format === 'jpeg' ? ' selected' : ''}>Photo (JPEG)</option>
    </select></label>
    <label class="row2"><span>Keep text selectable &amp; searchable (OCR)
      <small class="hint">Reads the visible text on your device so you can copy and search it. Blacked-out parts are never included.</small></span>
      <input id="x-search" class="switch" type="checkbox" ${prefs.export.searchable ? 'checked' : ''}></label>
    </div>
    <div class="row"><button id="x-cancel">Cancel</button><button id="x-go" class="primary">Continue</button></div>`, true);
  let method = m0;
  const DESC = {
    vector: 'Recommended. Text, shapes and image parts under your boxes are removed from the file itself; everything else stays as real text, so the copy looks like the original, stays small and is fully searchable.',
    image: 'Maximum safety. Every page becomes a picture with your boxes burned in and nothing else from the original is kept. Larger files; text is searchable only with OCR.',
  };
  const showMethod = () => {
    $('#x-desc').textContent = DESC[method];
    $('#x-image-opts').hidden = method !== 'image';
    $('#x-method').querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === method)));
  };
  $('#x-method').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
    if (!b) return;
    method = b.dataset.m as typeof method; showMethod();
    $('#x-image-opts').animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
  };
  showMethod();
  $('#x-cancel').onclick = closeModal;
  $('#x-go').onclick = async () => {
    const opts: ExportOptions = {
      ...DEFAULT_EXPORT,
      dpi: Number($<HTMLSelectElement>('#x-dpi').value),
      format: $<HTMLSelectElement>('#x-fmt').value as ExportOptions['format'],
      searchable: $<HTMLInputElement>('#x-search').checked,
    };
    prefs.export = { dpi: opts.dpi, format: opts.format, searchable: opts.searchable, method }; savePrefs();
    modal(`<h2>Preparing your copy…</h2><p id="x-msg" class="hint">Starting</p><progress id="x-bar" max="1" value="0"></progress>`);
    S.busy = true; syncToolbar();
    try {
      const out = await runExport({ ...opts, searchable: method === 'image' && opts.searchable }, true, (m, f) => {
        const msg = document.getElementById('x-msg'); if (msg && prefs.advanced) msg.textContent = m;
        else if (msg) msg.textContent = f < 1 ? 'Making the pages…' : 'Checking it\'s safe…';
        const bar = document.getElementById('x-bar') as HTMLProgressElement | null; if (bar) bar.value = f;
      }, method);
      resultDialog(out);
    } catch (e) {
      const hidden = (e as Error).name === 'HiddenLayersError';
      modal(`<div class="big-icon bad">${ICON_BAD}</div><h2>${hidden ? 'This PDF has hidden layers' : 'Something went wrong'}</h2>
        <p class="hint">${hidden
          ? 'Parts of this file are switched off and never shown, so they couldn\'t be reviewed. Nothing was saved. Export again with "Image only", which keeps only what you can see.'
          : 'Nothing was saved. Try again, or pick a lower quality if the file is very large.'}</p>
        <details><summary>Details</summary><p>${esc((e as Error).message)}</p></details>
        <div class="row"><button id="r-close">Close</button></div>`);
      $('#r-close').onclick = closeModal;
    } finally {
      S.busy = false; syncToolbar();
    }
  };
}

function technicalReport({ bytes, report, downscaled, ocrWords }: ExportOutcome): string {
  const mb = (bytes.length / 1048576).toFixed(2);
  const li = (s: string) => `<li>${esc(s)}</li>`;
  return `<ul>${[
    `${report.pages} page(s), ${mb} MB`,
    report.searchable ? `Text layer: ${ocrWords} OCR words, ${report.textInBoxes} inside redactions` : `Extractable text: ${report.textChars} chars`,
    `Fonts: ${report.fontPages.length ? `pages ${report.fontPages.join(', ')}` : 'none / allowed only'}`,
    `Annotations: ${report.annotations}; risky catalog keys: ${report.catalogKeys.join(', ') || 'none'}; metadata: ${report.metadataFields.join(', ') || 'none'}`,
    report.ocr ? `OCR double-check: ${report.ocr.checkedRegions} region(s), ${report.ocr.leaks.length} leak(s)` : 'OCR double-check: not run (no boxes)',
    ...(report.notes ?? []),
    ...downscaled.map((d) => `Page ${d.page} reduced to ${d.dpi} DPI to fit memory`),
    ...report.issues.map((i) => `ISSUE: ${i}`),
  ].map(li).join('')}</ul>`;
}

function resultDialog(out: ExportOutcome) {
  const { bytes, report } = out;
  if (report.ok) {
    modal(`<div class="big-icon ok">${ICON_OK}</div><h2>Safe to share</h2>
      <p class="hint">We checked the copy: no hidden text, links, forms or file details, and nothing readable under the black boxes.${report.searchable ? ' Visible text stays searchable.' : ''}</p>
      <p class="note">${report.pages} page(s) · ${bytes.length >= 1048576 ? `${(bytes.length / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.length / 1024))} KB`}</p>
      ${prefs.advanced ? `<details open><summary>Technical report</summary>${technicalReport(out)}</details>` : ''}
      <div class="row"><button id="r-close">Cancel</button><button id="r-save" class="primary">Save PDF</button></div>`);
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
      <p class="hint">The final check found something that might reveal hidden content, so Umbra didn't save it. Try again with a higher quality, or draw slightly larger boxes.</p>
      <details ${prefs.advanced ? 'open' : ''}><summary>Details</summary>${technicalReport(out)}</details>
      <div class="row"><button id="r-close">Close</button></div>`);
    $('#r-close').onclick = closeModal;
  }
}

// ---------- Wiring ----------
$('#btn-open').onclick = pickAndLoad;
$('#btn-open-2').onclick = pickAndLoad;
$('#mode-draw').onclick = () => { S.mode = 'draw'; syncToolbar(); };
$('#mode-pan').onclick = () => { S.mode = 'pan'; syncToolbar(); };
$('#btn-undo').onclick = undo;
$('#btn-settings').onclick = settingsDialog;
$('#zoom-in').onclick = () => setZoom(S.zoom * 1.25);
$('#zoom-out').onclick = () => setZoom(S.zoom / 1.25);
$('#btn-export').onclick = () => S.doc && !S.busy && exportDialog();
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
syncToolbar();

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
  exportVectorRaw: (boxes: Rect[][], blackBoxes = true) => exportVector(S.bytes!, S.password, boxes, () => {}, { blackBoxes }),
  applied: () => S.applied.map((x) => ({ id: x.id, on: x.on, label: x.label, text: x.text })),
  toggleApplied: (id: number, on: boolean) => toggleApplied(id, on),
  verify: (bytes: Uint8Array, boxes?: Rect[][]) =>
    verifyOutput(bytes, () => {}, boxes ? { searchable: true, redactions: boxes } : undefined),
  text: async (bytes: Uint8Array) => {
    const d = await openPdf(bytes);
    let t = '';
    for (let i = 1; i <= d.numPages; i++) {
      const tc = await (await d.getPage(i)).getTextContent();
      t += tc.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
    }
    await closePdf(d);
    return t;
  },
  ocrRegions: (bytes: Uint8Array, boxes: Rect[][]) => ocrRedactedRegions(bytes, boxes),
  boxes: () => S.boxes,
  search: async (q: string, matchCase = false, wholeWord = false) => { if (S.panel !== 'find') openFind(); S.findTerms = []; await runFind(q, matchCase, wholeWord); return S.sugg; },
  addTerm: async (q: string) => { if (S.panel !== 'find') openFind(); await runFind(q, false, false); return { terms: S.findTerms.length, hits: S.sugg.length }; },
  removeTerm: async (i: number) => { S.findTerms.splice(i, 1); await searchTerms(); return { terms: S.findTerms.length, hits: S.sugg.length }; },
  removeType: (label: string) => { removeType(label); return S.sugg; },
  setOpt: (k: keyof Options, v: boolean) => { prefs.opts[k] = v; },
  detect: async (enabled: string[], custom: CustomPattern[] = []) => { if (S.panel !== 'detect') openDetect(); await runDetect(enabled, custom); return S.sugg; },
  applyOne: (id: number) => applySugg(S.sugg.filter((x) => x.id === id)),
  applyAll: () => applySugg(S.sugg.filter((x) => x.on)),
  toggle: (id: number) => toggleSugg(id),
  undo,
  back: () => handleBack(),
  state: () => ({ hasDoc: !!S.doc, dirty: S.dirty, panel: S.panel, modal: !$('#modal').hidden && !$('#modal').classList.contains('closing') }),
};

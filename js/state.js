/* ══════════════════════════════════════════════════════════
   state.js — the workspace model
   ------------------------------------------------------------------
   Nothing here ever touches a real PDF. Every operation edits a plain
   list of page descriptors; the actual PDF is only assembled at export
   time (see pageops.js → buildPdf). That is what makes undo free and
   "move page between documents" a one-line splice.
   ══════════════════════════════════════════════════════════ */

export const uid = () => Math.random().toString(36).slice(2, 10);

export const PRESETS = {
  a4:      { w: 595,  h: 842,  label: 'A4' },
  a4l:     { w: 842,  h: 595,  label: 'A4 landscape' },
  letter:  { w: 612,  h: 792,  label: 'Letter' },
  letterl: { w: 792,  h: 612,  label: 'Letter landscape' },
  legal:   { w: 612,  h: 1008, label: 'Legal' },
  a3:      { w: 842,  h: 1191, label: 'A3' },
  a5:      { w: 420,  h: 595,  label: 'A5' },
};

export const state = {
  /** id → { id, name, bytes:Uint8Array, pdfjs, dims:[{w,h,rotate}], pageCache:Map } */
  sources: new Map(),
  /** id → { id, name, bytes:Uint8Array, mime, w, h, url } */
  images: new Map(),
  /** [{ id, name, pages:[Page] }] */
  docs: [],
  activeDoc: null,
  current: 0,
  selection: new Set(),
  undo: [],
  redo: [],
  dirty: false,
};

/* ── page factories ─────────────────────────────────────── */

const emptyCrop = () => ({ l: 0, t: 0, r: 0, b: 0 });

export function pdfPage(srcId, srcPage) {
  return { id: uid(), kind: 'pdf', src: srcId, srcPage, rotation: 0,
           crop: emptyCrop(), size: null, overlays: [] };
}
export function blankPage(w = 595, h = 842) {
  return { id: uid(), kind: 'blank', src: null, srcPage: 0, rotation: 0,
           crop: emptyCrop(), size: null, base: { w, h }, overlays: [] };
}
export function imagePage(imgId, w, h, margin = 0) {
  return { id: uid(), kind: 'image', src: imgId, srcPage: 0, rotation: 0,
           crop: emptyCrop(), size: null, base: { w, h }, margin, overlays: [] };
}

export function clonePage(p) {
  return { ...structuredClone(p), id: uid() };
}

/* ── geometry ───────────────────────────────────────────── */

/** Raw, unrotated media size of whatever the page points at. */
export function rawSize(page) {
  if (page.kind === 'pdf') {
    const d = state.sources.get(page.src).dims[page.srcPage];
    return { w: d.w, h: d.h, rotate: d.rotate };
  }
  return { w: page.base.w, h: page.base.h, rotate: 0 };
}

/** Total clockwise rotation the viewer sees (source /Rotate + ours). */
export function totalRotation(page) {
  const r = rawSize(page).rotate + page.rotation;
  return ((r % 360) + 360) % 360;
}

/** Size of the visible content after rotation + crop (before any resize). */
export function contentSize(page) {
  const raw = rawSize(page);
  const rot = totalRotation(page);
  let w = rot % 180 ? raw.h : raw.w;
  let h = rot % 180 ? raw.w : raw.h;
  const c = page.crop;
  return { w: w * (1 - c.l - c.r), h: h * (1 - c.t - c.b) };
}

/** Final page box: the resize override if there is one, else the content size. */
export function pageSize(page) {
  return page.size ? { w: page.size.w, h: page.size.h } : contentSize(page);
}

/**
 * Crop fractions are stored in *display* space (what the user sees and drags).
 * Rotating the page by 90° clockwise cycles the tuple one step left, so
 * converting display-space crop into raw page space is just a rotate of
 * (l, t, r, b) by rotation/90 steps.
 */
export function cropToRaw(crop, rotation) {
  const steps = (((rotation / 90) | 0) % 4 + 4) % 4;
  let v = [crop.l, crop.t, crop.r, crop.b];
  for (let i = 0; i < steps; i++) v = [v[1], v[2], v[3], v[0]];
  return { l: v[0], t: v[1], r: v[2], b: v[3] };
}

/* ── accessors ──────────────────────────────────────────── */

export const doc = (id = state.activeDoc) => state.docs.find(d => d.id === id) || null;
export const pages = () => (doc()?.pages ?? []);
export const currentPage = () => pages()[state.current] || null;

export function findPage(pageId) {
  for (const d of state.docs) {
    const i = d.pages.findIndex(p => p.id === pageId);
    if (i >= 0) return { doc: d, index: i, page: d.pages[i] };
  }
  return null;
}

/** Selected pages in the active document, in page order. */
export function selectedPages() {
  return pages().filter(p => state.selection.has(p.id));
}
/** Selection, or the current page if nothing is ticked. */
export function targetPages() {
  const sel = selectedPages();
  if (sel.length) return sel;
  const c = currentPage();
  return c ? [c] : [];
}

/* ── history ────────────────────────────────────────────── */

function snap() {
  return JSON.stringify({
    docs: state.docs, activeDoc: state.activeDoc,
    current: state.current, selection: [...state.selection],
  });
}

function restore(json) {
  const s = JSON.parse(json);
  state.docs = s.docs;
  state.activeDoc = s.activeDoc;
  state.current = s.current;
  state.selection = new Set(s.selection);
}

let pending = null;

/** Call immediately BEFORE mutating state. */
export function checkpoint() {
  pending = snap();
}

/** Call after mutating; commits the checkpoint onto the undo stack. */
export function commit() {
  if (pending === null) return;
  const before = pending;
  pending = null;
  if (before === snap()) return;         // nothing actually changed
  state.undo.push(before);
  if (state.undo.length > 60) state.undo.shift();
  state.redo.length = 0;
  state.dirty = true;
}

export function doUndo() {
  if (!state.undo.length) return false;
  const now = snap();
  restore(state.undo.pop());
  state.redo.push(now);
  return true;
}

export function doRedo() {
  if (!state.redo.length) return false;
  const now = snap();
  restore(state.redo.pop());
  state.undo.push(now);
  return true;
}

/** Keep current index / selection sane after structural edits. */
export function clampCursor() {
  const n = pages().length;
  if (!n) { state.current = 0; state.selection.clear(); return; }
  state.current = Math.max(0, Math.min(state.current, n - 1));
  const live = new Set(pages().map(p => p.id));
  for (const id of [...state.selection]) if (!live.has(id)) state.selection.delete(id);
}

/** Unique-ish document name, so tabs stay readable. */
export function uniqueName(base) {
  const taken = new Set(state.docs.map(d => d.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\.pdf$/i, '');
  for (let i = 2; ; i++) {
    const n = `${stem} (${i}).pdf`;
    if (!taken.has(n)) return n;
  }
}

export function addDoc(name, pageList) {
  const d = { id: uid(), name: uniqueName(name), pages: pageList };
  state.docs.push(d);
  return d;
}

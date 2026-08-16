/* ══════════════════════════════════════════════════════════
   pageops.js — every page operation, plus the pdf-lib exporter
   ══════════════════════════════════════════════════════════ */

import { state, doc, pages, addDoc, blankPage, clonePage, findPage,
         contentSize, pageSize, cropToRaw, totalRotation, rawSize,
         checkpoint, commit, clampCursor } from './state.js';

const { PDFDocument, degrees } = window.PDFLib;

/* ══════════════ operations ══════════════ */

export function rotate(list, delta) {
  if (!list.length) return;
  checkpoint();
  for (const p of list) p.rotation = (((p.rotation + delta) % 360) + 360) % 360;
  commit();
}

export function remove(list) {
  const d = doc();
  if (!d || !list.length) return 0;
  checkpoint();
  const kill = new Set(list.map(p => p.id));
  d.pages = d.pages.filter(p => !kill.has(p.id));
  for (const id of kill) state.selection.delete(id);
  if (!d.pages.length) {                       // an empty document is just clutter
    state.docs = state.docs.filter(x => x !== d);
    state.activeDoc = state.docs[0]?.id ?? null;
    state.current = 0;
  }
  clampCursor();
  commit();
  return kill.size;
}

export function duplicate(list) {
  const d = doc();
  if (!d || !list.length) return;
  checkpoint();
  // walk backwards so earlier insertions don't shift later indices
  [...list].reverse().forEach(p => {
    const i = d.pages.indexOf(p);
    if (i >= 0) d.pages.splice(i + 1, 0, clonePage(p));
  });
  commit();
}

export function insertBlank(where = 'after', list = []) {
  const d = doc();
  if (!d) return null;
  checkpoint();
  // match the neighbouring page's size so it doesn't look out of place
  const ref = list[0] || d.pages[state.current];
  const size = ref ? pageSize(ref) : { w: 595, h: 842 };
  const page = blankPage(Math.round(size.w), Math.round(size.h));

  let at;
  if (where === 'start') at = 0;
  else if (where === 'end') at = d.pages.length;
  else if (where === 'before') at = list.length ? d.pages.indexOf(list[0]) : state.current;
  else at = (list.length ? d.pages.indexOf(list[list.length - 1]) : state.current) + 1;

  d.pages.splice(Math.max(0, at), 0, page);
  state.current = Math.max(0, at);
  commit();
  return page;
}

export function extract(list) {
  const d = doc();
  if (!d || !list.length) return null;
  checkpoint();
  const nd = addDoc(`${d.name.replace(/\.pdf$/i, '')} — extract.pdf`,
                    list.map(p => clonePage(p)));
  state.activeDoc = nd.id;
  state.current = 0;
  state.selection.clear();
  commit();
  return nd;
}

export function movePages(list, targetDocId) {
  const from = doc();
  const to = state.docs.find(x => x.id === targetDocId);
  if (!from || !to || from === to || !list.length) return;
  checkpoint();
  const kill = new Set(list.map(p => p.id));
  from.pages = from.pages.filter(p => !kill.has(p.id));
  to.pages.push(...list);
  state.selection.clear();
  clampCursor();
  commit();
}

/** Reorder within the active document (mirrors what SortableJS did in the DOM). */
export function reorder(fromIndex, toIndex) {
  const d = doc();
  if (!d) return;
  checkpoint();
  const [p] = d.pages.splice(fromIndex, 1);
  d.pages.splice(toIndex, 0, p);
  state.current = toIndex;
  commit();
}

/** Drop a page from another document into this one at `toIndex`. */
export function moveAcross(pageId, toDocId, toIndex) {
  const found = findPage(pageId);
  const to = state.docs.find(x => x.id === toDocId);
  if (!found || !to) return;
  checkpoint();
  found.doc.pages.splice(found.index, 1);
  to.pages.splice(Math.min(toIndex, to.pages.length), 0, found.page);
  clampCursor();
  commit();
}

export function mergeAll() {
  if (state.docs.length < 2) return null;
  checkpoint();
  const all = state.docs.flatMap(d => d.pages);
  const merged = addDoc('merged.pdf', all);
  state.docs = state.docs.filter(d => d === merged);
  state.activeDoc = merged.id;
  state.current = 0;
  state.selection.clear();
  commit();
  return merged;
}

/** Cut the active document into several. mode: 'at' | 'every' | 'each' */
export function split(mode, n) {
  const d = doc();
  if (!d) return [];
  checkpoint();
  const chunks = [];
  if (mode === 'each') {
    d.pages.forEach(p => chunks.push([p]));
  } else if (mode === 'every') {
    const size = Math.max(1, n);
    for (let i = 0; i < d.pages.length; i += size) chunks.push(d.pages.slice(i, i + size));
  } else {
    const at = Math.min(Math.max(1, n), d.pages.length - 1);
    chunks.push(d.pages.slice(0, at), d.pages.slice(at));
  }
  const stem = d.name.replace(/\.pdf$/i, '');
  const made = chunks.map((ch, i) => addDoc(`${stem} — part ${i + 1}.pdf`, ch));
  state.docs = state.docs.filter(x => x !== d);
  state.activeDoc = made[0]?.id ?? state.docs[0]?.id ?? null;
  state.current = 0;
  state.selection.clear();
  commit();
  return made;
}

export function applyCrop(list, crop) {
  if (!list.length) return;
  checkpoint();
  for (const p of list) p.crop = { ...crop };
  commit();
}

export function clearCrop(list) {
  if (!list.length) return;
  checkpoint();
  for (const p of list) p.crop = { l: 0, t: 0, r: 0, b: 0 };
  commit();
}

export function resize(list, size) {
  if (!list.length) return;
  checkpoint();
  for (const p of list) p.size = size ? { w: size.w, h: size.h } : null;
  commit();
}

/* ══════════════ export ══════════════ */

/** Where to anchor a drawn object so its centre lands on (cx, cy). */
function anchorFor(cx, cy, w, h, degCW) {
  const a = -degCW * Math.PI / 180;          // pdf-lib angles are counter-clockwise
  const ca = Math.cos(a), sa = Math.sin(a);
  return { x: cx - (w / 2 * ca - h / 2 * sa), y: cy - (w / 2 * sa + h / 2 * ca) };
}

/** Map a point from base-box space through rotation → crop → scale. */
function makeTransform(page, ps) {
  const raw = rawSize(page);
  const rot = totalRotation(page);
  const bw = raw.w, bh = raw.h;
  const rbw = rot % 180 ? bh : bw;
  const rbh = rot % 180 ? bw : bh;
  const c = page.crop;
  const cw = rbw * (1 - c.l - c.r);
  const ch = rbh * (1 - c.t - c.b);
  const s = page.size ? Math.min(ps.w / cw, ps.h / ch) : 1;
  const ox = (ps.w - cw * s) / 2;
  const oy = (ps.h - ch * s) / 2;

  return {
    scale: s,
    pt(u, v) {                                  // (u,v) in base space, y-up
      let x, y;
      if (rot === 90)       { x = v;          y = bw - u; }
      else if (rot === 180) { x = bw - u;     y = bh - v; }
      else if (rot === 270) { x = bh - v;     y = u; }
      else                  { x = u;          y = v; }
      x -= c.l * rbw; y -= c.b * rbh;
      return { x: ox + x * s, y: oy + y * s };
    },
  };
}

async function embedImageBytes(out, rec) {
  if (rec.mime === 'image/png') return out.embedPng(rec.bytes);
  if (rec.mime === 'image/jpeg') return out.embedJpg(rec.bytes);
  // anything else (webp…) → repaint as PNG first
  const cv = document.createElement('canvas');
  cv.width = rec.w; cv.height = rec.h;
  cv.getContext('2d').drawImage(rec.el, 0, 0);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  return out.embedPng(new Uint8Array(await blob.arrayBuffer()));
}

async function drawOverlays(out, pdfPageObj, page, ps) {
  for (const ov of page.overlays) {
    const bytes = dataUrlToBytes(ov.dataUrl);
    const img = await out.embedPng(bytes);
    const w = ov.w * ps.w, h = ov.h * ps.h;
    const cx = ov.x * ps.w + w / 2;
    const cy = ps.h - (ov.y * ps.h + h / 2);       // stored y is from the top
    const a = anchorFor(cx, cy, w, h, ov.rot || 0);
    pdfPageObj.drawImage(img, { x: a.x, y: a.y, width: w, height: h,
                                rotate: degrees(-(ov.rot || 0)) });
  }
}

export function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const untouched = p => p.rotation === 0 && !p.size && !p.overlays.length &&
                       !p.crop.l && !p.crop.t && !p.crop.r && !p.crop.b;

/**
 * Assemble a real PDF from a document descriptor.
 * Pages that only need rotating or cropping are copied verbatim so links,
 * annotations and form fields survive; anything more (resize, a signature
 * stamped on top) is re-composed onto a fresh, un-rotated page.
 */
export async function buildPdf(d, onProgress) {
  const out = await PDFDocument.create();
  const loaded = new Map();
  const getSrc = async id => {
    if (!loaded.has(id)) {
      loaded.set(id, await PDFDocument.load(state.sources.get(id).bytes,
                                            { ignoreEncryption: true }));
    }
    return loaded.get(id);
  };

  for (let i = 0; i < d.pages.length; i++) {
    const page = d.pages[i];
    const ps = pageSize(page);
    onProgress?.(i, d.pages.length);

    /* ── plain copy, or copy + rotate/crop ── */
    if (page.kind === 'pdf' && !page.size && !page.overlays.length) {
      const srcDoc = await getSrc(page.src);
      const [copied] = await out.copyPages(srcDoc, [page.srcPage]);
      if (!untouched(page)) {
        const c = page.crop;
        if (c.l || c.t || c.r || c.b) {
          const box = copied.getCropBox();
          const rc = cropToRaw(c, totalRotation(page));
          const nx = box.x + rc.l * box.width;
          const ny = box.y + rc.b * box.height;
          const nw = box.width * (1 - rc.l - rc.r);
          const nh = box.height * (1 - rc.t - rc.b);
          copied.setCropBox(nx, ny, nw, nh);
          copied.setMediaBox(nx, ny, nw, nh);
        }
        copied.setRotation(degrees(totalRotation(page)));
      }
      out.addPage(copied);
      continue;
    }

    /* ── re-composed page ── */
    const newPage = out.addPage([ps.w, ps.h]);

    if (page.kind === 'pdf') {
      const srcDoc = await getSrc(page.src);
      const sp = srcDoc.getPage(page.srcPage);
      const cb = sp.getCropBox();
      const rc = cropToRaw(page.crop, totalRotation(page));
      const emb = await out.embedPage(sp, {
        left:   cb.x + rc.l * cb.width,
        bottom: cb.y + rc.b * cb.height,
        right:  cb.x + cb.width * (1 - rc.r),
        top:    cb.y + cb.height * (1 - rc.t),
      });
      const rot = totalRotation(page);
      const cs = contentSize(page);
      const s = page.size ? Math.min(ps.w / cs.w, ps.h / cs.h) : 1;
      const W = emb.width * s, H = emb.height * s;      // un-rotated drawn size
      const a = anchorFor(ps.w / 2, ps.h / 2, W, H, rot);
      newPage.drawPage(emb, { x: a.x, y: a.y, width: W, height: H,
                              rotate: degrees(-rot) });

    } else if (page.kind === 'image') {
      const rec = state.images.get(page.src);
      const img = await embedImageBytes(out, rec);
      const T = makeTransform(page, ps);
      const m = page.margin || 0;
      const bw = page.base.w, bh = page.base.h;
      const k = Math.min((bw - 2 * m) / rec.w, (bh - 2 * m) / rec.h);
      const iw = rec.w * k, ih = rec.h * k;             // image rect in base space
      const centre = T.pt(bw / 2, bh / 2);
      const dw = iw * T.scale, dh = ih * T.scale;
      const rot = totalRotation(page);
      const a = anchorFor(centre.x, centre.y, dw, dh, rot);
      newPage.drawImage(img, { x: a.x, y: a.y, width: dw, height: dh,
                               rotate: degrees(-rot) });
    }
    // 'blank' needs nothing drawn

    await drawOverlays(out, newPage, page, ps);
  }

  onProgress?.(d.pages.length, d.pages.length);
  return out.save({ useObjectStreams: true });
}

/* ══════════════════════════════════════════════════════════
   render.js — loading files and painting pages onto canvases
   ══════════════════════════════════════════════════════════ */

import { state, uid, pdfPage, imagePage, addDoc, rawSize, totalRotation,
         contentSize, pageSize } from './state.js';

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ── loading ────────────────────────────────────────────── */

export async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Register a PDF's bytes as a source and read every page's raw geometry.
 * pdf.js detaches the buffer it is handed, so it always gets a copy.
 */
export async function addSource(name, bytes) {
  const id = uid();
  const pdfjs = await pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    cMapUrl: undefined,
  }).promise;

  const dims = [];
  for (let i = 1; i <= pdfjs.numPages; i++) {
    const p = await pdfjs.getPage(i);
    const [x0, y0, x1, y1] = p.view;
    dims.push({ w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), rotate: p.rotate || 0 });
  }

  const src = { id, name, bytes, pdfjs, dims, pageCache: new Map() };
  state.sources.set(id, src);
  return src;
}

/** Open a PDF file as a new document in the workspace. */
export async function openPdf(file) {
  const bytes = await readFile(file);
  const src = await addSource(file.name, bytes);
  const list = src.dims.map((_, i) => pdfPage(src.id, i));
  return addDoc(file.name, list);
}

/** Register an image file; returns the image record. */
export async function addImage(file) {
  const bytes = await readFile(file);
  const blob = new Blob([bytes], { type: file.type });
  const url = URL.createObjectURL(blob);
  const el = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`${file.name} is not a readable image`));
    im.src = url;
  });
  const rec = { id: uid(), name: file.name, bytes, mime: file.type,
                w: el.naturalWidth, h: el.naturalHeight, url, el };
  state.images.set(rec.id, rec);
  return rec;
}

/** Page box for an image, given a sizing mode. `fit` caps the long edge at A4. */
export function imagePageBox(img, mode) {
  if (mode === 'a4')     return { w: 595, h: 842 };
  if (mode === 'a4l')    return { w: 842, h: 595 };
  if (mode === 'letter') return { w: 612, h: 792 };
  if (mode === 'auto')   return img.w >= img.h ? { w: 842, h: 595 } : { w: 595, h: 842 };
  const k = 842 / Math.max(img.w, img.h);
  return { w: Math.round(img.w * k), h: Math.round(img.h * k) };
}

/** Build a document out of image records. */
export function makeImageDoc(name, imgs, mode = 'fit', margin = 0) {
  const list = imgs.map(im => {
    const box = imagePageBox(im, mode);
    return imagePage(im.id, box.w, box.h, margin);
  });
  return addDoc(name, list);
}

/* ── pdf.js page handles ────────────────────────────────── */

function pdfjsPage(srcId, index) {
  const src = state.sources.get(srcId);
  if (!src.pageCache.has(index)) src.pageCache.set(index, src.pdfjs.getPage(index + 1));
  return src.pageCache.get(index);
}

/* ── rendering ──────────────────────────────────────────── */

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** The rotated + cropped content of a page, at `pxWidth` pixels across. */
async function renderContent(page, pxWidth) {
  const cs = contentSize(page);
  const scale = pxWidth / cs.w;

  if (page.kind === 'blank') {
    const c = newCanvas(cs.w * scale, cs.h * scale);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  if (page.kind === 'image') {
    // Draw the whole page box (white + contained image), then crop/rotate it.
    const img = state.images.get(page.src);
    const base = page.base;
    const rot = totalRotation(page);
    const full = newCanvas(base.w * scale, base.h * scale);
    const g = full.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, full.width, full.height);
    const m = (page.margin || 0) * scale;
    const bw = full.width - m * 2, bh = full.height - m * 2;
    const k = Math.min(bw / img.w, bh / img.h);
    const dw = img.w * k, dh = img.h * k;
    g.drawImage(img.el, m + (bw - dw) / 2, m + (bh - dh) / 2, dw, dh);
    return cropRotate(full, page, rot, page.crop);
  }

  // PDF page
  const p = await pdfjsPage(page.src, page.srcPage);
  const rot = totalRotation(page);
  const vp = p.getViewport({ scale, rotation: rot });
  const full = newCanvas(vp.width, vp.height);
  const g = full.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, full.width, full.height);
  await p.render({ canvasContext: g, viewport: vp }).promise;
  return cropCanvas(full, page.crop);
}

/** Rotate a canvas clockwise by `rot`, then crop it (display-space fractions). */
function cropRotate(src, page, rot, crop) {
  let c = src;
  if (rot % 360 !== 0) {
    const swap = rot % 180 !== 0;
    const out = newCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
    const g = out.getContext('2d');
    g.translate(out.width / 2, out.height / 2);
    g.rotate(rot * Math.PI / 180);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    c = out;
  }
  return cropCanvas(c, crop);
}

function cropCanvas(c, crop) {
  if (!crop || (!crop.l && !crop.t && !crop.r && !crop.b)) return c;
  const x = Math.round(c.width * crop.l);
  const y = Math.round(c.height * crop.t);
  const w = Math.max(1, Math.round(c.width * (1 - crop.l - crop.r)));
  const h = Math.max(1, Math.round(c.height * (1 - crop.t - crop.b)));
  const out = newCanvas(w, h);
  out.getContext('2d').drawImage(c, x, y, w, h, 0, 0, w, h);
  return out;
}

/** Cached <img> for a data/blob URL. */
const imgCache = new Map();
export function loadImg(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('image failed to load'));
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

/**
 * Render a page exactly as it will export: final page box, with the content
 * scaled to fit inside it when a resize is in effect.
 * Pass `{ overlays:false }` for the stage, where signatures are live DOM.
 */
export async function renderPage(page, pxWidth, { overlays = true } = {}) {
  const ps = pageSize(page);
  const cs = contentSize(page);
  const out = newCanvas(pxWidth, pxWidth * ps.h / ps.w);
  const g = out.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);

  const scale = out.width / ps.w;
  const k = page.size ? Math.min(ps.w / cs.w, ps.h / cs.h) : 1;
  const contentPx = Math.max(1, Math.round(cs.w * k * scale));
  const content = await renderContent(page, contentPx);

  g.drawImage(content,
    Math.round((out.width - content.width) / 2),
    Math.round((out.height - content.height) / 2));

  if (overlays) {
    for (const ov of page.overlays) {
      let im;
      try { im = await loadImg(ov.dataUrl); } catch { continue; }
      const w = ov.w * out.width, h = ov.h * out.height;
      g.save();
      g.translate(ov.x * out.width + w / 2, ov.y * out.height + h / 2);
      g.rotate((ov.rot || 0) * Math.PI / 180);
      g.drawImage(im, -w / 2, -h / 2, w, h);
      g.restore();
    }
  }
  return out;
}

/** High-resolution single-page render, used by the image exporter. */
export async function renderPageAtDpi(page, dpi) {
  const ps = pageSize(page);
  return renderPage(page, Math.max(1, Math.round(ps.w * dpi / 72)));
}

/* ── a small concurrency-limited queue for thumbnails ───── */

export function makeQueue(limit = 3) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      active++;
      job.run().then(job.ok, job.fail).finally(() => { active--; pump(); });
    }
  };
  const q = {
    push(run) {
      return new Promise((ok, fail) => { waiting.push({ run, ok, fail }); pump(); });
    },
    clear() { waiting.length = 0; },
  };
  return q;
}

/* ══════════════════════════════════════════════════════════
   convert.js — PDF ⇄ image conversions and file downloads
   ══════════════════════════════════════════════════════════ */

import { renderPageAtDpi } from './render.js';
import { buildPdf } from './pageops.js';

/* ── downloads ──────────────────────────────────────────── */

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const safeName = s => (s || 'chintu').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'chintu';

/* ── PDF → JPG / PNG ────────────────────────────────────── */

function canvasToBlob(cv, format, quality) {
  return new Promise(res => cv.toBlob(res, `image/${format}`, format === 'jpeg' ? quality : undefined));
}

/**
 * Rasterise pages to images.
 * @returns {Promise<{name:string, blob:Blob}[]>}
 */
export async function pagesToImages(pageList, { format = 'png', dpi = 150, quality = 0.9,
                                                stem = 'page', onProgress } = {}) {
  const out = [];
  const width = String(pageList.length).length;
  for (let i = 0; i < pageList.length; i++) {
    onProgress?.(i, pageList.length);
    const cv = await renderPageAtDpi(pageList[i].page ?? pageList[i], dpi);
    const blob = await canvasToBlob(cv, format, quality);
    const num = String((pageList[i].number ?? i + 1)).padStart(width, '0');
    out.push({ name: `${stem}-${num}.${format === 'jpeg' ? 'jpg' : 'png'}`, blob });
    // let the UI breathe between pages
    await new Promise(r => setTimeout(r, 0));
  }
  onProgress?.(pageList.length, pageList.length);
  return out;
}

export async function zipFiles(files, zipName) {
  const zip = new window.JSZip();
  for (const f of files) zip.file(f.name, f.blob);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  download(blob, zipName);
}

/* ── document → .pdf on disk ────────────────────────────── */

export async function savePdf(doc, onProgress) {
  const bytes = await buildPdf(doc, onProgress);
  const name = /\.pdf$/i.test(doc.name) ? doc.name : `${doc.name}.pdf`;
  download(new Blob([bytes], { type: 'application/pdf' }), safeName(name));
  return bytes.length;
}

/* ── several documents → one zip of PDFs ────────────────── */

export async function saveDocsAsZip(docs, zipName, onProgress) {
  const zip = new window.JSZip();
  for (let i = 0; i < docs.length; i++) {
    onProgress?.(i, docs.length);
    const bytes = await buildPdf(docs[i]);
    const n = /\.pdf$/i.test(docs[i].name) ? docs[i].name : `${docs[i].name}.pdf`;
    zip.file(safeName(n), bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE',
                                         compressionOptions: { level: 4 } });
  download(blob, zipName);
}

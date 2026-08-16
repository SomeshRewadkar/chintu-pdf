/* ══════════════════════════════════════════════════════════
   app.js — wiring: DOM ⇄ state ⇄ operations
   ══════════════════════════════════════════════════════════ */

import { state, doc, pages, currentPage, targetPages, selectedPages, PRESETS,
         pageSize, doUndo, doRedo, clampCursor, findPage } from './state.js';
import { openPdf, addImage, renderPage, makeQueue, makeImageDoc,
         imagePageBox, loadImg } from './render.js';
import * as ops from './pageops.js';
import * as sig from './signature.js';
import { pagesToImages, zipFiles, savePdf, saveDocsAsZip, download, safeName } from './convert.js';
import { $, $$, toast, chintu, says, busy, modal, confetti, startBlinking, idleLine } from './ui.js';

/* ══════════════ shared bits ══════════════ */

const thumbQueue = makeQueue(3);
const thumbCache = new Map();            // pageId → { sig, canvas }
let cropMode = false;
let crop = { l: 0, t: 0, r: 0, b: 0 };
let stageToken = 0;
let draggingPageId = null;
let sorter = null;

const pageSig = p => [p.kind, p.src, p.srcPage, p.rotation, p.crop.l, p.crop.t, p.crop.r,
  p.crop.b, p.size?.w, p.size?.h, p.margin, p.overlays.map(o => `${o.id}${o.x.toFixed(3)}${o.y.toFixed(3)}${o.w.toFixed(3)}${o.rot}`).join()].join('|');

/* ══════════════ render: document tabs ══════════════ */

function renderTabs() {
  const wrap = $('#doc-tabs');
  wrap.textContent = '';
  state.docs.forEach(d => {
    const el = document.createElement('div');
    el.className = 'doc-tab' + (d.id === state.activeDoc ? ' is-on' : '');
    el.innerHTML = `<span class="dt-name"></span>
                    <span class="dt-count">${d.pages.length}</span>
                    <span class="dt-x" title="Close">✕</span>`;
    el.querySelector('.dt-name').textContent = d.name.replace(/\.pdf$/i, '');
    el.title = d.name;

    el.onclick = e => {
      if (e.target.classList.contains('dt-x')) return closeDoc(d);
      if (state.activeDoc === d.id) return;
      state.activeDoc = d.id;
      state.current = 0;
      state.selection.clear();
      exitCrop();
      refresh();
    };

    // dropping a thumbnail here moves that page into this document
    el.addEventListener('dragover', e => {
      if (!draggingPageId || d.id === state.activeDoc) return;
      e.preventDefault();
      el.classList.add('drop-hot');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hot'));
    el.addEventListener('drop', e => {
      el.classList.remove('drop-hot');
      if (!draggingPageId || d.id === state.activeDoc) return;
      e.preventDefault();
      const id = draggingPageId;
      draggingPageId = null;
      ops.moveAcross(id, d.id, d.pages.length);
      chintu('grin', `Page shipped to “${d.name.replace(/\.pdf$/i, '')}”.`);
      refresh();
    });

    wrap.appendChild(el);
  });
}

function closeDoc(d) {
  if (!confirm(`Close “${d.name}”? Anything unsaved in it is gone.`)) return;
  state.docs = state.docs.filter(x => x !== d);
  if (state.activeDoc === d.id) {
    state.activeDoc = state.docs[0]?.id ?? null;
    state.current = 0;
    state.selection.clear();
  }
  state.undo.length = state.redo.length = 0;
  refresh();
}

/* ══════════════ render: thumbnails ══════════════ */

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.textContent = '';
  const list = pages();

  list.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' +
      (state.selection.has(p.id) ? ' is-sel' : '') +
      (i === state.current ? ' is-cur' : '');
    el.dataset.id = p.id;
    el.draggable = false;

    const s = pageSig(p);
    const hit = thumbCache.get(p.id);
    if (hit && hit.sig === s) {
      el.appendChild(hit.canvas);
    } else {
      const skel = document.createElement('div');
      skel.className = 't-skel';
      el.appendChild(skel);
      thumbQueue.push(async () => {
        const cv = await renderPage(p, 190);
        thumbCache.set(p.id, { sig: s, canvas: cv });
        if (el.isConnected) { el.textContent = ''; el.appendChild(cv); decorate(el, p, i); }
      }).catch(() => {});
    }
    decorate(el, p, i);

    el.onclick = e => {
      if (e.shiftKey && state.selection.size) {
        const idxs = list.map((q, j) => state.selection.has(q.id) ? j : -1).filter(j => j >= 0);
        const from = Math.min(...idxs, i), to = Math.max(...idxs, i);
        for (let j = from; j <= to; j++) state.selection.add(list[j].id);
      } else if (e.ctrlKey || e.metaKey) {
        state.selection.has(p.id) ? state.selection.delete(p.id) : state.selection.add(p.id);
      } else {
        state.selection.clear();
        state.selection.add(p.id);
      }
      state.current = i;
      exitCrop();
      refresh();
    };

    wrap.appendChild(el);
  });

  sorter?.destroy();
  sorter = new window.Sortable(wrap, {
    animation: 140,
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onStart: e => { draggingPageId = e.item.dataset.id; },
    onEnd: e => {
      const id = draggingPageId;
      draggingPageId = null;
      if (e.oldIndex === e.newIndex) return;
      // if the page was dropped on a doc tab, moveAcross already handled it
      if (!findPage(id) || findPage(id).doc.id !== state.activeDoc) { refresh(); return; }
      ops.reorder(e.oldIndex, e.newIndex);
      refresh();
    },
  });

  const n = state.selection.size;
  $('#sel-info').textContent = n
    ? `${n} page${n > 1 ? 's' : ''} selected`
    : `page ${list.length ? state.current + 1 : 0} of ${list.length}`;
}

function decorate(el, p, i) {
  const num = document.createElement('span');
  num.className = 't-num';
  num.textContent = i + 1;
  el.appendChild(num);
  const tags = [];
  if (p.kind === 'blank') tags.push('blank');
  if (p.overlays.length) tags.push('✍');
  if (p.size) tags.push('resized');
  if (p.crop.l || p.crop.t || p.crop.r || p.crop.b) tags.push('crop');
  if (tags.length) {
    const b = document.createElement('span');
    b.className = 't-badge';
    b.textContent = tags.join(' · ');
    el.appendChild(b);
  }
}

/* ══════════════ render: stage ══════════════ */

async function renderStage() {
  const page = currentPage();
  const empty = !page;
  $('#empty-state').hidden = !empty;
  $('#page-scroll').hidden = empty;
  $('#stage-nav').hidden = empty;
  $$('#stage-toolbar .tool').forEach(b => b.disabled = empty);
  if (empty) { $('#overlay-layer').textContent = ''; return; }

  $('#pagecount').textContent = `${state.current + 1} / ${pages().length}`;

  const view = $('#stage-view');
  const ps = pageSize(page);
  const zoom = +$('#zoom').value / 100;
  const availW = Math.max(120, view.clientWidth - 56);
  const availH = Math.max(120, view.clientHeight - 56);
  const fit = Math.min(availW / ps.w, availH / ps.h);
  const cssW = Math.max(80, ps.w * fit * zoom);
  const cssH = cssW * ps.h / ps.w;

  const wrap = $('#page-wrap');
  wrap.style.width = cssW + 'px';
  wrap.style.height = cssH + 'px';

  const my = ++stageToken;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = await renderPage(page, Math.round(cssW * dpr), { overlays: false });
  if (my !== stageToken) return;

  const target = $('#stage-canvas');
  target.width = cv.width;
  target.height = cv.height;
  target.style.width = cssW + 'px';
  target.style.height = cssH + 'px';
  target.getContext('2d').drawImage(cv, 0, 0);

  sig.mountOverlays(page, $('#overlay-layer'), structural => {
    thumbCache.delete(page.id);
    renderThumbs();
    if (structural) renderStage();
  });

  if (cropMode) paintCrop();
}

/* ══════════════ master refresh ══════════════ */

function refresh() {
  clampCursor();
  renderTabs();
  renderThumbs();
  renderStage();
  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
  $('#btn-save').disabled = !doc() || !pages().length;
}

/* ══════════════ opening files ══════════════ */

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdfs = files.filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  const imgs = files.filter(f => /^image\//.test(f.type));
  const junk = files.length - pdfs.length - imgs.length;

  busy(true, 'Chintu is chewing…');
  try {
    for (const f of pdfs) {
      try {
        const d = await openPdf(f);
        state.activeDoc = d.id;
      } catch (err) {
        toast(`${f.name} wouldn't open — ${err.message || 'is it password protected?'}`, 'bad', 5200);
      }
    }
    if (imgs.length) {
      const recs = [];
      for (const f of imgs) { try { recs.push(await addImage(f)); } catch (e) { toast(e.message, 'bad'); } }
      if (recs.length) {
        const d = makeImageDoc(recs.length === 1 ? `${recs[0].name}.pdf` : 'images.pdf', recs, 'fit', 0);
        state.activeDoc = d.id;
      }
    }
    state.current = 0;
    state.selection.clear();
    state.undo.length = state.redo.length = 0;
  } finally {
    busy(false);
  }

  if (junk) toast(`Ignored ${junk} file${junk > 1 ? 's' : ''} that wasn't a PDF or image.`, 'bad');
  const total = pages().length;
  chintu('grin', total ? `${total} page${total > 1 ? 's' : ''}. Delicious.` : idleLine());
  refresh();
}

/* ══════════════ toolbar ══════════════ */

const ACTIONS = {
  'rotate-ccw': () => { ops.rotate(targetPages(), -90); tick(targetPages().length, 'Tilted left.'); },
  'rotate-cw':  () => { ops.rotate(targetPages(), 90);  tick(targetPages().length, 'Tilted right.'); },
  duplicate:    () => { const n = targetPages().length; ops.duplicate(targetPages()); chintu('grin', `Cloned ${n} page${n > 1 ? 's' : ''}.`); },
  blank:        () => { ops.insertBlank($('#blank-where').value, selectedPages()); chintu('grin', 'A fresh blank page.'); },
  delete:       doDelete,
  crop:         () => cropMode ? exitCrop(true) : enterCrop(),
  extract:      doExtract,
  split:        doSplit,
  merge:        doMerge,
  moveto:       doMoveTo,
};

function tick(n, line) { chintu('happy', line); }

function doDelete() {
  const list = targetPages();
  if (!list.length) return;
  if (list.length === pages().length && !confirm('That is every page in this document. Sure?')) return;
  const n = ops.remove(list);
  chintu('ohno', `Chintu ate ${n} page${n > 1 ? 's' : ''}. 🍽`);
  refresh();
}

function doExtract() {
  const list = selectedPages();
  if (!list.length) return toast('Tick some pages in the sidebar first.', 'bad');
  ops.extract(list);
  chintu('grin', `Pulled ${list.length} page${list.length > 1 ? 's' : ''} into a new document.`);
  refresh();
}

async function doSplit() {
  const d = doc();
  if (!d || d.pages.length < 2) return toast('Need at least two pages to split.', 'bad');
  const res = await modal({
    title: 'Split this document',
    ok: '✂ Split',
    body: `<label class="opt is-on"><input type="radio" name="sm" value="at" checked>
             Cut once, after page <input type="number" id="sp-at" value="1" min="1"
             max="${d.pages.length - 1}" style="width:70px">
           </label>
           <label class="opt"><input type="radio" name="sm" value="every">
             Every <input type="number" id="sp-n" value="2" min="1" style="width:60px"> pages
           </label>
           <label class="opt"><input type="radio" name="sm" value="each">
             One document per page (${d.pages.length} of them)
           </label>`,
  });
  if (!res) return;
  const mode = res.querySelector('input[name=sm]:checked').value;
  const n = mode === 'at' ? +res.querySelector('#sp-at').value : +res.querySelector('#sp-n').value;
  const made = ops.split(mode, n);
  chintu('grin', `Chopped into ${made.length} documents.`);
  refresh();
}

function doMerge() {
  if (state.docs.length < 2) return toast('Open more than one document first.', 'bad');
  const n = state.docs.length;
  ops.mergeAll();
  chintu('grin', `${n} documents, now one.`);
  refresh();
}

async function doMoveTo() {
  const list = targetPages();
  const others = state.docs.filter(d => d.id !== state.activeDoc);
  if (!list.length) return;
  if (!others.length) return toast('Nowhere to move to — open another PDF first.', 'bad');
  const res = await modal({
    title: `Move ${list.length} page${list.length > 1 ? 's' : ''} to…`,
    ok: '➜ Move',
    body: others.map((d, i) => `<label class="opt${i ? '' : ' is-on'}">
        <input type="radio" name="mv" value="${d.id}" ${i ? '' : 'checked'}>
        ${d.name.replace(/</g, '&lt;')} <small>(${d.pages.length} pages)</small></label>`).join(''),
  });
  if (!res) return;
  ops.movePages(list, res.querySelector('input[name=mv]:checked').value);
  chintu('grin', 'Moved. Tip: you can also drag thumbnails onto a document tab.');
  refresh();
}

/* ══════════════ crop ══════════════ */

function enterCrop() {
  const p = currentPage();
  if (!p) return;
  cropMode = true;
  crop = { ...p.crop };
  if (!crop.l && !crop.t && !crop.r && !crop.b) crop = { l: .08, t: .08, r: .08, b: .08 };
  $('#crop-layer').hidden = false;
  $('#btn-crop-apply').disabled = false;
  $('#btn-crop-all').disabled = false;
  $$('#stage-toolbar .tool').find(b => b.dataset.act === 'crop').classList.add('is-on');
  says('Drag the box, then hit apply in the right panel.');
  paintCrop();
}

function exitCrop(silent) {
  cropMode = false;
  $('#crop-layer').hidden = true;
  $('#btn-crop-apply').disabled = true;
  $('#btn-crop-all').disabled = true;
  $$('#stage-toolbar .tool').find(b => b.dataset.act === 'crop')?.classList.remove('is-on');
}

function paintCrop() {
  const box = $('#crop-box');
  const L = crop.l * 100, T = crop.t * 100, R = crop.r * 100, B = crop.b * 100;
  box.style.cssText = `left:${L}%;top:${T}%;right:${R}%;bottom:${B}%`;
  const s = i => $$('#crop-layer .crop-shade')[i];
  s(0).style.cssText = `left:0;top:0;right:0;height:${T}%`;
  s(1).style.cssText = `left:0;bottom:0;right:0;height:${B}%`;
  s(2).style.cssText = `left:0;top:${T}%;bottom:${B}%;width:${L}%`;
  s(3).style.cssText = `right:0;top:${T}%;bottom:${B}%;width:${R}%`;
}

function wireCrop() {
  const layer = $('#crop-layer');
  layer.addEventListener('pointerdown', e => {
    const h = e.target.dataset.h;
    if (!h && !e.target.classList.contains('crop-box')) return;
    e.preventDefault();
    const r = layer.getBoundingClientRect();
    const start = { ...crop, mx: e.clientX, my: e.clientY };
    const MIN = .05;

    const move = ev => {
      const dx = (ev.clientX - start.mx) / r.width;
      const dy = (ev.clientY - start.my) / r.height;
      if (!h) {
        const maxX = Math.min(start.l + dx, 1 - start.r - MIN);
        const maxY = Math.min(start.t + dy, 1 - start.b - MIN);
        const l = Math.max(0, Math.min(maxX, 1 - MIN));
        const t = Math.max(0, Math.min(maxY, 1 - MIN));
        crop.l = l; crop.r = Math.max(0, start.r - (l - start.l));
        crop.t = t; crop.b = Math.max(0, start.b - (t - start.t));
      } else {
        if (h.includes('w')) crop.l = clamp(start.l + dx, 0, 1 - start.r - MIN);
        if (h.includes('e')) crop.r = clamp(start.r - dx, 0, 1 - start.l - MIN);
        if (h.includes('n')) crop.t = clamp(start.t + dy, 0, 1 - start.b - MIN);
        if (h.includes('s')) crop.b = clamp(start.b - dy, 0, 1 - start.t - MIN);
      }
      paintCrop();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ══════════════ right panel: pages ══════════════ */

function wirePagePanel() {
  $('#resize-preset').onchange = e => {
    $('#custom-size').hidden = e.target.value !== 'custom';
  };

  $('#btn-resize').onclick = () => {
    const v = $('#resize-preset').value;
    if (!v) return toast('Pick a size first.', 'bad');
    const size = v === 'custom'
      ? { w: +$('#size-w').value || 595, h: +$('#size-h').value || 842 }
      : PRESETS[v];
    const list = targetPages();
    ops.resize(list, size);
    chintu('happy', `Resized ${list.length} page${list.length > 1 ? 's' : ''}.`);
    refresh();
  };

  $('#btn-resize-reset').onclick = () => {
    ops.resize(targetPages(), null);
    refresh();
  };

  $('#btn-crop-apply').onclick = () => {
    const p = currentPage();
    if (!p) return;
    ops.applyCrop([p], crop);
    exitCrop();
    chintu('happy', 'Cropped.');
    refresh();
  };

  $('#btn-crop-all').onclick = () => {
    const list = targetPages();
    ops.applyCrop(list, crop);
    exitCrop();
    chintu('happy', `Cropped ${list.length} page${list.length > 1 ? 's' : ''}.`);
    refresh();
  };

  $('#btn-crop-clear').onclick = () => {
    ops.clearCrop(targetPages());
    exitCrop();
    refresh();
  };

  $('#btn-blank-2').onclick = ACTIONS.blank;
  $('#btn-blank-2').addEventListener('click', () => refresh());
}

/* ══════════════ right panel: signatures ══════════════ */

let pad = null;
let sigColor = '#111111';
let typeColor = '#111111';
let uploadedImg = null;
let uploadedResult = null;

function wireSignPanel() {
  pad = sig.makeDrawPad($('#sig-pad'), () => ({ color: sigColor, width: +$('#sig-width').value }));

  $('#sig-seg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#sig-seg button').forEach(x => x.classList.toggle('is-on', x === b));
    $$('.sigmode').forEach(m => m.hidden = m.dataset.sigmode !== b.dataset.sig);
  };

  $('#sig-colors').onclick = e => {
    const b = e.target.closest('.sw');
    if (!b) return;
    $$('#sig-colors .sw').forEach(x => x.classList.toggle('is-on', x === b));
    sigColor = b.dataset.c;
  };

  $('#sig-clear').onclick = () => { pad.clear(); says('Blank slate.'); };

  $('#sig-save-draw').onclick = () => {
    if (pad.isEmpty()) return toast('Draw something first!', 'bad');
    const cv = pad.result();
    if (!cv) return toast('That looked empty to Chintu.', 'bad');
    saveSig(cv);
    pad.clear();
  };

  // typed
  const redrawTyped = async () => {
    uploadedResult = null;
    await sig.renderTyped($('#sig-type-canvas'), $('#sig-text').value,
                          $('#sig-font').value, typeColor);
  };
  $('#sig-text').oninput = redrawTyped;
  $('#sig-font').onchange = redrawTyped;
  $('#sig-colors-2').onclick = e => {
    const b = e.target.closest('.sw');
    if (!b) return;
    $$('#sig-colors-2 .sw').forEach(x => x.classList.toggle('is-on', x === b));
    typeColor = b.dataset.c;
    redrawTyped();
  };
  $('#sig-save-type').onclick = async () => {
    const cv = await sig.renderTyped($('#sig-type-canvas'), $('#sig-text').value,
                                     $('#sig-font').value, typeColor);
    if (!cv) return toast('Type your name first.', 'bad');
    saveSig(cv);
  };

  // uploaded
  $('#sig-pick').onclick = () => $('#sig-file').click();
  $('#sig-file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    uploadedImg = await loadImg(url);
    await redrawUpload();
    $('#sig-save-up').disabled = false;
  };
  const redrawUpload = async () => {
    uploadedResult = await sig.renderUploaded($('#sig-up-canvas'), uploadedImg,
                                              $('#sig-bg').checked, +$('#sig-thresh').value);
  };
  $('#sig-bg').onchange = redrawUpload;
  $('#sig-thresh').oninput = redrawUpload;
  $('#sig-save-up').onclick = () => {
    if (!uploadedResult) return toast('Choose an image first.', 'bad');
    saveSig(uploadedResult);
  };

  renderSigLib();
}

function saveSig(canvas) {
  const rec = sig.addToLibrary(canvas.toDataURL('image/png'), canvas.width, canvas.height);
  renderSigLib();
  chintu('grin', 'Signature saved. Click it to stamp a page.');
  const p = currentPage();
  if (p) stamp(rec);
}

function renderSigLib() {
  const wrap = $('#siglib');
  const list = sig.loadLibrary();
  wrap.textContent = '';
  if (!list.length) {
    wrap.innerHTML = '<div class="none">Nothing saved yet.<br>Draw, type or upload one above.</div>';
    return;
  }
  list.forEach(s => {
    const el = document.createElement('div');
    el.className = 'sigitem';
    el.innerHTML = `<img src="${s.dataUrl}" alt="signature"><span class="sx">✕</span>`;
    el.onclick = e => {
      if (e.target.classList.contains('sx')) {
        sig.removeFromLibrary(s.id);
        renderSigLib();
        return;
      }
      stamp(s);
    };
    wrap.appendChild(el);
  });
}

function stamp(s) {
  const p = currentPage();
  if (!p) return toast('Open a PDF first.', 'bad');
  sig.stampOnPage(p, s);
  thumbCache.delete(p.id);
  chintu('smug', 'Stamped. Drag it where you want it.');
  refresh();
}

/* ══════════════ right panel: PDF → images ══════════════ */

function wireExportPanel() {
  $('#ex-format').onchange = e => { $('#ex-qwrap').hidden = e.target.value !== 'jpeg'; };
  $('#ex-quality').oninput = e => { $('#ex-qval').textContent = e.target.value; };

  $('#btn-export-img').onclick = async () => {
    const d = doc();
    if (!d) return toast('Open a PDF first.', 'bad');
    const scope = $('#ex-scope').value;
    const list = scope === 'all' ? d.pages
               : scope === 'sel' ? selectedPages()
               : [currentPage()].filter(Boolean);
    if (!list.length) return toast('No pages picked for that option.', 'bad');

    const format = $('#ex-format').value;
    const dpi = +$('#ex-dpi').value;
    const quality = +$('#ex-quality').value / 100;
    const stem = safeName(d.name.replace(/\.pdf$/i, ''));

    const bar = $('#ex-bar'), label = $('#ex-label'), prog = $('#ex-progress');
    prog.hidden = false;
    chintu('busy', 'Rendering…');

    try {
      const files = await pagesToImages(
        list.map(p => ({ page: p, number: d.pages.indexOf(p) + 1 })),
        { format, dpi, quality, stem, onProgress: (i, n) => {
          bar.style.width = (i / n * 100) + '%';
          label.textContent = `page ${Math.min(i + 1, n)} of ${n}`;
        } });

      if (files.length > 1 && $('#ex-zip').checked) {
        await zipFiles(files, `${stem}-images.zip`);
      } else {
        files.forEach((f, i) => setTimeout(() => download(f.blob, f.name), i * 220));
      }
      chintu('grin', `${files.length} image${files.length > 1 ? 's' : ''} on the way.`);
      confetti(50);
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'bad', 5000);
      chintu('ohno');
    } finally {
      setTimeout(() => { prog.hidden = true; bar.style.width = '0'; }, 900);
    }
  };
}

/* ══════════════ right panel: images → PDF ══════════════ */

let imQueue = [];

function wireBuildPanel() {
  $('#im-pick').onclick = () => $('#im-file').click();
  $('#im-margin').oninput = e => { $('#im-marginval').textContent = e.target.value + ' pt'; };

  $('#im-file').onchange = async e => {
    busy(true, 'Loading images…');
    for (const f of e.target.files) {
      try { imQueue.push(await addImage(f)); } catch (err) { toast(err.message, 'bad'); }
    }
    busy(false);
    e.target.value = '';
    renderImList();
  };

  $('#btn-build-pdf').onclick = () => {
    if (!imQueue.length) return;
    const d = makeImageDoc('images.pdf', imQueue, $('#im-size').value, +$('#im-margin').value);
    state.activeDoc = d.id;
    state.current = 0;
    state.selection.clear();
    imQueue = [];
    renderImList();
    chintu('grin', `Built a ${d.pages.length}-page PDF. Save it when you're happy.`);
    confetti(50);
    refresh();
  };
}

function renderImList() {
  const wrap = $('#im-list');
  wrap.textContent = '';
  imQueue.forEach(im => {
    const row = document.createElement('div');
    row.className = 'imrow';
    row.dataset.id = im.id;
    row.innerHTML = `<img src="${im.url}" alt=""><span></span><span class="ix">✕</span>`;
    row.querySelector('span').textContent = im.name;
    row.querySelector('.ix').onclick = () => {
      imQueue = imQueue.filter(x => x !== im);
      renderImList();
    };
    wrap.appendChild(row);
  });
  $('#btn-build-pdf').disabled = !imQueue.length;
  if (imQueue.length) {
    new window.Sortable(wrap, {
      animation: 130,
      onEnd: e => {
        const [m] = imQueue.splice(e.oldIndex, 1);
        imQueue.splice(e.newIndex, 0, m);
      },
    });
  }
}

/* ══════════════ saving ══════════════ */

async function doSave() {
  const d = doc();
  if (!d || !d.pages.length) return toast('Nothing to save.', 'bad');

  let all = false;
  if (state.docs.length > 1) {
    const res = await modal({
      title: 'Save which?',
      ok: '💾 Save',
      body: `<label class="opt is-on"><input type="radio" name="sv" value="one" checked>
               Just <b>${d.name.replace(/</g, '&lt;')}</b></label>
             <label class="opt"><input type="radio" name="sv" value="all">
               All ${state.docs.length} documents, as a .zip</label>`,
    });
    if (!res) return;
    all = res.querySelector('input[name=sv]:checked').value === 'all';
  }

  busy(true, 'Assembling your PDF…');
  chintu('busy');
  try {
    if (all) {
      await saveDocsAsZip(state.docs, 'chintu-pdfs.zip',
        (i, n) => busy(true, `document ${i + 1} of ${n}…`));
      chintu('grin', 'All of them, zipped.');
    } else {
      const bytes = await savePdf(d, (i, n) => busy(true, `page ${i + 1} of ${n}…`));
      chintu('grin', `Saved — ${(bytes / 1024 / 1024).toFixed(2)} MB.`);
    }
    state.dirty = false;
    confetti();
  } catch (err) {
    console.error(err);
    toast(`Could not build the PDF: ${err.message}`, 'bad', 6000);
    chintu('ohno', 'That one defeated me.');
  } finally {
    busy(false);
  }
}

/* ══════════════ keyboard ══════════════ */

function wireKeys() {
  window.addEventListener('keydown', e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return doSave(); }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (doUndo()) { thumbCache.clear(); refresh(); says('Undone.'); }
      return;
    }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      if (doRedo()) { thumbCache.clear(); refresh(); says('Redone.'); }
      return;
    }
    if (typing) return;

    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      pages().forEach(p => state.selection.add(p.id));
      return refresh();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return doDelete(); }
    if (e.key === '[') return ACTIONS['rotate-ccw'](), refresh();
    if (e.key === ']') return ACTIONS['rotate-cw'](), refresh();
    if (e.key === 'Escape' && cropMode) return exitCrop();
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { step(1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { step(-1); }
  });
}

function step(d) {
  const n = pages().length;
  if (!n) return;
  state.current = clamp(state.current + d, 0, n - 1);
  state.selection.clear();
  exitCrop();
  refresh();
}

/* ══════════════ drag & drop ══════════════ */

function wireDrop() {
  let depth = 0;
  const veil = $('#dropveil');
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    veil.classList.add('on');
  });
  window.addEventListener('dragover', e => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; veil.classList.remove('on'); }
  });
  window.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    veil.classList.remove('on');
    handleFiles(e.dataTransfer.files);
  });
}

/* ══════════════ boot ══════════════ */

function init() {
  $('#btn-open').onclick = $('#btn-open-2').onclick = () => $('#file-input').click();
  $('#file-input').onchange = e => { handleFiles(e.target.files); e.target.value = ''; };
  $('#btn-save').onclick = doSave;
  $('#btn-undo').onclick = () => { if (doUndo()) { thumbCache.clear(); refresh(); } };
  $('#btn-redo').onclick = () => { if (doRedo()) { thumbCache.clear(); refresh(); } };

  $('#stage-toolbar').onclick = e => {
    const b = e.target.closest('.tool');
    if (!b || b.disabled) return;
    ACTIONS[b.dataset.act]?.();
    if (b.dataset.act !== 'crop') refresh();
  };

  $('#btn-prev').onclick = () => step(-1);
  $('#btn-next').onclick = () => step(1);
  $('#zoom').oninput = e => { $('#zoomval').textContent = e.target.value + '%'; renderStage(); };
  $('#btn-select-all').onclick = () => { pages().forEach(p => state.selection.add(p.id)); refresh(); };
  $('#btn-select-none').onclick = () => { state.selection.clear(); refresh(); };

  $$('.ptab').forEach(t => t.onclick = () => {
    $$('.ptab').forEach(x => x.classList.toggle('is-on', x === t));
    $$('.panel-body').forEach(p => p.hidden = p.dataset.panel !== t.dataset.tab);
  });

  wirePagePanel();
  wireSignPanel();
  wireExportPanel();
  wireBuildPanel();
  wireCrop();
  wireKeys();
  wireDrop();
  startBlinking();

  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(renderStage, 140); });
  window.addEventListener('beforeunload', e => {
    if (state.dirty && state.docs.length) { e.preventDefault(); e.returnValue = ''; }
  });

  refresh();

  // handy from the devtools console
  window.CHINTU = { state, ops, sig, doc, pages, refresh, handleFiles };
}

init();

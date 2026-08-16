/* ══════════════════════════════════════════════════════════
   signature.js — draw / type / upload a signature, then stamp it
   ══════════════════════════════════════════════════════════ */

import { state, uid, pageSize, checkpoint, commit } from './state.js';

const LS_KEY = 'chintu.signatures';

/* ── the saved library ──────────────────────────────────── */

export function loadLibrary() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}

function saveLibrary(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  catch { /* quota — the signature still works for this session */ }
}

export function addToLibrary(dataUrl, w, h) {
  const list = loadLibrary();
  list.unshift({ id: uid(), dataUrl, w, h });
  saveLibrary(list.slice(0, 12));
  return list[0];
}

export function removeFromLibrary(id) {
  saveLibrary(loadLibrary().filter(s => s.id !== id));
}

/* ── canvas helpers ─────────────────────────────────────── */

/** Crop away fully transparent edges so the stamp sits tight on its ink. */
export function trimCanvas(cv, pad = 6) {
  const g = cv.getContext('2d');
  const { data } = g.getImageData(0, 0, cv.width, cv.height);
  let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (data[(y * cv.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;                       // nothing drawn
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(cv.width - 1, x1 + pad); y1 = Math.min(cv.height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/* ── 1. draw pad ────────────────────────────────────────── */

export function makeDrawPad(canvas, getStyle) {
  const g = canvas.getContext('2d');
  let drawing = false, pts = [], dirty = false;

  const at = e => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width,
             y: (e.clientY - r.top) * canvas.height / r.height };
  };

  const stroke = () => {
    const { color, width } = getStyle();
    g.strokeStyle = color; g.lineWidth = width * 2;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    if (pts.length < 3) {
      const p = pts[0];
      g.arc(p.x, p.y, g.lineWidth / 2, 0, Math.PI * 2);
      g.fillStyle = color; g.fill();
      return;
    }
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      g.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);   // smoothed, not jagged
    }
    g.lineTo(pts.at(-1).x, pts.at(-1).y);
    g.stroke();
  };

  canvas.addEventListener('pointerdown', e => {
    drawing = true; dirty = true;
    canvas.setPointerCapture(e.pointerId);
    pts = [at(e)];
    stroke();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    pts.push(at(e));
    if (pts.length > 4) pts = pts.slice(-4);
    stroke();
  });
  const stop = () => { drawing = false; pts = []; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  return {
    clear() { g.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
    isEmpty() { return !dirty; },
    result() { return trimCanvas(canvas); },
  };
}

/* ── 2. typed signature ─────────────────────────────────── */

export async function renderTyped(canvas, text, font, color) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!text.trim()) return null;

  try { await document.fonts.load(`120px "${font}"`, text); } catch { /* fall back */ }

  let size = 120;
  g.font = `${size}px "${font}"`;
  const max = canvas.width - 60;
  const w = g.measureText(text).width;
  if (w > max) { size = Math.max(24, size * max / w); g.font = `${size}px "${font}"`; }

  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2);
  return trimCanvas(canvas, 10);
}

/* ── 3. uploaded image ──────────────────────────────────── */

export async function renderUploaded(canvas, imgEl, knockout, threshold) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!imgEl) return null;

  const k = Math.min(canvas.width / imgEl.naturalWidth, canvas.height / imgEl.naturalHeight, 4);
  const w = Math.round(imgEl.naturalWidth * k), h = Math.round(imgEl.naturalHeight * k);
  g.drawImage(imgEl, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);

  if (knockout) {
    const im = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= threshold) d[i + 3] = 0;
      else if (lum > threshold - 45) d[i + 3] = Math.round(d[i + 3] * (threshold - lum) / 45);
    }
    g.putImageData(im, 0, 0);
  }
  return trimCanvas(canvas, 4);
}

/* ── stamping onto a page ───────────────────────────────── */

export function stampOnPage(page, sig) {
  const ps = pageSize(page);
  const aspect = sig.w / sig.h;
  const wFrac = 0.34;
  const hFrac = (wFrac * ps.w / aspect) / ps.h;
  const ov = { id: uid(), dataUrl: sig.dataUrl,
               x: 0.5 - wFrac / 2, y: 0.66, w: wFrac, h: hFrac, rot: 0 };
  checkpoint();
  page.overlays.push(ov);
  commit();
  return ov;
}

/* ── the draggable stamps on the stage ──────────────────── */

export function mountOverlays(page, layer, onChange) {
  layer.textContent = '';
  if (!page) return;

  page.overlays.forEach(ov => {
    const el = document.createElement('div');
    el.className = 'ovl';
    el.dataset.id = ov.id;
    el.innerHTML = `<img src="${ov.dataUrl}" alt="signature">
      <span class="ostem"></span>
      <span class="oh" data-o="rot"></span>
      <span class="oh" data-o="se"></span>
      <span class="oh" data-o="del">✕</span>`;
    place(el, ov);
    layer.appendChild(el);

    const box = () => layer.getBoundingClientRect();

    const select = () => {
      layer.querySelectorAll('.ovl').forEach(o => o.classList.remove('is-on'));
      el.classList.add('is-on');
    };

    el.addEventListener('pointerdown', e => {
      const handle = e.target.closest('.oh')?.dataset.o;
      select();
      if (handle === 'del') {
        checkpoint();
        page.overlays.splice(page.overlays.indexOf(ov), 1);
        commit();
        onChange?.(true);
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const r = box();
      const start = { mx: e.clientX, my: e.clientY, ...ov };
      const cx = r.left + (ov.x + ov.w / 2) * r.width;
      const cy = r.top + (ov.y + ov.h / 2) * r.height;
      const aspect = ov.w * r.width / (ov.h * r.height);
      const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;

      let moved = false;
      const move = ev => {
        if (!moved) { checkpoint(); moved = true; }
        const dx = (ev.clientX - start.mx) / r.width;
        const dy = (ev.clientY - start.my) / r.height;

        if (handle === 'se') {
          const w = Math.max(0.04, Math.min(1.6, start.w + dx));
          ov.w = w;
          ov.h = (w * r.width / aspect) / r.height;
        } else if (handle === 'rot') {
          const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
          let deg = start.rot + (a - startAngle);
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          ov.rot = ((deg % 360) + 360) % 360;
        } else {
          ov.x = start.x + dx;
          ov.y = start.y + dy;
        }
        place(el, ov);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) { commit(); onChange?.(false); }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });
}

function place(el, ov) {
  el.style.left = ov.x * 100 + '%';
  el.style.top = ov.y * 100 + '%';
  el.style.width = ov.w * 100 + '%';
  el.style.height = ov.h * 100 + '%';
  el.style.transform = `rotate(${ov.rot || 0}deg)`;
}

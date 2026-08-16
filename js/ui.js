/* ══════════════════════════════════════════════════════════
   ui.js — chrome: Pappu's moods, toasts, modals, confetti
   ══════════════════════════════════════════════════════════ */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ── toasts ─────────────────────────────────────────────── */

export function toast(msg, kind = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ── Pappu ──────────────────────────────────────────────── */

const MOUTHS = {
  happy:   'M23 44q9 7 18 0',
  grin:    'M22 42q10 12 20 0',
  flat:    'M24 46h16',
  ohno:    'M27 47a5 5 0 0 1 10 0a5 5 0 0 1-10 0',
  smug:    'M24 45q9 4 17 -2',
};

let sayTimer = null;

export function pappu(mood = 'happy', line = null) {
  const m = document.getElementById('pappu-mouth');
  const el = document.getElementById('mascot');
  if (m && MOUTHS[mood]) m.setAttribute('d', MOUTHS[mood]);
  if (el) {
    el.classList.toggle('spin', mood === 'busy');
    document.getElementById('pappu-sweat')
      ?.classList.toggle('p-hidden', mood !== 'ohno' && mood !== 'busy');
    if (mood === 'grin') {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  }
  if (line) says(line);
}

export function says(line, holdMs = 4200) {
  const p = document.getElementById('pappu-says');
  if (!p) return;
  p.textContent = line;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { p.textContent = idleLine(); }, holdMs);
}

const IDLE = [
  'Feed me a PDF.',
  'Nothing leaves this browser. Promise.',
  'Drag pages around. Go on.',
  'Pappu is just vibing.',
  'Try signing something.',
];
export const idleLine = () => IDLE[Math.floor(Math.random() * IDLE.length)];

/** Idle blinking, so he looks alive. */
export function startBlinking() {
  const el = document.getElementById('mascot');
  if (!el) return;
  const tick = () => {
    el.classList.add('blink');
    setTimeout(() => el.classList.remove('blink'), 130);
    setTimeout(tick, 2200 + Math.random() * 4200);
  };
  setTimeout(tick, 1800);
  el.addEventListener('click', () => {
    pappu('grin', 'Ow. But also thank you.');
  });
}

/* ── busy veil ──────────────────────────────────────────── */

export function busy(on, text = 'working…') {
  const b = document.getElementById('busy');
  document.getElementById('busy-text').textContent = text;
  b.hidden = !on;
  if (on) pappu('busy');
}

/* ── modal ──────────────────────────────────────────────── */

/**
 * Minimal promise-based modal.
 * @param {{title:string, body:string, ok?:string, cancel?:string}} cfg
 * @returns {Promise<HTMLElement|null>} the modal element on OK, null on cancel
 */
export function modal({ title, body, ok = 'Do it', cancel = 'Never mind' }) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    root.hidden = false;
    root.innerHTML = `<div class="modal">
      <h3>${title}</h3>
      <div class="mbody">${body}</div>
      <div class="mrow">
        <button class="btn btn-white" data-x>${cancel}</button>
        <button class="btn btn-lime" data-ok>${ok}</button>
      </div>
    </div>`;
    const box = root.firstElementChild;
    const close = val => { root.hidden = true; root.innerHTML = ''; resolve(val); };
    box.querySelector('[data-x]').onclick = () => close(null);
    box.querySelector('[data-ok]').onclick = () => close(box);
    root.onclick = e => { if (e.target === root) close(null); };
    $$('.opt', box).forEach(o => o.onclick = () => {
      $$('.opt', box).forEach(x => x.classList.remove('is-on'));
      o.classList.add('is-on');
    });
    box.querySelector('input,select')?.focus();
  });
}

/* ── confetti ───────────────────────────────────────────── */

export function confetti(n = 90) {
  const cv = $('#confetti');
  cv.hidden = false;
  cv.width = innerWidth; cv.height = innerHeight;
  const g = cv.getContext('2d');
  const cols = ['#FFD93D', '#FF5C8A', '#5FE0EE', '#A8E85C', '#C09BFF', '#141414'];
  const bits = Array.from({ length: n }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 260,
    y: innerHeight + 20,
    vx: (Math.random() - .5) * 13,
    vy: -(11 + Math.random() * 13),
    s: 6 + Math.random() * 9,
    a: Math.random() * 6,
    va: (Math.random() - .5) * .35,
    c: cols[(Math.random() * cols.length) | 0],
  }));
  let frames = 0;
  (function loop() {
    g.clearRect(0, 0, cv.width, cv.height);
    bits.forEach(b => {
      b.vy += .42; b.x += b.vx; b.y += b.vy; b.a += b.va;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.a);
      g.fillStyle = b.c;
      g.strokeStyle = '#141414';
      g.lineWidth = 1.5;
      g.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      g.strokeRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      g.restore();
    });
    if (++frames < 150) requestAnimationFrame(loop);
    else { g.clearRect(0, 0, cv.width, cv.height); cv.hidden = true; }
  })();
}

# Pappu-PDF

A PDF editor that runs entirely in the browser. No server, no uploads, no build step —
open `index.html` from any static host and it works.

![no backend](https://img.shields.io/badge/backend-none-A8E85C) ![files uploaded](https://img.shields.io/badge/files%20uploaded-zero-FF5C8A)

## What it does

**Page operations** — add blank pages, delete, duplicate, reorder by dragging, rotate,
extract a selection into a new document, split, merge, move pages between open documents,
crop with a draggable box, resize to A4/Letter/Legal/custom, thumbnail sidebar with
multi-select (click, shift-click, ctrl-click).

**Signatures** — draw one with the mouse or a touchscreen, type one in a handwriting font,
or upload a photo of a real signature (with white-background knockout). Saved signatures live
in `localStorage`, so they're there next time. Stamp one on any page, then drag it, pull the
corner to resize, or twist the top handle to rotate.

**Conversions** — PDF → JPG/PNG at 72–600 dpi (single files or a zip), and JPG/PNG → PDF with
a choice of page size and margin.

## Keyboard

| Key | Does |
|---|---|
| `Ctrl+S` | save the current document |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Del` | delete the selected pages |
| `[` / `]` | rotate left / right |
| `←` `→` | previous / next page |
| `Ctrl+A` | select every page |
| `Esc` | leave crop mode |

## Running it locally

ES modules need a real HTTP origin, so `file://` won't work. Any static server does:

```bash
python -m http.server 8777
```

Then open <http://localhost:8777>.

## Putting it on GitHub Pages

```bash
git init
git add .
git commit -m "Pappu-PDF"
git branch -M main
git remote add origin https://github.com/<you>/pappu-pdf.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save.**
A minute later it's live at `https://<you>.github.io/pappu-pdf/`. Every later `git push` redeploys it.

## How it's put together

```
index.html          one page, four tool panels
css/style.css       the neobrutalist design system
js/state.js         the workspace model + undo/redo
js/render.js        pdf.js loading, page → canvas
js/pageops.js       every page operation + the pdf-lib exporter
js/signature.js     draw / type / upload, and the draggable stamps
js/convert.js       image export, zipping, downloads
js/ui.js            toasts, modals, confetti, Pappu's moods
js/app.js           wiring
vendor/             pdf-lib, pdf.js, SortableJS, JSZip (committed, no npm)
```

The central idea is that **nothing edits a real PDF until you hit save.** The workspace is a
plain list of page descriptors:

```js
{ kind:'pdf', src:'a1b2', srcPage:3, rotation:90,
  crop:{l:.1,t:0,r:.1,b:0}, size:null, overlays:[…] }
```

Rotating a page sets a number. Moving a page between documents is an array splice. Undo is a
JSON snapshot. Only `buildPdf()` in `pageops.js` touches pdf-lib, and it takes the cheapest
route it can: pages that merely need rotating or cropping are **copied verbatim**, so links,
annotations and form fields survive; only pages that were resized or signed get re-composed
onto a fresh page.

## Known limits

- Password-protected PDFs won't open.
- A page that gets resized or signed is rebuilt, which drops that page's link annotations and
  form fields (the page content itself is untouched, and text stays selectable).
- Very large PDFs are held in memory, so a 500 MB scan will make your tab sweat.
- Rendering pauses while the tab is in the background — pdf.js schedules on `requestAnimationFrame`.

## Credits

[pdf-lib](https://pdf-lib.js.org/) · [pdf.js](https://mozilla.github.io/pdf.js/) ·
[SortableJS](https://sortablejs.github.io/Sortable/) · [JSZip](https://stuk.github.io/jszip/) ·
fonts: Archivo Black, Space Grotesk, Caveat, Dancing Script, Great Vibes, Homemade Apple (OFL).

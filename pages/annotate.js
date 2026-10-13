/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch, pages/annotate.js
 * Extracted from pages/annotate.html: MV3 blocks inline scripts (CSP),
 * so page logic must live in an external file.
 */
(() => {
'use strict';
const UI = window.ImgFetchUI;

const $ = (id) => document.getElementById(id);
const id = location.hash.replace('#', '');
UI.applyTheme('system');

const state = {
  tool: 'pen',
  color: '#e5484d',
  width: 6,
  strokes: [], // {kind, ...}, vector list for undo
  drawing: null,
  selected: -1,  // index of the selected text stroke (-1 = none)
  dragText: null, // {dx, dy} while dragging a selected text stroke
};

let baseCanvas = null;   // original screenshot (full res)
let annotCanvas = null;  // annotation layer (full res)
let actx = null;
const editor = $('editor');
const ectx = editor.getContext('2d');

function fail(msg) {
  const loading = $('loading');
  loading.replaceChildren();
  const p = document.createElement('p');
  p.textContent = msg;
  loading.append(p);
}

/**
 * M11: layered rendering. The committed-strokes layer is repainted only when
 * the stroke list actually changes; the display canvas is a cheap composite
 * of cached layers. Drag previews and selection moves never repaint strokes.
 */
function repaintAnnotLayer(exclude = -1) {
  actx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  state.strokes.forEach((s, i) => {
    if (i !== exclude) paintStroke(actx, s);
  });
}

/** Cheap composite of cached layers onto the display canvas (no selection). */
function composite() {
  ectx.clearRect(0, 0, editor.width, editor.height);
  ectx.drawImage(baseCanvas, 0, 0);
  ectx.drawImage(annotCanvas, 0, 0);
}

/**
 * B6: drag rendering via requestAnimationFrame + preview. Pointermove can
 * fire faster than the display refresh, coalesce into one frame, and draw
 * the dragged stroke as a preview on top of the cheap composite instead of
 * repainting every committed stroke on every move event.
 */
let dragRaf = 0;
function scheduleDragRender() {
  if (dragRaf) return;
  const idx = state.selected;
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0;
    repaintAnnotLayer(idx); // committed strokes minus the dragged one
    composite();
    const s = state.strokes[idx];
    if (s) paintStroke(ectx, s); // preview: dragged stroke on top
  });
}

function redraw() {
  // Composite base + all strokes onto the display canvas.
  // Pure: the saved image comes from this, never from selection chrome.
  repaintAnnotLayer();
  composite();
}

/** Display render: repaint the committed-strokes layer + composite. */
function render() {
  redraw();
}

/** Text selection is invisible (drag only), just the cheap composite. */
function renderSelection() {
  composite();
}

/* ---------------- selectable text ---------------- */

function textFont(s) {
  return `600 ${Math.max(14, s.width * 4)}px system-ui, sans-serif`;
}

function textBounds(s) {
  const mctx = textBounds.ctx || (textBounds.ctx = document.createElement('canvas').getContext('2d'));
  mctx.font = textFont(s);
  const m = mctx.measureText(s.text);
  const size = Math.max(14, s.width * 4);
  const asc = m.actualBoundingBoxAscent || size * 0.8;
  const desc = m.actualBoundingBoxDescent || size * 0.2;
  const pad = 6;
  return { x: s.at[0] - pad, y: s.at[1] - asc - pad, w: m.width + pad * 2, h: asc + desc + pad * 2 };
}

/** Topmost text stroke under (x, y), or -1. Coordinates are full-res. */
function hitText(x, y) {
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (!s || s.kind !== 'text') continue;
    const b = textBounds(s);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

function deleteSelectedText() {
  if (state.selected < 0 || state.selected >= state.strokes.length) return;
  state.strokes.splice(state.selected, 1);
  state.selected = -1;
  state.dragText = null;
  render();
  $('btnUndo').disabled = state.strokes.length === 0;
}

function paintStroke(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'pen') {
    ctx.beginPath();
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  } else if (s.kind === 'arrow' || s.kind === 'line') {
    const [x1, y1] = s.from;
    const [x2, y2] = s.to;
    if (s.kind === 'arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      // Head scales with the line so short arrows don't get swallowed:
      // never larger than ~38% of the shaft, never invisibly small.
      const head = Math.max(8, Math.min(s.width * 2.6, len * 0.38));
      const spread = 0.46; // ~26° per side, clean modern head
      // Shaft stops at the head base so the head sits exactly on the end.
      const bx = x2 - head * Math.cos(ang);
      const by = y2 - head * Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - spread), y2 - head * Math.sin(ang - spread));
      ctx.lineTo(x2 - head * Math.cos(ang + spread), y2 - head * Math.sin(ang + spread));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  } else if (s.kind === 'rect') {
    const [x, y, w, h] = s.rect;
    ctx.strokeRect(x, y, w, h);
  } else if (s.kind === 'circle') {
    const [cx, cy, rx, ry] = s.ellipse;
    if (rx >= 1 && ry >= 1) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (s.kind === 'text') {
    ctx.font = `600 ${Math.max(14, s.width * 4)}px system-ui, sans-serif`;
    ctx.fillText(s.text, s.at[0], s.at[1]);
  } else if (s.kind === 'pixelate') {
    // Pixelate the region from the BASE image onto the annotation layer.
    // L8: block size scales with the image (not a fixed 14 px), so a 4K
    // screenshot gets the same hiding strength as a small one.
    const [x, y, w, h] = s.rect.map(Math.round);
    if (w < 2 || h < 2) return;
    const block = Math.min(64, Math.max(8, Math.round(Math.min(baseCanvas.width, baseCanvas.height) / 48)));
    const tiny = document.createElement('canvas');
    const tw = Math.max(1, Math.round(w / block));
    const th = Math.max(1, Math.round(h / block));
    tiny.width = tw;
    tiny.height = th;
    const tctx = tiny.getContext('2d');
    tctx.drawImage(baseCanvas, x, y, w, h, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, 0, 0, tw, th, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }
  ctx.restore();
}

function canvasPos(e) {
  const r = editor.getBoundingClientRect();
  const sx = editor.width / r.width;
  const sy = editor.height / r.height;
  return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
}

editor.addEventListener('pointerdown', (e) => {
  if (state.tool === 'text') {
    const [x, y] = canvasPos(e);
    const hit = hitText(x, y);
    if (hit >= 0) {
      // Select existing text, drag to move it.
      state.selected = hit;
      const s = state.strokes[hit];
      state.dragText = { dx: x - s.at[0], dy: y - s.at[1] };
      editor.setPointerCapture(e.pointerId);
      render();
      return;
    }
    state.selected = -1;
    state.dragText = null;
    placeText(e);
    return;
  }
  if (state.selected >= 0) {
    state.selected = -1;
    renderSelection();
  }
  editor.setPointerCapture(e.pointerId);
  const [x, y] = canvasPos(e);
  state.drawing = { tool: state.tool, from: [x, y], points: [[x, y]] };
});

editor.addEventListener('pointermove', (e) => {
  if (state.dragText && state.selected >= 0) {
    const s = state.strokes[state.selected];
    if (s && s.kind === 'text') {
      const [x, y] = canvasPos(e);
      s.at = [x - state.dragText.dx, y - state.dragText.dy];
      scheduleDragRender(); // B6: rAF-throttled preview, no full repaint
    }
    return;
  }
  // No selection chrome, the cursor tells the user text is draggable.
  if (!state.drawing && state.tool === 'text') {
    const [x, y] = canvasPos(e);
    editor.style.cursor = hitText(x, y) >= 0 ? 'move' : 'text';
  }
  if (!state.drawing) return;
  const [x, y] = canvasPos(e);
  const d = state.drawing;
  if (d.tool === 'pen') d.points.push([x, y]);
  else d.to = [x, y];
  // M11: live preview on the cheap composite, never repaint all strokes here.
  composite();
  const preview = previewStroke(d);
  if (preview) paintStroke(ectx, preview);
});

editor.addEventListener('pointerup', (e) => {
  if (state.dragText) {
    state.dragText = null;
    if (dragRaf) {
      // A preview frame is still queued, commit the final position now.
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    render();
    return;
  }
  if (!state.drawing) return;
  const d = state.drawing;
  state.drawing = null;
  const [x, y] = canvasPos(e);
  const stroke = finalizeStroke(d, x, y);
  if (stroke) state.strokes.push(stroke);
  render();
  $('btnUndo').disabled = state.strokes.length === 0;
});

function previewStroke(d) {
  const base = { color: state.color, width: state.width };
  if (d.tool === 'pen') return { ...base, kind: 'pen', points: d.points };
  if (!d.to) return null;
  if (d.tool === 'arrow') return { ...base, kind: 'arrow', from: d.from, to: d.to };
  if (d.tool === 'rect' || d.tool === 'pixelate') {
    return { ...base, kind: d.tool, rect: rectOf(d.from, d.to) };
  }
  if (d.tool === 'circle') return { ...base, kind: 'circle', ellipse: ellipseOf(d.from, d.to) };
  return null;
}

function rectOf(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}

/** Ellipse from a drag: [centerX, centerY, radiusX, radiusY]. */
function ellipseOf(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2];
}

function finalizeStroke(d, x, y) {
  const base = { color: state.color, width: state.width };
  if (d.tool === 'pen') {
    return d.points.length > 1 ? { ...base, kind: 'pen', points: d.points } : null;
  }
  const to = d.to || [x, y];
  const dist = Math.hypot(to[0] - d.from[0], to[1] - d.from[1]);
  if (dist < 4) return null;
  if (d.tool === 'arrow') return { ...base, kind: 'arrow', from: d.from, to };
  if (d.tool === 'rect' || d.tool === 'pixelate') return { ...base, kind: d.tool, rect: rectOf(d.from, to) };
  if (d.tool === 'circle') return { ...base, kind: 'circle', ellipse: ellipseOf(d.from, to) };
  return null;
}

function hideTextBox() {
  const wrap = $('textWrap');
  if (wrap) wrap.style.display = 'none';
}

function placeText(e) {
  const [x, y] = canvasPos(e);
  const input = $('textInput');
  const wrap = $('textWrap');
  const r = editor.getBoundingClientRect();
  const stageR = $('stage').getBoundingClientRect();
  wrap.style.display = 'block';
  wrap.style.left = `${r.left - stageR.left + x / (editor.width / r.width)}px`;
  wrap.style.top = `${r.top - stageR.top + y / (editor.height / r.height)}px`;
  input.value = '';
  input.focus();
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter' && input.value.trim()) {
      state.strokes.push({ kind: 'text', text: input.value.trim().slice(0, 120), at: [x, y], color: state.color, width: state.width });
      state.selected = state.strokes.length - 1; // select it so it can be dragged right away
      hideTextBox();
      render();
      $('btnUndo').disabled = false;
    } else if (ev.key === 'Escape') {
      hideTextBox();
    }
    ev.stopPropagation();
  };
}

$('textClose').addEventListener('click', (ev) => {
  ev.stopPropagation();
  hideTextBox();
});

// Toolbar wiring
document.querySelectorAll('.tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    state.tool = b.dataset.tool;
    state.selected = -1;
    state.dragText = null;
    editor.style.cursor = state.tool === 'text' ? 'text' : 'crosshair';
    renderSelection();
    // L8: pixelation is weak redaction, warn once per session.
    if (state.tool === 'pixelate' && !state.pixelateWarned) {
      state.pixelateWarned = true;
      UI.toast('Pixelation hides details from casual viewing, but it can sometimes be reversed, don’t rely on it for sensitive text.', 5000);
    }
    document.querySelectorAll('.tool[data-tool]').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
  });
});
document.querySelectorAll('.swatch').forEach((b) => {
  b.addEventListener('click', () => {
    state.color = b.dataset.color;
    document.querySelectorAll('.swatch').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
  });
});
document.querySelectorAll('.tool[data-width]').forEach((b) => {
  b.addEventListener('click', () => {
    state.width = Number(b.dataset.width);
    document.querySelectorAll('.tool[data-width]').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
  });
});
$('btnUndo').addEventListener('click', () => {
  state.strokes.pop();
  if (state.selected >= state.strokes.length) state.selected = -1;
  render();
  $('btnUndo').disabled = state.strokes.length === 0;
});
$('btnUndo').disabled = true;
$('btnClear').addEventListener('click', () => {
  state.strokes = [];
  state.selected = -1;
  state.dragText = null;
  render();
  $('btnUndo').disabled = true;
});

// Delete / Escape for the selected text (ignored while typing in the box).
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
    e.preventDefault();
    deleteSelectedText();
  } else if (e.key === 'Escape' && state.selected >= 0 && !state.drawing) {
    state.selected = -1;
    renderSelection();
  }
});

$('btnSave').addEventListener('click', async () => {
  $('btnSave').disabled = true;
  try {
    redraw();
    const dataUrl = editor.toDataURL('image/png');
    await UI.send('SAVE_ANNOTATED', { id, dataUrl });
    UI.toast('Screenshot saved.');
    setTimeout(() => window.close(), 800);
  } catch (err) {
    UI.toast(err.message || 'Save failed.');
    $('btnSave').disabled = false;
  }
});
$('btnCancel').addEventListener('click', () => window.close());

async function init() {
  try {
    const { settings } = await UI.send('GET_SETTINGS');
    UI.applyTheme(settings.theme);
    UI.watchSystemTheme(() => settings.theme);
  } catch {
    UI.applyTheme('system');
  }
  if (!id) {
    fail('This editor link is invalid.');
    return;
  }
  let cap;
  try {
    cap = await UI.send('GET_CAPTURE', { id });
  } catch (err) {
    fail(err.message);
    return;
  }
  const img = new Image();
  img.onload = () => {
    baseCanvas = document.createElement('canvas');
    baseCanvas.width = img.naturalWidth;
    baseCanvas.height = img.naturalHeight;
    baseCanvas.getContext('2d').drawImage(img, 0, 0);
    annotCanvas = document.createElement('canvas');
    annotCanvas.width = baseCanvas.width;
    annotCanvas.height = baseCanvas.height;
    actx = annotCanvas.getContext('2d');
    editor.width = baseCanvas.width;
    editor.height = baseCanvas.height;
    // Fit large screenshots on screen via CSS while keeping full res.
    const maxW = Math.min(1040, window.innerWidth - 40);
    if (editor.width > maxW) editor.style.width = `${maxW}px`;
    redraw();
    $('loading').hidden = true;
    $('content').hidden = false;
  };
  img.onerror = () => fail('Could not load the screenshot.');
  img.src = cap.dataUrl;
}

document.addEventListener('DOMContentLoaded', init);
})();

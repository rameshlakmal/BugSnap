// Screenshot editor: annotate the captured area (arrow, box, highlight, pen, text, numbered
// markers, blur), then save it to the BugSnap server, which shares it like a recording.
//
// Marks are kept as data and redrawn on every change, so they stay editable: click a mark to
// select it, drag to move, drag its handles to adjust (arrow ends, box corners), double-click
// text to edit, Delete to remove. Colour and thickness apply to the selected mark. Undo/redo
// keeps whole snapshots. The saved and copied PNG is full resolution without selection marks.
import { collectEnvironment } from './recorder-core.js';

const $ = (id) => document.getElementById(id);
const I = globalThis.ScreenRecIcons || {};
document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = I[el.dataset.icon] || ''));

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const base = new Image();
let draft = null;
let shapes = [];
let history = [[]]; // snapshots of `shapes`
let at = 0; // position in history
let tool = 'arrow';
let color = '#e5484d';
let size = 1;
let selected = null; // index into shapes
let action = null; // current pointer gesture

const FONT = '"Figtree", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const onDark = (c) => !['#ffffff', '#f5a524'].includes(c);
// Sizes scale with the image so marks look the same on small and large captures.
const unit = () => Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 300));
// Image pixels per CSS pixel (the canvas is shown scaled to fit).
const px = () => canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
const clone = (v) => JSON.parse(JSON.stringify(v));

function showError(message, canRetry = false) {
  $('alert').hidden = !message;
  $('alertText').textContent = message || '';
  $('retry').hidden = !canRetry;
}

// ---------------------------------------------------------------- geometry

const norm = (s) => ({ x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) });

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function textBox(s) {
  const fs = Math.max(16, unit() * 8 * (s.size || 1));
  ctx.save();
  ctx.font = `600 ${fs}px ${FONT}`;
  const w = ctx.measureText(s.text).width + fs * 0.9;
  ctx.restore();
  const h = fs * 1.6;
  return { x: s.x, y: s.y - h / 2, w, h };
}

const numberRadius = (s) => Math.max(12, unit() * 5 * Math.sqrt(s.size || 1));

/** Handles a mark can be adjusted by (image coordinates). */
function handlesOf(s) {
  if (s.type === 'arrow') return [{ key: 'p1', x: s.x1, y: s.y1 }, { key: 'p2', x: s.x2, y: s.y2 }];
  if (s.type === 'rect' || s.type === 'highlight' || s.type === 'blur') {
    const { x, y, w, h } = norm(s);
    return [
      { key: 'nw', x, y },
      { key: 'ne', x: x + w, y },
      { key: 'sw', x, y: y + h },
      { key: 'se', x: x + w, y: y + h },
    ];
  }
  return [];
}

function bounds(s) {
  if (s.type === 'pen') {
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (s.type === 'text') return textBox(s);
  if (s.type === 'number') {
    const r = numberRadius(s);
    return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 };
  }
  return norm(s);
}

/** Topmost mark under the point, or -1. */
function hitTest(p) {
  const tol = 9 * px();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'arrow' && distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tol + unit()) return i;
    if (s.type === 'pen') {
      for (let k = 1; k < s.points.length; k++) {
        if (distToSegment(p, { x: s.points[k - 1][0], y: s.points[k - 1][1] }, { x: s.points[k][0], y: s.points[k][1] }) <= tol + unit()) return i;
      }
    }
    if (s.type === 'rect') {
      const { x, y, w, h } = norm(s);
      const nearEdge =
        p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol &&
        !(p.x > x + tol && p.x < x + w - tol && p.y > y + tol && p.y < y + h - tol);
      if (nearEdge) return i;
    }
    if (s.type === 'highlight' || s.type === 'blur' || s.type === 'text') {
      const b = bounds(s);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return i;
    }
    if (s.type === 'number' && Math.hypot(p.x - s.x, p.y - s.y) <= numberRadius(s) + tol) return i;
  }
  return -1;
}

function handleAt(p) {
  if (selected === null) return null;
  const tol = 10 * px();
  return handlesOf(shapes[selected]).find((h) => Math.hypot(p.x - h.x, p.y - h.y) <= tol) || null;
}

// ---------------------------------------------------------------- drawing

function render({ preview = null, clean = false } = {}) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  const all = preview ? [...shapes, preview] : shapes;
  // Blur first so other marks can sit on top of a blurred area.
  for (const s of all) if (s.type === 'blur') drawBlur(s);
  for (const s of all) if (s.type !== 'blur') drawShape(s);
  if (!clean && selected !== null && shapes[selected]) drawSelection(shapes[selected]);
}

function drawBlur(s) {
  const { x, y, w, h } = norm(s);
  if (w < 2 || h < 2) return;
  // Pixelate: shrink the region then draw it back up without smoothing.
  const block = Math.max(8, Math.round(Math.max(canvas.width, canvas.height) / 110));
  const tw = Math.max(1, Math.round(w / block));
  const th = Math.max(1, Math.round(h / block));
  const tmp = new OffscreenCanvas(tw, th);
  tmp.getContext('2d').drawImage(base, x, y, w, h, 0, 0, tw, th);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
  ctx.restore();
}

function drawShape(s) {
  const u = unit();
  const k = s.size || 1;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.type === 'arrow') {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 2) return ctx.restore();
    const lw = u * 1.6 * k;
    const head = Math.min(len * 0.5, lw * 3.6 + u * 2);
    const ang = Math.atan2(dy, dx);
    ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
    ctx.shadowBlur = u * 1.5;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2 - Math.cos(ang) * head * 0.6, s.y2 - Math.sin(ang) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 7), s.y2 - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 7), s.y2 - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (s.type === 'rect') {
    const { x, y, w, h } = norm(s);
    ctx.lineWidth = u * 1.4 * k;
    ctx.shadowColor = 'rgb(0 0 0 / 0.2)';
    ctx.shadowBlur = u;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, u * 2);
    ctx.stroke();
  } else if (s.type === 'highlight') {
    const { x, y, w, h } = norm(s);
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, u);
    ctx.fill();
  } else if (s.type === 'pen') {
    if (s.points.length < 2) return ctx.restore();
    ctx.lineWidth = u * 1.3 * k;
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (let i = 1; i < s.points.length - 1; i++) {
      const [x, y] = s.points[i];
      const [nx, ny] = s.points[i + 1];
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const last = s.points[s.points.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  } else if (s.type === 'text') {
    const fs = Math.max(16, u * 8 * k);
    const b = textBox(s);
    ctx.font = `600 ${fs}px ${FONT}`;
    ctx.shadowColor = 'rgb(0 0 0 / 0.2)';
    ctx.shadowBlur = u * 2;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, fs * 0.3);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = onDark(s.color) ? '#ffffff' : '#18181b';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, s.x + fs * 0.45, s.y + fs * 0.04);
  } else if (s.type === 'number') {
    const r = numberRadius(s);
    ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
    ctx.shadowBlur = u * 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, u * 0.8);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = onDark(s.color) ? '#ffffff' : '#18181b';
    ctx.font = `700 ${r * 1.1}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s.n), s.x, s.y + r * 0.06);
  }
  ctx.restore();
}

/** Dashed outline and round handles around the selected mark (never in the export). */
function drawSelection(s) {
  const p = px();
  const b = bounds(s);
  const pad = 6 * p;
  ctx.save();
  ctx.lineWidth = 1.5 * p;
  ctx.setLineDash([5 * p, 4 * p]);
  ctx.strokeStyle = '#18181b';
  if (s.type !== 'arrow') ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  for (const h of handlesOf(s)) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 6.5 * p, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 * p;
    ctx.strokeStyle = '#18181b';
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- history

let pushHistory = function () {
  history = history.slice(0, at + 1);
  history.push(clone(shapes));
  if (history.length > 100) history.shift();
  at = history.length - 1;
  updateHistory();
};

function restore(i) {
  at = i;
  shapes = clone(history[at]);
  selected = null;
  updateHistory();
  render();
}

function updateHistory() {
  $('undo').disabled = at === 0;
  $('redo').disabled = at >= history.length - 1;
  $('clear').disabled = !shapes.length;
}

const undo = () => at > 0 && restore(at - 1);
const redo = () => at < history.length - 1 && restore(at + 1);

function select(i) {
  selected = i;
  if (i !== null && shapes[i]) {
    // Show the selected mark's colour and thickness in the toolbar.
    paintColor(shapes[i].color);
    paintSize(shapes[i].size || 1);
  }
  render();
}

function removeSelected() {
  if (selected === null) return;
  shapes.splice(selected, 1);
  renumber();
  selected = null;
  pushHistory();
  render();
}

/** Keep numbered markers 1, 2, 3… after one is deleted. */
function renumber() {
  let n = 0;
  for (const s of shapes) if (s.type === 'number') s.n = ++n;
}

// ---------------------------------------------------------------- pointer

function toImage(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}

function moveShape(s, dx, dy) {
  if ('x1' in s) {
    s.x1 += dx;
    s.x2 += dx;
    s.y1 += dy;
    s.y2 += dy;
  } else if (s.type === 'pen') {
    s.points = s.points.map(([x, y]) => [x + dx, y + dy]);
  } else {
    s.x += dx;
    s.y += dy;
  }
}

function adjustShape(s, key, p) {
  if (key === 'p1') Object.assign(s, { x1: p.x, y1: p.y });
  else if (key === 'p2') Object.assign(s, { x2: p.x, y2: p.y });
  else {
    // Corner handles: move that corner, keep the opposite one.
    const b = norm(s);
    const left = key.includes('w') ? p.x : b.x;
    const right = key.includes('e') ? p.x : b.x + b.w;
    const top = key.includes('n') ? p.y : b.y;
    const bottom = key.includes('s') ? p.y : b.y + b.h;
    Object.assign(s, { x1: left, y1: top, x2: right, y2: bottom });
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (!draft || e.button !== 0) return;
  const p = toImage(e);

  // 1. A handle of the selected mark: adjust it.
  const handle = handleAt(p);
  if (handle) {
    canvas.setPointerCapture(e.pointerId);
    action = { kind: 'adjust', key: handle.key, changed: false };
    canvas.classList.add('dragging');
    return;
  }
  // 2. An existing mark: select it and get ready to move it.
  const hit = hitTest(p);
  if (hit !== -1) {
    canvas.setPointerCapture(e.pointerId);
    select(hit);
    action = { kind: 'move', last: p, changed: false };
    canvas.classList.add('dragging');
    return;
  }
  // 3. Empty space: draw with the current tool.
  select(null);
  if (tool === 'text') return startText(e, p);
  if (tool === 'number') {
    const n = shapes.filter((s) => s.type === 'number').length + 1;
    shapes.push({ type: 'number', x: p.x, y: p.y, n, color, size });
    pushHistory();
    return select(shapes.length - 1);
  }
  canvas.setPointerCapture(e.pointerId);
  const shape = tool === 'pen' ? { type: 'pen', points: [[p.x, p.y]], color, size } : { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, size };
  action = { kind: 'draw', shape };
});

canvas.addEventListener('pointermove', (e) => {
  const p = toImage(e);
  if (!action) {
    // Hover feedback: move cursor over marks, grab cursor over handles.
    canvas.classList.toggle('over-handle', Boolean(handleAt(p)));
    canvas.classList.toggle('over-shape', !handleAt(p) && hitTest(p) !== -1);
    return;
  }
  if (action.kind === 'draw') {
    const s = action.shape;
    if (s.type === 'pen') s.points.push([p.x, p.y]);
    else Object.assign(s, { x2: p.x, y2: p.y });
    render({ preview: s });
  } else if (action.kind === 'move') {
    moveShape(shapes[selected], p.x - action.last.x, p.y - action.last.y);
    action.last = p;
    action.changed = true;
    render();
  } else if (action.kind === 'adjust') {
    adjustShape(shapes[selected], action.key, p);
    action.changed = true;
    render();
  }
});

function endPointer() {
  if (!action) return;
  const a = action;
  action = null;
  canvas.classList.remove('dragging');
  if (a.kind === 'draw') {
    const s = a.shape;
    const tiny = s.type === 'pen' ? s.points.length < 2 : Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4;
    if (tiny) return render();
    shapes.push(s);
    pushHistory();
    select(shapes.length - 1); // ready to adjust straight away
  } else if (a.changed) {
    pushHistory();
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('dblclick', (e) => {
  const p = toImage(e);
  const hit = hitTest(p);
  if (hit !== -1 && shapes[hit].type === 'text') startText(e, { x: shapes[hit].x, y: shapes[hit].y }, hit);
});

function startText(e, p, editIndex = null) {
  const input = $('textInput');
  input.hidden = false;
  input.value = editIndex !== null ? shapes[editIndex].text : '';
  input.style.left = `${e.clientX}px`;
  input.style.top = `${e.clientY - 18}px`;
  input.style.borderColor = editIndex !== null ? shapes[editIndex].color : color;
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  const done = (keep) => {
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    const text = input.value.trim();
    input.hidden = true;
    if (!keep) return;
    if (editIndex !== null) {
      if (!text) {
        selected = editIndex;
        return removeSelected();
      }
      if (text !== shapes[editIndex].text) {
        shapes[editIndex].text = text;
        pushHistory();
      }
      return select(editIndex);
    }
    if (text) {
      shapes.push({ type: 'text', x: p.x, y: p.y, text, color, size });
      pushHistory();
      select(shapes.length - 1);
    }
  };
  const onKey = (ev) => {
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
    ev.stopPropagation();
  };
  const onBlur = () => done(true);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
}

// ---------------------------------------------------------------- toolbar

function setTool(name) {
  tool = name;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
  canvas.classList.toggle('text-mode', name === 'text');
}

function paintColor(c) {
  document.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x.dataset.color === c));
}
function paintSize(v) {
  document.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('on', Number(x.dataset.size) === v));
}

/** Colour/thickness: the default for new marks, and applied to the selected mark. */
function applyToSelected(patch) {
  if (selected === null || !shapes[selected]) return;
  const s = shapes[selected];
  if (Object.entries(patch).every(([k, v]) => s[k] === v)) return;
  Object.assign(s, patch);
  pushHistory();
  render();
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('[data-color]').forEach((b) =>
  b.addEventListener('click', () => {
    color = b.dataset.color;
    paintColor(color);
    applyToSelected({ color });
  }),
);
document.querySelectorAll('[data-size]').forEach((b) =>
  b.addEventListener('click', () => {
    size = Number(b.dataset.size);
    paintSize(size);
    applyToSelected({ size });
  }),
);
const SIZES = [0.6, 1, 1.6, 2.4];
function stepSize(dir) {
  const i = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(size) + dir));
  size = SIZES[i];
  paintSize(size);
  applyToSelected({ size });
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('clear').addEventListener('click', () => {
  if (!shapes.length) return;
  shapes = [];
  selected = null;
  pushHistory();
  render();
});

const KEYS = { a: 'arrow', r: 'rect', h: 'highlight', p: 'pen', t: 'text', n: 'number', b: 'blur' };
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl+C copies the annotated image, unless text is selected somewhere.
  if (mod && k === 'c' && !(typing && e.target.selectionStart !== e.target.selectionEnd) && !String(window.getSelection())) {
    if (draft) {
      e.preventDefault();
      copyImage();
    }
    return;
  }
  if (typing) return;
  if (mod && k === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && k === 'y') {
    e.preventDefault();
    redo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
    e.preventDefault();
    removeSelected();
  } else if (e.key === 'Escape' && selected !== null) {
    select(null);
  } else if (e.key === 'Escape' && embedded) {
    closeSnap();
  } else if (e.key === '[') {
    stepSize(-1);
  } else if (e.key === ']') {
    stepSize(1);
  } else if (selected !== null && e.key.startsWith('Arrow')) {
    // Nudge the selected mark: 1 px, or 10 px with Shift.
    e.preventDefault();
    const d = (e.shiftKey ? 10 : 1) * px();
    moveShape(shapes[selected], e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
    render();
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(pushHistory, 400);
  } else if (!mod && !e.altKey && KEYS[k]) {
    setTool(KEYS[k]);
  }
});
let nudgeTimer;

document.querySelectorAll('[data-kind]').forEach((b) =>
  b.addEventListener('click', () => document.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b))),
);

// ---------------------------------------------------------------- export, copy, save

/** Full-resolution PNG of the image with its marks, without selection outlines. */
function exportBlob() {
  render({ clean: true });
  return new Promise((resolve) =>
    canvas.toBlob((blob) => {
      render();
      resolve(blob);
    }, 'image/png'),
  );
}

let toastTimer;
function toast(text, ok = true) {
  const t = $('toast');
  $('toastText').textContent = text;
  const ic = t.querySelector('.icon');
  ic.innerHTML = I[ok ? 'check' : 'warning-circle'] || '';
  t.classList.toggle('bad', !ok);
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}

let copyTimer;
async function copyImage() {
  const btn = $('copyImage');
  const label = btn.querySelector('.label');
  btn.classList.remove('copied', 'failed');
  void btn.offsetWidth; // restart the animation on repeated copies
  try {
    const blob = await exportBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    btn.classList.add('copied');
    label.textContent = 'Copied';
    toast('Image copied. Paste it anywhere.');
  } catch {
    btn.classList.add('failed');
    label.textContent = "Couldn't copy";
    toast("Couldn't copy the image. Try Download instead.", false);
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    btn.classList.remove('copied', 'failed');
    label.textContent = 'Copy image';
  }, 1800);
}
$('copyImage').addEventListener('click', copyImage);

$('download').addEventListener('click', async (e) => {
  if ($('download').dataset.ready) return;
  e.preventDefault();
  const url = URL.createObjectURL(await exportBlob());
  const a = $('download');
  a.href = url;
  a.download = `${($('title').value || 'screenshot').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'screenshot'}.png`;
  a.dataset.ready = '1';
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    delete a.dataset.ready;
  }, 1000);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- autosave
// A new capture is saved the moment the editor opens, so it is always in Recordings even if
// this tab is closed. Every change (marks, title, description) saves again a moment later.

let server = null; // { url, auth }
let rid = null; // the screenshot's id on the server
let viewerUrl = null;
let shareUrl = null;
let saveTimer = null;
let saving = null; // promise of the save in progress
let dirty = false;

async function settings() {
  const { settings: s } = await chrome.storage.local.get('settings');
  return { serverUrl: 'http://localhost:4800', uploadToken: '', reporterName: '', captureLocation: true, ...(s || {}) };
}

async function call(method, pathPart, body, headers = {}) {
  let res;
  try {
    res = await fetch(`${server.url}${pathPart}`, { method, body, headers: { ...server.auth, ...headers } });
  } catch {
    throw new Error(`Can't reach the server (${server.url}). Is it running?`);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Server answered ${res.status}`);
  return out;
}

function setState(state, text) {
  $('saveState').dataset.state = state;
  $('saveText').textContent = text;
}

const kindNow = () => document.querySelector('[data-kind].on')?.dataset.kind || 'bug';

/** Save the image (with marks), the marks themselves, and the details. */
async function saveNow({ publishNow = false } = {}) {
  if (!rid) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) {
    dirty = true;
    return saving;
  }
  dirty = false;
  setState('saving', 'Saving…');
  showError('');
  saving = (async () => {
    try {
      await call('PUT', `/api/recordings/${rid}/image`, await exportBlob(), { 'Content-Type': 'image/png' });
      await call('PUT', `/api/recordings/${rid}/annotations`, JSON.stringify({ shapes }), { 'Content-Type': 'application/json' });
      // Title, description and type are edited in the panel on the right (saved by the server).
      await call('POST', `/api/recordings/${rid}/finalize-shot${publishNow ? '?now=1' : ''}`, JSON.stringify({
        width: canvas.width,
        height: canvas.height,
      }), { 'Content-Type': 'application/json' });
      setState('saved', 'All changes saved');
    } catch (err) {
      setState('error', "Couldn't save");
      showError(err.message, true);
    } finally {
      saving = null;
      if (dirty) scheduleSave();
    }
  })();
  return saving;
}

function scheduleSave() {
  if (!rid) return;
  setState('saving', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1200);
}

/** First save of a new capture: create it on the server and reserve its share link. */
async function createOnServer() {
  const s = await settings();
  const title = $('title').value.trim() || draft.meta.title || 'Screenshot';
  const created = await call('POST', '/api/recordings', JSON.stringify({ meta: { ...draft.meta, title, reporter: s.reporterName || undefined } }), { 'Content-Type': 'application/json' });
  rid = created.id;
  viewerUrl = created.viewerUrl;
  // Keep the unmarked capture so marks stay editable later (it never leaves this computer).
  await call('PUT', `/api/recordings/${rid}/original`, await (await fetch(draft.image)).blob(), { 'Content-Type': 'image/png' });
  await call('PUT', `/api/recordings/${rid}/image`, await exportBlob(), { 'Content-Type': 'image/png' });
  const env = await collectEnvironment({ captureLocation: s.captureLocation }).catch(() => ({}));
  await call('POST', `/api/recordings/${rid}/finalize-shot?now=1`, JSON.stringify({
    title,
    description: $('desc').value,
    kind: kindNow(),
    width: canvas.width,
    height: canvas.height,
    env,
  }), { 'Content-Type': 'application/json' });
  await chrome.storage.session.remove('snapDraft');
  // From now on this tab edits that screenshot (reloading keeps working).
  window.history.replaceState(null, '', `snap.html?id=${encodeURIComponent(rid)}`);
  chrome.runtime.sendMessage({ type: 'snap:saved', id: rid, viewerUrl, shareUrl: null, title }).catch(() => {});
}

/** The public link (reserved on Drive in the background); shown as soon as it exists. */
async function fetchLink() {
  const r = await chrome.runtime.sendMessage({ type: 'share:link', id: rid }).catch(() => null);
  const link = r?.result || { url: viewerUrl, isPublic: false };
  shareUrl = link.url;
  $('link').value = link.url;
  $('copyLink').disabled = false;
  $('open').disabled = false;
  $('ghIssue').disabled = false;
  $('linkNote').textContent = link.isPublic
    ? 'Anyone with the link can view it. Saved automatically, even if you close this tab.'
    : `Only you can open this link. ${link.error || 'Connect Google Drive in Settings to share.'}`;
  if (link.isPublic) chrome.runtime.sendMessage({ type: 'snap:saved', id: rid, viewerUrl, shareUrl: link.url, title: $('title').value }).catch(() => {});
}

// Marks changed → save. (pushHistory is called for every committed change.)
const basePush = pushHistory;
pushHistory = function () {
  basePush();
  scheduleSave();
};
$('title').addEventListener('input', scheduleSave);
$('desc').addEventListener('input', scheduleSave);
document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', scheduleSave));
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveNow({ publishNow: true });
});
$('retry').addEventListener('click', () => saveNow());

$('copyLink').addEventListener('click', async () => {
  const btn = $('copyLink');
  const label = btn.querySelector('span:last-child');
  // Make sure the latest marks are what people see.
  if (dirty || saveTimer || saving) saveNow({ publishNow: true });
  const ok = await copyText($('link').value);
  label.textContent = ok ? 'Copied' : "Couldn't copy";
  if (ok) toast('Link copied');
  setTimeout(() => (label.textContent = 'Copy link'), 1400);
});
$('open').addEventListener('click', async () => {
  if (!viewerUrl) return;
  await saveNow({ publishNow: true });
  chrome.runtime.sendMessage({ type: 'open:url', url: `${viewerUrl}#report` });
});
// ---- Create GitHub issue without leaving the editor: the player's issue window (AI report,
// labels, boards) is loaded from the BugSnap server in a transparent frame over this page.

function closeGhLayer() {
  const layer = $('ghLayer');
  if (layer.hidden || layer.classList.contains('closing')) return;
  layer.classList.add('closing');
  setTimeout(() => {
    layer.hidden = true;
    layer.classList.remove('closing', 'ready');
    layer.querySelector('iframe')?.remove();
    $('ghIssue').focus();
  }, 180);
}

$('ghIssue').addEventListener('click', async () => {
  if (!viewerUrl) return;
  const btn = $('ghIssue');
  btn.disabled = true;
  // The issue window reads the latest description, type and image from the server.
  await saveNow({ publishNow: true });
  btn.disabled = false;
  const layer = $('ghLayer');
  layer.querySelector('iframe')?.remove();
  const url = new URL(viewerUrl);
  url.searchParams.set('embed', 'github');
  const frame = document.createElement('iframe');
  frame.src = url.href;
  frame.title = 'Create GitHub issue';
  frame.allow = 'clipboard-write';
  layer.classList.remove('ready', 'closing');
  layer.hidden = false;
  layer.append(frame);
  // If the server does not answer, don't leave a spinner up forever.
  clearTimeout(closeGhLayer.timer);
  closeGhLayer.timer = setTimeout(() => {
    if (layer.hidden || layer.classList.contains('ready')) return;
    closeGhLayer();
    showError("Couldn't open the GitHub window. Is the BugSnap server running?");
  }, 15000);
});

// ---- Right side: "Create a [Link to share | GitHub issue]" from the BugSnap server (the player's
// panel). It asks this editor to save the latest marks before it creates anything.

const embedded = window.parent !== window || new URLSearchParams(location.search).has('embed');
if (embedded) document.documentElement.classList.add('embed');

function mountPanel() {
  if (!viewerUrl || $('panel').src) return;
  const url = new URL(viewerUrl);
  url.searchParams.set('embed', 'panel');
  $('panel').src = url.href;
  clearTimeout(mountPanel.timer);
  mountPanel.timer = setTimeout(() => {
    if (!$('panel').hidden) return;
    $('panelWait').hidden = true;
    showError("Couldn't load the share options. Is the BugSnap server running?");
  }, 15000);
}

/** Close the editor: remove the dialog from the page, or close this tab. Changes are saved first. */
/** Save until nothing is pending (a save that was running may have left newer changes). */
async function flushSaves() {
  for (let i = 0; i < 5 && (saveTimer || saving || dirty || i === 0); i++) await saveNow({ publishNow: true }).catch(() => {});
}

async function closeSnap() {
  if (saveTimer || saving || dirty) await flushSaves();
  if (window.parent !== window) return window.parent.postMessage({ source: 'bugsnap-overlay', type: 'close' }, '*');
  window.close();
}
$('closeSnap').addEventListener('click', closeSnap);

window.addEventListener('message', async (e) => {
  if (!server || e.origin !== new URL(server.url).origin) return;
  const m = e.data;
  if (!m || m.source !== 'bugsnap-embed') return;
  const fromPanel = e.source === $('panel').contentWindow;
  if (fromPanel) {
    const reply = (msg) => $('panel').contentWindow?.postMessage({ source: 'bugsnap-host', ...msg }, new URL(server.url).origin);
    if (m.type === 'ready') {
      clearTimeout(mountPanel.timer);
      $('panelWait').hidden = true;
      $('panel').hidden = false;
    } else if (m.type === 'error') {
      $('panelWait').hidden = true;
      showError(m.message || "Couldn't load the share options.");
    } else if (m.type === 'flush') {
      // Creating a link or issue: the server must have the latest marks first.
      await flushSaves();
      reply({ type: 'flushed' });
    } else if (m.type === 'details') {
      if (typeof m.title === 'string') {
        $('title').value = m.title;
        $('pageName').textContent = m.title;
      }
      if (typeof m.description === 'string') $('desc').value = m.description;
    } else if (m.type === 'open' && /^https?:\/\//.test(m.url || '')) {
      chrome.runtime.sendMessage({ type: 'open:url', url: m.url }).catch(() => {});
    } else if (m.type === 'created' && m.kind === 'link') {
      chrome.runtime.sendMessage({ type: 'snap:saved', id: rid, viewerUrl, shareUrl: m.url, title: $('title').value }).catch(() => {});
    } else if (m.type === 'created' && m.issue?.number) {
      toast(`Issue #${m.issue.number} created`);
    } else if (m.type === 'close') {
      closeSnap();
    }
    return;
  }
  // The older GitHub window (over the editor).
  if (m.type === 'ready') {
    $('ghLayer').classList.add('ready');
    $('ghLayer').querySelector('iframe')?.focus();
  }
  if (m.type === 'error') {
    closeGhLayer();
    showError(m.message || "Couldn't open the GitHub window.");
  }
  if (m.type === 'close') {
    closeGhLayer();
    if (m.issue?.number) toast(`Issue #${m.issue.number} created`);
  }
});

$('closeTab').addEventListener('click', async () => {
  if (saveTimer || saving) await saveNow({ publishNow: true });
  window.close();
});

window.addEventListener('beforeunload', (e) => {
  // Changes from the last second may still be on their way.
  if (saveTimer || saving) {
    saveNow();
    e.preventDefault();
  }
});

// ---------------------------------------------------------------- load

function fillMeta(meta) {
  let host = '';
  let pathName = '';
  try {
    const u = new URL(meta.startUrl);
    host = u.host;
    pathName = u.pathname;
  } catch {
    /* no URL */
  }
  $('pageName').textContent = meta.title || host;
  const rows = [
    ['Page', host + pathName],
    ['Size', `${canvas.width} × ${canvas.height}`],
    ['Viewport', meta.viewport ? `${meta.viewport.width} × ${meta.viewport.height}` : ''],
    ['Taken', new Date(meta.takenAt || meta.recordedAt || Date.now()).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })],
  ].filter(([, v]) => v);
  $('meta').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
}

function showEmpty(text) {
  $('wrap').hidden = true;
  $('empty').hidden = false;
  if (text) $('empty').querySelector('span:last-child').textContent = text;
  document.querySelector('.toolbar').hidden = true;
  setState('error', 'Nothing to edit');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    base.onload = resolve;
    base.onerror = () => reject(new Error('Could not load the image'));
    base.src = src;
  });
}

(async () => {
  const s = await settings();
  server = { url: s.serverUrl.replace(/\/$/, ''), auth: s.uploadToken ? { 'X-Upload-Token': s.uploadToken } : {} };
  await document.fonts.load(`600 20px ${FONT}`).catch(() => {});
  const editId = new URLSearchParams(location.search).get('id');

  try {
    if (editId) {
      // Editing a saved screenshot: original image + its marks, so everything stays editable.
      rid = editId;
      const rec = await call('GET', `/api/recordings/${encodeURIComponent(rid)}?events=0`);
      if (rec.type !== 'screenshot') throw new Error('This is not a screenshot.');
      viewerUrl = rec.viewerUrl;
      draft = { meta: rec.meta || {} };
      const imgRes = await fetch(`${server.url}/api/recordings/${rid}/original`, { headers: server.auth, cache: 'no-store' });
      if (!imgRes.ok) throw new Error('The original image is not on this server.');
      await loadImage(URL.createObjectURL(await imgRes.blob()));
      const ann = await call('GET', `/api/recordings/${rid}/annotations`).catch(() => ({ shapes: [] }));
      canvas.width = base.naturalWidth;
      canvas.height = base.naturalHeight;
      shapes = Array.isArray(ann.shapes) ? ann.shapes : [];
      history = [clone(shapes)];
      at = 0;
      $('title').value = rec.meta?.title || '';
      $('desc').value = rec.meta?.description || '';
      document.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === (rec.meta?.kind || 'bug')));
      render();
      updateHistory();
      fillMeta(draft.meta);
      setState('saved', 'All changes saved');
      fetchLink();
      mountPanel();
      return;
    }

    const { snapDraft } = await chrome.storage.session.get('snapDraft');
    if (!snapDraft) return showEmpty('Take one with the BugSnap panel or Alt+Shift+S. Saved ones can be edited from Recordings.');
    draft = snapDraft;
    await loadImage(draft.image);
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;
    render();
    updateHistory();
    fillMeta(draft.meta);
    $('title').value = draft.meta.title || '';
    $('desc').focus();
    // Save straight away so the capture is never lost.
    setState('saving', 'Saving…');
    await createOnServer();
    setState('saved', 'Saved');
    fetchLink();
    mountPanel();
    if (dirty || shapes.length) scheduleSave();
  } catch (err) {
    setState('error', "Couldn't save");
    $('panelWait').hidden = true;
    showError(err.message, !editId);
    if (editId && !base.naturalWidth) showEmpty(err.message);
  }
})();

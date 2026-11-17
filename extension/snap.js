// Screenshot editor: annotate the captured area (arrow, shapes, highlight, pen, text, numbered
// markers, blur), then save it to the BugSnap server, which shares it like a recording.
//
// Shapes (rectangle, ellipse, line, triangle, double arrow) share one toolbar button with a menu.
// Text is edited in place (click a selected text, double-click, or Enter) and has its own style
// bar: font size, bold, text colour and background (or none).
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
/** Light colours get dark text on top, everything else white. Works for any #rrggbb. */
function isLight(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(c || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170;
}
const onDark = (c) => !isLight(c);
const SHAPES = ['rect', 'ellipse', 'line', 'triangle', 'darrow'];
const LINEAR = ['arrow', 'line', 'darrow']; // two end points
const BOXED = ['rect', 'ellipse', 'triangle', 'highlight', 'blur']; // four corners
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

// Text marks: { text (may hold line breaks), x, y (centre of the first line), fontPx (image px),
// fg (text colour, or unset = automatic), bg (background, 'none', or unset = the mark colour), bold }.
// Older marks only have color + size; the helpers below give them their original look.
const fontPxOf = (s) => s.fontPx || Math.max(16, unit() * 8 * (s.size || 1));
const bgOf = (s) => (s.bg === undefined ? s.color : s.bg);
const fgOf = (s) => s.fg || (bgOf(s) === 'none' ? s.color : onDark(bgOf(s)) ? '#ffffff' : '#18181b');
const fontOf = (s, fs) => `${s.bold === false ? 500 : 700} ${fs}px ${FONT}`;

function textMetrics(s) {
  const fs = fontPxOf(s);
  const lines = String(s.text || '').split('\n');
  ctx.save();
  ctx.font = fontOf(s, fs);
  const tw = Math.max(fs * 0.5, ...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const padX = fs * 0.45;
  const padY = fs * 0.3;
  const lh = fs * 1.25;
  const top = s.y - (padY * 2 + lh) / 2;
  return { fs, lines, padX, padY, lh, box: { x: s.x, y: top, w: tw + padX * 2, h: padY * 2 + lh * lines.length } };
}
const textBox = (s) => textMetrics(s).box;

const numberRadius = (s) => Math.max(12, unit() * 5 * Math.sqrt(s.size || 1));

/** Handles a mark can be adjusted by (image coordinates). */
function handlesOf(s) {
  if (LINEAR.includes(s.type)) return [{ key: 'p1', x: s.x1, y: s.y1 }, { key: 'p2', x: s.x2, y: s.y2 }];
  if (BOXED.includes(s.type)) {
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
    if (LINEAR.includes(s.type) && distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tol + unit()) return i;
    if (s.type === 'ellipse') {
      const { x, y, w, h } = norm(s);
      const rx = Math.max(1, w / 2);
      const ry = Math.max(1, h / 2);
      const d = Math.hypot((p.x - x - rx) / rx, (p.y - y - ry) / ry);
      if (Math.abs(d - 1) * Math.min(rx, ry) <= tol + unit()) return i;
    }
    if (s.type === 'triangle') {
      const t = trianglePoints(s);
      if ([0, 1, 2].some((k) => distToSegment(p, t[k], t[(k + 1) % 3]) <= tol + unit())) return i;
    }
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

function trianglePoints(s) {
  const { x, y, w, h } = norm(s);
  return [{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }];
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
  for (const s of all) if (s.type !== 'blur' && !(editing && s === editing.shape)) drawShape(s);
  if (!clean && !editing && selected !== null && shapes[selected]) drawSelection(shapes[selected]);
  if (!clean) updateTextBar();
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
  if (LINEAR.includes(s.type)) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 2) return ctx.restore();
    const lw = u * 1.6 * k;
    const head = s.type === 'line' ? 0 : Math.min(len * (s.type === 'darrow' ? 0.35 : 0.5), lw * 3.6 + u * 2);
    const ang = Math.atan2(dy, dx);
    const tip = (x, y, a) => {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - head * Math.cos(a - Math.PI / 7), y - head * Math.sin(a - Math.PI / 7));
      ctx.lineTo(x - head * Math.cos(a + Math.PI / 7), y - head * Math.sin(a + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    };
    ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
    ctx.shadowBlur = u * 1.5;
    ctx.lineWidth = lw;
    const back = head * 0.6;
    const startBack = s.type === 'darrow' ? back : 0;
    ctx.beginPath();
    ctx.moveTo(s.x1 + Math.cos(ang) * startBack, s.y1 + Math.sin(ang) * startBack);
    ctx.lineTo(s.x2 - Math.cos(ang) * back, s.y2 - Math.sin(ang) * back);
    ctx.stroke();
    if (head) tip(s.x2, s.y2, ang);
    if (head && s.type === 'darrow') tip(s.x1, s.y1, ang + Math.PI);
  } else if (s.type === 'ellipse' || s.type === 'triangle') {
    const { x, y, w, h } = norm(s);
    ctx.lineWidth = u * 1.4 * k;
    ctx.shadowColor = 'rgb(0 0 0 / 0.2)';
    ctx.shadowBlur = u;
    ctx.beginPath();
    if (s.type === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
    else {
      const [a, b, c] = trianglePoints(s);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
    }
    ctx.stroke();
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
    const m = textMetrics(s);
    const bg = bgOf(s);
    const fg = fgOf(s);
    ctx.font = fontOf(s, m.fs);
    if (bg !== 'none') {
      ctx.fillStyle = bg;
      ctx.shadowColor = 'rgb(0 0 0 / 0.2)';
      ctx.shadowBlur = u * 2;
      ctx.beginPath();
      ctx.roundRect(m.box.x, m.box.y, m.box.w, m.box.h, m.fs * 0.3);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // No background: a soft halo keeps the text readable on any screenshot.
      ctx.lineWidth = Math.max(2, m.fs * 0.16);
      ctx.strokeStyle = isLight(fg) ? 'rgb(0 0 0 / 0.55)' : 'rgb(255 255 255 / 0.9)';
    }
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    m.lines.forEach((line, i) => {
      const ty = m.box.y + m.padY + m.lh * (i + 0.5) + m.fs * 0.04;
      if (bg === 'none') ctx.strokeText(line, s.x + m.padX, ty);
      ctx.fillText(line, s.x + m.padX, ty);
    });
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
  if (!LINEAR.includes(s.type)) ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
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
    const s = shapes[i];
    paintColor(s.type === 'text' ? (bgOf(s) !== 'none' ? bgOf(s) : fgOf(s)) : s.color);
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
    // A text that is already selected, or any text with the Text tool: edit it on release.
    const editOnClick = shapes[hit].type === 'text' && (hit === selected || tool === 'text');
    canvas.setPointerCapture(e.pointerId);
    select(hit);
    action = { kind: 'move', last: p, changed: false, editOnClick };
    canvas.classList.add('dragging');
    return;
  }
  // 3. Empty space: draw with the current tool.
  select(null);
  if (tool === 'text') return startText(p);
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
  } else if (a.editOnClick && selected !== null) {
    startText(null, selected);
  }
  updateTextBar();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('dblclick', (e) => {
  const hit = hitTest(toImage(e));
  if (hit !== -1 && shapes[hit].type === 'text' && !editing) startText(null, hit);
});

// ---------------------------------------------------------------- text editing

const FS_STEPS = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96];
const SWATCHES = ['#e5484d', '#f5a524', '#16a34a', '#2563eb', '#8e4ec6', '#18181b', '#71717a', '#ffffff'];
const SWATCH_NAMES = ['Red', 'Amber', 'Green', 'Blue', 'Purple', 'Black', 'Grey', 'White'];
// Font sizes are shown in page pixels (a 2x screen captures twice the pixels).
const pageScale = () => draft?.meta?.scale || 1;
let editing = null; // { index (null for a new text), shape, before }
let lastTextStyle = null; // new texts start with the style used last

/** The text box on screen (CSS px) for a text mark. */
function screenBox(s) {
  const r = canvas.getBoundingClientRect();
  const k = px();
  const m = textMetrics(s);
  return { left: r.left + m.box.x / k, top: r.top + m.box.y / k, width: m.box.w / k, height: m.box.h / k, m, k };
}

/** Lay the textarea exactly over the text, same font, size and colours, so editing looks like the result. */
function placeEditor() {
  if (!editing) return;
  const s = editing.shape;
  const input = $('textInput');
  const { left, top, m, k } = screenBox({ ...s, text: input.value || ' ' });
  const bg = bgOf(s);
  const fg = fgOf(s);
  Object.assign(input.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${(m.box.w + m.fs) / k}px`,
    height: `${m.box.h / k}px`,
    font: fontOf(s, m.fs / k),
    lineHeight: `${m.lh / k}px`,
    padding: `${m.padY / k}px ${m.padX / k}px`,
    borderRadius: `${(m.fs * 0.3) / k}px`,
    color: fg,
    background: bg === 'none' ? 'transparent' : bg,
    textShadow: bg === 'none' ? `0 0 ${Math.max(2, m.fs * 0.08) / k}px ${isLight(fg) ? 'rgb(0 0 0 / .8)' : '#fff'}` : 'none',
  });
}

/** Start editing a text: `editIndex` for an existing one, or a new text at image point `p`. */
function startText(p, editIndex = null) {
  if (editing) return;
  const input = $('textInput');
  const shape =
    editIndex !== null
      ? shapes[editIndex]
      : { type: 'text', x: p.x, y: p.y, text: '', color, size, fontPx: fontPxOf({ size }), bold: true, bg: color, ...(lastTextStyle || {}) };
  editing = { index: editIndex, shape, before: clone(shape) };
  selected = editIndex;
  input.value = shape.text || '';
  input.hidden = false;
  placeEditor();
  render();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function finishText(keep) {
  if (!editing) return;
  const { index, shape, before } = editing;
  const input = $('textInput');
  const text = input.value.replace(/\s+$/, '');
  editing = null;
  input.hidden = true;
  closeSwatches();
  if (index === null) {
    if (keep && text.trim()) {
      shapes.push({ ...shape, text });
      pushHistory();
      select(shapes.length - 1);
    } else render();
    return;
  }
  if (!keep) {
    // Esc: drop the style changes made while editing too.
    for (const key of Object.keys(shape)) if (!(key in before)) delete shape[key];
    Object.assign(shape, before);
    return select(index);
  }
  if (!text.trim()) {
    selected = index;
    return removeSelected();
  }
  shape.text = text;
  if (JSON.stringify(shape) !== JSON.stringify(before)) pushHistory();
  select(index);
}

$('textInput').addEventListener('input', placeEditor);
$('textInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    finishText(true); // Shift+Enter adds a line
  } else if (e.key === 'Escape') {
    e.preventDefault();
    finishText(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    styleText({ bold: textTarget().bold === false });
  }
});
// Clicking the style bar keeps the text in edit mode; clicking anywhere else finishes it.
$('textInput').addEventListener('blur', (e) => {
  if ($('textBar').contains(e.relatedTarget)) return;
  setTimeout(() => {
    if (editing && document.activeElement !== $('textInput') && !$('textBar').contains(document.activeElement)) finishText(true);
  }, 0);
});

/** The text the style bar acts on: the one being edited, else the selected one. */
function textTarget() {
  if (editing) return editing.shape;
  const s = selected !== null ? shapes[selected] : null;
  return s && s.type === 'text' ? s : null;
}

function styleText(patch) {
  const s = textTarget();
  if (!s) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete s[key];
    else s[key] = value;
  }
  if (s.bg && s.bg !== 'none') s.color = s.bg; // keep the old field meaningful
  lastTextStyle = { bg: bgOf(s), bold: s.bold !== false, fontPx: s.fontPx, ...(s.fg ? { fg: s.fg } : {}) };
  if (editing) {
    placeEditor();
    render();
    $('textInput').focus();
  } else {
    pushHistory();
    render();
  }
}

function stepFont(dir) {
  const s = textTarget();
  if (!s) return;
  const scale = pageScale();
  const now = fontPxOf(s) / scale;
  const next = dir > 0 ? FS_STEPS.find((v) => v > now + 0.5) || FS_STEPS.at(-1) : [...FS_STEPS].reverse().find((v) => v < now - 0.5) || FS_STEPS[0];
  styleText({ fontPx: Math.round(next * scale) });
}

function updateTextBar() {
  const bar = $('textBar');
  const s = textTarget();
  if (!s || (action && !editing)) {
    bar.hidden = true;
    closeSwatches();
    return;
  }
  bar.hidden = false;
  $('fsVal').textContent = Math.round(fontPxOf(s) / pageScale());
  $('boldBtn').setAttribute('aria-pressed', String(s.bold !== false));
  $('fgChip').style.setProperty('--c', fgOf(s));
  const bg = bgOf(s);
  $('bgChip').classList.toggle('none', bg === 'none');
  $('bgChip').style.setProperty('--c', bg === 'none' ? 'transparent' : bg);
  $('textEdit').hidden = !!editing;
  // Above the text, or below it when there is no room; always inside the window.
  const box = screenBox(editing ? { ...s, text: $('textInput').value || ' ' } : s);
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  let top = box.top - bh - 12;
  if (top < 8) top = box.top + box.height + 12;
  const left = Math.max(8, Math.min(innerWidth - bw - 8, box.left));
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.min(innerHeight - bh - 8, top)}px`;
}

let swatchFor = null;
function closeSwatches() {
  $('swatches').hidden = true;
  swatchFor = null;
}
function openSwatches(kind, anchor) {
  if (swatchFor === kind) return closeSwatches();
  const s = textTarget();
  if (!s) return;
  swatchFor = kind;
  const current = String(kind === 'fg' ? fgOf(s) : bgOf(s)).toLowerCase();
  const box = $('swatches');
  box.replaceChildren();
  const add = (value, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw';
    b.dataset.tip = label;
    b.setAttribute('aria-label', label);
    if (value === 'none') {
      b.classList.add('none');
      b.innerHTML = `<span class="icon">${I.prohibit || ''}</span>`;
    } else b.style.setProperty('--c', value);
    b.classList.toggle('on', current === value);
    b.addEventListener('click', () => {
      styleText(kind === 'fg' ? { fg: value } : { bg: value });
      closeSwatches();
    });
    box.append(b);
  };
  SWATCHES.forEach((c, i) => add(c, SWATCH_NAMES[i]));
  if (kind === 'bg') add('none', 'No background');
  // Any other colour.
  const custom = document.createElement('label');
  custom.className = 'sw';
  custom.dataset.tip = 'Custom colour';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.setAttribute('aria-label', 'Custom colour');
  picker.value = /^#[0-9a-f]{6}$/.test(current) ? current : '#e5484d';
  picker.addEventListener('input', () => styleText(kind === 'fg' ? { fg: picker.value } : { bg: picker.value }));
  picker.addEventListener('change', closeSwatches);
  custom.append(picker);
  box.append(custom);
  box.hidden = false;
  box.style.left = `${Math.max(0, anchor.offsetLeft - 8)}px`;
}

// Buttons in the bar must not take focus away from the text being edited.
$('textBar').addEventListener('mousedown', (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
});
$('fsDown').addEventListener('click', () => stepFont(-1));
$('fsUp').addEventListener('click', () => stepFont(1));
$('boldBtn').addEventListener('click', () => textTarget() && styleText({ bold: textTarget().bold === false }));
$('fgBtn').addEventListener('click', () => openSwatches('fg', $('fgBtn')));
$('bgBtn').addEventListener('click', () => openSwatches('bg', $('bgBtn')));
$('textEdit').addEventListener('click', () => selected !== null && startText(null, selected));
$('textDel').addEventListener('click', () => {
  if (editing) {
    const i = editing.index;
    finishText(false);
    if (i === null) return;
    selected = i;
  }
  removeSelected();
});
addEventListener('resize', () => {
  placeEditor();
  updateTextBar();
});
$('stage').addEventListener('scroll', () => {
  placeEditor();
  updateTextBar();
});

// ---------------------------------------------------------------- toolbar

const SHAPE_ICONS = { rect: 'square', ellipse: 'circle', line: 'line-segment', triangle: 'triangle', darrow: 'arrows-left-right' };
const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', triangle: 'Triangle', darrow: 'Double arrow' };
let lastShape = 'rect';

function setTool(name) {
  tool = name;
  if (SHAPES.includes(name)) {
    // The shapes button shows (and stands for) the shape picked last.
    lastShape = name;
    $('shapeBtn').dataset.tool = name;
    $('shapeBtn').dataset.tip = `${SHAPE_NAMES[name]} · click again for more shapes`;
    $('shapeIcon').innerHTML = I[SHAPE_ICONS[name]] || '';
    document.querySelectorAll('[data-shape]').forEach((b) => {
      b.classList.toggle('on', b.dataset.shape === name);
      b.setAttribute('aria-checked', String(b.dataset.shape === name));
    });
  }
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
  canvas.classList.toggle('text-mode', name === 'text');
}

function toggleShapeMenu(open = $('shapeMenu').hidden) {
  $('shapeMenu').hidden = !open;
  $('shapeBtn').setAttribute('aria-expanded', String(open));
}
$('shapeBtn').addEventListener('click', (e) => {
  // First click picks the shape tool; clicking it again (or the little arrow) opens the menu.
  const onCaret = !!e.target.closest('.caret');
  if (!SHAPES.includes(tool)) {
    setTool(lastShape);
    if (!onCaret) return;
  }
  toggleShapeMenu();
});
document.querySelectorAll('[data-shape]').forEach((b) =>
  b.addEventListener('click', () => {
    setTool(b.dataset.shape);
    toggleShapeMenu(false);
  }),
);
document.addEventListener('pointerdown', (e) => {
  if (!$('shapePick').contains(e.target)) toggleShapeMenu(false);
  if (!$('textBar').contains(e.target)) closeSwatches();
});

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
    // A text takes it as its background (or as the text colour when it has no background).
    const t = textTarget();
    if (t) return styleText(bgOf(t) === 'none' ? { fg: color } : { bg: color, fg: undefined });
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
  if (textTarget()) return stepFont(dir);
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

const KEYS = { a: 'arrow', r: 'rect', e: 'ellipse', l: 'line', g: 'triangle', d: 'darrow', h: 'highlight', p: 'pen', t: 'text', n: 'number', b: 'blur' };
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
  } else if (e.key === 'Enter' && textTarget()) {
    e.preventDefault();
    startText(null, selected);
  } else if (mod && k === 'b' && textTarget()) {
    e.preventDefault();
    styleText({ bold: textTarget().bold === false });
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
  url.searchParams.set('theme', window.BugSnapTheme?.pref || 'system');
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
  url.searchParams.set('theme', window.BugSnapTheme?.pref || 'system');
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
    } else if (m.type === 'settings') {
      chrome.runtime.sendMessage({ type: 'settings:open', section: m.section }).catch(() => {});
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

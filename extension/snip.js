// Area selection for screenshots. Injected after the visible tab has been captured, so this
// layer never appears in the image. Drag to select; Enter (or the button) takes the whole view;
// Esc cancels. Reports the rectangle in CSS pixels to the background, which crops the capture.
(() => {
  if (window.__bugsnapSnip) return;
  window.__bugsnapSnip = true;

  const host = document.createElement('div');
  host.id = '__bugsnap_snip__';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgb(15 15 18 / .32); animation: in .15s ease-out; }
      .layer.dragging { background: transparent; }
      @keyframes in { from { opacity: 0; } }
      .sel { position: fixed; display: none; border: 2px solid #fff; border-radius: 4px; box-shadow: 0 0 0 9999px rgb(15 15 18 / .38), 0 0 0 1px rgb(0 0 0 / .35); pointer-events: none; }
      .size { position: absolute; right: -2px; bottom: -28px; padding: 4px 7px; border-radius: 6px; background: #18181b; color: #fff; font: 600 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .hint {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px;
        padding: 6px 6px 6px 14px; border-radius: 12px; background: rgb(24 24 27 / .96); color: #fafafa;
        font: 600 13.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; box-shadow: 0 10px 30px rgb(0 0 0 / .3);
        cursor: default; user-select: none; animation: drop .2s cubic-bezier(.16,1,.3,1);
      }
      @keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }
      .hint span { color: rgb(255 255 255 / .65); font-weight: 500; margin-right: 6px; }
      button { all: unset; cursor: pointer; height: 32px; padding: 0 12px; border-radius: 8px; font: inherit; color: #fafafa; }
      button:hover { background: rgb(255 255 255 / .12); }
      button.primary { background: #fafafa; color: #18181b; }
      button.primary:hover { background: #fff; }
      .layer.dragging ~ .hint { opacity: 0; pointer-events: none; }
    </style>
    <div class="layer"></div>
    <div class="sel"><div class="size"></div></div>
    <div class="hint"><span>Drag to select an area</span><button class="primary" data-act="full">Whole page</button><button data-act="cancel">Cancel</button></div>`;
  (document.body || document.documentElement).append(host);

  const layer = root.querySelector('.layer');
  const sel = root.querySelector('.sel');
  const size = root.querySelector('.size');
  let start = null;
  let rect = null;

  function finish(message) {
    window.__bugsnapSnip = false;
    removeEventListener('keydown', onKey, true);
    host.remove();
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }
  const whole = () => finish({ type: 'snip:done', rect: { x: 0, y: 0, w: innerWidth, h: innerHeight }, vw: innerWidth, vh: innerHeight });
  const cancel = () => finish({ type: 'snip:cancel' });

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      whole();
    }
  }
  addEventListener('keydown', onKey, true);

  root.querySelector('[data-act="full"]').addEventListener('click', whole);
  root.querySelector('[data-act="cancel"]').addEventListener('click', cancel);

  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
  });
  layer.addEventListener('pointermove', (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    if (w < 3 && h < 3) return;
    rect = { x, y, w, h };
    layer.classList.add('dragging');
    Object.assign(sel.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  });
  layer.addEventListener('pointerup', () => {
    const r = rect;
    start = null;
    rect = null;
    if (!r || r.w < 8 || r.h < 8) {
      // A click without a drag: start over.
      layer.classList.remove('dragging');
      sel.style.display = 'none';
      return;
    }
    finish({ type: 'snip:done', rect: r, vw: innerWidth, vh: innerHeight });
  });
})();

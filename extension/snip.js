// Capture bar (like the Windows Snipping Tool): one bar at the top of the page to take a screenshot
// or start a recording, of a dragged area or the whole page.
//
// Injected by background.js after the visible tab has been captured, so nothing of ours is in the
// screenshot. In screenshot mode that capture is shown frozen under the selection, so what you see
// is exactly what you get even if the page changes underneath.
//
// The page must not notice the layer: a click "outside" a modal or a focus change would otherwise
// close the modal on screen. All pointer, mouse, touch, wheel and hover events aimed at the layer are
// caught on window in the capture phase (before page listeners) and stopped there.
(() => {
  if (window.__bugsnapSnip) return;
  window.__bugsnapSnip = true;

  const I = globalThis.ScreenRecIcons || {};
  const AREA_SVG =
    '<svg aria-hidden="true" viewBox="0 0 256 256"><path fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" d="M40 80V56a16 16 0 0 1 16-16h24M112 40h32M176 40h24a16 16 0 0 1 16 16v24M216 112v32M216 176v24a16 16 0 0 1-16 16h-24M144 216h-32M80 216H56a16 16 0 0 1-16-16v-24M40 144v-32"/></svg>';

  let mode = window.__bugsnapSnipMode === 'rec' ? 'rec' : 'shot';
  let recBusy = false; // a recording is already running: only screenshots

  const host = document.createElement('div');
  host.id = '__bugsnap_snip__';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      /* One layer above everything on the page, sticky navbars included. */
      :host { all: initial; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important; }
      * { box-sizing: border-box; }
      /* touch-action: in DevTools mobile view the mouse acts as a finger; without this a drag scrolls the page. */
      .layer { position: fixed; inset: 0; cursor: crosshair; touch-action: none; }
      canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; display: none; pointer-events: none; }
      .shot canvas.ready { display: block; }
      .dim { position: fixed; inset: 0; background: rgb(15 15 18 / .34); pointer-events: none; animation: in .15s ease-out; }
      .dragging .dim { display: none; }
      @keyframes in { from { opacity: 0; } }
      .sel { position: fixed; display: none; border: 2px solid #fff; border-radius: 4px; box-shadow: 0 0 0 9999px rgb(15 15 18 / .4), 0 0 0 1px rgb(0 0 0 / .35); pointer-events: none; }
      .rec .sel { border-color: #f2555a; }
      .size { position: absolute; right: -2px; bottom: -28px; padding: 4px 7px; border-radius: 6px; background: #18181b; color: #fff; font: 600 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }

      .bar {
        position: fixed; z-index: 2; top: 14px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 2px; height: 48px; padding: 0 6px;
        border-radius: 14px; background: rgb(24 24 27 / .96); border: 1px solid rgb(255 255 255 / .08);
        box-shadow: 0 12px 32px rgb(0 0 0 / .3), 0 2px 6px rgb(0 0 0 / .18);
        font: 600 13px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #fafafa;
        cursor: default; user-select: none; animation: drop .2s cubic-bezier(.16,1,.3,1);
      }
      @keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }
      .dragging .bar { opacity: 0; pointer-events: none; }
      .seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: rgb(255 255 255 / .07); }
      .sep { width: 1px; height: 20px; background: rgb(255 255 255 / .14); margin: 0 4px; }
      button {
        all: unset; position: relative; box-sizing: border-box; cursor: pointer; width: 36px; height: 36px;
        display: grid; place-items: center; border-radius: 10px; color: rgb(255 255 255 / .82);
        transition: background .15s ease, color .15s ease;
      }
      .seg button { width: 34px; height: 30px; border-radius: 8px; }
      button svg { width: 19px; height: 19px; fill: currentColor; }
      button:hover { background: rgb(255 255 255 / .1); color: #fff; }
      button.on { background: #fafafa; color: #18181b; }
      .rec .seg button.on { background: #f2555a; color: #fff; }
      button.mark { color: #fff; background: rgb(255 255 255 / .1); cursor: default; }
      button[hidden] { display: none; }
      button:disabled { opacity: .35; cursor: default; }
      button:disabled:hover { background: none; }
      /* Tooltips under the bar. */
      button .tip {
        position: absolute; top: calc(100% + 12px); left: 50%; transform: translateX(-50%);
        display: flex; gap: 8px; align-items: center; padding: 6px 9px; border-radius: 8px;
        background: #18181b; color: #fff; white-space: nowrap; font-size: 12.5px; font-weight: 500;
        box-shadow: 0 6px 18px rgb(0 0 0 / .25); pointer-events: none; opacity: 0; transition: opacity .12s ease;
      }
      button:hover .tip { opacity: 1; transition-delay: .25s; }
      .tip .k { font-size: 11px; font-weight: 600; padding: 3px 5px; border-radius: 5px; background: rgb(255 255 255 / .14); color: rgb(255 255 255 / .85); }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    </style>
    <div class="wrap">
      <canvas></canvas>
      <div class="layer"></div>
      <div class="dim"></div>
      <div class="sel"><div class="size"></div></div>
      <div class="bar" role="toolbar" aria-label="Capture">
        <div class="seg">
          <button data-act="shot" aria-label="Screenshot"></button>
          <button data-act="rec" aria-label="Record"></button>
        </div>
        <span class="sep"></span>
        <button data-act="area" class="mark" aria-label="Drag to select an area"></button>
        <button data-act="full" aria-label="Whole page"></button>
        <button data-act="screen" aria-label="Screen or window"></button>
        <span class="sep"></span>
        <button data-act="cancel" aria-label="Cancel"></button>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const wrap = $('.wrap');
  const canvas = $('canvas');
  const sel = $('.sel');
  const size = $('.size');
  const btn = (act) => $(`[data-act="${act}"]`);

  function setButton(act, iconSvg, tip, kbd) {
    const b = btn(act);
    b.innerHTML = iconSvg || '';
    const t = document.createElement('span');
    t.className = 'tip';
    t.textContent = tip;
    if (kbd) {
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = kbd;
      t.append(k);
    }
    b.append(t);
    b.setAttribute('aria-label', tip);
  }

  function applyMode() {
    wrap.classList.toggle('shot', mode === 'shot');
    wrap.classList.toggle('rec', mode === 'rec');
    btn('shot').classList.toggle('on', mode === 'shot');
    btn('rec').classList.toggle('on', mode === 'rec');
    btn('rec').disabled = recBusy;
    setButton('shot', I.camera, 'Screenshot', 'S');
    setButton('rec', I['video-camera'], recBusy ? 'Already recording' : 'Record', recBusy ? '' : 'R');
    setButton('area', AREA_SVG, mode === 'shot' ? 'Drag to select an area' : 'Drag to select an area to record');
    setButton('full', mode === 'shot' ? I['corners-out'] : I.browser, mode === 'shot' ? 'Whole page' : 'Record this tab', 'Enter');
    setButton('screen', I.monitor, 'Record screen or window');
    btn('screen').hidden = mode !== 'rec';
    setButton('cancel', I.x, 'Cancel', 'Esc');
  }
  applyMode();
  (document.body || document.documentElement).append(host);

  // The frozen capture. Drawn on a canvas so the page's Content Security Policy (img-src) can't block it.
  (async () => {
    try {
      const [{ snapPending }, { rec }] = await Promise.all([chrome.storage.session.get('snapPending'), chrome.storage.session.get('rec')]);
      if (rec) {
        recBusy = true;
        if (mode === 'rec') mode = 'shot';
        applyMode();
      }
      const url = snapPending?.image;
      if (!url || !window.__bugsnapSnip) return;
      const bin = atob(url.slice(url.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      canvas.classList.add('ready');
    } catch {
      /* no frozen view: the live page shows instead */
    }
  })();

  let start = null;
  let rect = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }

  function finish(message) {
    window.__bugsnapSnip = false;
    for (const [type, fn, opts] of LISTENERS) removeEventListener(type, fn, opts);
    host.remove();
    if (message) send(message);
  }

  const view = () => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1 });
  function take(r) {
    if (mode === 'shot') finish({ type: 'snip:done', rect: r, ...view() });
    else finish({ type: 'snip:record', target: 'tab', rect: r.w >= innerWidth - 1 && r.h >= innerHeight - 1 ? null : r, ...view() });
  }
  const whole = () => take({ x: 0, y: 0, w: innerWidth, h: innerHeight });
  const cancel = () => finish({ type: 'snip:cancel' });

  function act(name) {
    if (name === 'shot' || (name === 'rec' && !recBusy)) {
      mode = name;
      applyMode();
    } else if (name === 'full') whole();
    else if (name === 'screen' && mode === 'rec') finish({ type: 'snip:record', target: 'desktop' });
    else if (name === 'cancel') cancel();
  }

  function resetDrag() {
    start = null;
    rect = null;
    wrap.classList.remove('dragging');
    sel.style.display = 'none';
  }

  /** Is this event aimed at our layer? (Closed shadow root: from window, the target is the host.) */
  const ours = (e) => e.target === host;
  const swallow = (e) => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };
  const onBar = (e) => root.elementFromPoint(e.clientX, e.clientY)?.closest('.bar');

  function onPointerDown(e) {
    if (!ours(e)) return;
    swallow(e); // no focus change, no "click outside", no text selection
    if (e.button !== 0 || onBar(e)) return;
    start = { x: e.clientX, y: e.clientY };
  }
  function onPointerMove(e) {
    if (!start) return;
    swallow(e);
    const x = Math.max(0, Math.min(start.x, e.clientX));
    const y = Math.max(0, Math.min(start.y, e.clientY));
    const w = Math.min(innerWidth, Math.max(start.x, e.clientX)) - x;
    const h = Math.min(innerHeight, Math.max(start.y, e.clientY)) - y;
    if (w < 3 && h < 3) return;
    rect = { x, y, w, h };
    wrap.classList.add('dragging');
    Object.assign(sel.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }
  function onPointerUp(e) {
    if (!ours(e) && !start) return;
    swallow(e);
    const r = rect;
    const dragging = !!start;
    resetDrag();
    if (!dragging) return;
    // A click without a drag: start over.
    if (r && r.w >= 8 && r.h >= 8) take(r);
  }
  function onClick(e) {
    if (!ours(e)) return;
    swallow(e);
    const b = root.elementFromPoint(e.clientX, e.clientY)?.closest('button');
    if (b && !b.disabled) act(b.dataset.act);
  }
  // Everything else aimed at the layer stays with us. Hover changes too, so menus that open
  // on hover don't close because the pointer is now "over" our layer.
  const block = (e) => {
    if (ours(e) || e.relatedTarget === host) swallow(e);
  };
  function onKey(e) {
    const k = e.key;
    if (k === 'Escape') cancel();
    else if (k === 'Enter') whole();
    else if (k === 's' || k === 'S') act('shot');
    else if (k === 'r' || k === 'R') act('rec');
    else return;
    swallow(e);
  }

  const capture = { capture: true, passive: false };
  const LISTENERS = [
    ['pointerdown', onPointerDown, capture],
    ['pointermove', onPointerMove, capture],
    ['pointerup', onPointerUp, capture],
    ['pointercancel', (e) => start && (swallow(e), resetDrag()), capture],
    ['click', onClick, capture],
    ['keydown', onKey, capture],
    ...['mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'wheel',
      'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'mousemove']
      .map((type) => [type, block, capture]),
  ];
  for (const [type, fn, opts] of LISTENERS) addEventListener(type, fn, opts);
})();

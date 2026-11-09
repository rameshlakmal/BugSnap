// Floating recording controls, bottom-centre of the page.
// Lives in a closed shadow root so page CSS cannot touch it and page scripts cannot read it.
// One pill for the whole flow: Starting… → 3-2-1 → timer with stop/pause/discard → Saving…
(() => {
  // A fresh copy (after an extension reload) replaces the orphaned one.
  const REPLACED = '__screenrec_overlay_replaced__';
  window.dispatchEvent(new CustomEvent(REPLACED));
  let retired = false;
  window.addEventListener(REPLACED, () => {
    retired = true;
    destroy();
    try {
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      /* context already invalid */
    }
  }, { once: true });

  const HOST_ID = 'screenrec-overlay-host';
  const I = globalThis.ScreenRecIcons || {};
  const icon = (name) => I[name] || '';

  let rec = null;
  let myTabId = null;
  let host, root, els;
  let tick;
  let collapsed = false;
  let offset = { x: 0, y: 0 };
  let confirmTimer;
  let toast = null; // { message, until }
  let saved = null; // { entry, until, copied } after a recording is saved
  let savedHover = false;

  const control = (action) => {
    try {
      chrome.runtime.sendMessage({ type: 'control', action }).catch(() => {});
    } catch {
      destroy(); // extension was reloaded; this copy is orphaned
    }
  };

  function visibleFor(r) {
    if (toast && toast.until > Date.now()) return true;
    if (saved && (saved.until > Date.now() || savedHover) && !isActive(r)) return true;
    if (!r || myTabId === null) return false;
    const mine = r.mode === 'desktop' || r.tabId === myTabId;
    if (!mine) return false;
    // While a screen recording waits on Chrome's picker there is nothing to show yet.
    if (r.status === 'starting') return r.mode === 'tab';
    return ['countdown', 'recording', 'paused', 'stopping'].includes(r.status);
  }

  const isActive = (r) => r && ['starting', 'countdown', 'recording', 'paused', 'stopping'].includes(r.status);

  function elapsedMs(r) {
    if (!r.startedAt) return 0;
    const end = r.status === 'paused' && r.pausedAt ? r.pausedAt : Date.now();
    return Math.max(0, end - r.startedAt - (r.pausedMs || 0));
  }

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; left: 50%; bottom: 24px; z-index: 2147483647;
      transform: translate(calc(-50% + var(--dx, 0px)), var(--dy, 0px));
      font: 600 13.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #fafafa; -webkit-font-smoothing: antialiased;
    }
    .wrap.leaving .bar { animation: leave .16s ease-in forwards; }
    @keyframes leave { to { opacity: 0; transform: translateY(8px) scale(.97); } }
    .ok { color: #4ade80; display: inline-grid; }
    .ok svg { width: 18px; height: 18px; fill: currentColor; }
    .saved .label { padding: 0 6px 0 4px; }
    .linkbtn { background: #fafafa; color: #18181b; padding: 0 12px; }
    .linkbtn:hover { background: #fff; }
    .bar {
      position: relative; display: flex; align-items: center; gap: 2px; height: 48px; padding: 0 6px;
      border-radius: 14px; background: rgb(24 24 27 / .96);
      border: 1px solid rgb(255 255 255 / .08);
      box-shadow: 0 12px 32px rgb(0 0 0 / .28), 0 2px 6px rgb(0 0 0 / .18);
      user-select: none; animation: enter .24s cubic-bezier(.16,1,.3,1);
    }
    @keyframes enter { from { opacity: 0; transform: translateY(10px) scale(.98); } }
    .grip { width: 18px; height: 32px; display: grid; place-items: center; color: rgb(255 255 255 / .35); cursor: grab; border-radius: 6px; }
    .grip:active { cursor: grabbing; }
    .grip svg { width: 14px; height: 14px; fill: currentColor; }
    .clock { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; padding: 0 10px; min-width: 64px; text-align: center; }
    .clock.paused { color: #f5b544; }
    .sep { width: 1px; height: 20px; background: rgb(255 255 255 / .14); margin: 0 4px; }
    .label { padding: 0 12px 0 8px; white-space: nowrap; }
    .muted { color: rgb(255 255 255 / .62); font-weight: 500; }
    button {
      all: unset; box-sizing: border-box; cursor: pointer; height: 36px; min-width: 36px;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      border-radius: 10px; color: #fafafa; padding: 0 10px; font: inherit;
      transition: background .15s ease, transform .12s ease;
    }
    button svg { width: 18px; height: 18px; fill: currentColor; flex: none; }
    button:hover { background: rgb(255 255 255 / .1); }
    button:active { transform: scale(.95); }
    button:focus-visible { box-shadow: 0 0 0 2px rgb(255 255 255 / .6); }
    .iconbtn { padding: 0; width: 36px; }
    .stop .sq { width: 16px; height: 16px; border-radius: 4px; background: #f2555a; }
    .stop:hover .sq { background: #ff6b6f; }
    .danger:hover { color: #ff8a8e; }
    .confirm { background: rgb(242 85 90 / .2); color: #ffb0b3; }
    .confirm:hover { background: rgb(242 85 90 / .3); }
    .spin { display: inline-grid; width: 18px; height: 18px; animation: spin .9s linear infinite; }
    .spin svg { width: 100%; height: 100%; fill: currentColor; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .num {
      width: 30px; height: 30px; margin-left: 4px; border-radius: 50%; display: grid; place-items: center;
      background: #f2555a; color: #fff; font-size: 15px; font-variant-numeric: tabular-nums;
      animation: pop .9s cubic-bezier(.16,1,.3,1);
    }
    @keyframes pop { from { transform: scale(1.35); } }
    .mini { width: 48px; padding: 0; justify-content: center; }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: #f2555a; animation: pulse 1.4s ease-in-out infinite; }
    .dot.paused { background: #f5b544; animation: none; }
    @keyframes pulse { 50% { opacity: .4; } }
    .toast { max-width: min(520px, calc(100vw - 32px)); height: auto; min-height: 48px; padding: 10px 8px 10px 14px; gap: 10px; }
    .toast .ic { color: #ff8a8e; display: inline-grid; }
    .toast .ic svg { width: 18px; height: 18px; fill: currentColor; }
    .toast .msg { line-height: 1.4; font-weight: 500; }
    .tip {
      position: absolute; bottom: calc(100% + 10px); left: 0; transform: translateX(-50%);
      padding: 6px 9px; border-radius: 8px; background: #18181b; color: #fff; white-space: nowrap;
      font-size: 12.5px; font-weight: 500; box-shadow: 0 6px 18px rgb(0 0 0 / .25); pointer-events: none;
      display: flex; gap: 8px; align-items: center; opacity: 0; transition: opacity .12s ease;
    }
    .tip.on { opacity: 1; }
    .tip .k { font-size: 11px; font-weight: 600; padding: 3px 5px; border-radius: 5px; background: rgb(255 255 255 / .14); color: rgb(255 255 255 / .85); }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `;

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
    els = { wrap: document.createElement('div') };
    els.wrap.className = 'wrap';
    els.wrap.setAttribute('role', 'toolbar');
    els.wrap.setAttribute('aria-label', 'Recording controls');
    root.append(els.wrap);
    (document.body || document.documentElement).append(host);
    applyOffset();
  }

  /** Remove the pill; fades out unless it must vanish at once (end of countdown). */
  function destroy(immediate = true) {
    clearInterval(tick);
    if (!immediate && els?.wrap && host) {
      const old = host;
      els.wrap.classList.add('leaving');
      host = root = els = null;
      setTimeout(() => old.remove(), 170);
      return;
    }
    host?.remove();
    host = root = els = null;
  }

  function applyOffset() {
    if (!els) return;
    els.wrap.style.setProperty('--dx', `${offset.x}px`);
    els.wrap.style.setProperty('--dy', `${offset.y}px`);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // Tooltip above the pill (page-level tooltips can't reach into the shadow root).
  function attachTip(b, label, kbd) {
    b.setAttribute('aria-label', label);
    let t;
    let timer;
    const show = () => {
      const bar = b.closest('.bar');
      if (!bar) return;
      t = el('div', 'tip', label);
      if (kbd) t.append(el('span', 'k', kbd));
      bar.append(t);
      const br = bar.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      t.style.left = `${r.left - br.left + r.width / 2}px`;
      requestAnimationFrame(() => t?.classList.add('on'));
    };
    const hide = () => {
      clearTimeout(timer);
      t?.remove();
      t = null;
    };
    b.addEventListener('pointerenter', () => (timer = setTimeout(show, 350)));
    b.addEventListener('pointerleave', hide);
    b.addEventListener('focus', () => b.matches(':focus-visible') && show());
    b.addEventListener('blur', hide);
    b.addEventListener('click', hide);
  }

  function btn({ cls = '', label, kbd, iconName, text, onClick, html }) {
    const b = document.createElement('button');
    b.className = cls;
    if (html) b.append(html);
    else if (iconName) b.innerHTML = icon(iconName); // trusted, bundled SVG
    if (text) b.append(document.createTextNode(text));
    attachTip(b, label, kbd);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function spinner() {
    const s = el('span', 'spin');
    s.innerHTML = icon('spinner-gap');
    return s;
  }

  function grip() {
    const g = el('div', 'grip');
    g.innerHTML = icon('dots-six-vertical');
    g.title = 'Drag to move';
    enableDrag(g);
    return g;
  }

  function cancelBtn() {
    return btn({ cls: 'iconbtn', label: 'Cancel', iconName: 'x', onClick: () => control('discard') });
  }

  function renderToast(bar) {
    bar.classList.add('toast');
    const ic = el('span', 'ic');
    ic.innerHTML = icon('warning-circle');
    bar.append(ic, el('span', 'msg', toast.message), btn({ cls: 'iconbtn', label: 'Close', iconName: 'x', onClick: () => { toast = null; render(); } }));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // http:// pages have no async clipboard; a selected textarea + copy still works on a click.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      root.append(ta);
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

  function renderSaved(bar) {
    bar.classList.add('saved');
    const e = saved.entry;
    const ok = el('span', 'ok');
    ok.innerHTML = icon('check');
    const link = e.shareUrl || e.viewerUrl;
    const copy = btn({
      cls: 'linkbtn',
      label: e.shareUrl ? 'Copy the share link' : 'Copy link (only you can open it until Drive is connected)',
      iconName: saved.copied ? 'check' : 'link-simple',
      text: saved.copied ? 'Copied' : 'Copy link',
      onClick: async () => {
        let url = link;
        if (!e.shareUrl) {
          // No public link yet (Drive was slow, or just connected): ask for one now.
          try {
            const r = await chrome.runtime.sendMessage({ type: 'share:link', id: e.id });
            if (r?.result?.url) url = r.result.url;
            if (r?.result?.isPublic) e.shareUrl = r.result.url;
          } catch {
            /* extension reloaded: fall back to the link we have */
          }
        }
        if (await copyText(url)) {
          saved.copied = true;
          saved.until = Math.max(saved.until, Date.now() + 4000);
          render();
        }
      },
    });
    const open = btn({
      cls: '',
      label: 'Open to add a title or description',
      iconName: 'arrow-square-out',
      text: 'Open',
      onClick: () => {
        try {
          chrome.runtime.sendMessage({ type: 'open:url', url: `${e.viewerUrl}?review=1` }).catch(() => {});
        } catch {
          /* extension reloaded */
        }
        saved = null;
        render();
      },
    });
    bar.append(el('span', 'label'), ok, el('span', 'label', 'Saved'), el('span', 'sep'), copy, open, el('span', 'sep'),
      btn({ cls: 'iconbtn', label: 'Close', iconName: 'x', onClick: () => { saved = null; render(); } }));
    bar.firstChild.style.padding = '0 2px';
    // Hovering keeps it open; it fades away on its own otherwise.
    bar.addEventListener('pointerenter', () => (savedHover = true));
    bar.addEventListener('pointerleave', () => {
      savedHover = false;
      saved && (saved.until = Math.max(saved.until, Date.now() + 2500));
    });
  }

  function renderBar() {
    const bar = el('div', 'bar');
    const status = rec?.status;

    if (saved && !isActive(rec) && !(toast && toast.until > Date.now())) {
      renderSaved(bar);
      els.wrap.replaceChildren(bar);
      return;
    }

    if (toast && toast.until > Date.now() && !['countdown', 'recording', 'paused', 'stopping'].includes(status)) {
      renderToast(bar);
      els.wrap.replaceChildren(bar);
      return;
    }

    if (status === 'starting') {
      bar.append(el('span', 'label'), spinner(), el('span', 'label', 'Starting…'), el('span', 'sep'), cancelBtn());
      bar.firstChild.style.padding = '0 2px';
      els.wrap.replaceChildren(bar);
      return;
    }

    if (status === 'countdown') {
      const left = Math.max(1, Math.ceil((rec.countdownEndsAt - Date.now()) / 1000));
      const num = el('span', 'num', String(left));
      bar.append(num, el('span', 'label', 'Recording in'), el('span', 'sep'), cancelBtn());
      els.num = num;
      els.wrap.replaceChildren(bar);
      return;
    }

    if (status === 'stopping') {
      bar.append(el('span', 'label'), spinner(), el('span', 'label', 'Saving…'));
      bar.firstChild.style.padding = '0 2px';
      els.wrap.replaceChildren(bar);
      return;
    }

    if (collapsed) {
      bar.classList.add('mini');
      bar.append(btn({ cls: 'iconbtn', label: 'Show controls', html: el('span', `dot${status === 'paused' ? ' paused' : ''}`), onClick: () => { collapsed = false; render(); } }));
      els.wrap.replaceChildren(bar);
      return;
    }

    const sq = el('span', 'sq');
    bar.append(grip(), btn({ cls: 'iconbtn stop', label: 'Stop and save', kbd: 'Alt+Shift+X', html: sq, onClick: () => control('stop') }));
    bar.append(
      status === 'paused'
        ? btn({ cls: 'iconbtn', label: 'Resume', kbd: 'Alt+Shift+P', iconName: 'play-fill', onClick: () => control('resume') })
        : btn({ cls: 'iconbtn', label: 'Pause', kbd: 'Alt+Shift+P', iconName: 'pause-fill', onClick: () => control('pause') }),
    );
    els.clock = el('span', `clock${status === 'paused' ? ' paused' : ''}`, fmt(elapsedMs(rec)));
    bar.append(els.clock, el('span', 'sep'));

    const discard = btn({
      cls: 'iconbtn danger',
      label: 'Discard',
      iconName: 'trash',
      onClick: () => {
        // Two-step confirm without a blocking dialog.
        const confirm = btn({ cls: 'confirm', label: 'Click to discard the recording', iconName: 'trash', text: 'Discard?', onClick: () => control('discard') });
        discard.replaceWith(confirm);
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => confirm.isConnected && confirm.replaceWith(discard), 3000);
      },
    });
    bar.append(discard, btn({ cls: 'iconbtn', label: 'Minimise', iconName: 'minus', onClick: () => { collapsed = true; render(); } }));
    els.wrap.replaceChildren(bar);
  }

  function enableDrag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      const move = (ev) => {
        const maxX = window.innerWidth / 2 - 120;
        offset.x = Math.max(-maxX, Math.min(maxX, start.ox + ev.clientX - start.x));
        offset.y = Math.max(-(window.innerHeight - 90), Math.min(16, start.oy + ev.clientY - start.y));
        applyOffset();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        chrome.storage.local.set({ overlayOffset: offset }).catch(() => {});
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
  }

  function render() {
    if (retired || !visibleFor(rec)) return destroy(false);
    if (!host || !host.isConnected) build();
    clearInterval(tick);
    renderBar();
    if (rec?.status === 'countdown') {
      tick = setInterval(() => {
        if (!rec || rec.status !== 'countdown') return;
        const left = Math.max(1, Math.ceil((rec.countdownEndsAt - Date.now()) / 1000));
        // Remove the pill just before capture starts so the countdown is never in the video.
        if (rec.countdownEndsAt - Date.now() <= 0) return destroy();
        if (els?.num && els.num.textContent !== String(left)) {
          const n = el('span', 'num', String(left));
          els.num.replaceWith(n);
          els.num = n;
        }
      }, 100);
    } else if (rec?.status === 'recording') {
      tick = setInterval(() => {
        if (els?.clock) els.clock.textContent = fmt(elapsedMs(rec));
      }, 250);
    } else if (toast || saved) {
      tick = setInterval(() => {
        if (toast && toast.until <= Date.now()) {
          toast = null;
          render();
        } else if (saved && saved.until <= Date.now() && !savedHover) {
          saved = null;
          render();
        }
      }, 400);
    }
  }

  async function init() {
    try {
      const [hello, stored] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'content:hello' }),
        chrome.storage.local.get('overlayOffset'),
      ]);
      myTabId = hello?.result?.tabId ?? null;
      rec = hello?.result?.rec || null;
      if (stored.overlayOffset) offset = stored.overlayOffset;
      render();
    } catch {
      /* extension reloaded or unavailable */
    }
  }

  function onStorage(changes, area) {
    if (retired) return;
    // A recording that failed to start: say why where the user is looking.
    const forMe = rec ? rec.mode === 'desktop' || rec.tabId === myTabId : document.hasFocus();
    if (area === 'local' && changes.lastError?.newValue && document.visibilityState === 'visible' && forMe) {
      toast = { message: changes.lastError.newValue.message, until: Date.now() + 7000 };
    }
    // Recording saved: offer the link right here instead of opening a new tab.
    const fresh = changes.lastResult?.newValue;
    if (area === 'local' && fresh && !fresh.dialog && fresh.id !== changes.lastResult?.oldValue?.id && rec && forMe && (rec.mode === 'tab' || document.visibilityState === 'visible')) {
      saved = { entry: fresh, until: Date.now() + 10000, copied: false };
    }
    if (area === 'session' && changes.rec) {
      const next = changes.rec.newValue || null;
      if (!next || next.status === 'countdown') collapsed = false;
      rec = next;
    } else if (!(area === 'local' && (changes.lastError || changes.lastResult))) {
      return;
    }
    render();
  }
  chrome.storage.onChanged.addListener(onStorage);

  // The BugSnap player and Recordings page (on the configured server only) can ask the
  // extension to open a screenshot in the editor. Anything else posting this is ignored.
  window.addEventListener('message', async (e) => {
    if (retired || e.source !== window || e.data?.source !== 'bugsnap-page') return;
    try {
      const { settings } = await chrome.storage.local.get('settings');
      const serverOrigin = new URL(settings?.serverUrl || 'http://localhost:4800').origin;
      if (location.origin !== serverOrigin) return;
      if (e.data.type === 'ping') return window.postMessage({ source: 'bugsnap-ext', type: 'pong' }, location.origin);
      if (e.data.type === 'theme' && ['light', 'dark', 'system'].includes(e.data.theme)) return chrome.storage.local.set({ theme: e.data.theme });
      if (e.data.type === 'annotate') {
        await chrome.runtime.sendMessage({ type: 'snap:edit', id: String(e.data.id || '') });
        window.postMessage({ source: 'bugsnap-ext', type: 'annotate-ack', id: e.data.id }, location.origin);
      }
    } catch {
      /* extension reloaded */
    }
  });

  // Light/dark: the BugSnap pages on the server follow the extension's choice (and set it).
  (async () => {
    try {
      const { settings, theme } = await chrome.storage.local.get(['settings', 'theme']);
      if (location.origin !== new URL(settings?.serverUrl || 'http://localhost:4800').origin) return;
      const tell = (t) => t && window.postMessage({ source: 'bugsnap-ext', type: 'theme', theme: t }, location.origin);
      tell(theme);
      chrome.storage.onChanged.addListener((c, area) => area === 'local' && c.theme && !retired && tell(c.theme.newValue));
    } catch {
      /* extension reloaded */
    }
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

// In-page panel that replaces Chrome's toolbar popup so it can have rounded corners and a
// soft shadow (Chrome draws its own popup frame square and extensions cannot style it).
// Injected by background.js on toolbar click; injecting again toggles it.
(() => {
  const existing = globalThis.__screenrecPanel;
  if (existing && existing.isConnected()) {
    existing.close();
    return;
  }

  const ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
  const host = document.createElement('div');
  host.id = '__screenrec_panel__';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .wrap {
      position: fixed; top: 10px; right: 12px; z-index: 2147483647;
      width: 340px; height: 210px; max-height: calc(100vh - 20px);
      border-radius: 18px; overflow: hidden; background: #fff;
      box-shadow: 0 0 0 1px rgb(16 24 40 / .08), 0 4px 10px rgb(16 24 40 / .06), 0 22px 56px rgb(16 24 40 / .18);
      transform-origin: top right;
      animation: in .2s cubic-bezier(.16,1,.3,1);
      transition: height .18s cubic-bezier(.16,1,.3,1);
    }
    .wrap.out { animation: out .14s ease-in forwards; }
    .wrap.dark { background: #141417; box-shadow: 0 0 0 1px rgb(255 255 255 / .09), 0 4px 10px rgb(0 0 0 / .3), 0 22px 56px rgb(0 0 0 / .55); }
    iframe { display: block; width: 100%; height: 100%; border: 0; overflow: hidden; }
    @keyframes in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
    @keyframes out { to { opacity: 0; transform: translateY(-4px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) { .wrap, .wrap.out { animation: none; transition: none; } }
  `;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('popup.html?panel=1');
  frame.title = 'BugSnap';
  frame.allow = 'clipboard-write';
  frame.setAttribute('scrolling', 'no'); // the page sizes the frame to its content
  wrap.append(frame);
  chrome.storage.local.get('theme').then(({ theme }) => {
    const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    wrap.classList.toggle('dark', dark);
  }).catch(() => {});
  root.append(style, wrap);
  (document.body || document.documentElement).append(host);

  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    removeEventListener('message', onMessage);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    wrap.classList.add('out');
    setTimeout(() => host.remove(), 150);
    globalThis.__screenrecPanel = null;
  }

  function onMessage(e) {
    if (e.origin !== ORIGIN || e.source !== frame.contentWindow || !e.data || e.data.source !== 'screenrec-panel') return;
    if (e.data.type === 'close') close();
    if (e.data.type === 'height' && Number.isFinite(e.data.value)) wrap.style.height = `${Math.ceil(e.data.value)}px`;
  }
  // Clicks inside the iframe never reach the page, so any page click is "outside".
  const onOutside = (e) => {
    if (!e.composedPath().includes(host)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  addEventListener('message', onMessage);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  globalThis.__screenrecPanel = { close, isConnected: () => host.isConnected && !closing };
})();

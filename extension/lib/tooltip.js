// Tooltips for any element with data-tip="Label" (and optional data-kbd="Alt+Shift+P").
// One floating bubble per page, shown after a short hover delay or at once on keyboard focus,
// placed below the element (above when there is no room) and kept inside the window.
// Copied to server/public/tooltip.js: keep in sync.
(function () {
  if (window.__bugsnapTips) return;
  window.__bugsnapTips = true;

  let tip;
  let timer;
  let current;

  function bubble() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'bugsnap-tip';
    document.body.append(tip);
    return tip;
  }

  function show(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    const t = bubble();
    t.replaceChildren(document.createTextNode(text));
    const kbd = el.getAttribute('data-kbd');
    if (kbd) {
      const k = document.createElement('span');
      k.className = 'tip-kbd';
      k.textContent = kbd;
      t.append(k);
    }
    t.classList.add('on');
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const gap = 8;
    const below = r.bottom + gap + h <= window.innerHeight || r.top - gap - h < 0;
    const top = below ? r.bottom + gap : r.top - gap - h;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.setAttribute('aria-describedby', 'bugsnap-tip');
    current = el;
  }

  function hide() {
    clearTimeout(timer);
    tip?.classList.remove('on');
    current?.removeAttribute('aria-describedby');
    current = null;
  }

  const target = (e) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);

  document.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el === current) return;
    hide();
    if (el && e.pointerType !== 'touch') timer = setTimeout(() => show(el), 380);
  });
  document.addEventListener('pointerout', (e) => {
    const el = target(e);
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el && el.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);

  // Icon-only buttons get their tooltip as an accessible name too.
  const label = () =>
    document.querySelectorAll('[data-tip]:not([aria-label])').forEach((el) => {
      if (!el.textContent.trim()) el.setAttribute('aria-label', el.getAttribute('data-tip'));
    });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', label);
  else label();
  new MutationObserver(label).observe(document.documentElement, { childList: true, subtree: true });
})();

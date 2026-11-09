// BugSnap theme: light, dark or system. Load it in <head> before the stylesheets so the page
// never flashes the wrong colours. The choice is remembered (localStorage; in the extension also
// chrome.storage, so every extension page and frame follows it). ?theme=light|dark|system
// (used when a page is framed inside the extension) wins for that page without being saved.
// Copied to extension/lib/theme.js: keep the two in sync.
(function () {
  const KEY = 'bugsnap.theme';
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (v) => v === 'light' || v === 'dark' || v === 'system';
  const forced = new URLSearchParams(location.search).get('theme');
  const ext = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id;
  let pref = 'system';
  try {
    pref = valid(forced) ? forced : localStorage.getItem(KEY) || 'system';
  } catch {
    pref = valid(forced) ? forced : 'system';
  }
  if (!valid(pref)) pref = 'system';
  const listeners = new Set();

  function apply() {
    const theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    root.dataset.theme = theme;
    root.dataset.themePref = pref;
    root.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0c0c0e' : '#ffffff';
    listeners.forEach((fn) => fn(theme, pref));
  }

  function take(next, save) {
    if (!valid(next) || next === pref) return;
    pref = next;
    if (save) {
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* storage blocked */
      }
    }
    apply();
  }

  apply();
  mq.addEventListener('change', () => pref === 'system' && apply());
  window.addEventListener('storage', (e) => e.key === KEY && !valid(forced) && take(e.newValue || 'system', false));
  // On the BugSnap server pages, the extension's content script shares the extension's choice.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.source === 'bugsnap-ext' && e.data.type === 'theme' && !valid(forced)) take(e.data.theme, true);
  });
  if (ext && !valid(forced)) {
    chrome.storage.local.get('theme').then((r) => r && valid(r.theme) && take(r.theme, true)).catch(() => {});
    chrome.storage.onChanged.addListener((c, area) => area === 'local' && c.theme && take(c.theme.newValue || 'system', true));
  }

  window.BugSnapTheme = {
    /** 'light' | 'dark' | 'system' */
    get pref() {
      return pref;
    },
    /** The theme in use now: 'light' | 'dark' */
    get theme() {
      return root.dataset.theme;
    },
    set(next) {
      if (!valid(next)) return;
      root.classList.add('theme-anim');
      setTimeout(() => root.classList.remove('theme-anim'), 450);
      take(next, true);
      if (ext) chrome.storage.local.set({ theme: next }).catch(() => {});
      // The extension's content script passes it to the extension (and the other way round).
      try {
        window.postMessage({ source: 'bugsnap-page', type: 'theme', theme: next }, location.origin);
      } catch {
        /* ignore */
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  // A theme switch button anywhere: <button data-theme-toggle>. Click cycles System → Light → Dark.
  const ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
  const LABEL = { system: 'Theme: same as system', light: 'Theme: light', dark: 'Theme: dark' };
  const NEXT = { system: 'light', light: 'dark', dark: 'system' };
  function paintToggles() {
    const icons = window.ScreenRecIcons || {};
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      const holder = b.querySelector('.icon') || b;
      holder.innerHTML = icons[ICON[pref]] || '';
      b.dataset.tip = `${LABEL[pref]} · click to change`;
      b.setAttribute('aria-label', LABEL[pref]);
    });
  }
  listeners.add(paintToggles);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!b) return;
    e.preventDefault();
    window.BugSnapTheme.set(NEXT[pref]);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintToggles);
  else paintToggles();
})();

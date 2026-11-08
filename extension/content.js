// Isolated-world content script.
// 1. Relays console and network events from page-hook.js to the background.
// 2. Records user actions (clicks, typing, selections, key presses) as readable sentences.
// Nothing is sent unless THIS tab is part of an active, unpaused recording.
(() => {
  // After an extension reload/update a fresh copy is injected next to the orphaned one.
  // The new copy tells the old one to remove its listeners, then takes over.
  const REPLACED = '__screenrec_content_replaced__';
  window.dispatchEvent(new CustomEvent(REPLACED));
  const ac = new AbortController();
  const on = (target, type, fn, capture = false) => target.addEventListener(type, fn, { capture, signal: ac.signal });
  window.addEventListener(REPLACED, () => teardown(), { once: true, signal: ac.signal });

  const PAGE_SOURCE = '__screenrec_page__';
  const CONTROL = '__screenrec_ext__';
  const OVERLAY_HOST = 'screenrec-overlay-host';
  const FLUSH_MS = 250;
  const MAX_BATCH = 50;
  const MAX_EARLY = 500;
  const CONSOLE_PER_SECOND = 100;

  let myTabId = null;
  let rec = null;
  let ready = false; // false until the background says which tab this is
  let active = false;
  let early = []; // events from page load, held until we know whether this tab is recorded

  const isMine = (r) => !!r && (r.mode === 'desktop' || r.tabId === myTabId);

  function applyState(next) {
    rec = next;
    const was = active;
    active = !!rec && rec.status === 'recording' && isMine(rec);
    if (was && !active) flush();
    // Only the recorded tab(s) keep page-hook.js posting; every other page goes quiet.
    const hookOn = isMine(rec) && ['countdown', 'recording', 'paused'].includes(rec.status);
    window.postMessage({ source: CONTROL, cmd: hookOn ? 'enable' : 'disable' }, '*');
  }

  function safeSend(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      teardown(); // extension context is gone (reloaded or removed)
      return Promise.resolve(null);
    }
  }

  safeSend({ type: 'content:hello' }).then((reply) => {
    if (!reply) return;
    myTabId = reply.result?.tabId ?? null;
    ready = true;
    // A state change that landed while hello was in flight is newer than the reply.
    applyState(latestWhileWaiting !== undefined ? latestWhileWaiting : reply.result?.rec || null);
    const held = early;
    early = [];
    if (active) held.forEach(send);
  });

  let latestWhileWaiting;
  const onStorage = (changes, area) => {
    if (area !== 'session' || !changes.rec) return;
    if (!ready) latestWhileWaiting = changes.rec.newValue || null;
    else applyState(changes.rec.newValue || null);
  };
  chrome.storage.onChanged.addListener(onStorage);

  // ---- Batched delivery ----
  let queue = [];
  let flushTimer = null;
  let consoleWindowStart = 0;
  let consoleInWindow = 0;
  let consoleDropped = 0;

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (consoleDropped) {
      queue.push({ type: 'console', level: 'warn', ts: Date.now(), url: location.href, message: `${consoleDropped} console messages were not recorded (more than ${CONSOLE_PER_SECOND} per second)` });
      consoleDropped = 0;
    }
    if (!queue.length) return;
    const events = queue;
    queue = [];
    safeSend({ type: 'page:events', events });
  }

  function send(event) {
    if (!ready) {
      if (early.length < MAX_EARLY) early.push({ ...event, url: location.href });
      return;
    }
    if (!active) return;
    if (event.type === 'console') {
      const now = Date.now();
      if (now - consoleWindowStart > 1000) {
        consoleWindowStart = now;
        consoleInWindow = 0;
      }
      if (++consoleInWindow > CONSOLE_PER_SECOND) {
        consoleDropped++;
        return;
      }
    }
    queue.push({ url: location.href, ...event });
    // User actions go out promptly (a click may navigate away); logs are batched.
    if (event.type === 'action' || queue.length >= MAX_BATCH) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function teardown() {
    ac.abort();
    clearTimeout(flushTimer);
    active = false;
    try {
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      /* context already invalid */
    }
  }

  on(window, 'pagehide', flush);

  const fromOverlay = (e) => e.target instanceof Element && e.target.id === OVERLAY_HOST;

  // ---- Relay from the page world ----
  on(window, 'message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== PAGE_SOURCE) return;
    const { kind, data, ts } = e.data;
    if ((kind !== 'console' && kind !== 'network') || !data || typeof data !== 'object') return;
    // type and ts are set AFTER the page-supplied fields so a page cannot forge user steps.
    send({ ...data, type: kind, ts: typeof ts === 'number' ? ts : Date.now() });
  });

  // ---- Element description ----
  const clean = (s, max = 60) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };

  const INTERACTIVE =
    'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=treeitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';

  function isPrivate(el) {
    return !!el.closest('[data-private],[data-screenrec-mask]');
  }

  function isSecretInput(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return el.type === 'password' || ac.startsWith('cc-') || ac === 'one-time-code' || ac.includes('password');
  }

  // innerText respects CSS (hidden text is skipped); textContent is the fallback.
  const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .join(' ');
      if (text.trim()) return clean(text);
    }
    if (el.labels && el.labels.length) {
      const text = textOf(el.labels[0]);
      if (text && text.trim()) return clean(text);
    }
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) && el.value) return clean(el.value);
    if (el instanceof HTMLImageElement && el.alt) return clean(el.alt);
    const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    if (!isField) {
      const text = textOf(el);
      if (text.trim()) return clean(text);
    }
    const fallback =
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.querySelector?.('img[alt]')?.getAttribute('alt') ||
      el.querySelector?.('svg title')?.textContent ||
      el.getAttribute('name') ||
      (el.id && !/\d{3,}/.test(el.id) ? el.id.replace(/[-_]+/g, ' ') : '');
    return clean(fallback);
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'dropdown';
    if (tag === 'textarea') return 'field';
    if (tag === 'img') return 'image';
    if (tag === 'label') return 'label';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file picker';
      return 'field';
    }
    if (el.isContentEditable) return 'editor';
    return 'element';
  }

  const ROLE_NOUN = {
    link: 'link',
    button: 'button',
    tab: 'tab',
    checkbox: 'checkbox',
    radio: 'option',
    switch: 'switch',
    option: 'option',
    menuitem: 'menu item',
    menuitemcheckbox: 'menu item',
    menuitemradio: 'menu item',
    treeitem: 'item',
    combobox: 'dropdown',
    dropdown: 'dropdown',
    field: 'field',
    editor: 'editor',
    image: 'image',
    label: 'label',
    slider: 'slider',
    'file picker': 'file picker',
  };

  function cssPath(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test');
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId}"]`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    const role = roleOf(el);
    const name = accessibleName(el);
    return { role, name, noun: ROLE_NOUN[role] || 'element', selector: cssPath(el), tag: el.tagName.toLowerCase() };
  }

  const quoted = (name) => (name ? `"${name}"` : '');

  // Last recorded click or Enter, used to drop the redundant "Submits the form" step.
  let lastTrigger = { el: null, ts: 0 };

  function action(kind, el, text, extra = {}) {
    if (kind === 'click' || kind === 'key') lastTrigger = { el, ts: Date.now() };
    const d = describe(el);
    send({ type: 'action', action: kind, ts: Date.now(), text, role: d.role, name: d.name, selector: d.selector, ...extra });
  }

  // ---- Clicks ----
  const TEXT_INPUT_TYPES = new Set(['text', 'email', 'search', 'url', 'tel', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week', '']);

  on(
    document,
    'click',
    (e) => {
      if (!active || !e.isTrusted || fromOverlay(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const el = target.closest(INTERACTIVE) || target;
      // Focusing a text field is noise; the typing itself is recorded on change.
      if ((el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      // A click on a <label> also fires a click on its control; record the control only.
      if (el.tagName === 'LABEL' && el.control) return;

      const d = describe(el);
      const name = isPrivate(el) ? '' : d.name;
      let text;
      if (d.role === 'checkbox' || d.role === 'switch') {
        const checked = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
        text = `${checked ? 'Checks' : 'Unchecks'} the ${quoted(name)} ${d.noun}`.replace(/\s+/g, ' ');
      } else if (d.role === 'radio' || d.role === 'option' || d.role === 'menuitemradio') {
        text = `Selects the ${quoted(name)} option`;
      } else if (d.role === 'tab') {
        text = `Opens the ${quoted(name)} tab`;
      } else if (d.role.startsWith('menuitem')) {
        text = `Chooses ${quoted(name) || 'an item'} from the menu`;
      } else if (d.noun !== 'element') {
        text = name ? `Clicks the ${quoted(name)} ${d.noun}` : `Clicks a ${d.noun}`;
      } else {
        text = name ? `Clicks on ${quoted(name)}` : `Clicks on the page (${d.tag})`;
      }
      action('click', el, text.replace(/\s+/g, ' ').replace(' the  ', ' the '), { x: e.clientX, y: e.clientY });
    },
    true,
  );

  // ---- Typing and selection (recorded once the value is committed) ----
  // Last value we reported per field, so Enter-then-change does not report twice.
  const reported = new WeakMap();
  on(
    document,
    'focusin',
    (e) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) reported.set(el, el.value);
    },
    true,
  );

  function recordTextValue(el) {
    if (reported.get(el) === el.value) return;
    reported.set(el, el.value);
    const d = describe(el);
    const field = d.name ? `the ${quoted(d.name)} ${d.noun}` : `a ${d.noun}`;
    if (isSecretInput(el) || isPrivate(el)) {
      action('input', el, `Enters a hidden value into ${field}`, { masked: true });
    } else if (!el.value) {
      action('input', el, `Clears ${field}`);
    } else {
      action('input', el, `Types ${quoted(clean(el.value, 80))} into ${field}`);
    }
  }

  on(
    document,
    'change',
    (e) => {
      if (!active || !e.isTrusted || fromOverlay(e)) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const d = describe(el);
      const field = d.name ? `the ${quoted(d.name)} ${d.noun}` : `a ${d.noun}`;
      if (el instanceof HTMLSelectElement) {
        if (isPrivate(el)) {
          action('select', el, `Chooses a hidden value in ${field}`, { masked: true });
        } else {
          const label = clean([...el.selectedOptions].map((o) => o.text).join(', '));
          action('select', el, `Selects ${quoted(label)} in ${field}`);
        }
      } else if (el instanceof HTMLInputElement && el.type === 'file') {
        const n = el.files ? el.files.length : 0;
        action('upload', el, `Chooses ${n} file${n === 1 ? '' : 's'} in ${field}`);
      } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        // Already recorded by the click handler.
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        recordTextValue(el);
      }
    },
    true,
  );

  // ---- Keys that change state ----
  on(
    document,
    'keydown',
    (e) => {
      if (!active || !e.isTrusted || fromOverlay(e) || e.repeat) return;
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const el = e.target instanceof Element ? e.target : document.body;
      // Report what was typed before the Enter that submits it.
      if (e.key === 'Enter' && (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))) recordTextValue(el);
      const d = describe(el);
      const where = d.noun === 'field' || d.noun === 'editor' ? ` in the ${quoted(d.name)} ${d.noun}`.replace('the  ', 'the ') : '';
      action('key', el, `Presses ${e.key}${where}`, { key: e.key });
    },
    true,
  );

  // ---- Form submissions without a recorded click ----
  on(
    document,
    'submit',
    (e) => {
      if (!active || !e.isTrusted || fromOverlay(e)) return;
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      // "Clicks the Sign in button" or "Presses Enter" already explains this submission.
      if (lastTrigger.el && Date.now() - lastTrigger.ts < 1500 && form.contains(lastTrigger.el)) return;
      const name = accessibleName(form) || form.getAttribute('name') || '';
      action('submit', form, name && name.length < 40 ? `Submits the ${quoted(name)} form` : 'Submits the form');
    },
    true,
  );

  // ---- Requests from the extension ----
  function onRuntimeMessage(msg, _sender, reply) {
    if (msg && msg.type === 'content:viewport') {
      reply({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        screen: { width: screen.width, height: screen.height },
        title: document.title,
        url: location.href,
        referrer: document.referrer || undefined,
      });
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
})();

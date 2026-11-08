// Runs in the page's own JavaScript world (MAIN) so it can observe console calls,
// uncaught errors, fetch and XMLHttpRequest.
// It is injected ONLY while a recording is running (registered dynamically by the
// background), so pages that are never recorded are left untouched. After a recording
// ends the wrappers stay installed until reload but go quiet (enabled = false).
(() => {
  const SOURCE = '__screenrec_page__';
  const CONTROL = '__screenrec_ext__';
  if (window.__screenRecHooked) {
    // Already hooked by an earlier recording on this page: just switch back on.
    window.postMessage({ source: CONTROL, cmd: 'enable' }, '*');
    return;
  }
  Object.defineProperty(window, '__screenRecHooked', { value: true });

  let enabled = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== CONTROL) return;
    if (e.data.cmd === 'enable') enabled = true;
    if (e.data.cmd === 'disable') enabled = false;
  });
  const MAX_TEXT = 2000;
  const MAX_BODY = 2000;
  // Object keys whose values are never logged (console arguments).
  const SENSITIVE_KEY = /passw|pwd|secret|token|api[-_]?key|authorization|cookie|credential/i;
  // Query parameters that are redacted from logged URLs.
  const SENSITIVE_PARAM = /passw|pwd|secret|token|api[-_]?key|auth|session|signature|^sig$|^code$|^state$|credential/i;

  const post = (kind, data) => {
    if (!enabled) return;
    try {
      window.postMessage({ source: SOURCE, kind, data, ts: Date.now() }, '*');
    } catch {
      /* data not cloneable; ignore */
    }
  };

  const truncate = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

  function serialize(value) {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
      if (value instanceof Element) {
        const id = value.id ? `#${value.id}` : '';
        const cls = typeof value.className === 'string' && value.className ? `.${value.className.trim().split(/\s+/).join('.')}` : '';
        return `<${value.tagName.toLowerCase()}${id}${cls}>`;
      }
      if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
      if (value === undefined) return 'undefined';
      const seen = new WeakSet();
      return JSON.stringify(value, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        if (typeof k === 'string' && k && SENSITIVE_KEY.test(k) && typeof v !== 'object') return '[redacted]';
        return v;
      });
    } catch {
      return String(value);
    }
  }

  function redactUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, '[redacted]');
      }
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
      }
      return url.href;
    } catch {
      return String(raw);
    }
  }

  // ---- Console ----
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = function (...args) {
      if (!enabled) return original.apply(this, args);
      try {
        post('console', {
          level,
          message: truncate(args.map(serialize).join(' ')),
          stack: level === 'error' || level === 'warn' ? (new Error().stack || '').split('\n').slice(2, 7).join('\n') : undefined,
        });
      } catch {
        /* never break the page */
      }
      return original.apply(this, args);
    };
  }

  window.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t && t !== window && (t.src || t.href)) {
        post('console', { level: 'error', message: `Failed to load resource: <${t.tagName.toLowerCase()}> ${redactUrl(t.src || t.href)}` });
        return;
      }
      post('console', {
        level: 'error',
        message: truncate(`Uncaught ${e.message || 'error'}`),
        source: e.filename ? `${redactUrl(e.filename)}:${e.lineno}:${e.colno}` : undefined,
        stack: e.error && e.error.stack ? truncate(String(e.error.stack)) : undefined,
      });
    },
    true,
  );

  window.addEventListener('unhandledrejection', (e) => {
    post('console', { level: 'error', message: truncate(`Unhandled promise rejection: ${serialize(e.reason)}`) });
  });

  // ---- fetch ----
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (input, init) {
      if (!enabled) return originalFetch.apply(this, arguments);
      const startedAt = Date.now();
      const t0 = performance.now();
      let method = 'GET';
      let url = '';
      try {
        method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      } catch {
        /* keep defaults */
      }
      try {
        const res = await originalFetch.apply(this, arguments);
        const entry = {
          via: 'fetch',
          method,
          url: redactUrl(url),
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get('content-type') || undefined,
          size: Number(res.headers.get('content-length')) || undefined,
          durationMs: Math.round(performance.now() - t0),
          startedAt,
        };
        if (!res.ok && res.type !== 'opaque') {
          res
            .clone()
            .text()
            .then((body) => post('network', { ...entry, responseBody: truncate(body, MAX_BODY) }))
            .catch(() => post('network', entry));
        } else {
          post('network', entry);
        }
        return res;
      } catch (err) {
        post('network', {
          via: 'fetch',
          method,
          url: redactUrl(url),
          status: 0,
          error: String(err && err.message ? err.message : err),
          durationMs: Math.round(performance.now() - t0),
          startedAt,
        });
        throw err;
      }
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__screenrec = { method: String(method || 'GET').toUpperCase(), url: String(url) };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const info = this.__screenrec;
      if (info && enabled) {
        info.startedAt = Date.now();
        info.t0 = performance.now();
        this.addEventListener('loadend', () => {
          const entry = {
            via: 'xhr',
            method: info.method,
            url: redactUrl(info.url),
            status: this.status,
            statusText: this.statusText,
            contentType: this.getResponseHeader('content-type') || undefined,
            durationMs: Math.round(performance.now() - info.t0),
            startedAt: info.startedAt,
          };
          if (this.status === 0) entry.error = 'Network error or request aborted';
          if (this.status >= 400 && (this.responseType === '' || this.responseType === 'text')) {
            try {
              entry.responseBody = truncate(String(this.responseText || ''), MAX_BODY);
            } catch {
              /* ignore */
            }
          }
          post('network', entry);
        });
      }
      return send.apply(this, arguments);
    };
  }
})();

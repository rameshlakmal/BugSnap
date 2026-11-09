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

  // ---- Network (like the browser's Network panel) ----
  // fetch and XMLHttpRequest: method, URL, status, request and response headers and bodies.
  // Every other request (page, scripts, styles, images, fonts, media): Resource Timing (sizes
  // and a timing breakdown). WebSockets: open, messages, close. Secrets are hidden: header
  // values like Authorization/Cookie, and JSON or form fields named like password/token.
  const MAX_NET_BODY = 64 * 1024;
  const BODY_BUDGET = 6 * 1024 * 1024; // per page, so bodies never crowd out steps and logs
  let bodyBytes = 0;
  const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
  const SECRET_FIELD = /passw|pwd|secret|token|api[-_]?key|authorization|cookie|session|credential|otp|cvv|cvc|card.?number|ssn/i;
  const HIDDEN = '••••';
  let netSeq = 0;
  const netId = () => `n${Date.now().toString(36)}${(netSeq++).toString(36)}`;

  function headerList(pairs) {
    const out = [];
    for (const [k, v] of pairs) {
      if (out.length >= 100) break;
      out.push([String(k), SECRET_HEADER.test(k) ? HIDDEN : truncate(String(v), 1000)]);
    }
    return out.length ? out : undefined;
  }

  function hideSecretsInJson(value, depth = 0) {
    if (depth > 20 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => hideSecretsInJson(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) && (typeof v !== 'object' || v === null) ? HIDDEN : hideSecretsInJson(v, depth + 1);
    return out;
  }

  /** Body text with secret fields hidden, cut to size; undefined when over the page budget. */
  function cleanBody(text, contentType = '') {
    if (typeof text !== 'string' || !text) return undefined;
    if (bodyBytes > BODY_BUDGET) return '[not saved: this page already sent a lot of data]';
    let out = text;
    const t = text.trimStart();
    if (/json/i.test(contentType) || t.startsWith('{') || t.startsWith('[')) {
      try {
        out = JSON.stringify(hideSecretsInJson(JSON.parse(text)));
      } catch {
        /* not JSON after all */
      }
    } else if (/x-www-form-urlencoded/i.test(contentType) || (/^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(t) && t.length < 20000)) {
      try {
        const p = new URLSearchParams(text);
        for (const k of [...p.keys()]) if (SECRET_FIELD.test(k)) p.set(k, HIDDEN);
        out = p.toString();
      } catch {
        /* keep as is */
      }
    }
    out = truncate(out, MAX_NET_BODY);
    bodyBytes += out.length;
    return out;
  }

  /** What was sent: text bodies as text, everything else described. */
  async function requestBody(body, contentType) {
    try {
      if (body === undefined || body === null) return undefined;
      if (typeof body === 'string') return cleanBody(body, contentType);
      if (body instanceof URLSearchParams) return cleanBody(body.toString(), 'application/x-www-form-urlencoded');
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) parts.push(`${k}: ${typeof v === 'string' ? (SECRET_FIELD.test(k) ? HIDDEN : truncate(v, 500)) : `[file ${v.name || 'blob'}, ${v.size} bytes, ${v.type || 'unknown type'}]`}`);
        return truncate(`[form data]\n${parts.join('\n')}`, MAX_NET_BODY);
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        if (/json|text|xml|form/i.test(body.type) && body.size < 1e6) return cleanBody(await body.text(), body.type);
        return `[binary ${body.size} bytes${body.type ? `, ${body.type}` : ''}]`;
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary ${body.byteLength} bytes]`;
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[stream]';
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Response text worth keeping: text-like types only, not streams or big downloads. */
  const readableType = (ct) => !ct || /json|text|xml|javascript|graphql|html|x-www-form-urlencoded|csv|yaml/i.test(ct);
  const isStream = (ct) => /event-stream|x-ndjson|octet-stream/i.test(ct || '');

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (input, init) {
      if (!enabled) return originalFetch.apply(this, arguments);
      const startedAt = Date.now();
      const t0 = performance.now();
      const base = { reqId: netId(), via: 'fetch', resourceType: 'fetch', method: 'GET', url: '' };
      let reqBodyPromise;
      try {
        const req = input instanceof Request ? input : null;
        base.method = String((init && init.method) || (req ? req.method : 'GET')).toUpperCase();
        base.url = redactUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const headers = new Headers((init && init.headers) || (req ? req.headers : undefined));
        base.requestHeaders = headerList(headers.entries());
        const ct = headers.get('content-type') || '';
        if (init && init.body !== undefined) reqBodyPromise = requestBody(init.body, ct);
        else if (req && !['GET', 'HEAD'].includes(base.method)) reqBodyPromise = req.clone().text().then((t) => cleanBody(t, ct)).catch(() => undefined);
        if (init && (init.mode || init.credentials || init.cache)) base.options = { mode: init.mode, credentials: init.credentials, cache: init.cache };
      } catch {
        /* keep what we have */
      }
      try {
        const res = await originalFetch.apply(this, arguments);
        const ct = res.headers.get('content-type') || '';
        const entry = {
          ...base,
          status: res.status,
          statusText: res.statusText,
          contentType: ct || undefined,
          size: Number(res.headers.get('content-length')) || undefined,
          responseHeaders: headerList(res.headers.entries()),
          redirected: res.redirected || undefined,
          responseType: res.type !== 'basic' ? res.type : undefined,
          headersMs: Math.round(performance.now() - t0),
          startedAt,
        };
        const finish = async () => {
          entry.requestBody = await reqBodyPromise;
          if (res.type !== 'opaque' && readableType(ct) && !isStream(ct) && !(entry.size > 5e6)) {
            try {
              const text = await res.clone().text();
              entry.bodySize = text.length;
              entry.responseBody = cleanBody(text, ct);
            } catch {
              /* body not readable */
            }
          }
          entry.durationMs = Math.round(performance.now() - t0);
          post('network', entry);
        };
        finish();
        return res;
      } catch (err) {
        post('network', {
          ...base,
          requestBody: await reqBodyPromise,
          status: 0,
          error: String(err && err.message ? err.message : err),
          durationMs: Math.round(performance.now() - t0),
          startedAt,
        });
        throw err;
      }
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__screenrec = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: [] };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        this.__screenrec?.headers.push([name, value]);
      } catch {
        /* ignore */
      }
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const info = this.__screenrec;
      if (info && enabled) {
        info.startedAt = Date.now();
        info.t0 = performance.now();
        const ct = (info.headers.find(([k]) => /^content-type$/i.test(k)) || [])[1] || '';
        const reqBody = requestBody(body, ct);
        this.addEventListener('loadend', async () => {
          const resCt = this.getResponseHeader('content-type') || '';
          const entry = {
            reqId: netId(),
            via: 'xhr',
            resourceType: 'xhr',
            method: info.method,
            url: redactUrl(info.url),
            status: this.status,
            statusText: this.statusText,
            contentType: resCt || undefined,
            size: Number(this.getResponseHeader('content-length')) || undefined,
            requestHeaders: headerList(info.headers),
            responseHeaders: headerList(
              String(this.getAllResponseHeaders() || '')
                .trim()
                .split(/\r?\n/)
                .filter(Boolean)
                .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
            ),
            requestBody: await reqBody,
            durationMs: Math.round(performance.now() - info.t0),
            startedAt: info.startedAt,
          };
          if (this.status === 0) entry.error = 'Network error or request aborted';
          try {
            let text;
            if (this.responseType === '' || this.responseType === 'text') text = String(this.responseText || '');
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            else if (this.responseType === 'document' && this.responseXML) text = this.responseXML.documentElement?.outerHTML;
            if (typeof text === 'string' && readableType(resCt)) {
              entry.bodySize = text.length;
              entry.responseBody = cleanBody(text, resCt);
            } else if (this.response && typeof this.response === 'object' && 'byteLength' in this.response) entry.bodySize = this.response.byteLength;
            else if (this.response instanceof Blob) entry.bodySize = this.response.size;
          } catch {
            /* ignore */
          }
          post('network', entry);
        });
      }
      return send.apply(this, arguments);
    };
  }

  // ---- WebSocket: one row per socket, updated as messages flow (the newest copy wins) ----
  const WS = window.WebSocket;
  if (typeof WS === 'function') {
    const Wrapped = function (url, protocols) {
      const sock = protocols === undefined ? new WS(url) : new WS(url, protocols);
      if (!enabled) return sock;
      const startedAt = Date.now();
      const t0 = performance.now();
      const row = { reqId: netId(), via: 'websocket', resourceType: 'websocket', method: 'GET', url: redactUrl(String(url)), status: 101, startedAt, messages: [], sent: 0, received: 0, sentBytes: 0, receivedBytes: 0 };
      let timer = 0;
      const report = (soon) => {
        clearTimeout(timer);
        const go = () => {
          row.durationMs = Math.round(performance.now() - t0);
          post('network', { ...row, messages: row.messages.slice() });
        };
        if (soon) timer = setTimeout(go, 1500);
        else go();
      };
      const note = (dir, data) => {
        const text = typeof data === 'string' ? data : data && (data.byteLength ?? data.size) !== undefined ? `[binary ${data.byteLength ?? data.size} bytes]` : String(data);
        const bytes = typeof data === 'string' ? data.length : data?.byteLength ?? data?.size ?? 0;
        if (dir === 'out') {
          row.sent += 1;
          row.sentBytes += bytes;
        } else {
          row.received += 1;
          row.receivedBytes += bytes;
        }
        row.messages.push({ dir, at: Math.round(performance.now() - t0), text: cleanBody(text) || '', size: bytes });
        if (row.messages.length > 100) row.messages.shift();
        report(true);
      };
      sock.addEventListener('open', () => {
        row.protocol = sock.protocol || undefined;
        report(false);
      });
      sock.addEventListener('message', (e) => note('in', e.data));
      sock.addEventListener('error', () => {
        row.error = 'WebSocket error';
        report(true);
      });
      sock.addEventListener('close', (e) => {
        row.closed = { code: e.code, reason: e.reason || undefined, clean: e.wasClean };
        report(false);
      });
      const realSend = sock.send;
      sock.send = function (data) {
        try {
          if (enabled) note('out', data);
        } catch {
          /* ignore */
        }
        return realSend.apply(this, arguments);
      };
      return sock;
    };
    Wrapped.prototype = WS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Object.defineProperty(Wrapped, k, { value: WS[k] });
    window.WebSocket = Wrapped;
  }

  // ---- Everything else the page loads: Resource Timing (sizes, timing breakdown, cache) ----
  const timeOrigin = performance.timeOrigin || Date.now() - performance.now();
  const hookedAt = Date.now();
  const r0 = (v) => (v > 0 ? Math.round(v) : 0);
  function timingRow(e) {
    const start = e.startTime;
    const phase = (a, b) => (e[a] > 0 && e[b] >= e[a] ? Math.round(e[b] - e[a]) : undefined);
    const row = {
      reqId: netId(),
      via: 'timing',
      resourceType: e.entryType === 'navigation' ? 'document' : e.initiatorType || 'other',
      method: 'GET',
      url: redactUrl(e.name),
      startedAt: Math.round(timeOrigin + start),
      durationMs: r0(e.duration),
      status: e.responseStatus || undefined,
      protocol: e.nextHopProtocol || undefined,
      transferSize: e.transferSize,
      encodedSize: e.encodedBodySize,
      decodedSize: e.decodedBodySize,
      contentType: e.contentType || undefined,
      renderBlocking: e.renderBlockingStatus === 'blocking' || undefined,
      timing: {
        redirect: phase('redirectStart', 'redirectEnd'),
        dns: phase('domainLookupStart', 'domainLookupEnd'),
        connect: phase('connectStart', 'connectEnd'),
        tls: e.secureConnectionStart > 0 ? phase('secureConnectionStart', 'connectEnd') : undefined,
        waiting: phase('requestStart', 'responseStart'),
        download: phase('responseStart', 'responseEnd'),
        queued: e.fetchStart > 0 ? Math.round(e.fetchStart - start) : undefined,
      },
    };
    // Size 0 with a body = served from the browser cache (same-origin or Timing-Allow-Origin).
    if (e.transferSize === 0 && e.decodedBodySize > 0) row.cache = 'cache';
    return row;
  }
  try {
    // Buffered: the page's first files may finish before this runs. Only requests from (just
    // before) the recording count, so a page that was already open doesn't list its old files.
    const recent = (e) => timeOrigin + e.startTime > hookedAt - 15000;
    // fetch/XHR timing rows are merged into the wrappers' rows by the player.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (enabled && recent(e)) post('network', timingRow(e));
    }).observe({ type: 'resource', buffered: true });
    // The page itself, once (Chrome can report it again when it finishes loading).
    let navDone = false;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (navDone || !enabled || !recent(e) || !(e.responseEnd > 0)) continue;
        navDone = true;
        post('network', timingRow(e));
      }
    }).observe({ type: 'navigation', buffered: true });
  } catch {
    /* old browser */
  }
})();

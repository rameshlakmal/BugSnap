// Background service worker: starts and stops recordings, gathers metadata,
// tracks navigation, and routes page events to whichever recorder is active.
//
// Recording state lives in chrome.storage.session (survives worker restarts, and
// content scripts react to it). Status flow:
//   starting -> countdown -> recording <-> paused -> stopping -> (cleared)

export const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:4800',
  uploadToken: '',
  reporterName: '',
  captureLocation: true,
};

const HOOK_SCRIPT_ID = 'screenrec-page-hook';
// The recorder window opens compact and fits itself to its content; it grows to
// PICKER_WINDOW only while Chrome's screen picker is open (see recorder.js).
const RECORDER_WINDOW = { width: 560, height: 400 };
const LIBRARY_WINDOW = { width: 1200, height: 800 };

// Let content scripts read the recording state.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

// ---------------------------------------------------------------- state

let recCache; // undefined = not loaded yet in this worker lifetime

async function getRec() {
  if (recCache === undefined) recCache = (await chrome.storage.session.get('rec')).rec || null;
  return recCache;
}

async function setRec(rec) {
  recCache = rec || null;
  if (rec) await chrome.storage.session.set({ rec });
  else await chrome.storage.session.remove('rec');
}

async function patchRec(patch) {
  const rec = await getRec();
  if (!rec) return null;
  const next = { ...rec, ...patch };
  await setRec(next);
  return next;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/**
 * Public share link for a recording. The server reserves it on Google Drive when recording
 * starts; for a very short recording that may still be in flight, so try a few times.
 */
async function shareUrlOf(id) {
  const { serverUrl } = await getSettings();
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${serverUrl}/api/recordings/${encodeURIComponent(id)}?events=0`).then((res) => res.json());
      if (r.shareUrl || !r.driveConnected) return r.shareUrl || null;
    } catch {
      return null;
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return null;
}

/**
 * Public link for any recording, asking the server to reserve one (and start the Drive upload)
 * when it has none yet. Returns { url, isPublic, error }. Remembered in lastResult/recent.
 */
async function publicLinkFor(id) {
  const { serverUrl } = await getSettings();
  const local = `${serverUrl}/r/${id}`;
  try {
    const res = await fetch(`${serverUrl}/api/recordings/${encodeURIComponent(id)}/share`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.shareUrl) return { url: body.viewerUrl || local, isPublic: false, error: body.error || `Server answered ${res.status}` };
    const { lastResult, recent = [] } = await chrome.storage.local.get(['lastResult', 'recent']);
    const patch = (e) => (e && e.id === id ? { ...e, shareUrl: body.shareUrl } : e);
    await chrome.storage.local.set({ lastResult: patch(lastResult), recent: recent.map(patch) });
    return { url: body.shareUrl, isPublic: true };
  } catch {
    return { url: local, isPublic: false, error: `Can't reach the server (${serverUrl})` };
  }
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

/** Sends to the active recorder page. Resolves false when no recorder is alive to receive it. */
async function toRecorder(msg) {
  try {
    await chrome.runtime.sendMessage({ target: 'recorder', ...msg });
    return true;
  } catch {
    return false; // "Receiving end does not exist"
  }
}

/** Removes a half-made recording from the server (best effort). */
async function discardRemote(rec) {
  if (!rec?.id) return;
  const s = await getSettings();
  await fetch(`${s.serverUrl}/api/recordings/${rec.id}`, { method: 'DELETE', headers: s.uploadToken ? { 'X-Upload-Token': s.uploadToken } : {} }).catch(() => {});
}

/** The recorder page died (crash, reload, window closed): reset so the user can record again. */
async function recorderLost(rec, message) {
  await chrome.storage.local.set({ lastError: { message, at: Date.now() } });
  await discardRemote(rec);
  await cleanup(rec);
}

// ---------------------------------------------------------------- page hook (console + network)

// page-hook.js wraps console/fetch/XHR. It is registered only while recording so
// that pages which are never recorded keep their original console call sites.
async function enablePageHook(rec) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [HOOK_SCRIPT_ID] }).catch(() => {});
    await chrome.scripting.registerContentScripts([
      { id: HOOK_SCRIPT_ID, js: ['page-hook.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false },
    ]);
  } catch (err) {
    console.warn('Could not register page hook', err);
  }
  const tabs = rec.mode === 'tab' ? [{ id: rec.tabId }] : await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] });
  await Promise.all(
    tabs.map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['page-hook.js'], world: 'MAIN', injectImmediately: true }).catch(() => {})),
  );
}

async function disablePageHook() {
  await chrome.scripting.unregisterContentScripts({ ids: [HOOK_SCRIPT_ID] }).catch(() => {});
}

// ---------------------------------------------------------------- metadata

async function pageInfo(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'content:viewport' });
  } catch {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          title: document.title,
          url: location.href,
        }),
      });
      return res?.result || {};
    } catch {
      return {}; // chrome:// pages and the Web Store cannot be scripted
    }
  }
}

async function buildMeta(mode, tabId) {
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  const [win, platform, page] = await Promise.all([chrome.windows.get(tab.windowId), chrome.runtime.getPlatformInfo(), pageInfo(tabId)]);
  return {
    mode,
    reporter: settings.reporterName || undefined,
    title: tab.title,
    startUrl: tab.url,
    recordedAt: new Date().toISOString(),
    window: { width: win.width, height: win.height, state: win.state },
    viewport: page.viewport,
    devicePixelRatio: page.devicePixelRatio,
    referrer: page.referrer,
    platform: { os: platform.os, arch: platform.arch },
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

// ---------------------------------------------------------------- screenshots

/** base64 of an ArrayBuffer without blowing the call stack on large images. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Capture the visible tab first (so nothing of ours is in it), then let the user pick an area
 * on the page. The capture waits in session storage until the selection comes back.
 */
async function startSnap(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || '')) throw new Error("This page can't be captured. Open a website first.");
  // Give the panel a moment to close so it isn't in the picture.
  await new Promise((r) => setTimeout(r, 220));
  const [image, meta] = await Promise.all([
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
    buildMeta('screenshot', tabId),
  ]);
  await chrome.storage.session.set({ snapPending: { tabId, windowId: tab.windowId, image, meta: { ...meta, type: 'screenshot', takenAt: new Date().toISOString() } } });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['snip.js'] });
}

async function finishSnap({ rect, vw, vh }, tabId) {
  const { snapPending: p } = await chrome.storage.session.get('snapPending');
  await chrome.storage.session.remove('snapPending');
  if (!p || p.tabId !== tabId) return;
  const bitmap = await createImageBitmap(await (await fetch(p.image)).blob());
  // The capture is in device pixels; the selection is in CSS pixels.
  const scale = bitmap.width / vw;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scale));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  const image = `data:image/png;base64,${toBase64(await png.arrayBuffer())}`;
  await chrome.storage.session.set({
    snapDraft: { image, width: sw, height: sh, meta: { ...p.meta, selection: rect, viewport: p.meta.viewport || { width: vw, height: vh }, scale } },
  });
  // The editor opens over the page it was taken from (as its own tab where that isn't possible).
  await showCreateDialog('snap.html?embed=1', tabId, 'snap.html');
}

// ---------------------------------------------------------------- create dialog
// After a recording or screenshot: a large dialog over the page (like a lightbox) with the
// video or editor on the left and "Create a [Link to share | GitHub issue]" on the right.

/** Runs inside the page: an isolated (shadow DOM) backdrop + card holding the extension page. */
function mountCreateOverlay(src) {
  document.getElementById('bugsnap-create')?.remove();
  const host = document.createElement('div');
  host.id = 'bugsnap-create';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .back { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 24px; box-sizing: border-box;
      background: rgb(24 24 27 / 0.45); backdrop-filter: blur(2px); animation: in .18s ease-out; }
    .card { width: min(1480px, 100%); height: min(880px, 100%); border-radius: 20px; overflow: hidden; background: #fff;
      box-shadow: 0 30px 80px rgb(0 0 0 / 0.3); animation: rise .26s cubic-bezier(0.16, 1, 0.3, 1); }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; color-scheme: light; }
    .back.out { animation: out .16s ease-in forwards; }
    @keyframes in { from { opacity: 0; } }
    @keyframes out { to { opacity: 0; } }
    @keyframes rise { from { opacity: 0; transform: translateY(12px) scale(0.985); } }
  </style><div class="back"><div class="card"><iframe allow="clipboard-write; clipboard-read; autoplay; fullscreen" title="BugSnap"></iframe></div></div>`;
  const frame = root.querySelector('iframe');
  frame.src = src;
  const html = document.documentElement;
  const overflow = html.style.overflow;
  html.style.overflow = 'hidden';
  html.append(host);
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow || e.data?.source !== 'bugsnap-overlay' || e.data.type !== 'close') return;
    window.removeEventListener('message', onMessage);
    root.querySelector('.back').classList.add('out');
    setTimeout(() => {
      host.remove();
      html.style.overflow = overflow;
    }, 160);
  };
  window.addEventListener('message', onMessage);
  frame.focus();
}

/** Show pagePath over the tab the user is looking at; fallbackPath opens as a tab instead. */
async function showCreateDialog(pagePath, preferTabId, fallbackPath = pagePath) {
  let tab = preferTabId ? await chrome.tabs.get(preferTabId).catch(() => null) : null;
  if (!tab?.active) {
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then((all) => all.sort((a, b) => Number(b.focused) - Number(a.focused)));
    if (win) [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  }
  try {
    if (!tab || !/^(https?|file):/.test(tab.url || '')) throw new Error('This page does not allow extensions');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: mountCreateOverlay, args: [chrome.runtime.getURL(pagePath)] });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } catch {
    await chrome.tabs.create({ url: fallbackPath, windowId: tab?.windowId, index: tab ? tab.index + 1 : undefined });
  }
}

// ---------------------------------------------------------------- start / stop

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

/** Bounds of a window of the given size, centred on the last focused browser window. */
async function centredBounds({ width, height }) {
  const anchor = await chrome.windows.getLastFocused().catch(() => null);
  if (!anchor || anchor.left === undefined) return { width, height };
  return {
    width,
    height,
    left: Math.max(0, Math.round(anchor.left + (anchor.width - width) / 2)),
    top: Math.max(0, Math.round(anchor.top + (anchor.height - height) / 2)),
  };
}

async function openRecorderWindow() {
  return chrome.windows.create({ url: 'recorder.html', type: 'popup', focused: true, ...(await centredBounds(RECORDER_WINDOW)) });
}

/** One Recordings window: focus it if it is already open. */
async function openLibrary() {
  const url = chrome.runtime.getURL('library.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true, state: 'normal' });
    return;
  }
  await chrome.windows.create({ url, type: 'popup', focused: true, ...(await centredBounds(LIBRARY_WINDOW)) });
}

/** Open a recording in a normal browser window (the library window has no tab strip). */
async function openInBrowser(url) {
  if (!String(url || '').startsWith('http://') && !String(url || '').startsWith('https://')) throw new Error('Invalid link');
  const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then((all) => all.sort((a, b) => Number(b.focused) - Number(a.focused)));
  if (!win) return chrome.windows.create({ url, focused: true });
  await chrome.tabs.create({ windowId: win.id, url, active: true });
  await chrome.windows.update(win.id, { focused: true });
}

async function startRecording({ mode, tabId, streamId }) {
  const existing = await getRec();
  if (existing) throw new Error('Already recording');

  const meta = await buildMeta(mode, tabId);
  // `rec` is readable by content scripts, so settings (upload token) are NOT stored here;
  // the recorder fetches them in recorder:hello.
  const rec = {
    status: 'starting',
    mode,
    tabId,
    recorderKind: mode === 'tab' ? 'offscreen' : 'window',
    pending: { mode, streamId, meta },
  };
  await setRec(rec);
  await chrome.storage.local.remove(['lastError', 'lastResult']);

  try {
    if (mode === 'tab') {
      await closeOffscreen();
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'GEOLOCATION'],
        justification: 'Record the selected tab with MediaRecorder and stamp the recording with location.',
      });
    } else {
      const win = await openRecorderWindow();
      await patchRec({ windowId: win.id });
    }
  } catch (err) {
    await cleanup(await getRec());
    throw err;
  }
}

async function control(action) {
  const rec = await getRec();
  if (!rec) return;
  if (action === 'toggle-pause') action = rec.status === 'paused' ? 'resume' : 'pause';

  // Before capture exists (desktop picker still open) there is nothing to save.
  if (rec.status === 'starting') {
    if (action === 'stop' || action === 'discard') await cleanup(rec);
    return;
  }
  if (rec.status === 'countdown' && action !== 'discard' && action !== 'stop') return;
  // The recorder decides what Stop means (during its countdown it discards).
  const delivered = await toRecorder({ type: action });
  if (!delivered) await recorderLost(rec, 'Recording stopped unexpectedly and was not saved.');
}

async function cleanup(rec) {
  await setRec(null);
  badge('');
  await disablePageHook();
  if (rec?.recorderKind === 'offscreen') await closeOffscreen().catch(() => {});
  if (rec?.recorderKind === 'window' && rec.windowId) chrome.windows.remove(rec.windowId).catch(() => {});
}

// ---------------------------------------------------------------- events

async function forward(events) {
  const rec = await getRec();
  // Paused/stopping still accepted: batches flushed at that moment carry events from before it,
  // and the recorder keeps only those timestamped before the pause or stop.
  if (!rec || !['recording', 'paused', 'stopping'].includes(rec.status)) return;
  const relevant = rec.mode === 'tab' ? events.filter((e) => e.tabId === undefined || e.tabId === rec.tabId) : events;
  if (relevant.length) toRecorder({ type: 'events', events: relevant });
}

const emit = (event) => forward([event]);

// ---- Every request of the recorded tab (scripts, styles, images, fonts, the page itself, API
// calls): status, headers, server IP and cache, like the browser's Network panel. The page hook
// adds bodies (fetch/XHR) and timing; the player merges the rows. Headers that carry secrets are
// hidden. BugSnap's own requests (uploads) have no tab and are never included.
const NET_SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
const NET_SECRET_PARAM = /passw|pwd|secret|token|api[-_]?key|auth|session|signature|^sig$|^code$|^state$|credential/i;
const netStarts = new Map(); // requestId -> { ts, headers }

function netRedactUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (NET_SECRET_PARAM.test(key)) url.searchParams.set(key, '[redacted]');
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return String(raw);
  }
}

const netHeaders = (list) =>
  Array.isArray(list) && list.length ? list.slice(0, 100).map((h) => [h.name, NET_SECRET_HEADER.test(h.name) ? '••••' : String(h.value ?? (h.binaryValue ? '[binary]' : '')).slice(0, 1000)]) : undefined;

const netWanted = (d) => d.tabId >= 0 && /^(https?|wss?):/.test(d.url) && recCache && ['recording', 'paused', 'stopping'].includes(recCache.status) && (recCache.mode !== 'tab' || d.tabId === recCache.tabId);

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (!netWanted(d)) return;
    netStarts.set(d.requestId, { ts: d.timeStamp, headers: netHeaders(d.requestHeaders) });
    if (netStarts.size > 5000) netStarts.delete(netStarts.keys().next().value);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders'],
);

function netDone(d, failed) {
  const start = netStarts.get(d.requestId);
  netStarts.delete(d.requestId);
  if (!netWanted(d)) return;
  const startedAt = Math.round(start?.ts || d.timeStamp);
  emit({
    type: 'network',
    ts: Date.now(),
    tabId: d.tabId,
    via: 'web',
    reqId: `w${d.requestId}`,
    resourceType: d.type,
    method: d.method,
    url: netRedactUrl(d.url),
    status: failed ? 0 : d.statusCode,
    statusLine: d.statusLine || undefined,
    error: failed ? d.error : undefined,
    ip: d.ip || undefined,
    fromCache: d.fromCache || undefined,
    initiator: d.initiator || undefined,
    frame: d.frameId || undefined,
    requestHeaders: start?.headers,
    responseHeaders: netHeaders(d.responseHeaders),
    startedAt,
    durationMs: Math.max(0, Math.round(d.timeStamp - startedAt)),
  });
}
chrome.webRequest.onCompleted.addListener((d) => netDone(d, false), { urls: ['<all_urls>'] }, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener((d) => netDone(d, true), { urls: ['<all_urls>'] });
getRec(); // the request listeners above read the cached state

const pendingTransitions = new Map();

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  pendingTransitions.set(d.tabId, { type: d.transitionType, qualifiers: d.transitionQualifiers || [], ts: Date.now() });
});

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url || '';
  }
}

chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const t = pendingTransitions.get(d.tabId) || { type: 'link', qualifiers: [], ts: Date.now() };
  pendingTransitions.delete(d.tabId);
  const rec = await getRec();
  if (!rec || rec.status !== 'recording') return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  const title = tab?.title && tab.title !== d.url ? tab.title : '';
  const where = title ? `the "${title}" page` : shortUrl(d.url);
  let text;
  if (t.type === 'reload') text = 'Reloads the page';
  else if (t.qualifiers.includes('forward_back')) text = `Goes back to ${where}`;
  else if (t.type === 'typed' || t.qualifiers.includes('from_address_bar')) text = `Opens ${shortUrl(d.url)} from the address bar`;
  else if (t.type === 'form_submit') text = `Is taken to ${where} after submitting the form`;
  else if (t.qualifiers.includes('server_redirect') || t.qualifiers.includes('client_redirect')) text = `Is redirected to ${where}`;
  else text = `Navigates to ${where}`;
  emit({ type: 'navigation', ts: t.ts, tabId: d.tabId, url: d.url, title, transition: t.type, text });
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const rec = await getRec();
  if (!rec || rec.status !== 'recording') return;
  const ts = Date.now();
  // Single-page apps usually update document.title just after the route change.
  setTimeout(async () => {
    const tab = await chrome.tabs.get(d.tabId).catch(() => null);
    const title = tab?.title && tab.title !== d.url ? tab.title : '';
    emit({ type: 'navigation', ts, tabId: d.tabId, url: d.url, title, transition: 'history', text: `Navigates to ${shortUrl(d.url)}${title ? ` ("${title}")` : ''}` });
  }, 400);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const rec = await getRec();
  if (!rec || rec.status !== 'recording' || rec.mode !== 'desktop') return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  emit({ type: 'navigation', ts: Date.now(), tabId, url: tab.url, title: tab.title, transition: 'tab_switch', text: `Switches to the "${tab.title || shortUrl(tab.url)}" tab` });
});

// ---------------------------------------------------------------- messages

const handlers = {
  'popup:start': async (msg) => {
    try {
      // The in-page panel may not be allowed to call tabCapture itself; the toolbar click
      // already granted it for this tab, so ask from here instead.
      if (msg.mode === 'tab' && !msg.streamId) msg.streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId });
      return await startRecording(msg);
    } catch (err) {
      // The popup has already closed; the page's control bar shows this.
      await chrome.storage.local.set({ lastError: { message: err.message, at: Date.now() } });
      throw err;
    }
  },
  'library:open': () => openLibrary(),
  'open:url': (msg) => openInBrowser(msg.url),
  'share:link': (msg) => publicLinkFor(msg.id),
  // A share link was made from the create dialog: show it in Recordings.
  'recording:shared': async (msg) => {
    const { recent = [] } = await chrome.storage.local.get('recent');
    await chrome.storage.local.set({ recent: recent.map((r) => (r.id === msg.id ? { ...r, shareUrl: msg.url || r.shareUrl } : r)) });
  },
  'snap:start': async (msg) => {
    try {
      await startSnap(msg.tabId);
    } catch (err) {
      await chrome.storage.local.set({ lastError: { message: err.message, at: Date.now() } });
      throw err;
    }
  },
  // Open the editor for a saved screenshot (from Recordings, the player, or the popup).
  'snap:edit': async (msg) => {
    if (!/^[A-Za-z0-9]{6,20}$/.test(String(msg.id || ''))) throw new Error('Unknown screenshot');
    const url = chrome.runtime.getURL(`snap.html?id=${msg.id}`);
    const [open] = await chrome.tabs.query({ url });
    if (open) {
      await chrome.tabs.update(open.id, { active: true });
      await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then((all) => all.sort((x, y) => Number(y.focused) - Number(x.focused)));
    if (win) {
      await chrome.tabs.create({ windowId: win.id, url, active: true });
      await chrome.windows.update(win.id, { focused: true });
    } else {
      await chrome.windows.create({ url, focused: true });
    }
  },
  'settings:open': () => chrome.runtime.openOptionsPage(),
  'snip:done': (msg, sender) => finishSnap(msg, sender.tab?.id),
  'snip:cancel': () => chrome.storage.session.remove('snapPending'),
  // The editor saved a screenshot: list it with the recordings.
  'snap:saved': async (msg) => {
    const { recent = [] } = await chrome.storage.local.get('recent');
    const entry = { id: msg.id, viewerUrl: msg.viewerUrl, shareUrl: msg.shareUrl || null, title: msg.title || 'Screenshot', mode: 'screenshot', type: 'screenshot', createdAt: new Date().toISOString() };
    await chrome.storage.local.set({ recent: [entry, ...recent.filter((r) => r.id !== msg.id)].slice(0, 50), lastResult: entry });
  },
  control: (msg) => control(msg.action),

  'content:hello': async (_msg, sender) => {
    const rec = await getRec();
    const { pending, ...publicRec } = rec || {};
    return { tabId: sender.tab?.id ?? null, rec: rec ? publicRec : null };
  },

  'page:events': async (msg, sender) => {
    if (!sender.tab || !Array.isArray(msg.events)) return;
    const tabId = sender.tab.id;
    await forward(msg.events.map((e) => ({ ...e, tabId })));
  },

  'recorder:hello': async () => {
    const rec = await getRec();
    if (!rec?.pending) return null;
    if (rec.status !== 'starting') {
      // The recorder page reloaded mid-recording; its capture is gone.
      await recorderLost(rec, 'Recorder was reloaded. Recording lost.');
      return null;
    }
    // Hand over the one-time tab capture id and drop it from shared state.
    await patchRec({ pending: { ...rec.pending, streamId: undefined } });
    return { ...rec.pending, settings: await getSettings() };
  },

  'recorder:countdown': async (msg) => {
    const rec = await patchRec({ status: 'countdown', countdownEndsAt: msg.endsAt, id: msg.id, viewerUrl: msg.viewerUrl });
    badge('...', '#5b616e');
    if (rec) await enablePageHook(rec);
    // The recorder window has done its job (the picker); get it out of the way.
    if (rec?.recorderKind === 'window' && rec.windowId) chrome.windows.update(rec.windowId, { state: 'minimized' }).catch(() => {});
  },

  'recorder:started': async (msg) => {
    const rec = await patchRec({ status: 'recording', startedAt: msg.startedAt, pausedMs: 0, pausedAt: null, countdownEndsAt: null });
    badge('REC', '#e5484d');
    if (!rec) return;
    const tab = await chrome.tabs.get(rec.tabId).catch(() => null);
    emit({
      type: 'navigation',
      ts: msg.startedAt,
      tabId: rec.tabId,
      url: tab?.url,
      title: tab?.title,
      transition: 'start',
      text: `Starts on ${tab?.title ? `the "${tab.title}" page` : shortUrl(tab?.url)}`,
    });
  },

  'recorder:paused': async (msg) => {
    await patchRec({ status: 'paused', pausedAt: msg.pausedAt });
    badge('II', '#b26b00');
  },

  'recorder:resumed': async (msg) => {
    await patchRec({ status: 'recording', pausedAt: null, pausedMs: msg.pausedMs });
    badge('REC', '#e5484d');
  },

  'recorder:stopping': async () => {
    await patchRec({ status: 'stopping' });
    badge('...', '#5b616e');
  },

  'recorder:done': async (msg) => {
    const rec = await getRec();
    const { recent = [] } = await chrome.storage.local.get('recent');
    const entry = {
      id: msg.id,
      viewerUrl: msg.viewerUrl,
      shareUrl: await shareUrlOf(msg.id),
      title: rec?.pending?.meta?.title || 'Recording',
      mode: rec?.mode,
      durationMs: msg.durationMs || null,
      createdAt: new Date().toISOString(),
    };
    // The create dialog opens over the page (no "Saved" bar).
    entry.dialog = true;
    await chrome.storage.local.set({ recent: [entry, ...recent.filter((r) => r.id !== msg.id)].slice(0, 50), lastResult: entry });
    await cleanup(rec);
    if (/^[A-Za-z0-9]{6,20}$/.test(String(msg.id || ''))) await showCreateDialog(`review.html?id=${msg.id}`, rec?.tabId).catch(() => {});
  },

  'recorder:discarded': async () => {
    await cleanup(await getRec());
  },

  'recorder:error': async (msg) => {
    const rec = await getRec();
    await chrome.storage.local.set({ lastError: { message: msg.message, at: Date.now() } });
    await cleanup(rec);
    badge('!', '#e5484d');
    setTimeout(() => badge(''), 6000);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type || msg.target === 'recorder') return;
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => reply({ ok: true, result }), (err) => reply({ ok: false, error: err.message }));
  return true; // async reply
});

// The plain-popup fallback is per tab: drop it once the tab is on a normal page again.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && /^(https?|file):/.test(info.url)) chrome.action.setPopup({ tabId, popup: '' }).catch(() => {});
});

// Toolbar click: show the rounded in-page panel. Pages that block extensions (chrome://,
// the Web Store, PDFs) fall back to Chrome's regular popup.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!/^(https?|file):/.test(tab.url || '')) throw new Error('restricted page');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['panel.js'] });
  } catch {
    await chrome.action.setPopup({ tabId: tab.id, popup: 'popup.html' });
    // openPopup needs Chrome 127+; on older versions the next click opens the popup.
    chrome.action.openPopup?.({ windowId: tab.windowId }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-screenshot') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) startSnap(tab.id).catch((err) => chrome.storage.local.set({ lastError: { message: err.message, at: Date.now() } }));
    return;
  }
  if (command === 'stop-recording') control('stop');
  if (command === 'toggle-pause') control('toggle-pause');
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const rec = await getRec();
  if (!rec || rec.recorderKind !== 'window' || rec.windowId !== windowId) return;
  const closed = { ...rec, windowId: null };
  if (rec.status === 'starting') return cleanup(closed);
  await recorderLost(
    closed,
    rec.status === 'stopping'
      ? 'Recorder window closed while saving. Recording lost.'
      : 'Recorder window closed. Recording lost. Minimise it next time.',
  );
});

// ---- Access key for a hosted server. Chrome adds it (X-Upload-Token) to every request for the
// BugSnap server that comes from this extension or from the server's own pages: fetches,
// thumbnails, video previews and the GitHub window inside the screenshot editor alike.
// Requests started by any other website never get it.
const AUTH_RULE_ID = 1;
async function syncServerAuth() {
  const { serverUrl, uploadToken } = await getSettings();
  let host = '';
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    host = '';
  }
  const addRules = host && uploadToken
    ? [{
        id: AUTH_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Upload-Token', operation: 'set', value: uploadToken }] },
        condition: {
          requestDomains: [host],
          initiatorDomains: [chrome.runtime.id, host],
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other', 'script', 'stylesheet', 'font'],
        },
      }]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [AUTH_RULE_ID], addRules }).catch((err) => console.warn('BugSnap: access key rule', err));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncServerAuth();
});
syncServerAuth();

// Inject the lightweight UI/action scripts into tabs that were open before install/update.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/icons-page.js', 'content.js', 'overlay.js'] }).catch(() => {});
  }
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await disablePageHook();
});

// A browser restart ends any recording; clear state left behind.
chrome.runtime.onStartup.addListener(async () => {
  await setRec(null);
  badge('');
  await disablePageHook();
});

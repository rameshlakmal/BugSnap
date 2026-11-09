// BugSnap player: video with custom controls, and steps, console and network logs kept in
// sync with playback. All page-derived text is rendered with textContent.
//
// Two sources:
//  - local server: /r/<id>, data from /api/recordings/<id> (review screen, editing, upload status)
//  - public player (GitHub Pages, built by scripts/build-viewer.js): ?id=<manifest>&v=<video>,
//    data and video streamed straight from Google Drive with a browser API key.

const $ = (id) => document.getElementById(id);
const CONFIG = globalThis.SCREENREC_CONFIG || {};
const params = new URLSearchParams(location.search);
// Inside the extension (?embed=…): github = only the GitHub issue window (older editor),
// create = the "Create a link / GitHub issue" dialog after a capture, panel = just its right side
// (next to the screenshot editor).
const embedMode = window.parent !== window ? params.get('embed') : null;
const embedded = Boolean(embedMode);
const embedGh = embedMode === 'github';
const tellParent = (msg) => embedded && window.parent.postMessage({ source: 'bugsnap-embed', ...msg }, '*');
const driveMode = Boolean(CONFIG.driveApiKey);
const id = driveMode ? params.get('id') || '' : location.pathname.split('/').filter(Boolean).pop();
const videoParam = params.get('v') || '';
const driveMedia = (fileId) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(CONFIG.driveApiKey)}`;
const drivePreview = (fileId) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
const video = $('video');
const ICONS = globalThis.ScreenRecIcons || {};

let rec;
let durationSec = 0;
const lists = { steps: [], console: [], network: [] };
let activeTab = 'steps';
let level = 'all';
let fallbackActive = false;
const isShot = () => rec?.type === 'screenshot';
let shotSetup = false;

if (driveMode) document.body.classList.add('public');

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Bundled Phosphor icon (trusted SVG string). */
function icon(name, cls = 'icon') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = ICONS[name] || '';
  return span;
}

function paintIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = ICONS[el.dataset.icon] || ''));
}

function setIcon(el, name) {
  const slot = el.querySelector('[data-icon]') || el;
  slot.dataset.icon = name;
  slot.innerHTML = ICONS[name] || '';
}

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

function relative(iso) {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(diff)) return '';
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Seconds into the video for an event, with paused stretches removed. */
function offsetOf(ev) {
  const ts = ev.type === 'network' && ev.startedAt ? ev.startedAt : ev.ts;
  let paused = 0;
  for (const p of rec.pauses || []) {
    if (p.start >= ts) break;
    paused += Math.min(ts, p.end) - p.start;
  }
  return Math.max(0, (ts - rec.startedAt - paused) / 1000);
}

const isHttp = (u) => /^https?:\/\//i.test(u || '');
const isNetError = (ev) => ev.status === 0 || ev.status >= 400;

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url || '';
  }
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url || '';
  }
}

const pageUrl = () => {
  const q = new URLSearchParams(location.search);
  q.delete('t');
  q.delete('review');
  const s = q.toString();
  return `${location.origin}${location.pathname}${s ? `?${s}` : ''}`;
};

/** The link to hand out: the public player (reserved when recording started), else this page. */
const shareLink = () => (driveMode ? pageUrl() : rec?.shareUrl || rec?.viewerUrl || pageUrl());
const isPublicLink = () => driveMode || Boolean(rec?.shareUrl);
const withTime = (url, sec) => `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(sec)}`;

// ---------------------------------------------------------------- load

async function fetchRecording() {
  if (driveMode) {
    if (!id) return null;
    // index.html starts this request before any script loads (see build-viewer.js).
    const early = globalThis.__bugsnapManifest;
    globalThis.__bugsnapManifest = null;
    const m = early ? await early : await fetch(driveMedia(id), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!m || !['bugsnap', 'screenrec'].includes(m.app)) return null;
    if (m.status === 'processing') return { status: 'uploading', meta: m.record?.meta || {}, createdAt: m.record?.createdAt, video: m.video, events: [] };
    return { ...m.record, events: m.events || [], video: m.video, posterData: m.posterData, poster: m.poster, status: 'ready' };
  }
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

/** Fade out the loading screen: once the video (or screenshot) can show, or after a while anyway. */
function hideBoot() {
  const el = $('boot');
  if (!el || el.classList.contains('out')) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 400);
}
setTimeout(hideBoot, 12000);

function hideBootWhenShown() {
  if (!rec || rec.status !== 'ready' || fallbackActive) return hideBoot();
  if (isShot()) {
    const img = $('shot');
    return img.complete && img.naturalWidth ? hideBoot() : (img.addEventListener('load', hideBoot, { once: true }), img.addEventListener('error', hideBoot, { once: true }));
  }
  if (video.readyState >= 2) return hideBoot();
  video.addEventListener('loadeddata', hideBoot, { once: true });
  video.addEventListener('error', hideBoot, { once: true });
}

async function load() {
  paintIcons();
  if (driveMode) {
    document.querySelectorAll('[data-local-only]').forEach((el) => el.remove());
    // The video id is in the link, so streaming starts while the logs load.
    if (videoParam) video.src = driveMedia(videoParam);
  }
  if (embedded) document.documentElement.classList.add('embed', `embed-${embedMode}`);
  rec = await fetchRecording().catch(() => null);
  if (embedded && (driveMode || !rec)) return tellParent({ type: 'error', message: rec ? 'This needs the BugSnap server.' : 'Not found on the BugSnap server.' });
  if (!rec) {
    hideBoot();
    if (driveMode && videoParam) return useDriveFallback('Recording details could not be loaded, so steps and logs are not shown. The video plays in Google Drive’s player.');
    document.querySelector('.topbar').hidden = true;
    $('layout').hidden = true;
    $('notfound').hidden = false;
    document.title = 'Recording not found · BugSnap';
    return;
  }
  render();
  hideBootWhenShown();
  if (needsPoll()) poll();
  const tab = location.hash.slice(1);
  document.querySelector(`[data-tab="${CSS.escape(tab)}"]`)?.click();
  const t = Number(params.get('t'));
  if (t > 0) video.addEventListener('loadedmetadata', () => (video.currentTime = t), { once: true });
  if (!driveMode && params.has('review')) openReview();
  if (!driveMode && (params.has('create') || embedMode === 'create' || embedMode === 'panel')) {
    openCreate();
    tellParent({ type: 'ready' });
  }
  if (embedGh) {
    openGitHub();
    tellParent({ type: 'ready' });
  }
}

const uploading = (r) => ['pending', 'uploading', 'reserved'].includes(r?.drive?.status);
const needsPoll = () => (driveMode ? rec.status === 'uploading' : rec.status !== 'ready' || uploading(rec));

let pollTimer = null;
function poll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await fetchRecording().catch(() => null);
    if (!r) return;
    const becameReady = rec.status !== 'ready' && r.status === 'ready';
    if (becameReady) {
      const t = video.currentTime;
      rec = r;
      render();
      crMedia();
      if (t) video.addEventListener('loadedmetadata', () => (video.currentTime = t), { once: true });
    } else {
      rec = { ...rec, drive: r.drive, shareUrl: r.shareUrl, driveConnected: r.driveConnected, meta: r.meta || rec.meta };
      renderBanner();
      renderDetails();
      crNote();
    }
    if (!needsPoll()) clearInterval(pollTimer);
  }, driveMode ? 5000 : 2500);
}

// ---------------------------------------------------------------- render

function render() {
  durationSec = (rec.durationMs || 0) / 1000;
  renderDetails();

  const stateEl = $('stageState');
  if (isShot()) setupShot();
  $('controls').hidden = rec.status !== 'ready' || fallbackActive || isShot();
  if (rec.status !== 'ready') {
    // Recording, processing, or (public link) still uploading to Drive.
    stateEl.hidden = false;
    $('stageTitle').textContent = rec.status === 'recording' ? 'Still recording' : driveMode ? 'Uploading…' : 'Preparing video…';
    $('stageText').textContent = driveMode ? 'This recording is still uploading. It opens here automatically.' : 'This page updates by itself.';
    video.removeAttribute('src');
    $('bigPlay').hidden = true;
  } else if (isShot()) {
    stateEl.hidden = true;
    // Local: the version query shows edits made in the editor.
    const src = driveMode ? driveMedia(rec.video?.id || videoParam) : `/api/recordings/${encodeURIComponent(id)}/image?v=${encodeURIComponent(rec.updatedAt || '')}`;
    if ($('shot').getAttribute('src') !== src) $('shot').src = src;
    $('shotLink').href = src;
    $('download').href = driveMode ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(rec.video?.id || videoParam)}` : src;
    if (driveMode) $('download').removeAttribute('download');
    else $('download').setAttribute('download', `screenshot-${id}.png`);
    $('download').dataset.tip = 'Download image';
  } else {
    stateEl.hidden = true;
    if (driveMode) {
      const vid = rec.video?.id || videoParam;
      if (!video.src || !video.src.includes(encodeURIComponent(vid))) video.src = driveMedia(vid);
      if (rec.posterData) video.poster = rec.posterData;
      else if (rec.poster?.id) video.poster = driveMedia(rec.poster.id);
      $('download').href = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(vid)}`;
      $('download').removeAttribute('download');
      $('download').target = '_blank';
      watchForStall();
    } else {
      const src = `/api/recordings/${encodeURIComponent(id)}/video`;
      // The version query makes the browser fetch the processed file once it replaces the raw one.
      const want = `${src}?v=${encodeURIComponent(rec.videoRev ? `t${rec.videoRev}` : rec.processing ? 'p' : rec.updatedAt || '')}`;
      if (!video.src.endsWith(want)) video.src = want;
      if (rec.hasPoster) video.poster = `/api/recordings/${encodeURIComponent(id)}/poster`;
      $('download').href = src;
      $('download').setAttribute('download', `recording-${id}.webm`);
    }
    $('bigPlay').hidden = !video.paused || video.currentTime > 0;
  }
  const driveVideo = driveMode ? rec.video?.id || videoParam : rec.drive?.status === 'done' ? rec.drive.videoId : null;
  $('openDrive').hidden = !driveVideo;
  if (driveVideo) $('openDrive').href = `https://drive.google.com/file/d/${driveVideo}/view`;
  renderBanner();

  // Events originate in arbitrary web pages: coerce every displayed field to a string.
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  const events = (rec.events || [])
    .filter((e) => e && typeof e.ts === 'number')
    .map((e) => ({ ...e, text: str(e.text), message: str(e.message) ?? '', url: str(e.url), method: str(e.method), selector: str(e.selector), stack: str(e.stack), source: str(e.source), responseBody: str(e.responseBody), level: str(e.level), status: e.status === undefined || e.status === null ? undefined : Number(e.status) || 0 }));
  const byTime = (a, b) => offsetOf(a) - offsetOf(b);
  lists.steps = events.filter((e) => e.type === 'action' || e.type === 'navigation').sort(byTime);
  lists.console = events.filter((e) => e.type === 'console').sort(byTime);
  lists.network = mergeNetwork(events.filter((e) => e.type === 'network')).sort(byTime);

  setCount('steps', lists.steps.length);
  setCount('console', lists.console.length, lists.console.filter((e) => e.level === 'error').length, 'error');
  setCount('network', lists.network.length, lists.network.filter(isNetError).length, 'failed');

  renderSteps();
  renderConsole();
  renderNetwork();
  renderInfo();
  renderMarkers();
  renderReport();
  sync();
}

// ---------------------------------------------------------------- report tab

let reportDirty = false;

function renderReport() {
  const saved = rec.report?.markdown;
  if (!reportDirty) $('report').value = saved || buildReport();
  $('reportLabel').textContent = saved
    ? `${rec.report.model ? 'Written by Claude' : 'Saved report'}${rec.report.editedAt ? ' · edited' : ''}`
    : 'Draft from the recording';
  if (driveMode) {
    $('report').readOnly = true;
    return;
  }
  if (!$('what').value) $('what').value = rec.meta?.description || '';
  if (!$('writeAi').classList.contains('busy')) $('writeAi').querySelector('span:last-child').textContent = saved && rec.report.model ? 'Rewrite with Claude' : 'Write with Claude';
  const kind = rec.report?.kind || 'bug';
  document.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
}

let aiChecked = false;
async function checkAi() {
  if (driveMode || aiChecked) return;
  aiChecked = true;
  const s = await fetch('/api/ai').then((r) => r.json()).catch(() => null);
  if (s && !s.available) {
    $('writeAi').disabled = true;
    $('aiHint').hidden = false;
    $('aiHint').className = 'ai-hint bad';
    $('aiHint').replaceChildren(
      document.createTextNode(s.provider === 'api' ? 'No Claude API key saved. ' : 'Claude Code was not found on this computer. '),
      h('a', { href: '/settings' }, s.provider === 'api' ? 'Add one in Settings' : 'Choose Claude Code or an API key in Settings'),
    );
  }
}

if (!driveMode) {
  document.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => document.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b))),
  );
  $('writeAi').addEventListener('click', async () => {
    const btn = $('writeAi');
    const hint = $('aiHint');
    if (reportDirty && !confirmOverwrite()) return;
    btn.disabled = true;
    btn.classList.add('busy');
    btn.querySelector('span:last-child').textContent = 'Writing…';
    hint.hidden = false;
    hint.className = 'ai-hint';
    hint.textContent = 'Claude is reading the recording. This takes about 10 seconds.';
    const kind = document.querySelector('[data-kind].on')?.dataset.kind || 'bug';
    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: $('what').value, kind }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server answered ${res.status}`);
      rec.report = body;
      rec.meta = { ...rec.meta, description: $('what').value };
      reportDirty = false;
      $('saveReport').hidden = true;
      renderReport();
      renderDetails();
      hint.hidden = true;
    } catch (err) {
      hint.className = 'ai-hint bad';
      hint.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.querySelector('span:last-child').textContent = rec.report?.markdown ? 'Rewrite with Claude' : 'Write with Claude';
    }
  });
  $('report').addEventListener('input', () => {
    reportDirty = true;
    $('saveReport').hidden = false;
  });
  $('saveReport').addEventListener('click', async () => {
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/report`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: $('report').value }),
    }).catch(() => null);
    if (!res || !res.ok) return flash($('saveReport'), 'warning-circle', "Couldn't save");
    rec.report = await res.json();
    reportDirty = false;
    flash($('saveReport'), 'check', 'Saved');
    setTimeout(() => ($('saveReport').hidden = true), 1400);
    renderReport();
  });
}

function confirmOverwrite() {
  const hint = $('aiHint');
  if (confirmOverwrite.armed) {
    confirmOverwrite.armed = false;
    return true;
  }
  confirmOverwrite.armed = true;
  hint.hidden = false;
  hint.className = 'ai-hint bad';
  hint.textContent = 'You have unsaved edits. Click "Write with Claude" again to replace them.';
  setTimeout(() => (confirmOverwrite.armed = false), 5000);
  return false;
}

function renderDetails() {
  const meta = rec.meta || {};
  const title = meta.title || shortUrl(meta.startUrl) || 'Untitled';
  document.title = `${title} · BugSnap`;
  $('title').textContent = title;
  $('crumbTitle').textContent = title;

  const desc = $('desc');
  desc.className = 'desc';
  if (meta.description) desc.textContent = meta.description;
  else if (!driveMode) {
    desc.classList.add('placeholder');
    desc.replaceChildren(h('button', { type: 'button', onclick: () => openReview() }, 'Add a description'));
  } else desc.textContent = '';
  desc.hidden = !meta.description && driveMode;

  const who = meta.reporter || 'Someone';
  const when = rec.startedAt || rec.createdAt;
  const items = [
    h('div', { class: 'item' }, h('span', { class: 'avatar' }, who.trim().charAt(0) || '?'), h('span', {}, h('strong', {}, who), isShot() ? ' captured this screenshot' : ` recorded this${durationSec ? ` (${fmt(durationSec)})` : ''}`, when ? ` · ${relative(new Date(when).toISOString())}` : '')),
  ];
  for (const issue of rec.github || []) {
    items.push(h('div', { class: 'item' }, h('span', { class: 'avatar drive' }, icon('github-logo')), h('span', {}, 'GitHub issue ', h('a', { href: issue.url, target: '_blank', rel: 'noopener noreferrer' }, `#${issue.number}`), ` in ${issue.repo}`)));
  }
  const d = rec.drive;
  if (!driveMode && d) {
    const text = d.status === 'done' ? 'Shared on Google Drive · anyone with the link can watch' : uploading(rec) ? 'Uploading to Google Drive…' : d.status === 'error' ? 'Google Drive upload failed' : '';
    if (text) items.push(h('div', { class: 'item' }, h('span', { class: 'avatar drive' }, icon(d.status === 'done' ? 'cloud-check' : 'cloud-arrow-up')), h('span', {}, text)));
  }
  $('activity').replaceChildren(...items);
}

/** Status line under the top bar: Drive upload problems, or how to share. */
function renderBanner() {
  const banner = $('banner');
  const action = $('bannerAction');
  const set = (text, { button = null, tone = '' } = {}) => {
    banner.hidden = false;
    banner.className = `banner ${tone}`;
    setIcon($('bannerIcon'), tone === 'bad' ? 'warning-circle' : tone === 'ok' ? 'check' : 'info');
    $('bannerText').textContent = text;
    action.hidden = !button;
    if (button) {
      action.textContent = button.label;
      action.onclick = button.onClick;
    }
  };
  if (driveMode || rec.status !== 'ready') return (banner.hidden = !fallbackActive);
  const d = rec.drive;
  if (!d || d.status === 'done' || uploading(rec)) return (banner.hidden = true);
  const upload = async () => {
    action.disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/drive`, { method: 'POST' }).catch(() => null);
    action.disabled = false;
    if (!res || !res.ok) {
      const b = await res?.json().catch(() => ({}));
      return set(b?.error || 'Could not start the upload.', { tone: 'bad', button: { label: 'Retry', onClick: upload } });
    }
    rec = { ...rec, drive: { ...rec.drive, status: 'pending' } };
    renderBanner();
    renderDetails();
    poll();
  };
  if (d.status === 'error') return set(`Drive upload failed: ${d.error}`, { tone: 'bad', button: { label: 'Retry', onClick: upload } });
  if (rec.driveConnected) return set('Not on Google Drive yet.', { button: { label: 'Upload', onClick: upload } });
  set('Only you can open this link. Connect Google Drive to share it.', { button: { label: 'Connect', onClick: () => (location.href = '/settings') } });
}

// When Google won't stream the file to us (throttled or blocked), Drive's own player still works.
function useDriveFallback(message) {
  hideBoot();
  const vid = rec?.video?.id || videoParam;
  if (!vid || fallbackActive) return;
  fallbackActive = true;
  video.pause();
  video.removeAttribute('src');
  video.load();
  const frame = h('iframe', { src: drivePreview(vid), allow: 'autoplay; fullscreen', allowfullscreen: '', title: 'Recording' });
  video.replaceWith(frame);
  $('controls').hidden = true;
  $('bigPlay').hidden = true;
  $('stageState').hidden = true;
  const banner = $('banner');
  banner.hidden = false;
  banner.className = 'banner';
  setIcon($('bannerIcon'), 'info');
  $('bannerText').textContent = message;
  $('bannerAction').hidden = true;
  if (!rec) {
    $('title').textContent = 'Recording';
    $('desc').hidden = true;
    $('side').hidden = true;
    $('layout').classList.add('no-side', 'side-gone');
  }
}

let stallTimer;
function watchForStall() {
  clearTimeout(stallTimer);
  if (video.readyState >= 2) return;
  stallTimer = setTimeout(() => {
    if (video.readyState >= 2 || fallbackActive) return;
    const banner = $('banner');
    banner.hidden = false;
    banner.className = 'banner';
    setIcon($('bannerIcon'), 'info');
    $('bannerText').textContent = 'The video is slow to load from Google Drive.';
    $('bannerAction').hidden = false;
    $('bannerAction').textContent = 'Use Drive player';
    $('bannerAction').onclick = () => useDriveFallback('Playing with Google Drive’s player. Steps still list what happened, but do not follow the video.');
  }, 9000);
}
video.addEventListener('loadeddata', () => {
  clearTimeout(stallTimer);
  if (!fallbackActive && driveMode) $('banner').hidden = true;
});
video.addEventListener('error', () => {
  if (isShot() || !rec) return;
  if (driveMode && rec?.status === 'ready') useDriveFallback('Google Drive would not stream this video to the player, so it plays in Drive’s own player. Steps still list what happened.');
});

/** Screenshots: image instead of video, and only the Info and Report tabs. */
function setupShot() {
  if (shotSetup) return;
  shotSetup = true;
  video.pause();
  video.removeAttribute('src');
  video.hidden = true;
  $('bigPlay').hidden = true;
  $('shotLink').hidden = false;
  $('stage').classList.add('is-shot');
  $('copyAtTime').hidden = true;
  if (!driveMode) $('annotate').hidden = false;
  for (const t of ['steps', 'console', 'network']) document.querySelector(`[data-tab="${t}"]`).hidden = true;
  if (!['info', 'report'].includes(location.hash.slice(1))) document.querySelector('[data-tab="info"]').click();
  $('shot').addEventListener('error', () => {
    if (driveMode && rec?.status === 'ready') useDriveFallback('Google Drive would not send the image to the player, so it opens in Drive’s own viewer.');
  });
}

function setCount(name, n, bad = 0, noun = '') {
  $(`c-${name}`).textContent = String(n);
  const badge = $(`e-${name}`);
  if (!badge) return;
  badge.hidden = !bad;
  badge.textContent = String(bad);
  badge.dataset.tip = `${bad} ${noun}${noun === 'error' && bad !== 1 ? 's' : ''}`;
}

function row(ev, { cls = '', glyph, tone = '', body }) {
  const off = offsetOf(ev);
  const li = h('li', { class: cls, onclick: () => seek(off - 0.5) }, h('span', { class: 't' }, fmt(off)), icon(glyph, `glyph${tone ? ` tone-${tone}` : ''}`), h('div', { class: 'body' }, ...body));
  li._off = off;
  li._ev = ev;
  return li;
}

function empty(iconName, text) {
  return h('li', { class: 'empty' }, icon(iconName), text);
}

const ACTION_ICON = { click: 'cursor-click', input: 'keyboard', key: 'keyboard', select: 'list-checks', submit: 'check', upload: 'folder-open' };

// Each kind of step gets its own soft colour so the list is easy to scan.
const ACTION_TONE = { click: 'click', input: 'type', key: 'type', select: 'select', submit: 'submit', upload: 'upload' };

function renderSteps() {
  const items = lists.steps.map((ev) =>
    row(ev, {
      glyph: ev.type === 'navigation' ? 'compass' : ACTION_ICON[ev.action] || 'cursor-click',
      tone: ev.type === 'navigation' ? 'nav' : ACTION_TONE[ev.action] || 'click',
      body: [
        h('div', { class: 'text' }, ev.text || ev.action || ''),
        ev.type === 'navigation' && ev.url ? h('div', { class: 'sub' }, shortUrl(ev.url)) : null,
        ev.type === 'action' && ev.selector ? h('div', { class: 'sub code' }, ev.selector) : null,
      ],
    }),
  );
  $('list-steps').replaceChildren(...(items.length ? items : [empty('cursor-click', rec.status === 'ready' ? 'No steps captured' : 'Steps appear when the recording is ready')]));
}

function renderConsole() {
  const items = lists.console.map((ev) =>
    row(ev, {
      cls: ev.level === 'error' ? 'bad' : ev.level === 'warn' ? 'warn' : '',
      glyph: ev.level === 'error' || ev.level === 'warn' ? 'warning-circle' : 'terminal-window',
      tone: ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'log',
      body: [
        h('div', { class: 'code' }, ev.message || ''),
        ev.source ? h('div', { class: 'sub code' }, ev.source) : null,
        ev.stack ? h('details', { onclick: (e) => e.stopPropagation() }, h('summary', {}, 'Stack trace'), h('div', { class: 'details-box' }, ev.stack)) : null,
      ],
    }),
  );
  $('list-console').replaceChildren(...(items.length ? items : [empty('terminal-window', 'No console messages')]));
}

// ---------------------------------------------------------------- Network (like the browser's panel)
// Rows come from up to three sources per request: the page hook (fetch/XHR/WebSocket: headers
// and bodies), Chrome's request API (every request: status, headers, IP, cache) and Resource
// Timing (sizes, timing breakdown). They are merged here into one row per request.

const NET_TYPES = {
  fetch: 'fetch', xhr: 'xhr', xmlhttprequest: 'xhr', beacon: 'ping', ping: 'ping',
  document: 'document', main_frame: 'document', navigation: 'document', sub_frame: 'document', iframe: 'document', frame: 'document',
  stylesheet: 'stylesheet', css: 'stylesheet', link: 'stylesheet',
  script: 'script',
  image: 'image', img: 'image', imageset: 'image', svg: 'image', image_: 'image',
  font: 'font',
  media: 'media', video: 'media', audio: 'media', track: 'media',
  websocket: 'websocket',
};
const netType = (ev) => {
  const raw = String(ev.resourceType || ev.via || '').toLowerCase();
  if (NET_TYPES[raw]) return NET_TYPES[raw];
  if (raw === 'other' || raw === 'timing') {
    const ct = String(ev.contentType || '');
    if (/css/.test(ct)) return 'stylesheet';
    if (/javascript/.test(ct)) return 'script';
    if (/^image\//.test(ct)) return 'image';
    if (/font/.test(ct)) return 'font';
    if (/^(video|audio)\//.test(ct)) return 'media';
  }
  return ev.via === 'fetch' ? 'fetch' : ev.via === 'xhr' ? 'xhr' : 'other';
};
const NET_CHIP = { fetch: 'fetch', xhr: 'fetch', document: 'doc', stylesheet: 'css', script: 'js', font: 'font', image: 'img', media: 'media', websocket: 'ws' };
const netChip = (ev) => NET_CHIP[ev.netType] || 'other';
const netStart = (ev) => (typeof ev.startedAt === 'number' ? ev.startedAt : ev.ts);

/** One row per request, with every field the sources had. Old recordings pass through as they are. */
function mergeNetwork(events) {
  // WebSockets report several times: keep the newest copy of each.
  const latest = new Map();
  const plain = [];
  for (const e of events) {
    if (e.reqId && e.via === 'websocket') latest.set(e.reqId, e);
    else plain.push(e);
  }
  const all = [...plain, ...latest.values()];
  const hook = all.filter((e) => e.via !== 'web' && e.via !== 'timing');
  const web = all.filter((e) => e.via === 'web');
  const timing = all.filter((e) => e.via === 'timing');
  const key = (e) => `${String(e.method || 'GET').toUpperCase()} ${e.url}`;
  const near = (a, b, ms = 2000) => Math.abs(netStart(a) - netStart(b)) <= ms;
  const rows = hook.map((e) => ({ ...e }));
  const byKey = new Map();
  for (const r of rows) {
    const k = r.netType === 'websocket' || r.via === 'websocket' ? `GET ${String(r.url).replace(/^http/, 'ws')}` : key(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const w of web) {
    const k = w.resourceType === 'websocket' ? `GET ${String(w.url).replace(/^http/, 'ws')}` : key(w);
    const match = (byKey.get(k) || []).find((r) => !r._web && near(r, w));
    if (match) {
      match._web = true;
      for (const f of ['ip', 'fromCache', 'statusLine', 'initiator', 'frame']) if (match[f] === undefined && w[f] !== undefined) match[f] = w[f];
      if (!match.responseHeaders) match.responseHeaders = w.responseHeaders;
      if (!match.requestHeaders) match.requestHeaders = w.requestHeaders;
      // The browser saw the cookies and real status even when the page could not.
      match.browserRequestHeaders = w.requestHeaders;
      if (!match.status && w.status) match.status = w.status;
      if (!match.error && w.error) match.error = w.error;
    } else {
      const r = { ...w };
      rows.push(r);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
  }
  const byUrl = new Map();
  for (const r of rows) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    byUrl.get(r.url).push(r);
  }
  for (const t of timing) {
    const match = (byUrl.get(t.url) || []).find((r) => !r._timing && near(r, t, 3000));
    if (match) {
      match._timing = true;
      Object.assign(match, {
        timing: t.timing,
        transferSize: t.transferSize,
        encodedSize: t.encodedSize,
        decodedSize: t.decodedSize,
        protocol: match.protocol || t.protocol,
        renderBlocking: t.renderBlocking,
        cache: match.cache || t.cache,
      });
      if (match.status === undefined && t.status) match.status = t.status;
      if (!match.contentType && t.contentType) match.contentType = t.contentType;
      if ((match.resourceType === 'other' || !match.resourceType) && t.resourceType) match.resourceType = t.resourceType;
    } else rows.push({ ...t });
  }
  for (const r of rows) r.netType = netType(r);
  return rows;
}

const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
function netSize(ev) {
  if (ev.fromCache || ev.cache) return ev.decodedSize ? `(cache) ${kb(ev.decodedSize)}` : '(cache)';
  const n = ev.transferSize || ev.size || ev.encodedSize || ev.bodySize || (ev.netType === 'websocket' ? (ev.sentBytes || 0) + (ev.receivedBytes || 0) : 0);
  return n ? kb(n) : '–';
}
const netTime = (ev) => (ev.netType === 'websocket' ? (ev.closed ? `${(ev.durationMs / 1000).toFixed(1)} s` : 'open') : ev.durationMs !== undefined ? (ev.durationMs >= 1000 ? `${(ev.durationMs / 1000).toFixed(2)} s` : `${ev.durationMs} ms`) : '–');
const NET_TYPE_LABEL = { fetch: 'fetch', xhr: 'xhr', document: 'document', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', media: 'media', websocket: 'websocket', ping: 'ping', other: 'other' };
function netName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.host;
    return decodeURIComponent(last) + u.search;
  } catch {
    return String(url || '');
  }
}
const statusTone = (code) => (!code ? 's0' : code >= 500 ? 's5' : code >= 400 ? 's4' : code >= 300 ? 's3' : 's2');

let netFilter = 'all';
let netOpen = null; // index in lists.network of the row in the detail view
let netTab = 'headers';

function renderNetwork() {
  const total = timelineDuration() || 1;
  const items = lists.network.map((ev, i) => {
    const bad = isNetError(ev);
    const off = offsetOf(ev);
    const code = ev.status;
    const method = (ev.method || 'GET').toUpperCase();
    const left = Math.min(100, (off / total) * 100);
    const width = Math.max(0.6, Math.min(100 - left, ((ev.durationMs || 0) / 1000 / total) * 100));
    const li = h(
      'li',
      { class: `net-row${bad ? ' bad' : ''}`, role: 'row', tabindex: '-1', title: ev.url, onclick: () => openNetDetail(i) },
      h('span', { class: 'c-n' }, String(i + 1)),
      h('span', { class: 'c-name' }, h('span', { class: `net-ic t-${ev.netType}` }), h('span', { class: 'txt' }, netName(ev.url))),
      h('span', { class: `c-method method m-${method.toLowerCase()}` }, method),
      h('span', { class: 'c-status' }, code === undefined ? h('span', { class: 'muted-sm' }, '–') : h('span', { class: `status ${statusTone(code)}` }, code || (ev.error ? 'failed' : 'ERR'))),
      h('span', { class: 'c-domain' }, hostOf(ev.url)),
      h('span', { class: 'c-type' }, NET_TYPE_LABEL[ev.netType] || ev.netType),
      h('span', { class: 'c-size' }, netSize(ev)),
      h('span', { class: 'c-time' }, netTime(ev)),
      h('span', { class: 'c-wf' }, h('span', { class: `wf-bar${bad ? ' bad' : ''}`, style: `left:${left}%;width:${width}%` })),
    );
    li._off = off;
    li._ev = ev;
    return li;
  });
  $('list-network').replaceChildren(...(items.length ? items : [empty('globe-simple', 'No requests captured')]));
  $('netHead').hidden = !items.length;
  if (netOpen !== null && !lists.network[netOpen]) closeNetDetail();
}

function netMatches(ev) {
  if (netFilter !== 'all' && netChip(ev) !== netFilter) return false;
  if ($('netErrors').checked && !isNetError(ev)) return false;
  return true;
}

// ---- detail view: Headers / Payload / Response / Timing (/ Messages for WebSockets)

function kvTable(rows) {
  const list = rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '');
  if (!list.length) return h('p', { class: 'nd-empty' }, 'Nothing recorded');
  return h('dl', { class: 'nd-kv' }, ...list.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
}

function ndSection(title, ...content) {
  return h('section', { class: 'nd-sec' }, h('h4', {}, title), ...content);
}

function prettyBody(text, contentType = '') {
  if (!text) return null;
  const t = String(text);
  if (/json/i.test(contentType) || /^\s*[[{]/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* cut off or not JSON */
    }
  }
  return t;
}

function bodyBlock(text, contentType, emptyText) {
  const pretty = prettyBody(text, contentType);
  if (!pretty) return h('p', { class: 'nd-empty' }, emptyText);
  const copy = h('button', { type: 'button', class: 'btn sm nd-copy' }, icon('copy'), h('span', {}, 'Copy'));
  copy.addEventListener('click', async () => {
    const ok = await copyText(String(text));
    flash(copy, ok ? 'check' : 'warning-circle', ok ? 'Copied' : "Couldn't copy");
  });
  return h('div', { class: 'nd-body-wrap' }, copy, h('pre', { class: 'nd-pre' }, pretty));
}

function queryRows(url) {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

function netTabs(ev) {
  const tabs = [['headers', 'Headers']];
  if (ev.netType === 'websocket') tabs.push(['messages', `Messages${ev.messages?.length ? ` (${ev.messages.length})` : ''}`]);
  else {
    tabs.push(['payload', 'Payload'], ['response', 'Response']);
  }
  tabs.push(['timing', 'Timing']);
  return tabs;
}

function renderNetDetail() {
  const ev = lists.network[netOpen];
  if (!ev) return;
  const tabs = netTabs(ev);
  if (!tabs.some(([k]) => k === netTab)) netTab = 'headers';
  $('ndTitle').replaceChildren(
    h('span', { class: `status ${statusTone(ev.status)}` }, ev.status === undefined ? '–' : ev.status || 'ERR'),
    h('span', { class: `method m-${String(ev.method || 'GET').toLowerCase()}` }, String(ev.method || 'GET').toUpperCase()),
    h('span', { class: 'txt' }, netName(ev.url)),
  );
  $('ndTabs').replaceChildren(
    ...tabs.map(([k, label]) => {
      const b = h('button', { type: 'button', role: 'tab', class: k === netTab ? 'on' : '', 'aria-selected': String(k === netTab) }, label);
      b.addEventListener('click', () => {
        netTab = k;
        renderNetDetail();
      });
      return b;
    }),
  );
  const off = offsetOf(ev);
  let body;
  if (netTab === 'headers') {
    body = [
      ndSection(
        'General',
        kvTable([
          ['Request URL', ev.url],
          ['Request method', String(ev.method || 'GET').toUpperCase()],
          ['Status', ev.status === undefined ? 'unknown (the server did not share it)' : `${ev.status || 'failed'} ${ev.statusText || (ev.statusLine || '').replace(/^HTTP\/[\d.]+\s+\d+\s*/, '')}`.trim()],
          ['Error', ev.error],
          ['Type', NET_TYPE_LABEL[ev.netType] || ev.netType],
          ['Remote address', ev.ip],
          ['Protocol', ev.protocol],
          ['Served from', ev.fromCache || ev.cache ? 'browser cache' : undefined],
          ['Initiator', ev.initiator],
          ['Redirected', ev.redirected ? 'yes' : undefined],
          ['Response type', ev.responseType],
          ['Render blocking', ev.renderBlocking ? 'yes' : undefined],
          ['At', `${fmt(off)} in the recording`],
        ]),
      ),
      ndSection(`Response headers${ev.responseHeaders ? ` (${ev.responseHeaders.length})` : ''}`, kvTable(ev.responseHeaders || [])),
      ndSection(`Request headers${ev.requestHeaders ? ` (${ev.requestHeaders.length})` : ''}`, kvTable(ev.requestHeaders || [])),
    ];
    if (ev.browserRequestHeaders && ev.browserRequestHeaders !== ev.requestHeaders) body.push(ndSection('Request headers sent by the browser', kvTable(ev.browserRequestHeaders)));
  } else if (netTab === 'payload') {
    const q = queryRows(ev.url);
    body = [
      q.length ? ndSection(`Query string (${q.length})`, kvTable(q)) : null,
      ndSection('Request body', bodyBlock(ev.requestBody, ev.requestHeaders?.find(([k]) => /^content-type$/i.test(k))?.[1], ['GET', 'HEAD'].includes(String(ev.method || 'GET').toUpperCase()) ? 'No body (GET request)' : 'No body recorded')),
    ];
  } else if (netTab === 'response') {
    body = [
      ndSection(
        `Response${ev.bodySize ? ` · ${kb(ev.bodySize)}` : ''}`,
        bodyBlock(ev.responseBody, ev.contentType, ev.netType === 'fetch' || ev.netType === 'xhr' ? 'No response body recorded (binary, streamed or empty)' : 'Bodies are recorded for fetch and XHR calls only'),
      ),
    ];
  } else if (netTab === 'messages') {
    const msgs = ev.messages || [];
    body = [
      ndSection('Connection', kvTable([['Sent', `${ev.sent || 0} messages · ${kb(ev.sentBytes || 0)}`], ['Received', `${ev.received || 0} messages · ${kb(ev.receivedBytes || 0)}`], ['Protocol', ev.protocol], ['Closed', ev.closed ? `code ${ev.closed.code}${ev.closed.reason ? ` · ${ev.closed.reason}` : ''}` : 'still open when the recording ended']])),
      ndSection(
        `Messages${msgs.length >= 100 ? ' (last 100)' : ''}`,
        msgs.length
          ? h('ol', { class: 'nd-msgs' }, ...msgs.map((m) => h('li', { class: m.dir }, h('span', { class: 'dir' }, m.dir === 'out' ? '↑' : '↓'), h('code', {}, m.text), h('span', { class: 'muted-sm' }, `${(m.at / 1000).toFixed(2)} s`))))
          : h('p', { class: 'nd-empty' }, 'No messages'),
      ),
    ];
  } else {
    const t = ev.timing || {};
    const phases = [['Queued', t.queued], ['Redirect', t.redirect], ['DNS lookup', t.dns], ['Initial connection', t.connect], ['SSL', t.tls], ['Waiting for server (TTFB)', t.waiting ?? ev.headersMs], ['Content download', t.download]].filter(([, v]) => typeof v === 'number' && v >= 0);
    const max = Math.max(1, ...phases.map(([, v]) => v), ev.durationMs || 0);
    body = [
      ndSection('When', kvTable([['Started at', `${fmt(off)} in the recording`], ['Total time', ev.durationMs !== undefined ? `${ev.durationMs} ms` : undefined], ['Transferred', ev.transferSize ? kb(ev.transferSize) : undefined], ['Body size', ev.decodedSize ? kb(ev.decodedSize) : ev.bodySize ? kb(ev.bodySize) : undefined]])),
      ndSection(
        'Breakdown',
        phases.length
          ? h('div', { class: 'nd-phases' }, ...phases.map(([k, v]) => h('div', { class: 'nd-phase' }, h('span', {}, k), h('span', { class: 'bar' }, h('span', { style: `width:${Math.max(1, (v / max) * 100)}%` })), h('span', { class: 'ms' }, `${v} ms`))))
          : h('p', { class: 'nd-empty' }, 'The server did not share timing details (cross-origin request without Timing-Allow-Origin).'),
      ),
    ];
  }
  $('ndBody').replaceChildren(...body.filter(Boolean));
  $('ndBody').scrollTop = 0;
  const rows = [...$('list-network').children];
  rows.forEach((li, i) => li.classList.toggle('open', i === netOpen));
}

function openNetDetail(i) {
  netOpen = i;
  $('netDetail').hidden = false;
  $('pane-network').classList.add('detail-open');
  renderNetDetail();
  const li = $('list-network').children[i];
  li?.scrollIntoView({ block: 'nearest' });
  if (li) seek(li._off - 0.5);
}

function closeNetDetail() {
  netOpen = null;
  $('netDetail').hidden = true;
  $('pane-network').classList.remove('detail-open');
  [...$('list-network').children].forEach((li) => li.classList.remove('open'));
}

function stepNetDetail(dir) {
  if (netOpen === null) return;
  const rows = [...$('list-network').children];
  for (let i = netOpen + dir; i >= 0 && i < rows.length; i += dir) {
    if (!rows[i].hidden) return openNetDetail(i);
  }
}

$('ndClose').addEventListener('click', closeNetDetail);
$('ndPrev').addEventListener('click', () => stepNetDetail(-1));
$('ndNext').addEventListener('click', () => stepNetDetail(1));
$('netDetail').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeNetDetail();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    stepNetDetail(e.key === 'ArrowUp' ? -1 : 1);
  }
});
document.querySelectorAll('[data-net]').forEach((b) =>
  b.addEventListener('click', () => {
    netFilter = b.dataset.net;
    document.querySelectorAll('[data-net]').forEach((x) => x.classList.toggle('on', x === b));
    applyFilter();
  }),
);
$('netErrors').addEventListener('change', applyFilter);
$('netWide').addEventListener('click', () => {
  const layout = $('layout');
  const wide = !layout.classList.contains('net-wide');
  layout.classList.toggle('net-wide', wide);
  setIcon($('netWide'), wide ? 'corners-in' : 'arrows-out-simple');
  $('netWide').dataset.tip = wide ? 'Narrower panel' : 'Wider panel';
});
// The table changes its columns with the panel width.
new ResizeObserver(() => {
  const w = $('pane-network').clientWidth;
  $('pane-network').dataset.size = w >= 760 ? 'wide' : w >= 540 ? 'mid' : 'narrow';
}).observe($('pane-network'));

function osIcon(os = '') {
  if (/windows/i.test(os)) return 'windows-logo';
  if (/mac|ios/i.test(os)) return 'apple-logo';
  if (/linux|chrome os|android/i.test(os)) return 'linux-logo';
  return 'monitor';
}

function renderInfo() {
  const meta = rec.meta || {};
  const env = meta.env || {};
  const size = (o) => (o && o.width ? `${o.width} × ${o.height}` : undefined);
  const loc = env.location;
  const tz = env.timeZone ? `${env.timeZone} (UTC${env.utcOffsetMinutes >= 0 ? '+' : '-'}${fmtOffset(env.utcOffsetMinutes)})` : undefined;
  const link = (href, text) => (isHttp(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text || href) : text || href);

  // Visited pages, each with the moment it was opened.
  const seen = new Set();
  const visits = lists.steps.filter((e) => e.type === 'navigation' && e.url && !seen.has(e.url) && seen.add(e.url));
  const blocks = [];
  if (visits.length) {
    blocks.push(
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, 'Visited URLs'), h('div', { class: 'urls' },
        ...visits.map((e) => h('button', { type: 'button', 'data-tip': 'Jump to this moment', onclick: () => seek(offsetOf(e)) }, h('span', { class: 'tt' }, fmt(offsetOf(e))), h('span', { class: 'u' }, shortUrl(e.url))))),
      ),
    );
  }
  const when = new Date(rec.startedAt || rec.createdAt);
  const rows = [
    [isShot() ? 'Captured' : 'Recorded', when.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })],
    ['Duration', durationSec ? fmt(durationSec) : undefined],
    [isShot() ? 'Captured by' : 'Recorded by', meta.reporter],
    ['GitHub issue', rec.github?.length ? [icon('github-logo'), ...rec.github.map((g, i) => [i ? ', ' : '', link(g.url, `#${g.number}`)]).flat()] : undefined],
    ['From recording', rec.fromRecordingInfo ? [icon('video-camera'), link(atTime(rec.fromRecordingInfo.viewerUrl, rec.fromRecordingInfo.at), `${rec.fromRecordingInfo.title} at ${fmt(rec.fromRecordingInfo.at)}`)] : undefined],
    ['Frames', rec.frameShots?.length ? [icon('camera'), ...rec.frameShots.map((f, i) => [i ? ', ' : '', link(f.viewerUrl, fmt(f.at))]).flat()] : undefined],
    ['Type', isShot() ? `Screenshot${rec.image?.width ? ` (${rec.image.width} × ${rec.image.height})` : ''}` : meta.mode === 'desktop' ? `Screen (${{ monitor: 'entire screen', window: 'window', browser: 'browser tab' }[env.displaySurface] || 'screen'})` : 'Browser tab'],
    ['Location', loc && loc.latitude !== undefined
      ? [icon('map-pin'), link(`https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=14/${loc.latitude}/${loc.longitude}`, `${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`)]
      : loc?.error ? 'Not available' : undefined],
    ['OS', env.os || meta.platform?.os ? [icon(osIcon(env.os || meta.platform?.os)), [env.os || meta.platform?.os, env.architecture].filter(Boolean).join(' · ')] : undefined],
    ['Browser', env.browser ? [icon('google-chrome-logo'), env.browser] : undefined],
    ['Window size', size(meta.window)],
    ['Viewport', size(meta.viewport)],
    ['Screen', size(env.screen)],
    ['Time zone', tz],
    ['Language', env.language],
    ['Connection', env.connection?.effectiveType],
    ['CPU / memory', env.hardwareConcurrency ? `${env.hardwareConcurrency} cores${env.deviceMemoryGb ? ` · ${env.deviceMemoryGb} GB+` : ''}` : undefined],
    [isShot() ? 'Page' : 'Start page', meta.startUrl ? link(meta.startUrl, shortUrl(meta.startUrl)) : undefined],
    ['Extension', meta.extensionVersion],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  blocks.push(h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  if (env.userAgent) blocks.push(h('details', {}, h('summary', {}, 'User agent'), h('p', { class: 'ua' }, env.userAgent)));
  $('info').replaceChildren(...blocks);
}

function fmtOffset(min) {
  const a = Math.abs(min || 0);
  return `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- progress bar markers

function renderMarkers() {
  const total = timelineDuration();
  if (!total) return $('markers').replaceChildren();
  const label = (e) => e.text || e.message || `${e.method} ${pathOf(e.url)} returned ${e.status || 'an error'}`;
  const marks = [
    ...lists.steps.filter((e) => e.type === 'action').map((e) => ({ e, cls: 'action' })),
    ...lists.console.filter((e) => e.level === 'error').map((e) => ({ e, cls: 'error' })),
    ...lists.network.filter(isNetError).map((e) => ({ e, cls: 'error' })),
  ];
  $('markers').replaceChildren(
    ...marks.map(({ e, cls }) => {
      const off = offsetOf(e);
      const m = h('div', { class: `marker ${cls}`, style: `left:${Math.min(100, (off / total) * 100)}%` });
      m._label = `${fmt(off)}  ${label(e).split('\n')[0]}`;
      return m;
    }),
  );
}

function timelineDuration() {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationSec;
}

// ---------------------------------------------------------------- bug report draft

/** Drive image address for a public screenshot file, so GitHub shows it inline. */
const driveImage = (fileId) => (fileId && /^[\w-]+$/.test(fileId) ? `https://lh3.googleusercontent.com/d/${fileId}=w4000` : '');

/** Markdown images for the issue: this screenshot, or the frames captured from this recording. */
function imageLines() {
  if (isShot()) {
    const url = driveImage(rec?.drive?.videoId);
    return url ? [`![Screenshot](${url})`] : [];
  }
  return (rec?.frameShots || []).filter((f) => driveImage(f.fileId)).map((f) => `![Frame at ${fmt(f.at)}](${driveImage(f.fileId)})`);
}

/** Add those images under "## Attachments" (or at the end), each once. */
function withShotImage(text) {
  const lines = imageLines().filter((l) => !text.includes(l));
  if (!lines.length) return text;
  const block = lines.join('\n');
  const m = /^##\s*Attachments[^\n]*\n/im.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + block + '\n' + text.slice(m.index + m[0].length);
  return `${text}${text ? '\n\n' : ''}## Attachments\n${block}`;
}

const atTime = (url, sec) => `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(sec)}`;

function buildReport() {
  const meta = rec.meta || {};
  const env = meta.env || {};
  const steps = lists.steps.filter((e) => e.text && e.transition !== 'start');
  const errors = lists.console.filter((e) => e.level === 'error');
  const failed = lists.network.filter(isNetError);
  const page = shortUrl(meta.startUrl) || meta.title || 'the page';

  // "<Page> - <problem>": page name from the tab title ("Pricing | Acme" -> "Pricing").
  const pageName = (meta.title || page).split(/\s[|–—-]\s/)[0].trim() || 'Page';
  let problem = 'describe the problem';
  if (errors[0]) problem = errors[0].message.split('\n')[0].slice(0, 70);
  else if (failed[0]) problem = `${failed[0].method} ${pathOf(failed[0].url).split('?')[0]} returns ${failed[0].status || 'a network error'}`;
  const title = `${pageName} - ${problem}`;
  const link = shareLink();
  const at = (e) => `${link}${link.includes('?') ? '&' : '?'}t=${Math.floor(offsetOf(e))}`;

  const evidence = [
    ...errors.slice(0, 5).map((e) => `- Console error at ${fmt(offsetOf(e))}: \`${e.message.split('\n')[0].slice(0, 200)}\` (${at(e)})`),
    ...failed.slice(0, 5).map((e) => `- \`${e.method} ${shortUrl(e.url)}\` returned ${e.status || 'a network error'} at ${fmt(offsetOf(e))} (${at(e)})`),
  ];
  const size = (o) => (o && o.width ? `${o.width}x${o.height}` : 'unknown');

  return [
    `# ${title}`,
    '',
    '## Description',
    meta.description || '_Describe the problem in one or two sentences._',
    '',
    '## Preconditions',
    `- Start on: ${meta.startUrl || 'unknown'}`,
    `- ${env.browser || 'Unknown browser'} on ${env.os || meta.platform?.os || 'unknown OS'}${meta.window?.width ? `, window ${size(meta.window)}` : ''}${meta.viewport?.width ? `, viewport ${size(meta.viewport)}` : ''}`,
    '',
    '## Steps to reproduce',
    ...(steps.length ? steps.map((e, i) => `${i + 1}. ${e.text}`) : isShot() ? [`1. Go to ${meta.startUrl || 'the page'}`, '2. _Describe what to do to see the problem._'] : ['1. _No steps captured_']),
    '',
    '## Attachments',
    ...imageLines(),
    `- ${isShot() ? 'Screenshot' : 'Recording'}: ${link}`,
    ...(rec.fromRecordingInfo ? [`- From recording at ${fmt(rec.fromRecordingInfo.at)}: ${atTime(rec.fromRecordingInfo.shareUrl || rec.fromRecordingInfo.viewerUrl, rec.fromRecordingInfo.at)}`] : []),
    ...evidence,
    '',
    '## Actual result',
    '_What happened._',
    '',
    '## Expected result',
    '_What should have happened._',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- playback

function seek(sec) {
  if (fallbackActive) return;
  video.currentTime = Math.max(0, Math.min(sec, timelineDuration() || sec));
  if (video.paused) video.play().catch(() => {});
}

const lastCurrent = {};
function sync() {
  const t = video.currentTime || 0;
  const total = timelineDuration();
  const pct = total ? Math.min(100, (t / total) * 100) : 0;
  $('clock').textContent = `${fmt(t)} / ${fmt(total)}`;
  $('played').style.width = `${pct}%`;
  $('knob').style.left = `${pct}%`;
  $('track').setAttribute('aria-valuenow', String(Math.round(t)));
  $('track').setAttribute('aria-valuemax', String(Math.round(total)));
  $('copyAtTime').querySelector('span:last-child').textContent = `Copy link at ${fmt(t)}`;

  const list = $(`list-${activeTab}`);
  if (!list) return;
  let current = null;
  for (const li of list.children) {
    if (li._off === undefined) continue;
    const past = li._off <= t + 0.05;
    li.classList.toggle('future', !past);
    if (past && !li.hidden) current = li;
  }
  if (lastCurrent[activeTab] !== current) {
    lastCurrent[activeTab]?.classList.remove('current');
    current?.classList.add('current');
    lastCurrent[activeTab] = current;
    if (current && $('follow').checked && !video.paused) current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function updatePlayState() {
  const playing = !video.paused && !video.ended;
  setIcon($('playBtn'), playing ? 'pause-fill' : 'play-fill');
  $('playBtn').dataset.tip = playing ? 'Pause' : 'Play';
  if (playing) $('bigPlay').hidden = true;
}

function updateBuffered() {
  const total = timelineDuration();
  if (!total || !video.buffered.length) return;
  $('buffered').style.width = `${Math.min(100, (video.buffered.end(video.buffered.length - 1) / total) * 100)}%`;
}

video.addEventListener('timeupdate', sync);
video.addEventListener('seeked', sync);
video.addEventListener('play', updatePlayState);
video.addEventListener('pause', updatePlayState);
video.addEventListener('ended', updatePlayState);
video.addEventListener('progress', updateBuffered);
video.addEventListener('volumechange', () => {
  setIcon($('muteBtn'), video.muted || video.volume === 0 ? 'speaker-slash' : 'speaker-high');
  $('muteBtn').dataset.tip = video.muted ? 'Unmute' : 'Mute';
});
video.addEventListener('loadedmetadata', () => {
  // An unprocessed WebM reports Infinity; seeking far forces Chrome to compute the duration.
  if (!Number.isFinite(video.duration)) {
    const restore = () => {
      video.removeEventListener('durationchange', restore);
      video.currentTime = 0;
      renderMarkers();
      sync();
    };
    video.addEventListener('durationchange', restore);
    video.currentTime = 1e7;
  } else if (rec) {
    renderMarkers();
  }
  sync();
});

const togglePlay = () => {
  if (fallbackActive || rec?.status !== 'ready') return;
  video.paused || video.ended ? video.play().catch(() => {}) : video.pause();
};
video.addEventListener('click', togglePlay);
$('bigPlay').addEventListener('click', togglePlay);
$('playBtn').addEventListener('click', togglePlay);
$('muteBtn').addEventListener('click', () => (video.muted = !video.muted));
document.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', () => seek(video.currentTime + Number(b.dataset.skip))));

const SPEEDS = [1, 1.5, 2, 0.5];
$('speedBtn').addEventListener('click', () => {
  const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length];
  video.playbackRate = next;
  $('speedBtn').textContent = `${next}x`;
});
const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen?.());
$('fullBtn').addEventListener('click', toggleFull);
document.addEventListener('fullscreenchange', () => {
  setIcon($('fullBtn'), document.fullscreenElement ? 'corners-in' : 'corners-out');
  $('fullBtn').dataset.tip = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});

// Progress bar: click or drag to seek, hover for the time (and what happened there).
const track = $('track');
const pctAt = (e) => {
  const r = track.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
};
track.addEventListener('pointerdown', (e) => {
  if (fallbackActive) return;
  track.setPointerCapture(e.pointerId);
  track.classList.add('drag');
  const move = (ev) => (video.currentTime = pctAt(ev) * timelineDuration());
  move(e);
  const up = () => {
    track.classList.remove('drag');
    track.removeEventListener('pointermove', move);
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', up, { once: true });
  track.addEventListener('pointercancel', up, { once: true });
});
track.addEventListener('pointermove', (e) => {
  const total = timelineDuration();
  if (!total) return;
  const p = pctAt(e);
  const tipEl = $('hoverTime');
  // Show the label of a marker under the pointer, otherwise just the time.
  const near = [...$('markers').children].find((m) => Math.abs(parseFloat(m.style.left) / 100 - p) * track.clientWidth < 6);
  tipEl.textContent = near ? near._label : fmt(p * total);
  tipEl.hidden = false;
  const w = tipEl.offsetWidth / 2;
  tipEl.style.left = `${Math.max(w, Math.min(track.clientWidth - w, p * track.clientWidth))}px`;
});
track.addEventListener('pointerleave', () => ($('hoverTime').hidden = true));
track.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') seek(video.currentTime - 5);
  else if (e.key === 'ArrowRight') seek(video.currentTime + 5);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// ---------------------------------------------------------------- side panel

document.querySelectorAll('[data-level]').forEach((b) =>
  b.addEventListener('click', () => {
    level = b.dataset.level;
    document.querySelectorAll('[data-level]').forEach((x) => x.classList.toggle('on', x === b));
    applyFilter();
  }),
);

document.querySelectorAll('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    history.replaceState(null, '', activeTab === 'steps' ? location.pathname + location.search : `${location.search}#${activeTab}`);
    document.querySelectorAll('[data-tab]').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    for (const name of ['info', 'steps', 'console', 'network', 'report']) $(`pane-${name}`).hidden = name !== activeTab;
    if (activeTab === 'report') checkAi();
    $('toolbar').hidden = activeTab === 'info' || activeTab === 'report';
    $('levels').hidden = activeTab !== 'console';
    $('netBar').hidden = activeTab !== 'network';
    applyFilter();
    sync();
  }),
);

function applyFilter() {
  const list = $(`list-${activeTab}`);
  if (!list) return;
  const q = $('search').value.trim().toLowerCase();
  for (const li of list.children) {
    if (!li._ev) continue;
    const ev = li._ev;
    let show = !q || li.textContent.toLowerCase().includes(q);
    if (activeTab === 'console' && level === 'error') show &&= ev.level === 'error';
    if (activeTab === 'console' && level === 'warn') show &&= ev.level === 'error' || ev.level === 'warn';
    if (activeTab === 'network') show &&= netMatches(ev);
    li.hidden = !show;
  }
}
$('search').addEventListener('input', applyFilter);

// DevTools panel: drag its left edge (or use arrow keys on it) to resize; the width is remembered.
(() => {
  const layout = $('layout');
  const handle = $('resizer');
  const clamp = (w) => Math.round(Math.max(320, Math.min(w, Math.min(1200, window.innerWidth * 0.75))));
  const apply = (w) => layout.style.setProperty('--side-w', `${clamp(w)}px`);
  const save = () => {
    try {
      localStorage.setItem('bugsnap.sideWidth', String($('side').getBoundingClientRect().width));
    } catch {
      /* storage unavailable: width just isn't remembered */
    }
  };
  try {
    const w = Number(localStorage.getItem('bugsnap.sideWidth'));
    if (w) apply(w);
  } catch {
    /* ignore */
  }
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => apply(window.innerWidth - ev.clientX);
    const up = () => {
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    layout.style.removeProperty('--side-w');
    save();
  });
  handle.addEventListener('keydown', (e) => {
    const w = $('side').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') apply(w + 24);
    else if (e.key === 'ArrowRight') apply(w - 24);
    else return;
    e.preventDefault();
    save();
  });
})();

$('togglePanel').addEventListener('click', () => {
  const layout = $('layout');
  const off = !layout.classList.contains('no-side');
  clearTimeout(layout._hideTimer);
  if (off) {
    layout.classList.add('no-side');
    // After the slide, take it out of keyboard focus order too.
    layout._hideTimer = setTimeout(() => layout.classList.add('side-gone'), 330);
  } else {
    layout.classList.remove('side-gone');
    requestAnimationFrame(() => layout.classList.remove('no-side'));
  }
  $('togglePanel').classList.toggle('off', off);
  $('togglePanel').dataset.tip = off ? 'Show DevTools' : 'Hide DevTools';
});

// ---------------------------------------------------------------- sharing

function flash(btn, iconName, text) {
  const label = btn.querySelector('span:last-child');
  const slot = btn.querySelector('[data-icon]');
  if (!label || !slot) {
    const old = btn.textContent;
    btn.textContent = text;
    return setTimeout(() => (btn.textContent = old), 1400);
  }
  const old = { icon: slot.dataset.icon, text: label.textContent };
  setIcon(slot, iconName);
  label.textContent = text;
  setTimeout(() => {
    setIcon(slot, old.icon);
    label.textContent = old.text;
  }, 1400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
    ta.value = text;
    document.body.append(ta);
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

/**
 * Make sure there is a public link before copying. A recording made before Google Drive was
 * connected gets its link reserved here, and its upload starts.
 */
async function ensurePublicLink() {
  if (driveMode || rec?.shareUrl || !rec?.driveConnected) return;
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/share`, { method: 'POST' }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (body.shareUrl) {
    rec = { ...rec, shareUrl: body.shareUrl, drive: { ...(rec.drive || {}), shareUrl: body.shareUrl, status: body.status || 'pending' } };
    renderBanner();
    renderDetails();
    if (needsPoll()) poll();
  }
}

async function copyShareLink(btn, atSeconds = null) {
  await ensurePublicLink();
  const base = shareLink();
  const url = atSeconds === null ? base : withTime(base, atSeconds);
  if (!(await copyText(url))) return flash(btn, 'warning-circle', "Couldn't copy");
  flash(btn, 'check', isPublicLink() ? 'Copied' : 'Copied (only you)');
  if ($('rLink')) $('rLink').value = base;
}

$('copyLink').addEventListener('click', () => copyShareLink($('copyLink')));

const menu = $('shareMenu');
function closeMenu() {
  if (menu.hidden || menu.classList.contains('closing')) return;
  menu.classList.add('closing');
  setTimeout(() => {
    menu.hidden = true;
    menu.classList.remove('closing');
  }, 120);
}
$('shareMore').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!menu.hidden) return closeMenu();
  menu.hidden = false;
  menu.querySelector('button, a:not([hidden])')?.focus();
});
document.addEventListener('click', (e) => !menu.contains(e.target) && closeMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
$('copyAtTime').addEventListener('click', async () => {
  closeMenu();
  await copyShareLink($('copyLink'), video.currentTime);
});
$('copyReportMenu').addEventListener('click', async () => {
  closeMenu();
  flash($('copyLink'), (await copyText($('report').value)) ? 'check' : 'warning-circle', 'Report copied');
});
$('copyReport').addEventListener('click', async () => {
  const ok = await copyText($('report').value);
  flash($('copyReport'), ok ? 'check' : 'warning-circle', ok ? 'Copied' : "Couldn't copy");
});

// ---------------------------------------------------------------- review (local server only)

function reviewStatus() {
  if (!rec.driveConnected && !rec.shareUrl) return 'Only you can open this link. Connect Google Drive in Settings to share.';
  if (rec.drive?.status === 'done') return 'Anyone with the link can watch.';
  if (rec.drive?.status === 'error') return `Upload failed: ${rec.drive.error}. Retry from the player.`;
  if (rec.shareUrl) return 'Link is ready to share. The video opens for others as soon as the upload finishes.';
  return 'Getting your share link…';
}

function openReview() {
  if (driveMode || !rec) return;
  const meta = rec.meta || {};
  $('rTitle').value = meta.title || '';
  $('rDesc').value = meta.description || '';
  $('rLink').value = shareLink();
  $('rStatus').textContent = reviewStatus();
  const rv = $('reviewVideo');
  if (isShot()) {
    rv.hidden = true;
    $('reviewImage').hidden = false;
    $('reviewImage').src = $('shot').src;
  } else if (rec.status === 'ready' && !rv.src) {
    rv.src = video.currentSrc || video.src;
    rv.poster = video.poster;
  }
  $('review').hidden = false;
  setTimeout(() => $('rTitle').focus(), 30);
  // The review screen is for sharing: make sure a public link exists.
  ensurePublicLink().then(() => {
    $('rLink').value = shareLink();
    $('rStatus').textContent = reviewStatus();
  });
  // Keep the link and status fresh while the modal is open (the link is reserved in the background).
  clearInterval(openReview.timer);
  openReview.timer = setInterval(async () => {
    if ($('review').hidden) return clearInterval(openReview.timer);
    const r = await fetchRecording().catch(() => null);
    if (!r) return;
    rec = { ...rec, drive: r.drive, shareUrl: r.shareUrl, driveConnected: r.driveConnected, status: r.status };
    $('rLink').value = shareLink();
    $('rStatus').textContent = reviewStatus();
    if (r.status === 'ready' && !rv.src && !isShot()) rv.src = `/api/recordings/${encodeURIComponent(id)}/video`;
  }, 2000);
}

function closeReview() {
  const back = $('review');
  if (back.hidden || back.classList.contains('closing')) return;
  back.classList.add('closing');
  setTimeout(() => {
    back.hidden = true;
    back.classList.remove('closing');
  }, 180);
  $('reviewVideo').pause();
  clearInterval(openReview.timer);
  if (params.has('review')) {
    params.delete('review');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
  }
}

if (!driveMode) {
  $('editBtn').addEventListener('click', openReview);
  $('editDetails').addEventListener('click', () => {
    closeMenu();
    openReview();
  });
  $('reviewClose').addEventListener('click', closeReview);
  $('review').addEventListener('click', (e) => e.target === $('review') && closeReview());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('review').hidden && closeReview());
  $('rCopy').addEventListener('click', () => copyShareLink($('rCopy')));
  $('reviewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('rSave').disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('rTitle').value, description: $('rDesc').value }),
    }).catch(() => null);
    $('rSave').disabled = false;
    if (!res || !res.ok) return ($('rStatus').textContent = 'Could not save. Is the server running?');
    const saved = await res.json();
    rec.meta = { ...rec.meta, title: saved.title, description: saved.description };
    renderDetails();
    if (!$('what').value) $('what').value = saved.description || '';
    renderReport();
    closeReview();
  });
  let armed = false;
  $('rDelete').addEventListener('click', async () => {
    const b = $('rDelete');
    if (!armed) {
      armed = true;
      b.classList.add('armed');
      b.querySelector('span:last-child').textContent = 'Click to delete';
      setTimeout(() => {
        armed = false;
        b.classList.remove('armed');
        b.querySelector('span:last-child').textContent = 'Delete';
      }, 3000);
      return;
    }
    b.disabled = true;
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (res && res.ok) location.href = '/';
    else {
      b.disabled = false;
      $('rStatus').textContent = 'Could not delete. Is the server running?';
    }
  });
}

// ---------------------------------------------------------------- GitHub issue (local server only)

const ghState = { repos: [], repo: new Set(), meta: null, labels: new Set(), assignees: new Set(), milestone: new Set(), projects: [], projectsError: null, boards: new Set(), fieldSel: {} };

function ghError(message) {
  $('ghAlert').hidden = !message;
  $('ghAlertText').textContent = message || '';
}

async function ghJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server answered ${res.status}`);
  return body;
}

// ---- Searchable picker: one popover used for repository, labels, assignees and milestone.

let openPop = null;

function closePop() {
  if (!openPop) return;
  const { el, trigger, onClose } = openPop;
  el.remove();
  trigger.setAttribute('aria-expanded', 'false');
  openPop = null;
  onClose?.();
}

/**
 * cfg: { title, items, key, name, sub?, lead?, tail?, selected (Set), multi?, toggle?, placeholder, empty, onChange }
 * Multi pickers stay open while you tick items; single pickers close on choice.
 */
function showPicker(trigger, cfg) {
  if (openPop?.trigger === trigger) return closePop();
  closePop();
  const input = h('input', { type: 'text', placeholder: cfg.placeholder || 'Search', autocomplete: 'off', spellcheck: 'false', 'aria-label': cfg.placeholder || 'Search' });
  const list = h('div', { class: 'pop-list', role: 'listbox', 'aria-multiselectable': cfg.multi ? 'true' : undefined });
  const clear = cfg.multi || cfg.toggle ? h('button', { type: 'button' }, 'Clear') : null;
  const el = h('div', { class: 'pop' }, h('div', { class: 'pop-head' }, h('span', {}, cfg.title), clear), h('label', { class: 'pop-search' }, icon('magnifying-glass'), input), list);
  let shown = [];
  let act = 0;

  const mark = () => [...list.children].forEach((r, i) => r.classList.toggle('act', i === act));
  const reveal = () => list.children[act]?.scrollIntoView({ block: 'nearest' });
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = cfg.items.filter((it) => !q || `${cfg.name(it)} ${cfg.sub?.(it) || ''}`.toLowerCase().includes(q));
    const typed = input.value.trim();
    const canCreate = cfg.create && typed && !cfg.items.some((it) => cfg.name(it).toLowerCase() === typed.toLowerCase());
    act = Math.min(act, Math.max(0, shown.length - (canCreate ? 0 : 1)));
    const createRow = () => {
      const row = h('div', { class: `pop-item pop-create${act === shown.length ? ' act' : ''}`, role: 'option' }, icon('plus'), h('span', { class: 'main' }, h('span', { class: 'name' }, `${cfg.createLabel || 'Create'} “${typed}”`)));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => choose(shown.length));
      return row;
    };
    if (!shown.length) return list.replaceChildren(canCreate ? createRow() : h('div', { class: 'pop-empty' }, cfg.items.length ? 'No matches' : cfg.empty || 'Nothing here'));
    list.replaceChildren(
      ...shown.map((it, i) => {
        const sub = cfg.sub?.(it);
        const row = h(
          'div',
          { class: `pop-item${i === act ? ' act' : ''}`, role: 'option', 'aria-selected': String(cfg.selected.has(cfg.key(it))) },
          icon('check', 'icon check'),
          cfg.lead?.(it),
          h('span', { class: 'main' }, h('span', { class: 'name' }, cfg.name(it)), sub ? h('span', { class: 'sub' }, sub) : null),
          cfg.tail?.(it),
        );
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => choose(i));
        row.addEventListener('mousemove', () => act !== i && ((act = i), mark()));
        return row;
      }),
      ...(canCreate ? [createRow()] : []),
    );
  };
  const choose = (i) => {
    if (i === shown.length && cfg.create && input.value.trim()) {
      const name = input.value.trim();
      closePop();
      trigger.focus();
      return cfg.create(name);
    }
    const it = shown[i];
    if (!it) return;
    const k = cfg.key(it);
    if (cfg.multi) {
      cfg.selected.has(k) ? cfg.selected.delete(k) : cfg.selected.add(k);
      list.children[i]?.setAttribute('aria-selected', String(cfg.selected.has(k)));
      cfg.onChange();
      return;
    }
    const was = cfg.selected.has(k);
    cfg.selected.clear();
    if (!(was && cfg.toggle)) cfg.selected.add(k);
    cfg.onChange();
    closePop();
    trigger.focus();
  };

  clear?.addEventListener('click', () => {
    cfg.selected.clear();
    cfg.onChange();
    if (cfg.multi) {
      render();
      input.focus();
    } else {
      closePop();
      trigger.focus();
    }
  });
  input.addEventListener('input', () => {
    act = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      act = Math.min(list.children.length - 1, act + 1);
      mark();
      reveal();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      act = Math.max(0, act - 1);
      mark();
      reveal();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(act);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePop();
      trigger.focus();
    } else if (e.key === 'Tab') closePop();
  });

  // Single pickers open on the current choice; multi pickers list chosen items first.
  if (cfg.multi) cfg.items = [...cfg.items.filter((it) => cfg.selected.has(cfg.key(it))), ...cfg.items.filter((it) => !cfg.selected.has(cfg.key(it)))];
  else act = Math.max(0, cfg.items.findIndex((it) => cfg.selected.has(cfg.key(it))));
  document.body.append(el);
  el.classList.toggle('no-search', Boolean(cfg.noSearch));
  render();

  // Place under the trigger, or above it when there is more room there.
  const r = trigger.getBoundingClientRect();
  el.style.width = `${Math.min(Math.max(r.width, 280), window.innerWidth - 24)}px`;
  el.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - el.offsetWidth - 12))}px`;
  const below = window.innerHeight - r.bottom - 18;
  const above = r.top - 18;
  const up = el.offsetHeight > below && above > below;
  el.classList.toggle('up', up);
  if (up) el.style.bottom = `${window.innerHeight - r.top + 6}px`;
  else el.style.top = `${r.bottom + 6}px`;
  list.style.maxHeight = `${Math.max(120, Math.min(280, (up ? above : below) - 96))}px`;

  trigger.setAttribute('aria-expanded', 'true');
  openPop = { el, trigger, onClose: cfg.onClose };
  reveal();
  input.focus();
}

document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.el.contains(e.target) && !openPop.trigger.contains(e.target)) closePop();
});
window.addEventListener('resize', closePop);

// ---- What each picker button shows when closed: short, one line, never wraps.

function setPickVal(btn, nodes, has) {
  btn.querySelector('.pick-val').replaceChildren(...nodes.filter(Boolean));
  btn.classList.toggle('has', Boolean(has));
}

const placeholder = (text) => h('span', { class: 'muted-sm' }, text);
const more = (n) => (n > 0 ? h('span', { class: 'pv-more' }, `+${n}`) : null);

function renderRepoPick() {
  const r = ghState.repos.find((x) => ghState.repo.has(x.fullName));
  setPickVal($('ghRepo'), r ? [icon('github-logo'), h('span', { class: 'txt' }, r.fullName), r.private ? icon('lock-simple', 'icon lock') : null] : [placeholder('Choose a repository')], r);
}

function renderLabelsPick() {
  const sel = (ghState.meta?.labels || []).filter((l) => ghState.labels.has(l.name));
  if (!sel.length) return setPickVal($('ghLabels'), [placeholder('Labels')]);
  setPickVal($('ghLabels'), [h('span', { class: 'pv-dots' }, ...sel.slice(0, 3).map((l) => h('span', { class: 'pv-dot', style: `--c: #${l.color}` }))), h('span', { class: 'txt' }, sel[0].name), more(sel.length - 1)], true);
}

function renderAssigneesPick() {
  const sel = (ghState.meta?.assignees || []).filter((a) => ghState.assignees.has(a.login));
  if (!sel.length) return setPickVal($('ghAssignees'), [placeholder('Assignees')]);
  setPickVal($('ghAssignees'), [h('span', { class: 'pv-avs' }, ...sel.slice(0, 3).map((a) => h('img', { src: a.avatar, alt: '' }))), h('span', { class: 'txt' }, sel[0].login), more(sel.length - 1)], true);
}

function renderMilestonePick() {
  const m = (ghState.meta?.milestones || []).find((x) => ghState.milestone.has(String(x.number)));
  setPickVal($('ghMilestone'), m ? [h('span', { class: 'txt' }, m.title)] : [placeholder('Milestone')], m);
}

function resetMetaPicks(loading) {
  for (const id of ['ghLabels', 'ghAssignees', 'ghMilestone']) $(id).disabled = Boolean(loading);
  renderLabelsPick();
  renderAssigneesPick();
  renderMilestonePick();
}

// ---- Project boards: pick any number, then each board's dropdown fields (Status, Priority, …).
// The issue is added to the boards and the values are set right after it is created.

const BOARD_COLORS = { GRAY: '#8b949e', BLUE: '#2f81f7', GREEN: '#2da44e', YELLOW: '#d4a72c', ORANGE: '#e16f24', RED: '#e5484d', PINK: '#db61a2', PURPLE: '#8250df' };
const boardKey = (repo) => `bugsnap.gh.boards.${repo}`;

function fieldSel(projectId, fieldId) {
  ghState.fieldSel[projectId] ||= {};
  return (ghState.fieldSel[projectId][fieldId] ||= new Set());
}

function rememberBoards() {
  const repo = [...ghState.repo][0];
  if (!repo) return;
  const values = {};
  for (const pid of ghState.boards) {
    values[pid] = {};
    for (const [fid, set] of Object.entries(ghState.fieldSel[pid] || {})) if (set.size) values[pid][fid] = [...set][0];
  }
  try {
    localStorage.setItem(boardKey(repo), JSON.stringify({ boards: [...ghState.boards], values }));
  } catch {
    /* storage off: nothing to remember */
  }
}

/** Last boards and values used with this repository, kept only where they still exist. */
function restoreBoards(repo) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(boardKey(repo)) || 'null');
  } catch {
    saved = null;
  }
  if (!saved) {
    // First time with this repo: show boards made for bug details right away (linked to the
    // repo and with their own dropdowns besides Status, e.g. Severity, Priority, Feature).
    for (const p of ghState.projects) {
      if (p.linked && p.fields.some((f) => f.name.trim().toLowerCase() !== 'status')) ghState.boards.add(p.id);
    }
    return;
  }
  for (const pid of saved?.boards || []) {
    const p = ghState.projects.find((x) => x.id === pid);
    if (!p) continue;
    ghState.boards.add(pid);
    for (const [fid, oid] of Object.entries(saved.values?.[pid] || {})) {
      if (p.fields.some((f) => f.id === fid && f.options.some((o) => o.id === oid))) fieldSel(pid, fid).add(oid);
    }
  }
}

function renderProjectsPick() {
  const sel = ghState.projects.filter((p) => ghState.boards.has(p.id));
  if (!sel.length) return setPickVal($('ghProjects'), [placeholder('Project')]);
  setPickVal($('ghProjects'), [icon('squares-four'), h('span', { class: 'txt' }, sel[0].title), more(sel.length - 1)], true);
}

function renderBoards() {
  const sel = ghState.projects.filter((p) => ghState.boards.has(p.id));
  $('ghBoards').replaceChildren(
    ...sel.map((p) => {
      const fields = p.fields.map((f) => {
        const btn = h(
          'button',
          { type: 'button', class: 'pick meta field-pick', 'aria-haspopup': 'listbox', 'data-tip': `${f.name} on ${p.title}` },
          h('span', { class: 'pick-val' }),
          icon('caret-down', 'icon caret'),
        );
        const paint = () => {
          const o = f.options.find((x) => fieldSel(p.id, f.id).has(x.id));
          setPickVal(btn, o ? [h('span', { class: 'pv-field' }, f.name), h('span', { class: 'pv-dot', style: `--c: ${BOARD_COLORS[o.color] || '#999'}` }), h('span', { class: 'txt' }, o.name)] : [placeholder(f.name)], o);
        };
        paint();
        btn.addEventListener('click', () =>
          showPicker(btn, {
            title: f.name,
            placeholder: `Search ${f.name.toLowerCase()}`,
            empty: 'No options',
            toggle: true,
            items: f.options,
            key: (o) => o.id,
            name: (o) => o.name,
            lead: (o) => h('span', { class: 'pv-dot', style: `--c: ${BOARD_COLORS[o.color] || '#999'}` }),
            selected: fieldSel(p.id, f.id),
            onChange: () => {
              paint();
              rememberBoards();
            },
          }),
        );
        return btn;
      });
      return h(
        'div',
        { class: 'gh-board' },
        h(
          'div',
          { class: 'gh-board-head' },
          icon('squares-four'),
          h('span', { class: 'txt' }, p.title),
          p.linked ? null : h('span', { class: 'pv-more' }, 'Not linked to this repo'),
          h('span', { class: 'spacer' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost icon-only sm gh-board-x',
              'data-tip': `Don't add to ${p.title}`,
              'aria-label': `Remove ${p.title}`,
              onclick: () => {
                ghState.boards.delete(p.id);
                renderProjectsPick();
                renderBoards();
                rememberBoards();
              },
            },
            icon('x'),
          ),
        ),
        fields.length ? h('div', { class: 'gh-meta' }, ...fields) : h('span', { class: 'muted-sm' }, 'This board has no dropdown fields.'),
      );
    }),
  );
}

async function loadProjects(repo) {
  ghState.projects = [];
  ghState.projectsError = null;
  ghState.boards.clear();
  ghState.fieldSel = {};
  $('ghBoards').replaceChildren();
  $('ghProjects').hidden = false;
  $('ghProjects').disabled = true;
  renderProjectsPick();
  try {
    const res = await ghJson(`/api/github/projects?repo=${encodeURIComponent(repo)}`);
    if (!ghState.repo.has(repo)) return;
    ghState.projects = res.projects || [];
    ghState.projectsError = res.error || null;
  } catch (err) {
    if (!ghState.repo.has(repo)) return;
    ghState.projectsError = err.message;
  }
  // No boards and nothing to explain: keep the row short.
  $('ghProjects').hidden = !ghState.projects.length && !ghState.projectsError;
  $('ghProjects').disabled = false;
  restoreBoards(repo);
  renderProjectsPick();
  renderBoards();
}

/** What the server needs to put the new issue on boards. */
function boardsPayload() {
  return [...ghState.boards].map((pid) => ({
    projectId: pid,
    values: Object.fromEntries(Object.entries(ghState.fieldSel[pid] || {}).filter(([, s]) => s.size).map(([fid, s]) => [fid, [...s][0]])),
  }));
}

async function loadRepoMeta(repo) {
  ghState.meta = null;
  ghState.labels.clear();
  ghState.assignees.clear();
  ghState.milestone.clear();
  $('ghMilestone').hidden = true;
  resetMetaPicks(true);
  if (!repo) return;
  loadProjects(repo);
  try {
    const meta = await ghJson(`/api/github/meta?repo=${encodeURIComponent(repo)}`);
    if (!ghState.repo.has(repo)) return; // another repository was picked meanwhile
    ghState.meta = meta;
    // Pre-select the label that matches the report type.
    const kind = rec.report?.kind || rec.meta?.kind || 'bug';
    const wanted = kind === 'suggestion' ? /enhancement|suggestion|feature/i : /^bug$/i;
    const match = meta.labels.find((l) => wanted.test(l.name));
    if (match) ghState.labels.add(match.name);
    $('ghMilestone').hidden = !meta.milestones.length;
    resetMetaPicks(false);
  } catch (err) {
    ghError(err.message);
  }
}

let ghBodyEdited = false;
let ghAiLabel = 'Claude';

/** "# Title\n\nbody" -> title field + description field. */
function fillGhFromMarkdown(md, fallbackTitle) {
  const text = String(md || '').trim();
  const m = /^#\s+(.+)\n?/.exec(text);
  $('ghTitle').value = m ? m[1].trim() : fallbackTitle || rec.meta?.title || '';
  $('ghBody').value = withShotImage(m ? text.slice(m[0].length).trim() : text);
}

function setGhKind(kind) {
  document.querySelectorAll('[data-ghkind]').forEach((b) => b.classList.toggle('on', b.dataset.ghkind === kind));
}

async function writeGhWithClaude() {
  const btn = $('ghWrite');
  const hint = $('ghAiHint');
  if (!$('ghWhat').value.trim()) {
    hint.className = 'ai-hint bad';
    hint.textContent = 'Describe what happened first.';
    return $('ghWhat').focus();
  }
  if (ghBodyEdited && !btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.querySelector('span:last-child').textContent = 'Replace my edits?';
    hint.className = 'ai-hint';
    hint.textContent = '';
    setTimeout(() => {
      if (!btn.classList.contains('armed')) return;
      btn.classList.remove('armed');
      btn.querySelector('span:last-child').textContent = 'Write with Claude';
    }, 4000);
    return;
  }
  btn.classList.remove('armed');
  const kind = document.querySelector('[data-ghkind].on')?.dataset.ghkind || 'bug';
  btn.disabled = true;
  btn.classList.add('busy');
  $('ghCreate').disabled = true;
  $('ghBody').classList.add('writing');
  btn.querySelector('span:last-child').textContent = 'Writing…';
  hint.className = 'ai-hint';
  hint.textContent = 'About 10 seconds';
  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: $('ghWhat').value, kind }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server answered ${res.status}`);
    // Keep the Report tab in step: same report, same description.
    rec.report = body;
    rec.meta = { ...rec.meta, description: $('ghWhat').value };
    $('what').value = $('ghWhat').value;
    reportDirty = false;
    $('saveReport').hidden = true;
    renderReport();
    renderDetails();
    fillGhFromMarkdown(body.markdown);
    const link = shareLink();
    if (link && !$('ghBody').value.includes(link)) $('ghBody').value += `\n\n**${isShot() ? 'Screenshot' : 'Recording'}:** ${link}`;
    ghBodyEdited = false;
    hint.textContent = `Written by ${ghAiLabel}`;
    // Match the label to the report type when the repo has one.
    if (ghState.meta) {
      const wanted = kind === 'suggestion' ? /enhancement|suggestion|feature/i : /^bug$/i;
      const other = kind === 'suggestion' ? /^bug$/i : /enhancement|suggestion|feature/i;
      for (const l of ghState.meta.labels) if (other.test(l.name)) ghState.labels.delete(l.name);
      const match = ghState.meta.labels.find((l) => wanted.test(l.name));
      if (match) ghState.labels.add(match.name);
      renderLabelsPick();
    }
  } catch (err) {
    hint.className = 'ai-hint bad';
    hint.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    $('ghCreate').disabled = false;
    $('ghBody').classList.remove('writing');
    btn.querySelector('span:last-child').textContent = rec.report?.model ? 'Rewrite with Claude' : 'Write with Claude';
  }
}

function setGhDone(done) {
  $('ghForm').hidden = done;
  $('ghDone').hidden = !done;
  document.querySelector('.gh-modal').classList.toggle('is-done', done);
  $('cr').classList.toggle('is-done', done);
}

async function openGitHub({ inline = false } = {}) {
  if (driveMode || !rec) return;
  closeMenu();
  const back = $('gh');
  if (!inline) back.hidden = false;
  ghError('');
  ghLastIssue = null;
  setGhDone(false);
  $('ghFoot').hidden = false;
  $('ghCreate').disabled = false;
  const status = await ghJson('/api/github').catch(() => ({ configured: false }));
  $('ghSetup').hidden = status.configured;
  $('ghFields').hidden = !status.configured;
  $('ghCreate').hidden = !status.configured;
  if (!status.configured) return;
  ghState.repos = [];
  ghState.repo.clear();
  ghState.projects = [];
  ghState.boards.clear();
  $('ghBoards').replaceChildren();
  $('ghProjects').hidden = true;
  setPickVal($('ghRepo'), [placeholder('Loading repositories…')]);
  resetMetaPicks(true);
  try {
    // Unsaved edits in the Report tab go into the issue too.
    const draft = await ghJson(`/api/recordings/${encodeURIComponent(id)}/github/draft`);
    // Unsaved Report tab edits first, then a saved report, else the template filled from the recording
    // (preconditions, steps, attachments), so the issue is useful before anything is written.
    if (reportDirty) fillGhFromMarkdown($('report').value, draft.title);
    else if (draft.hasReport) {
      $('ghTitle').value = draft.title;
      $('ghBody').value = draft.body;
    } else fillGhFromMarkdown(buildReport(), draft.title);
    ghBodyEdited = false;
    $('ghWhat').value = $('what').value || rec.meta?.description || '';
    setGhKind(rec.report?.kind || rec.meta?.kind || 'bug');
    $('ghAiHint').textContent = '';
    $('ghAiHint').className = 'ai-hint';
    $('ghWrite').classList.remove('armed');
    $('ghWrite').disabled = false;
    $('ghWrite').querySelector('span:last-child').textContent = rec.report?.model ? 'Rewrite with Claude' : 'Write with Claude';
    fetch('/api/ai')
      .then((r) => r.json())
      .then((s) => {
        ghAiLabel = s?.label ? s.label.split(' · ')[0] : 'Claude';
        if (s && s.available === false) {
          $('ghWrite').disabled = true;
          $('ghAiHint').className = 'ai-hint bad';
          $('ghAiHint').textContent = 'Set up AI reports in BugSnap Settings';
        }
      })
      .catch(() => {});
    if (!inline) setTimeout(() => $('ghWhat').focus(), 30);
    const repos = await ghJson('/api/github/repos');
    ghState.repos = repos;
    if (!repos.length) {
      renderRepoPick();
      ghError('The token cannot see any repository with issues. Give it access in GitHub settings.');
      $('ghCreate').disabled = true;
      return;
    }
    const selected = repos.some((r) => r.fullName === draft.repo) ? draft.repo : repos[0].fullName;
    ghState.repo.add(selected);
    renderRepoPick();
    loadRepoMeta(selected);
  } catch (err) {
    ghError(err.message);
  }
}

function closeGitHub() {
  if (crOpen()) return closeCreate();
  const back = $('gh');
  if (back.hidden || back.classList.contains('closing')) return;
  closePop();
  back.classList.add('closing');
  setTimeout(() => {
    back.hidden = true;
    back.classList.remove('closing');
    tellParent({ type: 'close', description: $('ghWhat').value, kind: document.querySelector('[data-ghkind].on')?.dataset.ghkind, issue: ghLastIssue });
  }, 180);
}

let ghLastIssue = null;

if (!driveMode) {
  $('ghOpen').addEventListener('click', openGitHub);
  $('ghClose').addEventListener('click', closeGitHub);
  $('ghCancel').addEventListener('click', closeGitHub);
  $('ghDoneClose').addEventListener('click', closeGitHub);
  $('gh').addEventListener('click', (e) => e.target === $('gh') && closeGitHub());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('gh').hidden && closeGitHub());
  $('ghForm').addEventListener('scroll', closePop, true);
  // A line above the pinned footer while there is more form below it.
  const footLine = () => { const f = $('ghForm'); f.classList.toggle('scrolled-up', f.scrollHeight - f.scrollTop - f.clientHeight > 2); };
  $('ghForm').addEventListener('scroll', footLine);
  new ResizeObserver(footLine).observe($('ghFields'));

  $('ghRepo').addEventListener('click', () => {
    if (!ghState.repos.length) return;
    showPicker($('ghRepo'), {
      title: 'Repository',
      placeholder: 'Search repositories',
      items: ghState.repos,
      key: (r) => r.fullName,
      name: (r) => r.fullName.split('/')[1],
      sub: (r) => r.fullName.split('/')[0],
      tail: (r) => (r.private ? icon('lock-simple', 'icon lock') : null),
      selected: ghState.repo,
      onChange: () => {
        renderRepoPick();
        loadRepoMeta([...ghState.repo][0]);
      },
    });
  });
  $('ghLabels').addEventListener('click', () => {
    if (!ghState.meta) return;
    showPicker($('ghLabels'), {
      title: 'Labels',
      placeholder: 'Search labels',
      empty: 'No labels in this repository',
      multi: true,
      items: ghState.meta.labels,
      key: (l) => l.name,
      name: (l) => l.name,
      sub: (l) => l.description,
      lead: (l) => h('span', { class: 'pv-dot', style: `--c: #${l.color}` }),
      selected: ghState.labels,
      onChange: renderLabelsPick,
    });
  });
  $('ghAssignees').addEventListener('click', () => {
    if (!ghState.meta) return;
    showPicker($('ghAssignees'), {
      title: 'Assignees',
      placeholder: 'Search people',
      empty: 'Nobody can be assigned',
      multi: true,
      items: ghState.meta.assignees,
      key: (a) => a.login,
      name: (a) => a.login,
      lead: (a) => h('img', { src: a.avatar, alt: '' }),
      selected: ghState.assignees,
      onChange: renderAssigneesPick,
    });
  });
  $('ghMilestone').addEventListener('click', () => {
    if (!ghState.meta) return;
    showPicker($('ghMilestone'), {
      title: 'Milestone',
      placeholder: 'Search milestones',
      toggle: true,
      items: ghState.meta.milestones,
      key: (m) => String(m.number),
      name: (m) => m.title,
      selected: ghState.milestone,
      onChange: renderMilestonePick,
    });
  });

  $('ghProjects').addEventListener('click', () => {
    showPicker($('ghProjects'), {
      title: 'Project boards',
      placeholder: 'Search boards',
      empty: ghState.projectsError || 'No project boards',
      multi: true,
      items: ghState.projects,
      key: (p) => p.id,
      name: (p) => p.title,
      sub: (p) => `${p.linked ? 'Linked to this repo' : 'Owner board'} · ${p.fields.length ? p.fields.map((f) => f.name).join(', ') : 'no dropdown fields'}`,
      lead: () => icon('squares-four'),
      selected: ghState.boards,
      onChange: () => {
        renderProjectsPick();
        renderBoards();
        rememberBoards();
      },
      // Boards sit under the description: bring them into view once the list closes.
      onClose: () => $('ghBoards').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    });
  });
  document.querySelectorAll('[data-ghkind]').forEach((b) => b.addEventListener('click', () => setGhKind(b.dataset.ghkind)));
  $('ghWrite').addEventListener('click', writeGhWithClaude);
  $('ghWhat').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      writeGhWithClaude();
    }
  });
  $('ghBody').addEventListener('input', () => (ghBodyEdited = true));
  $('ghTitle').addEventListener('input', () => (ghBodyEdited = true));
  $('ghDoneCopy').addEventListener('click', async () => {
    const btn = $('ghDoneCopy');
    const ok = await copyText($('ghDoneLink').href);
    btn.classList.toggle('copied', ok);
    setIcon(btn, ok ? 'check' : 'warning-circle');
    btn.querySelector('span:last-child').textContent = ok ? 'Copied' : "Couldn't copy";
    setTimeout(() => {
      btn.classList.remove('copied');
      setIcon(btn, 'copy');
      btn.querySelector('span:last-child').textContent = 'Copy link';
    }, 1600);
  });
  $('ghForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitGitHub();
  });
}

/** What is missing before an issue can be created, or ''. */
const ghMissing = () => (![...ghState.repo][0] ? 'Choose a repository.' : !$('ghTitle').value.trim() ? 'Add a title.' : '');

async function submitGitHub() {
  {
    ghError('');
    const repo = [...ghState.repo][0];
    if (ghMissing()) return ghError(ghMissing());
    const btn = $('ghCreate');
    btn.disabled = true;
    btn.querySelector('span:last-child').textContent = 'Creating…';
    try {
      const issue = await ghJson(`/api/recordings/${encodeURIComponent(id)}/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo,
          title: $('ghTitle').value,
          body: $('ghBody').value,
          labels: [...ghState.labels],
          assignees: [...ghState.assignees],
          milestone: [...ghState.milestone][0] || null,
          projects: boardsPayload(),
        }),
      });
      rec.github = [issue, ...(rec.github || [])];
      ghLastIssue = { number: issue.number, url: issue.url };
      renderDetails();
      renderInfo();
      $('ghDoneText').textContent = `Issue #${issue.number} created`;
      const failed = (issue.boards || []).filter((b) => !b.ok);
      const added = (issue.boards || []).filter((b) => b.ok).map((b) => ghState.projects.find((p) => p.id === b.projectId)?.title).filter(Boolean);
      $('ghDoneSub').textContent = added.length ? `${issue.repo} · on ${added.join(', ')}` : issue.repo;
      $('ghDoneWarn').hidden = !failed.length;
      $('ghDoneWarn').textContent = failed.length ? `Couldn't add it to ${failed.map((b) => ghState.projects.find((p) => p.id === b.projectId)?.title || 'a board').join(', ')}: ${failed[0].error}` : '';
      $('ghDoneLink').href = issue.url;
      setGhDone(true);
      tellParent({ type: 'created', kind: 'github', issue: ghLastIssue });
      setTimeout(() => $('ghDoneLink').focus(), 30);
      return true;
    } catch (err) {
      ghError(err.message);
      return false;
    } finally {
      btn.disabled = false;
      btn.querySelector('span:last-child').textContent = 'Create issue';
    }
  }
}

// Back from the editor: pick up the new image, title and description.
if (!driveMode) {
  window.addEventListener('focus', async () => {
    if (!isShot()) return;
    const r = await fetchRecording().catch(() => null);
    if (!r || r.updatedAt === rec.updatedAt) return;
    rec = { ...rec, ...r };
    render();
  });
}

// ---------------------------------------------------------------- annotate (screenshots, local server)
// The editor lives in the extension; its content script on this page opens it.

/** Ask the extension to open a screenshot in the editor. Resolves false if it did not answer. */
function openInEditor(shotId) {
  return new Promise((resolve) => {
    let answered = false;
    const onAck = (e) => {
      if (e.source === window && e.data?.source === 'bugsnap-ext' && e.data.type === 'annotate-ack') answered = true;
    };
    window.addEventListener('message', onAck);
    window.postMessage({ source: 'bugsnap-page', type: 'annotate', id: shotId }, location.origin);
    setTimeout(() => {
      window.removeEventListener('message', onAck);
      resolve(answered);
    }, 900);
  });
}

if (!driveMode) {
  $('annotate').addEventListener('click', async () => {
    if (!(await openInEditor(id))) flash($('annotate'), 'warning-circle', 'Needs the extension');
  });
}

// ---------------------------------------------------------------- capture a frame (recordings, local server)
// The frame at the current moment becomes a screenshot (in All recordings, editable, shareable),
// linked to this recording and moment. Its image goes inline into this recording's GitHub issues.

function frameToast(state, text, actions = []) {
  let el = $('frameToast');
  if (!el) {
    el = h('div', { class: 'frame-toast', id: 'frameToast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  clearTimeout(frameToast.timer);
  el.dataset.state = state;
  el.replaceChildren(icon(state === 'busy' ? 'spinner-gap' : state === 'error' ? 'warning-circle' : 'check'), h('span', { class: 'ft-text' }, text), ...actions);
  el.hidden = false;
  el.classList.remove('out');
  if (state !== 'busy') {
    frameToast.timer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => (el.hidden = true), 200);
    }, state === 'error' ? 6000 : 9000);
  }
}

async function captureFrame() {
  const btn = $('frameBtn');
  if (driveMode || isShot() || fallbackActive || !btn || btn.disabled) return;
  if (!video.videoWidth) return frameToast('error', 'The video is not ready yet.');
  video.pause();
  const at = video.currentTime;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return frameToast('error', "Couldn't read this frame.");
  btn.disabled = true;
  frameToast('busy', `Saving frame at ${fmt(at)}…`);
  try {
    // The page that was open at that moment, for the screenshot's details.
    const nav = lists.steps.filter((e) => e.type === 'navigation' && e.url && offsetOf(e) <= at + 0.05).at(-1);
    const created = await ghJson(`/api/recordings/${encodeURIComponent(id)}/frames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at, pageUrl: nav?.url || rec.meta?.startUrl }),
    });
    for (const part of ['original', 'image']) {
      const res = await fetch(`/api/recordings/${encodeURIComponent(created.id)}/${part}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
      if (!res.ok) throw new Error(`Couldn't save the frame (${res.status})`);
    }
    await ghJson(`/api/recordings/${encodeURIComponent(created.id)}/finalize-shot?now=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `${rec.meta?.title || 'Recording'} · ${fmt(at)}`, kind: rec.report?.kind || rec.meta?.kind || 'bug', width: canvas.width, height: canvas.height }),
    });
    rec.frames = [...(rec.frames || []), created.id];
    rec.frameShots = [...(rec.frameShots || []), { id: created.id, at, viewerUrl: created.viewerUrl, fileId: null }].sort((a, b) => a.at - b.at);
    renderInfo();
    renderReport();
    // The Drive copy (for inline images in issues) appears a moment later.
    setTimeout(async () => {
      const r = await fetchRecording().catch(() => null);
      if (r?.frameShots) {
        rec.frameShots = r.frameShots;
        renderReport();
      }
    }, 6000);
    const annotate = h('button', { type: 'button', class: 'ft-btn' }, 'Annotate');
    annotate.addEventListener('click', async () => {
      if (!(await openInEditor(created.id))) window.open(created.viewerUrl, '_blank', 'noopener');
    });
    const view = h('a', { class: 'ft-btn', href: created.viewerUrl, target: '_blank', rel: 'noopener' }, 'Open');
    frameToast('done', `Frame at ${fmt(at)} saved`, [annotate, view]);
  } catch (err) {
    frameToast('error', err.message || "Couldn't save the frame.");
  } finally {
    btn.disabled = false;
  }
}

if (!driveMode) $('frameBtn').addEventListener('click', captureFrame);

// ---------------------------------------------------------------- create dialog (local server)
// Right after a capture: the video (with a trim bar) or screenshot on the left, and on the right
// "Create a [Link to share | GitHub issue]". The GitHub issue form is the same one as above,
// moved into the right side.

const CR_KINDS = [
  { key: 'link', name: 'Link to share', icon: 'link-simple' },
  { key: 'github', name: 'GitHub issue', icon: 'github-logo' },
];
const CR_KIND_KEY = 'bugsnap.create.kind';
const cr = { open: false, kind: new Set(), ghReady: false, busy: false, start: 0, end: 0, dur: 0, raf: 0, saved: { title: '', description: '' } };
const crOpen = () => cr.open;
const crKind = () => [...cr.kind][0] || 'link';
const crVideo = $('crVideo');
const isRecording = () => rec && !isShot();

function crError(message) {
  $('crAlert').hidden = !message;
  $('crAlertText').textContent = message || '';
}

function openCreate() {
  if (driveMode || !rec) return;
  cr.open = true;
  let kind = 'link';
  try {
    kind = localStorage.getItem(CR_KIND_KEY) || kind;
  } catch {
    /* storage blocked */
  }
  cr.kind = new Set([CR_KINDS.some((k) => k.key === kind) ? kind : 'link']);
  $('crTitle').value = rec.meta?.title || '';
  $('crDesc').value = rec.meta?.description || '';
  cr.saved = { title: $('crTitle').value, description: $('crDesc').value };
  crError('');
  $('cr').hidden = false;
  crMedia();
  crSetKind();
  crNote();
  // The link is reserved on Drive in the background; ask for it now so Create is quick.
  ensurePublicLink().then(crNote);
  crFolderRender();
  crLoadFolders();
  if (crKind() === 'link' && !embedded) setTimeout(() => $('crTitle').focus(), 30);
}

function closeCreate() {
  if (!cr.open) return;
  closePop();
  crVideo.pause();
  const saving = crSaveDetails().catch(() => {});
  // The extension removes this frame on close: let the save finish first.
  if (embedded) return void saving.finally(() => tellParent({ type: 'close', issue: ghLastIssue }));
  cr.open = false;
  const back = $('cr');
  back.classList.add('closing');
  setTimeout(() => {
    back.hidden = true;
    back.classList.remove('closing');
  }, 180);
  if (params.has('create')) {
    params.delete('create');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
  }
}

function crSetKind() {
  const k = CR_KINDS.find((x) => x.key === crKind());
  setPickVal($('crKind'), [icon(k.icon), h('span', { class: 'txt' }, k.name)], true);
  const gh = k.key === 'github';
  $('crLinkFields').hidden = gh;
  $('crGhSlot').hidden = !gh;
  crError('');
  if (gh && !cr.ghReady) {
    // Move the issue form (and its success card) into the dialog, then load repos and labels.
    cr.ghReady = true;
    $('crGhSlot').append($('ghForm'), $('ghDone'));
    openGitHub({ inline: true });
  }
  crNote();
}

// ---- folder (project) for this capture; new captures go to the folder chosen last

const crFolders = { list: [], sel: new Set() };

function crFolderRender() {
  const f = crFolders.list.find((x) => x.id === rec.folderId);
  setPickVal($('crFolder'), [icon('folder-open'), h('span', { class: 'txt' }, f ? f.name : 'No folder')], Boolean(f));
  $('crFolder').dataset.tip = f ? `In the "${f.name}" folder` : 'Put it in a project folder';
}

async function crLoadFolders() {
  try {
    crFolders.list = (await ghJson('/api/folders')).folders || [];
  } catch {
    crFolders.list = [];
  }
  crFolderRender();
}

async function crMoveToFolder(folderId) {
  try {
    await ghJson('/api/folders/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], folderId, remember: true }) });
    rec.folderId = folderId;
  } catch (err) {
    crError(err.message);
  }
  crFolderRender();
}

function crPickFolder() {
  crFolders.sel = new Set([rec.folderId || '']);
  showPicker($('crFolder'), {
    title: 'Folder',
    placeholder: 'Find or create a folder',
    items: [{ id: '', name: 'No folder' }, ...crFolders.list],
    key: (f) => f.id,
    name: (f) => f.name,
    lead: (f) => (f.id ? h('span', { class: 'pv-dot', style: `--c: ${f.color}` }) : icon('x')),
    sub: (f) => (f.id ? `${f.count || 0} item${f.count === 1 ? '' : 's'}` : null),
    selected: crFolders.sel,
    createLabel: 'New folder',
    create: async (name) => {
      try {
        const f = await ghJson('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        crFolders.list.push(f);
        await crMoveToFolder(f.id);
      } catch (err) {
        crError(err.message);
      }
    },
    onChange: () => crMoveToFolder([...crFolders.sel][0] || null),
  });
}

function crNote() {
  if (!cr.open) return;
  const what = isShot() ? 'view it' : 'watch it';
  $('crLinkNote').textContent = !rec.driveConnected && !rec.shareUrl
    ? 'Google Drive is not connected, so only you can open the link. Connect it in BugSnap Settings.'
    : `Create copies the link and opens it in a new tab. Anyone with the link can ${what}.`;
}

// ---- left side: the video with a trim bar, or the screenshot

function crMedia() {
  if (!cr.open) return;
  const shot = isShot();
  const ready = rec.status === 'ready';
  $('crImage').hidden = !shot;
  crVideo.hidden = shot || !ready;
  $('crState').hidden = shot || ready;
  $('crTrim').hidden = shot || !ready;
  $('crMedia').classList.toggle('is-shot', shot);
  if (shot) {
    const src = `/api/recordings/${encodeURIComponent(id)}/image?v=${encodeURIComponent(rec.updatedAt || '')}`;
    if ($('crImage').getAttribute('src') !== src) $('crImage').src = src;
    return;
  }
  if (!ready) {
    $('crStateText').textContent = rec.status === 'recording' ? 'Still recording…' : 'Preparing video…';
    return;
  }
  const src = `/api/recordings/${encodeURIComponent(id)}/video?v=${encodeURIComponent(rec.videoRev ? `t${rec.videoRev}` : 'p')}`;
  if (crVideo.getAttribute('src') !== src) {
    crVideo.src = src;
    if (rec.hasPoster) crVideo.poster = `/api/recordings/${encodeURIComponent(id)}/poster?v=${encodeURIComponent(rec.videoRev || 0)}`;
    cr.dur = (rec.durationMs || 0) / 1000;
    cr.start = 0;
    cr.end = cr.dur;
  }
  crTrimRender();
}

const crClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const crTrimmed = () => cr.dur > 0 && (cr.start > 0.05 || cr.end < cr.dur - 0.05);

function crSecs(sec) {
  const v = sec < 10 ? Math.round(sec * 10) / 10 : Math.round(sec);
  return `${v} second${v === 1 ? '' : 's'}`;
}

function crTrimRender() {
  const d = cr.dur || 1;
  const a = (cr.start / d) * 100;
  const b = (cr.end / d) * 100;
  $('crSel').style.left = `${a}%`;
  $('crSel').style.right = `${100 - b}%`;
  $('crIn').style.left = `${a}%`;
  $('crOut').style.left = `${b}%`;
  $('crHead').style.left = `${(crClamp(crVideo.currentTime || 0, 0, d) / d) * 100}%`;
  $('crLength').textContent = crSecs(cr.end - cr.start);
  const trimmed = crTrimmed();
  $('crRange').hidden = !trimmed;
  $('crRange').textContent = trimmed ? `${fmt(cr.start)} – ${fmt(cr.end)} of ${fmt(cr.dur)}` : '';
  $('crReset').hidden = !trimmed;
  $('crTrack').classList.toggle('trimmed', trimmed);
  crNote();
}

function crPlayIcon() {
  setIcon($('crPlay'), crVideo.paused ? 'play-fill' : 'pause-fill');
  $('crPlay').dataset.tip = crVideo.paused ? 'Play' : 'Pause';
}

function crTogglePlay() {
  if (crVideo.hidden) return;
  if (!crVideo.paused) return crVideo.pause();
  // Play the kept part only.
  if (crVideo.currentTime < cr.start || crVideo.currentTime >= cr.end - 0.05) crVideo.currentTime = cr.start;
  crVideo.play().catch(() => {});
}

function crTick() {
  cancelAnimationFrame(cr.raf);
  if (crVideo.paused) return;
  if (crVideo.currentTime >= cr.end) {
    crVideo.pause();
    crVideo.currentTime = cr.end;
  }
  crTrimRender();
  cr.raf = requestAnimationFrame(crTick);
}

const crSecAt = (e) => {
  const r = $('crTrack').getBoundingClientRect();
  return crClamp((e.clientX - r.left) / r.width, 0, 1) * cr.dur;
};

function crDragHandle(handle, which) {
  handle.addEventListener('pointerdown', (e) => {
    if (cr.busy) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('drag');
    crVideo.pause();
    const move = (ev) => {
      const sec = crSecAt(ev);
      if (which === 'in') cr.start = crClamp(sec, 0, cr.end - 0.5);
      else cr.end = crClamp(sec, cr.start + 0.5, cr.dur);
      // Show the frame at the cut.
      crVideo.currentTime = which === 'in' ? cr.start : cr.end;
      crTrimRender();
    };
    const up = () => {
      handle.classList.remove('drag');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    if (cr.busy || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
    if (which === 'in') cr.start = crClamp(cr.start + step, 0, cr.end - 0.5);
    else cr.end = crClamp(cr.end + step, cr.start + 0.5, cr.dur);
    crVideo.currentTime = which === 'in' ? cr.start : cr.end;
    crTrimRender();
  });
}

/** Save the title and description typed on the Link side (also on close). */
async function crSaveDetails() {
  const title = $('crTitle').value.trim();
  const description = $('crDesc').value;
  if (title === cr.saved.title.trim() && description === cr.saved.description) return;
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  if (!res.ok) throw new Error('Could not save the title and description.');
  const saved = await res.json();
  cr.saved = { title: saved.title, description: saved.description };
  rec.meta = { ...rec.meta, title: saved.title, description: saved.description };
  renderDetails();
  tellParent({ type: 'details', title: saved.title, description: saved.description });
}

/** The screenshot editor next to this panel saves the latest marks before anything is created. */
function crFlushParent() {
  if (embedMode !== 'panel') return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const onMsg = (e) => e.source === window.parent && e.data?.source === 'bugsnap-host' && e.data.type === 'flushed' && done();
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      resolve();
    };
    timer = setTimeout(done, 10000);
    window.addEventListener('message', onMsg);
    tellParent({ type: 'flush' });
  });
}

/** Cut the video to the kept part (if the bar was moved), then reload what the cut changed. */
async function crApplyTrim() {
  if (!isRecording() || !crTrimmed()) return;
  crBusy('Trimming…');
  crVideo.pause();
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: cr.start, end: cr.end }),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) throw new Error(body.error || "Couldn't trim the video. Is the server running?");
  const fresh = await fetchRecording();
  if (fresh) rec = fresh;
  render();
  crMedia();
  // The issue text came from the untrimmed steps: rebuild it unless it was written or edited.
  if (cr.ghReady && !ghBodyEdited && !reportDirty && !rec.report?.markdown) {
    const title = $('ghTitle').value;
    fillGhFromMarkdown(buildReport(), title);
    $('ghTitle').value = title;
  }
}

function crBusy(text) {
  cr.busy = Boolean(text);
  const btn = $('crCreate');
  btn.disabled = cr.busy;
  btn.classList.toggle('busy', cr.busy);
  btn.querySelector('span:last-child').textContent = text || 'Create';
  $('crTrim').classList.toggle('locked', cr.busy);
}

/** Open a link in a new tab: the extension does it when we are inside it (no popup blocker). */
function crOpenTab(url) {
  if (embedded) tellParent({ type: 'open', url });
  else window.open(url, '_blank', 'noopener');
}

async function crCreate() {
  if (cr.busy) return;
  crError('');
  const kind = crKind();
  if (kind === 'github') {
    ghError('');
    const missing = ghMissing();
    if (missing) return ghError(missing);
  }
  try {
    crBusy(kind === 'github' ? 'Creating…' : 'Creating link…');
    await crFlushParent();
    await crApplyTrim();
    if (kind === 'github') {
      crBusy('Creating issue…');
      await submitGitHub();
      return;
    }
    crBusy('Creating link…');
    await crSaveDetails();
    await ensurePublicLink();
    const url = shareLink();
    await copyText(url);
    crOpenTab(url);
    tellParent({ type: 'created', kind: 'link', url });
    closeCreate();
  } catch (err) {
    crError(err.message);
  } finally {
    crBusy('');
  }
}

function crKeys(e) {
  if (e.key === 'Escape') {
    if (openPop) return;
    e.preventDefault();
    return closeCreate();
  }
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault();
    crTogglePlay();
  }
}

if (!driveMode) {
  $('crClose').addEventListener('click', closeCreate);
  $('crClose2').addEventListener('click', closeCreate);
  $('crCreate').addEventListener('click', crCreate);
  $('crFolder').addEventListener('click', crPickFolder);
  $('crKind').addEventListener('click', () => {
    showPicker($('crKind'), {
      title: 'Create a',
      noSearch: true,
      items: CR_KINDS,
      key: (k) => k.key,
      name: (k) => k.name,
      lead: (k) => icon(k.icon),
      selected: cr.kind,
      onChange: () => {
        try {
          localStorage.setItem(CR_KIND_KEY, crKind());
        } catch {
          /* storage blocked */
        }
        crSetKind();
      },
    });
  });
  $('crBody').addEventListener('scroll', closePop, true);
  crDragHandle($('crIn'), 'in');
  crDragHandle($('crOut'), 'out');
  $('crTrack').addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cr-handle') || !cr.dur || cr.busy) return;
    crVideo.currentTime = crClamp(crSecAt(e), cr.start, cr.end);
    crTrimRender();
  });
  $('crReset').addEventListener('click', () => {
    cr.start = 0;
    cr.end = cr.dur;
    crTrimRender();
  });
  $('crPlay').addEventListener('click', crTogglePlay);
  crVideo.addEventListener('click', crTogglePlay);
  crVideo.addEventListener('play', () => {
    crPlayIcon();
    crTick();
  });
  crVideo.addEventListener('pause', () => {
    crPlayIcon();
    crTrimRender();
  });
  crVideo.addEventListener('seeked', crTrimRender);
  crVideo.addEventListener('loadedmetadata', () => {
    // Older recordings may lack a duration in the record: use the file's.
    if (!cr.dur && Number.isFinite(crVideo.duration)) {
      cr.dur = crVideo.duration;
      cr.end = cr.dur;
    }
    crTrimRender();
  });
  $('crTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('crDesc').focus();
    }
  });
  // From the editor next door: its latest title.
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.data?.source !== 'bugsnap-host') return;
    if (e.data.type === 'title' && typeof e.data.title === 'string') {
      rec.meta = { ...rec.meta, title: e.data.title };
      if ($('crTitle').value === cr.saved.title) $('crTitle').value = e.data.title;
      cr.saved.title = e.data.title;
    }
  });
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (crOpen()) return crKeys(e);
  if (!$('review').hidden || ($('gh') && !$('gh').hidden)) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' || e.key === 'j') seek(video.currentTime - 5);
  else if (e.key === 'ArrowRight' || e.key === 'l') seek(video.currentTime + 5);
  else if (e.key === 'f') toggleFull();
  else if (e.key === 'm') video.muted = !video.muted;
  else if (e.key === 's' && !driveMode) captureFrame();
});

load();

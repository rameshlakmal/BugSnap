// Recordings library: thumbnail grid with filters and search. Hover plays a short muted
// preview, click opens the player. The same file runs as the extension's Recordings window
// (library.html) and as the server home page. Copied to server/public/library.js: keep in sync.
const inExtension = !!globalThis.chrome?.runtime?.id;
const I = globalThis.ScreenRecIcons || {};
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function icon(name) {
  const s = el('span', 'icon');
  s.innerHTML = I[name] || ''; // trusted, bundled SVG
  return s;
}
document.querySelectorAll('[data-icon]').forEach((n) => (n.innerHTML = I[n.dataset.icon] || ''));

const duration = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function relative(iso) {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const errorsOf = (r) => (r.eventCounts ? (r.eventCounts.consoleErrors || 0) + (r.eventCounts.networkErrors || 0) : 0);
const isShot = (r) => r.type === 'screenshot' || r.mode === 'screenshot';
const FILTERS = {
  all: () => true,
  tab: (r) => !isShot(r) && r.mode !== 'desktop',
  screen: (r) => !isShot(r) && r.mode === 'desktop',
  shots: (r) => isShot(r),
  errors: (r) => errorsOf(r) > 0,
};

let base = '';
let items = [];
let filter = 'all';
let source = 'server'; // 'server' | 'local' (listing disabled) | 'offline'

async function serverBase() {
  if (!inExtension) return location.origin;
  const { settings } = await chrome.storage.local.get('settings');
  return (settings?.serverUrl || 'http://localhost:4800').replace(/\/$/, '');
}

async function localRecent() {
  const { recent = [] } = await chrome.storage.local.get('recent');
  return recent.map((r) => ({ status: 'ready', ...r }));
}

function skeleton() {
  const grid = el('div', 'grid');
  for (let i = 0; i < 6; i++) {
    const c = el('div');
    c.append(el('div', 'sk sk-thumb'), el('div', 'sk sk-text'));
    grid.append(c);
  }
  $('content').replaceChildren(grid);
}

async function load() {
  skeleton();
  $('note').hidden = true;
  base = await serverBase();
  try {
    const res = await fetch(`${base}/api/recordings`, { cache: 'no-store' });
    if (res.status === 404 && inExtension) {
      items = await localRecent();
      source = 'local';
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      items = await res.json();
      source = 'server';
    }
  } catch {
    items = inExtension ? await localRecent() : null;
    source = 'offline';
  }
  draw();
}

function open(url, event) {
  if (!inExtension) return; // plain link on the server
  event.preventDefault();
  chrome.runtime.sendMessage({ type: 'open:url', url });
}

function attachPreview(card, thumb, r) {
  if (source === 'offline' || r.status !== 'ready' || isShot(r)) return;
  let timer;
  let video;
  card.addEventListener('pointerenter', () => {
    timer = setTimeout(() => {
      video = el('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = `${base}/api/recordings/${r.id}/video`;
      thumb.append(video);
      video.play().then(() => thumb.classList.add('playing')).catch(() => {});
    }, 350);
  });
  card.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    thumb.classList.remove('playing');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      video = null;
    }
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
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

/** Public link for a recording; reserves one (and starts the upload) if it has none. */
async function shareLink(r) {
  const local = r.viewerUrl || `${base}/r/${r.id}`;
  try {
    if (inExtension) {
      const res = await chrome.runtime.sendMessage({ type: 'share:link', id: r.id });
      return res?.result || { url: local, isPublic: false };
    }
    const res = await fetch(`/api/recordings/${encodeURIComponent(r.id)}/share`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    return body.shareUrl ? { url: body.shareUrl, isPublic: true } : { url: local, isPublic: false, error: body.error };
  } catch {
    return { url: local, isPublic: false, error: "Can't reach the server" };
  }
}

/** Open a saved screenshot in the editor (the extension does the editing). */
function openEditor(id, btn) {
  if (inExtension) return chrome.runtime.sendMessage({ type: 'snap:edit', id });
  // On the server page: ask the extension through its content script.
  let answered = false;
  const onAck = (e) => {
    if (e.source === window && e.data?.source === 'bugsnap-ext' && e.data.type === 'annotate-ack') answered = true;
  };
  window.addEventListener('message', onAck);
  window.postMessage({ source: 'bugsnap-page', type: 'annotate', id }, location.origin);
  setTimeout(() => {
    window.removeEventListener('message', onAck);
    if (!answered && btn) btn.dataset.tip = 'Needs the BugSnap extension in this browser';
  }, 900);
}

function card(r) {
  const url = r.viewerUrl || `${base}/r/${r.id}`;
  const a = el('a', 'card');
  a.href = url;
  a.addEventListener('click', (e) => open(url, e));

  const thumb = el('div', isShot(r) ? 'thumb shot' : 'thumb');
  thumb.append(el('div', 'ph', 'No preview'));
  if (r.hasPoster === false || source === 'offline') {
    thumb.classList.add('none');
  } else {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = `${base}/api/recordings/${r.id}/poster`;
    img.addEventListener('error', () => {
      img.remove();
      thumb.classList.add('none');
    });
    thumb.append(img);
  }

  const who = el('div', 'who');
  const name = r.reporter || 'You';
  who.append(el('span', 'avatar', name.trim().charAt(0) || '?'), el('span', '', name));
  thumb.append(who);

  if (isShot(r)) {
    const d = el('span', 'chip dur');
    d.append(icon('camera'), document.createTextNode('Screenshot'));
    thumb.append(d);
  } else if (r.durationMs) {
    const d = el('span', 'chip dur');
    d.append(icon('play-fill'), document.createTextNode(duration(r.durationMs)));
    thumb.append(d);
  }
  const errors = errorsOf(r);
  if (r.status && r.status !== 'ready') thumb.append(el('span', 'chip flag', r.status === 'recording' ? 'Recording' : 'Processing'));
  else if (r.driveStatus === 'pending' || r.driveStatus === 'uploading') thumb.append(el('span', 'chip flag', 'Uploading'));
  else if (r.driveStatus === 'error') thumb.append(el('span', 'chip flag bad', 'Upload failed'));
  else if (r.github) {
    const g = el('span', 'chip flag');
    g.append(icon('github-logo'), document.createTextNode(`#${r.github.number}`));
    g.title = `GitHub issue in ${r.github.repo}`;
    thumb.append(g);
  } else if (errors) thumb.append(el('span', 'chip flag bad', `${errors} ${errors === 1 ? 'error' : 'errors'}`));

  const copy = el('button', 'btn icon-only sm copy');
  copy.type = 'button';
  copy.dataset.tip = 'Copy share link';
  copy.append(icon('link-simple'));
  const reset = () => {
    copy.replaceChildren(icon('link-simple'));
    copy.dataset.tip = 'Copy share link';
  };
  copy.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    let link = r.shareUrl ? { url: r.shareUrl, isPublic: true } : null;
    if (!link) {
      // Not on Drive yet: reserve the public link now (the upload starts by itself).
      copy.replaceChildren(icon('spinner-gap'));
      link = await shareLink(r);
      if (link.isPublic) r.shareUrl = link.url;
    }
    const ok = await copyText(link.url);
    copy.replaceChildren(icon(ok ? 'check' : 'warning-circle'));
    copy.dataset.tip = !ok ? `Couldn't copy: ${link.url}` : link.isPublic ? 'Copied' : `Copied a local link only you can open. ${link.error || ''}`.trim();
    setTimeout(reset, link.isPublic && ok ? 1400 : 4000);
  });

  const meta = el('div', 'meta');
  meta.append(el('strong', '', r.title || 'Untitled'), el('small', '', relative(r.createdAt)));
  a.append(thumb, copy, meta);
  if (isShot(r) && r.status === 'ready' && source !== 'offline') {
    const edit = el('button', 'btn icon-only sm copy edit');
    edit.type = 'button';
    edit.dataset.tip = 'Annotate';
    edit.append(icon('pencil-simple'));
    edit.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditor(r.id, edit);
    });
    a.append(edit);
  }
  attachPreview(a, thumb, r);
  return a;
}

function emptyState(iconName, title, text) {
  const box = el('div', 'empty');
  const g = el('div', 'glyph');
  g.append(icon(iconName));
  box.append(g, el('strong', '', title));
  if (text) box.append(el('span', '', text));
  return box;
}

function draw() {
  const q = $('q').value.trim().toLowerCase();
  const note = $('note');
  note.hidden = source === 'server';
  if (source === 'offline') $('noteText').textContent = inExtension ? "Can't reach the server. Showing recordings from this computer." : "Can't reach the server.";
  if (source === 'local') $('noteText').textContent = 'Showing recordings from this computer.';

  for (const [key, fn] of Object.entries(FILTERS)) {
    const n = $(`n-${key}`);
    if (n) n.textContent = items ? String(items.filter(fn).length) : '';
  }
  document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
  $('heading').textContent = { all: 'All recordings', tab: 'Tab recordings', screen: 'Screen recordings', shots: 'Screenshots', errors: 'With errors' }[filter];

  if (items === null) return $('content').replaceChildren(emptyState('warning-circle', "Couldn't load recordings", 'Check the server and try again.'));

  const shown = items
    .filter(FILTERS[filter])
    .filter((r) => !q || `${r.title || ''} ${r.reporter || ''}`.toLowerCase().includes(q))
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));

  if (!shown.length) {
    return $('content').replaceChildren(
      items.length ? emptyState('magnifying-glass', 'No matches', 'Try another word or filter.') : emptyState('film-slate', 'No recordings yet', 'Record a tab or your screen to see it here.'),
    );
  }
  const grid = el('div', 'grid');
  grid.append(...shown.map(card));
  $('content').replaceChildren(grid);
}

$('q').addEventListener('input', draw);
$('refresh').addEventListener('click', load);
$('retry').addEventListener('click', load);
document.querySelectorAll('[data-filter]').forEach((b) =>
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    draw();
  }),
);
$('settingsLink')?.addEventListener('click', async (e) => {
  if (!inExtension) return;
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && document.activeElement !== $('q'))) {
    e.preventDefault();
    $('q').focus();
    $('q').select();
  }
});
if (inExtension) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.recent || changes.settings) load();
  });
}
load();

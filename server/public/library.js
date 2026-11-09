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
      await loadFolders();
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
  a.dataset.id = r.id;
  a.addEventListener('click', (e) => {
    // Ctrl/Cmd+click selects (to move several at once); a click while selecting adds to it.
    if (source === 'server' && (e.ctrlKey || e.metaKey || e.shiftKey || selected.size)) {
      e.preventDefault();
      selected.has(r.id) ? selected.delete(r.id) : selected.add(r.id);
      return drawSelection();
    }
    open(url, e);
  });
  if (source === 'server') {
    a.addEventListener('dragstart', (e) => {
      dragIds = selected.has(r.id) ? [...selected] : [r.id];
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragIds.join(','));
      document.body.classList.add('dragging');
    });
    a.addEventListener('dragend', () => {
      dragIds = null;
      document.body.classList.remove('dragging');
    });
  }

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
  meta.append(el('strong', '', r.title || 'Untitled'));
  const f = folderById(r.folderId);
  if (f && !filter.startsWith('folder:')) {
    const tag = el('small', 'ftag');
    const d = el('span', 'fdot');
    d.style.background = f.color;
    tag.append(d, document.createTextNode(f.name));
    meta.append(tag);
  }
  meta.append(el('small', '', relative(r.createdAt)));
  const acts = el('div', 'card-acts');
  if (source === 'server') {
    const mv = el('button', 'btn icon-only sm copy move');
    mv.type = 'button';
    mv.dataset.tip = 'Move to folder';
    mv.append(icon('folder-open'));
    mv.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      moveMenu(mv, selected.has(r.id) ? [...selected] : [r.id]);
    });
    acts.append(mv);
  }
  acts.append(copy);
  a.append(thumb, acts, meta);
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
    acts.prepend(edit);
  }
  attachPreview(a, thumb, r);
  return a;
}

// ---------------------------------------------------------------- folders (projects)
// A recording or screenshot sits in one folder (or none). Folders are kept on the server, so
// everyone using it sees the same ones. Move by dragging cards onto a folder, with the card's
// folder button, or by selecting several (Ctrl+click) and using the bar at the bottom.

let folders = [];
const selected = new Set();
let dragIds = null;
let creatingFolder = false;
const folderById = (id) => folders.find((f) => f.id === id) || null;

async function api(method, pathPart, body) {
  const res = await fetch(`${base}${pathPart}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Server answered ${res.status}`);
  return out;
}

async function loadFolders() {
  if (source !== 'server') return (folders = []);
  try {
    folders = (await api('GET', '/api/folders')).folders || [];
  } catch {
    folders = [];
  }
  return folders;
}

let toastTimer;
function libToast(text, bad = false) {
  let t = $('libToast');
  if (!t) {
    t = el('div', 'lib-toast');
    t.id = 'libToast';
    t.setAttribute('role', 'status');
    document.body.append(t);
  }
  t.replaceChildren(icon(bad ? 'warning-circle' : 'check'), el('span', '', text));
  t.classList.toggle('bad', bad);
  t.hidden = false;
  t.classList.remove('out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => (t.hidden = true), 200);
  }, bad ? 5000 : 2600);
}

// ---- a small menu under a button

let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('mousedown', (e) => openMenu && !openMenu.contains(e.target) && closeMenu());
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);

/** entries: { label, icon, onClick, danger, checked, dot } | 'sep' | { input: placeholder, onSubmit } */
function showMenu(anchor, entries) {
  closeMenu();
  const m = el('div', 'lib-menu');
  m.setAttribute('role', 'menu');
  for (const it of entries) {
    if (it === 'sep') {
      m.append(el('hr'));
      continue;
    }
    if (it.input) {
      const f = el('form', 'menu-input');
      const inp = el('input');
      inp.placeholder = it.input;
      inp.maxLength = 60;
      f.append(icon('plus'), inp);
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = inp.value.trim();
        if (!v) return;
        closeMenu();
        it.onSubmit(v);
      });
      inp.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
      m.append(f);
      continue;
    }
    const b = el('button', `menu-item${it.danger ? ' danger' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.dot) {
      const d = el('span', 'fdot');
      d.style.background = it.dot;
      b.append(d);
    } else if (it.icon) b.append(icon(it.icon));
    b.append(el('span', 'grow-txt', it.label));
    if (it.checked) b.append(icon('check'));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (it.keepOpen) return it.onClick(b);
      closeMenu();
      it.onClick();
    });
    m.append(b);
  }
  document.body.append(m);
  let r = anchor.getBoundingClientRect();
  // A hidden button (e.g. a folder's ⋯ opened from the keyboard): use its row instead.
  if (!r.width) r = (anchor.closest('.nav') || anchor.parentElement).getBoundingClientRect();
  const w = m.offsetWidth;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  const below = innerHeight - r.bottom;
  if (below < m.offsetHeight + 12 && r.top > below) m.style.bottom = `${innerHeight - r.top + 6}px`;
  else m.style.top = `${r.bottom + 6}px`;
  openMenu = m;
  m.querySelector('input')?.focus();
  m.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
  return m;
}

// ---- moving

async function moveTo(ids, folderId) {
  if (!ids?.length) return;
  try {
    await api('POST', '/api/folders/move', { ids, folderId });
    for (const r of items || []) if (ids.includes(r.id)) r.folderId = folderId;
    selected.clear();
    const f = folderById(folderId);
    libToast(`${ids.length === 1 ? 'Moved' : `Moved ${ids.length}`} to ${f ? f.name : 'No folder'}`);
  } catch (err) {
    libToast(err.message, true);
  }
  draw();
}

async function createFolder(name) {
  try {
    const f = await api('POST', '/api/folders', { name });
    folders.push(f);
    return f;
  } catch (err) {
    libToast(err.message, true);
    return null;
  }
}

/** The "Move to folder" menu for these recordings. */
function moveMenu(anchor, ids) {
  const current = ids.length === 1 ? (items || []).find((r) => r.id === ids[0])?.folderId || null : undefined;
  showMenu(anchor, [
    ...folders.map((f) => ({ label: f.name, dot: f.color, checked: current === f.id, onClick: () => moveTo(ids, f.id) })),
    { label: 'No folder', icon: 'x', checked: current === null, onClick: () => moveTo(ids, null) },
    'sep',
    { input: 'New folder…', onSubmit: async (name) => {
      const f = await createFolder(name);
      if (f) await moveTo(ids, f.id);
    } },
  ]);
}

// ---- sidebar list

function folderRow(f) {
  const b = el('button', 'nav folder');
  b.type = 'button';
  b.dataset.folder = f.id;
  b.classList.toggle('on', filter === `folder:${f.id}`);
  const dot = el('span', 'fdot');
  dot.style.background = f.color;
  const more = el('span', 'fmore');
  more.setAttribute('role', 'button');
  more.setAttribute('aria-label', `Rename or delete ${f.name}`);
  more.append(icon('dots-three'));
  b.append(dot, el('span', 'fname', f.name), el('span', 'n', String(items ? items.filter((r) => r.folderId === f.id).length : f.count || 0)), more);
  b.addEventListener('click', (e) => {
    if (e.target.closest('.fmore')) return folderMenu(f, more);
    filter = `folder:${f.id}`;
    selected.clear();
    draw();
  });
  b.addEventListener('dragover', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    b.classList.add('drop');
  });
  b.addEventListener('dragleave', () => b.classList.remove('drop'));
  b.addEventListener('drop', (e) => {
    e.preventDefault();
    b.classList.remove('drop');
    const ids = dragIds;
    dragIds = null;
    moveTo(ids, f.id);
  });
  return b;
}

function renameFolder(f) {
  const row = $('folders').querySelector(`[data-folder="${f.id}"]`);
  if (!row) return;
  const form = el('form', 'folder-edit');
  const inp = el('input');
  inp.value = f.name;
  inp.maxLength = 60;
  inp.setAttribute('aria-label', 'Folder name');
  form.append(inp);
  row.replaceWith(form);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = inp.value.trim();
    if (save && name && name !== f.name) {
      try {
        Object.assign(f, await api('PATCH', `/api/folders/${f.id}`, { name }));
      } catch (err) {
        libToast(err.message, true);
      }
    }
    draw();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    finish(true);
  });
  inp.addEventListener('keydown', (e) => e.key === 'Escape' && finish(false));
  inp.addEventListener('blur', () => finish(true));
}

function folderMenu(f, anchor) {
  showMenu(anchor, [
    { label: 'Rename', icon: 'pencil-simple', onClick: () => renameFolder(f) },
    {
      label: 'Delete folder',
      icon: 'trash',
      danger: true,
      keepOpen: true,
      onClick: async (btn) => {
        if (!btn.classList.contains('armed')) {
          btn.classList.add('armed');
          btn.querySelector('.grow-txt').textContent = 'Click again: recordings stay';
          return;
        }
        closeMenu();
        try {
          await api('DELETE', `/api/folders/${f.id}`);
          folders = folders.filter((x) => x !== f);
          for (const r of items || []) if (r.folderId === f.id) r.folderId = null;
          if (filter === `folder:${f.id}`) filter = 'all';
          libToast(`Deleted "${f.name}". Its recordings are under All recordings.`);
        } catch (err) {
          libToast(err.message, true);
        }
        draw();
      },
    },
  ]);
}

function newFolderRow() {
  const form = el('form', 'folder-edit');
  const inp = el('input');
  inp.placeholder = 'Folder name';
  inp.maxLength = 60;
  inp.setAttribute('aria-label', 'New folder name');
  form.append(inp);
  let done = false;
  // Enter creates and opens the folder; clicking elsewhere just creates it.
  const finish = async (save, open = false) => {
    if (done) return;
    done = true;
    creatingFolder = false;
    const name = inp.value.trim();
    if (save && name) {
      const f = await createFolder(name);
      if (f && open) {
        filter = `folder:${f.id}`;
        selected.clear();
      }
    }
    draw();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    finish(true, true);
  });
  inp.addEventListener('keydown', (e) => e.key === 'Escape' && finish(false));
  inp.addEventListener('blur', () => finish(true));
  setTimeout(() => inp.focus(), 0);
  return form;
}

function drawFolders() {
  const show = source === 'server';
  document.querySelector('.folders-head').hidden = !show;
  $('folders').hidden = !show;
  if (!show) return;
  const rows = folders.map(folderRow);
  if (creatingFolder) rows.push(newFolderRow());
  if (!rows.length) rows.push(el('p', 'folders-empty', 'Group recordings by project. Drag cards onto a folder.'));
  $('folders').replaceChildren(...rows);
}

function drawSelection() {
  $('selBar').hidden = !selected.size;
  document.body.classList.toggle('has-sel', selected.size > 0);
  $('selText').textContent = `${selected.size} selected`;
  document.querySelectorAll('.card[data-id]').forEach((c) => c.classList.toggle('selected', selected.has(c.dataset.id)));
}

$('addFolder').addEventListener('click', () => {
  creatingFolder = true;
  drawFolders();
});
$('selMove').addEventListener('click', () => moveMenu($('selMove'), [...selected]));
$('selClear').addEventListener('click', () => {
  selected.clear();
  drawSelection();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected.size && !openMenu) {
    selected.clear();
    drawSelection();
  }
});

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

  if (filter.startsWith('folder:') && !folderById(filter.slice(7))) filter = 'all';
  drawFolders();
  for (const [key, fn] of Object.entries(FILTERS)) {
    const n = $(`n-${key}`);
    if (n) n.textContent = items ? String(items.filter(fn).length) : '';
  }
  document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
  const inFolder = filter.startsWith('folder:') ? folderById(filter.slice(7)) : null;
  $('heading').textContent = inFolder ? inFolder.name : { all: 'All recordings', tab: 'Tab recordings', screen: 'Screen recordings', shots: 'Screenshots', errors: 'With errors' }[filter];
  drawSelection();

  if (items === null) return $('content').replaceChildren(emptyState('warning-circle', "Couldn't load recordings", 'Check the server and try again.'));

  const shown = items
    .filter(inFolder ? (r) => r.folderId === inFolder.id : FILTERS[filter])
    .filter((r) => !q || `${r.title || ''} ${r.reporter || ''}`.toLowerCase().includes(q))
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));

  if (!shown.length) {
    return $('content').replaceChildren(
      inFolder && !q ? emptyState('folder-open', 'This folder is empty', 'Drag recordings here, or use the folder button on a card.') : items.length ? emptyState('magnifying-glass', 'No matches', 'Try another word or filter.') : emptyState('film-slate', 'No recordings yet', 'Record a tab or your screen to see it here.'),
    );
  }
  const grid = el('div', 'grid');
  grid.append(...shown.map(card));
  $('content').replaceChildren(grid);
  drawSelection();
}

$('q').addEventListener('input', draw);
$('refresh').addEventListener('click', load);
$('retry').addEventListener('click', load);
document.querySelectorAll('[data-filter]').forEach((b) =>
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    selected.clear();
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

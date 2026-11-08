const DEFAULTS = { serverUrl: 'http://localhost:4800', uploadToken: '', reporterName: '', captureLocation: true };
const $ = (id) => document.getElementById(id);
let timer;
let lastUrl = '';

// Shown either as Chrome's popup or inside the rounded in-page panel (panel.js).
const inPanel = new URLSearchParams(location.search).has('panel');
function closeUi() {
  if (inPanel) parent.postMessage({ source: 'screenrec-panel', type: 'close' }, '*');
  else window.close();
}
if (inPanel) {
  document.documentElement.classList.add('in-panel');
  const report = () => parent.postMessage({ source: 'screenrec-panel', type: 'height', value: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
  new ResizeObserver(report).observe(document.body);
  addEventListener('keydown', (e) => e.key === 'Escape' && closeUi());
}

// Bundled Phosphor icons into [data-icon] slots.
function paintIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = globalThis.ScreenRecIcons?.[el.dataset.icon];
    if (svg) el.innerHTML = svg; // trusted, bundled SVG
  });
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res && res.ok === false) throw new Error(res.error);
  return res && res.result;
}

function showError(message) {
  $('alert').hidden = !message;
  $('alertText').textContent = message || '';
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

function relativeTime(iso) {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}


function setButton(btn, iconName, label) {
  btn.querySelector('[data-icon]').dataset.icon = iconName;
  btn.querySelector('span:last-child').textContent = label;
  paintIcons(btn);
}

function drawThumb(entry, serverUrl) {
  const box = $('lastThumb');
  if (box.dataset.id === entry.id) return;
  box.dataset.id = entry.id;
  const fallback = () => {
    box.innerHTML = '<span class="icon" data-icon="film-slate"></span>';
    paintIcons(box);
  };
  const img = document.createElement('img');
  img.alt = '';
  img.src = `${serverUrl}/api/recordings/${entry.id}/poster`;
  img.addEventListener('error', fallback);
  box.replaceChildren(img);
}

async function render() {
  const { rec } = await chrome.storage.session.get('rec');
  const { lastResult, lastError } = await chrome.storage.local.get(['lastResult', 'lastError']);
  const settings = await loadSettings();

  const busy = !!rec;
  $('idle').hidden = busy;
  $('snap').hidden = false;
  $('session').hidden = !busy;
  $('last').hidden = $('lastLabel').hidden = busy || !lastResult;
  clearInterval(timer);

  if (busy) {
    const labels = { starting: 'Choose what to share', countdown: 'Starting', recording: 'Recording', paused: 'Paused', stopping: 'Saving' };
    $('statusText').textContent = labels[rec.status] || rec.status;
    $('statusDot').className = rec.status === 'paused' ? 'dot-paused' : rec.status === 'recording' ? 'live-dot pulse' : 'live-dot';
    const live = rec.status === 'recording' || rec.status === 'paused';
    $('pause').disabled = !live;
    $('stop').disabled = rec.status === 'stopping';
    $('discard').disabled = rec.status === 'stopping';
    setButton($('pause'), rec.status === 'paused' ? 'play-fill' : 'pause-fill', rec.status === 'paused' ? 'Resume' : 'Pause');
    setButton($('stop'), 'stop-fill', live ? 'Stop' : 'Cancel');
    const tick = () => {
      if (!rec.startedAt) return ($('clock').textContent = '0:00');
      const end = rec.status === 'paused' && rec.pausedAt ? rec.pausedAt : Date.now();
      $('clock').textContent = fmt(end - rec.startedAt - (rec.pausedMs || 0));
    };
    tick();
    if (rec.status === 'recording') timer = setInterval(tick, 250);
  }

  showError(!busy && lastError && Date.now() - lastError.at < 10 * 60 * 1000 ? lastError.message : '');

  if (lastResult) {
    lastUrl = lastResult.viewerUrl;
    $('lastTitle').textContent = lastResult.title;
    $('lastWhen').textContent = relativeTime(lastResult.createdAt);
    drawThumb(lastResult, settings.serverUrl);
  }
}

async function start(mode) {
  showError('');
  const buttons = [$('recTab'), $('recDesktop')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('No active tab.');
    let streamId;
    if (mode === 'tab') {
      if (!/^https?:|^file:/.test(tab.url || '')) throw new Error("This page can't be recorded. Open a website first.");
      // Must run from the popup click so Chrome treats it as user-initiated.
      // Inside the in-page panel this can be refused; the background then asks instead.
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).catch(() => undefined);
    }
    // Close straight away: the control bar at the bottom of the page shows "Starting…".
    // A failure to start is reported there (the background stores it as lastError).
    send({ type: 'popup:start', mode, tabId: tab.id, streamId }).catch(() => {});
    closeUi();
  } catch (err) {
    showError(err.message);
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function openLibrary() {
  await send({ type: 'library:open' }).catch((e) => showError(e.message));
  closeUi();
}

function openLast() {
  if (!lastUrl) return;
  send({ type: 'open:url', url: lastUrl }).then(() => closeUi(), (e) => showError(e.message));
}

$('recTab').addEventListener('click', () => start('tab'));
$('recDesktop').addEventListener('click', () => start('desktop'));
$('snap').addEventListener('click', async () => {
  showError('');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return showError('No active tab.');
  if (!/^https?:|^file:/.test(tab.url || '')) return showError("This page can't be captured. Open a website first.");
  // Close first so the panel is not in the picture; the background captures a moment later.
  send({ type: 'snap:start', tabId: tab.id }).catch(() => {});
  closeUi();
});
$('pause').addEventListener('click', () => send({ type: 'control', action: 'toggle-pause' }).catch((e) => showError(e.message)));
$('stop').addEventListener('click', () => send({ type: 'control', action: 'stop' }).catch((e) => showError(e.message)));

let discardArmed = false;
$('discard').addEventListener('click', async () => {
  if (!discardArmed) {
    discardArmed = true;
    setButton($('discard'), 'trash', 'Click again to discard');
    setTimeout(() => {
      discardArmed = false;
      setButton($('discard'), 'trash', 'Discard');
    }, 3000);
    return;
  }
  await send({ type: 'control', action: 'discard' }).catch((e) => showError(e.message));
});

$('last').addEventListener('click', openLast);
$('last').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openLast();
  }
});
/** Clipboard write that also works where the async clipboard is refused (e.g. inside the panel). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
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

function setCopyIcon(name, tip) {
  $('copy').dataset.icon = name;
  $('copy').dataset.tip = tip;
  paintIcons($('copy').parentElement);
}

$('copy').addEventListener('click', async (e) => {
  e.stopPropagation();
  const { lastResult } = await chrome.storage.local.get('lastResult');
  if (!lastResult) return;
  showError('');
  // Known public link: copy at once, still inside the click. Otherwise ask for one (this also
  // uploads recordings made before Google Drive was connected).
  let link = lastResult.shareUrl ? { url: lastResult.shareUrl, isPublic: true } : null;
  if (!link) {
    setCopyIcon('spinner-gap', 'Getting the share link…');
    link = (await send({ type: 'share:link', id: lastResult.id }).catch(() => null)) || { url: lastResult.viewerUrl, isPublic: false };
  }
  const ok = await copyText(link.url);
  if (!ok) {
    setCopyIcon('link-simple', 'Copy link');
    return showError(`Couldn't copy. The link is: ${link.url}`);
  }
  if (!link.isPublic) showError(`Copied a local link that only you can open. ${link.error || 'Connect Google Drive to share.'}`);
  setCopyIcon('check', 'Copied');
  setTimeout(() => setCopyIcon('link-simple', 'Copy link'), 1400);
});

$('openLibrary').addEventListener('click', openLibrary);
$('openSettings').addEventListener('click', () => {
  // Every setting lives on the full settings page.
  chrome.runtime.openOptionsPage();
  closeUi();
});


(async () => {
  paintIcons();
  render();
})();

chrome.storage.onChanged.addListener(() => render());

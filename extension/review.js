// The dialog after a recording: the player's "Create a link / GitHub issue" view, loaded from the
// BugSnap server. Shown over the page (see showCreateDialog in background.js) or as its own tab.

const $ = (id) => document.getElementById(id);
const I = globalThis.ScreenRecIcons || {};
document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = I[el.dataset.icon] || ''));

const id = new URLSearchParams(location.search).get('id') || '';
const inOverlay = window.parent !== window;
if (!inOverlay) document.body.classList.add('tab');

let viewerUrl = '';
let serverOrigin = '';

/** Close the dialog: remove the overlay from the page, or close this tab. */
async function close() {
  if (inOverlay) return window.parent.postMessage({ source: 'bugsnap-overlay', type: 'close' }, '*');
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab) chrome.tabs.remove(tab.id);
  else window.close();
}

function fail(text) {
  document.body.classList.remove('ready');
  $('wait').hidden = true;
  $('frame').hidden = true;
  $('fail').hidden = false;
  if (text) $('failText').textContent = text;
}

$('failClose').addEventListener('click', close);
$('failOpen').addEventListener('click', () => {
  if (viewerUrl) chrome.runtime.sendMessage({ type: 'open:url', url: viewerUrl }).catch(() => {});
  close();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('fail').hidden && close());

window.addEventListener('message', (e) => {
  if (e.origin !== serverOrigin || e.source !== $('frame').contentWindow) return;
  const m = e.data;
  if (!m || m.source !== 'bugsnap-embed') return;
  if (m.type === 'ready') {
    clearTimeout(fail.timer);
    document.body.classList.add('ready');
    $('frame').focus();
  } else if (m.type === 'error') fail(m.message);
  else if (m.type === 'close') close();
  else if (m.type === 'open' && /^https?:\/\//.test(m.url || '')) chrome.runtime.sendMessage({ type: 'open:url', url: m.url }).catch(() => {});
  else if (m.type === 'created' && m.kind === 'link') chrome.runtime.sendMessage({ type: 'recording:shared', id, url: m.url }).catch(() => {});
});

(async () => {
  if (!/^[A-Za-z0-9]{6,20}$/.test(id)) return fail('Unknown recording.');
  const { settings } = await chrome.storage.local.get('settings');
  const server = String(settings?.serverUrl || 'http://localhost:4800').replace(/\/$/, '');
  try {
    serverOrigin = new URL(server).origin;
  } catch {
    return fail('The server address in BugSnap Settings is not valid.');
  }
  viewerUrl = `${server}/r/${encodeURIComponent(id)}`;
  const { theme = 'system' } = await chrome.storage.local.get('theme');
  $('frame').src = `${viewerUrl}?embed=create&theme=${encodeURIComponent(theme)}`;
  // Don't leave a spinner up forever if the server does not answer.
  fail.timer = setTimeout(() => !document.body.classList.contains('ready') && fail(`Can't reach the BugSnap server (${server}). Is it running?`), 15000);
})();

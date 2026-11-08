// Recorder window for screen / window capture. getDisplayMedia needs a click in a
// visible page, so this window hosts the source choice, Chrome's picker and the recording.
// It fits itself to its content, grows only while Chrome's picker is open (the picker is
// drawn inside this window), and is minimised once capture starts.
import { connectRecorder } from './recorder-host.js';

const $ = (id) => document.getElementById(id);
const sections = ['pick', 'waiting', 'live', 'saving', 'done'];
const FIT_WIDTH = 560;
const PICKER_SIZE = { width: 820, height: 680 };
const show = (id) =>
  sections.forEach((s) => {
    const el = $(s);
    const was = el.hidden;
    el.hidden = s !== id;
    if (was && !el.hidden) {
      el.classList.remove('view-in');
      void el.offsetWidth;
      el.classList.add('view-in');
    }
  });
let timer;
let state = 'pick';
let clockBase = { startedAt: 0, pausedMs: 0 };

function paintIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = globalThis.ScreenRecIcons?.[el.dataset.icon];
    if (svg) el.innerHTML = svg; // trusted, bundled SVG
  });
}

function setButton(btn, iconName, label) {
  btn.querySelector('[data-icon]').dataset.icon = iconName;
  btn.querySelector('span:last-child').textContent = label;
  paintIcons(btn);
}

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

/** Resize the window: to `size`, or to fit the current content. Keeps it centred where it was. */
async function fitWindow(size) {
  try {
    const win = await chrome.windows.getCurrent();
    if (win.state !== 'normal') return;
    const frameH = window.outerHeight - window.innerHeight;
    const width = size ? size.width : FIT_WIDTH;
    const height = size ? size.height : Math.ceil(document.querySelector('main').getBoundingClientRect().height) + frameH;
    if (Math.abs(win.width - width) < 2 && Math.abs(win.height - height) < 2) return;
    await chrome.windows.update(win.id, {
      width,
      height,
      left: Math.max(0, Math.round(win.left + (win.width - width) / 2)),
      top: Math.max(0, Math.round(win.top + (win.height - height) / 2)),
    });
  } catch {
    // Sizing is cosmetic; never block recording on it.
  }
}

function showError(message) {
  $('alert').hidden = !message;
  $('alertText').textContent = message || '';
}

function onUi(next, info = {}) {
  state = next;
  clearInterval(timer);
  if (next === 'countdown') {
    show('live');
    $('statusText').textContent = 'Starting';
    $('dot').className = 'live-dot';
    $('clock').textContent = '0:00';
    $('pause').disabled = true;
  } else if (next === 'recording') {
    show('live');
    clockBase = { startedAt: info.startedAt ?? clockBase.startedAt, pausedMs: info.pausedMs ?? clockBase.pausedMs };
    $('statusText').textContent = 'Recording';
    $('dot').className = 'live-dot pulse';
    $('pause').disabled = false;
    setButton($('pause'), 'pause-fill', 'Pause');
    const tick = () => ($('clock').textContent = fmt(Date.now() - clockBase.startedAt - clockBase.pausedMs));
    tick();
    timer = setInterval(tick, 250);
  } else if (next === 'paused') {
    $('statusText').textContent = 'Paused';
    $('dot').className = 'dot-paused';
    setButton($('pause'), 'play-fill', 'Resume');
  } else if (next === 'stopping') {
    show('saving');
  } else if (next === 'done') {
    show('done');
    $('link').href = info.viewerUrl;
  } else if (next === 'discarded') {
    // The background closes this window after it has cleared the recording state.
    state = 'discarded';
  } else if (next === 'error') {
    show('pick');
    $('choose').disabled = false;
    showError(info.message);
  }
  requestAnimationFrame(() => fitWindow());
}

// Restored from minimised: shrink to the live controls.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state !== 'waiting') fitWindow();
});

window.addEventListener('beforeunload', (e) => {
  if (['countdown', 'recording', 'paused', 'stopping'].includes(state)) e.preventDefault();
});

paintIcons();
requestAnimationFrame(() => fitWindow());

connectRecorder({ kind: 'window', onUi })
  .then((host) => {
    $('choose').addEventListener('click', async () => {
      showError('');
      $('choose').disabled = true;
      const surface = document.querySelector('input[name="surface"]:checked').value;
      state = 'waiting';
      show('waiting');
      await fitWindow(PICKER_SIZE); // room for Chrome's picker
      host.start({ surface, includeAudio: $('audio').checked }).finally(() => {
        if (state === 'pick' || state === 'error') $('choose').disabled = false;
      });
    });
    $('cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'control', action: 'discard' }));
    $('pause').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'control', action: 'toggle-pause' }));
    $('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'control', action: 'stop' }));
    let armed = false;
    $('discard').addEventListener('click', () => {
      if (!armed) {
        armed = true;
        setButton($('discard'), 'trash', 'Click again');
        setTimeout(() => {
          armed = false;
          setButton($('discard'), 'trash', 'Discard');
        }, 3000);
        return;
      }
      chrome.runtime.sendMessage({ type: 'control', action: 'discard' });
    });
  })
  .catch((err) => {
    $('choose').disabled = true;
    showError(err.message);
  });

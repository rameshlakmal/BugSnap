// Setup page: walks a new person through storage, their own Google app, their own share player
// (GitHub Pages, built by their copy of the repo) and the extension. Saves to /api/setup as it goes.
const $ = (id) => document.getElementById(id);
const I = globalThis.ScreenRecIcons || {};
const paint = (scope = document) => scope.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = I[el.dataset.icon] || ''));
paint();

const ORDER = ['storage', 'google', 'player', 'extension', 'done'];
let state = null;
let current = 'storage';
let viewerTouched = false;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const usesDrive = () => state.storage !== 'local';
const visibleSteps = () => ORDER.filter((s) => usesDrive() || !['google', 'player'].includes(s));
const stepDone = {
  storage: () => Boolean(state.storage),
  google: () => state.drive.connected,
  player: () => Boolean(state.viewerUrl && state.driveApiKey),
  extension: () => state.finished,
  done: () => state.finished,
};

function setStatus(el, kind, text) {
  el.className = `status ${kind || ''}`;
  const icon = { ok: 'check-circle', bad: 'warning-circle', busy: 'spinner-gap' }[kind] || 'circle-dashed';
  el.innerHTML = `<span class="icon">${I[icon] || ''}</span>`;
  el.append(document.createTextNode(text || ''));
}

function show(step) {
  if (!visibleSteps().includes(step)) step = 'extension';
  current = step;
  history.replaceState(null, '', `#${step}`);
  document.querySelectorAll('[data-view]').forEach((v) => (v.hidden = v.dataset.view !== step));
  renderRail();
  renderStep();
  $('nav').hidden = step === 'done';
  $('back').style.visibility = step === 'storage' ? 'hidden' : '';
  const optional = step === 'google' || step === 'player';
  $('skip').hidden = !optional || stepDone[step]();
  $('next').querySelector('span').textContent = step === 'extension' ? "I've added it" : 'Continue';
  $('next').disabled = step === 'storage' && !state.storage;
  window.scrollTo({ top: 0 });
}

function renderRail() {
  const steps = visibleSteps();
  document.querySelectorAll('#steps li').forEach((li) => {
    const s = li.dataset.step;
    li.hidden = !steps.includes(s);
    li.classList.toggle('on', s === current);
    const ok = s !== 'done' && s !== current && stepDone[s]();
    li.classList.toggle('ok', ok);
    const num = li.querySelector('.num');
    num.innerHTML = ok ? I.check || '' : String(steps.indexOf(s) + 1);
  });
}

function guessViewer(repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo || '');
  if (!m) return '';
  const host = `${m[1].toLowerCase()}.github.io`;
  return m[2].toLowerCase() === host ? `https://${host}` : `https://${host}/${m[2]}`;
}

function paintGhLinks() {
  const repo = $('repo').value.trim();
  const ok = /^[\w.-]+\/[\w.-]+$/.test(repo);
  document.querySelectorAll('.gh-link').forEach((a) => {
    if (ok) a.href = `https://github.com/${repo}/${a.dataset.gh}`;
    else a.removeAttribute('href');
    a.classList.toggle('disabled', !ok);
    a.dataset.tip = ok ? '' : 'Fill in "Your GitHub copy" first';
  });
}

function renderStep() {
  if (current === 'storage') {
    document.querySelectorAll('[data-storage]').forEach((b) => {
      const on = b.dataset.storage === state.storage;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  } else if (current === 'google') {
    $('clientId').value = $('clientId').value || state.googleClientId || '';
    $('clientSecret').placeholder = state.googleClientSecretHint ? `Saved (${state.googleClientSecretHint}). Paste to replace.` : 'GOCSPX-…';
    const q = new URLSearchParams(location.search);
    if (q.get('error')) setStatus($('googleStatus'), 'bad', q.get('error'));
    else if (state.drive.connected) setStatus($('googleStatus'), 'ok', `Connected${state.drive.email ? ` as ${state.drive.email}` : ''}`);
    else setStatus($('googleStatus'), '', 'Not connected yet');
    $('connectGoogle').querySelector('span:last-child').textContent = state.drive.connected ? 'Connect again' : 'Save and connect Drive';
  } else if (current === 'player') {
    $('apiKey').value = $('apiKey').value || state.driveApiKey || '';
    $('repo').value = $('repo').value || state.githubRepo || state.guess?.repo || '';
    $('viewerUrl').value = $('viewerUrl').value || state.viewerUrl || state.guess?.url || guessViewer($('repo').value);
    paintGhLinks();
    if (!$('playerStatus').textContent) setStatus($('playerStatus'), '', state.viewerUrl ? 'Saved. Check it any time.' : 'Not checked yet');
  } else if (current === 'extension') {
    $('extFolder').textContent = state.extensionFolder;
  } else if (current === 'done') {
    const rows = [
      [usesDrive() && state.drive.connected, usesDrive() ? (state.drive.connected ? `Google Drive: ${state.drive.email || 'connected'}` : 'Google Drive: not connected') : 'Recordings stay on this computer'],
      [usesDrive() && Boolean(state.viewerUrl), usesDrive() ? (state.viewerUrl ? `Player: ${state.viewerUrl}` : 'Player: not set') : null],
    ].filter(([, t]) => t);
    $('summary').replaceChildren(
      ...rows.map(([ok, text]) => {
        const d = document.createElement('div');
        d.innerHTML = `<span class="icon ${ok ? 'ok' : 'no'}">${I[ok ? 'check-circle' : 'circle-dashed'] || ''}</span>`;
        d.append(document.createTextNode(text));
        return d;
      }),
    );
    $('doneText').textContent = usesDrive() && !state.drive.connected
      ? 'BugSnap works now; links open only on this computer until Drive is connected. Come back to this page any time.'
      : 'Click the BugSnap icon on any website and record your first bug. Alt+Shift+S opens the capture bar.';
  }
}

async function save(patch) {
  state = { ...state, ...(await api('PUT', '/api/setup', patch)) };
}

// ---------------------------------------------------------------- actions

document.querySelectorAll('[data-storage]').forEach((b) =>
  b.addEventListener('click', async () => {
    await save({ storage: b.dataset.storage });
    show(b.dataset.storage === 'local' ? 'extension' : 'google');
  }),
);

$('connectGoogle').addEventListener('click', async () => {
  const id = $('clientId').value.trim();
  const secret = $('clientSecret').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) return setStatus($('googleStatus'), 'bad', 'The client ID ends with .apps.googleusercontent.com');
  if (!secret && !state.googleClientSecretHint) return setStatus($('googleStatus'), 'bad', 'Paste the client secret too.');
  setStatus($('googleStatus'), 'busy', 'Opening Google…');
  try {
    await save({ storage: 'drive', googleClientId: id, googleClientSecret: secret });
    location.href = '/auth/google'; // comes back to /setup?connected=1
  } catch (err) {
    setStatus($('googleStatus'), 'bad', err.message);
  }
});

$('repo').addEventListener('input', () => {
  paintGhLinks();
  if (!viewerTouched) $('viewerUrl').value = guessViewer($('repo').value.trim());
});
$('viewerUrl').addEventListener('input', () => (viewerTouched = true));

$('savePlayer').addEventListener('click', async () => {
  setStatus($('playerStatus'), 'busy', 'Checking the player…');
  try {
    await save({ driveApiKey: $('apiKey').value.trim(), viewerUrl: $('viewerUrl').value.trim(), githubRepo: $('repo').value.trim() });
    const r = await api('POST', '/api/setup/check-player');
    setStatus($('playerStatus'), r.ok ? 'ok' : 'bad', r.message);
    renderRail();
    $('skip').hidden = stepDone.player();
  } catch (err) {
    setStatus($('playerStatus'), 'bad', err.message);
  }
});

async function copyFrom(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.innerHTML;
    btn.innerHTML = `<span class="icon">${I.check || ''}</span>${btn.querySelector('span:not(.icon)') ? '<span>Copied</span>' : ''}`;
    setTimeout(() => (btn.innerHTML = old), 1200);
  } catch {
    /* clipboard blocked: the text is visible to copy by hand */
  }
}
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyFrom($(b.dataset.copy).textContent, b)));
document.querySelectorAll('[data-copy-text]').forEach((b) => b.addEventListener('click', () => copyFrom(b.dataset.copyText, b)));

$('steps').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-step]');
  if (li) show(li.dataset.step);
});

$('back').addEventListener('click', () => {
  const steps = visibleSteps();
  show(steps[Math.max(0, steps.indexOf(current) - 1)]);
});
$('skip').addEventListener('click', () => next(true));
$('next').addEventListener('click', () => next(false));

async function next(skipping) {
  const steps = visibleSteps();
  if (current === 'player' && !skipping && !stepDone.player()) {
    // Continue saves what was typed, even before the player is published.
    await save({ driveApiKey: $('apiKey').value.trim(), viewerUrl: $('viewerUrl').value.trim(), githubRepo: $('repo').value.trim() }).catch(() => {});
  }
  if (current === 'extension') await save({ finished: true });
  show(steps[Math.min(steps.length - 1, steps.indexOf(current) + 1)]);
}

// ---------------------------------------------------------------- start

(async () => {
  state = await api('GET', '/api/setup');
  const q = new URLSearchParams(location.search);
  const wanted = location.hash.slice(1);
  let start = ORDER.includes(wanted) ? wanted : null;
  if (q.has('connected') || q.has('error')) start = 'google';
  // Finished before: open on the summary (any step is one click away in the list).
  if (!start) start = state.finished ? 'done' : visibleSteps().find((s) => !stepDone[s]()) || 'done';
  show(start);
})().catch((err) => {
  document.querySelector('.pane').innerHTML = `<p class="lead">Couldn't load the setup (${err.message}). Is the BugSnap server running?</p>`;
});

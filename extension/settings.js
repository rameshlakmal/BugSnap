// BugSnap settings: extension preferences (chrome.storage) plus the server's Google Drive,
// AI and GitHub settings (through its local-only API). Everything saves as you change it,
// except secret keys, which save with their own button and are never shown again.
const $ = (id) => document.getElementById(id);
const I = globalThis.ScreenRecIcons || {};
const paint = (scope = document) => scope.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = I[el.dataset.icon] || ''));
paint();

const DEFAULTS = { serverUrl: 'http://localhost:4800', uploadToken: '', reporterName: '', captureLocation: true };
let prefs = { ...DEFAULTS };
let server = DEFAULTS.serverUrl;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const icon = (name) => {
  const s = h('span', { class: 'icon' });
  s.innerHTML = I[name] || '';
  return s;
};

let toastTimer;
function toast(text, ok = true) {
  $('toastText').textContent = text;
  $('toastIcon').innerHTML = I[ok ? 'check' : 'warning-circle'] || '';
  $('toast').classList.toggle('bad', !ok);
  $('toast').classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('on'), 1800);
}

async function api(method, pathPart, body) {
  let res;
  try {
    res = await fetch(`${server}${pathPart}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(prefs.uploadToken ? { 'X-Upload-Token': prefs.uploadToken } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach the server at ${server}.`);
  }
  const out = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error('These settings can only be changed on the computer running the server.');
  if (!res.ok) throw new Error(out.error || `Server answered ${res.status}`);
  return out;
}

function setPill(el, text, tone = '') {
  el.textContent = text;
  el.className = `pill${tone ? ` ${tone}` : ''}`;
}
const navBadge = (id, tone) => ($(id).className = `badge${tone ? ` ${tone}` : ''}`);

// ---------------------------------------------------------------- general + server (extension prefs)

async function savePrefs(patch, message = 'Saved') {
  prefs = { ...prefs, ...patch };
  await chrome.storage.local.set({ settings: prefs });
  toast(message);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

$('reporterName').addEventListener('input', debounce(() => savePrefs({ reporterName: $('reporterName').value.trim() }), 600));
$('captureLocation').addEventListener('change', () => savePrefs({ captureLocation: $('captureLocation').checked }));
$('uploadToken').addEventListener('input', debounce(() => savePrefs({ uploadToken: $('uploadToken').value.trim() }).then(checkServer), 700));
$('serverUrl').addEventListener('change', async () => {
  const url = $('serverUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.serverUrl;
  if (!/^https?:\/\//.test(url)) return toast('The address must start with http:// or https://', false);
  $('serverUrl').value = url;
  server = url;
  await savePrefs({ serverUrl: url });
  checkServer();
});
$('testServer').addEventListener('click', () => checkServer(true));

async function checkServer(announce = false) {
  const chip = $('serverChip');
  chip.dataset.state = 'checking';
  $('serverChipText').textContent = 'Checking server…';
  try {
    const res = await fetch(`${server}/api/recordings`, { cache: 'no-store' });
    if (!res.ok && res.status !== 404) throw new Error();
    chip.dataset.state = 'online';
    $('serverChipText').textContent = 'Server connected';
    $('serverDetail').textContent = `Connected to ${server}`;
    document.body.classList.remove('offline');
    if (announce) toast('Server connected');
    loadServerSections();
  } catch {
    chip.dataset.state = 'offline';
    $('serverChipText').textContent = 'Server offline';
    $('serverDetail').textContent = `Can't reach ${server}. Start it with "npm start" in the server folder.`;
    document.body.classList.add('offline');
    if (announce) toast("Can't reach the server", false);
  }
}

// ---------------------------------------------------------------- Google Drive

async function loadDrive() {
  const actions = $('driveActions');
  actions.replaceChildren();
  $('driveHelp').hidden = true;
  try {
    const d = await api('GET', '/api/drive');
    $('driveDetails').hidden = !d.connected;
    if (!d.configured) {
      $('driveSub').textContent = 'Not set up on the server yet.';
      setPill($('drivePill'), 'Not set up');
      navBadge('navDrive', 'warn');
      $('driveHelp').hidden = false;
      $('driveHelp').innerHTML = 'Add your Google keys to <code>server/.env</code>, then restart the server. The guide is <code>SETUP-GOOGLE-DRIVE.md</code>.';
      return;
    }
    if (!d.connected) {
      $('driveSub').textContent = 'Connect to share by link.';
      setPill($('drivePill'), 'Not connected', 'warn');
      navBadge('navDrive', 'warn');
      actions.append(h('button', { class: 'btn primary sm', onclick: () => chrome.tabs.create({ url: `${server}/auth/google` }) }, icon('cloud-check'), 'Connect Google Drive'));
      return;
    }
    $('driveSub').textContent = d.email || 'Connected';
    setPill($('drivePill'), 'Connected', 'ok');
    navBadge('navDrive', 'ok');
    $('driveFolder').textContent = `My Drive › ${d.folderName}`;
    $('driveViewer').textContent = d.viewerUrl || 'Google Drive (set VIEWER_URL for your own player)';
    actions.append(
      h('button', {
        class: 'btn sm',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await api('POST', '/api/drive/upload-all');
            toast(r.queued ? `Uploading ${r.queued} recording${r.queued === 1 ? '' : 's'}` : 'Everything is already on Drive');
          } catch (err) {
            toast(err.message, false);
          }
          e.currentTarget.disabled = false;
        },
      }, icon('cloud-arrow-up'), 'Upload older recordings'),
      h('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          await api('POST', '/api/drive/disconnect').catch((err) => toast(err.message, false));
          toast('Disconnected. Shared links keep working.');
          loadDrive();
        },
      }, 'Disconnect'),
    );
  } catch (err) {
    $('driveSub').textContent = err.message;
    setPill($('drivePill'), 'Unavailable');
  }
}

// ---------------------------------------------------------------- AI reports

const LOGOS = {
  'claude-code': { text: 'CC', bg: '#d97757' },
  anthropic: { text: 'A', bg: '#cc785c' },
  openai: { text: 'O', bg: '#10a37f' },
  google: { text: 'G', bg: '#4285f4' },
  openrouter: { text: 'OR', bg: '#6467f2' },
  ollama: { text: 'Ol', bg: '#18181b' },
};
let ai = null;
let shownProvider = null;
const modelCache = {};

async function loadAi() {
  try {
    ai = await api('GET', '/api/ai');
  } catch (err) {
    $('providers').replaceChildren(h('p', { class: 'note bad' }, err.message));
    return;
  }
  navBadge('navAi', ai.available ? 'ok' : 'warn');
  renderProviders();
  renderPanel(shownProvider || ai.provider);
}

function renderProviders() {
  $('providers').replaceChildren(
    ...Object.values(ai.providers).map((p) => {
      const logo = LOGOS[p.id];
      const check = h('span', { class: 'check' });
      check.innerHTML = I.check || '';
      const card = h('button', { class: `prov${ai.provider === p.id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(ai.provider === p.id), type: 'button' },
        h('span', { class: 'top-line' }, h('span', { class: 'logo', style: `background:${logo.bg}` }, logo.text), h('strong', {}, p.name)),
        h('small', {}, p.blurb),
        h('span', { class: `state${p.ready ? ' ok' : ''}` }, p.ready ? 'Ready' : p.needsKey && !p.hasKey ? 'Needs key' : p.id === 'claude-code' ? 'Not found' : 'Set up'),
        check);
      card.addEventListener('click', () => choose(p.id));
      return card;
    }),
  );
}

async function choose(id) {
  shownProvider = id;
  try {
    ai = await api('PUT', '/api/ai', { provider: id });
    toast(`${ai.providers[id].name} will write reports`);
  } catch (err) {
    toast(err.message, false);
  }
  navBadge('navAi', ai.available ? 'ok' : 'warn');
  renderProviders();
  renderPanel(id);
}

function result(el, text, tone) {
  el.hidden = !text;
  el.className = `result${tone ? ` ${tone}` : ''}`;
  el.textContent = text || '';
}

function renderPanel(id) {
  const p = ai.providers[id];
  const panel = $('providerPanel');
  const out = h('p', { class: 'result', hidden: true });
  const rows = [];

  if (id === 'claude-code') {
    rows.push(h('div', { class: 'row' }, h('span', { class: 'row-text' }, h('strong', {}, 'Claude Code'),
      h('small', {}, p.ready ? `Found ${p.version.replace(' (Claude Code)', '')}. Reports use your Claude plan; no key needed.` : 'Not found on the server computer. Install Claude Code and run "claude" once in a terminal to sign in.'))));
  }

  if (p.needsKey) {
    const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.hasKey ? `Saved (${p.keyHint})${p.keyFromEnv ? ' from server/.env' : ''}` : p.keyPlaceholder || 'API key' });
    const save = h('button', { class: 'btn sm primary', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      if (!input.value.trim()) return input.focus();
      save.disabled = true;
      try {
        ai = await api('PUT', '/api/ai', { keys: { [id]: input.value.trim() } });
        toast('Key saved');
        modelCache[id] = null;
        renderProviders();
        renderPanel(id);
        if (id !== 'anthropic') loadModels(id, true);
      } catch (err) {
        result(out, err.message, 'bad');
        save.disabled = false;
      }
    });
    rows.push(h('div', { class: 'row' },
      h('span', { class: 'row-text' }, h('strong', {}, 'API key'), h('small', {}, 'Stored only on the computer running the server. ', p.keyUrl ? h('a', { class: 'linkish', href: p.keyUrl, target: '_blank', rel: 'noopener' }, 'Get a key') : '')),
      h('span', { class: 'inline' }, input, save)));
    if (p.hasKey && !p.keyFromEnv) {
      rows.push(h('div', { class: 'actions' }, h('button', {
        class: 'btn ghost sm',
        type: 'button',
        onclick: async () => {
          ai = await api('PUT', '/api/ai', { keys: { [id]: '' } }).catch((err) => (toast(err.message, false), ai));
          toast('Key removed');
          renderProviders();
          renderPanel(id);
        },
      }, 'Remove key')));
    }
  }

  if (id === 'ollama') {
    const url = h('input', { class: 'input', type: 'url', value: p.url || 'http://localhost:11434', spellcheck: 'false' });
    url.addEventListener('change', async () => {
      try {
        ai = await api('PUT', '/api/ai', { ollamaUrl: url.value });
        toast('Saved');
        loadModels(id, true);
      } catch (err) {
        result(out, err.message, 'bad');
      }
    });
    rows.push(h('label', { class: 'row' }, h('span', { class: 'row-text' }, h('strong', {}, 'Ollama address'), h('small', {}, 'Install from ', h('a', { class: 'linkish', href: 'https://ollama.com/download', target: '_blank', rel: 'noopener' }, 'ollama.com'), ', then run e.g. "ollama pull llama3.3".')), url));
  }

  if (id !== 'claude-code') {
    const select = h('select', { class: 'input', id: 'modelSelect' });
    const refresh = h('button', { class: 'btn ghost icon-only sm', type: 'button', 'data-tip': 'Load models again' }, icon('arrow-clockwise'));
    refresh.addEventListener('click', () => loadModels(id, true));
    select.addEventListener('change', async () => {
      try {
        ai = await api('PUT', '/api/ai', { models: { [id]: select.value } });
        toast(`Model: ${select.selectedOptions[0]?.textContent}`);
        renderProviders();
      } catch (err) {
        result(out, err.message, 'bad');
      }
    });
    const canList = id === 'anthropic' || id === 'ollama' || p.hasKey;
    rows.push(h('label', { class: 'row' }, h('span', { class: 'row-text' }, h('strong', {}, 'Model'), h('small', {}, canList ? 'The models your key can use, best picks first.' : 'Save a key to see the models.')), h('span', { class: 'inline' }, select, refresh)));
    fillModels(select, id, p.model);
    if (canList && !p.fixedModels) loadModels(id);
  }

  const test = h('button', { class: 'btn sm', type: 'button' }, icon('sparkle'), 'Test');
  test.addEventListener('click', async () => {
    test.disabled = true;
    result(out, 'Testing…');
    try {
      const r = await api('POST', `/api/ai/test?provider=${encodeURIComponent(id)}`);
      result(out, `Works. ${r.model} answered "${r.reply}".`, 'ok');
    } catch (err) {
      result(out, err.message, 'bad');
    }
    test.disabled = false;
  });
  const useIt = ai.provider === id ? null : h('button', { class: 'btn primary sm', type: 'button', onclick: () => choose(id) }, `Use ${p.name}`);
  rows.push(h('div', { class: 'actions' }, useIt, test));
  rows.push(out);
  panel.replaceChildren(...rows);
  paint(panel);
}

function fillModels(select, id, current) {
  const p = ai.providers[id];
  const list = p.fixedModels ? Object.entries(p.fixedModels).map(([value, label]) => ({ id: value, label })) : modelCache[id] || (current ? [{ id: current, label: current }] : []);
  select.replaceChildren(
    ...(list.length ? [] : [h('option', { value: '' }, p.needsKey && !p.hasKey ? 'Save a key first' : 'Loading models…')]),
    ...list.map((m) => h('option', { value: m.id, selected: m.id === current ? true : undefined }, m.label)),
  );
  select.disabled = !list.length;
}

async function loadModels(id, force = false) {
  if (!force && modelCache[id]) return;
  try {
    modelCache[id] = await api('GET', `/api/ai/models?provider=${encodeURIComponent(id)}`);
    const p = ai.providers[id];
    // No model chosen yet: take the first (best) one so the provider is ready to use.
    if (!p.model && modelCache[id].length) {
      ai = await api('PUT', '/api/ai', { models: { [id]: modelCache[id][0].id } });
      renderProviders();
    }
  } catch (err) {
    modelCache[id] = null;
    if (shownProvider === id || ai.provider === id) toast(err.message, false);
  }
  const select = $('modelSelect');
  if (select && (shownProvider || ai.provider) === id) fillModels(select, id, ai.providers[id].model);
}

// ---------------------------------------------------------------- GitHub

async function loadGitHub() {
  try {
    const st = await api('GET', '/api/github');
    setPill($('ghPill'), st.configured ? 'Connected' : 'Not set up', st.configured ? 'ok' : '');
    navBadge('navGh', st.configured ? 'ok' : '');
    $('ghSub').textContent = st.configured ? `Signed in as ${st.login || 'GitHub user'}` : 'Create issues straight from the player.';
    $('ghHow').hidden = st.configured;
    $('ghToken').value = '';
    $('ghToken').placeholder = st.configured ? `Saved (${st.tokenHint})${st.fromEnv ? ' from server/.env' : ''}. Paste to replace.` : 'github_pat_…';
    $('ghRemove').hidden = !st.configured || st.fromEnv;
    $('ghRepoRow').hidden = !st.configured;
    if (st.configured) {
      const repos = await api('GET', '/api/github/repos').catch((err) => (toast(err.message, false), []));
      $('ghDefault').replaceChildren(...repos.map((r) => h('option', { value: r.fullName, selected: r.fullName === st.defaultRepo ? true : undefined }, `${r.fullName}${r.private ? ' (private)' : ''}`)));
    }
  } catch (err) {
    $('ghSub').textContent = err.message;
  }
}

$('ghSave').addEventListener('click', async () => {
  const token = $('ghToken').value.trim();
  if (!token) return $('ghToken').focus();
  $('ghSave').disabled = true;
  try {
    const st = await api('PUT', '/api/github', { token });
    toast(`Connected as ${st.login}`);
    loadGitHub();
  } catch (err) {
    toast(err.message, false);
  }
  $('ghSave').disabled = false;
});
$('ghDefault').addEventListener('change', async () => {
  await api('PUT', '/api/github', { defaultRepo: $('ghDefault').value }).then(() => toast('Default repository saved')).catch((err) => toast(err.message, false));
});
$('ghRemove').addEventListener('click', async () => {
  await api('PUT', '/api/github', { token: '' }).then(() => toast('GitHub disconnected')).catch((err) => toast(err.message, false));
  loadGitHub();
});

// ---------------------------------------------------------------- shortcuts, about, nav

async function loadShortcuts() {
  const cmds = await chrome.commands.getAll();
  const label = { 'capture-screenshot': 'Capture a screenshot', 'stop-recording': 'Stop and save the recording', 'toggle-pause': 'Pause or resume the recording', _execute_action: 'Open the BugSnap panel' };
  $('shortcutList').replaceChildren(
    ...cmds.map((c) => h('div', { class: 'short' }, h('span', {}, label[c.name] || c.description || c.name), c.shortcut ? h('span', { class: 'kbd' }, c.shortcut) : h('span', { class: 'muted' }, 'Not set'))),
  );
}
$('editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
const openLibrary = () => chrome.runtime.sendMessage({ type: 'library:open' });
$('openLibrary').addEventListener('click', openLibrary);
$('openLibrary2').addEventListener('click', openLibrary);
$('version').textContent = `Version ${chrome.runtime.getManifest().version}`;

// Highlight the section in view.
const links = [...document.querySelectorAll('.nav a')];
const observer = new IntersectionObserver(
  (entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${visible.target.id}`));
  },
  { rootMargin: '-80px 0px -60% 0px' },
);
document.querySelectorAll('.sec').forEach((s) => observer.observe(s));

function loadServerSections() {
  loadDrive();
  loadAi();
  loadGitHub();
}

// Back from connecting Drive in another tab: refresh.
window.addEventListener('focus', () => {
  if (!document.body.classList.contains('offline')) loadDrive();
});

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  prefs = { ...DEFAULTS, ...(settings || {}) };
  server = prefs.serverUrl.replace(/\/+$/, '');
  $('reporterName').value = prefs.reporterName;
  $('captureLocation').checked = prefs.captureLocation;
  $('serverUrl').value = prefs.serverUrl;
  $('uploadToken').value = prefs.uploadToken;
  loadShortcuts();
  await checkServer();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();

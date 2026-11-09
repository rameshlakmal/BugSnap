import express from 'express';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { newId, ID_PATTERN } from './ids.js';
import { LocalStorage, countEvents } from './storage/local.js';
import { processVideo, makeImagePoster, trimVideo } from './media.js';
import { Drive } from './drive.js';
import { ReportWriter, reportContext } from './ai.js';
import { GitHub, splitReport } from './github.js';
import { Auth } from './auth.js';

const storage = new LocalStorage(config.dataDir);
await storage.init();
const drive = new Drive({ ...config.google, dataDir: config.dataDir, port: config.port, viewerUrl: config.viewerUrl });
await drive.load();
const writer = new ReportWriter({ command: config.claudePath, model: config.aiModel, dataDir: config.dataDir, envApiKey: config.anthropicApiKey });
await writer.load();
const github = new GitHub({ dataDir: config.dataDir, envToken: config.githubToken });
await github.load();
const auth = new Auth({ dataDir: config.dataDir, required: config.requireLogin, legacyToken: config.uploadToken });
await auth.load();

const app = express();
app.disable('x-powered-by');

// The extension calls this API from a chrome-extension:// origin.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------- sign-in (hosted server)

// Behind a reverse proxy (Caddy) on the same machine: trust its X-Forwarded-* headers only.
app.set('trust proxy', 'loopback');

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// What the login page itself needs before anyone is signed in.
const OPEN_PATHS = /^\/(login|logout|tokens\.css|logo\.svg|favicon-32\.png|favicon\.ico|apple-touch-icon\.png|site\.webmanifest|fonts\/[\w.-]+)$/;

// Who is asking: the extension sends a personal access key; browsers use the session cookie.
app.use((req, res, next) => {
  req.user = auth.userForKey(req.get('X-Upload-Token')) || auth.userForCookie(req.get('Cookie'));
  if (!auth.enabled || req.user || req.method === 'OPTIONS' || OPEN_PATHS.test(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(401).json({ error: auth.users.length ? 'Sign in required. Add your access key in BugSnap Settings → Server.' : 'No users yet. On the server run: npm run user add <name>' });
  }
  res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
});

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loginPage({ next = '/', error = '', name = '' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<title>Sign in · BugSnap</title><link rel="icon" href="/logo.svg" type="image/svg+xml" /><link rel="stylesheet" href="/tokens.css" />
<style>
body { min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
.box { width: min(380px, 100%); padding: 28px; display: grid; gap: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow-md); animation: rise-in .25s var(--ease); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; }
.brand img { width: 32px; height: 32px; }
h1 { margin: 6px 0 0; font-size: 19px; } p { margin: 0; color: var(--muted); font-size: 14px; }
label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
input { font: 400 14px/1.4 var(--font); height: 42px; padding: 0 12px; border-radius: var(--r-field); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); }
input:focus { outline: none; border-color: var(--text); box-shadow: var(--ring); }
.err { padding: 10px 12px; border-radius: var(--r-field); background: var(--live-soft); color: var(--live); font-size: 13px; }
.btn { height: 42px; justify-content: center; }
</style></head>
<body><form class="box" method="post" action="/login">
<div class="brand"><img src="/logo.svg" alt="" />BugSnap</div>
<h1>Sign in</h1><p>Use the name and password your BugSnap server was set up with.</p>
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
<input type="hidden" name="next" value="${escapeHtml(next)}" />
<label>Name<input name="name" autocomplete="username" required value="${escapeHtml(name)}" autofocus /></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
<button class="btn primary" type="submit">Sign in</button>
</form></body></html>`;
}

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(302, safeNext(req.query.next));
  res.set('Cache-Control', 'no-store').type('html').send(loginPage({ next: safeNext(req.query.next) }));
});

app.post('/login', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
  const ip = req.ip;
  const next = safeNext(req.body?.next);
  const name = String(req.body?.name || '').slice(0, 60);
  res.set('Cache-Control', 'no-store');
  if (auth.blocked(ip)) return res.status(429).type('html').send(loginPage({ next, name, error: 'Too many tries. Wait 15 minutes and try again.' }));
  const user = await auth.checkPassword(name, String(req.body?.password || '').slice(0, 200));
  if (!user) {
    auth.failed(ip);
    return res.status(401).type('html').send(loginPage({ next, name, error: 'That name and password do not match.' }));
  }
  auth.succeeded(ip);
  res.set('Set-Cookie', auth.cookie(auth.sessionValue(user), req.secure)).redirect(303, next);
});

app.get('/logout', (req, res) => {
  res.set('Set-Cookie', auth.cookie('', req.secure, 0)).redirect(302, '/login');
});

function requireUploadToken(req, res, next) {
  if (req.user) return next();
  if (!config.uploadToken) return next();
  if (req.get('X-Upload-Token') === config.uploadToken) return next();
  res.status(401).json({ error: 'Invalid upload token' });
}

// Drive sign-in and publishing act on your Google account: only this computer may use them.
function localOnly(req, res, next) {
  if (req.user) return next();
  if (auth.enabled) return res.status(403).json({ error: 'Sign in required' });
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: 'Only available on the computer running the server' });
}

/** Edits and deletes: this computer, or anyone with the upload token. */
function localOrToken(req, res, next) {
  if (req.user) return next();
  if (auth.enabled) return res.status(403).json({ error: 'Sign in required' });
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  if (config.uploadToken && req.get('X-Upload-Token') === config.uploadToken) return next();
  res.status(403).json({ error: 'Not allowed' });
}

// Reading the unannotated original: this computer, or the upload token.
const uploaderOrLocalRead = (req, res, next) =>
  req.user ? next() : config.uploadToken && req.get('X-Upload-Token') === config.uploadToken ? next() : localOnly(req, res, next);

app.param('id', (req, res, next, id) => {
  if (!ID_PATTERN.test(id)) return res.status(404).json({ error: 'Recording not found' });
  next();
});

const viewerUrl = (id) => `${config.publicBaseUrl}/r/${id}`;

// Metadata partly comes from arbitrary web pages: keep it plain JSON and cap its size.
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const json = JSON.stringify(meta);
  return json.length > 200_000 ? {} : JSON.parse(json);
}

// ---------------------------------------------------------------- folders (projects)
// Recordings and screenshots can sit in one folder each (record.folderId). New captures go to the
// folder last chosen in the create dialog. Deleting a folder never deletes what was in it.

const FOLDERS_FILE = path.join(config.dataDir, 'folders.json');
const FOLDER_COLORS = ['#e5484d', '#2f81f7', '#2da44e', '#d4a72c', '#8250df', '#e16f24', '#db61a2', '#0f766e'];
let folders = { list: [], lastUsed: null };
try {
  folders = { list: [], lastUsed: null, ...JSON.parse(await fsp.readFile(FOLDERS_FILE, 'utf8')) };
} catch {
  /* no folders yet */
}
const saveFolders = () => fsp.writeFile(FOLDERS_FILE, JSON.stringify(folders, null, 2));
const folderOf = (id) => folders.list.find((f) => f.id === id) || null;
const cleanFolderName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '');

app.get('/api/folders', async (req, res, next) => {
  try {
    const counts = {};
    for (const r of await storage.list()) if (r.folderId) counts[r.folderId] = (counts[r.folderId] || 0) + 1;
    res.json({ folders: folders.list.map((f) => ({ ...f, count: counts[f.id] || 0 })), lastUsed: folderOf(folders.lastUsed) ? folders.lastUsed : null });
  } catch (err) {
    next(err);
  }
});

app.post('/api/folders', localOrToken, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const name = cleanFolderName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Give the folder a name' });
    if (folders.list.some((f) => f.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: `There is already a folder called "${name}"` });
    const folder = { id: newId(), name, color: FOLDER_COLORS[folders.list.length % FOLDER_COLORS.length], createdAt: new Date().toISOString() };
    folders.list.push(folder);
    await saveFolders();
    res.status(201).json({ ...folder, count: 0 });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/folders/:id', localOrToken, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const folder = folderOf(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    const name = cleanFolderName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Give the folder a name' });
    if (folders.list.some((f) => f !== folder && f.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: `There is already a folder called "${name}"` });
    folder.name = name;
    await saveFolders();
    res.json(folder);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/folders/:id', localOrToken, async (req, res, next) => {
  try {
    const folder = folderOf(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    // What was inside stays, just without a folder.
    for (const r of await storage.list()) if (r.folderId === folder.id) await storage.updateWith(r.id, (x) => delete x.folderId);
    folders.list = folders.list.filter((f) => f !== folder);
    if (folders.lastUsed === folder.id) folders.lastUsed = null;
    await saveFolders();
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// Move recordings into a folder (folderId null = no folder). remember: new captures go there too.
app.post('/api/folders/move', localOrToken, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    const folderId = req.body?.folderId || null;
    if (folderId && !folderOf(folderId)) return res.status(404).json({ error: 'Folder not found' });
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => ID_PATTERN.test(String(x))).slice(0, 500);
    let moved = 0;
    for (const id of ids) {
      const ok = await storage
        .updateWith(id, (r) => {
          if (folderId) r.folderId = folderId;
          else delete r.folderId;
        })
        .then(() => true, () => false);
      if (ok) moved += 1;
    }
    if (req.body?.remember) {
      folders.lastUsed = folderId;
      await saveFolders();
    }
    res.json({ moved, folderId });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recordings', requireUploadToken, express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    const id = newId();
    let record = await storage.create(id, sanitizeMeta(req.body?.meta));
    // Straight into the folder last used for captures.
    if (folderOf(folders.lastUsed)) record = await storage.updateWith(id, (r) => (r.folderId = folders.lastUsed));
    res.status(201).json({ id, viewerUrl: viewerUrl(id) });
    // Reserve the public link in the background so recording starts without waiting on Google.
    if (drive.connected) reserveDriveLink(record || (await storage.get(id)));
  } catch (err) {
    next(err);
  }
});

app.put(
  '/api/recordings/:id/chunks/:index',
  requireUploadToken,
  express.raw({ type: () => true, limit: config.maxChunkBytes }),
  async (req, res, next) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Bad chunk index' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Empty chunk' });
      const record = await storage.appendChunk(req.params.id, index, req.body);
      res.json({ received: record.chunks });
    } catch (err) {
      next(err);
    }
  },
);

app.post('/api/recordings/:id/finalize', requireUploadToken, express.json({ limit: '50mb' }), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    await storage.finalize(id, {
      events: Array.isArray(body.events) ? body.events : [],
      pauses: Array.isArray(body.pauses)
        ? body.pauses.filter((p) => Number.isFinite(p?.start) && Number.isFinite(p?.end) && p.end >= p.start).map((p) => ({ start: p.start, end: p.end }))
        : [],
      startedAt: Number(body.startedAt) || null,
      endedAt: Number(body.endedAt) || null,
      durationMs: Number(body.durationMs) || null,
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'video/webm',
      env: sanitizeMeta(body.env),
    });
    if (drive.connected) await patchDrive(id, { status: 'pending' });
    res.json({ id, viewerUrl: viewerUrl(id) });
    processInBackground(id);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- screenshots
// Create with POST /api/recordings (meta.type = "screenshot"), then upload the PNG, then finalize.

app.put('/api/recordings/:id/image', requireUploadToken, express.raw({ type: () => true, limit: '40mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length < 8) return res.status(400).json({ error: 'Empty image' });
    // PNG signature: \x89PNG
    if (req.body[0] !== 0x89 || req.body[1] !== 0x50 || req.body[2] !== 0x4e || req.body[3] !== 0x47) return res.status(400).json({ error: 'Not a PNG image' });
    await storage.writeImage(req.params.id, req.body);
    res.json({ bytes: req.body.length });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recordings/:id/finalize-shot', requireUploadToken, express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    const { id } = req.params;
    const imagePath = storage.imagePath(id);
    if (!imagePath) return res.status(409).json({ error: 'Upload the image first' });
    const body = req.body || {};
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    // The thumbnail is rebuilt in the background so autosaves answer quickly.
    makeImagePoster({ ffmpegPath: config.ffmpegPath, imagePath, posterPath: storage.file(id, 'poster.jpg') }).catch(() => {});
    const record = await storage.updateWith(id, (r) => {
      r.type = 'screenshot';
      r.status = 'ready';
      r.startedAt = r.startedAt || Date.parse(r.createdAt);
      r.durationMs = null;
      r.eventCounts = null;
      r.image = { width: Number(body.width) || null, height: Number(body.height) || null };
      r.meta = {
        ...r.meta,
        type: 'screenshot',
        title: str(body.title, 200)?.trim() || r.meta?.title,
        // Left out = unchanged (the editor's autosave sends only the image size).
        description: str(body.description, 5000) ?? r.meta?.description ?? '',
        kind: body.kind === undefined ? r.meta?.kind || 'bug' : body.kind === 'suggestion' ? 'suggestion' : 'bug',
        env: { ...(r.meta?.env || {}), ...sanitizeMeta(body.env) },
      };
    });
    if (drive.connected) scheduleDriveRefresh(id, req.query.now === '1' ? 0 : 4000);
    res.json({ id, viewerUrl: viewerUrl(id), shareUrl: shareUrlOf(record) });
  } catch (err) {
    next(err);
  }
});

// The unannotated capture and the marks, so a screenshot can be edited again later. They stay
// on this computer (the original may show what a blur hides) and are never sent to Drive.
app.put('/api/recordings/:id/original', requireUploadToken, express.raw({ type: () => true, limit: '40mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body[0] !== 0x89 || req.body[1] !== 0x50) return res.status(400).json({ error: 'Not a PNG image' });
    await storage.get(req.params.id);
    await fsp.writeFile(storage.file(req.params.id, 'original.png'), req.body);
    res.json({ bytes: req.body.length });
  } catch (err) {
    next(err);
  }
});

app.get('/api/recordings/:id/original', uploaderOrLocalRead, (req, res) => {
  const p = [storage.file(req.params.id, 'original.png'), storage.imagePath(req.params.id)].find((f) => f && existsSync(f));
  if (!p) return res.sendStatus(404);
  res.sendFile(p, { headers: { 'Cache-Control': 'no-store' } });
});

app.put('/api/recordings/:id/annotations', requireUploadToken, express.json({ limit: '2mb' }), async (req, res, next) => {
  try {
    await storage.get(req.params.id);
    const shapes = Array.isArray(req.body?.shapes) ? req.body.shapes.slice(0, 500) : [];
    await fsp.writeFile(storage.file(req.params.id, 'annotations.json'), JSON.stringify({ version: 1, shapes }));
    res.json({ count: shapes.length });
  } catch (err) {
    next(err);
  }
});

app.get('/api/recordings/:id/annotations', uploaderOrLocalRead, async (req, res) => {
  try {
    res.json(JSON.parse(await fsp.readFile(storage.file(req.params.id, 'annotations.json'), 'utf8')));
  } catch {
    res.json({ version: 1, shapes: [] });
  }
});

app.get('/api/recordings/:id/image', (req, res) => {
  const p = storage.imagePath(req.params.id);
  if (!p) return res.sendStatus(404);
  res.sendFile(p, { headers: { 'Cache-Control': 'private, max-age=60' } });
});

// Discard or delete: removes the local copy and, when it was shared, the Drive files.
const uploaderOrLocal = (req, res, next) =>
  req.user || (!auth.enabled && !config.uploadToken) || req.get('X-Upload-Token') === config.uploadToken ? next() : localOrToken(req, res, next);

app.delete('/api/recordings/:id', uploaderOrLocal, async (req, res, next) => {
  try {
    const record = await storage.get(req.params.id).catch(() => null);
    await reservations.get(req.params.id)?.catch(() => {});
    const d = (await storage.get(req.params.id).catch(() => null))?.drive || record?.drive;
    if (d && drive.connected && (d.manifestId || d.videoId)) {
      await drive.deleteFiles([d.manifestId, d.videoId]).catch((err) => console.error(`[drive ${req.params.id}] delete:`, err.message));
    }
    await storage.remove(req.params.id);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// Title and description, set on the review screen after recording.
app.patch('/api/recordings/:id', localOrToken, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+$/g, '').slice(0, max) : undefined);
    const title = clean(req.body?.title, 200);
    const description = clean(req.body?.description, 5000);
    const record = await storage.updateWith(req.params.id, (r) => {
      r.meta = { ...r.meta };
      if (title !== undefined) r.meta.title = title.trim() || r.meta.title;
      if (description !== undefined) r.meta.description = description;
    });
    if (record.drive?.status === 'done' && drive.connected) queueManifestRefresh(record.id);
    res.json({ id: record.id, title: record.meta.title, description: record.meta.description || '' });
  } catch (err) {
    next(err);
  }
});

async function processInBackground(id) {
  try {
    const rawPath = storage.file(id, 'video.raw.webm');
    const result = await processVideo({
      ffmpegPath: config.ffmpegPath,
      rawPath,
      outPath: storage.file(id, 'video.webm'),
      posterPath: storage.file(id, 'poster.jpg'),
    });
    await storage.update(id, { status: 'ready', processing: result });
  } catch (err) {
    console.error(`[process ${id}]`, err.message);
    // The raw file is still playable, just less seekable.
    await storage.update(id, { status: 'ready', processing: { error: err.message } }).catch(() => {});
  }
  if (drive.connected) queueDriveUpload(id);
}

// ---------------------------------------------------------------- Google Drive

/** Merge into record.drive without losing the reserved ids. */
const patchDrive = (id, patch) => storage.updateWith(id, (r) => (r.drive = { ...(r.drive || {}), ...patch }));

const reservations = new Map(); // id -> promise while the link is being reserved

function reserveDriveLink(record) {
  const p = drive
    .reserve(record)
    .then((reserved) => patchDrive(record.id, { ...reserved, status: 'reserved' }))
    .catch((err) => console.error(`[drive ${record.id}] could not reserve a link:`, err.message))
    .finally(() => reservations.delete(record.id));
  reservations.set(record.id, p);
  return p;
}

// One upload at a time keeps bandwidth predictable and Drive rate limits happy.
let driveQueue = Promise.resolve();
const queued = new Set();

const rerun = new Set(); // changed again while queued or uploading

function queueDriveUpload(id) {
  if (queued.has(id)) {
    rerun.add(id);
    return;
  }
  queued.add(id);
  patchDrive(id, { status: 'pending' }).catch(() => {});
  driveQueue = driveQueue
    .then(() => uploadToDrive(id))
    .finally(() => {
      queued.delete(id);
      if (rerun.delete(id)) queueDriveUpload(id);
    });
}

// Screenshot edits save every few seconds; upload once they settle.
const refreshTimers = new Map();
function scheduleDriveRefresh(id, delayMs) {
  clearTimeout(refreshTimers.get(id));
  patchDrive(id, { status: 'pending' }).catch(() => {});
  refreshTimers.set(id, setTimeout(() => {
    refreshTimers.delete(id);
    queueDriveUpload(id);
  }, delayMs));
}

/** Direct image address of a screenshot on Drive (public file), for showing it inside GitHub issues. */
function shotImageUrl(record) {
  const fileId = record?.type === 'screenshot' ? record.drive?.videoId : null;
  return fileId && /^[\w-]+$/.test(fileId) ? `https://lh3.googleusercontent.com/d/${fileId}=w4000` : null;
}

/** Images to show inside a GitHub issue: the screenshot itself, or a recording's captured frames. */
async function issueImages(record, { wait = false } = {}) {
  if (record?.type === 'screenshot') {
    const r = wait && shotImageUrl(record) ? await waitForDrive(record.id) : record;
    const url = shotImageUrl(r);
    return url ? [{ alt: 'Screenshot', url, fileId: r.drive.videoId }] : [];
  }
  const out = [];
  const until = Date.now() + 20000;
  for (const f of record?.frames?.length ? await frameShotsOf(record) : []) {
    let shot = await storage.get(f.id).catch(() => null);
    if (wait && shot && shotImageUrl(shot)) shot = await waitForDrive(shot.id, Math.max(0, until - Date.now()));
    const url = shotImageUrl(shot);
    if (url) out.push({ alt: `Frame at ${clock(f.at)}`, url, fileId: shot.drive.videoId });
  }
  return out;
}

/** Put those images into an issue body (under Attachments), each once. */
function withImages(body, images) {
  let text = String(body || '');
  const lines = images.filter((i) => !text.includes(`${i.fileId}=`)).map((i) => `![${i.alt}](${i.url})`);
  if (!lines.length) return text;
  const block = lines.join('\n');
  const m = /^##\s*Attachments[^\n]*\n/im.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + block + '\n' + text.slice(m.index + m[0].length);
  return `${text}${text ? '\n\n' : ''}## Attachments\n${block}`;
}

/** Wait (a little) for a pending Drive upload so the image is there when GitHub first shows it. */
async function waitForDrive(id, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await storage.get(id);
    if (!r.drive || r.drive.status === 'done' || r.drive.status === 'error' || Date.now() > end) return r;
    if (refreshTimers.has(id)) {
      // An edit is waiting to upload: send it now.
      clearTimeout(refreshTimers.get(id));
      refreshTimers.delete(id);
      queueDriveUpload(id);
    }
    await new Promise((res) => setTimeout(res, 700));
  }
}

function queueManifestRefresh(id) {
  driveQueue = driveQueue.then(async () => {
    try {
      const record = await storage.get(id);
      await drive.refreshManifest({ record, events: await storage.getEvents(id), posterPath: storage.posterPath(id) });
    } catch (err) {
      console.error(`[drive ${id}] refresh:`, err.message);
    }
  });
}

async function uploadToDrive(id) {
  try {
    await reservations.get(id)?.catch(() => {});
    const record = await storage.get(id);
    const videoPath = record.type === 'screenshot' ? storage.imagePath(id) : storage.videoPath(id);
    if (!videoPath) throw new Error(record.type === 'screenshot' ? 'No image to upload' : 'No video file to upload');
    await patchDrive(id, { status: 'uploading', startedAt: new Date().toISOString(), error: undefined });
    const result = await drive.publish({
      record,
      events: await storage.getEvents(id),
      videoPath,
      posterPath: storage.posterPath(id),
      // After a trim (videoRev goes up) the video on Drive is replaced, not kept.
      reserved: { ...record.drive, needsVideo: (record.videoRev || 0) !== (record.drive?.videoRev || 0) },
    });
    const after = await patchDrive(id, { ...result, status: 'done', error: undefined, videoRev: record.videoRev || undefined });
    console.log(`[drive ${id}] shared: ${result.shareUrl}`);
    // Title or description edited while uploading: publish the latest.
    if (after.meta?.title !== record.meta?.title || after.meta?.description !== record.meta?.description) queueManifestRefresh(id);
  } catch (err) {
    console.error(`[drive ${id}]`, err.message);
    await patchDrive(id, { status: 'error', error: err.message, at: new Date().toISOString() }).catch(() => {});
  }
}

// The reserved link works from the start; it shows "uploading" until the video is there.
const shareUrlOf = (r) => r.drive?.shareUrl || null;

app.get('/auth/google', localOnly, (req, res, next) => {
  try {
    res.redirect(drive.authUrl());
  } catch (err) {
    next(err);
  }
});

app.get('/auth/google/callback', localOnly, async (req, res) => {
  try {
    await drive.handleCallback({ code: req.query.code, state: req.query.state, error: req.query.error });
    res.redirect(`${config.publicBaseUrl}/settings?connected=1`);
  } catch (err) {
    res.redirect(`${config.publicBaseUrl}/settings?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/drive', localOnly, (req, res) => res.json(drive.status()));

app.post('/api/drive/disconnect', localOnly, async (req, res, next) => {
  try {
    await drive.disconnect();
    res.json(drive.status());
  } catch (err) {
    next(err);
  }
});

// Upload one recording now (retry after an error, or one made before Drive was connected).
app.post('/api/recordings/:id/drive', localOnly, async (req, res, next) => {
  try {
    if (!drive.connected) return res.status(409).json({ error: 'Google Drive is not connected' });
    const record = await storage.get(req.params.id);
    if (record.status !== 'ready') return res.status(409).json({ error: 'Recording is still processing' });
    queueDriveUpload(record.id);
    res.status(202).json({ queued: true });
  } catch (err) {
    next(err);
  }
});

// Public link for any recording, on demand (Copy link buttons). Recordings made before Drive
// was connected get their link reserved now and start uploading; the link works right away.
app.post('/api/recordings/:id/share', localOrToken, async (req, res, next) => {
  try {
    let record = await storage.get(req.params.id);
    if (record.drive?.shareUrl) return res.json({ shareUrl: record.drive.shareUrl, status: record.drive.status });
    if (!drive.connected) return res.status(409).json({ error: 'Google Drive is not connected', viewerUrl: viewerUrl(record.id) });
    await (reservations.get(record.id) || reserveDriveLink(record));
    record = await storage.get(record.id);
    if (!record.drive?.shareUrl) return res.status(502).json({ error: record.drive?.error || 'Could not create a share link on Google Drive' });
    if (record.status === 'ready' && !['pending', 'uploading', 'done'].includes(record.drive.status)) queueDriveUpload(record.id);
    res.json({ shareUrl: record.drive.shareUrl, status: record.drive.status });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- AI bug reports

app.get('/api/ai', localOnly, async (req, res) => res.json(await writer.status()));

// Choose the provider (Claude Code or API key), the API model, and save or clear the key.
app.put('/api/ai', localOnly, express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    // Older clients sent { provider: 'api', apiKey, apiModel } for Anthropic.
    const patch = {
      provider: b.provider === 'api' ? 'anthropic' : b.provider,
      keys: { ...(b.keys || {}), ...(typeof b.apiKey === 'string' ? { anthropic: b.apiKey } : {}) },
      models: { ...(b.models || {}), ...(b.apiModel ? { anthropic: b.apiModel } : {}) },
      ollamaUrl: b.ollamaUrl,
    };
    await writer.save(patch);
    res.json(await writer.status());
  } catch (err) {
    next(err);
  }
});

app.get('/api/ai/models', localOnly, async (req, res, next) => {
  try {
    res.json(await writer.listModels(String(req.query.provider || '')));
  } catch (err) {
    next(err);
  }
});

app.post('/api/ai/test', localOnly, async (req, res, next) => {
  try {
    res.json(await writer.test(req.query.provider ? String(req.query.provider) : undefined));
  } catch (err) {
    err.status = err.status || 502;
    next(err);
  }
});

// Write the report with Claude Code from the reporter's description plus the recording's data.
app.post('/api/recordings/:id/report', localOrToken, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 5000) : '';
    const kind = req.body?.kind === 'suggestion' ? 'suggestion' : 'bug';
    const record = await storage.updateWith(req.params.id, (r) => {
      r.meta = { ...r.meta, description: description || r.meta?.description || '' };
    });
    if (record.status !== 'ready') return res.status(409).json({ error: 'The recording is still processing. Try again in a moment.' });
    const status = await writer.status();
    if (!status.available) return res.status(503).json({ error: `${status.error} Change it in BugSnap Settings → AI reports.` });
    const link = record.drive?.shareUrl || viewerUrl(record.id);
    const out = await writer.write(reportContext({ record, events: await storage.getEvents(record.id), link, description: record.meta.description, kind }));
    const saved = await storage.updateWith(record.id, (r) => {
      r.report = { markdown: out.markdown, kind, generatedAt: new Date().toISOString(), model: out.model, provider: out.provider };
    });
    if (saved.drive?.status === 'done' && drive.connected) queueManifestRefresh(saved.id);
    res.json(saved.report);
  } catch (err) {
    err.status = err.status || 502;
    next(err);
  }
});

// Save edits to the report (it is shown on the shared link too).
app.put('/api/recordings/:id/report', localOrToken, express.json({ limit: '128kb' }), async (req, res, next) => {
  try {
    const markdown = typeof req.body?.markdown === 'string' ? req.body.markdown.slice(0, 60_000) : '';
    const saved = await storage.updateWith(req.params.id, (r) => {
      r.report = { ...(r.report || {}), markdown, editedAt: new Date().toISOString() };
    });
    if (saved.drive?.status === 'done' && drive.connected) queueManifestRefresh(saved.id);
    res.json(saved.report);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- GitHub issues

app.get('/api/github', localOnly, (req, res) => res.json(github.status()));

app.put('/api/github', localOnly, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    if (typeof req.body?.token === 'string') await github.setToken(req.body.token);
    if (typeof req.body?.defaultRepo === 'string') await github.setDefaultRepo(req.body.defaultRepo);
    res.json(github.status());
  } catch (err) {
    next(err);
  }
});

app.get('/api/github/repos', localOnly, async (req, res, next) => {
  try {
    res.json(await github.repos());
  } catch (err) {
    next(err);
  }
});

app.get('/api/github/meta', localOnly, async (req, res, next) => {
  try {
    res.json(await github.repoMeta(String(req.query.repo || '')));
  } catch (err) {
    next(err);
  }
});

app.get('/api/github/projects', localOnly, async (req, res, next) => {
  try {
    res.json(await github.projects(String(req.query.repo || '')));
  } catch (err) {
    next(err);
  }
});

// What the issue form starts with: the saved report split into title and body, with the link.
app.get('/api/recordings/:id/github/draft', localOrToken, async (req, res, next) => {
  try {
    const record = await storage.get(req.params.id);
    const link = record.drive?.shareUrl || viewerUrl(record.id);
    const { title, body } = splitReport(record.report?.markdown, record.meta?.title);
    const label = record.type === 'screenshot' ? 'Screenshot' : 'Recording';
    const withLink = withImages(body.includes(link) ? body : [body, `**${label}:** ${link}`].filter(Boolean).join('\n\n'), await issueImages(record));
    res.json({ title, body: withLink, hasReport: Boolean(record.report?.markdown), repo: github.status().defaultRepo, issues: record.github || [] });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recordings/:id/github', localOrToken, express.json({ limit: '128kb' }), async (req, res, next) => {
  try {
    const record = await storage.get(req.params.id);
    // Screenshots (and frames captured from a recording) go into the issue as images, not links.
    const images = await issueImages(record, { wait: true });
    const { nodeId, ...issue } = await github.createIssue({ ...(req.body || {}), body: withImages(req.body?.body, images) });
    await github.setDefaultRepo(issue.repo);
    // Boards are set right after the issue exists (GitHub cannot do both in one call).
    const boards = Array.isArray(req.body?.projects) && req.body.projects.length && nodeId ? await github.addToProjects(nodeId, req.body.projects) : [];
    const saved = await storage.updateWith(record.id, (r) => {
      r.github = [issue, ...(r.github || [])].slice(0, 10);
    });
    if (saved.drive?.status === 'done' && drive.connected) queueManifestRefresh(saved.id);
    res.status(201).json({ ...issue, boards });
  } catch (err) {
    next(err);
  }
});

// Upload every ready recording that is not on Drive yet.
app.post('/api/drive/upload-all', localOnly, async (req, res, next) => {
  try {
    if (!drive.connected) return res.status(409).json({ error: 'Google Drive is not connected' });
    const list = await storage.list();
    const todo = list.filter((r) => r.status === 'ready' && r.drive?.status !== 'done');
    todo.forEach((r) => queueDriveUpload(r.id));
    res.status(202).json({ queued: todo.length });
  } catch (err) {
    next(err);
  }
});

app.get('/api/recordings', async (req, res, next) => {
  if (config.disableList) return res.status(404).json({ error: 'Listing is disabled on this server' });
  try {
    const list = await storage.list();
    res.json(
      list.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt,
        durationMs: r.durationMs,
        title: r.meta?.title || r.meta?.startUrl || null,
        mode: r.meta?.mode,
        reporter: r.meta?.reporter || null,
        eventCounts: r.eventCounts || null,
        hasPoster: !!storage.posterPath(r.id),
        type: r.type || 'recording',
        github: r.github?.[0] ? { number: r.github[0].number, url: r.github[0].url, repo: r.github[0].repo } : null,
        shareUrl: shareUrlOf(r),
        driveStatus: r.drive?.status || null,
        viewerUrl: viewerUrl(r.id),
        folderId: r.folderId || null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- frames from recordings

const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Screenshots captured from a recording, oldest moment first (deleted ones are skipped). */
async function frameShotsOf(record) {
  const out = [];
  for (const fid of record?.frames || []) {
    const r = await storage.get(fid).catch(() => null);
    if (!r || r.type !== 'screenshot') continue;
    out.push({ id: r.id, at: r.meta?.fromRecording?.at || 0, title: r.meta?.title, fileId: r.drive?.videoId || null, driveStatus: r.drive?.status || null, viewerUrl: viewerUrl(r.id) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Where a frame screenshot came from: its recording and the moment. */
async function fromRecordingOf(record) {
  const from = record?.meta?.fromRecording;
  if (!from?.id) return null;
  const parent = await storage.get(from.id).catch(() => null);
  if (!parent) return null;
  return { id: parent.id, at: from.at || 0, title: parent.meta?.title || 'Recording', shareUrl: shareUrlOf(parent), viewerUrl: viewerUrl(parent.id) };
}

// Start a screenshot from the current frame of a recording. The player then uploads the image
// (PUT /image and /original) and finalizes it like any screenshot.
app.post('/api/recordings/:id/frames', requireUploadToken, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    const parent = await storage.get(req.params.id);
    if (parent.type === 'screenshot' || parent.meta?.fromRecording || !storage.videoPath(parent.id)) return res.status(400).json({ error: 'Frames come from finished recordings' });
    const at = Math.max(0, Math.min(Number(req.body?.at) || 0, 24 * 3600));
    const pm = parent.meta || {};
    const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
    const pageUrl = str(req.body?.pageUrl, 2000);
    const meta = sanitizeMeta({
      ...pm,
      title: `${pm.title || 'Recording'} · ${clock(at)}`,
      startUrl: pageUrl && /^https?:\/\//.test(pageUrl) ? pageUrl : pm.startUrl,
      description: '',
      capturedAt: new Date((parent.startedAt || Date.parse(parent.createdAt)) + at * 1000).toISOString(),
      fromRecording: { id: parent.id, at },
    });
    const id = newId();
    await storage.create(id, meta);
    // "Captured" is when that moment happened in the recording, not when the frame was grabbed.
    await storage.updateWith(id, (r) => {
      r.startedAt = Date.parse(meta.capturedAt) || r.startedAt;
      if (parent.folderId) r.folderId = parent.folderId;
      else delete r.folderId;
    });
    await storage.updateWith(parent.id, (r) => {
      r.frames = [...(r.frames || []), id].slice(-30);
    });
    res.status(201).json({ id, viewerUrl: viewerUrl(id) });
    if (drive.connected) reserveDriveLink(await storage.get(id));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- trim (recordings)
// Keep [start, end] seconds of the video. Steps, logs and captured frames move with it, so the
// player, the AI report and the public link all show the trimmed recording.

const trimming = new Set();

/** Seconds into the video for an event, with paused stretches removed (same as the player). */
function videoOffset(record, ev) {
  const ts = ev.type === 'network' && ev.startedAt ? ev.startedAt : ev.ts;
  let paused = 0;
  for (const p of record.pauses || []) {
    if (p.start >= ts) break;
    paused += Math.min(ts, p.end) - p.start;
  }
  return Math.max(0, (ts - record.startedAt - paused) / 1000);
}

app.post('/api/recordings/:id/trim', localOrToken, express.json({ limit: '8kb' }), async (req, res, next) => {
  const { id } = req.params;
  if (trimming.has(id)) return res.status(409).json({ error: 'Already trimming this recording' });
  trimming.add(id);
  const tmp = storage.file(id, 'video.trim.webm');
  try {
    const record = await storage.get(id);
    const inPath = storage.videoPath(id);
    if (record.type === 'screenshot' || record.status !== 'ready' || !inPath) return res.status(409).json({ error: 'Only finished recordings can be trimmed' });
    const total = (record.durationMs || 0) / 1000;
    const start = Math.max(0, Number(req.body?.start) || 0);
    const end = Math.min(total || Infinity, Number(req.body?.end) || total);
    if (!(end - start >= 0.5)) return res.status(400).json({ error: 'Keep at least half a second' });
    if (start < 0.05 && end > total - 0.05) return res.json({ id, durationMs: record.durationMs, trimmed: false });

    await trimVideo({ ffmpegPath: config.ffmpegPath, inPath, outPath: tmp, posterPath: storage.file(id, 'poster.jpg'), start, end });
    // Windows may refuse to replace a file that is being streamed: retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, storage.file(id, 'video.webm'));
        break;
      } catch (err) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // New clock: the recording now "starts" at the cut and has no pauses.
    const startedAt = (record.startedAt || Date.parse(record.createdAt)) + Math.round(start * 1000);
    const durationMs = Math.round((end - start) * 1000);
    const events = await storage.getEvents(id);
    const kept = [];
    let lastNav = null;
    for (const ev of events) {
      if (!ev || typeof ev.ts !== 'number') continue;
      const off = videoOffset(record, ev);
      if (off < start) {
        // The page open when the trimmed video starts still matters ("Starts on …").
        if (ev.type === 'navigation') lastNav = ev;
        continue;
      }
      if (off > end) continue;
      const shift = startedAt + Math.round((off - start) * 1000) - (ev.type === 'network' && ev.startedAt ? ev.startedAt : ev.ts);
      kept.push({ ...ev, ts: ev.ts + shift, ...(ev.startedAt ? { startedAt: ev.startedAt + shift } : {}) });
    }
    if (lastNav && !kept.some((e) => e.type === 'navigation' && e.ts <= startedAt + 50)) kept.unshift({ ...lastNav, ts: startedAt });
    await fsp.writeFile(storage.file(id, 'events.json'), JSON.stringify(kept));

    // Frames captured from the cut-away parts no longer belong to this recording.
    const frames = [];
    for (const fid of record.frames || []) {
      const shot = await storage.get(fid).catch(() => null);
      const at = shot?.meta?.fromRecording?.at;
      if (!shot || typeof at !== 'number' || at < start || at > end) continue;
      await storage.updateWith(fid, (r) => (r.meta = { ...r.meta, fromRecording: { ...r.meta.fromRecording, at: at - start } }));
      frames.push(fid);
    }

    const saved = await storage.updateWith(id, (r) => {
      r.trims = [...(r.trims || []), { start, end, ofMs: r.durationMs, at: new Date().toISOString() }].slice(-10);
      r.startedAt = startedAt;
      r.endedAt = startedAt + durationMs;
      r.durationMs = durationMs;
      r.pauses = [];
      r.eventCounts = countEvents(kept);
      r.frames = frames;
      r.videoRev = (r.videoRev || 0) + 1;
      r.processing = { ...(r.processing || {}), trimmed: true };
    });
    console.log(`[trim ${id}] kept ${clock(start)}–${clock(end)} (${(durationMs / 1000).toFixed(1)}s)`);
    // The share link stays the same; Drive gets the new video.
    if (drive.connected && saved.drive?.videoId) queueDriveUpload(id);
    res.json({ id, durationMs, trimmed: true });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    next(err);
  } finally {
    trimming.delete(id);
  }
});

app.get('/api/recordings/:id', async (req, res, next) => {
  try {
    const record = await storage.get(req.params.id);
    const events = req.query.events === '0' ? undefined : await storage.getEvents(req.params.id);
    res.json({
      ...record,
      viewerUrl: viewerUrl(record.id),
      shareUrl: shareUrlOf(record),
      driveConnected: drive.connected,
      hasPoster: !!storage.posterPath(record.id),
      frameShots: record.frames?.length ? await frameShotsOf(record) : undefined,
      fromRecordingInfo: record.meta?.fromRecording ? await fromRecordingOf(record) : undefined,
      events,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/recordings/:id/video', (req, res) => {
  const p = storage.videoPath(req.params.id);
  if (!p) return res.status(404).json({ error: 'No video yet' });
  // sendFile handles HTTP Range requests, which is what makes streaming and seeking work.
  res.sendFile(p, { headers: { 'Content-Type': 'video/webm', 'Cache-Control': 'private, max-age=60' } });
});

app.get('/api/recordings/:id/poster', (req, res) => {
  const p = storage.posterPath(req.params.id);
  if (!p) return res.sendStatus(404);
  res.sendFile(p);
});

// Viewer pages
app.get('/r/:id', (req, res) => res.sendFile(path.join(config.publicDir, 'viewer.html')));
app.get('/settings', localOnly, (req, res) => res.sendFile(path.join(config.publicDir, 'settings.html')));
app.use(express.static(config.publicDir, { index: 'index.html' }));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, ...(err.details || {}) });
});

// Uploads with no activity for 6 hours were abandoned (crash, closed window).
const SWEEP_AGE_MS = 6 * 60 * 60 * 1000;
const sweep = () =>
  storage
    .sweepAbandoned(SWEEP_AGE_MS)
    .then((ids) => ids.length && console.log(`Removed ${ids.length} abandoned upload(s)`))
    .catch((err) => console.error('sweep failed', err.message));
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

// Uploads cut short by a restart start again.
if (drive.connected) {
  storage
    .list()
    .then((list) => list.filter((r) => r.status === 'ready' && ['pending', 'uploading'].includes(r.drive?.status)).forEach((r) => queueDriveUpload(r.id)))
    .catch(() => {});
}

const server = app.listen(config.port, config.host, () => {
  console.log(`BugSnap server on ${config.publicBaseUrl} (data: ${config.dataDir})`);
  if (auth.enabled) console.log(auth.users.length ? `Sign-in: on (${auth.users.length} user${auth.users.length === 1 ? '' : 's'})` : 'Sign-in: on, but no users yet. Add one: npm run user add <name>');
  else if (config.host !== '127.0.0.1') console.warn('Sign-in is off and the server accepts other machines. Set REQUIRE_LOGIN=1 and add users: npm run user add <name>');
  const d = drive.status();
  if (!d.configured) console.log('Google Drive: not set up, recordings stay on this computer. See SETUP-GOOGLE-DRIVE.md');
  else if (!d.connected) console.log("Google Drive: not connected. Connect it in BugSnap Settings (click the extension icon, then the gear).");
  else console.log(`Google Drive: connected${d.email ? ` as ${d.email}` : ''}${d.viewerUrl ? '' : ' (VIEWER_URL not set: links point to Drive instead of the player)'}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other server or set PORT, e.g. PORT=4801 npm start`);
    process.exit(1);
  }
  throw err;
});

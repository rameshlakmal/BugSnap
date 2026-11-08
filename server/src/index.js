import express from 'express';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { newId, ID_PATTERN } from './ids.js';
import { LocalStorage } from './storage/local.js';
import { processVideo, makeImagePoster } from './media.js';
import { Drive } from './drive.js';
import { ReportWriter, reportContext } from './ai.js';
import { GitHub, splitReport } from './github.js';

const storage = new LocalStorage(config.dataDir);
await storage.init();
const drive = new Drive({ ...config.google, dataDir: config.dataDir, port: config.port, viewerUrl: config.viewerUrl });
await drive.load();
const writer = new ReportWriter({ command: config.claudePath, model: config.aiModel, dataDir: config.dataDir, envApiKey: config.anthropicApiKey });
await writer.load();
const github = new GitHub({ dataDir: config.dataDir, envToken: config.githubToken });
await github.load();

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

function requireUploadToken(req, res, next) {
  if (!config.uploadToken) return next();
  if (req.get('X-Upload-Token') === config.uploadToken) return next();
  res.status(401).json({ error: 'Invalid upload token' });
}

// Drive sign-in and publishing act on your Google account: only this computer may use them.
function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: 'Only available on the computer running the server' });
}

/** Edits and deletes: this computer, or anyone with the upload token. */
function localOrToken(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  if (config.uploadToken && req.get('X-Upload-Token') === config.uploadToken) return next();
  res.status(403).json({ error: 'Not allowed' });
}

// Reading the unannotated original: this computer, or the upload token.
const uploaderOrLocalRead = (req, res, next) =>
  config.uploadToken && req.get('X-Upload-Token') === config.uploadToken ? next() : localOnly(req, res, next);

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

app.post('/api/recordings', requireUploadToken, express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    const id = newId();
    const record = await storage.create(id, sanitizeMeta(req.body?.meta));
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
        description: str(body.description, 5000) || '',
        kind: body.kind === 'suggestion' ? 'suggestion' : 'bug',
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
  !config.uploadToken || req.get('X-Upload-Token') === config.uploadToken ? next() : localOrToken(req, res, next);

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
      reserved: record.drive,
    });
    const after = await patchDrive(id, { ...result, status: 'done', error: undefined });
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

// What the issue form starts with: the saved report split into title and body, with the link.
app.get('/api/recordings/:id/github/draft', localOrToken, async (req, res, next) => {
  try {
    const record = await storage.get(req.params.id);
    const link = record.drive?.shareUrl || viewerUrl(record.id);
    const { title, body } = splitReport(record.report?.markdown, record.meta?.title);
    const label = record.type === 'screenshot' ? 'Screenshot' : 'Recording';
    const withLink = body.includes(link) ? body : [body, `**${label}:** ${link}`].filter(Boolean).join('\n\n');
    res.json({ title, body: withLink, hasReport: Boolean(record.report?.markdown), repo: github.status().defaultRepo, issues: record.github || [] });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recordings/:id/github', localOrToken, express.json({ limit: '128kb' }), async (req, res, next) => {
  try {
    const record = await storage.get(req.params.id);
    const issue = await github.createIssue(req.body || {});
    await github.setDefaultRepo(issue.repo);
    const saved = await storage.updateWith(record.id, (r) => {
      r.github = [issue, ...(r.github || [])].slice(0, 10);
    });
    if (saved.drive?.status === 'done' && drive.connected) queueManifestRefresh(saved.id);
    res.status(201).json(issue);
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
      })),
    );
  } catch (err) {
    next(err);
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
  if (!config.uploadToken && config.host !== '127.0.0.1') console.warn('UPLOAD_TOKEN is not set: anyone who can reach this server can upload.');
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

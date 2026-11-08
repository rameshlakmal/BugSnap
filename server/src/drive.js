// Google Drive publishing: after a recording is processed, upload the video, poster and a
// manifest (metadata + events) to a "BugSnap" folder in your Drive, make them viewable by
// anyone with the link, and build a share link to the static player (GitHub Pages).
//
// Auth: OAuth "Desktop app" client, drive.file scope (the app only sees files it created).
// The refresh token is kept in <dataDir>/google-drive.json. No Google SDK: plain fetch.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CHUNK_BYTES = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const MANIFEST_VERSION = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Safe Drive file name from a recording title. */
function fileName(title, id, ext) {
  const clean = String(title || 'Recording').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean || 'Recording'} (${id}).${ext}`;
}

export class Drive {
  constructor({ clientId, clientSecret, dataDir, folderName, port, viewerUrl }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.stateFile = path.join(dataDir, 'google-drive.json');
    this.folderName = folderName || 'BugSnap';
    this.port = port;
    this.viewerUrl = (viewerUrl || '').replace(/\/+$/, '');
    this.saved = null; // { refreshToken, email, folderId, connectedAt }
    this.access = null; // { token, expiresAt }
    this.states = new Map(); // OAuth state -> created time
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  get connected() {
    return Boolean(this.configured && this.saved?.refreshToken);
  }

  /** Loopback redirect: allowed for Desktop OAuth clients on any port without registering it. */
  get redirectUri() {
    return `http://127.0.0.1:${this.port}/auth/google/callback`;
  }

  status() {
    return {
      configured: this.configured,
      connected: this.connected,
      email: this.saved?.email || null,
      folderName: this.folderName,
      viewerUrl: this.viewerUrl || null,
    };
  }

  async load() {
    try {
      this.saved = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
    } catch {
      this.saved = null;
    }
  }

  async save() {
    const tmp = `${this.stateFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.stateFile);
  }

  // ------------------------------------------------------------ OAuth

  authUrl() {
    if (!this.configured) throw new DriveError('Google client ID and secret are not set (see .env.example).', 500);
    const state = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [s, t] of this.states) if (now - t > 10 * 60 * 1000) this.states.delete(s);
    this.states.set(state, now);
    return `${AUTH_URL}?${new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    })}`;
  }

  async handleCallback({ code, state, error }) {
    if (error) throw new DriveError(`Google sign-in was cancelled (${error}).`, 400);
    if (!state || !this.states.has(state)) throw new DriveError('Sign-in link expired. Try again.', 400);
    this.states.delete(state);
    const tokens = await this.tokenRequest({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    if (!tokens.refresh_token) throw new DriveError('Google did not return a refresh token. Remove BugSnap at myaccount.google.com/permissions and connect again.', 400);
    this.access = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
    this.saved = { refreshToken: tokens.refresh_token, email: null, folderId: null, connectedAt: new Date().toISOString() };
    try {
      const about = await this.json('GET', `${API}/about?fields=user(emailAddress)`);
      this.saved.email = about.user?.emailAddress || null;
    } catch {
      // The email is only for display.
    }
    await this.save();
  }

  async disconnect() {
    const token = this.saved?.refreshToken;
    this.saved = null;
    this.access = null;
    await fs.rm(this.stateFile, { force: true });
    if (token) await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
  }

  async tokenRequest(form) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'invalid_grant') {
        // Revoked, or expired because the OAuth app is still in "Testing" mode.
        this.saved = null;
        await fs.rm(this.stateFile, { force: true });
        throw new DriveError('Google Drive access expired. Connect again at /settings.', 401);
      }
      throw new DriveError(`Google sign-in failed: ${body.error_description || body.error || res.status}`, res.status);
    }
    return body;
  }

  async token() {
    if (this.access && this.access.expiresAt - 60_000 > Date.now()) return this.access.token;
    if (!this.connected) throw new DriveError('Google Drive is not connected. Connect it at /settings.', 401);
    const t = await this.tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.saved.refreshToken,
      grant_type: 'refresh_token',
    });
    this.access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return this.access.token;
  }

  // ------------------------------------------------------------ API calls

  /** fetch with auth and retries on rate limits / server errors. */
  async request(method, url, { body, headers = {} } = {}, attempts = 5) {
    for (let i = 1; ; i++) {
      let res;
      try {
        res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${await this.token()}`, ...headers } });
      } catch (err) {
        if (i >= attempts) throw new DriveError(`Network error talking to Google Drive: ${err.message}`, 503);
        await sleep(500 * 2 ** i);
        continue;
      }
      if (res.status === 401 && i < attempts) {
        this.access = null; // token expired early; refresh and retry
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && i < attempts) {
        await sleep(500 * 2 ** i + Math.random() * 300);
        continue;
      }
      return res;
    }
  }

  async json(method, url, opts = {}) {
    const res = await this.request(method, url, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new DriveError(body.error?.message || res.statusText, res.status);
    return body;
  }

  async folder() {
    if (this.saved.folderId) {
      try {
        const f = await this.json('GET', `${API}/files/${this.saved.folderId}?fields=id,trashed`);
        if (!f.trashed) return f.id;
      } catch {
        // Deleted: make a new one below.
      }
    }
    const created = await this.json('POST', `${API}/files?fields=id`, {
      body: JSON.stringify({ name: this.folderName, mimeType: 'application/vnd.google-apps.folder' }),
      headers: { 'Content-Type': 'application/json' },
    });
    this.saved.folderId = created.id;
    await this.save();
    return created.id;
  }

  /**
   * Resumable upload of a file on disk or a Buffer. Uploads in 8 MiB pieces and resumes
   * from what Google already has after a network or server error.
   */
  async upload({ id, filePath, buffer, name, mimeType, parents }) {
    const handle = filePath ? await fs.open(filePath, 'r') : null;
    try {
      const size = handle ? (await handle.stat()).size : buffer.length;
      const init = await this.request('POST', `${UPLOAD_API}?uploadType=resumable&fields=id`, {
        body: JSON.stringify(id ? { id, name, mimeType, parents } : { name, mimeType, parents }),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) },
      });
      if (!init.ok) {
        const b = await init.json().catch(() => ({}));
        throw new DriveError(b.error?.message || init.statusText, init.status);
      }
      const session = init.headers.get('location');
      let offset = 0;
      let failures = 0;
      while (true) {
        const len = Math.min(CHUNK_BYTES, size - offset);
        let piece;
        if (handle) {
          piece = Buffer.alloc(len);
          await handle.read(piece, 0, len, offset);
        } else {
          piece = buffer.subarray(offset, offset + len);
        }
        let res;
        try {
          res = await fetch(session, {
            method: 'PUT',
            body: piece,
            headers: { 'Content-Range': len ? `bytes ${offset}-${offset + len - 1}/${size}` : `bytes */${size}` },
          });
        } catch {
          res = null;
        }
        if (res && (res.status === 200 || res.status === 201)) return (await res.json()).id;
        if (res && res.status === 308) {
          offset = nextOffset(res);
          failures = 0;
          continue;
        }
        if (res && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          const b = await res.json().catch(() => ({}));
          throw new DriveError(b.error?.message || `HTTP ${res.status}`, res.status);
        }
        // Network or server error: ask Google how much it has, then carry on from there.
        if (++failures > 6) throw new DriveError('Google Drive upload kept failing. Try again later.', 503);
        await sleep(1000 * 2 ** failures);
        const probe = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } }).catch(() => null);
        if (probe && (probe.status === 200 || probe.status === 201)) return (await probe.json()).id;
        if (probe && probe.status === 308) offset = nextOffset(probe);
      }
    } finally {
      await handle?.close();
    }
  }

  /** New content for an existing file (resumable, so large images are fine). */
  async replaceFile(fileId, filePath, mimeType) {
    const size = (await fs.stat(filePath)).size;
    const init = await this.request('PATCH', `${UPLOAD_API}/${fileId}?uploadType=resumable&fields=id`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) },
    });
    if (!init.ok) throw new DriveError(`Google Drive: could not update the file (${init.status})`, init.status);
    const res = await fetch(init.headers.get('location'), { method: 'PUT', body: await fs.readFile(filePath), headers: { 'Content-Range': `bytes 0-${size - 1}/${size}` } });
    if (!res.ok) throw new DriveError(`Google Drive: could not update the file (${res.status})`, res.status);
  }

  async shareWithAnyone(fileId) {
    await this.json('POST', `${API}/files/${fileId}/permissions?fields=id`, {
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async generateIds(count) {
    const r = await this.json('GET', `${API}/files/generateIds?count=${count}&space=drive&type=files`);
    return r.ids;
  }

  shareUrlFor(manifestId, videoId) {
    if (!this.viewerUrl) return `https://drive.google.com/file/d/${videoId}/view`;
    return `${this.viewerUrl}/?id=${encodeURIComponent(manifestId)}&v=${encodeURIComponent(videoId)}`;
  }

  /**
   * Reserve the share link when a recording starts: pre-generate the Drive ids and publish a
   * small "processing" manifest, so the public link works (and says "uploading") from the
   * first second instead of only after the upload finishes.
   */
  async reserve(record) {
    const parents = [await this.folder()];
    const [manifestId, videoId] = await this.generateIds(2);
    const placeholder = {
      app: 'bugsnap',
      version: MANIFEST_VERSION,
      status: 'processing',
      record: { id: record.id, createdAt: record.createdAt, meta: { title: record.meta?.title, reporter: record.meta?.reporter } },
      video: { id: videoId },
    };
    await this.upload({ id: manifestId, buffer: Buffer.from(JSON.stringify(placeholder)), name: fileName(record.meta?.title, record.id, 'json'), mimeType: 'application/json', parents });
    await this.shareWithAnyone(manifestId);
    return { manifestId, videoId, folderId: parents[0], shareUrl: this.shareUrlFor(manifestId, videoId) };
  }

  async exists(fileId) {
    const res = await this.request('GET', `${API}/files/${fileId}?fields=id,trashed`);
    if (res.status === 404) return false;
    const body = await res.json().catch(() => ({}));
    return res.ok && !body.trashed;
  }

  /** Everything the public player needs. Internal upload bookkeeping is left out. */
  async buildManifest({ record, events, videoId, posterPath }) {
    const { chunks, processing, drive, ...publicRecord } = record;
    let posterData = null;
    if (posterPath) {
      // Inline the small thumbnail so the player shows it without another request.
      const jpg = await fs.readFile(posterPath).catch(() => null);
      if (jpg && jpg.length < 200_000) posterData = `data:image/jpeg;base64,${jpg.toString('base64')}`;
    }
    return {
      app: 'bugsnap',
      version: MANIFEST_VERSION,
      status: 'ready',
      record: { ...publicRecord, status: 'ready', hasPoster: Boolean(posterData) },
      events,
      video: { id: videoId, mimeType: record.type === 'screenshot' ? 'image/png' : 'video/webm' },
      posterData,
    };
  }

  async replaceContent(fileId, buffer, mimeType) {
    return this.json('PATCH', `${UPLOAD_API}/${fileId}?uploadType=media&fields=id`, { body: buffer, headers: { 'Content-Type': mimeType } });
  }

  /** Re-publish the manifest after the title or description changed. */
  async refreshManifest({ record, events, posterPath }) {
    const { manifestId, videoId } = record.drive || {};
    if (!manifestId || !videoId) throw new DriveError('Recording is not on Drive yet', 409);
    const manifest = await this.buildManifest({ record, events, videoId, posterPath });
    await this.replaceContent(manifestId, Buffer.from(JSON.stringify(manifest)), 'application/json');
  }

  async deleteFiles(ids) {
    for (const fid of ids.filter(Boolean)) {
      const res = await this.request('DELETE', `${API}/files/${fid}`);
      if (!res.ok && res.status !== 404) throw new DriveError(`Could not delete a Drive file (${res.status})`, res.status);
    }
  }

  /** Upload one recording (into its reserved ids when it has them) and return the Drive ids and share link. */
  async publish({ record, events, videoPath, posterPath, reserved }) {
    const parents = [await this.folder()];
    const title = record.meta?.title;
    const isShot = record.type === 'screenshot';

    // A retry may find the media already uploaded under its reserved id. Screenshots use the
    // same slot for their PNG.
    let videoId = reserved?.videoId;
    if (isShot && videoId && (await this.exists(videoId))) {
      await this.replaceFile(videoId, videoPath, 'image/png');
    } else if (!videoId || !(await this.exists(videoId))) {
      videoId = await this.upload({
        id: videoId,
        filePath: videoPath,
        name: fileName(title, record.id, isShot ? 'png' : 'webm'),
        mimeType: isShot ? 'image/png' : 'video/webm',
        parents,
      });
    }
    await this.shareWithAnyone(videoId);

    const manifest = Buffer.from(JSON.stringify(await this.buildManifest({ record, events, videoId, posterPath })));
    let manifestId = reserved?.manifestId;
    if (manifestId && (await this.exists(manifestId))) {
      await this.replaceContent(manifestId, manifest, 'application/json');
    } else {
      manifestId = await this.upload({ id: manifestId, buffer: manifest, name: fileName(title, record.id, 'json'), mimeType: 'application/json', parents });
      await this.shareWithAnyone(manifestId);
    }
    return {
      manifestId,
      videoId,
      folderId: parents[0],
      shareUrl: this.shareUrlFor(manifestId, videoId),
      uploadedAt: new Date().toISOString(),
    };
  }
}

/** Next byte to send after a 308 "Resume Incomplete" (no Range header = nothing stored yet). */
function nextOffset(res) {
  const range = res.headers.get('range');
  const m = range && /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

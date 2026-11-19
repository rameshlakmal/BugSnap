// Offline test of the Google Drive publisher against a fake Google kept in memory.
// Covers: reserving the link up front, resumable upload with a dropped piece, publishing
// into the reserved ids, retry without re-uploading, manifest refresh and delete.
// Run: node test/drive-mock.js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Drive } from '../src/drive.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bugsnap-drive-'));
const video = path.join(dir, 'video.webm');
const poster = path.join(dir, 'poster.jpg');
const big = Buffer.alloc(20 * 1024 * 1024 + 12345, 7); // 3 pieces of 8 MiB
await fs.writeFile(video, big);
await fs.writeFile(poster, Buffer.from('jpeg-bytes'));

const files = new Map(); // id -> { meta, data }
const sessions = new Map();
const permissions = [];
let nextId = 1;
let dropped = false;
let videoUploads = 0;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const API = 'https://www.googleapis.com/drive/v3';

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const method = opts.method || 'GET';
  if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'tok', expires_in: 3600 });
  if (method !== 'PUT' && !String(opts.headers?.Authorization || '').startsWith('Bearer tok')) return json(401, { error: { message: 'no auth' } });

  if (url.startsWith(`${API}/files/generateIds`)) {
    const count = Number(new URL(url).searchParams.get('count'));
    return json(200, { ids: Array.from({ length: count }, () => `gen${nextId++}`) });
  }
  if (url.startsWith(`${API}/files?`) && method === 'POST') {
    const meta = JSON.parse(opts.body);
    const id = `f${nextId++}`;
    files.set(id, { meta, data: null });
    return json(200, { id });
  }
  const one = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([\w-]+)(\?|$)/.exec(url);
  if (one && method === 'GET') return files.has(one[1]) ? json(200, { id: one[1], trashed: false }) : json(404, { error: { message: 'not found' } });
  if (one && method === 'DELETE') return files.delete(one[1]) ? new Response(null, { status: 204 }) : json(404, { error: { message: 'not found' } });

  const patch = /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/([\w-]+)\?uploadType=media/.exec(url);
  if (patch && method === 'PATCH') {
    if (!files.has(patch[1])) return json(404, { error: { message: 'not found' } });
    files.get(patch[1]).data = Buffer.from(opts.body);
    return json(200, { id: patch[1] });
  }
  if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart') && method === 'POST') {
    // Strict parse: parts separated by CRLF, as Google expects.
    const boundary = /boundary=(\S+)/.exec(opts.headers['Content-Type'])[1];
    const text = Buffer.from(opts.body).toString('utf8');
    assert.ok(text.endsWith(`\r\n--${boundary}--`), 'multipart ends with the closing boundary');
    const parts = text.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
    assert.equal(parts.length, 2, 'metadata part + content part');
    const [, metaJson] = parts[0].split('\r\n\r\n');
    const meta = JSON.parse(metaJson);
    const data = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
    if (meta.id && files.has(meta.id)) return json(409, { error: { message: 'A file already exists with the provided ID.' } });
    const id = meta.id || `f${nextId++}`;
    files.set(id, { meta, data: Buffer.from(data) });
    return json(200, { id });
  }
  if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
    const meta = JSON.parse(opts.body);
    if (meta.id && files.has(meta.id)) return json(409, { error: { message: 'A file already exists with the provided ID.' } });
    if (meta.mimeType === 'video/webm') videoUploads++;
    const session = `https://upload.example/session/${nextId++}`;
    sessions.set(session, { meta, size: Number(opts.headers['X-Upload-Content-Length']), bytes: 0, parts: [] });
    return new Response(null, { status: 200, headers: { Location: session } });
  }
  if (sessions.has(url) && method === 'PUT') {
    const s = sessions.get(url);
    const range = opts.headers['Content-Range'];
    const status = () => (s.bytes ? new Response(null, { status: 308, headers: { Range: `bytes=0-${s.bytes - 1}` } }) : new Response(null, { status: 308 }));
    if (range.startsWith('bytes */')) return s.doneId ? json(200, { id: s.doneId }) : status();
    const start = Number(/bytes (\d+)-/.exec(range)[1]);
    if (s.size === big.length && start > 0 && !dropped) {
      dropped = true; // the connection dies once mid-upload
      throw new TypeError('fetch failed');
    }
    assert.equal(start, s.bytes, 'piece starts where the last one ended');
    s.parts.push(Buffer.from(opts.body));
    s.bytes += opts.body.length;
    if (s.bytes < s.size) return status();
    const id = s.meta.id || `f${nextId++}`;
    s.doneId = id;
    files.set(id, { meta: s.meta, data: Buffer.concat(s.parts) });
    return json(200, { id });
  }
  const perm = /\/files\/([\w-]+)\/permissions(?:\/([\w-]+))?/.exec(url);
  if (perm && method === 'GET') {
    return json(200, { permissions: permissions.filter((p) => p.id === perm[1]).map((p, i) => ({ id: `${p.id}-perm${i}`, type: p.type })) });
  }
  if (perm && method === 'DELETE') {
    const at = permissions.findIndex((p, i) => p.id === perm[1] && perm[2] === `${p.id}-perm${permissions.filter((q, j) => q.id === p.id && j < i).length}`);
    if (at >= 0) permissions.splice(at, 1);
    return new Response(null, { status: 204 });
  }
  if (perm) {
    permissions.push({ id: perm[1], ...JSON.parse(opts.body) });
    return json(200, { id: 'p' });
  }
  return json(404, { error: { message: `unexpected ${method} ${url}` } });
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a);

const drive = new Drive({ clientId: 'cid', clientSecret: 'secret', dataDir: dir, port: 4800, viewerUrl: 'https://me.github.io/bugsnap-viewer/' });
drive.saved = { refreshToken: 'refresh', folderId: null };

const record = { id: 'AbCdEf1234', createdAt: '2026-11-07T10:00:00Z', meta: { title: 'Checkout: fails / "Pricing"', reporter: 'Jane' }, startedAt: 1, durationMs: 5000, chunks: 9, processing: {}, drive: {} };
const events = [{ type: 'action', ts: 2, text: 'Clicks the "Buy" button' }];

// 1. Reserve at start: link exists before any upload.
const reserved = await drive.reserve(record);
assert.ok(reserved.manifestId && reserved.videoId, 'ids reserved');
assert.equal(reserved.shareUrl, `https://me.github.io/bugsnap-viewer/?id=${reserved.manifestId}&v=${reserved.videoId}`);
const placeholder = JSON.parse(files.get(reserved.manifestId).data);
assert.equal(placeholder.status, 'processing', 'placeholder says processing');
assert.equal(placeholder.record.meta.title, record.meta.title);
assert.ok(permissions.some((p) => p.id === reserved.manifestId && p.type === 'anyone'), 'placeholder shared');
const folder = [...files.values()].find((f) => f.meta.mimeType === 'application/vnd.google-apps.folder');
assert.equal(folder.meta.name, 'BugSnap');

// 2. Publish into the reserved ids (with one dropped upload piece).
const result = await drive.publish({ record, events, videoPath: video, posterPath: poster, reserved });
assert.ok(dropped, 'a dropped piece was simulated');
assert.equal(result.videoId, reserved.videoId, 'video uses the reserved id');
assert.equal(result.manifestId, reserved.manifestId, 'manifest keeps the reserved id');
assert.equal(result.shareUrl, reserved.shareUrl, 'share link unchanged');
assert.ok(files.get(reserved.videoId).data.equals(big), 'video bytes intact after resume');
assert.equal(files.get(reserved.videoId).meta.name, 'Checkout fails Pricing (AbCdEf1234).webm');
const manifest = JSON.parse(files.get(reserved.manifestId).data);
assert.equal(manifest.status, 'ready');
assert.equal(manifest.app, 'bugsnap');
assert.equal(manifest.video.id, reserved.videoId);
assert.ok(manifest.posterData.startsWith('data:image/jpeg;base64,'), 'thumbnail inlined');
assert.equal(manifest.record.chunks, undefined, 'internal fields left out');
assert.equal(manifest.record.drive, undefined);
assert.ok(permissions.some((p) => p.id === reserved.videoId), 'video shared');

// 3. Retry after success does not upload the video again.
const uploadsBefore = videoUploads;
await drive.publish({ record, events, videoPath: video, posterPath: poster, reserved });
assert.equal(videoUploads, uploadsBefore, 'existing video reused on retry');

// 4. Title edit republishes the manifest.
await drive.refreshManifest({ record: { ...record, meta: { ...record.meta, title: 'New title' }, drive: result }, events, posterPath: poster });
assert.equal(JSON.parse(files.get(reserved.manifestId).data).record.meta.title, 'New title');

// 5. Without a reservation it still works (recordings made before connecting).
const plain = await drive.publish({ record: { ...record, id: 'Second1234' }, events, videoPath: poster, posterPath: null });
assert.ok(files.has(plain.manifestId) && files.has(plain.videoId));
const folders = [...files.values()].filter((f) => f.meta.mimeType === 'application/vnd.google-apps.folder').length;
assert.equal(folders, 1, 'folder reused');

// 6. Screenshots: first publish uploads into the reserved ids; an edit replaces the PNG in place
//    with few requests (no folder or exists checks, no second share).
const shot = { ...record, id: 'Shot123456', type: 'screenshot' };
const shotPng = path.join(dir, 'shot.png');
await fs.writeFile(shotPng, Buffer.from('png-v1'));
const shotIds = await drive.reserve(shot);
await drive.publish({ record: shot, events: [], videoPath: shotPng, posterPath: null, reserved: shotIds });
assert.equal(String(files.get(shotIds.videoId).data), 'png-v1', 'screenshot uploaded into its reserved id');
await fs.writeFile(shotPng, Buffer.from('png-v2'));
let calls = 0;
const counted = globalThis.fetch;
globalThis.fetch = (u, o) => (String(u).includes('oauth2') || calls++, counted(u, o));
const again = await drive.publish({ record: { ...shot, meta: { ...shot.meta, title: 'Edited' } }, events: [], videoPath: shotPng, posterPath: null, reserved: shotIds });
globalThis.fetch = counted;
assert.equal(again.videoId, shotIds.videoId, 'same link after an edit');
assert.equal(String(files.get(shotIds.videoId).data), 'png-v2', 'edited image replaced in place');
assert.equal(JSON.parse(files.get(shotIds.manifestId).data).record.meta.title, 'Edited');
assert.equal(calls, 2, `an edited screenshot republishes with 2 requests (was 7), got ${calls}`);
// A deleted file on Drive is uploaded again instead of failing.
files.delete(shotIds.videoId);
await drive.publish({ record: shot, events: [], videoPath: shotPng, posterPath: null, reserved: shotIds });
assert.equal(String(files.get(shotIds.videoId).data), 'png-v2', 'missing screenshot uploaded again');

// 7. Share links leave out private details; bodies only when the setting allows.
const withPrivate = { ...record, id: 'Priv123456', github: [{ number: 9, repo: 'me/secret-repo' }], folderId: 'fold1' };
const netEvents = [{ type: 'network', ts: 3, url: 'https://api.example/users', requestBody: '{"q":1}', responseBody: '[{"email":"a@b.c"}]' }];
let m = await drive.buildManifest({ record: withPrivate, events: netEvents, videoId: 'v1', posterPath: null });
assert.equal(m.record.github, undefined, 'GitHub issues not in share links');
assert.equal(m.record.folderId, undefined, 'folder not in share links');
assert.equal(m.events[0].responseBody, '[{"email":"a@b.c"}]', 'bodies kept by default');
assert.equal(m.bodiesHidden, undefined);
drive.shareBodies = false;
m = await drive.buildManifest({ record: withPrivate, events: netEvents, videoId: 'v1', posterPath: null });
assert.equal(m.events[0].responseBody, undefined, 'response body left out when switched off');
assert.equal(m.events[0].requestBody, undefined, 'request body left out when switched off');
assert.equal(m.events[0].url, 'https://api.example/users', 'the request itself is still listed');
assert.equal(m.bodiesHidden, true);
assert.equal(netEvents[0].responseBody, '[{"email":"a@b.c"}]', 'the local copy is untouched');
drive.shareBodies = true;

// 8. Stop sharing removes "anyone with the link"; republishing keeps it private; share again restores it.
const anyone = (fid) => permissions.some((p) => p.id === fid && p.type === 'anyone');
assert.ok(anyone(shotIds.videoId) && anyone(shotIds.manifestId), 'shared to begin with');
await drive.unshare([shotIds.videoId, shotIds.manifestId]);
assert.ok(!anyone(shotIds.videoId) && !anyone(shotIds.manifestId), 'no longer shared');
await drive.publish({ record: { ...shot, drive: { unshared: true } }, events: [], videoPath: shotPng, posterPath: null, reserved: shotIds });
assert.ok(!anyone(shotIds.videoId) && !anyone(shotIds.manifestId), 'an edit does not share it again');
await drive.reshare([shotIds.videoId, shotIds.manifestId]);
assert.ok(anyone(shotIds.videoId) && anyone(shotIds.manifestId), 'shared again');

// 9. Delete removes the files.
await drive.deleteFiles([reserved.manifestId, reserved.videoId]);
assert.ok(!files.has(reserved.manifestId) && !files.has(reserved.videoId), 'files deleted');

console.log('drive: ok (reserve, resume, publish into reserved ids, retry, refresh, delete)');
await fs.rm(dir, { recursive: true, force: true });

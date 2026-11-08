// End-to-end check of the server: create, upload chunks, finalize, process, stream.
// Usage: start the server, then `npm run smoke` (needs ffmpeg to generate a test video).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:4800';
const TOKEN = process.env.UPLOAD_TOKEN || '';
const headers = TOKEN ? { 'X-Upload-Token': TOKEN } : {};

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok  - ${msg}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenrec-smoke-'));
const videoPath = path.join(tmp, 'test.webm');
const gen = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
  '-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8',
  '-c:a', 'libopus', '-shortest', videoPath,
]);
assert(gen.status === 0, `generated test video (${gen.stderr?.toString().trim() || 'ffmpeg ok'})`);
const bytes = fs.readFileSync(videoPath);

const t0 = Date.now();
const created = await fetch(`${BASE}/api/recordings`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    meta: {
      mode: 'tab',
      title: 'Pricing – Example',
      startUrl: 'https://example.com/',
      reporter: 'Smoke test',
      window: { width: 1440, height: 900, state: 'normal' },
      viewport: { width: 1440, height: 789 },
      devicePixelRatio: 1,
      platform: { os: 'win', arch: 'x86-64' },
      env: { os: 'Windows 11', browser: 'Google Chrome 142.0.0.0', timeZone: 'Asia/Colombo', utcOffsetMinutes: 330, language: 'en-US' },
    },
  }),
}).then((r) => r.json());
assert(/^[0-9A-Za-z]{10}$/.test(created.id), `created recording ${created.id}`);

const CHUNK = 64 * 1024;
let index = 0;
for (let off = 0; off < bytes.length; off += CHUNK, index++) {
  const res = await fetch(`${BASE}/api/recordings/${created.id}/chunks/${index}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: bytes.subarray(off, off + CHUNK),
  });
  if (!res.ok) assert(false, `chunk ${index} upload: ${res.status}`);
}
assert(true, `uploaded ${index} chunks (${bytes.length} bytes)`);

const outOfOrder = await fetch(`${BASE}/api/recordings/${created.id}/chunks/${index + 5}`, { method: 'PUT', headers, body: Buffer.from('x') });
assert(outOfOrder.status === 409, 'out-of-order chunk rejected with 409');

const at = (s) => t0 + s * 1000;
const events = [
  { type: 'navigation', ts: at(0), url: 'https://example.com/', title: 'Example', transition: 'start', text: 'Starts on the "Example" page' },
  { type: 'action', ts: at(1.5), action: 'click', text: 'Clicks the "Pricing" link', role: 'link', name: 'Pricing', selector: 'nav > a:nth-of-type(2)' },
  { type: 'navigation', ts: at(2), url: 'https://example.com/pricing', title: 'Pricing – Example', transition: 'link', text: 'Navigates to the "Pricing – Example" page' },
  { type: 'action', ts: at(4), action: 'input', text: 'Types "ramesh@example.com" into the "Email" field', role: 'field', name: 'Email', selector: '#email' },
  { type: 'action', ts: at(5), action: 'click', text: 'Clicks the "Start trial" button', role: 'button', name: 'Start trial', selector: 'form > button' },
  { type: 'network', ts: at(5.6), startedAt: at(5.1), via: 'fetch', method: 'POST', url: 'https://api.example.com/trials', status: 500, statusText: 'Internal Server Error', durationMs: 480, responseBody: '{"error":"plan_id missing"}' },
  { type: 'console', ts: at(5.7), level: 'error', message: 'TypeError: Cannot read properties of undefined (reading \'id\')', source: 'https://example.com/app.js:120:14' },
  { type: 'network', ts: at(1.2), startedAt: at(1.0), via: 'fetch', method: 'GET', url: 'https://api.example.com/plans', status: 200, durationMs: 120, contentType: 'application/json' },
  { type: 'console', ts: at(3), level: 'warn', message: 'Deprecated API used: plans.v1' },
];
const fin = await fetch(`${BASE}/api/recordings/${created.id}/finalize`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    events,
    pauses: [{ start: at(6), end: at(8) }, { start: 'bad', end: 1 }],
    startedAt: t0,
    endedAt: at(14),
    durationMs: 12000,
    mimeType: 'video/webm;codecs=vp9,opus',
    env: { location: { latitude: 6.9271, longitude: 79.8612, accuracyM: 30 } },
  }),
});
assert(fin.ok, 'finalized');

let rec;
for (let i = 0; i < 40; i++) {
  rec = await fetch(`${BASE}/api/recordings/${created.id}`).then((r) => r.json());
  if (rec.status === 'ready') break;
  await new Promise((r) => setTimeout(r, 250));
}
assert(rec.status === 'ready', `processed (remuxed: ${rec.processing?.remuxed}, poster: ${rec.processing?.poster})`);
assert(rec.events.length === events.length, `events stored (${rec.events.length})`);
assert(rec.eventCounts.consoleErrors === 1 && rec.eventCounts.networkErrors === 1, 'error counts computed');

const ranged = await fetch(`${BASE}/api/recordings/${created.id}/video`, { headers: { Range: 'bytes=0-1023' } });
assert(ranged.status === 206, `video supports range requests (${ranged.headers.get('content-range')})`);

const page = await fetch(`${BASE}/r/${created.id}`);
assert(page.ok && (await page.text()).includes('viewer.js'), 'viewer page served');

assert(rec.pauses.length === 1 && rec.pauses[0].end - rec.pauses[0].start === 2000, 'valid pauses stored, invalid ones dropped');

for (const asset of ['/tokens.css', '/viewer.css', '/viewer.js', '/icons.js', '/fonts/figtree.woff2', '/fonts/geist-mono.woff2', '/library.js', '/library.css']) {
  const r = await fetch(`${BASE}${asset}`);
  if (!r.ok) assert(false, `asset ${asset} served`);
}
assert(true, 'viewer assets served (css, js, icons, fonts)');

const bad = await fetch(`${BASE}/api/recordings/..%2F..%2Fetc`);
assert(bad.status === 404, 'invalid ids rejected');

// Discard flow: create then DELETE
const throwaway = await fetch(`${BASE}/api/recordings`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"meta":{}}' }).then((r) => r.json());
const del = await fetch(`${BASE}/api/recordings/${throwaway.id}`, { method: 'DELETE', headers });
const gone = await fetch(`${BASE}/api/recordings/${throwaway.id}`);
assert(del.status === 204 && gone.status === 404, 'discarded recording is deleted');

console.log(`\nViewer: ${created.viewerUrl}`);
fs.rmSync(tmp, { recursive: true, force: true });

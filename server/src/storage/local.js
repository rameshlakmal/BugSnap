import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';

export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.status = 409;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Recording not found') {
    super(message);
    this.status = 404;
  }
}

/**
 * Local storage: one folder per recording on disk. Finished recordings are also
 * published to Google Drive (see drive.js); these files stay as the working copy.
 *
 *   <dataDir>/<id>/record.json   status + metadata
 *   <dataDir>/<id>/video.raw.webm chunks appended as they arrive
 *   <dataDir>/<id>/video.webm     remuxed (seekable) copy, after processing
 *   <dataDir>/<id>/events.json    actions, console, network, navigation
 *   <dataDir>/<id>/poster.jpg     thumbnail
 *
 *   <dataDir>/google-drive.json  Drive sign-in (refresh token) and folder id
 */
export class LocalStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  dir(id) {
    return path.join(this.dataDir, id);
  }

  file(id, name) {
    return path.join(this.dir(id), name);
  }

  /** Serialise writes per recording so chunk appends never interleave. */
  async withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    this.locks.set(id, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  async create(id, meta) {
    await fs.mkdir(this.dir(id), { recursive: true });
    const record = {
      id,
      status: 'recording',
      createdAt: new Date().toISOString(),
      chunks: 0,
      bytes: 0,
      meta: meta || {},
    };
    await this.writeRecord(record);
    return record;
  }

  async get(id) {
    try {
      const raw = await fs.readFile(this.file(id, 'record.json'), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') throw new NotFoundError();
      throw err;
    }
  }

  async writeRecord(record) {
    record.updatedAt = new Date().toISOString();
    const tmp = this.file(record.id, 'record.json.tmp');
    await fs.writeFile(tmp, JSON.stringify(record, null, 2));
    await fs.rename(tmp, this.file(record.id, 'record.json'));
  }

  async update(id, patch) {
    return this.withLock(id, async () => {
      const record = { ...(await this.get(id)), ...patch };
      await this.writeRecord(record);
      return record;
    });
  }

  /** Read, change and write a record under its lock (for nested fields like `drive`). */
  async updateWith(id, fn) {
    return this.withLock(id, async () => {
      const record = await this.get(id);
      fn(record);
      await this.writeRecord(record);
      return record;
    });
  }

  async appendChunk(id, index, buffer) {
    return this.withLock(id, async () => {
      const record = await this.get(id);
      if (record.status !== 'recording') {
        throw new ConflictError('Recording is no longer accepting chunks', { status: record.status });
      }
      if (index < record.chunks) {
        // Duplicate retry of a chunk we already have: acknowledge without writing.
        return record;
      }
      if (index !== record.chunks) {
        throw new ConflictError('Chunk out of order', { expected: record.chunks, got: index });
      }
      await new Promise((resolve, reject) => {
        const ws = createWriteStream(this.file(id, 'video.raw.webm'), { flags: 'a' });
        ws.on('error', reject);
        ws.end(buffer, resolve);
      });
      record.chunks += 1;
      record.bytes += buffer.length;
      await this.writeRecord(record);
      return record;
    });
  }

  async remove(id) {
    return this.withLock(id, async () => {
      await this.get(id); // 404 if unknown
      await fs.rm(this.dir(id), { recursive: true, force: true });
    });
  }

  /** Delete uploads that never finished (browser crashed, recorder window closed). */
  async sweepAbandoned(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const removed = [];
    for (const r of await this.list()) {
      const touched = Date.parse(r.updatedAt || r.createdAt);
      if (r.status === 'recording' && touched < cutoff) {
        await this.remove(r.id).catch(() => {});
        removed.push(r.id);
      }
    }
    return removed;
  }

  async finalize(id, { events, pauses, startedAt, endedAt, durationMs, mimeType, env }) {
    await fs.writeFile(this.file(id, 'events.json'), JSON.stringify(events || []));
    return this.withLock(id, async () => {
      const record = await this.get(id);
      record.status = 'processing';
      record.startedAt = startedAt;
      record.endedAt = endedAt;
      record.durationMs = durationMs;
      record.mimeType = mimeType;
      record.pauses = Array.isArray(pauses) ? pauses : [];
      record.meta = { ...record.meta, env: { ...(record.meta.env || {}), ...(env || {}) } };
      record.eventCounts = countEvents(events || []);
      await this.writeRecord(record);
      return record;
    });
  }

  async getEvents(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id, 'events.json'), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Path of the best available video file, or null. */
  videoPath(id) {
    const processed = this.file(id, 'video.webm');
    if (existsSync(processed)) return processed;
    const raw = this.file(id, 'video.raw.webm');
    return existsSync(raw) ? raw : null;
  }

  posterPath(id) {
    const p = this.file(id, 'poster.jpg');
    if (existsSync(p)) return p;
    const img = this.file(id, 'image.png'); // screenshots without ffmpeg use the image itself
    return existsSync(img) ? img : null;
  }

  /** Screenshot image (annotated PNG), or null. */
  imagePath(id) {
    const p = this.file(id, 'image.png');
    return existsSync(p) ? p : null;
  }

  async writeImage(id, buffer) {
    await this.get(id); // 404 if unknown
    await fs.writeFile(this.file(id, 'image.png'), buffer);
  }

  async list() {
    const entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    const records = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        records.push(await this.get(e.name));
      } catch {
        /* skip half-written folders */
      }
    }
    return records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
}

function countEvents(events) {
  const counts = { action: 0, navigation: 0, console: 0, consoleErrors: 0, network: 0, networkErrors: 0 };
  for (const e of events) {
    if (e.type in counts) counts[e.type] += 1;
    if (e.type === 'console' && e.level === 'error') counts.consoleErrors += 1;
    if (e.type === 'network' && (e.status === 0 || e.status >= 400)) counts.networkErrors += 1;
  }
  return counts;
}

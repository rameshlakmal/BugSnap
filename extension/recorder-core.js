// Shared recording engine, used by the offscreen document (tab mode) and the
// recorder window (desktop mode). It owns the MediaStream, uploads video chunks
// to the server while recording, collects events, and finalises the recording.
//
// Lifecycle: prepare() -> [countdown in the UI] -> begin() -> pause()/resume() -> stop() | discard()

const CHUNK_MS = 4000;
const MAX_DURATION_MS = 30 * 60 * 1000;
const MAX_EVENTS = 20000;
const MAX_EVENT_BYTES = 20 * 1024 * 1024; // stays well under the server's 50 MB finalize limit

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function getTabStream(streamId) {
  const constraints = (kind) => ({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, ...(kind === 'video' ? { maxFrameRate: 30 } : {}) } });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints('audio'), video: constraints('video') });
  let audioContext = null;
  // Capturing a tab mutes it for the user; route the audio back to the speakers.
  if (stream.getAudioTracks().length) {
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
  }
  return { stream, audioContext };
}

/** @param {'monitor'|'window'|'browser'} surface preselects that pane in Chrome's picker */
async function getDisplayStream(surface, includeAudio) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: surface, frameRate: { ideal: 30, max: 30 } },
    audio: includeAudio,
    selfBrowserSurface: 'exclude',
    systemAudio: includeAudio ? 'include' : 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
  return { stream, audioContext: null };
}

export async function collectEnvironment({ captureLocation }) {
  const env = {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: navigator.deviceMemory,
    connection: navigator.connection ? { effectiveType: navigator.connection.effectiveType, downlinkMbps: navigator.connection.downlink } : undefined,
  };
  try {
    const ua = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']);
    env.os = describeOs(ua.platform, ua.platformVersion);
    env.osVersion = ua.platformVersion;
    env.architecture = [ua.architecture, ua.bitness && `${ua.bitness}-bit`].filter(Boolean).join(' ');
    env.browser = describeBrowser(ua.fullVersionList || []);
  } catch {
    /* userAgentData not available */
  }
  if (captureLocation) env.location = await getLocation();
  return env;
}

function describeOs(platform, version) {
  const major = parseInt(version || '0', 10);
  if (platform === 'Windows') {
    // platformVersion 13+ means Windows 11; the plain user agent always says "Windows NT 10.0".
    if (major >= 13) return 'Windows 11';
    if (major > 0) return 'Windows 10';
    return 'Windows 7/8';
  }
  if (platform === 'macOS') return `macOS ${version}`;
  return [platform, version].filter(Boolean).join(' ');
}

function describeBrowser(brands) {
  const preferred = ['Microsoft Edge', 'Google Chrome', 'Brave', 'Opera', 'Vivaldi', 'Chromium'];
  for (const name of preferred) {
    const b = brands.find((x) => x.brand === name);
    if (b) return `${b.brand} ${b.version}`;
  }
  const other = brands.find((x) => !/not.?a.?brand/i.test(x.brand));
  return other ? `${other.brand} ${other.version}` : undefined;
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: Number(p.coords.latitude.toFixed(4)),
          longitude: Number(p.coords.longitude.toFixed(4)),
          accuracyM: Math.round(p.coords.accuracy),
        }),
      (err) => resolve({ error: err.message || 'denied' }),
      { timeout: 6000, maximumAge: 10 * 60 * 1000 },
    );
  });
}


export class Recorder {
  constructor({ serverUrl, uploadToken, onAutoStop, onUploadFailed }) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.uploadToken = uploadToken;
    // Called when capture ends without the user pressing Stop (Chrome's share bar, time limit, tab closed).
    this.onAutoStop = onAutoStop || (() => this.stop());
    // Called once if video upload fails for good, so the user learns now rather than at Stop.
    this.onUploadFailed = onUploadFailed || (() => {});
    this.events = [];
    this.eventBytes = 0;
    this.pauses = [];
    this.chunkIndex = 0;
    this.queue = Promise.resolve();
    this.uploadError = null;
    this.state = 'idle'; // idle | prepared | recording | paused | stopping | done | discarded
  }

  async api(method, path, body, headers = {}) {
    const res = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: { ...(this.uploadToken ? { 'X-Upload-Token': this.uploadToken } : {}), ...headers },
      body,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch {
        /* not json */
      }
      const err = new Error(`${method} ${path} failed: ${res.status} ${detail}`.trim());
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  /**
   * Acquire the stream and create the server-side recording. Nothing is recorded yet.
   * @param {{mode:'tab'|'desktop', streamId?:string, surface?:string, includeAudio?:boolean, meta:object, captureLocation:boolean}} opts
   */
  async prepare({ mode, streamId, surface = 'monitor', includeAudio = true, meta, captureLocation }) {
    const acquired = mode === 'tab' ? await getTabStream(streamId) : await getDisplayStream(surface, includeAudio);
    this.stream = acquired.stream;
    this.audioContext = acquired.audioContext;
    try {
      const video = this.stream.getVideoTracks()[0];
      const settings = video ? video.getSettings() : {};
      const env = await collectEnvironment({ captureLocation });
      this.env = { ...env, captureSize: { width: settings.width, height: settings.height }, displaySurface: settings.displaySurface };

      const created = await this.api('POST', '/api/recordings', JSON.stringify({ meta: { ...meta, env: this.env } }), { 'Content-Type': 'application/json' });
      this.id = created.id;
      this.viewerUrl = created.viewerUrl;

      // The user can end capture from Chrome's own "Stop sharing" bar, or close the tab.
      if (video) video.addEventListener('ended', () => this.onAutoStop());
      this.state = 'prepared';
      return { id: this.id, viewerUrl: this.viewerUrl, displaySurface: settings.displaySurface };
    } catch (err) {
      this.release();
      throw err;
    }
  }

  begin() {
    if (this.state !== 'prepared') return null;
    this.mimeType = pickMimeType();
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.mimeType || undefined, videoBitsPerSecond: 3_000_000 });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && this.state !== 'discarded') this.enqueue(e.data);
    };
    this.stopped = new Promise((resolve) => (this.mediaRecorder.onstop = resolve));
    this.mediaRecorder.start(CHUNK_MS);
    this.startedAt = Date.now();
    this.maxTimer = setTimeout(() => this.onAutoStop(), MAX_DURATION_MS);
    this.state = 'recording';
    return { startedAt: this.startedAt };
  }

  pause() {
    if (this.state !== 'recording') return null;
    this.mediaRecorder.pause();
    this.pausedAt = Date.now();
    this.state = 'paused';
    return { pausedAt: this.pausedAt };
  }

  resume() {
    if (this.state !== 'paused') return null;
    this.mediaRecorder.resume();
    this.pauses.push({ start: this.pausedAt, end: Date.now() });
    this.pausedAt = null;
    this.state = 'recording';
    return { pausedMs: this.totalPausedMs() };
  }

  totalPausedMs() {
    return this.pauses.reduce((sum, p) => sum + (p.end - p.start), 0);
  }

  addEvents(events) {
    // While paused or stopping, batches still arrive that were captured just before;
    // keep only events from before that moment (paused moments are not in the video).
    let cutoff = Infinity;
    if (this.state === 'paused') cutoff = this.pausedAt;
    else if (this.state === 'stopping') cutoff = this.stopRequestedAt;
    else if (this.state !== 'recording' && this.state !== 'prepared') return;
    for (const ev of events) {
      if (!(ev.ts < cutoff)) continue;
      if (this.events.length >= MAX_EVENTS) return;
      const size = JSON.stringify(ev).length;
      if (this.eventBytes + size > MAX_EVENT_BYTES) return;
      this.eventBytes += size;
      this.events.push(ev);
    }
  }

  enqueue(blob) {
    const index = this.chunkIndex++;
    this.queue = this.queue.then(() => this.uploadChunk(blob, index));
  }

  async uploadChunk(blob, index) {
    if (this.uploadError) return;
    // Up to ~1 minute of retries per chunk rides out brief network or server blips.
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this.api('PUT', `/api/recordings/${this.id}/chunks/${index}`, blob, { 'Content-Type': 'application/octet-stream' });
        return;
      } catch (err) {
        const permanent = err.status && err.status < 500 && err.status !== 408 && err.status !== 429;
        if (attempt === 8 || permanent) {
          this.uploadError = err;
          this.onUploadFailed(err);
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(15000, 500 * 2 ** attempt)));
      }
    }
  }

  /** Retries transient failures (network, 5xx, 408, 429) with backoff, about 30 s in total. */
  async withRetry(fn, attempts = 6) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const permanent = err.status && err.status < 500 && err.status !== 408 && err.status !== 429;
        if (attempt >= attempts || permanent) throw err;
        await new Promise((r) => setTimeout(r, Math.min(10000, 500 * 2 ** attempt)));
      }
    }
  }

  release() {
    clearTimeout(this.maxTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  /** Stops capture, waits for uploads, finalises. Safe to call more than once. */
  stop() {
    if (this.finishing) return this.finishing;
    if (this.state !== 'recording' && this.state !== 'paused') return Promise.resolve(null);
    if (this.state === 'paused') this.pauses.push({ start: this.pausedAt, end: Date.now() });
    this.stopRequestedAt = this.state === 'paused' ? this.pausedAt : Date.now();
    this.state = 'stopping';
    this.finishing = (async () => {
      if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      await this.stopped;
      this.release();
      const endedAt = Date.now();
      await this.queue;
      if (this.uploadError) throw this.uploadError;
      // Give late event batches (flushed by pages at the moment of Stop) a moment to arrive.
      await new Promise((r) => setTimeout(r, 400));
      const result = await this.withRetry(() => this.api(
        'POST',
        `/api/recordings/${this.id}/finalize`,
        JSON.stringify({
          // Drop anything captured before capture began (e.g. during the countdown).
          events: this.events.filter((e) => e.ts >= this.startedAt - 500).sort((a, b) => a.ts - b.ts),
          pauses: this.pauses,
          startedAt: this.startedAt,
          endedAt,
          durationMs: endedAt - this.startedAt - this.totalPausedMs(),
          mimeType: this.mimeType,
          env: this.env,
        }),
        { 'Content-Type': 'application/json' },
      ));
      this.state = 'done';
      return { id: this.id, viewerUrl: result?.viewerUrl || this.viewerUrl, durationMs: endedAt - this.startedAt - this.totalPausedMs() };
    })();
    return this.finishing;
  }

  /** Throws the recording away, locally and on the server. */
  async discard() {
    if (this.state === 'done' || this.state === 'discarded') return;
    this.state = 'discarded';
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    this.release();
    if (this.id) await this.api('DELETE', `/api/recordings/${this.id}`).catch(() => {});
  }
}

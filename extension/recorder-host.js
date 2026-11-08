// Glue between the background service worker and a Recorder instance.
// Used by both offscreen.html (tab mode) and recorder.html (desktop mode).
import { Recorder } from './recorder-core.js';

const COUNTDOWN_MS = 3000;

export async function connectRecorder({ kind, onUi = () => {} }) {
  // The background replies {ok, result}; result is the pending recording request.
  const reply = await chrome.runtime.sendMessage({ type: 'recorder:hello', kind });
  const config = reply && reply.result;
  if (!config) throw new Error('No pending recording request');

  const notify = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  let countdownTimer = null;
  let cancelCountdown = null;

  const recorder = new Recorder({
    serverUrl: config.settings.serverUrl,
    uploadToken: config.settings.uploadToken,
    onAutoStop: () => finish(),
    onUploadFailed: async (err) => {
      // Don't let someone keep recording into the void: stop now and say why.
      await recorder.discard();
      fail(new Error(`Upload failed, so recording stopped. (${err.message})`));
    },
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'recorder') return;
    switch (msg.type) {
      case 'events':
        recorder.addEvents(msg.events);
        break;
      case 'pause': {
        const r = recorder.pause();
        if (r) {
          notify('recorder:paused', r);
          onUi('paused', r);
        }
        break;
      }
      case 'resume': {
        const r = recorder.resume();
        if (r) {
          notify('recorder:resumed', r);
          onUi('recording', { startedAt: recorder.startedAt, pausedMs: r.pausedMs });
        }
        break;
      }
      case 'stop':
        finish();
        break;
      case 'discard':
        discard();
        break;
    }
  });

  async function finish() {
    if (recorder.state === 'prepared') return discard(); // stopped during the countdown
    if (recorder.state !== 'recording' && recorder.state !== 'paused') return;
    try {
      notify('recorder:stopping');
      onUi('stopping');
      const result = await recorder.stop();
      if (result) {
        onUi('done', result);
        await notify('recorder:done', result);
      }
    } catch (err) {
      fail(err);
    }
  }

  async function discard() {
    clearTimeout(countdownTimer);
    cancelCountdown?.();
    await recorder.discard();
    onUi('discarded');
    notify('recorder:discarded');
  }

  function fail(err) {
    recorder.release();
    let message = err && err.message ? err.message : String(err);
    if (err && err.name === 'NotAllowedError') message = 'Screen access was blocked.';
    if (err instanceof TypeError && /fetch/i.test(message)) message = `Can't reach the server (${config.settings.serverUrl}). Check Settings.`;
    onUi('error', { message });
    notify('recorder:error', { message });
  }

  /** @param {{surface?:string, includeAudio?:boolean}} options desktop-mode choices from the recorder window */
  async function start(options = {}) {
    try {
      const prepared = await recorder.prepare({
        mode: config.mode,
        streamId: config.streamId,
        surface: options.surface,
        includeAudio: options.includeAudio !== false,
        meta: config.meta,
        captureLocation: config.settings.captureLocation,
      });
      const endsAt = Date.now() + COUNTDOWN_MS;
      notify('recorder:countdown', { ...prepared, endsAt });
      onUi('countdown', { endsAt });
      const proceed = await new Promise((resolve) => {
        cancelCountdown = () => resolve(false);
        // A short grace period lets the page overlay remove the countdown before frames are kept.
        countdownTimer = setTimeout(() => resolve(true), COUNTDOWN_MS + 250);
      });
      cancelCountdown = null;
      if (!proceed || recorder.state !== 'prepared') return;
      const begun = recorder.begin();
      onUi('recording', { startedAt: begun.startedAt, pausedMs: 0 });
      await notify('recorder:started', { id: recorder.id, viewerUrl: recorder.viewerUrl, startedAt: begun.startedAt });
    } catch (err) {
      // Closing Chrome's picker is not an error: stay on the choice screen so the user can retry.
      if (err && err.name === 'NotAllowedError' && config.mode === 'desktop') {
        onUi('error', { message: 'Sharing cancelled.', cancelled: true });
        return;
      }
      fail(err);
    }
  }

  return { config, start, stop: finish, discard };
}

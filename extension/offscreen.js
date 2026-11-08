// Offscreen document: records a single tab from a tabCapture stream ID.
// It starts as soon as it loads; the background created it for exactly one recording.
import { connectRecorder } from './recorder-host.js';

connectRecorder({ kind: 'offscreen' })
  .then((host) => host.start())
  .catch((err) => chrome.runtime.sendMessage({ type: 'recorder:error', message: err.message }));

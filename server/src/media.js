import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr}`))));
  });
}

let ffmpegAvailable;
export async function hasFfmpeg(ffmpegPath) {
  if (ffmpegAvailable === undefined) {
    ffmpegAvailable = await run(ffmpegPath, ['-version']).then(
      () => true,
      () => false,
    );
  }
  return ffmpegAvailable;
}

/**
 * Browser MediaRecorder output has no duration or seek index (cues), so players
 * cannot seek reliably. A stream-copy remux fixes that in seconds without re-encoding.
 * Falls back to using the raw file when ffmpeg is not installed.
 */
/** Small JPEG thumbnail of a screenshot (skipped without ffmpeg; the PNG is used instead). */
export async function makeImagePoster({ ffmpegPath, imagePath, posterPath }) {
  if (!(await hasFfmpeg(ffmpegPath))) return false;
  try {
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-vf', "scale='min(640,iw)':-2", '-q:v', '4', posterPath]);
    return true;
  } catch {
    return false;
  }
}

export async function processVideo({ ffmpegPath, rawPath, outPath, posterPath }) {
  if (!(await hasFfmpeg(ffmpegPath))) {
    await fs.copyFile(rawPath, outPath);
    return { remuxed: false, poster: false };
  }
  // Cues (the seek index) at the front: players can start and seek without first reading
  // the end of the file, which saves a round trip when streaming from Drive.
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath, '-c', 'copy', '-cues_to_front', '1', outPath]);
  let poster = false;
  try {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '0.5', '-i', outPath, '-frames:v', '1', '-vf', 'scale=640:-2', posterPath,
    ]);
    poster = true;
  } catch {
    /* very short clips may have no frame at 0.5s; poster is optional */
  }
  return { remuxed: true, poster };
}

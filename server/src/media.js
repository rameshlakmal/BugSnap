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

/**
 * One frame of a recording as a PNG, at full size. Used when the frame is chosen on the public
 * player, whose video (from Google Drive) the page itself is not allowed to read.
 */
export async function extractFrame({ ffmpegPath, videoPath, at, outPath }) {
  if (!(await hasFfmpeg(ffmpegPath))) throw Object.assign(new Error('Capturing frames from a share link needs ffmpeg on the server.'), { status: 501 });
  // -ss before -i seeks fast and, since frames are decoded, still lands on the exact moment.
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', Math.max(0, at).toFixed(3), '-i', videoPath, '-frames:v', '1', '-update', '1', outPath]);
  const png = await fs.readFile(outPath);
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('ffmpeg did not produce an image at that moment.');
  // Width and height sit in the PNG's first chunk (IHDR).
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), png };
}

/**
 * Cut [start, end] seconds out of a recording. Browser recordings have very few keyframes, so a
 * stream copy would start at the wrong moment: re-encode (fast VP9 settings) for an exact cut.
 */
export async function trimVideo({ ffmpegPath, inPath, outPath, posterPath, start, end }) {
  if (!(await hasFfmpeg(ffmpegPath))) throw Object.assign(new Error('Trimming needs ffmpeg on the server.'), { status: 501 });
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inPath, '-ss', start.toFixed(3), '-to', end.toFixed(3),
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '32', '-b:v', '0',
    '-c:a', 'libopus', '-b:a', '96k',
    '-cues_to_front', '1', outPath,
  ]);
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.3', '-i', outPath, '-frames:v', '1', '-vf', 'scale=640:-2', posterPath]).catch(() => {});
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

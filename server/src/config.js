import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT || 4800);

export const config = {
  port,
  // Only this computer can reach the server by default (it holds your Google Drive access).
  // Set HOST=0.0.0.0 to accept uploads from other machines.
  host: process.env.HOST || '127.0.0.1',
  // Base URL used when building share links, e.g. https://rec.yourco.com
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  // Local working copies of recordings (also used for thumbnails and hover previews).
  dataDir: process.env.DATA_DIR || path.resolve(here, '..', 'data'),
  // Optional shared secret the extension must send to upload. Empty = uploads open (local dev only).
  uploadToken: process.env.UPLOAD_TOKEN || '',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  // The list of all recordings has no sign-in. Set to 1 to hide it
  // on a shared server so recordings are reachable only through their share links.
  disableList: process.env.DISABLE_LIST === '1',
  publicDir: path.resolve(here, '..', 'public'),
  // Google Drive publishing (see SETUP-GOOGLE-DRIVE.md). Empty = recordings stay local only.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    folderName: process.env.DRIVE_FOLDER_NAME || 'BugSnap',
  },
  // Public player on GitHub Pages, e.g. https://you.github.io/bugsnap-viewer
  viewerUrl: process.env.VIEWER_URL || '',
  // Browser API key the public player uses to read shared files (only needed to build it).
  driveApiKey: process.env.DRIVE_API_KEY || '',
  // AI bug reports via Claude Code on this computer (no API key). Optional overrides:
  claudePath: process.env.CLAUDE_CODE_PATH || '',
  aiModel: process.env.AI_MODEL || 'sonnet',
  // Or the Claude API: a key here (or saved on the settings page, which wins).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  // GitHub issues: fine-grained token (or save it on the settings page, which wins).
  githubToken: process.env.GITHUB_TOKEN || '',
  maxChunkBytes: 100 * 1024 * 1024,
};

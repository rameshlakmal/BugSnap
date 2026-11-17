// Settings made on the setup page (/setup), kept in <dataDir>/setup.json. They win over server/.env,
// so nobody has to edit .env: each person pastes their own Google app, API key and player address.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIELDS = ['googleClientId', 'googleClientSecret', 'driveApiKey', 'viewerUrl', 'githubRepo', 'playerHost', 'storage', 'finished'];
const HOSTS = ['vercel', 'github', 'other'];

const clean = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class SetupStore {
  constructor({ dataDir, env }) {
    this.file = path.join(dataDir, 'setup.json');
    this.env = env; // { googleClientId, googleClientSecret, driveApiKey, viewerUrl } from .env
    this.saved = {};
  }

  async load() {
    try {
      this.saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.saved = {};
    }
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Saved value, else the .env value. */
  get(key) {
    return this.saved[key] || this.env[key] || '';
  }

  async update(patch) {
    for (const key of FIELDS) {
      if (!(key in patch)) continue;
      if (key === 'finished') this.saved.finished = Boolean(patch.finished);
      else if (key === 'storage') this.saved.storage = patch.storage === 'local' ? 'local' : 'drive';
      else if (key === 'playerHost') this.saved.playerHost = HOSTS.includes(patch.playerHost) ? patch.playerHost : '';
      else if (key === 'viewerUrl') {
        const url = clean(patch.viewerUrl).replace(/\/+$/, '');
        if (url && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url)) throw Object.assign(new Error('The player address must start with https://'), { status: 400 });
        this.saved.viewerUrl = url;
      } else if (key === 'githubRepo') {
        // owner/repo, also accepted as a github.com address
        const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(clean(patch.githubRepo));
        this.saved.githubRepo = m ? m[1] : '';
      } else this.saved[key] = clean(patch[key]);
    }
    await this.persist();
  }

  /** What the setup page shows. Secrets only as a hint. */
  status() {
    const secret = this.get('googleClientSecret');
    const key = this.get('driveApiKey');
    return {
      storage: this.saved.storage || (this.get('googleClientId') ? 'drive' : null),
      finished: Boolean(this.saved.finished),
      googleClientId: this.get('googleClientId'),
      googleClientSecretHint: secret ? `…${secret.slice(-4)}` : null,
      driveApiKey: key, // public by design: it ships inside the player
      viewerUrl: this.get('viewerUrl'),
      githubRepo: this.saved.githubRepo || '',
      playerHost: this.saved.playerHost || guessHost(this.get('viewerUrl')),
      extensionFolder: path.join(repoRoot, 'extension'),
    };
  }
}

/** Which host an existing player address points at, for people who set it up before choosing. */
function guessHost(url) {
  if (!url) return null;
  if (/\.vercel\.app(\/|$)/i.test(url)) return 'vercel';
  if (/\.github\.io(\/|$)/i.test(url)) return 'github';
  return 'other';
}

/** owner/repo from this folder's git remote, when it is a GitHub copy, and its GitHub Pages address. */
export function guessPlayerUrl() {
  return new Promise((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, timeout: 3000, windowsHide: true }, (err, out) => {
      const m = !err && /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/i.exec(String(out));
      if (!m) return resolve({ url: null, repo: null });
      const [, owner, repo] = m;
      const pages = `${owner.toLowerCase()}.github.io`;
      resolve({ url: repo.toLowerCase() === pages ? `https://${pages}` : `https://${pages}/${repo}`, repo: `${owner}/${repo}` });
    });
  });
}

// What to do on each host when the player is missing or has an old key.
const FIX = {
  vercel: {
    reach: 'Check it, and that the deployment on Vercel finished.',
    missing: "Not published yet, or that isn't the player's address. Check the deployment on Vercel finished.",
    key: 'On Vercel: Settings, Environment Variables, update DRIVE_API_KEY, then Deployments, Redeploy.',
  },
  github: {
    reach: 'Check it, and that GitHub Pages is turned on.',
    missing: 'Not published yet. Run the Player action in your GitHub copy (it takes about a minute).',
    key: 'Update the DRIVE_API_KEY variable in your GitHub copy and run the Player action again.',
  },
  other: {
    reach: 'Check it, and that the upload finished.',
    missing: "Not published yet, or that isn't the player's address. Check the upload.",
    key: 'Run npm run build:viewer again and upload the new viewer-site folder.',
  },
};

/**
 * Is the player published, and does it carry this API key? Reads <player>/config.js, which the
 * player build writes. Returns { ok, message }.
 */
export async function checkPlayer(viewerUrl, apiKey, host) {
  const fix = FIX[host] || FIX[guessHost(viewerUrl)] || FIX.other;
  if (!viewerUrl) return { ok: false, message: 'Add the player address first.' };
  let res;
  try {
    res = await fetch(`${viewerUrl.replace(/\/+$/, '')}/config.js`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  } catch {
    return { ok: false, message: `Can't reach that address. ${fix.reach}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message: /\.vercel\.app/i.test(viewerUrl)
        ? 'That address asks viewers to log in to Vercel. Use the short address under Domains (your-project.vercel.app), not a deployment address.'
        : 'That address asks viewers to log in. The player has to be public.',
    };
  }
  if (res.status === 404) return { ok: false, message: fix.missing };
  if (res.status >= 500 && /\.vercel\.app/i.test(viewerUrl)) {
    return { ok: false, message: `The player answered with an error (${res.status}). On Vercel, check Settings, Build and Deployment: Framework Preset "Other", then Deployments, Redeploy.` };
  }
  if (!res.ok) return { ok: false, message: `The player answered with an error (${res.status}).` };
  const text = await res.text();
  const m = /"driveApiKey"\s*:\s*"([^"]*)"/.exec(text);
  if (!m) return { ok: false, message: "That address doesn't look like a BugSnap player." };
  if (apiKey && m[1] !== apiKey) return { ok: false, message: `The player uses a different API key. ${fix.key}` };
  // The player is up; now ask Google whether this key may be used from the player's address
  // (keys limited to other websites fail here). A made-up file id: 404 means the key works.
  try {
    const drive = await fetch(`https://www.googleapis.com/drive/v3/files/bugsnap-key-check?key=${encodeURIComponent(m[1])}`, {
      headers: { Referer: `${viewerUrl.replace(/\/+$/, '')}/` },
      signal: AbortSignal.timeout(10000),
    });
    if (drive.status === 400) return { ok: false, message: "Google doesn't accept this API key. Check you copied all of it." };
    if (drive.status === 403) {
      const host = new URL(viewerUrl).host;
      return { ok: false, message: `Google blocks this API key on ${host}. In Google Cloud, open the key and add https://${host}/* under Website restrictions (or turn on the Google Drive API for its project). Changes take up to 5 minutes.` };
    }
  } catch {
    /* Google unreachable: the player itself is fine */
  }
  return { ok: true, message: 'Player is live.' };
}

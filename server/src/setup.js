// Settings made on the setup page (/setup), kept in <dataDir>/setup.json. They win over server/.env,
// so nobody has to edit .env: each person pastes their own Google app, API key and player address.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIELDS = ['googleClientId', 'googleClientSecret', 'driveApiKey', 'viewerUrl', 'githubRepo', 'storage', 'finished'];

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
      extensionFolder: path.join(repoRoot, 'extension'),
    };
  }
}

/** https://<owner>.github.io/<repo> from this folder's git remote, when it is a GitHub copy. */
export function guessPlayerUrl() {
  return new Promise((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, timeout: 3000, windowsHide: true }, (err, out) => {
      const m = !err && /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/i.exec(String(out));
      if (!m) return resolve({ url: null, repo: null });
      const [, owner, repo] = m;
      const host = `${owner.toLowerCase()}.github.io`;
      resolve({ url: repo.toLowerCase() === host ? `https://${host}` : `https://${host}/${repo}`, repo: `${owner}/${repo}` });
    });
  });
}

/**
 * Is the player published, and does it carry this API key? Reads <player>/config.js, which the
 * GitHub Action writes. Returns { ok, message }.
 */
export async function checkPlayer(viewerUrl, apiKey) {
  if (!viewerUrl) return { ok: false, message: 'Add the player address first.' };
  let res;
  try {
    res = await fetch(`${viewerUrl.replace(/\/+$/, '')}/config.js`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  } catch {
    return { ok: false, message: "Can't reach that address. Check it, and that GitHub Pages is turned on." };
  }
  if (res.status === 404) return { ok: false, message: 'Not published yet. Run the Player action in your GitHub copy (it takes about a minute).' };
  if (!res.ok) return { ok: false, message: `The player answered with an error (${res.status}).` };
  const text = await res.text();
  const m = /"driveApiKey"\s*:\s*"([^"]*)"/.exec(text);
  if (!m) return { ok: false, message: "That address doesn't look like a BugSnap player." };
  if (apiKey && m[1] !== apiKey) return { ok: false, message: 'The player uses a different API key. Update DRIVE_API_KEY in your GitHub copy and run the Player action again.' };
  return { ok: true, message: 'Player is live.' };
}

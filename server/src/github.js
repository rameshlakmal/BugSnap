// GitHub issues from recordings and screenshots, with a fine-grained personal access token
// (Issues: read and write on the chosen repositories). The token is stored only on this
// computer in <dataDir>/github.json and never sent to the browser.
import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.github.com';
const fail = (message, status) => Object.assign(new Error(message), { status });

export class GitHub {
  constructor({ dataDir, envToken }) {
    this.file = path.join(dataDir, 'github.json');
    this.envToken = envToken || '';
    this.saved = { token: '', login: null, defaultRepo: null };
  }

  async load() {
    try {
      this.saved = { ...this.saved, ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    } catch {
      /* not set up yet */
    }
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  get token() {
    return this.saved.token || this.envToken;
  }

  status() {
    const t = this.token;
    return {
      configured: Boolean(t),
      login: this.saved.login,
      tokenHint: t ? `…${t.slice(-4)}` : null,
      fromEnv: Boolean(!this.saved.token && this.envToken),
      defaultRepo: this.saved.defaultRepo,
    };
  }

  async request(method, url, body) {
    if (!this.token) throw fail('GitHub is not connected. Add a token in Settings.', 400);
    let res;
    try {
      res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'BugSnap',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw fail("Can't reach GitHub. Check the internet connection.", 503);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { data, headers: res.headers };
    if (res.status === 401) throw fail('GitHub did not accept the token. Create a new one in Settings.', 400);
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw fail('GitHub rate limit reached. Try again in a few minutes.', 429);
    if (res.status === 403 || res.status === 404) throw fail('The token cannot do this. Give it "Issues: Read and write" on this repository.', 403);
    if (res.status === 410) throw fail('Issues are turned off for this repository.', 400);
    if (res.status === 422) throw fail(`GitHub rejected the issue: ${(data.errors || []).map((e) => e.message || e.code).join(', ') || data.message}`, 400);
    throw fail(`GitHub error ${res.status}: ${data.message || res.statusText}`, 502);
  }

  /** Save (and check) a token; an empty string removes the saved one. */
  async setToken(token) {
    const t = String(token || '').trim();
    if (!t) {
      this.saved = { ...this.saved, token: '', login: null };
      await this.persist();
      return this.status();
    }
    const previous = this.saved.token;
    this.saved.token = t;
    try {
      const { data } = await this.request('GET', '/user');
      this.saved.login = data.login;
    } catch (err) {
      this.saved.token = previous;
      throw err;
    }
    await this.persist();
    return this.status();
  }

  async setDefaultRepo(fullName) {
    this.saved.defaultRepo = fullName || null;
    await this.persist();
  }

  /** Repositories the token can reach, most recently updated first. */
  async repos() {
    const out = [];
    let url = '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
    for (let page = 0; url && page < 5; page++) {
      const { data, headers } = await this.request('GET', url);
      out.push(...data.map((r) => ({ fullName: r.full_name, private: r.private, hasIssues: r.has_issues })));
      url = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') || '')?.[1] || null;
    }
    return out.filter((r) => r.hasIssues);
  }

  /** Labels, people who can be assigned, and open milestones of one repository. */
  async repoMeta(fullName) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName || '')) throw fail('Unknown repository', 400);
    const get = (p) => this.request('GET', `/repos/${fullName}${p}`).then((r) => r.data).catch(() => []);
    const [labels, assignees, milestones] = await Promise.all([get('/labels?per_page=100'), get('/assignees?per_page=100'), get('/milestones?state=open&per_page=50')]);
    return {
      labels: labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
      assignees: assignees.map((a) => ({ login: a.login, avatar: a.avatar_url })),
      milestones: milestones.map((m) => ({ number: m.number, title: m.title })),
    };
  }

  async createIssue({ repo, title, body, labels, assignees, milestone }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw fail('Choose a repository', 400);
    if (!String(title || '').trim()) throw fail('The issue needs a title', 400);
    const payload = { title: String(title).trim().slice(0, 256), body: String(body || '').slice(0, 65000) };
    if (Array.isArray(labels) && labels.length) payload.labels = labels.map(String).slice(0, 20);
    if (Array.isArray(assignees) && assignees.length) payload.assignees = assignees.map(String).slice(0, 10);
    if (Number(milestone)) payload.milestone = Number(milestone);
    const { data } = await this.request('POST', `/repos/${repo}/issues`, payload);
    return { number: data.number, url: data.html_url, repo, createdAt: data.created_at };
  }
}

/** Split a Markdown report into an issue title ("# Title" line) and body. */
export function splitReport(markdown, fallbackTitle) {
  const text = String(markdown || '').trim();
  const m = /^#\s+(.+)\n?/.exec(text);
  return m ? { title: m[1].trim(), body: text.slice(m[0].length).trim() } : { title: fallbackTitle || 'Bug report', body: text };
}

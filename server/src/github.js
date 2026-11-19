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
      recentRepos: this.saved.recentRepos || [],
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

  /** The repository last used; it also goes to the top of the recent list. */
  async setDefaultRepo(fullName) {
    const repo = /^[\w.-]+\/[\w.-]+$/.test(fullName || '') ? fullName : null;
    // Older saves have only the last repo: it starts the recent list.
    const before = this.saved.recentRepos?.length ? this.saved.recentRepos : [this.saved.defaultRepo].filter(Boolean);
    this.saved.defaultRepo = repo;
    if (repo) this.saved.recentRepos = mru(before, [repo], 8);
    await this.persist();
  }

  /** Boards (and their dropdown values) last used with a repository; recent boards are listed first. */
  boardPrefs(repo) {
    return this.saved.boards?.[repo] || null;
  }

  async setBoardPrefs(repo, { boards, values }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw fail('Unknown repository', 400);
    const ok = (v) => typeof v === 'string' && /^[\w-]{4,100}$/.test(v);
    const ids = (Array.isArray(boards) ? boards : []).filter(ok).slice(0, 10);
    const vals = {};
    for (const pid of ids) {
      const v = values?.[pid];
      if (v && typeof v === 'object') vals[pid] = Object.fromEntries(Object.entries(v).filter(([f, o]) => ok(f) && ok(o)).slice(0, 20));
    }
    const prev = this.boardPrefs(repo);
    this.saved.boards = { ...(this.saved.boards || {}), [repo]: { boards: ids, values: vals, recent: mru(prev?.recent, ids, 10) } };
    await this.persist();
  }

  /** Repositories the token can reach: recently used first, then most recently updated. */
  async repos() {
    const recent = this.saved.recentRepos?.length ? this.saved.recentRepos : [this.saved.defaultRepo].filter(Boolean);
    return byRecent(await this.cached('repos', () => this.allRepos()), recent, (r) => r.fullName);
  }

  /**
   * Listing repositories (and their labels and people) takes GitHub seconds. The last answer is
   * returned at once and refreshed in the background, so the issue form opens without waiting.
   */
  cached(key, load, maxAgeMs = 60 * 1000) {
    this.cache ||= new Map();
    const token = this.token;
    const hit = this.cache.get(key);
    const fresh = () => {
      const p = load().then(
        (value) => {
          if (this.token === token) this.cache.set(key, { value, at: Date.now(), token });
          return value;
        },
        (err) => {
          if (this.cache.get(key)?.pending === p) this.cache.delete(key);
          throw err;
        },
      );
      return p;
    };
    if (hit?.token === token && 'value' in hit) {
      if (Date.now() - hit.at > maxAgeMs && !hit.refreshing) {
        hit.refreshing = true;
        fresh().catch(() => (hit.refreshing = false));
      }
      return Promise.resolve(hit.value);
    }
    if (hit?.token === token && hit.pending) return hit.pending;
    const pending = fresh();
    this.cache.set(key, { pending, token });
    return pending;
  }

  /** Load the repository list now so the first issue form after a restart is quick too. */
  warm() {
    if (!this.token) return;
    this.cached('repos', () => this.allRepos()).catch(() => {});
    // The last-used repo's labels and boards too: that is the one the form opens on.
    const repo = this.saved.defaultRepo;
    if (repo) {
      this.repoMeta(repo).catch(() => {});
      this.projects(repo).catch(() => {});
    }
  }

  async allRepos() {
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
    return this.cached(`meta:${fullName}`, () => this.loadRepoMeta(fullName));
  }

  async loadRepoMeta(fullName) {
    const get = (p) => this.request('GET', `/repos/${fullName}${p}`).then((r) => r.data).catch(() => []);
    const [labels, assignees, milestones] = await Promise.all([get('/labels?per_page=100'), get('/assignees?per_page=100'), get('/milestones?state=open&per_page=50')]);
    return {
      labels: labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
      assignees: assignees.map((a) => ({ login: a.login, avatar: a.avatar_url })),
      milestones: milestones.map((m) => ({ number: m.number, title: m.title })),
    };
  }

  /** GitHub's GraphQL API (project boards exist only there). Throws on any error in the answer. */
  async graphql(query, variables) {
    const { data } = await this.request('POST', '/graphql', { query, variables });
    if (data.errors?.length) {
      const e = data.errors[0];
      const scope = data.errors.some((x) => /INSUFFICIENT_SCOPES|FORBIDDEN|NOT_FOUND/.test(x.type || '') || /permission|scope|access/i.test(x.message || ''));
      throw Object.assign(fail(scope ? 'The token cannot see project boards. Give it "Projects: Read and write" in GitHub settings.' : `GitHub: ${e.message}`, scope ? 403 : 502), { data: data.data });
    }
    return data.data;
  }

  /**
   * Project boards (Projects v2) for a repository: boards linked to it first, then other open
   * boards of the same owner. Only single-select fields (Status, Priority, …) are returned.
   */
  async projects(fullName) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName || '')) throw fail('Unknown repository', 400);
    const key = `projects:${fullName}`;
    const out = await this.cached(key, () => this.loadProjects(fullName));
    // A failed look-up is asked again next time rather than remembered.
    if (out?.error && !out.projects?.length) this.cache.delete(key);
    return out;
  }

  async loadProjects(fullName) {
    const [owner, name] = fullName.split('/');
    const P = `nodes { id title number closed url fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name color } } } } }`;
    const list = `projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { ${P} }`;
    const query = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${list}
        owner { __typename ... on User { ${list} } ... on Organization { ${list} } }
      }
    }`;
    let data;
    let warning = null;
    try {
      data = await this.graphql(query, { owner, name });
    } catch (err) {
      // Partial answers are common: e.g. the token sees the repo's boards but not the org's.
      if (!err.data?.repository) return { projects: [], error: err.message };
      data = err.data;
      warning = err.message;
    }
    const shape = (p, linked) => ({
      id: p.id,
      title: p.title,
      number: p.number,
      url: p.url,
      linked,
      fields: (p.fields?.nodes || []).filter((f) => f?.id && Array.isArray(f.options)).map((f) => ({ id: f.id, name: f.name, options: f.options.map((o) => ({ id: o.id, name: o.name, color: o.color })) })),
    });
    const seen = new Set();
    const out = [];
    for (const [nodes, linked] of [
      [data.repository?.projectsV2?.nodes, true],
      [data.repository?.owner?.projectsV2?.nodes, false],
    ]) {
      for (const p of nodes || []) {
        if (!p || p.closed || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push(shape(p, linked));
      }
    }
    const saved = this.boardPrefs(fullName);
    return { projects: byRecent(out, saved?.recent, (p) => p.id), error: out.length ? null : warning, saved };
  }

  /**
   * Put a new issue on boards and set their dropdowns.
   * boards: [{ projectId, values: { fieldId: optionId } }]. Each board is tried on its own,
   * so one failure does not stop the others; the issue itself is already created.
   */
  async addToProjects(contentId, boards) {
    const id = (v) => typeof v === 'string' && /^[\w-]{4,100}$/.test(v);
    const results = [];
    for (const b of (Array.isArray(boards) ? boards : []).slice(0, 5)) {
      if (!id(b?.projectId)) continue;
      try {
        const added = await this.graphql(`mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`, { p: b.projectId, c: contentId });
        const itemId = added.addProjectV2ItemById.item.id;
        const values = Object.entries(b.values || {}).filter(([f, o]) => id(f) && id(o)).slice(0, 20);
        if (values.length) {
          // One request for all fields of this board, using aliases.
          const vars = { p: b.projectId, i: itemId };
          const parts = values.map(([f, o], n) => {
            vars[`f${n}`] = f;
            vars[`o${n}`] = o;
            return `u${n}: updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f${n}, value: { singleSelectOptionId: $o${n} } }) { projectV2Item { id } }`;
          });
          const decl = values.map((_, n) => `$f${n}: ID!, $o${n}: String!`).join(', ');
          await this.graphql(`mutation($p: ID!, $i: ID!, ${decl}) { ${parts.join(' ')} }`, vars);
        }
        results.push({ projectId: b.projectId, ok: true });
      } catch (err) {
        results.push({ projectId: b.projectId, ok: false, error: err.message });
      }
    }
    return results;
  }

  async createIssue({ repo, title, body, labels, assignees, milestone }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw fail('Choose a repository', 400);
    if (!String(title || '').trim()) throw fail('The issue needs a title', 400);
    const payload = { title: String(title).trim().slice(0, 256), body: String(body || '').slice(0, 65000) };
    if (Array.isArray(labels) && labels.length) payload.labels = labels.map(String).slice(0, 20);
    if (Array.isArray(assignees) && assignees.length) payload.assignees = assignees.map(String).slice(0, 10);
    if (Number(milestone)) payload.milestone = Number(milestone);
    const { data } = await this.request('POST', `/repos/${repo}/issues`, payload);
    return { number: data.number, url: data.html_url, repo, createdAt: data.created_at, nodeId: data.node_id };
  }
}

/** Most recent first: `used` moved to the front of `list`, no repeats, at most `max`. */
function mru(list, used, max) {
  const out = [...used];
  for (const x of Array.isArray(list) ? list : []) if (!out.includes(x)) out.push(x);
  return out.slice(0, max);
}

/** Items in `recent` order first (most recent on top), the rest keep their order. */
function byRecent(items, recent, key) {
  const rank = new Map((Array.isArray(recent) ? recent : []).map((k, i) => [k, i]));
  const r = (x) => (rank.has(key(x)) ? rank.get(key(x)) : Infinity);
  return items.map((x, i) => [x, i]).sort((a, b) => r(a[0]) - r(b[0]) || a[1] - b[1]).map(([x]) => x);
}

/** Split a Markdown report into an issue title ("# Title" line) and body. */
export function splitReport(markdown, fallbackTitle) {
  const text = String(markdown || '').trim();
  const m = /^#\s+(.+)\n?/.exec(text);
  return m ? { title: m[1].trim(), body: text.slice(m[0].length).trim() } : { title: fallbackTitle || 'Bug report', body: text };
}

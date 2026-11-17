// Jira, GitLab, Slack and Notion: connect by pasting a token, then send a recording or screenshot
// as an issue, message or page. Tokens live in <dataDir>/integrations.json on this computer and
// are never sent to the browser.
//
// Each tool has the same shape:
//   connect(input)          check the token, return what to save (throws a friendly error)
//   targets(cfg, query)     where it can go: Jira/GitLab projects, Notion databases (Slack: none)
//   meta(cfg, target)       extra choices for a target (Jira issue types)
//   send(cfg, item)         create it; item = { target, title, markdown, images: [{ name, path }], link, extra }
import fs from 'node:fs/promises';
import path from 'node:path';
import { openAsBlob } from 'node:fs';

export class IntegrationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status) => new IntegrationError(message, status);

/** fetch + JSON with readable errors. `who` names the service in messages. */
async function call(who, url, { method = 'GET', headers = {}, body, form, raw = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: form || (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw fail(`Can't reach ${who}. Check the address and your connection.`, 502);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail =
      data?.errorMessages?.join(' ') ||
      (data?.errors && typeof data.errors === 'object' ? Object.values(data.errors).join(' ') : '') ||
      data?.message ||
      data?.error_description ||
      (typeof data?.error === 'string' ? data.error : '') ||
      text.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw fail(`${who} refused the token${detail ? ` (${detail})` : ''}. Check it and try again.`, 400);
    if (res.status === 404) throw fail(`${who} could not find that${detail ? `: ${detail}` : ''}.`, 400);
    throw fail(`${who} answered ${res.status}${detail ? `: ${detail}` : ''}`, 502);
  }
  return raw ? text : data;
}

const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- markdown helpers

/** Markdown (as BugSnap writes it) to Jira wiki markup, for Jira's v2 API. */
export function toJiraWiki(md) {
  const out = [];
  let inCode = false;
  for (const line of String(md || '').split('\n')) {
    if (/^\s*```/.test(line)) {
      out.push(inCode ? '{code}' : '{code}');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    let l = line;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) l = `h${h[1].length}. ${h[2]}`;
    const ul = /^(\s*)[-*]\s+(.*)$/.exec(l);
    if (ul) l = `${'*'.repeat(Math.floor(ul[1].length / 2) + 1)} ${ul[2]}`;
    const ol = /^(\s*)\d+[.)]\s+(.*)$/.exec(l);
    if (ol) l = `${'#'.repeat(Math.floor(ol[1].length / 2) + 1)} ${ol[2]}`;
    l = l
      .replace(/`([^`]+)`/g, '{{$1}}')
      .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '!$1!')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '[$1|$2]')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*');
    out.push(l);
  }
  return out.join('\n');
}

/** Markdown to Slack mrkdwn. */
export function toSlack(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(md || '')
    .split('\n')
    .map((line) => {
      let l = esc(line);
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      if (h) return `*${h[1].replace(/\*\*/g, '')}*`;
      l = l.replace(/^(\s*)[-*]\s+/, '$1• ');
      return l
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<$2|$1>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
        .replace(/\*\*([^*]+)\*\*/g, '*$1*');
    })
    .join('\n');
}

/** Inline markdown (bold, code, links) to Notion rich text. */
function richText(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m;
  const push = (content, annotations = {}, link = null) => {
    for (let i = 0; i < content.length; i += 1900) {
      const chunk = content.slice(i, i + 1900);
      out.push({ type: 'text', text: { content: chunk, ...(link && /^https?:\/\//.test(link) ? { link: { url: link } } : {}) }, ...(Object.keys(annotations).length ? { annotations } : {}) });
    }
  };
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[2]) push(m[2], { bold: true });
    else if (m[3]) push(m[3], { code: true });
    else push(m[4], {}, m[5]);
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last));
  return out.slice(0, 100);
}

/** Markdown to Notion blocks (headings, lists, code, images, paragraphs). Notion takes 100 per request. */
export function toNotionBlocks(md) {
  const blocks = [];
  const lines = String(md || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ object: 'block', type: 'code', code: { language: 'plain text', rich_text: [{ type: 'text', text: { content: code.join('\n').slice(0, 1900) } }] } });
      continue;
    }
    if (!line.trim()) continue;
    const img = /^\s*!\[[^\]]*\]\((https:\/\/[^)\s]+)\)\s*$/.exec(line);
    if (img) {
      blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: img[1] } } });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const type = `heading_${Math.min(3, h[1].length)}`;
      blocks.push({ object: 'block', type, [type]: { rich_text: richText(h[2]) } });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(ul[1]) } });
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: richText(ol[1]) } });
      continue;
    }
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(line) } });
  }
  return blocks.slice(0, 100);
}

// ---------------------------------------------------------------- Jira (Cloud: email + API token; Server/DC: personal token)

const jiraAuth = (cfg) => (cfg.email ? `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}` : `Bearer ${cfg.token}`);
const jira = {
  name: 'Jira',
  async connect({ site, email, token }) {
    site = trimUrl(site);
    if (!/^https?:\/\/[^\s/]+/.test(site)) throw fail('Enter your Jira address, for example https://yourteam.atlassian.net');
    if (!token) throw fail('Paste your Jira API token.');
    const cfg = { site, email: String(email || '').trim(), token: String(token).trim() };
    const me = await call('Jira', `${site}/rest/api/2/myself`, { headers: { Authorization: jiraAuth(cfg) } });
    return { ...cfg, account: me?.displayName || me?.emailAddress || 'Jira user' };
  },
  async targets(cfg, query = '') {
    const q = new URLSearchParams({ maxResults: '100', orderBy: '-lastIssueUpdatedDate', ...(query ? { query } : {}) });
    const data = await call('Jira', `${cfg.site}/rest/api/2/project/search?${q}`, { headers: { Authorization: jiraAuth(cfg) } });
    return (data?.values || []).map((p) => ({ id: p.key, name: `${p.name} (${p.key})` }));
  },
  async meta(cfg, project) {
    if (!project) return { issueTypes: [] };
    const data = await call('Jira', `${cfg.site}/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`, { headers: { Authorization: jiraAuth(cfg) } });
    const types = (data?.issueTypes || data?.values || []).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
    return { issueTypes: types };
  },
  async send(cfg, { target, title, markdown, images, extra }) {
    if (!target) throw fail('Pick a Jira project.');
    let issueType = extra?.issueType;
    if (!issueType) {
      const { issueTypes } = await this.meta(cfg, target);
      issueType = (issueTypes.find((t) => /^bug$/i.test(t.name)) || issueTypes.find((t) => /task/i.test(t.name)) || issueTypes[0])?.id;
    }
    // Images go in as attachments; the description shows them by file name.
    const shots = images.map((img, i) => ({ ...img, file: `${img.name || `screenshot-${i + 1}`}.png`.replace(/[^\w.-]+/g, '-') }));
    let wiki = toJiraWiki(markdown);
    if (shots.length) wiki += `\n\nh2. Attachments\n${shots.map((s) => `!${s.file}|thumbnail!`).join(' ')}`;
    const issue = await call('Jira', `${cfg.site}/rest/api/2/issue`, {
      method: 'POST',
      headers: { Authorization: jiraAuth(cfg) },
      body: { fields: { project: { key: target }, issuetype: { id: String(issueType || '') }, summary: clip(title, 250), description: wiki } },
    });
    for (const s of shots) {
      const form = new FormData();
      form.append('file', await openAsBlob(s.path, { type: 'image/png' }), s.file);
      await call('Jira', `${cfg.site}/rest/api/2/issue/${issue.key}/attachments`, { method: 'POST', headers: { Authorization: jiraAuth(cfg), 'X-Atlassian-Token': 'no-check' }, form });
    }
    return { key: issue.key, url: `${cfg.site}/browse/${issue.key}`, label: issue.key };
  },
};

// ---------------------------------------------------------------- GitLab (gitlab.com or self-hosted; personal access token, api scope)

const gitlab = {
  name: 'GitLab',
  async connect({ baseUrl, token }) {
    const base = trimUrl(baseUrl) || 'https://gitlab.com';
    if (!/^https?:\/\/[^\s/]+/.test(base)) throw fail('Enter the GitLab address, for example https://gitlab.com');
    if (!token) throw fail('Paste your GitLab access token.');
    const cfg = { baseUrl: base, token: String(token).trim() };
    const me = await call('GitLab', `${base}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': cfg.token } });
    return { ...cfg, account: me?.username ? `@${me.username}` : 'GitLab user' };
  },
  async targets(cfg, query = '') {
    const q = new URLSearchParams({ membership: 'true', simple: 'true', per_page: '100', order_by: 'last_activity_at', ...(query ? { search: query } : {}) });
    const data = await call('GitLab', `${cfg.baseUrl}/api/v4/projects?${q}`, { headers: { 'PRIVATE-TOKEN': cfg.token } });
    return (data || []).map((p) => ({ id: String(p.id), name: p.path_with_namespace }));
  },
  async meta() {
    return {};
  },
  async send(cfg, { target, title, markdown, images, extra }) {
    if (!target) throw fail('Pick a GitLab project.');
    const pid = encodeURIComponent(target);
    const uploads = [];
    for (const [i, img] of images.entries()) {
      const form = new FormData();
      form.append('file', await openAsBlob(img.path, { type: 'image/png' }), `${img.name || `screenshot-${i + 1}`}.png`.replace(/[^\w.-]+/g, '-'));
      const up = await call('GitLab', `${cfg.baseUrl}/api/v4/projects/${pid}/uploads`, { method: 'POST', headers: { 'PRIVATE-TOKEN': cfg.token }, form });
      if (up?.markdown) uploads.push(up.markdown);
    }
    const description = uploads.length ? `${markdown}\n\n## Attachments\n${uploads.join('\n')}` : markdown;
    const labels = String(extra?.labels || '').trim();
    const issue = await call('GitLab', `${cfg.baseUrl}/api/v4/projects/${pid}/issues`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': cfg.token },
      body: { title: clip(title, 255), description, ...(labels ? { labels } : {}) },
    });
    return { key: `#${issue.iid}`, url: issue.web_url, label: `#${issue.iid}` };
  },
};

// ---------------------------------------------------------------- Slack (incoming webhook: one channel, no scopes to set up)

const SLACK_HOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[\w/-]+$/;
const slack = {
  name: 'Slack',
  async connect({ webhook, channel }) {
    const url = String(webhook || '').trim();
    // Tests point this at a local fake Slack.
    const allowed = SLACK_HOOK.test(url) || (process.env.BUGSNAP_TEST_SLACK && url.startsWith(process.env.BUGSNAP_TEST_SLACK));
    if (!allowed) throw fail('Paste a Slack webhook URL. It starts with https://hooks.slack.com/services/');
    const name = String(channel || '').trim().replace(/^#?/, '#').slice(0, 80);
    return { webhook: url, channel: name === '#' ? '' : name, account: name !== '#' ? name : 'Incoming webhook' };
  },
  async targets() {
    return [];
  },
  async meta() {
    return {};
  },
  message({ title, markdown, link }) {
    let text = toSlack(markdown);
    if (text.length > 2900) text = `${text.slice(0, 2900)}…`;
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: clip(title || 'Bug report', 150), emoji: true } },
      ...(text.trim() ? [{ type: 'section', text: { type: 'mrkdwn', text } }] : []),
    ];
    if (/^https?:\/\//.test(link || '')) {
      blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in BugSnap' }, url: link, style: 'primary' }] });
    }
    return { text: `${title}${link ? ` ${link}` : ''}`, blocks };
  },
  async send(cfg, item) {
    await call('Slack', cfg.webhook, { method: 'POST', body: this.message(item), raw: true });
    return { key: null, url: null, label: cfg.channel || 'Slack' };
  },
};

// ---------------------------------------------------------------- Notion (internal integration token; share a database with it)

const NOTION_VERSION = '2022-06-28';
const notionBase = () => process.env.NOTION_API_BASE || 'https://api.notion.com';
const notionHeaders = (cfg) => ({ Authorization: `Bearer ${cfg.token}`, 'Notion-Version': NOTION_VERSION });
const plain = (rich) => (rich || []).map((t) => t.plain_text || t.text?.content || '').join('');
const notion = {
  name: 'Notion',
  async connect({ token }) {
    const cfg = { token: String(token || '').trim() };
    if (!cfg.token) throw fail('Paste your Notion integration secret.');
    const me = await call('Notion', `${notionBase()}/v1/users/me`, { headers: notionHeaders(cfg) });
    return { ...cfg, account: me?.bot?.workspace_name || me?.name || 'Notion' };
  },
  async targets(cfg, query = '') {
    const data = await call('Notion', `${notionBase()}/v1/search`, {
      method: 'POST',
      headers: notionHeaders(cfg),
      body: { ...(query ? { query } : {}), filter: { property: 'object', value: 'database' }, page_size: 100 },
    });
    return (data?.results || []).map((d) => ({ id: d.id, name: plain(d.title) || 'Untitled database' }));
  },
  async meta() {
    return {};
  },
  async send(cfg, { target, title, markdown, link }) {
    if (!target) throw fail('Pick a Notion database. Only databases shared with your integration are listed.');
    const db = await call('Notion', `${notionBase()}/v1/databases/${encodeURIComponent(target)}`, { headers: notionHeaders(cfg) });
    const titleProp = Object.entries(db?.properties || {}).find(([, p]) => p.type === 'title')?.[0] || 'Name';
    // A URL column, when the database has one, gets the share link.
    const urlProp = Object.entries(db?.properties || {}).find(([, p]) => p.type === 'url')?.[0];
    const page = await call('Notion', `${notionBase()}/v1/pages`, {
      method: 'POST',
      headers: notionHeaders(cfg),
      body: {
        parent: { database_id: target },
        properties: {
          [titleProp]: { title: [{ type: 'text', text: { content: clip(title || 'Bug report', 1900) } }] },
          ...(urlProp && /^https?:\/\//.test(link || '') ? { [urlProp]: { url: link } } : {}),
        },
        children: toNotionBlocks(markdown),
      },
    });
    return { key: page.id, url: page.url, label: 'Notion page' };
  },
};

export const TOOLS = { jira, gitlab, slack, notion };

// ---------------------------------------------------------------- store

export class Integrations {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'integrations.json');
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

  tool(name) {
    const t = TOOLS[name];
    if (!t) throw fail('Unknown tool', 404);
    return t;
  }

  cfg(name) {
    this.tool(name);
    const c = this.saved[name];
    if (!c) throw fail(`${TOOLS[name].name} is not connected. Connect it in BugSnap Settings.`, 409);
    return c;
  }

  /** Everything the browser may see: no tokens. */
  status() {
    const out = {};
    for (const [name, t] of Object.entries(TOOLS)) {
      const c = this.saved[name];
      out[name] = c
        ? { name: t.name, connected: true, account: c.account, site: c.site || c.baseUrl || null, email: c.email || null, channel: c.channel || null, defaults: c.defaults || {} }
        : { name: t.name, connected: false };
    }
    return out;
  }

  async connect(name, input) {
    const prev = this.saved[name];
    // Keep the saved token when only other fields change (the token field is left empty).
    const merged = { ...input };
    if (!merged.token && prev?.token && name !== 'slack') merged.token = prev.token;
    if (name === 'slack' && !merged.webhook && prev?.webhook) merged.webhook = prev.webhook;
    const saved = await this.tool(name).connect(merged);
    this.saved[name] = { ...saved, defaults: prev?.defaults || {} };
    await this.persist();
    return this.status()[name];
  }

  async setDefaults(name, defaults) {
    const c = this.cfg(name);
    c.defaults = { ...(c.defaults || {}), ...Object.fromEntries(Object.entries(defaults || {}).map(([k, v]) => [k, String(v ?? '').slice(0, 200)])) };
    await this.persist();
  }

  async disconnect(name) {
    this.tool(name);
    delete this.saved[name];
    await this.persist();
  }

  targets(name, query) {
    return this.tool(name).targets(this.cfg(name), String(query || '').slice(0, 100));
  }

  meta(name, target) {
    return this.tool(name).meta(this.cfg(name), String(target || ''));
  }

  async send(name, item) {
    const result = await this.tool(name).send(this.cfg(name), item);
    // The project/database used last is picked again next time.
    await this.setDefaults(name, { target: item.target || '', ...(item.extra?.issueType ? { issueType: item.extra.issueType } : {}) }).catch(() => {});
    return result;
  }
}

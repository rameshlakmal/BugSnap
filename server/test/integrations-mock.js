// Offline end-to-end test of Jira, GitLab, Slack and Notion: a real BugSnap server (throwaway data
// folder, port 4812) talks to one fake server that plays all four services.
// Covers: connecting (token checks, wrong token), listing targets, Jira issue types, creating an
// issue/message/page from a screenshot with its image, and that tokens never reach the browser.
// Run: node test/integrations-mock.js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = 4899;
const PORT = 4812;
const BASE = `http://localhost:${PORT}`;
const FAKE = `http://localhost:${MOCK}`;
const seen = []; // { path, method, headers, body }

// ---------------------------------------------------------------- the fake services
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const body = /json/.test(req.headers['content-type'] || '') && raw.length ? JSON.parse(raw) : raw.toString('latin1');
  seen.push({ path: req.url, method: req.method, headers: req.headers, body });
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const u = req.url;
  // Jira
  if (u.startsWith('/jira/')) {
    const ok = req.headers.authorization === `Basic ${Buffer.from('me@team.dev:jira-token').toString('base64')}`;
    if (!ok) return send(401, { errorMessages: ['Client must be authenticated'] });
    if (u === '/jira/rest/api/2/myself') return send(200, { displayName: 'Dev Tester' });
    if (u.startsWith('/jira/rest/api/2/project/search')) return send(200, { values: [{ key: 'WEB', name: 'Website' }, { key: 'APP', name: 'Mobile app' }] });
    if (u === '/jira/rest/api/2/issue/createmeta/WEB/issuetypes') return send(200, { issueTypes: [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug' }, { id: '3', name: 'Sub-task', subtask: true }] });
    if (u === '/jira/rest/api/2/issue' && req.method === 'POST') return send(201, { id: '100', key: 'WEB-42' });
    if (u === '/jira/rest/api/2/issue/WEB-42/attachments') return send(200, [{ id: '9' }]);
  }
  // GitLab
  if (u.startsWith('/gitlab/')) {
    if (req.headers['private-token'] !== 'gl-token') return send(401, { message: '401 Unauthorized' });
    if (u === '/gitlab/api/v4/user') return send(200, { username: 'devtester' });
    if (u.startsWith('/gitlab/api/v4/projects?')) return send(200, [{ id: 7, path_with_namespace: 'team/website' }]);
    if (u === '/gitlab/api/v4/projects/7/uploads') return send(201, { markdown: '![screenshot](/uploads/abc/screenshot.png)' });
    if (u === '/gitlab/api/v4/projects/7/issues') return send(201, { iid: 12, web_url: `${FAKE}/gitlab/team/website/-/issues/12` });
  }
  // Slack webhook
  if (u === '/slack/hook') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  // Notion
  if (u.startsWith('/v1/')) {
    if (req.headers.authorization !== 'Bearer ntn_secret') return send(401, { message: 'API token is invalid.' });
    if (u === '/v1/users/me') return send(200, { bot: { workspace_name: 'Team space' } });
    if (u === '/v1/search') return send(200, { results: [{ id: 'db1', title: [{ plain_text: 'Bugs' }] }] });
    if (u === '/v1/databases/db1') return send(200, { properties: { Bug: { type: 'title' }, Link: { type: 'url' } } });
    if (u === '/v1/pages') return send(200, { id: 'page1', url: 'https://www.notion.so/page1' });
  }
  send(404, { message: `mock: no route for ${req.method} ${u}` });
});
await new Promise((r) => mock.listen(MOCK, r));

// ---------------------------------------------------------------- a throwaway BugSnap server
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bugsnap-int-'));
const server = spawn(process.execPath, [path.join(here, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, NOTION_API_BASE: FAKE, BUGSNAP_TEST_SLACK: `${FAKE}/slack/`, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50; i++) {
  if (await fetch(`${BASE}/healthz`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 100));
}

const api = async (method, p, body) => {
  const res = await fetch(`${BASE}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

let failed = false;
try {
  // A screenshot to send (a 1x1 PNG is enough).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const created = await api('POST', '/api/recordings', { meta: { title: 'Checkout page', type: 'screenshot' } });
  const id = created.data.id;
  await fetch(`${BASE}/api/recordings/${id}/image`, { method: 'PUT', body: png });
  await api('POST', `/api/recordings/${id}/finalize-shot`, { width: 1, height: 1, title: 'Checkout page' });

  // Nothing connected yet.
  let st = await api('GET', '/api/integrations');
  assert.deepEqual(Object.keys(st.data), ['jira', 'gitlab', 'slack', 'notion']);
  assert.ok(Object.values(st.data).every((t) => !t.connected));
  const notConnected = await api('POST', `/api/recordings/${id}/send/jira`, { target: 'WEB', title: 'x', body: 'y' });
  assert.equal(notConnected.status, 409);
  assert.match(notConnected.data.error, /not connected/);

  // Wrong token: friendly error, nothing saved.
  const bad = await api('PUT', '/api/integrations/jira', { site: `${FAKE}/jira`, email: 'me@team.dev', token: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Jira refused the token/);

  // Connect all four.
  const j = await api('PUT', '/api/integrations/jira', { site: `${FAKE}/jira/`, email: 'me@team.dev', token: 'jira-token' });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  assert.equal(j.data.account, 'Dev Tester');
  assert.equal(j.data.site, `${FAKE}/jira`);
  const g = await api('PUT', '/api/integrations/gitlab', { baseUrl: `${FAKE}/gitlab`, token: 'gl-token' });
  assert.equal(g.data.account, '@devtester');
  const badHook = await api('PUT', '/api/integrations/slack', { webhook: 'https://example.com/hook' });
  assert.equal(badHook.status, 400);
  const s = await api('PUT', '/api/integrations/slack', { webhook: `${FAKE}/slack/hook`, channel: 'qa-bugs' });
  assert.equal(s.data.account, '#qa-bugs');
  const n = await api('PUT', '/api/integrations/notion', { token: 'ntn_secret' });
  assert.equal(n.data.account, 'Team space');

  // Tokens never come back to the browser.
  st = await api('GET', '/api/integrations');
  const visible = JSON.stringify(st.data);
  for (const secret of ['jira-token', 'gl-token', 'ntn_secret', '/slack/hook']) assert.ok(!visible.includes(secret), `${secret} leaked`);
  // Saving again without a token keeps the saved one.
  const again = await api('PUT', '/api/integrations/jira', { site: `${FAKE}/jira`, email: 'me@team.dev' });
  assert.equal(again.status, 200);

  // Targets and Jira issue types (sub-tasks left out).
  assert.deepEqual((await api('GET', '/api/integrations/jira/targets')).data.map((t) => t.id), ['WEB', 'APP']);
  assert.deepEqual((await api('GET', '/api/integrations/jira/meta?target=WEB')).data.issueTypes.map((t) => t.name), ['Task', 'Bug']);
  assert.deepEqual((await api('GET', '/api/integrations/gitlab/targets?q=web')).data, [{ id: '7', name: 'team/website' }]);
  assert.deepEqual((await api('GET', '/api/integrations/notion/targets')).data, [{ id: 'db1', name: 'Bugs' }]);

  // Draft to start from.
  const draft = await api('GET', `/api/recordings/${id}/draft`);
  assert.equal(draft.data.title, 'Checkout page');
  assert.match(draft.data.body, /\*\*Screenshot:\*\* http/);
  const body = '## Steps to reproduce\n1. Open **Checkout**\n2. Click [Pay](https://shop.test/pay)\n\n## Actual result\nNothing happens `TypeError`';

  // Jira: issue (Bug type picked automatically), wiki markup, screenshot attached.
  seen.length = 0;
  const sj = await api('POST', `/api/recordings/${id}/send/jira`, { target: 'WEB', title: 'Checkout - Pay does nothing', body });
  assert.equal(sj.status, 201, JSON.stringify(sj.data));
  assert.equal(sj.data.url, `${FAKE}/jira/browse/WEB-42`);
  const issueReq = seen.find((r) => r.path === '/jira/rest/api/2/issue');
  assert.equal(issueReq.body.fields.issuetype.id, '2');
  assert.equal(issueReq.body.fields.summary, 'Checkout - Pay does nothing');
  assert.match(issueReq.body.fields.description, /h2\. Steps to reproduce/);
  assert.match(issueReq.body.fields.description, /# Open \*Checkout\*/);
  assert.match(issueReq.body.fields.description, /\[Pay\|https:\/\/shop\.test\/pay\]/);
  assert.match(issueReq.body.fields.description, /\{\{TypeError\}\}/);
  assert.match(issueReq.body.fields.description, /!screenshot\.png\|thumbnail!/);
  const attach = seen.find((r) => r.path.endsWith('/attachments'));
  assert.equal(attach.headers['x-atlassian-token'], 'no-check');
  assert.match(attach.body, /filename="screenshot\.png"/);

  // GitLab: image uploaded first, then the issue with it under Attachments.
  seen.length = 0;
  const sg = await api('POST', `/api/recordings/${id}/send/gitlab`, { target: '7', title: 'Pay does nothing', body, extra: { labels: 'bug' } });
  assert.equal(sg.status, 201, JSON.stringify(sg.data));
  assert.equal(sg.data.label, '#12');
  const glIssue = seen.find((r) => r.path === '/gitlab/api/v4/projects/7/issues');
  assert.match(glIssue.body.description, /## Attachments\n!\[screenshot\]\(\/uploads\/abc\/screenshot\.png\)/);
  assert.equal(glIssue.body.labels, 'bug');

  // Slack: header + mrkdwn section.
  seen.length = 0;
  const ss = await api('POST', `/api/recordings/${id}/send/slack`, { title: 'Pay does nothing', body });
  assert.equal(ss.status, 201, JSON.stringify(ss.data));
  const msg = seen.find((r) => r.path === '/slack/hook').body;
  assert.equal(msg.blocks[0].type, 'header');
  assert.match(msg.blocks[1].text.text, /\*Steps to reproduce\*/);
  assert.match(msg.blocks[1].text.text, /<https:\/\/shop\.test\/pay\|Pay>/);

  // Notion: page in the database, title in its title column, blocks for the body.
  seen.length = 0;
  const sn = await api('POST', `/api/recordings/${id}/send/notion`, { target: 'db1', title: 'Pay does nothing', body });
  assert.equal(sn.status, 201, JSON.stringify(sn.data));
  assert.equal(sn.data.url, 'https://www.notion.so/page1');
  const page = seen.find((r) => r.path === '/v1/pages').body;
  assert.equal(page.properties.Bug.title[0].text.content, 'Pay does nothing');
  assert.deepEqual(page.children.slice(0, 3).map((b) => b.type), ['heading_2', 'numbered_list_item', 'numbered_list_item']);
  assert.ok(page.children[1].numbered_list_item.rich_text.some((t) => t.annotations?.bold && t.text.content === 'Checkout'));

  // Everything sent is remembered on the screenshot; the last target is the next default.
  const rec = await api('GET', `/api/recordings/${id}`);
  assert.deepEqual((rec.data.sent || []).map((x) => x.tool), ['notion', 'slack', 'gitlab', 'jira']);
  st = await api('GET', '/api/integrations');
  assert.equal(st.data.jira.defaults.target, 'WEB');

  // Disconnect.
  await api('DELETE', '/api/integrations/slack');
  assert.equal((await api('GET', '/api/integrations')).data.slack.connected, false);
  console.log('integrations-mock: all checks passed');
} catch (err) {
  failed = true;
  console.error(err);
  console.error('--- server log ---\n' + log);
} finally {
  server.kill();
  mock.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exitCode = failed ? 1 : 0;
}

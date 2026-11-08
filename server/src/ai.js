// AI bug reports. The recording's steps, errors, failed requests and environment plus the
// reporter's own description go in; a Markdown issue in the team's template comes out.
//
// Providers (Settings): Claude Code on this computer (your Claude plan, no API key), or an API
// key for Anthropic, OpenAI, Google Gemini or OpenRouter, or local models through Ollama. Claude Code runs in print mode (-p), restricted (no shell or code
// tools), with no MCP servers and no saved session, in an empty working folder.
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Find the Claude Code executable. On Windows the npm "claude" is a .cmd shim; use the real exe. */
export function claudeCommand(configured) {
  if (configured) return configured;
  if (process.platform === 'win32') {
    const exe = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
    const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (existsSync(native)) return native;
  }
  return 'claude';
}

function run(cmd, args, { input = '', timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude took too long to answer. Try again.'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error('Claude Code is not installed on this computer.') : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((errOut || out).trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

export const API_MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (best)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (faster, cheaper)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (cheapest)',
};

const fail = (message, status) => Object.assign(new Error(message), { status });

/**
 * Report writers. "claude-code" uses the CLI on this computer; "anthropic" uses the official
 * SDK; OpenAI, Google Gemini, OpenRouter and Ollama all speak the OpenAI chat-completions
 * format, so one small client serves them (Gemini through its OpenAI-compatible endpoint).
 */
export const PROVIDERS = {
  'claude-code': { name: 'Claude Code', kind: 'cli', needsKey: false, blurb: 'Uses your Claude plan on this computer. No API key.' },
  anthropic: { name: 'Anthropic', kind: 'anthropic', needsKey: true, blurb: 'Claude models with an API key.', keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…' },
  openai: {
    name: 'OpenAI', kind: 'openai', needsKey: true, blurb: 'GPT models with an API key.', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…',
    base: 'https://api.openai.com/v1',
    prefer: [/^gpt-5(\.\d+)?$/, /^gpt-5/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt/],
    exclude: /embed|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|instruct|codex/i,
  },
  google: {
    name: 'Google Gemini', kind: 'openai', needsKey: true, blurb: 'Gemini models with an API key from Google AI Studio.', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    prefer: [/gemini-[\d.]+-pro$/, /gemini-[\d.]+-flash$/, /gemini.*pro/, /gemini/],
    exclude: /embed|aqa|imagen|veo|tts|image|audio|live|learnlm/i,
  },
  openrouter: {
    name: 'OpenRouter', kind: 'openai', needsKey: true, blurb: 'One key for hundreds of models from many providers.', keyUrl: 'https://openrouter.ai/settings/keys', keyHint: 'sk-or-…',
    base: 'https://openrouter.ai/api/v1',
    prefer: [/^anthropic\/claude-sonnet/, /^anthropic\/claude/, /^openai\/gpt-5/, /^google\/gemini.*pro/],
  },
  ollama: { name: 'Ollama', kind: 'openai', needsKey: false, blurb: 'Free open models running on this computer. Nothing leaves your PC.', keyUrl: 'https://ollama.com/download' },
};

/**
 * Settings live in <dataDir>/ai.json (data/ is never committed):
 *   { provider, keys: { anthropic, openai, google, openrouter }, models: { … }, ollamaUrl }
 * Keys are never sent back to the browser, only their last four characters.
 */
export class ReportWriter {
  constructor({ command, model, dataDir, envApiKey }) {
    this.cmd = claudeCommand(command);
    this.model = model || 'sonnet';
    this.file = path.join(dataDir, 'ai.json');
    this.envKeys = { anthropic: envApiKey || '', openai: process.env.OPENAI_API_KEY || '', google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', openrouter: process.env.OPENROUTER_API_KEY || '' };
    this.prefs = { provider: 'claude-code', keys: {}, models: { anthropic: 'claude-opus-5-5' }, ollamaUrl: 'http://localhost:11434' };
    this.busy = Promise.resolve();
    this.cliChecked = null;
  }

  async load() {
    let saved = null;
    try {
      saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      if (this.envKeys.anthropic) this.prefs.provider = 'anthropic';
      return;
    }
    // Earlier versions stored { provider: 'api', apiKey, apiModel } for Anthropic only.
    if (saved.provider === 'api') saved.provider = 'anthropic';
    const keys = { ...(saved.keys || {}) };
    const models = { ...this.prefs.models, ...(saved.models || {}) };
    if (saved.apiKey && !keys.anthropic) keys.anthropic = saved.apiKey;
    if (saved.apiModel && !saved.models?.anthropic) models.anthropic = saved.apiModel;
    this.prefs = { ...this.prefs, provider: PROVIDERS[saved.provider] ? saved.provider : 'claude-code', keys, models, ollamaUrl: saved.ollamaUrl || this.prefs.ollamaUrl };
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Patch: { provider?, keys?: { id: key|'' }, models?: { id: model }, ollamaUrl? } */
  async save(patch = {}) {
    if (patch.provider !== undefined && !PROVIDERS[patch.provider]) throw fail('Unknown provider', 400);
    const next = { ...this.prefs, keys: { ...this.prefs.keys }, models: { ...this.prefs.models } };
    if (patch.provider !== undefined) next.provider = patch.provider;
    for (const [id, key] of Object.entries(patch.keys || {})) {
      if (!PROVIDERS[id]?.needsKey) continue;
      next.keys[id] = String(key || '').trim();
    }
    for (const [id, m] of Object.entries(patch.models || {})) {
      if (!PROVIDERS[id] || id === 'claude-code') continue;
      if (id === 'anthropic' && !API_MODELS[m]) throw fail('Unknown model', 400);
      next.models[id] = String(m || '').slice(0, 200);
    }
    if (typeof patch.ollamaUrl === 'string') {
      const u = patch.ollamaUrl.trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\//.test(u)) throw fail('Ollama address must start with http:// or https://', 400);
      next.ollamaUrl = u || 'http://localhost:11434';
    }
    this.prefs = next;
    await this.persist();
  }

  keyFor(id) {
    return this.prefs.keys[id] || this.envKeys[id] || '';
  }

  baseFor(id) {
    return id === 'ollama' ? `${this.prefs.ollamaUrl}/v1` : PROVIDERS[id].base;
  }

  async cliStatus() {
    if (this.cliChecked && Date.now() - this.cliChecked.at < 60_000) return this.cliChecked.value;
    let value;
    try {
      value = { available: true, version: (await run(this.cmd, ['--version'], { timeoutMs: 15_000 })).trim() };
    } catch (err) {
      value = { available: false, error: err.message };
    }
    this.cliChecked = { at: Date.now(), value };
    return value;
  }

  /** Everything the settings page and the Report tab need. Never returns a key itself. */
  async status() {
    const cli = await this.cliStatus();
    const providers = {};
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const key = p.needsKey ? this.keyFor(id) : '';
      const model = this.prefs.models[id] || '';
      const ready = id === 'claude-code' ? cli.available : p.needsKey ? Boolean(key && model) : Boolean(model);
      providers[id] = {
        id,
        name: p.name,
        blurb: p.blurb,
        needsKey: p.needsKey,
        keyUrl: p.keyUrl || null,
        keyPlaceholder: p.keyHint || null,
        hasKey: Boolean(key),
        keyHint: key ? `…${key.slice(-4)}` : null,
        keyFromEnv: Boolean(p.needsKey && !this.prefs.keys[id] && this.envKeys[id]),
        model,
        fixedModels: id === 'anthropic' ? API_MODELS : null,
        ready,
        ...(id === 'claude-code' ? { version: cli.version || null, error: cli.available ? null : cli.error } : {}),
        ...(id === 'ollama' ? { url: this.prefs.ollamaUrl } : {}),
      };
    }
    const current = providers[this.prefs.provider];
    return {
      provider: this.prefs.provider,
      available: current.ready,
      label: current.model ? `${current.name} · ${current.fixedModels?.[current.model] || current.model}` : current.name,
      error: current.ready ? null : this.notReadyMessage(this.prefs.provider, current),
      providers,
      // Older clients
      claudeCode: cli,
      api: { configured: providers.anthropic.hasKey, keyHint: providers.anthropic.keyHint, model: providers.anthropic.model, models: API_MODELS, fromEnv: providers.anthropic.keyFromEnv },
    };
  }

  notReadyMessage(id, p) {
    if (id === 'claude-code') return p.error || 'Claude Code is not installed.';
    if (p.needsKey && !p.hasKey) return `No ${p.name} API key saved.`;
    if (!p.model) return `Choose a model for ${p.name} in Settings.`;
    return `${p.name} is not ready.`;
  }

  /** Models a provider offers this key, best guesses first. */
  async listModels(id) {
    const p = PROVIDERS[id];
    if (!p) throw fail('Unknown provider', 400);
    if (id === 'claude-code') return [];
    if (id === 'anthropic') return Object.entries(API_MODELS).map(([value, label]) => ({ id: value, label }));
    if (p.needsKey && !this.keyFor(id)) throw fail(`Save a ${p.name} API key first.`, 400);
    const res = await this.openaiFetch(id, 'GET', '/models');
    let ids = (res.data || res.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    if (p.exclude) ids = ids.filter((m) => !p.exclude.test(m));
    ids = [...new Set(ids)];
    const rank = (m) => {
      const i = (p.prefer || []).findIndex((re) => re.test(m));
      return i === -1 ? 99 : i;
    };
    ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return ids.map((m) => ({ id: m, label: m }));
  }

  /** One report at a time keeps usage predictable. */
  write(context) {
    const job = this.busy.then(async () => {
      const out = await this.call(this.prefs.provider, buildPrompt(context), SYSTEM_PROMPT, 16000);
      return { markdown: cleanup(out.text), model: out.model, provider: this.prefs.provider };
    });
    this.busy = job.catch(() => {});
    return job;
  }

  /** Short live check of the chosen (or given) provider. */
  async test(id = this.prefs.provider) {
    const out = await this.call(id, 'Reply with exactly: OK', 'You are a terse assistant.', 50);
    return { ok: true, reply: out.text.slice(0, 40), model: out.model, provider: id };
  }

  async call(id, prompt, system, maxTokens) {
    const p = PROVIDERS[id];
    if (!p) throw fail('Unknown provider', 400);
    if (p.kind === 'cli') return this.callCli(prompt, system);
    if (p.needsKey && !this.keyFor(id)) throw fail(`No ${p.name} API key saved. Add one in Settings.`, 400);
    if (!this.prefs.models[id]) throw fail(`Choose a model for ${p.name} in Settings.`, 400);
    if (p.kind === 'anthropic') return this.callAnthropic(prompt, system, maxTokens);
    return this.callOpenAI(id, prompt, system);
  }

  async callCli(prompt, system) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bugsnap-ai-'));
    try {
      const raw = await run(
        this.cmd,
        ['-p', '--output-format', 'json', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--model', this.model, '--system-prompt', system],
        { input: prompt, cwd, timeoutMs: 150_000 },
      );
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw fail('Claude Code returned something unexpected. Is it signed in? Run "claude" once in a terminal.', 502);
      }
      if (parsed.is_error || !parsed.result) throw fail(parsed.result || 'Claude Code could not write the report. Is it signed in?', 502);
      return { text: parsed.result, model: Object.keys(parsed.modelUsage || {})[0] || this.model };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  async callAnthropic(prompt, system, maxTokens) {
    const client = new Anthropic({ apiKey: this.keyFor('anthropic') });
    const model = this.prefs.models.anthropic || 'claude-opus-5-5';
    let response;
    try {
      // If Opus or Sonnet declines, Anthropic retries on a suitable fallback model in the same
      // call. Haiku 5.5 has no server-side fallback, so it is not requested there.
      const withFallback = model !== 'claude-haiku-5-5';
      response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        // Thinking stays adaptive (the default); medium effort suits a one-page report.
        output_config: { effort: 'medium' },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw fail('The Anthropic API key was not accepted. Check it in Settings.', 400);
      if (error instanceof Anthropic.PermissionDeniedError) throw fail('This Anthropic key is not allowed to use that model.', 400);
      if (error instanceof Anthropic.RateLimitError) throw fail('Anthropic is rate limiting this key. Try again in a minute.', 429);
      if (error instanceof Anthropic.APIConnectionError) throw fail('Cannot reach Anthropic. Check the internet connection.', 503);
      if (error instanceof Anthropic.APIError) throw fail(`Anthropic error ${error.status}: ${error.message}`, 502);
      throw error;
    }
    if (response.stop_reason === 'refusal') throw fail('Claude declined to write this report.', 422);
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (response.stop_reason === 'max_tokens') throw fail('The report was cut off. Try again with a shorter description.', 502);
    if (!text) throw fail('Anthropic returned an empty answer. Try again.', 502);
    return { text, model: response.model };
  }

  /** OpenAI-format HTTP call for OpenAI, Gemini, OpenRouter and Ollama. */
  async openaiFetch(id, method, pathPart, body) {
    const p = PROVIDERS[id];
    const key = this.keyFor(id);
    let res;
    try {
      res = await fetch(`${this.baseFor(id)}${pathPart}`, {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(id === 'openrouter' ? { 'X-Title': 'BugSnap' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(150_000),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw fail(`${p.name} took too long to answer. Try again.`, 504);
      throw fail(id === 'ollama' ? `Cannot reach Ollama at ${this.prefs.ollamaUrl}. Is it running?` : `Cannot reach ${p.name}. Check the internet connection.`, 503);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const detail = data.error?.message || data.message || (Array.isArray(data) && data[0]?.error?.message) || res.statusText;
    if (res.status === 401 || res.status === 403) throw fail(`${p.name} did not accept the API key. Check it in Settings.`, 400);
    if (res.status === 404) throw fail(`${p.name} does not know this model. Pick another one in Settings. (${detail})`, 400);
    if (res.status === 429) throw fail(`${p.name} is rate limiting this key, or it has no credit left. (${detail})`, 429);
    if (res.status === 402) throw fail(`${p.name} account has no credit left.`, 402);
    throw fail(`${p.name} error ${res.status}: ${detail}`, 502);
  }

  async callOpenAI(id, prompt, system) {
    const model = this.prefs.models[id];
    const data = await this.openaiFetch(id, 'POST', '/chat/completions', {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const text = (Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content || '')).trim();
    if (choice?.finish_reason === 'length') throw fail('The report was cut off. Try again, or choose a model with longer answers.', 502);
    if (!text) throw fail(`${PROVIDERS[id].name} returned an empty answer. Try again or pick another model.`, 502);
    return { text, model: data.model || model };
  }
}

function cleanup(text) {
  // Strip a wrapping code fence if the model added one.
  return text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1').trim();
}

const SYSTEM_PROMPT = `You write bug reports and improvement suggestions for a software team from a screen recording's captured data and the reporter's own words.

Output ONLY the report in Markdown, exactly in this structure, with no preamble and no code fence:

# <Title>

## Description
<2-4 plain sentences: what is wrong (or what could be better) and why it matters to the user.>

## Preconditions
- <starting page / state needed>
- <browser and OS, window or viewport size>
- <logged-in state, data or settings: include this line only when the recording or reporter shows it; never write "unknown" or "not shown">

## Steps to reproduce
1. <one short, human action per step>

## Attachments
- Recording: <link>   (write "Screenshot: <link>" instead when the capture is a screenshot)
- <the key evidence, each with its time and a link to that moment, e.g. "Console error at 0:05: TypeError: … (<link with ?t=5 or &t=5>)" or "POST /api/trials returned 500 at 0:05">

## Actual result
<what happened>

## Expected result
<what should happen>

Title rules:
- Bug: "<Page or feature name> - <short problem statement>", e.g. "Pricing Page - User cannot start a free trial". Capitalise the page name like a title; keep it under about 80 characters.
- Suggestion: "[suggestion] <Page or feature name> - It would be better to <improvement>", e.g. "[suggestion] Pricing page - It would be better to show the yearly price first".
- Name the page the way a user would ("Pricing Page", "Checkout", "Login"), not by URL.

Steps rules:
- Write for a human tester: imperative, short, e.g. "Go to the Pricing page", "Click **Start trial**", "Enter a work email in **Email**".
- Turn the captured technical steps into these. Merge repeated typing into one step. Drop noise (focus changes, duplicate clicks, scrolls) unless it matters.
- Never include CSS selectors. Do not invent steps the recording or the reporter does not support.
- For a screenshot there are no captured steps: write the few steps needed to reach the page shown (from its URL and title) and to see the problem, based on the reporter's description. Mention what the screenshot's annotations point at when the reporter refers to them.
- Keep typed values when they help reproduce (not passwords or hidden values).

Content rules:
- Use the reporter's description as the source of truth for intent and expectation; use the captured data for facts (pages, errors, status codes, timing).
- For a suggestion, "Actual result" is the current behaviour and "Expected result" is the suggested behaviour; still list the steps that show where it applies.
- Only mention console errors or failed requests that plausibly relate to the problem. Quote error messages briefly.
- If the reporter's expectation is not given, state the reasonable expectation implied by the problem.
- Plain, friendly English. No speculation about root causes in code unless the errors make it obvious, then one short sentence in the Description.`;

function buildPrompt(c) {
  const lines = [];
  lines.push(`Report type: ${c.kind === 'suggestion' ? 'Suggestion' : 'Bug'}`);
  lines.push('');
  lines.push("Reporter's description (in their words):");
  lines.push(c.description?.trim() ? c.description.trim() : '(none given: infer from the captured data, and keep the expectation general)');
  lines.push('');
  lines.push(`${c.capture === 'screenshot' ? 'Screenshot' : 'Recording'} link: ${c.link}`);
  if (c.capture !== 'screenshot') lines.push(`Link to a moment: append ${c.link.includes('?') ? '&' : '?'}t=<seconds>`);
  lines.push(`Page title at start: ${c.title || 'unknown'}`);
  lines.push(`Start URL: ${c.startUrl || 'unknown'}`);
  lines.push(c.capture === 'screenshot' ? 'Capture: annotated screenshot of the visible page (no steps or logs are captured for screenshots)' : `Capture: ${c.mode === 'desktop' ? 'screen recording' : 'browser tab recording'}; duration ${c.duration}`);
  lines.push(`Environment: ${c.env}`);
  lines.push('');
  lines.push('Captured steps (time, action):');
  lines.push(...(c.steps.length ? c.steps : ['(none captured)']));
  lines.push('');
  lines.push('Console errors and warnings:');
  lines.push(...(c.console.length ? c.console : ['(none)']));
  lines.push('');
  lines.push('Failed network requests:');
  lines.push(...(c.network.length ? c.network : ['(none)']));
  return lines.join('\n');
}

/** Turn a stored recording into the compact context the model needs. */
export function reportContext({ record, events, link, description, kind }) {
  const meta = record.meta || {};
  const env = meta.env || {};
  const pauses = record.pauses || [];
  const offset = (ts) => {
    let paused = 0;
    for (const p of pauses) {
      if (p.start >= ts) break;
      paused += Math.min(ts, p.end) - p.start;
    }
    return Math.max(0, Math.floor((ts - record.startedAt - paused) / 1000));
  };
  const t = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const at = (e) => {
    const s = offset(e.type === 'network' && e.startedAt ? e.startedAt : e.ts);
    return `[${t(s)} | ${s}s]`;
  };
  const str = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const size = (o) => (o && o.width ? `${o.width}x${o.height}` : 'unknown');
  const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e.ts === 'number').sort((a, b) => a.ts - b.ts);

  const steps = list
    .filter((e) => e.type === 'action' || e.type === 'navigation')
    .slice(0, 120)
    .map((e) => `${at(e)} ${str(e.text || e.action, 200)}${e.type === 'navigation' && e.url ? ` (${str(e.url, 160)})` : ''}`);
  const consoleLines = list
    .filter((e) => e.type === 'console' && (e.level === 'error' || e.level === 'warn'))
    .slice(0, 20)
    .map((e) => `${at(e)} ${e.level}: ${str(e.message, 300)}${e.source ? ` (${str(e.source, 120)})` : ''}`);
  const network = list
    .filter((e) => e.type === 'network' && (Number(e.status) === 0 || Number(e.status) >= 400))
    .slice(0, 20)
    .map((e) => `${at(e)} ${str(e.method, 10) || 'GET'} ${str(e.url, 200)} -> ${Number(e.status) || 'failed'}${e.durationMs !== undefined ? ` in ${e.durationMs} ms` : ''}${e.error ? ` (${str(e.error, 120)})` : ''}${e.responseBody ? `; response: ${str(e.responseBody, 300)}` : ''}`);

  return {
    kind,
    description,
    link,
    capture: record.type === 'screenshot' ? 'screenshot' : 'recording',
    title: meta.title,
    startUrl: meta.startUrl,
    mode: meta.mode,
    duration: record.durationMs ? t(Math.round(record.durationMs / 1000)) : 'unknown',
    env: [env.browser, env.os || meta.platform?.os, `window ${size(meta.window)}`, `viewport ${size(meta.viewport)}`, env.timeZone].filter(Boolean).join(', '),
    steps,
    console: consoleLines,
    network,
  };
}

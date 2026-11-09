// Sign-in for a hosted BugSnap server.
//
// Each person has a username, a password (for the web pages) and a personal access key (for
// the extension, sent as the X-Upload-Token header). Users live in <dataDir>/users.json with
// scrypt password hashes; sessions are signed cookies, so nothing else needs storing.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const COOKIE = 'bugsnap_session';
const SESSION_DAYS = 30;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class Auth {
  constructor({ dataDir, required, legacyToken }) {
    this.file = path.join(dataDir, 'users.json');
    this.secretFile = path.join(dataDir, 'session.key');
    this.required = Boolean(required);
    this.legacyToken = legacyToken || '';
    this.users = [];
    this.secret = null;
    this.failures = new Map(); // ip -> { count, until }
  }

  async load() {
    try {
      this.users = JSON.parse(await fs.readFile(this.file, 'utf8')).users || [];
    } catch {
      this.users = [];
    }
    try {
      this.secret = Buffer.from((await fs.readFile(this.secretFile, 'utf8')).trim(), 'base64url');
    } catch {
      this.secret = crypto.randomBytes(32);
      await fs.writeFile(this.secretFile, b64url(this.secret), { mode: 0o600 });
    }
  }

  /** Sign-in is on when asked for (REQUIRE_LOGIN=1) or as soon as any user exists. */
  get enabled() {
    return this.required || this.users.length > 0;
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  static newKey() {
    return `bsk_${b64url(crypto.randomBytes(24))}`;
  }

  find(name) {
    return this.users.find((u) => u.name.toLowerCase() === String(name || '').trim().toLowerCase());
  }

  /** Add a person, or set a new password for an existing one. Returns their access key. */
  async setUser(name, password) {
    const clean = String(name || '').trim();
    if (!/^[\w.@-]{2,40}$/.test(clean)) throw new Error('Use 2-40 letters, numbers, dots, dashes or underscores for the name.');
    if (String(password || '').length < 10) throw new Error('Use a password of at least 10 characters.');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt);
    let user = this.find(clean);
    if (!user) {
      user = { name: clean, key: Auth.newKey(), createdAt: new Date().toISOString() };
      this.users.push(user);
    }
    user.salt = b64url(salt);
    user.hash = b64url(hash);
    user.passwordSetAt = new Date().toISOString();
    await this.persist();
    return user.key;
  }

  async newKeyFor(name) {
    const user = this.find(name);
    if (!user) throw new Error(`No user called ${name}`);
    user.key = Auth.newKey();
    await this.persist();
    return user.key;
  }

  async remove(name) {
    const before = this.users.length;
    this.users = this.users.filter((u) => u !== this.find(name));
    if (this.users.length === before) throw new Error(`No user called ${name}`);
    await this.persist();
  }

  async checkPassword(name, password) {
    const user = this.find(name);
    // Same work whether or not the user exists, so timing does not reveal names.
    const salt = user ? Buffer.from(user.salt, 'base64url') : Buffer.alloc(16);
    const hash = await scrypt(password, salt);
    return user && safeEqual(b64url(hash), user.hash) ? user : null;
  }

  userForKey(key) {
    if (!key) return null;
    if (this.legacyToken && safeEqual(key, this.legacyToken)) return { name: 'upload-token' };
    return this.users.find((u) => safeEqual(u.key, key)) || null;
  }

  // ---- sessions (signed cookie: name.expiry.signature)

  sign(text) {
    return b64url(crypto.createHmac('sha256', this.secret).update(text).digest());
  }

  sessionValue(user) {
    const body = `${b64url(user.name)}.${Date.now() + SESSION_DAYS * 864e5}`;
    return `${body}.${this.sign(body)}`;
  }

  userForCookie(header) {
    const raw = String(header || '')
      .split(/;\s*/)
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [name, exp, sig] = raw.split('.');
    if (!name || !exp || !sig || !safeEqual(sig, this.sign(`${name}.${exp}`)) || Number(exp) < Date.now()) return null;
    return this.find(Buffer.from(name, 'base64url').toString()) || null;
  }

  cookie(value, secure, maxAgeDays = SESSION_DAYS) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(maxAgeDays * 86400)}${secure ? '; Secure' : ''}`;
  }

  // ---- slow down password guessing: 8 failures per address, then 15 minutes' wait

  blocked(ip) {
    const f = this.failures.get(ip);
    return Boolean(f && f.count >= 8 && f.until > Date.now());
  }

  failed(ip) {
    const f = this.failures.get(ip);
    const fresh = !f || f.until < Date.now();
    this.failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60e3 });
  }

  succeeded(ip) {
    this.failures.delete(ip);
  }
}

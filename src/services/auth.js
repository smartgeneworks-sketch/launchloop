// Accounts: email + password and Google sign-in, with server-side sessions in an HttpOnly cookie.
// Sign-up is gated so the dashboard stays private: a new account needs the team access code
// (APP_API_TOKEN) unless its email is on SIGNUP_ALLOWED_EMAILS. Bearer APP_API_TOKEN still works for scripts.
import crypto from 'node:crypto';
import { HttpError, timingSafeEqualStr } from '../lib/util.js';

const YEAR = 365 * 24 * 3600;
const DAY = 24 * 3600;
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

export function readCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
export const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket?.encrypted;
export const baseUrlOf = (req) => `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
/** Only same-site relative paths, never "//evil.com". */
export const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) && !n.includes('\\') ? n : '/');

export class Auth {
  constructor({ db, config, notifier, fetchImpl = (...a) => fetch(...a) }) {
    this.db = db;
    this.config = config;
    this.env = config.env || {};
    this.notifier = notifier;
    this.fetch = fetchImpl;
    db.raw.exec(AUTH_SCHEMA);
    this.secret = crypto.createHash('sha256').update(`launchloop-auth:${this.env.AUTH_SECRET || config.appApiToken || crypto.randomBytes(32).toString('hex')}`).digest();
    this.hits = new Map();
  }

  // ------------------------------------------------------------ policy
  get required() {
    return !!this.config.appApiToken;
  }
  get google() {
    return !!(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET);
  }
  get emailReset() {
    return !!this.notifier?.providers?.().email.configured;
  }
  publicConfig() {
    return { authRequired: this.required, google: this.google, emailReset: this.emailReset, signupNeedsCode: this.required, hasUsers: !!this.db.scalar('SELECT COUNT(*) FROM users') };
  }
  codeOk(code) {
    return !this.required || (!!code && timingSafeEqualStr(String(code).trim(), this.config.appApiToken));
  }
  emailAllowlisted(email) {
    const list = String(this.env.SIGNUP_ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return list.some((e) => (e.startsWith('@') ? email.endsWith(e) : email === e));
  }
  limit(key, max, windowSec) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowSec * 1000);
    if (arr.length >= max) throw new HttpError(429, 'Too many attempts — wait a few minutes and try again');
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear();
  }

  // ------------------------------------------------------------ passwords
  hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
  }
  verifyPassword(pw, stored) {
    const [alg, n, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(want, got);
  }
  static checkPassword(pw) {
    pw = String(pw || '');
    if (pw.length < 8) throw new HttpError(400, 'Use at least 8 characters for your password');
    if (pw.length > 200) throw new HttpError(400, 'That password is too long');
    if (!/[A-Za-z]/.test(pw) || !/[0-9\W_]/.test(pw)) throw new HttpError(400, 'Mix letters with a number or symbol');
  }
  static normEmail(e) {
    const email = String(e || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    return email;
  }

  // ------------------------------------------------------------ users & sessions
  publicUser(u) {
    return u && { id: u.id, email: u.email, name: u.name || u.email.split('@')[0], role: u.role, avatar: u.avatar || null, google: !!u.google_sub, password: !!u.password_hash };
  }
  createUser({ email, name, password, googleSub, avatar }) {
    const role = this.db.scalar('SELECT COUNT(*) FROM users') ? 'member' : 'owner';
    const uid = id('usr');
    this.db.run('INSERT INTO users (id, email, name, password_hash, google_sub, avatar, role, created_at) VALUES (?,?,?,?,?,?,?,?)', uid, email, name || null, password ? this.hashPassword(password) : null, googleSub || null, avatar || null, role, nowIso());
    return this.db.get(null, 'SELECT * FROM users WHERE id = ?', uid);
  }
  createSession(res, req, user, { remember = true } = {}) {
    const raw = b64url(crypto.randomBytes(32));
    const ttl = remember ? YEAR : DAY;
    this.db.run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)', sha256(raw), user.id, nowIso(), new Date(Date.now() + ttl * 1000).toISOString(), String(req.headers['user-agent'] || '').slice(0, 200));
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
    this.setCookie(res, req, 'll_sid', raw, remember ? ttl : null);
    return raw;
  }
  setCookie(res, req, name, value, maxAge) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (maxAge !== null && maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    if (isHttps(req)) parts.push('Secure');
    const prev = res.getHeader('set-cookie');
    res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
  }
  userFromRequest(req) {
    const raw = readCookie(req, 'll_sid');
    if (!raw) return null;
    const row = this.db.get(null, 'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?', sha256(raw), nowIso());
    return row || null;
  }
  signOut(req, res) {
    const raw = readCookie(req, 'll_sid');
    if (raw) this.db.run('DELETE FROM sessions WHERE id = ?', sha256(raw));
    this.setCookie(res, req, 'll_sid', '', 0);
  }

  // ------------------------------------------------------------ flows
  signup(req, res, { name, email, password, accessCode, remember = true }) {
    this.limit(`signup:${clientIp(req)}`, 10, 3600);
    email = Auth.normEmail(email);
    Auth.checkPassword(password);
    if (!this.codeOk(accessCode) && !this.emailAllowlisted(email)) throw new HttpError(403, accessCode ? 'That access code is not right' : 'Enter your team access code to create an account');
    const existing = this.db.get(null, 'SELECT * FROM users WHERE email = ?', email);
    if (existing) throw new HttpError(409, existing.google_sub && !existing.password_hash ? 'This email already has an account — use “Continue with Google”' : 'This email already has an account — sign in instead');
    const user = this.createUser({ email, name: String(name || '').trim().slice(0, 80), password });
    this.createSession(res, req, user, { remember });
    return this.publicUser(user);
  }
  signin(req, res, { email, password, remember = true }) {
    email = Auth.normEmail(email);
    this.limit(`signin:${clientIp(req)}:${email}`, 8, 900);
    this.limit(`signin-ip:${clientIp(req)}`, 30, 900);
    const user = this.db.get(null, 'SELECT * FROM users WHERE email = ?', email);
    if (user && !user.password_hash && user.google_sub) throw new HttpError(400, 'This account uses Google — click “Continue with Google”');
    if (!user || !this.verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
    this.createSession(res, req, user, { remember });
    return this.publicUser(user);
  }
  async forgot(req, { email }) {
    email = Auth.normEmail(email);
    this.limit(`forgot:${clientIp(req)}`, 5, 900);
    const user = this.db.get(null, 'SELECT * FROM users WHERE email = ?', email);
    if (!this.emailReset) return { emailSent: false };
    if (user) {
      const raw = b64url(crypto.randomBytes(32));
      this.db.run('INSERT INTO password_resets (id, user_id, expires_at) VALUES (?,?,?)', sha256(raw), user.id, new Date(Date.now() + 3600 * 1000).toISOString());
      const link = `${baseUrlOf(req)}/reset-password?token=${raw}`;
      await this.notifier.sendEmail(email, { subject: 'Reset your LaunchLoop password', title: 'Reset your password', lines: ['Someone (hopefully you) asked to reset your LaunchLoop password. The link works for one hour.', 'If this wasn’t you, ignore this email — your password stays the same.'], link, linkLabel: 'Choose a new password', footer: 'You get this because a password reset was requested for your LaunchLoop account.' });
    }
    return { emailSent: true }; // same answer either way, so nobody can probe which emails have accounts
  }
  reset(req, res, { token, password }) {
    this.limit(`reset:${clientIp(req)}`, 10, 900);
    Auth.checkPassword(password);
    const row = this.db.get(null, 'SELECT * FROM password_resets WHERE id = ? AND used_at IS NULL AND expires_at > ?', sha256(token), nowIso());
    if (!row) throw new HttpError(400, 'This reset link has expired or was already used — ask for a new one');
    this.db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), row.id);
    return this.setPasswordAndSignIn(req, res, row.user_id, password);
  }
  resetWithCode(req, res, { email, accessCode, password }) {
    this.limit(`reset-code:${clientIp(req)}`, 10, 900);
    email = Auth.normEmail(email);
    Auth.checkPassword(password);
    if (!this.required || !this.codeOk(accessCode)) throw new HttpError(403, 'That access code is not right');
    const user = this.db.get(null, 'SELECT * FROM users WHERE email = ?', email);
    if (!user) throw new HttpError(404, 'No account uses that email');
    return this.setPasswordAndSignIn(req, res, user.id, password);
  }
  setPasswordAndSignIn(req, res, userId, password) {
    this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', this.hashPassword(password), userId);
    this.db.run('DELETE FROM sessions WHERE user_id = ?', userId); // sign out everywhere else
    const user = this.db.get(null, 'SELECT * FROM users WHERE id = ?', userId);
    this.createSession(res, req, user, { remember: true });
    return this.publicUser(user);
  }

  // ------------------------------------------------------------ signed short-lived cookies (Google flow)
  sign(obj) {
    const body = b64url(JSON.stringify(obj));
    return `${body}.${b64url(crypto.createHmac('sha256', this.secret).update(body).digest())}`;
  }
  unsign(v) {
    const [body, mac] = String(v || '').split('.');
    if (!body || !mac) return null;
    const want = b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
    if (!timingSafeEqualStr(mac, want)) return null;
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    return obj.exp > Date.now() ? obj : null;
  }

  // ------------------------------------------------------------ Google (OAuth 2.0 authorization code flow)
  redirectUri(req) {
    return this.env.GOOGLE_REDIRECT_URI || `${baseUrlOf(req)}/api/auth/google/callback`;
  }
  /** Remember (for 10 minutes) that the sign-up page supplied a valid access code before going to Google. */
  googlePrepare(req, res, { accessCode }) {
    this.limit(`gprep:${clientIp(req)}`, 10, 900);
    if (accessCode && !this.codeOk(accessCode)) throw new HttpError(403, 'That access code is not right');
    this.setCookie(res, req, 'll_gcode', this.sign({ ok: !!accessCode, exp: Date.now() + 600_000 }), 600);
    return { ok: true };
  }
  googleStartUrl(req, res, { next, mode }) {
    if (!this.google) return null;
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const pre = this.unsign(readCookie(req, 'll_gcode'));
    this.setCookie(res, req, 'll_gstate', this.sign({ state, nonce, next: safeNext(next), mode: mode === 'signup' ? 'signup' : 'signin', code: !!pre?.ok, exp: Date.now() + 600_000 }), 600);
    this.setCookie(res, req, 'll_gcode', '', 0);
    const q = new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, redirect_uri: this.redirectUri(req), response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  /** Returns { redirect } — where to send the browser next. */
  async googleCallback(req, res, q) {
    const fail = (error, mode = 'signin', extra = '') => ({ redirect: `/${mode}?error=${error}${extra}` });
    const st = this.unsign(readCookie(req, 'll_gstate'));
    this.setCookie(res, req, 'll_gstate', '', 0);
    if (q.error) return fail(q.error === 'access_denied' ? 'google_cancelled' : 'google_failed', st?.mode);
    if (!st || !q.state || !timingSafeEqualStr(q.state, st.state)) return fail('google_expired', st?.mode);
    let claims;
    try {
      const r = await this.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: String(q.code || ''), client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, redirect_uri: this.redirectUri(req), grant_type: 'authorization_code' }),
      });
      const tok = await r.json();
      if (!r.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || `HTTP ${r.status}`);
      // The ID token came straight from Google's token endpoint over TLS in exchange for our client secret,
      // so its signature need not be re-verified (Google's OpenID Connect guidance); the claims are still checked.
      claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
    } catch (e) {
      console.error('Google sign-in failed:', e.message);
      return fail('google_failed', st.mode);
    }
    const okIss = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
    if (!okIss || claims.aud !== this.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || claims.nonce !== st.nonce) return fail('google_failed', st.mode);
    if (!claims.email || claims.email_verified === false) return fail('google_unverified', st.mode);
    const email = String(claims.email).toLowerCase();
    let user = this.db.get(null, 'SELECT * FROM users WHERE google_sub = ?', claims.sub) || this.db.get(null, 'SELECT * FROM users WHERE email = ?', email);
    if (user) {
      // Google has verified this email, so it is safe to link it to an existing account with the same address.
      this.db.run('UPDATE users SET google_sub = ?, avatar = COALESCE(avatar, ?), name = COALESCE(name, ?) WHERE id = ?', claims.sub, claims.picture || null, claims.name || null, user.id);
      user = this.db.get(null, 'SELECT * FROM users WHERE id = ?', user.id);
    } else {
      if (!st.code && !this.emailAllowlisted(email) && this.required) return fail('needs_code', 'signup', `&email=${encodeURIComponent(email)}`);
      user = this.createUser({ email, name: claims.name, googleSub: claims.sub, avatar: claims.picture });
    }
    this.createSession(res, req, user, { remember: true });
    return { redirect: st.next || '/' };
  }
}

// Identity & session security: input validators, password policy, server-side sessions
// (HttpOnly cookie + CSRF token), login throttling and contact masking.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, tx } from '../db.js';
import { AppError } from '../utils/errors.js';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const PROD = process.env.NODE_ENV === 'production';

// ---------------- validators ----------------
const NAME_RE = /^[\p{L}\p{M}'’ -]+$/u;
const charLen = (s) => [...s].length;

/** Returns the trimmed name, or null if invalid. Empty allowed only when optional. */
export function cleanName(v, { required = true, max = 60 } = {}) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return required ? null : '';
  if (charLen(s) > max || !NAME_RE.test(s) || !/\p{L}/u.test(s)) return null;
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function cleanEmail(v) {
  const s = String(v ?? '').trim();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

/** Mock India-only mobile: accepts "+91 98765 43210", "919876543210", "09876543210" or "9876543210". */
export function normalizeMobile(v) {
  let d = String(v ?? '').replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

// A small offline sample of breached/common passwords (a real deployment would query a breach corpus).
const COMPROMISED = new Set([
  'password1234', 'password12345', 'password123456', 'passwordpassword', 'password@123', 'password@1234',
  '123456789012', '1234567890123', '12345678901234', 'qwertyuiop12', 'qwertyuiop123', 'qwerty123456', 'iloveyou1234',
  'welcome12345', 'welcome@1234', 'admin1234567', 'administrator', 'letmein12345', 'abc123456789', 'aaaaaaaaaaaa',
  'monkey123456', 'football1234', 'baseball1234', 'sunshine1234', 'princess1234', 'india@123456', 'changeme1234',
]);

/** Returns null when acceptable, otherwise the user-facing error. Never trims or truncates. */
export function passwordProblem(pw, { email } = {}) {
  const MSG = 'Use 12–128 characters and choose a stronger password.';
  if (typeof pw !== 'string') return MSG;
  const len = charLen(pw);
  if (len < 12 || len > 128) return MSG;
  const lower = pw.toLowerCase();
  if (COMPROMISED.has(lower) || /^(.)\1+$/.test(pw) || /^\d+$/.test(pw)) return MSG;
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return MSG;
  return null;
}

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10); // adaptive hash
export const checkPassword = (pw, hash) => !!hash && bcrypt.compareSync(String(pw ?? ''), hash);

// ---------------- masking ----------------
export function maskEmail(e = '') {
  const [local, domain] = String(e).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}
export const maskMobile = (m = '') => (m ? `+91 ******${String(m).slice(-4)}` : '');

// ---------------- cookies ----------------
export const SESSION_COOKIE = 'vhc_sid';
export const CSRF_COOKIE = 'vhc_csrf';

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { httpOnly = true, maxAgeSec } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (httpOnly) parts.push('HttpOnly');
  if (PROD) parts.push('Secure');
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

// ---------------- sessions ----------------
// Session timing uses real time (not the test clock) so shifting the clock never logs staff out.
export const IDLE_MS = Number(process.env.SESSION_IDLE_MS) || 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

export function createSession(res, req, { subjectId, role, remember = false }) {
  const isStaff = !['customer', 'claimant'].includes(role);
  const remembered = !!remember && !isStaff; // staff sessions never use "remember this device"
  const token = randomToken();
  const csrfToken = randomToken(24);
  const t = Date.now();
  const session = db.insert('sessions', {
    tokenHash: sha256(token), subjectId, role, csrfToken, remembered,
    createdAtMs: t, lastSeenAtMs: t,
    idleMs: remembered ? REMEMBER_MS : IDLE_MS,
    absoluteExpiresAtMs: t + (remembered ? REMEMBER_MS : ABSOLUTE_MS),
    revokedAt: null, ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
  });
  const maxAge = remembered ? Math.floor(REMEMBER_MS / 1000) : undefined;
  res.append('Set-Cookie', cookie(SESSION_COOKIE, token, { maxAgeSec: maxAge }));
  res.append('Set-Cookie', cookie(CSRF_COOKIE, csrfToken, { httpOnly: false, maxAgeSec: maxAge }));
  return { session, csrfToken };
}

export function clearSessionCookies(res) {
  res.append('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAgeSec: 0 }));
  res.append('Set-Cookie', cookie(CSRF_COOKIE, '', { httpOnly: false, maxAgeSec: 0 }));
}

export function sessionPublic(s) {
  return {
    id: s.id, current: false, remembered: s.remembered, createdAt: new Date(s.createdAtMs).toISOString(),
    lastSeenAt: new Date(s.lastSeenAtMs).toISOString(), expiresAt: new Date(Math.min(s.absoluteExpiresAtMs, s.lastSeenAtMs + s.idleMs)).toISOString(),
    userAgent: s.userAgent, ip: s.ip,
  };
}

/** Resolves the session from the cookie; throws 401 for missing/expired/revoked sessions. */
export function resolveSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) throw new AppError(401, 'Please sign in to continue.', { code: 'NO_SESSION' });
  const s = db.findOne('sessions', (x) => x.tokenHash === sha256(token));
  const t = Date.now();
  if (!s || s.revokedAt) throw new AppError(401, 'Your session has ended. Please sign in again.', { code: 'SESSION_REVOKED' });
  if (t > s.absoluteExpiresAtMs || t > s.lastSeenAtMs + s.idleMs) {
    throw new AppError(401, 'Your session has expired. Please sign in again.', { code: 'SESSION_EXPIRED' });
  }
  if (t - s.lastSeenAtMs > TOUCH_EVERY_MS) tx(() => { s.lastSeenAtMs = t; });
  return s;
}

export function revokeSession(s, reason = 'logout') {
  s.revokedAt = new Date().toISOString();
  s.revokedReason = reason;
}
export function revokeAllSessions(subjectId, { exceptId, reason = 'revoked' } = {}) {
  let n = 0;
  for (const s of db.find('sessions', (x) => x.subjectId === subjectId && !x.revokedAt && x.id !== exceptId)) {
    revokeSession(s, reason);
    n++;
  }
  return n;
}

// ---------------- login throttling ----------------
// Mock defaults: 5 failures in 15 minutes lock the email key for 15 minutes; IPs are throttled too.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const IP_MAX_FAILURES = 30;
const ipFailures = new Map();

export function assertNotThrottled(emailKey, ip) {
  const t = Date.now();
  const rec = db.findOne('loginAttempts', (a) => a.key === emailKey);
  if (rec?.lockedUntilMs && rec.lockedUntilMs > t) {
    const mins = Math.ceil((rec.lockedUntilMs - t) / 60000);
    throw new AppError(429, `Too many sign-in attempts. Try again in ${mins} minute(s) or reset your password.`, { code: 'LOCKED', retryAfterMinutes: mins });
  }
  const ipList = (ipFailures.get(ip) || []).filter((x) => t - x < WINDOW_MS);
  if (ipList.length >= IP_MAX_FAILURES) throw new AppError(429, 'Too many sign-in attempts from this network. Try again later.', { code: 'IP_THROTTLED' });
}

export function recordLoginFailure(emailKey, ip) {
  const t = Date.now();
  ipFailures.set(ip, [...(ipFailures.get(ip) || []).filter((x) => t - x < WINDOW_MS), t]);
  let rec = db.findOne('loginAttempts', (a) => a.key === emailKey);
  if (!rec) rec = db.insert('loginAttempts', { key: emailKey, failuresMs: [], lockedUntilMs: null });
  rec.failuresMs = [...rec.failuresMs.filter((x) => t - x < WINDOW_MS), t];
  if (rec.failuresMs.length >= MAX_FAILURES) {
    rec.lockedUntilMs = t + WINDOW_MS;
    rec.failuresMs = [];
  }
}

export function clearLoginFailures(emailKey) {
  const rec = db.findOne('loginAttempts', (a) => a.key === emailKey);
  if (rec) { rec.failuresMs = []; rec.lockedUntilMs = null; }
}

export const resetIpThrottle = () => ipFailures.clear();

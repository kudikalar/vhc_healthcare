// One-time verification challenges (email links and SMS/e-mail OTPs).
// Each challenge is bound to subject + purpose + destination, stored hashed, single-use,
// superseded by a newer challenge of the same purpose, and rate-limited per destination.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now } from '../clock.js';
import { AppError } from '../utils/errors.js';
import { randomToken, sha256 } from './security.js';

export const TTL = {
  email_verify: 24 * 60, email_change: 24 * 60, password_reset: 30, invite: 72 * 60,
  mobile_verify: 5, mobile_change: 5, claimant_access: 5, nominee_change: 5,
}; // minutes
const COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_OTP_FAILURES = 5;
const INVALID = 'The code is invalid or has expired.';

export function assertCanSend(destination) {
  const t = now().getTime();
  const recent = db.find('challenges', (c) => c.destination === destination && t - Date.parse(c.createdAt) < 3600 * 1000);
  const last = recent.reduce((m, c) => Math.max(m, Date.parse(c.createdAt)), 0);
  if (last && t - last < COOLDOWN_MS) {
    throw new AppError(429, 'Please wait before requesting another code.', { retryAfterSeconds: Math.ceil((COOLDOWN_MS - (t - last)) / 1000) });
  }
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    throw new AppError(429, 'Please wait before requesting another code.', { retryAfterSeconds: Math.ceil((3600 * 1000 - (t - Math.min(...recent.map((c) => Date.parse(c.createdAt))))) / 1000) });
  }
}

/** Creates a challenge; returns { challenge, secret }. kind 'link' => long random token, 'otp' => 6 digits. */
export function createChallenge({ subjectId, purpose, destination, kind, meta = {} }) {
  assertCanSend(destination);
  for (const old of db.find('challenges', (c) => c.subjectId === subjectId && c.purpose === purpose && !c.usedAt && !c.supersededAt)) {
    old.supersededAt = now().toISOString();
  }
  const id = `chl_${crypto.randomBytes(8).toString('hex')}`;
  const secret = kind === 'otp' ? String(crypto.randomInt(0, 1000000)).padStart(6, '0') : randomToken();
  const challenge = db.insert('challenges', {
    id, subjectId, purpose, destination, kind, meta,
    secretHash: kind === 'otp' ? sha256(`${id}:${secret}`) : sha256(secret),
    expiresAt: new Date(now().getTime() + TTL[purpose] * 60000).toISOString(),
    usedAt: null, supersededAt: null, failedAttempts: 0,
  });
  if (process.env.DB_IN_MEMORY !== '1') console.log(`[${kind === 'otp' ? 'sms/email' : 'email'}:simulated] ${purpose} -> ${destination}`);
  return { challenge, secret };
}

function assertUsable(c) {
  if (!c || c.usedAt || c.supersededAt || c.expiresAt <= now().toISOString()) return false;
  return true;
}

/** Consumes a link token for one of the given purposes. Throws with `expiredMessage` otherwise. */
export function consumeLink(token, purposes, expiredMessage) {
  const c = token ? db.findOne('challenges', (x) => x.kind === 'link' && x.secretHash === sha256(token)) : null;
  if (!c || !purposes.includes(c.purpose) || !assertUsable(c)) throw new AppError(400, expiredMessage, { code: 'CHALLENGE_INVALID' });
  c.usedAt = now().toISOString();
  return c;
}

/** Peeks at a link token without consuming it (e.g. to show a reset form). */
export function peekLink(token, purposes) {
  const c = token ? db.findOne('challenges', (x) => x.kind === 'link' && x.secretHash === sha256(token)) : null;
  return c && purposes.includes(c.purpose) && assertUsable(c) ? c : null;
}

/**
 * Verifies an OTP. The caller must run this inside tx() and must NOT roll back on failure
 * for the attempt counter to stick — so this function returns { ok, challenge } instead of throwing.
 */
export function checkOtp(challengeId, code, { subjectId, purposes }) {
  const c = db.get('challenges', challengeId);
  if (!c || c.kind !== 'otp' || c.subjectId !== subjectId || !purposes.includes(c.purpose)) return { ok: false, error: INVALID };
  if (!assertUsable(c) || c.failedAttempts >= MAX_OTP_FAILURES) return { ok: false, error: INVALID, challenge: c };
  if (!/^\d{6}$/.test(String(code ?? '').trim()) || sha256(`${c.id}:${String(code).trim()}`) !== c.secretHash) {
    c.failedAttempts++;
    return { ok: false, error: INVALID, challenge: c, attemptsLeft: Math.max(0, MAX_OTP_FAILURES - c.failedAttempts) };
  }
  c.usedAt = now().toISOString();
  return { ok: true, challenge: c };
}

export const challengeView = (c, maskedDestination) => ({
  challengeId: c.id, purpose: c.purpose, destination: maskedDestination, expiresAt: c.expiresAt,
  resendAfterSeconds: 60,
});

// VHC-M01 registration, VHC-M02 verification, VHC-M03 login / recovery / sessions.
import { Router } from 'express';
import { db, tx } from '../db.js';
import { now } from '../clock.js';
import { authenticate } from '../middleware/auth.js';
import { AppError, bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import {
  assertNotThrottled, checkPassword, cleanEmail, cleanName, clearLoginFailures, clearSessionCookies, createSession,
  hashPassword, maskEmail, maskMobile, normalizeMobile, parseCookies, passwordProblem, recordLoginFailure,
  revokeAllSessions, revokeSession, sessionPublic, sha256, SESSION_COOKIE,
} from '../services/security.js';
import { challengeView, checkOtp, consumeLink, createChallenge, peekLink } from '../services/challenges.js';
import { displayName, newCustomerId, PRIVACY_VERSION, publicUser, TERMS_VERSION } from '../services/profile.js';
import { audit, notify } from '../services/audit.js';

const r = Router();
const DEV = process.env.NODE_ENV !== 'production';
const dev = (o) => (DEV ? o : {});
const NEUTRAL_REGISTER = 'If this address can be registered, check your email for next steps.';
const NEUTRAL_RESET = 'If an account exists, we have sent reset instructions.';
const BAD_LOGIN = 'Email or password is incorrect.';
const EXPIRED_LINK = 'This link has expired. Request a new one.';
const PRIVILEGED_KEYS = ['role', 'roles', 'isAdmin', 'admin', 'permissions', 'status', 'emailVerified', 'mobileVerified', 'active'];
const meta = (req) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) });

function sendEmailVerification(u) {
  const { secret } = createChallenge({ subjectId: u.id, purpose: 'email_verify', destination: u.emailLower, kind: 'link' });
  notify(u.id, 'Verify your email', 'Open the verification link we emailed you to activate your account.');
  return secret;
}

// ---------------- M01 registration ----------------
r.post('/register', (req, res) => {
  const b = req.body || {};
  // Public signup always creates a Customer: privileged fields are rejected, never honoured.
  if (PRIVILEGED_KEYS.some((k) => k in b && !(k === 'role' && b.role === 'customer'))) {
    tx(() => audit(null, 'REGISTRATION_PRIVILEGE_INJECTION_BLOCKED', 'user', null, { keys: Object.keys(b).filter((k) => PRIVILEGED_KEYS.includes(k)), ...meta(req) }));
    throw bad('Invalid registration request.');
  }
  const fields = {};
  const firstName = cleanName(b.firstName);
  if (!firstName) fields.firstName = 'Enter your first name.';
  const lastName = cleanName(b.lastName, { required: false });
  if (lastName === null) fields.lastName = 'Use letters, spaces, apostrophes or hyphens.';
  const email = cleanEmail(b.email);
  if (!email) fields.email = 'Enter a valid email address.';
  const mobile = normalizeMobile(b.mobile);
  if (!mobile) fields.mobile = 'Enter a valid 10-digit mobile number.';
  const pw = passwordProblem(b.password, { email });
  if (pw) fields.password = pw;
  if (typeof b.confirmPassword !== 'string' || b.confirmPassword !== b.password) fields.confirmPassword = 'Passwords do not match.';
  if (b.acceptTerms !== true) fields.acceptTerms = 'Accept the terms and acknowledge the privacy notice.';
  if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields });

  const emailLower = email.toLowerCase();
  const existing = db.findOne('users', (u) => u.emailLower === emailLower);
  if (existing) {
    // Neutral response: never reveal whether the email is registered.
    tx(() => {
      if (existing.status === 'Pending Verification') {
        try { sendEmailVerification(existing); } catch { /* rate limited: stay neutral */ }
      } else notify(existing.id, 'Registration attempt', 'Someone tried to register with your email address. If this was you, sign in or reset your password.');
    });
    return res.status(202).json({ message: NEUTRAL_REGISTER });
  }
  const passwordHash = hashPassword(b.password); // never logged, never stored in plain text
  let token;
  tx(() => {
    if (db.findOne('users', (u) => u.emailLower === emailLower)) return; // concurrent duplicate: stay neutral
    const u = db.insert('users', {
      role: 'customer', status: 'Pending Verification', active: true, customerId: newCustomerId(),
      firstName, lastName, name: displayName({ firstName, lastName }), legalName: displayName({ firstName, lastName }),
      email, emailLower, emailVerified: false, mobile, mobileVerified: false, passwordHash, passwordChangedAt: now().toISOString(),
      profile: { address: { country: 'India' } }, communicationPreference: 'email', marketingOptIn: b.marketingOptIn === true, profileVersion: 1,
    });
    const at = now().toISOString();
    db.insert('consents', { userId: u.id, type: 'terms_privacy', termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, granted: true, at, ...meta(req) });
    db.insert('consents', { userId: u.id, type: 'marketing', granted: b.marketingOptIn === true, at, ...meta(req) });
    token = sendEmailVerification(u);
    audit({ id: u.id, role: 'customer', name: u.name }, 'USER_REGISTERED', 'user', u.id, { ...meta(req) });
  });
  res.status(202).json({ message: NEUTRAL_REGISTER, ...dev(token ? { devVerificationToken: token } : {}) });
});

// ---------------- M02 verification ----------------
r.post('/verify-email', (req, res) => {
  const out = tx(() => {
    const c = consumeLink(req.body?.token, ['email_verify', 'email_change'], EXPIRED_LINK);
    const u = db.get('users', c.subjectId);
    if (!u) throw bad(EXPIRED_LINK);
    if (c.purpose === 'email_verify') {
      if (c.destination !== u.emailLower) throw bad(EXPIRED_LINK);
      u.emailVerified = true;
      if (u.status === 'Pending Verification') u.status = 'Active';
      audit({ id: u.id, role: u.role, name: u.name }, 'EMAIL_VERIFIED', 'user', u.id);
      return { message: 'Your email is verified. You can now sign in.', kind: 'verify' };
    }
    // email change: bound to the pending destination it was sent to
    if (!u.pendingEmail || c.destination !== u.pendingEmail.toLowerCase()) throw bad(EXPIRED_LINK);
    if (db.findOne('users', (x) => x.id !== u.id && x.emailLower === c.destination)) throw bad(EXPIRED_LINK);
    const old = u.email;
    u.email = u.pendingEmail;
    u.emailLower = c.destination;
    u.pendingEmail = null;
    u.emailVerified = true;
    audit({ id: u.id, role: u.role, name: u.name }, 'EMAIL_CHANGED', 'user', u.id, { from: maskEmail(old), to: maskEmail(u.email) });
    notify(u.id, 'Email address changed', `Your sign-in email is now ${maskEmail(u.email)}.`);
    return { message: 'Your new email address is verified and is now your sign-in email.', kind: 'change' };
  });
  res.json(out);
});

r.post('/resend-verification', (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email) throw bad('Enter a valid email address.');
  const u = db.findOne('users', (x) => x.emailLower === email.toLowerCase());
  let token = null;
  if (u && u.status === 'Pending Verification') token = tx(() => sendEmailVerification(u)); // 429 propagates (cooldown)
  res.json({ message: 'If this address is awaiting verification, we have sent a new link.', destination: maskEmail(email), resendAfterSeconds: 60, ...dev(token ? { devVerificationToken: token } : {}) });
});

/** Sends an OTP to the user's unverified mobile, or to a pending new mobile number. */
r.post('/mobile/send', authenticate, (req, res) => {
  const u = db.get('users', req.user.id);
  if (!u) throw notFound();
  const purpose = u.pendingMobile ? 'mobile_change' : 'mobile_verify';
  const destination = u.pendingMobile || u.mobile;
  if (purpose === 'mobile_verify' && u.mobileVerified) throw conflict('Your mobile number is already verified.');
  const { challenge, secret } = tx(() => createChallenge({ subjectId: u.id, purpose, destination, kind: 'otp' }));
  res.status(201).json({ ...challengeView(challenge, maskMobile(destination)), ...dev({ devCode: secret }) });
});

r.post('/mobile/verify', authenticate, (req, res) => {
  const u = db.get('users', req.user.id);
  const result = tx(() => {
    const out = checkOtp(req.body?.challengeId, req.body?.code, { subjectId: u.id, purposes: ['mobile_verify', 'mobile_change'] });
    if (!out.ok) return out;
    const c = out.challenge;
    if (c.purpose === 'mobile_change') {
      if (!u.pendingMobile || c.destination !== u.pendingMobile) return { ok: false, error: 'The code is invalid or has expired.' };
      u.mobile = u.pendingMobile;
      u.pendingMobile = null;
    } else if (c.destination !== u.mobile) return { ok: false, error: 'The code is invalid or has expired.' };
    u.mobileVerified = true;
    audit(req.user, c.purpose === 'mobile_change' ? 'MOBILE_CHANGED' : 'MOBILE_VERIFIED', 'user', u.id, { mobile: maskMobile(u.mobile) });
    return out;
  });
  if (!result.ok) throw bad(result.error, { attemptsLeft: result.attemptsLeft });
  res.json({ message: 'Your mobile number is verified.', user: publicUser(u) });
});

// ---------------- M03 login & sessions ----------------
r.post('/login', (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email) throw bad('Enter a valid email address.');
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length === 0) throw bad('Enter your password.');
  const key = email.toLowerCase();
  assertNotThrottled(key, req.ip);
  const u = db.findOne('users', (x) => x.emailLower === key);
  if (!u || !checkPassword(password, u.passwordHash)) {
    tx(() => {
      recordLoginFailure(key, req.ip);
      audit(u ? { id: u.id, role: u.role, name: u.name } : null, 'LOGIN_FAILED', 'user', u?.id || null, meta(req));
    });
    throw new AppError(401, BAD_LOGIN); // identical for unknown email and wrong password
  }
  if (!u.active || u.status === 'Disabled') throw new AppError(403, 'This account is disabled. Contact support.');
  if (u.status !== 'Active') throw new AppError(403, 'Verify your email address before signing in.', { code: 'EMAIL_NOT_VERIFIED' });
  const old = parseCookies(req)[SESSION_COOKIE];
  const out = tx(() => {
    if (old) { const prev = db.findOne('sessions', (s) => s.tokenHash === sha256(old)); if (prev && !prev.revokedAt) revokeSession(prev, 'rotated'); }
    clearLoginFailures(key);
    const { session, csrfToken } = createSession(res, req, { subjectId: u.id, role: u.role, remember: req.body?.rememberDevice === true });
    u.lastLoginAt = now().toISOString();
    audit({ id: u.id, role: u.role, name: u.name }, 'LOGIN_SUCCESS', 'user', u.id, { ...meta(req), remembered: session.remembered });
    return { user: publicUser(u), csrfToken, session: sessionPublic(session) };
  });
  res.json(out);
});

r.post('/logout', authenticate, (req, res) => {
  tx(() => {
    revokeSession(req.session, 'logout');
    audit(req.user, 'LOGOUT', 'user', req.user.id);
  });
  clearSessionCookies(res);
  res.json({ message: 'You have been signed out.' });
});

r.get('/me', authenticate, (req, res) => {
  const user = req.user.role === 'claimant' ? req.user : publicUser(db.get('users', req.user.id));
  res.json({ user, csrfToken: req.session.csrfToken, session: sessionPublic(req.session) });
});

r.get('/sessions', authenticate, (req, res) => {
  const t = Date.now();
  res.json(db.find('sessions', (s) => s.subjectId === req.user.id && !s.revokedAt && t < s.absoluteExpiresAtMs && t < s.lastSeenAtMs + s.idleMs)
    .map((s) => ({ ...sessionPublic(s), current: s.id === req.session.id })));
});

r.post('/sessions/:id/revoke', authenticate, (req, res) => {
  const s = db.findOne('sessions', (x) => x.id === req.params.id && x.subjectId === req.user.id);
  if (!s) throw notFound('Session not found');
  tx(() => { revokeSession(s, 'user_revoked'); audit(req.user, 'SESSION_REVOKED', 'user', req.user.id, { sessionId: s.id }); });
  if (s.id === req.session.id) clearSessionCookies(res);
  res.json({ ok: true });
});

r.post('/change-password', authenticate, (req, res) => {
  const u = db.get('users', req.user.id);
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!checkPassword(currentPassword, u?.passwordHash)) throw bad('Current password is incorrect.');
  const problem = passwordProblem(newPassword, { email: u.email });
  if (problem) throw unprocessable(problem, { fields: { newPassword: problem } });
  if (newPassword !== confirmPassword) throw unprocessable('Passwords do not match.', { fields: { confirmPassword: 'Passwords do not match.' } });
  const hash = hashPassword(newPassword);
  const n = tx(() => {
    u.passwordHash = hash;
    u.passwordChangedAt = now().toISOString();
    const revoked = revokeAllSessions(u.id, { exceptId: req.session.id, reason: 'password_changed' });
    audit(req.user, 'PASSWORD_CHANGED', 'user', u.id, { otherSessionsRevoked: revoked });
    notify(u.id, 'Password changed', 'Your password was changed. Other devices have been signed out.');
    return revoked;
  });
  res.json({ message: 'Password updated. Other sessions were signed out.', otherSessionsRevoked: n });
});

// ---------------- M03 recovery ----------------
r.post('/forgot-password', (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email) throw bad('Enter a valid email address.');
  const u = db.findOne('users', (x) => x.emailLower === email.toLowerCase());
  let token = null;
  if (u && u.active && u.status !== 'Invited') {
    tx(() => {
      try {
        token = createChallenge({ subjectId: u.id, purpose: 'password_reset', destination: u.emailLower, kind: 'link' }).secret;
        audit({ id: u.id, role: u.role, name: u.name }, 'PASSWORD_RESET_REQUESTED', 'user', u.id, meta(req));
      } catch { /* rate limited — the response stays neutral */ }
    });
  }
  res.json({ message: NEUTRAL_RESET, ...dev(token ? { devResetToken: token } : {}) });
});

r.get('/reset-password/check', (req, res) => {
  const c = peekLink(req.query.token, ['password_reset']);
  if (!c) throw bad('This reset link is invalid or expired.');
  res.json({ valid: true, expiresAt: c.expiresAt });
});

r.post('/reset-password', (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  const peek = peekLink(token, ['password_reset']);
  if (!peek) throw bad('This reset link is invalid or expired.');
  const u = db.get('users', peek.subjectId);
  const problem = passwordProblem(password, { email: u?.email });
  if (problem) throw unprocessable(problem, { fields: { password: problem } });
  if (password !== confirmPassword) throw unprocessable('Passwords do not match.', { fields: { confirmPassword: 'Passwords do not match.' } });
  const hash = hashPassword(password);
  tx(() => {
    consumeLink(token, ['password_reset'], 'This reset link is invalid or expired.');
    u.passwordHash = hash;
    u.passwordChangedAt = now().toISOString();
    u.emailVerified = true; // the reset link proves control of the email address
    if (u.status === 'Pending Verification') u.status = 'Active';
    const n = revokeAllSessions(u.id, { reason: 'password_reset' });
    clearLoginFailures(u.emailLower);
    audit({ id: u.id, role: u.role, name: u.name }, 'PASSWORD_RESET', 'user', u.id, { sessionsRevoked: n, ...meta(req) });
    notify(u.id, 'Password reset', 'Your password was reset and all devices were signed out.');
  });
  res.json({ message: 'Your password has been reset. Sign in with your new password.' });
});

// ---------------- staff invitations ----------------
r.get('/invite/check', (req, res) => {
  const c = peekLink(req.query.token, ['invite']);
  if (!c) throw bad('This invitation is invalid or expired.');
  const u = db.get('users', c.subjectId);
  res.json({ valid: true, name: u.name, email: maskEmail(u.email), role: u.role });
});

r.post('/accept-invite', (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  const peek = peekLink(token, ['invite']);
  if (!peek) throw bad('This invitation is invalid or expired.');
  const u = db.get('users', peek.subjectId);
  const problem = passwordProblem(password, { email: u.email });
  if (problem) throw unprocessable(problem, { fields: { password: problem } });
  if (password !== confirmPassword) throw unprocessable('Passwords do not match.', { fields: { confirmPassword: 'Passwords do not match.' } });
  const hash = hashPassword(password);
  tx(() => {
    consumeLink(token, ['invite'], 'This invitation is invalid or expired.');
    Object.assign(u, { passwordHash: hash, passwordChangedAt: now().toISOString(), emailVerified: true, status: 'Active' });
    audit({ id: u.id, role: u.role, name: u.name }, 'INVITATION_ACCEPTED', 'user', u.id);
  });
  res.json({ message: 'Your account is ready. Sign in to continue.' });
});

export default r;

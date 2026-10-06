// Cookie-session authentication with CSRF protection for state-changing requests.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { AppError, forbidden } from '../utils/errors.js';
import { resolveSession } from '../services/security.js';

export const ROLES = ['customer', 'claimant', 'agent', 'underwriter', 'claims_officer', 'admin'];
export const STAFF = ['agent', 'underwriter', 'claims_officer', 'admin'];
export const isStaff = (u) => STAFF.includes(u?.role);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function principal(session) {
  if (session.role === 'claimant') {
    const acc = db.get('claimantAccounts', session.subjectId);
    if (!acc || !acc.verified) throw new AppError(401, 'Please verify again to continue.', { code: 'SESSION_REVOKED' });
    return { id: acc.id, role: 'claimant', name: acc.name, email: acc.email, claimIds: acc.claimIds, policyId: acc.policyId };
  }
  const u = db.get('users', session.subjectId);
  // Disabled or unverified users cannot use or renew sessions.
  if (!u || !u.active || u.status !== 'Active') throw new AppError(401, 'Your session has ended. Please sign in again.', { code: 'SESSION_REVOKED' });
  if (u.role !== session.role) throw new AppError(401, 'Your access has changed. Please sign in again.', { code: 'SESSION_REVOKED' });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

export function authenticate(req, _res, next) {
  try {
    const session = resolveSession(req);
    if (MUTATING.has(req.method) && !safeEqual(req.headers['x-csrf-token'], session.csrfToken)) {
      throw new AppError(403, 'Security check failed. Refresh the page and try again.', { code: 'CSRF' });
    }
    req.session = session;
    req.user = principal(session);
    next();
  } catch (e) {
    next(e);
  }
}

export function optionalAuth(req, _res, next) {
  try {
    const session = resolveSession(req);
    req.session = session;
    req.user = principal(session);
  } catch {
    /* anonymous */
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden());

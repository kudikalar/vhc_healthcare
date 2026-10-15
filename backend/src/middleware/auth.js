// Cookie-session authentication with CSRF protection for state-changing requests.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { AppError, forbidden } from '../utils/errors.js';
import { resolveSession } from '../services/security.js';

// Enterprise role model. Spec role → stored role:
//   SUPER_ADMIN→admin, OPERATIONS_ADMIN→operations_admin, SALES_EXECUTIVE→agent, SALES_MANAGER→sales_manager,
//   CLAIMS_COORDINATOR→claims_officer, FINANCE_MANAGER→finance_manager, SUPPORT_MANAGER/AGENT→support_manager/agent,
//   COMPLIANCE_OFFICER→compliance_officer, AUDITOR→auditor, INSURANCE_PARTNER_ADMIN/USER→insurer_admin/user,
//   HOSPITAL_ADMIN/STAFF→hospital_admin/staff, TPA_ADMIN/AGENT→tpa_admin/agent, CORPORATE_ADMIN/HR→corporate_admin/hr.
// Underwriter is kept from the original application.
/** Internal VHC staff (not partner organisations). */
export const STAFF = [
  'agent', 'underwriter', 'claims_officer', 'admin',
  'operations_admin', 'sales_manager', 'finance_manager', 'support_manager', 'support_agent', 'compliance_officer', 'auditor',
];
/** Partner-organisation roles: every one of these users belongs to exactly one organisation (orgType + orgId). */
export const PARTNER_ROLES = {
  insurer_admin: 'insurer', insurer_user: 'insurer',
  hospital_admin: 'hospital', hospital_staff: 'hospital',
  tpa_admin: 'tpa', tpa_agent: 'tpa',
  corporate_admin: 'employer', corporate_hr: 'employer',
};
/** Collection that holds each organisation type. */
export const ORG_COLLECTION = { insurer: 'insurers', hospital: 'hospitals', tpa: 'tpas', employer: 'employers' };
export const ROLES = ['customer', 'claimant', ...STAFF, ...Object.keys(PARTNER_ROLES)];
export const isStaff = (u) => STAFF.includes(u?.role);
export const isPartner = (u) => !!PARTNER_ROLES[u?.role];
/** Read-only oversight roles may view across the platform but never change records. */
export const READ_ONLY_ROLES = ['auditor', 'compliance_officer'];
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
  const out = { id: u.id, role: u.role, name: u.name, email: u.email };
  if (PARTNER_ROLES[u.role]) {
    // Partner users are always scoped to their own organisation; a missing/suspended org ends access.
    const org = u.orgId && db.get(ORG_COLLECTION[PARTNER_ROLES[u.role]], u.orgId);
    if (!org) throw new AppError(401, 'Your organisation access is not active. Contact VHC support.', { code: 'SESSION_REVOKED' });
    out.orgType = PARTNER_ROLES[u.role];
    out.orgId = u.orgId;
    out.orgName = org.name || org.legalName;
  }
  return out;
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

/** Requires a partner user of the given organisation type (e.g. 'hospital'); admins pass through when allowAdmin. */
export const requireOrg = (orgType, { allowAdmin = true } = {}) => (req, _res, next) => {
  if (allowAdmin && req.user?.role === 'admin') return next();
  return req.user?.orgType === orgType && req.user?.orgId ? next() : next(forbidden());
};

/** Throws 404 unless the record belongs to the caller's organisation (internal staff/admin pass when allowStaff). */
export function assertSameOrg(user, orgId, { allowStaff = true, what = 'Record' } = {}) {
  if (allowStaff && isStaff(user)) return;
  if (!user?.orgId || user.orgId !== orgId) throw new AppError(404, `${what} not found`);
}

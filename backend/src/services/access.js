// Central authorization rules. Unauthorized lookups return 404 so record ids cannot be probed.
import { db } from '../db.js';
import { forbidden, notFound } from '../utils/errors.js';

export const MEDICAL_CATEGORIES = ['medical_report', 'exam_report', 'discharge_summary', 'prescription', 'bill'];

export function assertApplicationAccess(user, app) {
  if (!app) throw notFound('Application not found');
  if (user.role === 'customer' && app.userId === user.id) return app;
  if (['agent', 'underwriter', 'admin'].includes(user.role)) return app;
  throw notFound('Application not found');
}

export function assertPolicyAccess(user, policy) {
  if (!policy) throw notFound('Policy not found');
  if (user.role === 'customer' && policy.userId === user.id) return policy;
  if (['agent', 'underwriter', 'claims_officer', 'admin'].includes(user.role)) return policy;
  throw notFound('Policy not found');
}

export function assertHealthClaimAccess(user, claim) {
  if (!claim) throw notFound('Claim not found');
  if (user.role === 'customer' && claim.userId === user.id) return claim;
  if (['claims_officer', 'admin'].includes(user.role)) return claim;
  throw notFound('Claim not found');
}

export function assertLifeClaimAccess(user, claim) {
  if (!claim) throw notFound('Claim not found');
  if (user.role === 'claimant' && claim.claimantAccountId === user.id) return claim;
  if (['claims_officer', 'admin'].includes(user.role)) return claim;
  throw notFound('Claim not found');
}

const ENTITY = {
  application: ['applications', assertApplicationAccess],
  policy: ['policies', assertPolicyAccess],
  healthClaim: ['healthClaims', assertHealthClaimAccess],
  lifeClaim: ['lifeClaims', assertLifeClaimAccess],
};

/** Returns the entity if the user may attach/view documents on it. */
export function assertEntityAccess(user, entityType, entityId) {
  const def = ENTITY[entityType];
  if (!def) throw notFound('Unknown document owner type');
  return def[1](user, db.get(def[0], entityId));
}

export function assertDocumentAccess(user, doc) {
  if (!doc) throw notFound('Document not found');
  assertEntityAccess(user, doc.entityType, doc.entityId);
  if (user.role === 'agent' && MEDICAL_CATEGORIES.includes(doc.category)) {
    throw forbidden('Medical documents are restricted to underwriting and claims staff');
  }
  return doc;
}

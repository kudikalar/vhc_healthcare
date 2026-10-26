// Data rights, consent and audit oversight (§2, §45).
//
// Customers can request a copy of their data (export) or deletion of their account. Each request goes
// requested → under_review → completed | denied, decided by a compliance officer (the one mutation the
// compliance role performs). Deletion never hard-deletes policies, claims, payments, refunds, consents or
// audit records — those are retained for the legally required period and the customer is told so.
import { db, nextSeq } from '../db.js';
import { now } from '../clock.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { audit, notify } from './audit.js';
import { revokeAllSessions, maskEmail } from './security.js';
import { publicUser } from './profile.js';

export const REQUEST_TYPES = { export: 'Data export (copy of my data)', deletion: 'Account deletion' };

/** What is retained after an account deletion and why (shown to the customer and the reviewer). */
export const RETENTION_RULES = [
  { records: 'Policies and proposal forms', basis: 'Insurance record-keeping obligations (insurer and intermediary records must be kept for the policy life and the regulatory retention period after it ends).' },
  { records: 'Claims and claim documents', basis: 'Needed to defend or settle claims and for regulatory inspection; retained for the statutory period after closure.' },
  { records: 'Payments, refunds and invoices', basis: 'Tax and accounting law (GST / income-tax books of account) and anti-money-laundering record-keeping.' },
  { records: 'Consent records and audit logs', basis: 'Proof that consent was given or withdrawn and of who accessed your data; required for accountability.' },
];

const typeOk = (t) => Object.prototype.hasOwnProperty.call(REQUEST_TYPES, t);

export function createDataRequest(user, { type, reason }) {
  if (!typeOk(type)) throw bad('Choose export or deletion');
  if (db.findOne('dataRequests', (r) => r.userId === user.id && r.type === type && ['requested', 'under_review'].includes(r.status))) {
    throw conflict('You already have an open request of this type');
  }
  const r = db.insert('dataRequests', {
    reference: `DRQ-${String(nextSeq('dataRequest')).padStart(6, '0')}`, userId: user.id, customerName: user.name, customerEmail: maskEmail(user.email),
    type, reason: String(reason || '').trim().slice(0, 1000) || null, status: 'requested',
    history: [{ at: now().toISOString(), status: 'requested', by: user.name }], decision: null,
  });
  audit(user, 'DATA_REQUEST_CREATED', 'dataRequest', r.id, { reference: r.reference, type });
  return r;
}

export function retainedSummary(userId) {
  const count = (c, f = (x) => x.userId === userId) => db.find(c, f).length;
  return {
    policies: count('policies'), applications: count('applications'), healthClaims: count('healthClaims'),
    payments: count('payments'), refunds: count('refunds'), consents: count('consents'),
    activePolicies: db.find('policies', (p) => p.userId === userId && !p.terminatedOn && p.endDate >= now().toISOString().slice(0, 10)).length,
    openClaims: db.find('healthClaims', (c) => c.userId === userId && !['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status)).length,
  };
}

export function requestView(r) {
  return { ...r, typeLabel: REQUEST_TYPES[r.type], retained: r.type === 'deletion' ? retainedSummary(r.userId) : undefined, retentionRules: r.type === 'deletion' ? RETENTION_RULES : undefined };
}

/** Closes the login and erases optional data; regulated records stay (see RETENTION_RULES). */
function eraseAccount(user, actor) {
  const at = now().toISOString();
  user.active = false;
  user.status = 'Closed';
  if (user.marketingOptIn) db.insert('consents', { userId: user.id, type: 'marketing', granted: false, at, source: 'account_deletion' });
  user.marketingOptIn = false;
  user.communicationPreference = 'email';
  user.pendingEmail = null;
  user.pendingMobile = null;
  user.profileHistory = []; // non-essential version snapshots
  for (const m of db.find('familyMembers', (x) => x.userId === user.id && x.status === 'active')) {
    const covered = db.findOne('policies', (p) => p.userId === user.id && (p.members || []).some((pm) => pm.fullName === m.fullName));
    if (!covered) { m.status = 'archived'; m.archivedReason = 'Account deletion request'; db.touch(m); }
  }
  user.erasure = { at, by: actor.name, retained: RETENTION_RULES.map((r) => r.records) };
  db.touch(user);
  revokeAllSessions(user.id, { reason: 'account_closed' });
}

export function decideDataRequest(id, actor, { action, note }) {
  const r = db.get('dataRequests', id);
  if (!r) throw notFound('Request not found');
  const at = now().toISOString();
  if (action === 'start_review') {
    if (r.status !== 'requested') throw conflict(`Request is ${r.status}`);
    r.status = 'under_review';
  } else if (['complete', 'deny'].includes(action)) {
    if (!['requested', 'under_review'].includes(r.status)) throw conflict(`Request is already ${r.status}`);
    const text = String(note || '').trim();
    if (action === 'deny' && !text) throw bad('Explain why the request is denied (the customer sees this)');
    r.status = action === 'complete' ? 'completed' : 'denied';
    r.decision = { action, note: text || null, by: actor.name, at };
    const user = db.get('users', r.userId);
    if (action === 'complete' && r.type === 'export') r.exportAvailableUntil = new Date(now().getTime() + 7 * 86400000).toISOString();
    if (action === 'complete' && r.type === 'deletion' && user) {
      r.retainedAtCompletion = retainedSummary(user.id);
      eraseAccount(user, actor);
    }
    if (user) notify(user.id, `Data request ${r.status}`, action === 'complete'
      ? (r.type === 'export' ? 'Your data export is ready to download from Profile → Privacy & data (available for 7 days).' : 'Your account has been closed. Policies, claims and payment records are retained as required by law.')
      : `Your request was not completed: ${text}`, { link: '/profile?tab=privacy' });
  } else throw bad('action must be start_review, complete or deny');
  r.history.push({ at, status: r.status, by: actor.name, note: note || null });
  db.touch(r);
  audit(actor, 'DATA_REQUEST_DECIDED', 'dataRequest', r.id, { reference: r.reference, action, type: r.type });
  return r;
}

/** Customer's data export (JSON). Only for a completed, unexpired export request. */
export function buildExport(r) {
  if (r.type !== 'export' || r.status !== 'completed') throw conflict('The export is not ready');
  if (r.exportAvailableUntil && r.exportAvailableUntil < now().toISOString()) throw conflict('This export has expired; raise a new request');
  const u = db.get('users', r.userId);
  const mine = (c) => db.find(c, (x) => x.userId === r.userId);
  return {
    generatedAt: now().toISOString(), request: r.reference, note: 'Copy of the personal data Vision Health Care (sandbox) holds about you.',
    profile: publicUser(u), consents: mine('consents'),
    policies: mine('policies').map((p) => ({ policyNumber: p.policyNumber, planName: p.planName, product: p.product, startDate: p.startDate, endDate: p.endDate, insurerName: p.insurerName, members: p.members?.map((m) => ({ fullName: m.fullName, relationship: m.relationship, dob: m.dob })) })),
    applications: mine('applications').map((a) => ({ applicationNumber: a.applicationNumber, planName: a.planName, status: a.status, createdAt: a.createdAt })),
    claims: mine('healthClaims').map((c) => ({ claimNumber: c.claimNumber, status: c.status, admissionDate: c.admissionDate, requestedAmount: c.requestedAmount })),
    payments: mine('payments').map((p) => ({ reference: p.reference, description: p.description, amount: p.amount, status: p.status, createdAt: p.createdAt, card: p.card ? { brand: p.card.brand, last4: p.card.last4 } : undefined })),
    refunds: mine('refunds').map((x) => ({ reference: x.reference, amount: x.amount, status: x.status })),
    supportTickets: mine('supportTickets').map((t) => ({ reference: t.reference, subject: t.subject, status: t.status, createdAt: t.createdAt })),
    familyMembers: mine('familyMembers').map((m) => ({ fullName: m.fullName, relationship: m.relationship, dob: m.dob, status: m.status })),
  };
}

// ---------------------------------------------------------------- oversight views
const ACCESS_ACTIONS = /(DOWNLOAD|ACCESSED|VIEWED|EXPORT|DISCLOS|PROFILE_READ)/;

export function searchAudit({ action, entityType, actor, entityId, from, to, access, limit = 300 } = {}) {
  return db.find('auditLogs', (a) => {
    if (access && !ACCESS_ACTIONS.test(a.action)) return false;
    if (action && !a.action.includes(String(action).toUpperCase())) return false;
    if (entityType && a.entityType !== entityType) return false;
    if (entityId && a.entityId !== entityId) return false;
    if (actor && !`${a.actorName} ${a.actorRole}`.toLowerCase().includes(String(actor).toLowerCase())) return false;
    const d = (a.at || '').slice(0, 10);
    if ((from && d < from) || (to && d > to)) return false;
    return true;
  }).slice(-Math.min(Number(limit) || 300, 2000)).reverse();
}

export function consentRegister({ type } = {}) {
  const users = new Map(db.all('users').map((u) => [u.id, u]));
  return db.find('consents', (c) => !type || c.type === type).sort((a, b) => (b.at || '').localeCompare(a.at || '')).map((c) => {
    const u = users.get(c.userId);
    return { id: c.id, at: c.at, type: c.type, granted: c.granted, termsVersion: c.termsVersion || null, privacyVersion: c.privacyVersion || null, source: c.source || null, userId: c.userId, customerId: u?.customerId || null, name: u?.name || null, email: u ? maskEmail(u.email) : null };
  });
}

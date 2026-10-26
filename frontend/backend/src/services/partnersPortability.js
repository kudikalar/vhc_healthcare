// Partners module — health insurance portability and migration requests (spec §9).
//
//   Submitted → Documents Requested → Under Insurer Review → Approved by Insurer | Rejected by Insurer
// (customers may withdraw before a decision). Only the receiving insurer decides: its insurer_admin users
// through the partner portal, or a VHC admin acting for a synthetic sandbox insurer. A request is never
// shown as approved before the insurer has decided; continuity credit is applied by the insurer.
import { db, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, forbidden, notFound } from '../utils/errors.js';
import { diffDays, isValidDate } from '../utils/dates.js';
import { audit, notify } from './audit.js';
import { distributionStatus } from './insurerHub.js';

export const PORT_STATUS = {
  SUBMITTED: 'Submitted', DOCS: 'Documents Requested', REVIEW: 'Under Insurer Review',
  APPROVED: 'Approved by Insurer', REJECTED: 'Rejected by Insurer', WITHDRAWN: 'Withdrawn',
};
const FINAL = [PORT_STATUS.APPROVED, PORT_STATUS.REJECTED, PORT_STATUS.WITHDRAWN];
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

function push(req, status, actor, note) {
  const from = req.status;
  req.status = status;
  req.history.push({ at: now().toISOString(), from, status, by: actor.name, role: actor.role, note: note || null });
  db.touch(req);
}

/** IRDAI-style timing guidance: portability should be requested 15–60 days before the current policy ends. */
export function timingNote(endDate, at = today()) {
  if (!endDate) return null;
  const days = diffDays(at, endDate);
  if (days < 0) return { ok: false, note: 'The current policy has already ended; the insurer may treat this as a fresh proposal without continuity.' };
  if (days < 15) return { ok: false, note: `Only ${days} day(s) before renewal — insurers usually need at least 15 days; continuity may not be granted.` };
  if (days > 60) return { ok: true, note: `Requested ${days} days before renewal; the insurer usually processes requests in the last 60 days.` };
  return { ok: true, note: `Within the usual 15–60 day window (${days} days before renewal).` };
}

export function createPortability(user, body) {
  const b = body || {};
  const type = b.type === 'migration' ? 'migration' : 'portability';
  const plan = db.get('plans', b.toPlanId);
  if (!plan || plan.product !== 'health' || !plan.active) throw bad('Choose an active health product to move to');
  const dist = distributionStatus(plan);
  if (!dist.allowed) throw conflict(`This product cannot be purchased right now: ${dist.reason}`);
  const rec = { type, userId: user.id, toPlanId: plan.id, toPlanName: plan.name, toInsurerId: plan.insurerId, toInsurerName: plan.insurerName, history: [], documentsRequested: [], customerResponses: [] };
  if (type === 'portability') {
    const f = b.from || {};
    const from = {
      insurerName: str(f.insurerName, 120), policyNumber: str(f.policyNumber, 60), productName: str(f.productName, 120),
      sumInsured: Number.isSafeInteger(f.sumInsured) && f.sumInsured > 0 ? f.sumInsured : null,
      policyEndDate: f.policyEndDate, continuousCoverYears: Number(f.continuousCoverYears), claimsInLastYear: f.claimsInLastYear === true,
    };
    const errors = [];
    if (!from.insurerName) errors.push('Current insurer name is required');
    if (!from.policyNumber) errors.push('Current policy number is required');
    if (!isValidDate(from.policyEndDate)) errors.push('Current policy end date is required (YYYY-MM-DD)');
    if (!Number.isInteger(from.continuousCoverYears) || from.continuousCoverYears < 0 || from.continuousCoverYears > 60) errors.push('Continuous cover years must be a whole number between 0 and 60');
    if (errors.length) throw bad('Please correct the portability details', { errors });
    rec.from = from;
    rec.timing = timingNote(from.policyEndDate);
  } else {
    const pol = db.get('policies', b.fromPolicyId);
    if (!pol || pol.userId !== user.id) throw notFound('Policy not found');
    if (pol.product !== 'health') throw bad('Migration applies to health policies');
    if (pol.planId === plan.id) throw bad('Choose a different product to migrate to');
    if (pol.insurerId !== plan.insurerId) throw bad('Migration is between products of the same insurer; use portability to move to another insurer');
    rec.fromPolicyId = pol.id;
    rec.from = { insurerName: pol.insurerName, policyNumber: pol.policyNumber, productName: pol.planName, sumInsured: pol.coverage, policyEndDate: pol.endDate, continuousCoverYears: Math.max(0, Math.floor(diffDays(pol.continuityStartDate || pol.startDate, today()) / 365)) };
    rec.timing = timingNote(pol.endDate);
  }
  if (db.findOne('portabilityRequests', (x) => x.userId === user.id && x.toPlanId === plan.id && x.from?.policyNumber === rec.from.policyNumber && !FINAL.includes(x.status))) {
    throw conflict('You already have an open request for this policy and product');
  }
  rec.reference = `PRT-${today().slice(0, 4)}-${String(nextSeq('portability')).padStart(6, '0')}`;
  rec.requestedSumInsured = Number.isSafeInteger(b.requestedSumInsured) ? b.requestedSumInsured : rec.from.sumInsured;
  rec.status = PORT_STATUS.SUBMITTED;
  rec.history.push({ at: now().toISOString(), from: null, status: PORT_STATUS.SUBMITTED, by: user.name, role: user.role, note: `${type === 'migration' ? 'Migration' : 'Portability'} request submitted` });
  const saved = db.insert('portabilityRequests', rec);
  audit(user, 'PORTABILITY_REQUESTED', 'portability', saved.id, { reference: saved.reference, type, toPlanId: plan.id });
  for (const u of db.find('users', (x) => x.orgId === plan.insurerId && x.role === 'insurer_admin')) {
    notify(u.id, 'New portability request', `${saved.reference}: ${type} to ${plan.name}.`, { link: '/insurer/portability' });
  }
  return saved;
}

/** Whether `user` may decide on behalf of the receiving insurer. */
export function assertInsurerActor(user, req) {
  if (['insurer_admin', 'insurer_user'].includes(user.role)) {
    if (user.orgId !== req.toInsurerId) throw notFound('Request not found');
    if (user.role !== 'insurer_admin') throw forbidden('Only insurer partner admins can act on portability requests');
    return;
  }
  if (user.role === 'admin') {
    const ins = db.get('insurers', req.toInsurerId);
    if (!ins?.sandbox) throw forbidden('Only the receiving insurer can decide; VHC admins may act only for synthetic sandbox insurers');
    return;
  }
  throw forbidden('Only the receiving insurer can decide on portability');
}

export function insurerAction(user, req, { action, note, reason, documents }) {
  assertInsurerActor(user, req);
  if (FINAL.includes(req.status)) throw conflict(`Request is already ${req.status}`);
  const actor = { id: user.id, name: user.role === 'admin' ? `${user.name} (for ${req.toInsurerName})` : `${user.name} (${user.orgName || req.toInsurerName})`, role: user.role };
  if (action === 'request_documents') {
    const docs = (Array.isArray(documents) ? documents : []).map((d) => str(d, 120)).filter(Boolean);
    if (!docs.length) throw bad('List the documents required');
    if (![PORT_STATUS.SUBMITTED, PORT_STATUS.REVIEW].includes(req.status)) throw conflict(`Documents can be requested while Submitted or Under Insurer Review (now ${req.status})`);
    req.documentsRequested.push(...docs.map((d) => ({ name: d, requestedAt: now().toISOString(), status: 'requested' })));
    push(req, PORT_STATUS.DOCS, actor, `Documents requested: ${docs.join(', ')}${note ? ` — ${str(note, 300)}` : ''}`);
    notify(req.userId, 'Documents needed for portability', `${req.reference}: the insurer needs ${docs.join(', ')}.`, { type: 'warning', link: '/portability' });
  } else if (action === 'start_review') {
    if (req.status !== PORT_STATUS.SUBMITTED) throw conflict('Only submitted requests can move to review');
    push(req, PORT_STATUS.REVIEW, actor, str(note, 300) || 'Insurer review started');
  } else if (action === 'approve') {
    if (req.status !== PORT_STATUS.REVIEW) throw conflict('The insurer must review the request before approving it');
    req.decision = { decision: 'approved', at: now().toISOString(), by: actor.name, note: str(note, 500) || null };
    push(req, PORT_STATUS.APPROVED, actor, str(note, 500) || 'Approved by insurer');
    notify(req.userId, 'Portability approved by insurer', `${req.reference} was approved by ${req.toInsurerName}. Continue with a proposal for ${req.toPlanName}; waiting-period credit is applied by the insurer.`, { type: 'success', link: '/portability' });
  } else if (action === 'reject') {
    if (!str(reason)) throw bad('A reason is required to reject');
    req.decision = { decision: 'rejected', at: now().toISOString(), by: actor.name, reason: str(reason, 500) };
    push(req, PORT_STATUS.REJECTED, actor, `Rejected: ${str(reason, 500)}`);
    notify(req.userId, 'Portability not approved', `${req.reference}: ${str(reason, 300)}`, { type: 'error', link: '/portability' });
  } else throw bad('action must be request_documents, start_review, approve or reject');
  audit(actor, `PORTABILITY_${action.toUpperCase()}`, 'portability', req.id, { status: req.status });
  return req;
}

export function customerAction(user, req, { action, note }) {
  if (req.userId !== user.id) throw notFound('Request not found');
  if (FINAL.includes(req.status)) throw conflict(`Request is already ${req.status}`);
  if (action === 'respond') {
    if (req.status !== PORT_STATUS.DOCS) throw conflict('No documents have been requested');
    if (!str(note)) throw bad('Describe what you have provided (upload files in Documents)');
    req.customerResponses.push({ at: now().toISOString(), note: str(note, 500) });
    req.documentsRequested.forEach((d) => { if (d.status === 'requested') d.status = 'provided'; });
    push(req, PORT_STATUS.REVIEW, user, `Customer responded: ${str(note, 300)}`);
  } else if (action === 'withdraw') {
    push(req, PORT_STATUS.WITHDRAWN, user, str(note, 300) || 'Withdrawn by customer');
  } else throw bad('action must be respond or withdraw');
  audit(user, `PORTABILITY_${action.toUpperCase()}`, 'portability', req.id, { status: req.status });
  return req;
}

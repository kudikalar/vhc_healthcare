// Third-party administrators (TPAs): registry, insurer↔TPA relationships, authorised hospital network
// references, servicing contacts, escalations, and the TPA claim desk.
//
// A TPA sees only health claims on policies of insurers it currently administers. It can add notes,
// recommend documents and record a *recommendation* — never a final decision: adjudication stays with the
// insurer / VHC claims officer through the health-claims workflow.
import { db, newId } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { assertPaise } from '../utils/money.js';
import { audit } from './audit.js';
import { insurerName } from './networkCore.js';

const s = (v) => String(v ?? '').trim();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
export const RECOMMENDATIONS = {
  recommend_approve: 'Recommend approval',
  recommend_partial: 'Recommend partial approval',
  recommend_reject: 'Recommend rejection',
  query: 'Query — more information needed',
};
export const RECOMMENDATION_NOTE = 'TPA recommendation only. The final decision is made by the insurer / authorised claims officer.';

export function getTpa(id) {
  const t = db.get('tpas', id);
  if (!t) throw notFound('TPA not found');
  return t;
}

const relActive = (r, d = today()) => r.status !== 'ended' && r.from <= d && (!r.to || r.to >= d);

/** Insurers the TPA currently administers (relationships; legacy insurerIds when none recorded). */
export function administeredInsurerIds(tpa, d = today()) {
  if (tpa.relationships?.length) return [...new Set(tpa.relationships.filter((r) => relActive(r, d)).map((r) => r.insurerId))];
  return tpa.insurerIds || [];
}

function syncInsurerIds(tpa) {
  tpa.insurerIds = administeredInsurerIds(tpa);
  db.touch(tpa);
}

export function addRelationship(tpa, b, actor) {
  const ins = db.get('insurers', b.insurerId);
  if (!ins) throw unprocessable('Select an insurer');
  if (ins.status === 'Prospect') throw unprocessable('TPA relationships can only be recorded with insurers that have an active agreement');
  if (!isDate(b.from)) throw unprocessable('Start date is required');
  if (b.to && (!isDate(b.to) || b.to < b.from)) throw unprocessable('End date must be on or after the start date');
  if ((tpa.relationships || []).some((r) => r.insurerId === ins.id && relActive(r))) throw conflict('An active relationship with this insurer already exists');
  tpa.relationships ||= [];
  const rel = {
    id: `rel_${tpa.relationships.length + 1}`, insurerId: ins.id, insurerName: ins.name, from: b.from, to: b.to || null, status: 'active',
    scope: s(b.scope) || 'Health claims administration (cashless & reimbursement)', agreementRef: s(b.agreementRef) || null,
    authorisedNetworkScope: b.authorisedNetworkScope === 'listed' ? 'listed' : 'insurer_network', authorisedHospitalIds: Array.isArray(b.authorisedHospitalIds) ? b.authorisedHospitalIds.filter((id) => db.get('hospitals', id) && !db.get('hospitals', id).candidate) : [],
    history: [{ at: now().toISOString(), by: actor.name, note: 'Relationship recorded' }],
  };
  tpa.relationships.push(rel);
  syncInsurerIds(tpa);
  audit(actor, 'TPA_RELATIONSHIP_ADDED', 'tpa', tpa.id, { insurerId: ins.id, from: rel.from, to: rel.to });
  return tpa;
}

export function endRelationship(tpa, relId, { reason, to }, actor) {
  const rel = (tpa.relationships || []).find((r) => r.id === relId);
  if (!rel) throw notFound('Relationship not found');
  if (rel.status === 'ended') throw conflict('Relationship already ended');
  if (!s(reason)) throw bad('A reason is required');
  rel.to = isDate(to) ? to : today();
  if (rel.to <= today()) rel.status = 'ended';
  rel.history.push({ at: now().toISOString(), by: actor.name, note: `Ended ${rel.to}: ${s(reason)}` });
  syncInsurerIds(tpa);
  audit(actor, 'TPA_RELATIONSHIP_ENDED', 'tpa', tpa.id, { relId, to: rel.to, reason: s(reason) });
  return tpa;
}

export function updateTpa(tpa, b, actor) {
  if (b.servicingContacts !== undefined) tpa.servicingContacts = (Array.isArray(b.servicingContacts) ? b.servicingContacts : []).map((c) => ({ name: s(c.name), role: s(c.role), phone: s(c.phone), email: s(c.email), region: s(c.region) })).filter((c) => c.name);
  if (b.hospitalNetworkRefs !== undefined) tpa.hospitalNetworkRefs = (Array.isArray(b.hospitalNetworkRefs) ? b.hospitalNetworkRefs : []).filter((id) => db.get('hospitalNetworks', id));
  if (b.status !== undefined) {
    if (!['Active', 'Suspended', 'Prospect'].includes(b.status)) throw unprocessable('Unknown status');
    tpa.status = b.status;
  }
  db.touch(tpa);
  audit(actor, 'TPA_UPDATED', 'tpa', tpa.id, { fields: Object.keys(b || {}) });
  return tpa;
}

export function addEscalation(tpa, b, actor) {
  if (!s(b.subject)) throw bad('Escalation subject is required');
  tpa.escalations ||= [];
  const e = { id: `esc_${tpa.escalations.length + 1}`, at: now().toISOString(), level: Number(b.level) || 1, subject: s(b.subject), claimNumber: s(b.claimNumber) || null, raisedBy: actor.name, status: 'open', resolution: null };
  tpa.escalations.push(e);
  db.touch(tpa);
  audit(actor, 'TPA_ESCALATION_RAISED', 'tpa', tpa.id, { escalationId: e.id, level: e.level });
  return tpa;
}
export function resolveEscalation(tpa, eid, b, actor) {
  const e = (tpa.escalations || []).find((x) => x.id === eid);
  if (!e) throw notFound('Escalation not found');
  if (!s(b.resolution)) throw bad('Describe the resolution');
  Object.assign(e, { status: 'resolved', resolution: s(b.resolution), resolvedBy: actor.name, resolvedAt: now().toISOString() });
  db.touch(tpa);
  audit(actor, 'TPA_ESCALATION_RESOLVED', 'tpa', tpa.id, { escalationId: eid });
  return tpa;
}

export const tpaView = (t) => ({
  ...t, administeredInsurerIds: administeredInsurerIds(t), administeredInsurers: administeredInsurerIds(t).map((id) => ({ id, name: insurerName(id) })),
  networkRefs: (t.hospitalNetworkRefs || []).map((id) => db.get('hospitalNetworks', id)).filter(Boolean).map((r) => ({ id: r.id, hospitalId: r.hospitalId, hospitalName: db.get('hospitals', r.hospitalId)?.name, insurerName: insurerName(r.insurerId), status: r.status })),
  openEscalations: (t.escalations || []).filter((e) => e.status === 'open').length,
});

// ---------- TPA claim desk ----------
export function tpaClaims(tpa) {
  const ins = new Set(administeredInsurerIds(tpa));
  return db.find('healthClaims', (c) => ins.has(db.get('policies', c.policyId)?.insurerId));
}

/** Returns the claim if it is on a policy of an insurer this TPA administers; otherwise 404. */
export function tpaClaim(tpa, claimId) {
  const c = db.get('healthClaims', claimId);
  if (!c || !administeredInsurerIds(tpa).includes(db.get('policies', c.policyId)?.insurerId)) throw notFound('Claim not found');
  return c;
}

export function reviewFor(tpaId, claimId, create = false) {
  let r = db.findOne('tpaClaimReviews', (x) => x.tpaId === tpaId && x.claimId === claimId);
  if (!r && create) r = db.insert('tpaClaimReviews', { id: newId('tcr'), tpaId, claimId, notes: [], documentRecommendations: [], recommendations: [] });
  return r;
}

export function tpaClaimView(c, tpa, { detail = false } = {}) {
  const policy = db.get('policies', c.policyId);
  const review = reviewFor(tpa.id, c.id);
  const base = {
    id: c.id, claimNumber: c.claimNumber, type: c.type, status: c.status, policyNumber: c.policyNumber, insurerId: policy?.insurerId, insurerName: insurerName(policy?.insurerId),
    planName: policy?.planName, memberName: c.memberName, hospitalId: c.hospitalId, hospitalName: c.hospitalName, networkHospital: !!c.networkHospital,
    admissionDate: c.admissionDate, dischargeDate: c.dischargeDate, requestedAmount: c.requestedAmount,
    preauth: c.preauth ? { status: c.preauth.status, amount: c.preauth.amount ?? null, at: c.preauth.at } : null,
    approvedAmount: c.assessment?.approvedAmount ?? null, createdAt: c.createdAt, updatedAt: c.updatedAt,
    latestRecommendation: review?.recommendations.at(-1) || null,
  };
  if (!detail) return base;
  return {
    ...base, diagnosis: c.diagnosis, treatment: c.treatment, isAccident: c.isAccident, finalBill: c.finalBill ? { amount: c.finalBill.amount, at: c.finalBill.at } : null,
    documentRequests: c.documentRequests, timeline: c.timeline.map((t) => ({ at: t.at, status: t.status, by: t.role === 'customer' ? 'Customer' : t.by, role: t.role, note: t.note })),
    documents: db.find('documents', (d) => d.entityId === c.id).map((d) => ({ id: d.id, category: d.category, filename: d.filename, uploadedAt: d.createdAt })),
    review: review || { notes: [], documentRecommendations: [], recommendations: [] }, recommendationNote: RECOMMENDATION_NOTE,
  };
}

export function addTpaNote(tpa, c, { note }, actor) {
  if (!s(note)) throw bad('Note is required');
  const r = reviewFor(tpa.id, c.id, true);
  r.notes.push({ at: now().toISOString(), by: actor.name, role: actor.role, note: s(note).slice(0, 2000) });
  db.touch(r);
  audit(actor, 'TPA_CLAIM_NOTE', 'healthClaim', c.id, { tpaId: tpa.id });
  return r;
}

export function recommendDocuments(tpa, c, { documents, note }, actor) {
  const docs = (Array.isArray(documents) ? documents : s(documents).split(',')).map(s).filter(Boolean);
  if (!docs.length) throw bad('List the documents to request');
  const r = reviewFor(tpa.id, c.id, true);
  r.documentRecommendations.push({ at: now().toISOString(), by: actor.name, documents: docs, note: s(note) || null, status: 'recommended', forwardedTo: 'Claims officer (VHC) for action' });
  db.touch(r);
  audit(actor, 'TPA_DOCUMENTS_RECOMMENDED', 'healthClaim', c.id, { tpaId: tpa.id, documents: docs });
  return r;
}

export function recordRecommendation(tpa, c, { recommendation, amount, reason }, actor) {
  if (!RECOMMENDATIONS[recommendation]) throw bad(`recommendation must be one of ${Object.keys(RECOMMENDATIONS).join(', ')}`);
  if (['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status)) throw conflict(`Claim is already ${c.status}`);
  if (!s(reason)) throw bad('Give the reasoning for the recommendation');
  if (['recommend_approve', 'recommend_partial'].includes(recommendation)) assertPaise(amount, 'amount');
  if (amount != null && amount > c.requestedAmount) throw unprocessable('Recommended amount cannot exceed the requested amount');
  const r = reviewFor(tpa.id, c.id, true);
  r.recommendations.push({ at: now().toISOString(), by: actor.name, role: actor.role, recommendation, label: RECOMMENDATIONS[recommendation], amount: amount ?? null, reason: s(reason), final: false, note: RECOMMENDATION_NOTE });
  db.touch(r);
  audit(actor, 'TPA_RECOMMENDATION', 'healthClaim', c.id, { tpaId: tpa.id, recommendation, amount: amount ?? null });
  return r;
}

const hours = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const avg = (xs) => (xs.length ? Math.round((xs.reduce((t, x) => t + x, 0) / xs.length) * 10) / 10 : null);

export function tpaTurnaround(tpa) {
  const claims = tpaClaims(tpa);
  const byStatus = {};
  const preauth = [], settle = [], rec = [];
  for (const c of claims) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (c.preauth?.at) preauth.push(hours(c.createdAt, c.preauth.at));
    const done = c.timeline.find((t) => ['Settled', 'Rejected'].includes(t.status));
    if (done) settle.push(hours(c.createdAt, done.at) / 24);
    const first = reviewFor(tpa.id, c.id)?.recommendations[0];
    if (first) rec.push(hours(c.createdAt, first.at));
  }
  return {
    tpaId: tpa.id, asOf: now().toISOString(), totalClaims: claims.length, byStatus,
    preauthDecisionHoursAvg: avg(preauth), preauthDecisions: preauth.length,
    closureDaysAvg: avg(settle), closedClaims: settle.length,
    recommendationHoursAvg: avg(rec), recommended: rec.length,
    open: claims.filter((c) => !['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status)).length,
  };
}

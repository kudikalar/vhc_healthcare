// Provider contracts (VHC ↔ hospital/provider). A VHC contract covers platform services (bookings,
// packages, referral rules, quality obligations); it never implies cashless eligibility with any insurer —
// that comes only from insurer network records (see networkCore.cashlessStatus).
//
// Lifecycle: draft → pending_approval → (approved, scheduled) → active → expired | terminated; rejected
// returns to draft for edits. Approval is two-step maker/checker: drafted and submitted by operations (or an
// admin), approved by an administrator who did not draft it. Amendments to approved contracts are versioned
// and approved the same way. Activation publishes HOSPITAL_CONTRACT_ACTIVATED exactly once.
import { db, newId, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { addDays, addYears, diffDays } from '../utils/dates.js';
import { bad, conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { assertPaise } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { on, publish } from './events.js';
import { CANDIDATE_LABEL } from './networkCore.js';

export const CONTRACT_STATUSES = ['draft', 'pending_approval', 'approved', 'active', 'expired', 'terminated', 'rejected'];
const EDITABLE = ['title', 'terms', 'effectiveFrom', 'effectiveTo', 'facilities', 'serviceScope', 'packageRates', 'paymentObligations', 'referralRestrictions', 'qualityObligations', 'escalation', 'renewal'];
const s = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v : s(v).split(',')).map((x) => s(x)).filter(Boolean);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

function cleanFields(b, h) {
  const out = {};
  if (b.title !== undefined) { if (!s(b.title)) throw unprocessable('Contract title is required'); out.title = s(b.title); }
  if (b.terms !== undefined) {
    const t = b.terms || {};
    out.terms = { summary: s(t.summary), noticeDays: Number.isInteger(Number(t.noticeDays)) ? Number(t.noticeDays) : 90, governingLaw: s(t.governingLaw) || 'Laws of India', disputeResolution: s(t.disputeResolution) || null };
  }
  for (const k of ['effectiveFrom', 'effectiveTo']) if (b[k] !== undefined) { if (!isDate(b[k])) throw unprocessable(`${k} must be a date (YYYY-MM-DD)`); out[k] = b[k]; }
  if (b.facilities !== undefined) {
    out.facilities = list(b.facilities);
    const known = new Set(['main', ...(h.branches || []).map((x) => x.id)]);
    for (const f of out.facilities) if (!known.has(f)) throw unprocessable(`Unknown facility/branch ${f}`);
  }
  if (b.serviceScope !== undefined) out.serviceScope = list(b.serviceScope);
  if (b.packageRates !== undefined) {
    if (!Array.isArray(b.packageRates)) throw unprocessable('packageRates must be a list');
    out.packageRates = b.packageRates.map((p, i) => {
      if (!s(p.name)) throw unprocessable(`Package ${i + 1}: name is required`);
      assertPaise(p.amount, `packageRates[${i}].amount`);
      return { code: s(p.code) || `PKG-${i + 1}`, name: s(p.name), amount: p.amount, inclusions: s(p.inclusions) || null, synthetic: true };
    });
  }
  if (b.paymentObligations !== undefined) {
    const p = b.paymentObligations || {};
    out.paymentObligations = { creditDays: Number.isInteger(Number(p.creditDays)) ? Number(p.creditDays) : 30, billingCycle: s(p.billingCycle) || 'monthly', note: s(p.note) || null };
  }
  if (b.referralRestrictions !== undefined) out.referralRestrictions = s(b.referralRestrictions);
  if (b.qualityObligations !== undefined) out.qualityObligations = list(b.qualityObligations);
  if (b.escalation !== undefined) out.escalation = (Array.isArray(b.escalation) ? b.escalation : []).map((e, i) => ({ level: Number(e.level) || i + 1, name: s(e.name), email: s(e.email), phone: s(e.phone) })).filter((e) => e.name || e.email);
  if (b.renewal !== undefined) out.renewal = { auto: !!b.renewal?.auto, noticeDays: Number(b.renewal?.noticeDays) || 60 };
  return out;
}

function validateDates(c) {
  if (!c.effectiveFrom || !c.effectiveTo) throw unprocessable('Effective and expiry dates are required');
  if (c.effectiveTo < c.effectiveFrom) throw unprocessable('Expiry date cannot be before the effective date');
}

const snapshot = (c) => Object.fromEntries(EDITABLE.map((k) => [k, structuredClone(c[k] ?? null)]));

/** Moves approved/active contracts along the calendar and publishes activation once. */
export function refreshContract(c, actor = null) {
  const t = today();
  if (['approved', 'active'].includes(c.status)) {
    let next = c.status;
    if (c.effectiveTo < t) next = 'expired';
    else if (c.effectiveFrom <= t) next = 'active';
    else next = 'approved';
    if (next !== c.status) {
      c.history.push({ at: now().toISOString(), status: next, by: actor?.name || 'System', role: actor?.role || 'system', note: next === 'expired' ? 'Contract reached its expiry date' : 'Contract effective date reached' });
      c.status = next;
      db.touch(c);
      if (next === 'active') activate(c, actor);
    }
  }
  return c;
}

function activate(c, actor) {
  c.activatedAt ||= now().toISOString();
  publish('HOSPITAL_CONTRACT_ACTIVATED', { contractId: c.id, reference: c.reference, hospitalId: c.hospitalId, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo }, {
    idempotencyKey: `HOSPITAL_CONTRACT_ACTIVATED:${c.id}`, actor, subject: { type: 'providerContract', id: c.id },
  });
}

// Notifies the hospital's administrators when a contract becomes active (validates before mutating).
on('HOSPITAL_CONTRACT_ACTIVATED', 'network.notifyHospitalAdmins', (payload) => {
  const c = db.get('providerContracts', payload.contractId);
  if (!c) throw new Error(`Contract ${payload.contractId} not found`);
  const admins = db.find('users', (u) => u.orgId === c.hospitalId && u.role === 'hospital_admin' && u.active);
  for (const u of admins) notify(u.id, 'Provider contract active', `Contract ${c.reference} is now in effect (${c.effectiveFrom} to ${c.effectiveTo}).`, { type: 'success', dedupeKey: `contract-active:${c.id}:${u.id}`, link: '/hospital?tab=contracts' });
  return { notified: admins.length };
});

export function getContract(id) {
  const c = db.get('providerContracts', id);
  if (!c) throw notFound('Contract not found');
  return refreshContract(c);
}

export function createContract(b, actor, { id } = {}) {
  const h = db.get('hospitals', b.hospitalId);
  if (!h) throw unprocessable('Select a provider');
  const fields = cleanFields({ title: b.title || `${h.name} — provider services agreement`, terms: b.terms || {}, facilities: b.facilities || ['main'], paymentObligations: b.paymentObligations || {}, packageRates: b.packageRates || [], ...b }, h);
  const c = db.insert('providerContracts', {
    id: id || newId('hct'),
    reference: `VHC-PC-${today().slice(0, 4)}-${String(nextSeq('providerContract')).padStart(4, '0')}`,
    hospitalId: h.id, hospitalName: h.name, status: 'draft', version: 1, synthetic: true,
    serviceScope: [], referralRestrictions: '', qualityObligations: [], escalation: [], renewal: { auto: false, noticeDays: 60 },
    ...fields,
    complaints: [], amendments: [], versions: [], approvals: [{ step: 'drafted', by: actor.name, userId: actor.id, role: actor.role, at: now().toISOString() }],
    draftedBy: { id: actor.id, name: actor.name, role: actor.role }, approvedBy: null, renewedFromId: b.renewedFromId || null, renewedToId: null, termination: null,
    history: [{ at: now().toISOString(), status: 'draft', by: actor.name, role: actor.role, note: b.renewedFromId ? 'Renewal draft created' : 'Contract drafted' }],
  });
  if (h.candidate) c.candidateNote = `${CANDIDATE_LABEL}: negotiation draft only — cannot be approved in the sandbox.`;
  audit(actor, 'PROVIDER_CONTRACT_DRAFTED', 'providerContract', c.id, { reference: c.reference, hospitalId: h.id });
  return c;
}

export function updateDraft(c, b, actor) {
  if (!['draft', 'rejected'].includes(c.status)) throw conflict('Only draft contracts can be edited; propose an amendment instead');
  const h = db.get('hospitals', c.hospitalId);
  Object.assign(c, cleanFields(b, h));
  if (c.status === 'rejected') {
    c.status = 'draft';
    c.history.push({ at: now().toISOString(), status: 'draft', by: actor.name, role: actor.role, note: 'Reopened for edits after rejection' });
  }
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_EDITED', 'providerContract', c.id, { fields: Object.keys(b || {}).filter((k) => EDITABLE.includes(k)) });
  return c;
}

export function submitContract(c, actor) {
  if (c.status !== 'draft') throw conflict(`Contract is ${c.status}`);
  validateDates(c);
  if (!c.serviceScope?.length) throw unprocessable('Add the service scope before submitting');
  c.status = 'pending_approval';
  c.approvals.push({ step: 'submitted', by: actor.name, userId: actor.id, role: actor.role, at: now().toISOString() });
  c.history.push({ at: now().toISOString(), status: 'pending_approval', by: actor.name, role: actor.role, note: 'Submitted for administrator approval' });
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_SUBMITTED', 'providerContract', c.id, { reference: c.reference });
  return c;
}

const assertChecker = (actor, makerId, what) => {
  if (actor.role !== 'admin') throw forbidden(`Only an administrator can approve ${what}`);
  if (makerId === actor.id) throw conflict(`${what[0].toUpperCase()}${what.slice(1)} must be approved by a different administrator than the one who prepared it`);
};

export function approveContract(c, { note } = {}, actor) {
  if (c.status !== 'pending_approval') throw conflict(`Contract is ${c.status}; only contracts pending approval can be approved`);
  assertChecker(actor, c.approvals.filter((a) => a.step === 'submitted').at(-1)?.userId, 'contracts');
  const h = db.get('hospitals', c.hospitalId);
  if (h?.candidate) throw unprocessable(`${h.name} is a ${CANDIDATE_LABEL.toLowerCase()}; contracts with candidates cannot be approved in the sandbox.`);
  validateDates(c);
  c.status = 'approved';
  c.approvedBy = { id: actor.id, name: actor.name, at: now().toISOString() };
  c.approvals.push({ step: 'approved', by: actor.name, userId: actor.id, role: actor.role, at: now().toISOString(), note: s(note) || null });
  c.versions.push({ version: c.version, at: now().toISOString(), by: actor.name, snapshot: snapshot(c), note: 'Approved version' });
  c.history.push({ at: now().toISOString(), status: 'approved', by: actor.name, role: actor.role, note: s(note) || 'Approved' });
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_APPROVED', 'providerContract', c.id, { reference: c.reference, version: c.version });
  if (c.renewedFromId) {
    const prev = db.get('providerContracts', c.renewedFromId);
    if (prev) { prev.renewedToId = c.id; db.touch(prev); }
  }
  refreshContract(c, actor);
  return c;
}

export function rejectContract(c, { reason }, actor) {
  if (c.status !== 'pending_approval') throw conflict(`Contract is ${c.status}`);
  if (actor.role !== 'admin') throw forbidden('Only an administrator can reject contracts');
  if (!s(reason)) throw bad('A reason is required');
  c.status = 'rejected';
  c.approvals.push({ step: 'rejected', by: actor.name, userId: actor.id, role: actor.role, at: now().toISOString(), note: s(reason) });
  c.history.push({ at: now().toISOString(), status: 'rejected', by: actor.name, role: actor.role, note: s(reason) });
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_REJECTED', 'providerContract', c.id, { reason: s(reason) });
  return c;
}

export function proposeAmendment(c, { changes, note }, actor) {
  if (!['approved', 'active'].includes(c.status)) throw conflict('Amendments apply to approved or active contracts; edit the draft instead');
  if (c.amendments.some((a) => a.status === 'pending')) throw conflict('Another amendment is already pending approval');
  if (!s(note)) throw bad('Describe the reason for the amendment');
  const h = db.get('hospitals', c.hospitalId);
  const clean = cleanFields(changes || {}, h);
  if (!Object.keys(clean).length) throw unprocessable('No changes proposed');
  const tmp = { ...c, ...clean };
  validateDates(tmp);
  const a = { version: c.version + 1, status: 'pending', changes: clean, note: s(note), proposedBy: actor.name, proposedById: actor.id, proposedAt: now().toISOString() };
  c.amendments.push(a);
  c.history.push({ at: now().toISOString(), status: c.status, by: actor.name, role: actor.role, note: `Amendment v${a.version} proposed: ${a.note}` });
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_AMENDMENT_PROPOSED', 'providerContract', c.id, { version: a.version, fields: Object.keys(clean) });
  return c;
}

export function decideAmendment(c, version, { decision, reason }, actor) {
  const a = c.amendments.find((x) => x.version === Number(version) && x.status === 'pending');
  if (!a) throw notFound('Pending amendment not found');
  assertChecker(actor, a.proposedById, 'amendments');
  if (decision === 'approve') {
    Object.assign(c, a.changes);
    c.version = a.version;
    a.status = 'approved';
    c.versions.push({ version: c.version, at: now().toISOString(), by: actor.name, snapshot: snapshot(c), note: a.note });
  } else if (decision === 'reject') {
    if (!s(reason)) throw bad('A reason is required');
    a.status = 'rejected';
    a.reason = s(reason);
  } else throw bad('decision must be approve or reject');
  a.decidedBy = actor.name;
  a.decidedAt = now().toISOString();
  c.history.push({ at: a.decidedAt, status: c.status, by: actor.name, role: actor.role, note: `Amendment v${a.version} ${a.status}` });
  db.touch(c);
  audit(actor, `PROVIDER_CONTRACT_AMENDMENT_${decision.toUpperCase()}D`, 'providerContract', c.id, { version: a.version });
  refreshContract(c, actor);
  return c;
}

export function renewContract(c, b, actor) {
  if (!['approved', 'active', 'expired'].includes(c.status)) throw conflict('Only approved, active or expired contracts can be renewed');
  if (c.renewedToId || db.findOne('providerContracts', (x) => x.renewedFromId === c.id && !['rejected', 'terminated'].includes(x.status))) throw conflict('A renewal already exists for this contract');
  const from = isDate(b?.effectiveFrom) ? b.effectiveFrom : addDays(c.effectiveTo, 1);
  const to = isDate(b?.effectiveTo) ? b.effectiveTo : addDays(addYears(from, 1), -1);
  const fields = Object.fromEntries(['terms', 'facilities', 'serviceScope', 'packageRates', 'paymentObligations', 'referralRestrictions', 'qualityObligations', 'escalation', 'renewal'].map((k) => [k, structuredClone(c[k])]));
  const next = createContract({ ...fields, hospitalId: c.hospitalId, title: c.title, effectiveFrom: from, effectiveTo: to, renewedFromId: c.id }, actor);
  audit(actor, 'PROVIDER_CONTRACT_RENEWAL_DRAFTED', 'providerContract', c.id, { renewal: next.reference });
  return next;
}

export function terminateContract(c, { reason, effectiveDate }, actor) {
  if (actor.role !== 'admin') throw forbidden('Only an administrator can terminate contracts');
  if (['terminated', 'expired', 'rejected'].includes(c.status)) throw conflict(`Contract is already ${c.status}`);
  if (!s(reason)) throw bad('A termination reason is required');
  const eff = isDate(effectiveDate) ? effectiveDate : today();
  c.termination = { reason: s(reason), effectiveDate: eff, by: actor.name, at: now().toISOString() };
  if (eff <= today() || ['draft', 'pending_approval'].includes(c.status)) c.status = 'terminated';
  else c.effectiveTo = eff; // scheduled termination: ends on that date
  c.history.push({ at: now().toISOString(), status: c.status, by: actor.name, role: actor.role, note: `Termination (${eff}): ${s(reason)}` });
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_TERMINATED', 'providerContract', c.id, { reason: s(reason), effectiveDate: eff });
  return c;
}

export function addComplaint(c, { summary, raisedBy }, actor) {
  if (!s(summary)) throw bad('Describe the complaint');
  const item = { id: `cmp_${c.complaints.length + 1}`, at: now().toISOString(), by: actor.name, role: actor.role, raisedBy: s(raisedBy) || actor.orgName || 'VHC', summary: s(summary), status: 'open', resolution: null };
  c.complaints.push(item);
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_COMPLAINT', 'providerContract', c.id, { complaintId: item.id });
  return c;
}

export function resolveComplaint(c, cid, { resolution }, actor) {
  const item = c.complaints.find((x) => x.id === cid);
  if (!item) throw notFound('Complaint not found');
  if (!s(resolution)) throw bad('Describe the resolution');
  Object.assign(item, { status: 'resolved', resolution: s(resolution), resolvedBy: actor.name, resolvedAt: now().toISOString() });
  db.touch(c);
  audit(actor, 'PROVIDER_CONTRACT_COMPLAINT_RESOLVED', 'providerContract', c.id, { complaintId: cid });
  return c;
}

export const contractView = (c) => ({
  ...c, daysToExpiry: ['approved', 'active'].includes(c.status) ? diffDays(today(), c.effectiveTo) : null,
  pendingAmendment: c.amendments.find((a) => a.status === 'pending') || null,
});

/** Hospital-facing view: commercial terms they agreed, without internal approval notes. */
export const hospitalContractView = (c) => ({
  id: c.id, reference: c.reference, title: c.title, status: c.status, version: c.version, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo,
  facilities: c.facilities, serviceScope: c.serviceScope, packageRates: c.packageRates, paymentObligations: c.paymentObligations,
  referralRestrictions: c.referralRestrictions, qualityObligations: c.qualityObligations, escalation: c.escalation, terms: c.terms,
  complaints: c.complaints, amendments: c.amendments.filter((a) => a.status === 'approved').map((a) => ({ version: a.version, note: a.note, decidedAt: a.decidedAt })),
  daysToExpiry: ['approved', 'active'].includes(c.status) ? diffDays(today(), c.effectiveTo) : null,
});

export const expiringContracts = (days = 60) => {
  const t = today(), until = addDays(t, days);
  return db.find('providerContracts', (c) => ['approved', 'active'].includes(refreshContract(c).status) && c.effectiveTo >= t && c.effectiveTo <= until && !c.renewedToId);
};

export function refreshAllContracts() {
  let changed = 0;
  for (const c of db.all('providerContracts')) {
    const before = c.status;
    refreshContract(c);
    if (before !== c.status) changed++;
  }
  return changed;
}

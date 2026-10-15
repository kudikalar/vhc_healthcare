// Claims operations core: claim enrichment (insurer reference, TPA, request timestamps, insurer
// communications), the customer-facing unified status with the responsible organisation and next action,
// settlement breakdown with the customer-payable amount, claim intimations and claim lifecycle events.
import { db, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { isValidDate } from '../utils/dates.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { audit, notify } from './audit.js';
import { publish } from './events.js';
import { registerJob } from './jobs.js';
import { breachesFor, checkSlaBreaches, claimClocks, claimTimestamps, currentPolicy, primaryClock, SLA_SOURCE } from './claimsOpsSla.js';
import { claimDocumentIntel, claimTimelineSummary, rupees } from './claimsOpsDocs.js';
import { FRAUD_DISCLAIMER, openFlagsFor } from './claimsOpsFraud.js';

export const CLAIMS_TEAM = ['claims_officer', 'admin'];
export const DECISION_DISCLAIMER = 'VHC is a technology platform and claims-assistance intermediary, not the insurer. Claim decisions are made by the insurer (or its TPA) — VHC does not control insurer decisions.';
export const UNIFIED_STATUSES = ['Pending', 'Awaiting Documents', 'Under Review', 'Authorized', 'Partially Authorized', 'Rejected', 'Discharged', 'Settlement Pending', 'Settled', 'Closed'];
export const RESPONSIBLE_ORGS = ['Customer', 'Hospital', 'Insurer', 'TPA', 'VHC claims assistance'];
const SYSTEM = { id: 'system', role: 'system', name: 'VHC Claims Ops' };

// ---------------- enrichment ----------------
const insurerOf = (policy) => (policy?.insurerId ? db.get('insurers', policy.insurerId) : null);
/** The TPA linked to the policy's insurer (insurer↔TPA link on the TPA record), else null. */
export function tpaFor(policy) {
  if (!policy?.insurerId) return null;
  return db.find('tpas', (t) => (t.status || 'Active') === 'Active' && (t.insurerIds || []).includes(policy.insurerId))
    .sort((a, b) => a.id.localeCompare(b.id))[0] || null;
}
export function newInsurerClaimRef(insurer) {
  const prefix = insurer?.sandbox === false ? 'INS' : 'SBX';
  return `${prefix}-CLM-${today().slice(0, 4)}-${String(nextSeq('insurerClaimRef')).padStart(6, '0')}`;
}

/** Adds insurer/TPA/SLA/request fields to a claim (fills only what is missing; never touches updatedAt). */
export function enrichClaim(c, { slaPolicyId } = {}) {
  const policy = db.get('policies', c.policyId);
  const insurer = insurerOf(policy);
  if (c.insurerId === undefined) c.insurerId = policy?.insurerId || null;
  if (c.insurerName === undefined) c.insurerName = insurer?.name || policy?.insurerName || null;
  if (!c.insurerClaimRef) c.insurerClaimRef = newInsurerClaimRef(insurer);
  if (c.tpaId === undefined) {
    const tpa = tpaFor(policy);
    c.tpaId = tpa?.id || null;
    c.tpaName = tpa?.name || null;
  }
  if (c.slaPolicyId === undefined && slaPolicyId) c.slaPolicyId = slaPolicyId;
  c.requests ||= {};
  c.insurerComms ||= [];
  return c;
}

export function addInsurerComm(c, { direction = 'outbound', channel = 'Insurer API (sandbox)', subject, message, by = 'VHC Claims Ops', visibleToCustomer = true, insurerRef = null }) {
  c.insurerComms ||= [];
  const entry = { at: now().toISOString(), direction, channel, subject, message: message || null, by, visibleToCustomer, insurerRef: insurerRef || c.insurerClaimRef || null };
  c.insurerComms.push(entry);
  return entry;
}

function publishOnce(type, c, key, actor, payload = {}) {
  return publish(type, { claimId: c.id, claimNumber: c.claimNumber, type: c.type, insurerClaimRef: c.insurerClaimRef || null, ...payload }, {
    idempotencyKey: key, actor, subject: { type: 'healthClaim', id: c.id }, correlationId: c.correlationId || undefined,
  });
}

/** Hook for POST /health-claims after the claim record is inserted (inside the same transaction). */
export function onClaimSubmitted(c, actor, intimation = null) {
  enrichClaim(c, { slaPolicyId: currentPolicy()?.id });
  c.correlationId ||= `cor_claim_${c.id}`;
  c.requests.submittedAt = c.createdAt;
  if (c.type === 'cashless') c.requests.preauthRequestedAt = c.createdAt;
  if (intimation) {
    c.intimationId = intimation.id;
    c.requests.intimatedAt = intimation.createdAt;
    intimation.status = 'Converted';
    intimation.claimId = c.id;
    intimation.claimNumber = c.claimNumber;
    intimation.convertedAt = now().toISOString();
    intimation.history.push({ at: now().toISOString(), action: 'Converted to claim', by: actor.name, note: c.claimNumber });
    db.touch(intimation);
  }
  addInsurerComm(c, { direction: 'outbound', subject: c.type === 'cashless' ? 'Cashless pre-authorisation request sent' : 'Reimbursement claim registered with insurer', message: `Insurer claim reference ${c.insurerClaimRef}${c.tpaName ? `; routed via ${c.tpaName}` : ''} (sandbox — simulated exchange).` });
  publishOnce('CLAIM_INTIMATED', c, intimation ? `claim-intimated:${intimation.id}` : `claim-intimated:claim:${c.id}`, actor, { intimationId: intimation?.id || null });
  if (c.type === 'cashless') publishOnce('PREAUTH_REQUESTED', c, `preauth-requested:${c.id}`, actor, { hospitalId: c.hospitalId, requestedAt: c.requests.preauthRequestedAt });
}

export function onPreauthDecided(c, actor, decision) {
  enrichClaim(c);
  c.requests.preauthDecidedAt = c.preauth?.at || now().toISOString();
  addInsurerComm(c, { direction: 'inbound', subject: `Pre-authorisation ${decision === 'approve' ? 'approved (provisional)' : 'refused'}`, message: decision === 'approve' ? `Provisional amount ${rupees(c.preauth.amount)}.` : c.preauth?.reason, by: actor.name });
  publishOnce('PREAUTH_DECIDED', c, `preauth-decided:${c.id}`, actor, { decision, amount: c.preauth?.amount ?? null, decidedAt: c.requests.preauthDecidedAt });
}

export function onFinalBill(c, actor) {
  enrichClaim(c);
  c.requests.finalBillRequestedAt = c.finalBill?.at || now().toISOString();
  addInsurerComm(c, { direction: 'outbound', subject: 'Final bill and discharge details sent for final authorisation', message: `Final bill ${rupees(c.finalBill?.amount)}.`, by: actor.name });
}

export function onDocumentsRequested(c, actor, note) {
  enrichClaim(c);
  c.requests.lastDocumentRequestAt = now().toISOString();
  addInsurerComm(c, { direction: 'inbound', subject: 'Additional documents requested', message: note, by: actor.name });
}

export function onDocumentsProvided(c) {
  enrichClaim(c);
  c.requests.lastDocumentAt = now().toISOString();
}

export function onClaimDecided(c, actor, decision) {
  enrichClaim(c);
  const t = now().toISOString();
  c.requests.decidedAt = t;
  if (c.type === 'cashless' && c.requests.finalBillRequestedAt && !c.requests.finalBillDecidedAt) c.requests.finalBillDecidedAt = t;
  if (c.type === 'cashless' && decision === 'reject' && !c.requests.finalBillRequestedAt && !c.requests.preauthDecidedAt) c.requests.preauthDecidedAt = t;
  addInsurerComm(c, { direction: 'inbound', subject: decision === 'approve' ? 'Claim approved' : 'Claim rejected', message: decision === 'approve' ? `Approved ${rupees(c.assessment?.approvedAmount)}.` : c.rejection?.reason, by: actor.name });
}

/**
 * Publishes CLAIM_SETTLED for settled claims (settlement completes in the payout rail, outside this
 * module), and records the settlement timestamp and insurer communication once. Idempotent.
 */
export function reconcileSettledClaims() {
  let n = 0;
  for (const c of db.find('healthClaims', (x) => x.status === 'Settled')) {
    const key = `claim-settled:${c.id}`;
    if (db.findOne('events', (e) => e.idempotencyKey === key)) continue;
    enrichClaim(c);
    const settledAt = claimTimestamps(c).settledAt || now().toISOString();
    c.requests.settledAt = settledAt;
    const payout = db.find('payouts', (p) => p.claimId === c.id && p.status === 'success').at(-1);
    addInsurerComm(c, { direction: 'inbound', subject: 'Settlement confirmed', message: `${rupees(c.paidAmount)} paid${payout ? ` (${payout.reference})` : ''}.`, by: 'Payout rail' });
    publishOnce('CLAIM_SETTLED', c, key, SYSTEM, { paidAmount: c.paidAmount, payoutReference: payout?.reference || null, settledAt });
    n += 1;
  }
  return n;
}

registerJob(() => ({ claimSettledEvents: reconcileSettledClaims(), slaBreaches: checkSlaBreaches() }));

// ---------------- unified status ----------------
const insurerSide = (c) => (c.tpaId ? 'TPA' : 'Insurer');

/** Maps an internal claim state to the customer-facing status, responsible organisation and next action. */
export function unifiedStatus(c) {
  const side = insurerSide(c);
  const sideName = c.tpaName ? `${c.tpaName} (TPA for ${c.insurerName || 'the insurer'})` : c.insurerName || 'the insurer';
  const partial = c.preauth?.status === 'approved' && c.preauth.amount < c.requestedAmount;
  if (c.closedAt) return { status: 'Closed', responsible: 'VHC claims assistance', nextAction: 'No further action is pending. If you disagree with the outcome you can raise a grievance.' };
  switch (c.status) {
    case 'Submitted': return { status: 'Pending', responsible: 'VHC claims assistance', nextAction: 'VHC claims assistance is checking the claim file before the insurer assessment starts.' };
    case 'Preauth Requested': return { status: 'Under Review', responsible: side, nextAction: `${sideName} to decide the cashless pre-authorisation request.` };
    case 'Documents Requested': {
      const cashlessPre = c.type === 'cashless' && ['Preauth Requested', 'Preauth Approved'].includes(c.resumeStatus);
      return { status: 'Awaiting Documents', responsible: cashlessPre ? 'Hospital' : 'Customer', nextAction: cashlessPre ? 'The hospital insurance desk should submit the requested documents (you can also upload them here).' : 'Upload the requested documents, then tell us they are uploaded.' };
    }
    case 'Under Review': return { status: 'Under Review', responsible: side, nextAction: `${sideName} is assessing the claim.` };
    case 'Preauth Approved': return { status: partial ? 'Partially Authorized' : 'Authorized', responsible: 'Hospital', nextAction: `Provisional amount ${rupees(c.preauth.amount)}${partial ? ` of the estimated ${rupees(c.requestedAmount)}` : ''}. The hospital sends the final bill at discharge for final authorisation.` };
    case 'Preauth Rejected': return { status: 'Rejected', responsible: 'Customer', nextAction: 'Cashless was refused. You may file a reimbursement claim after treatment, or raise a grievance.' };
    case 'Final Bill Submitted': return { status: 'Discharged', responsible: side, nextAction: `${sideName} to give final authorisation on the final bill.` };
    case 'Approved':
      if (c.type === 'reimbursement' && !c.payoutVerified) return { status: 'Settlement Pending', responsible: 'VHC claims assistance', nextAction: 'VHC is verifying your payout bank details before the payment is released.' };
      return { status: 'Settlement Pending', responsible: 'Insurer', nextAction: c.type === 'cashless' ? `Payment of ${rupees(c.assessment?.approvedAmount)} to the hospital is being processed.` : `Payment of ${rupees(c.assessment?.approvedAmount)} to your bank account is being processed.` };
    case 'Settled': return { status: 'Settled', responsible: 'VHC claims assistance', nextAction: c.type === 'cashless' ? 'Settlement is complete. Any amount not covered (see the breakdown) is payable by you to the hospital.' : 'Settlement is complete. The breakdown shows any amount that was not reimbursed and why.' };
    case 'Rejected': return { status: 'Rejected', responsible: 'Customer', nextAction: "Review the reason. You can raise a VHC grievance and complain to the insurer's grievance officer." };
    default: return { status: 'Pending', responsible: 'VHC claims assistance', nextAction: 'VHC claims assistance is reviewing the claim.' };
  }
}

const FLOW = {
  cashless: ['Pending', 'Under Review', 'Authorized', 'Discharged', 'Settlement Pending', 'Settled', 'Closed'],
  reimbursement: ['Pending', 'Under Review', 'Settlement Pending', 'Settled', 'Closed'],
};
/** Stepper for the customer UI: each step is done | current | upcoming | stopped. */
export function statusSteps(c) {
  const flow = FLOW[c.type] || FLOW.reimbursement;
  const u = unifiedStatus(c);
  const base = u.status === 'Awaiting Documents' ? unifiedStatus({ ...c, status: c.resumeStatus || 'Submitted' }).status : u.status;
  const slot = base === 'Partially Authorized' ? 'Authorized' : base;
  let idx = flow.indexOf(slot);
  if (base === 'Rejected') {
    idx = c.type === 'cashless' && c.status === 'Preauth Rejected' ? flow.indexOf('Authorized') : flow.indexOf('Settlement Pending');
    return flow.map((label, i) => ({ label: i === idx ? 'Rejected' : label, state: i < idx ? 'done' : i === idx ? 'stopped' : 'upcoming' }));
  }
  if (idx < 0) idx = 0;
  return flow.map((label, i) => ({
    label: i === idx && base === 'Partially Authorized' ? 'Partially Authorized' : label,
    state: i < idx || (i === idx && ['Settled', 'Closed'].includes(label)) ? 'done' : i === idx ? (u.status === 'Awaiting Documents' ? 'waiting' : 'current') : 'upcoming',
  }));
}

export const STATUS_MAP = [
  ['Submitted', 'Pending', 'VHC claims assistance'], ['Preauth Requested', 'Under Review', 'Insurer / TPA'], ['Documents Requested', 'Awaiting Documents', 'Customer or Hospital'],
  ['Under Review', 'Under Review', 'Insurer / TPA'], ['Preauth Approved (full)', 'Authorized', 'Hospital'], ['Preauth Approved (below estimate)', 'Partially Authorized', 'Hospital'],
  ['Preauth Rejected', 'Rejected', 'Customer'], ['Final Bill Submitted', 'Discharged', 'Insurer / TPA'], ['Approved', 'Settlement Pending', 'Insurer (VHC while payout details are verified)'],
  ['Settled', 'Settled', 'VHC claims assistance'], ['Rejected', 'Rejected', 'Customer'], ['Settled/Rejected + closed by VHC', 'Closed', 'VHC claims assistance'],
].map(([internal, unified, responsible]) => ({ internal, unified, responsible }));

// ---------------- settlement ----------------
/** Bill vs approved amount with every deduction explained; customer-payable = bill − approved. */
export function settlementBreakdown(c) {
  const a = c.assessment;
  const payouts = db.find('payouts', (p) => p.claimId === c.id).map((p) => ({ reference: p.reference, amount: p.amount, status: p.status, payee: p.payee?.name || null, completedAt: p.completedAt || null }));
  const settledAt = claimTimestamps(c).settledAt;
  if (!a) {
    return { assessed: false, billedAmount: c.finalBill?.amount ?? c.requestedAmount, authorizedAmount: c.preauth?.status === 'approved' ? c.preauth.amount : null, approvedAmount: null, customerPayable: null, deductions: [], paidAmount: c.paidAmount || 0, payouts, settledAt };
  }
  const billed = a.billedAmount ?? a.requestedAmount;
  const nonPayableItems = (a.items || []).filter((i) => i.amount > i.admissible).map((i) => ({ description: i.description, amount: i.amount - i.admissible, note: i.note }));
  const deductions = [
    { key: 'non_payable', label: a.eligible ? 'Non-payable / non-admissible items and limits' : `Not payable under policy terms (${a.reasons.join('; ')})`, amount: billed - a.eligibleAmount, items: a.eligible ? nonPayableItems : [] },
    { key: 'deductible', label: 'Deductible', amount: a.deductible },
    { key: 'copay', label: `Co-payment (${(a.inputs?.copayBp || 0) / 100}%)`, amount: a.copay },
    { key: 'coverage_cap', label: 'Above the remaining sum insured', amount: a.calculatedAmount - a.approvedAmount },
  ].filter((d) => d.amount > 0);
  const approved = c.status === 'Rejected' ? 0 : a.approvedAmount;
  return {
    assessed: true, billedAmount: billed, authorizedAmount: c.preauth?.status === 'approved' ? c.preauth.amount : null,
    approvedAmount: approved, customerPayable: billed - approved, deductions, provisional: !a.approvedAt,
    customerPayableLabel: c.type === 'cashless' ? 'Payable by you to the hospital' : 'Not reimbursed (borne by you)',
    paidAmount: c.paidAmount || 0, payee: c.type === 'cashless' ? c.hospitalName : 'Policyholder bank account', payouts, settledAt,
  };
}

// ---------------- view ----------------
const isTeam = (user) => CLAIMS_TEAM.includes(user.role);

/** Claims-ops extension attached to the claim view (`claim.ops`). */
export function claimOpsView(c, user) {
  const team = isTeam(user);
  const clocks = claimClocks(c);
  const u = unifiedStatus(c);
  const intimation = c.intimationId ? db.get('claimIntimations', c.intimationId) : null;
  const intel = claimDocumentIntel(c, { audience: team ? 'staff' : 'customer' });
  const out = {
    unified: { ...u, steps: statusSteps(c) }, disclaimer: DECISION_DISCLAIMER,
    insurer: { id: c.insurerId || null, name: c.insurerName || null, claimRef: c.insurerClaimRef || null },
    tpa: c.tpaId ? { id: c.tpaId, name: c.tpaName } : null,
    timestamps: claimTimestamps(c),
    sla: { policyVersion: clocks[0]?.policyVersion ?? null, source: SLA_SOURCE, clocks, primary: primaryClock(clocks.filter((k) => k.running)) || null, breaches: breachesFor('healthClaim', c.id) },
    settlement: settlementBreakdown(c),
    insurerComms: (c.insurerComms || []).filter((m) => team || m.visibleToCustomer !== false),
    documents: intel, pendingDocuments: intel.pendingDocuments, timelineSummary: claimTimelineSummary(c),
    intimation: intimation ? { id: intimation.id, intimationNumber: intimation.intimationNumber, createdAt: intimation.createdAt } : null,
    grievances: db.find('grievances', (g) => g.claimId === c.id && (team || g.userId === user.id)).map((g) => ({ id: g.id, reference: g.reference, status: g.status })),
  };
  if (team) {
    const flags = db.find('fraudFlags', (f) => f.claimId === c.id);
    out.fraud = { disclaimer: FRAUD_DISCLAIMER, open: flags.filter((f) => ['Open', 'In Review'].includes(f.status)).length, flags };
    out.auditHistory = db.find('auditLogs', (l) => l.entityType === 'healthClaim' && l.entityId === c.id).map((l) => ({ at: l.at, action: l.action, by: l.actorName, role: l.actorRole, details: l.details }));
  }
  return out;
}

/** Compact SLA/status summary for lists and boards (no medical details). */
export function claimRow(c) {
  const clocks = claimClocks(c);
  const running = clocks.filter((k) => k.running);
  const primary = primaryClock(running) || primaryClock(clocks);
  const u = unifiedStatus(c);
  return {
    id: c.id, claimNumber: c.claimNumber, type: c.type, status: c.status, unifiedStatus: u.status, responsible: u.responsible,
    policyNumber: c.policyNumber, hospitalName: c.hospitalName, insurerName: c.insurerName || null, tpaName: c.tpaName || null,
    insurerClaimRef: c.insurerClaimRef || null, requestedAmount: c.requestedAmount, approvedAmount: c.assessment?.approvedAmount ?? null,
    createdAt: c.createdAt, updatedAt: c.updatedAt, open: !['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status) && !c.closedAt,
    policyVersion: clocks[0]?.policyVersion ?? null,
    sla: primary ? { key: primary.key, label: primary.label, state: primary.state, dueAt: primary.dueAt, remainingMs: primary.remainingMs, elapsedMs: primary.elapsedMs, owner: primary.owner } : null,
    clocks: clocks.map((k) => ({ key: k.key, label: k.label, state: k.state, startAt: k.startAt, stopAt: k.stopAt, dueAt: k.dueAt, elapsedMs: k.elapsedMs, remainingMs: k.remainingMs, durationMs: k.durationMs, breached: k.breached, running: k.running, paused: k.paused, owner: k.owner })),
    breachRecorded: breachesFor('healthClaim', c.id).length > 0,
    openFlags: openFlagsFor(c.id).length,
  };
}

// ---------------- intimations ----------------
export const INTIMATION_STATUSES = ['Intimated', 'Converted', 'Cancelled'];

export function assertIntimationAccess(user, rec) {
  if (!rec) throw notFound('Intimation not found');
  if (user.role === 'customer' && rec.userId === user.id) return rec;
  if (isTeam(user)) return rec;
  throw notFound('Intimation not found');
}

export function createIntimation(user, b = {}) {
  if (b.idempotencyKey) {
    const prior = db.findOne('claimIntimations', (x) => x.userId === user.id && x.idempotencyKey === b.idempotencyKey);
    if (prior) return prior;
  }
  const policy = db.get('policies', b.policyId);
  if (!policy || policy.userId !== user.id || policy.product !== 'health') throw notFound('Policy not found');
  const member = policy.members.find((m) => m.id === b.memberId);
  if (!member) throw bad('The selected person is not insured under this policy');
  const hospital = b.hospitalId ? db.get('hospitals', b.hospitalId) : null;
  if (b.hospitalId && (!hospital || !hospital.active)) throw bad('Hospital not found');
  if (!hospital && !String(b.hospitalName || '').trim()) throw bad('Hospital is required');
  if (!isValidDate(b.expectedAdmissionDate)) throw bad('A valid expected admission date is required');
  if (b.expectedAdmissionDate < policy.startDate || b.expectedAdmissionDate > policy.endDate) throw unprocessable(`Admission must fall within the coverage period ${policy.startDate} to ${policy.endDate}`);
  const illness = String(b.natureOfIllness || '').trim();
  if (!illness) throw bad('Describe the nature of the illness or injury');
  if (illness.length > 500) throw bad('Keep the description under 500 characters');
  const admissionType = b.admissionType === 'emergency' ? 'emergency' : 'planned';
  // Cashless is only possible at a network hospital; otherwise the intimation leads to a reimbursement claim.
  const wantsCashless = b.preferredType ? b.preferredType === 'cashless' : !!hospital?.network;
  const preferredType = wantsCashless && hospital?.network ? 'cashless' : 'reimbursement';
  const insurer = insurerOf(policy);
  const tpa = tpaFor(policy);
  const rec = db.insert('claimIntimations', {
    intimationNumber: `INT-${today().slice(0, 4)}-${String(nextSeq('claimIntimation')).padStart(6, '0')}`,
    insurerIntimationRef: `${insurer?.sandbox === false ? 'INS' : 'SBX'}-INT-${String(nextSeq('insurerIntimationRef')).padStart(6, '0')}`,
    idempotencyKey: b.idempotencyKey || null, userId: user.id, customerName: user.name, policyId: policy.id, policyNumber: policy.policyNumber,
    memberId: member.id, memberName: member.fullName, hospitalId: hospital?.id || null, hospitalName: hospital?.name || String(b.hospitalName).trim(),
    networkHospital: !!hospital?.network, expectedAdmissionDate: b.expectedAdmissionDate, admissionType, natureOfIllness: illness,
    preferredType, cashlessEligible: !!hospital?.network, insurerId: policy.insurerId || null, insurerName: insurer?.name || policy.insurerName || null,
    tpaId: tpa?.id || null, tpaName: tpa?.name || null, status: 'Intimated', claimId: null, notes: [],
    history: [{ at: now().toISOString(), action: 'Intimated', by: user.name, note: `${admissionType} admission expected ${b.expectedAdmissionDate}` }],
  });
  rec.history.push({ at: now().toISOString(), action: 'Sent to insurer', by: 'VHC Claims Ops', note: `Insurer intimation reference ${rec.insurerIntimationRef} (sandbox — simulated)` });
  publish('CLAIM_INTIMATED', { intimationId: rec.id, intimationNumber: rec.intimationNumber, policyId: policy.id, preferredType }, { idempotencyKey: `claim-intimated:${rec.id}`, actor: user, subject: { type: 'claimIntimation', id: rec.id } });
  audit(user, 'CLAIM_INTIMATED', 'claimIntimation', rec.id, { intimationNumber: rec.intimationNumber, policyNumber: policy.policyNumber });
  notify(user.id, 'Claim intimation received', `${rec.intimationNumber}: we have informed the insurer. ${rec.cashlessEligible ? 'At admission, the hospital insurance desk raises the cashless request — or you can convert this intimation into a claim here.' : 'After treatment, convert this intimation into a reimbursement claim and upload your bills.'}`, { link: `/claims/intimations/${rec.id}` });
  for (const u of db.find('users', (x) => isTeam(x) && x.status === 'Active')) notify(u.id, 'New claim intimation', `${rec.intimationNumber} · ${rec.hospitalName} · expected ${rec.expectedAdmissionDate}`, { dedupeKey: `intimation:${rec.id}:${u.id}`, link: '/ops/intimations' });
  return rec;
}

/** Validates that an intimation can be converted into the claim being filed. */
export function intimationForClaim(user, intimationId, b) {
  if (!intimationId) return null;
  const rec = db.get('claimIntimations', intimationId);
  if (!rec || rec.userId !== user.id) throw notFound('Intimation not found');
  if (rec.status !== 'Intimated') throw conflict(`Intimation ${rec.intimationNumber} is already ${rec.status.toLowerCase()}`);
  if (rec.policyId !== b.policyId || rec.memberId !== b.memberId) throw bad('The claim must be for the same policy and member as the intimation');
  return rec;
}

export function intimationView(rec, user) {
  const v = structuredClone(rec);
  if (!isTeam(user)) delete v.notes;
  v.claim = rec.claimId ? (() => { const c = db.get('healthClaims', rec.claimId); return c ? { id: c.id, claimNumber: c.claimNumber, status: c.status, unifiedStatus: unifiedStatus(c).status } : null; })() : null;
  return v;
}

import { Router } from 'express';
import { db, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { AppError, bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { isValidDate } from '../utils/dates.js';
import { assertPaise } from '../utils/money.js';
import { assertHealthClaimAccess } from '../services/access.js';
import { transition } from '../services/lifecycle.js';
import { available, evaluateHealthClaim } from '../services/settlement.js';
import { audit, notify } from '../services/audit.js';
import { bucketFilter } from '../services/buckets.js';

const r = Router();
r.use(authenticate);
const officer = requireRole('claims_officer', 'admin');
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const FINAL = ['Settled', 'Rejected', 'Preauth Rejected'];

const load = (req) => assertHealthClaimAccess(req.user, db.get('healthClaims', req.params.id));

function view(claim, user) {
  const policy = db.get('policies', claim.policyId);
  const v = structuredClone(claim);
  v.policy = { id: policy.id, policyNumber: policy.policyNumber, planName: policy.planName, planType: policy.planType, startDate: policy.startDate, endDate: policy.endDate, coverage: policy.coverage, available: available(policy), reserved: policy.balance.reserved, paid: policy.balance.paid };
  v.member = policy.members.find((m) => m.id === claim.memberId);
  if (user.role === 'customer') delete v.internalNotes;
  v.payouts = db.find('payouts', (p) => p.claimId === claim.id);
  return v;
}

export function validatePayoutDetails(d) {
  if (!d?.accountName?.trim()) throw bad('Payout account holder name is required');
  if (!/^\d{9,18}$/.test(d.accountNumber || '')) throw bad('Payout account number must be 9–18 digits');
  if (!IFSC.test(String(d.ifsc || '').toUpperCase())) throw bad('A valid IFSC code is required (e.g. VHCB0001234)');
  return { accountName: d.accountName.trim(), accountNumber: d.accountNumber, ifsc: d.ifsc.toUpperCase() };
}

r.get('/', (req, res) => {
  const { status, type } = req.query;
  let list = req.user.role === 'customer' ? db.find('healthClaims', (c) => c.userId === req.user.id)
    : ['claims_officer', 'admin'].includes(req.user.role) ? db.all('healthClaims') : [];
  list = list.filter((c) => (!status || c.status === status) && (!type || c.type === type)).filter(bucketFilter('claims', req.query.bucket));
  res.json([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => ({
    id: c.id, claimNumber: c.claimNumber, type: c.type, status: c.status, policyNumber: c.policyNumber, memberName: c.memberName,
    hospitalName: c.hospitalName, admissionDate: c.admissionDate, requestedAmount: c.requestedAmount,
    approvedAmount: c.assessment?.approvedAmount ?? null, createdAt: c.createdAt, updatedAt: c.updatedAt,
  })));
});

r.get('/:id', (req, res) => res.json(view(load(req), req.user)));

r.post('/', requireRole('customer'), (req, res) => {
  const b = req.body || {};
  if (b.idempotencyKey) {
    const prior = db.findOne('healthClaims', (c) => c.idempotencyKey === b.idempotencyKey && c.userId === req.user.id);
    if (prior) return res.json(view(prior, req.user));
  }
  const policy = db.get('policies', b.policyId);
  if (!policy || policy.userId !== req.user.id || policy.product !== 'health') throw notFound('Policy not found');
  const member = policy.members.find((m) => m.id === b.memberId);
  if (!member) throw bad('The selected person is not insured under this policy');
  if (!['cashless', 'reimbursement'].includes(b.type)) throw bad('type must be cashless or reimbursement');
  if (!isValidDate(b.admissionDate) || !isValidDate(b.dischargeDate)) throw bad('Valid admission and discharge dates are required');
  if (b.dischargeDate < b.admissionDate) throw bad('Discharge date cannot be before the admission date');
  if (!b.diagnosis?.trim() || !b.treatment?.trim()) throw bad('Diagnosis and treatment description are required');
  assertPaise(b.requestedAmount, 'requestedAmount');
  let hospital = b.hospitalId ? db.get('hospitals', b.hospitalId) : null;
  if (b.type === 'cashless') {
    if (!hospital || !hospital.active || !hospital.network) throw unprocessable('Cashless claims are available only at active network hospitals. You can still file a reimbursement claim.');
  } else {
    if (!hospital && !b.hospitalName?.trim()) throw bad('Hospital is required');
    if (b.admissionDate > today()) throw bad('Reimbursement claims are for treatment that has already taken place');
  }
  if (b.admissionDate < policy.startDate || b.admissionDate > policy.endDate) {
    throw unprocessable(`Treatment date must fall within the coverage period ${policy.startDate} to ${policy.endDate}`);
  }
  if (b.type === 'reimbursement' && !db.get('users', req.user.id)?.mobileVerified) {
    throw new AppError(403, 'Verify your mobile number before submitting payout details.', { code: 'MOBILE_NOT_VERIFIED' });
  }
  const payoutDetails = b.type === 'reimbursement' ? validatePayoutDetails(b.payoutDetails) : null;
  const dup = db.findOne('healthClaims', (c) => c.policyId === policy.id && c.memberId === member.id && c.admissionDate === b.admissionDate && c.type === b.type && !FINAL.includes(c.status));
  if (dup) throw conflict(`A ${b.type} claim (${dup.claimNumber}) already exists for this admission`);

  const claim = tx(() => {
    const c = db.insert('healthClaims', {
      claimNumber: `HC-${today().slice(0, 4)}-${String(nextSeq('healthClaim')).padStart(6, '0')}`,
      idempotencyKey: b.idempotencyKey || null, userId: req.user.id, policyId: policy.id, policyNumber: policy.policyNumber,
      memberId: member.id, memberName: member.fullName, type: b.type,
      hospitalId: hospital?.id || null, hospitalName: hospital?.name || b.hospitalName.trim(), networkHospital: !!hospital?.network,
      admissionDate: b.admissionDate, dischargeDate: b.dischargeDate, diagnosis: b.diagnosis.trim(), treatment: b.treatment.trim(),
      isAccident: !!b.isAccident, requestedAmount: b.requestedAmount, payoutDetails, payoutVerified: false,
      status: b.type === 'cashless' ? 'Preauth Requested' : 'Submitted', preauth: null, assessment: null,
      reservedAmount: 0, paidAmount: 0, documentRequests: [], internalNotes: [], timeline: [],
    });
    c.timeline.push({ at: now().toISOString(), status: c.status, by: req.user.name, role: 'customer', note: b.type === 'cashless' ? 'Pre-authorisation requested' : 'Reimbursement claim submitted' });
    audit(req.user, 'HEALTH_CLAIM_SUBMITTED', 'healthClaim', c.id, { claimNumber: c.claimNumber, type: c.type, requested: c.requestedAmount });
    notify(req.user.id, 'Claim received', `Claim ${c.claimNumber} has been registered.`, { link: `/claims/${c.id}` });
    return c;
  });
  res.status(201).json(view(claim, req.user));
});

r.post('/:id/request-documents', officer, (req, res) => {
  const c = load(req);
  const note = req.body?.note?.trim();
  if (!note) throw bad('Describe the documents required');
  if ([...FINAL, 'Approved'].includes(c.status)) throw conflict(`Claim is ${c.status}`);
  tx(() => {
    if (c.status !== 'Documents Requested') c.resumeStatus = c.status;
    c.documentRequests.push({ note, at: now().toISOString(), by: req.user.name, resolved: false });
    transition(c, 'Documents Requested', req.user, note);
    audit(req.user, 'CLAIM_DOCUMENTS_REQUESTED', 'healthClaim', c.id, { note });
    notify(c.userId, 'Documents needed for your claim', `${c.claimNumber}: ${note}`, { type: 'warning', link: `/claims/${c.id}` });
  });
  res.json(view(c, req.user));
});

r.post('/:id/respond', requireRole('customer'), (req, res) => {
  const c = load(req);
  if (c.status !== 'Documents Requested') throw conflict('No documents are currently requested');
  tx(() => {
    c.documentRequests.forEach((d) => { d.resolved = true; });
    transition(c, c.resumeStatus || 'Submitted', req.user, req.body?.note || 'Requested documents provided');
  });
  res.json(view(c, req.user));
});

r.post('/:id/notes', officer, (req, res) => {
  const c = load(req);
  if (!req.body?.note?.trim()) throw bad('Note is required');
  tx(() => c.internalNotes.push({ at: now().toISOString(), by: req.user.name, note: req.body.note.trim() }));
  res.json(view(c, req.user));
});

r.post('/:id/preauth', officer, (req, res) => {
  const c = load(req);
  if (c.type !== 'cashless' || c.status !== 'Preauth Requested') throw conflict('Claim is not awaiting pre-authorisation');
  const { decision, amount, reason } = req.body || {};
  const policy = db.get('policies', c.policyId);
  tx(() => {
    if (decision === 'approve') {
      assertPaise(amount, 'amount');
      const hospital = db.get('hospitals', c.hospitalId);
      if (!hospital?.active || !hospital.network) throw unprocessable('Hospital is no longer an active network hospital');
      if (amount > available(policy)) throw unprocessable(`Pre-authorisation exceeds the remaining coverage (${available(policy)} paise)`);
      policy.balance.reserved += amount;
      c.reservedAmount = amount;
      c.preauth = { status: 'approved', amount, provisional: true, by: req.user.name, at: now().toISOString(), note: reason || null };
      transition(c, 'Preauth Approved', req.user, 'Provisional pre-authorisation approved; final settlement follows final bill review');
    } else if (decision === 'reject') {
      if (!reason?.trim()) throw bad('A reason is required to refuse pre-authorisation');
      c.preauth = { status: 'rejected', by: req.user.name, at: now().toISOString(), reason };
      transition(c, 'Preauth Rejected', req.user, `${reason}. You may still submit a reimbursement claim after treatment.`);
    } else throw bad('decision must be approve or reject');
    audit(req.user, `PREAUTH_${decision.toUpperCase()}`, 'healthClaim', c.id, { amount, reason });
    notify(c.userId, `Pre-authorisation ${decision === 'approve' ? 'approved' : 'refused'}`, `${c.claimNumber}: ${decision === 'approve' ? 'provisional approval granted (final amount decided after the final bill)' : `${reason}. A reimbursement claim is still possible.`}`, { link: `/claims/${c.id}` });
  });
  res.json(view(c, req.user));
});

r.post('/:id/final-bill', requireRole('customer', 'claims_officer', 'admin'), (req, res) => {
  const c = load(req);
  if (c.type !== 'cashless' || c.status !== 'Preauth Approved') throw conflict('Final bill can be submitted after pre-authorisation approval');
  const { finalAmount, dischargeDate, note } = req.body || {};
  assertPaise(finalAmount, 'finalAmount');
  if (dischargeDate && (!isValidDate(dischargeDate) || dischargeDate < c.admissionDate)) throw bad('Discharge date cannot be before the admission date');
  tx(() => {
    c.finalBill = { amount: finalAmount, at: now().toISOString(), by: req.user.name, note: note || null };
    c.requestedAmount = finalAmount;
    if (dischargeDate) c.dischargeDate = dischargeDate;
    transition(c, 'Final Bill Submitted', req.user, 'Final hospital bill submitted for review');
  });
  res.json(view(c, req.user));
});

function parseItems(items) {
  if (items == null) return null;
  if (!Array.isArray(items)) throw bad('billItems must be an array');
  return items.map((i, k) => {
    assertPaise(i.amount, `billItems[${k}].amount`, { allowZero: true });
    return { description: String(i.description || `Item ${k + 1}`), category: ['room', 'medical', 'surgery', 'pharmacy', 'diagnostics', 'non_medical'].includes(i.category) ? i.category : 'medical', amount: i.amount, admissible: i.admissible !== false };
  });
}

r.post('/:id/assess', officer, (req, res) => {
  const c = load(req);
  if (!['Submitted', 'Under Review', 'Final Bill Submitted'].includes(c.status)) throw conflict(`Claim cannot be assessed while ${c.status}`);
  const items = parseItems(req.body?.billItems);
  const policy = db.get('policies', c.policyId);
  tx(() => {
    c.billItems = items;
    c.assessment = { ...evaluateHealthClaim(policy, c, items), by: req.user.name };
    if (c.status === 'Submitted') transition(c, 'Under Review', req.user, 'Assessment in progress');
    db.touch(c);
  });
  res.json(view(c, req.user));
});

r.post('/:id/verify-payout', officer, (req, res) => {
  const c = load(req);
  if (c.type !== 'reimbursement') throw bad('Cashless claims are settled to the hospital');
  tx(() => {
    if (req.body?.payoutDetails) c.payoutDetails = validatePayoutDetails(req.body.payoutDetails);
    c.payoutVerified = true;
    c.payoutVerifiedBy = req.user.name;
    audit(req.user, 'PAYOUT_DETAILS_VERIFIED', 'healthClaim', c.id);
  });
  res.json(view(c, req.user));
});

r.post('/:id/approve', officer, (req, res) => {
  const c = load(req);
  if (!['Under Review', 'Final Bill Submitted'].includes(c.status)) throw conflict(`Claim cannot be approved while ${c.status}`);
  if (!c.assessment) throw conflict('Run the assessment first');
  const policy = db.get('policies', c.policyId);
  tx(() => {
    // Re-evaluate against the live balance so concurrent family claims cannot exceed shared coverage.
    const a = evaluateHealthClaim(policy, c, c.billItems);
    if (!a.eligible) throw unprocessable(`Claim is not payable: ${a.reasons.join('; ')}. Reject it with a reason instead.`);
    if (a.approvedAmount <= 0) throw unprocessable('No coverage remains for this claim');
    policy.balance.reserved += a.approvedAmount - c.reservedAmount; // replaces any provisional preauth reservation
    c.reservedAmount = a.approvedAmount;
    c.assessment = { ...a, by: req.user.name, approvedBy: req.user.name, approvedAt: now().toISOString() };
    transition(c, 'Approved', req.user, `Approved ${a.approvedAmount} paise (requested ${a.requestedAmount}, deducted ${a.totalDeducted})`);
    audit(req.user, 'HEALTH_CLAIM_APPROVED', 'healthClaim', c.id, { approved: a.approvedAmount, eligible: a.eligibleAmount, deductible: a.deductible, copay: a.copay });
    notify(c.userId, 'Claim approved', `${c.claimNumber} approved. Settlement will follow shortly.`, { type: 'success', link: `/claims/${c.id}` });
  });
  res.json(view(c, req.user));
});

r.post('/:id/reject', officer, (req, res) => {
  const c = load(req);
  const reason = req.body?.reason?.trim();
  if (!reason) throw bad('A rejection reason is required');
  if (FINAL.includes(c.status)) throw conflict(`Claim is already ${c.status}`);
  if (db.findOne('payouts', (p) => p.claimId === c.id && ['initiated', 'success'].includes(p.status))) throw conflict('A payout is already in progress');
  const policy = db.get('policies', c.policyId);
  tx(() => {
    policy.balance.reserved -= c.reservedAmount;
    c.reservedAmount = 0;
    c.rejection = { reason, by: req.user.name, at: now().toISOString() };
    transition(c, 'Rejected', req.user, reason);
    audit(req.user, 'HEALTH_CLAIM_REJECTED', 'healthClaim', c.id, { reason });
    notify(c.userId, 'Claim rejected', `${c.claimNumber}: ${reason}`, { type: 'error', link: `/claims/${c.id}` });
  });
  res.json(view(c, req.user));
});

export default r;

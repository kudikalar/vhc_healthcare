// Simulated payment gateway (premiums in) and payout rail (claims out).
// Both are idempotent: unique references, idempotency keys, and callbacks that
// are ignored once a terminal state has been applied.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { AppError, bad, conflict, forbidden, notFound } from '../utils/errors.js';
import { sum } from '../utils/money.js';
import { APP_STATUS, issuePolicy, policyStatusAt, transition } from './lifecycle.js';
import { audit, notify, raiseException } from './audit.js';

function uniqueRef(prefix, col) {
  let ref;
  do {
    ref = `${prefix}-${today().replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  } while (db.findOne(col, (p) => p.reference === ref));
  return ref;
}

export function overdueInstallments(policy, at = today()) {
  return policy.schedule.filter((i) => i.status !== 'paid' && i.dueDate <= at).sort((a, b) => a.no - b.no);
}

/** Works out what a payment is for and the exact amount the server expects. */
export function resolvePaymentTarget(user, body) {
  const { purpose } = body;
  if (purpose === 'application') {
    const app = db.get('applications', body.applicationId);
    if (!app || (user.role === 'customer' && app.userId !== user.id)) throw notFound('Application not found');
    if (app.status === APP_STATUS.ISSUED) throw conflict('This application has already been paid and the policy issued');
    if (app.status !== APP_STATUS.ACCEPTED) throw conflict('Payment is available only after you accept the approved offer');
    return { targetKey: `app:${app.id}`, amount: app.offer.firstPayment, userId: app.userId, applicationId: app.id, description: `First premium for ${app.applicationNumber}` };
  }
  const policy = db.get('policies', body.policyId);
  if (!policy || (user.role === 'customer' && policy.userId !== user.id)) throw notFound('Policy not found');
  if (policy.product !== 'life') throw bad('Installment payments apply to life policies');
  const status = policyStatusAt(policy);
  if (['Terminated', 'Expired'].includes(status)) throw conflict(`Policy is ${status}; premiums cannot be collected`);
  if (purpose === 'installment') {
    const inst = policy.schedule.find((i) => i.no === Number(body.installmentNo));
    if (!inst) throw notFound('Installment not found');
    if (inst.status === 'paid') throw conflict(`Installment ${inst.no} is already paid`);
    const firstUnpaid = policy.schedule.filter((i) => i.status !== 'paid').sort((a, b) => a.no - b.no)[0];
    if (firstUnpaid.no !== inst.no) throw conflict(`Please pay installment ${firstUnpaid.no} first`);
    if (status === 'Lapsed') throw conflict('Policy has lapsed. Submit a reinstatement request to restore coverage');
    return { targetKey: `inst:${policy.id}:${inst.no}`, amount: inst.amount, userId: policy.userId, policyId: policy.id, installmentNo: inst.no, description: `Installment ${inst.no} for ${policy.policyNumber}` };
  }
  if (purpose === 'reinstatement') {
    const reqst = db.findOne('reinstatements', (r) => r.policyId === policy.id && r.status === 'Approved');
    if (!reqst) throw conflict('No approved reinstatement request for this policy');
    if (reqst.payBy < today()) throw conflict('The reinstatement approval has expired; submit a new request');
    const overdue = overdueInstallments(policy);
    if (!overdue.length) throw conflict('Nothing is overdue on this policy');
    return { targetKey: `reinst:${reqst.id}`, amount: sum(overdue, (i) => i.amount), userId: policy.userId, policyId: policy.id, reinstatementId: reqst.id, installmentNos: overdue.map((i) => i.no), description: `Reinstatement arrears for ${policy.policyNumber}` };
  }
  throw bad('Unknown payment purpose');
}

export function initiatePayment(user, body, actor = user) {
  if (!body.idempotencyKey) throw bad('idempotencyKey is required');
  const existing = db.findOne('payments', (p) => p.idempotencyKey === body.idempotencyKey && p.userId === (user.role === 'customer' ? user.id : p.userId));
  if (existing) return { payment: existing, replayed: true };
  const target = resolvePaymentTarget(user, body);
  if (body.amount !== target.amount) {
    throw new AppError(400, `Incorrect amount: expected ${target.amount} paise`, { expected: target.amount, received: body.amount });
  }
  if (db.findOne('payments', (p) => p.targetKey === target.targetKey && p.status === 'success')) throw conflict('This item has already been paid');
  const payment = db.insert('payments', {
    reference: uniqueRef('PAY', 'payments'), ...target, purpose: body.purpose, status: 'pending',
    idempotencyKey: body.idempotencyKey, method: body.method || 'simulated-gateway', callbacks: [], initiatedBy: actor?.id,
  });
  audit(actor, 'PAYMENT_INITIATED', 'payment', payment.id, { reference: payment.reference, amount: payment.amount, purpose: payment.purpose });
  return { payment, replayed: false };
}

function applyPaymentEffect(payment, actor) {
  if (payment.purpose === 'application') {
    const app = db.get('applications', payment.applicationId);
    if (app.status !== APP_STATUS.ACCEPTED) return 'Application is no longer awaiting payment';
    issuePolicy(app, payment, actor);
    return null;
  }
  const policy = db.get('policies', payment.policyId);
  if (payment.purpose === 'installment') {
    const inst = policy.schedule.find((i) => i.no === payment.installmentNo);
    if (inst.status === 'paid') return `Installment ${inst.no} was already paid by ${inst.paymentRef}`;
    Object.assign(inst, { status: 'paid', paidAt: now().toISOString(), paymentRef: payment.reference });
    notify(policy.userId, 'Premium received', `Installment ${inst.no} for ${policy.policyNumber} has been received.`, { type: 'success', link: `/policies/${policy.id}` });
    return null;
  }
  if (payment.purpose === 'reinstatement') {
    const reqst = db.get('reinstatements', payment.reinstatementId);
    if (reqst.status !== 'Approved') return 'Reinstatement is no longer awaiting payment';
    for (const no of payment.installmentNos) {
      const inst = policy.schedule.find((i) => i.no === no);
      if (inst.status === 'paid') continue;
      Object.assign(inst, { status: 'paid', paidAt: now().toISOString(), paymentRef: payment.reference });
    }
    reqst.status = 'Completed';
    reqst.completedAt = now().toISOString();
    policy.reinstatedOn = today();
    notify(policy.userId, 'Policy reinstated', `${policy.policyNumber} has been reinstated.`, { type: 'success', link: `/policies/${policy.id}` });
    return null;
  }
  return 'Unknown payment purpose';
}

/** Gateway callback. Repeated callbacks for a finished payment are acknowledged but have no effect. */
export function processPaymentCallback({ reference, status, amount }, actor = { name: 'Payment Gateway', role: 'system' }) {
  const payment = db.findOne('payments', (p) => p.reference === reference);
  if (!payment) throw notFound('Payment reference not found');
  payment.callbacks.push({ at: now().toISOString(), status, amount });
  if (['success', 'failed', 'refund_due'].includes(payment.status)) {
    audit(actor, 'PAYMENT_CALLBACK_DUPLICATE', 'payment', payment.id, { reference, status });
    return { payment, duplicate: true };
  }
  if (!['success', 'failed', 'pending'].includes(status)) throw bad('status must be success, failed or pending');
  if (status === 'pending') return { payment, duplicate: false };
  if (status === 'failed') {
    payment.status = 'failed';
    payment.failureReason = 'Declined by simulated gateway';
    payment.completedAt = now().toISOString();
    audit(actor, 'PAYMENT_FAILED', 'payment', payment.id, { reference });
    notify(payment.userId, 'Payment failed', `Payment ${reference} for ${payment.description} failed. You can retry.`, { type: 'error' });
    if (payment.autoPay) raiseException('autopay_failed', payment.id, 'Automatic premium collection failed', { reference });
    return { payment, duplicate: false };
  }
  if (amount != null && amount !== payment.amount) {
    payment.status = 'failed';
    payment.failureReason = `Amount mismatch: gateway reported ${amount}, expected ${payment.amount}`;
    raiseException('payment_amount_mismatch', payment.id, payment.failureReason, { reference });
    audit(actor, 'PAYMENT_AMOUNT_MISMATCH', 'payment', payment.id, { reference, amount });
    return { payment, duplicate: false };
  }
  const problem = applyPaymentEffect(payment, actor);
  payment.completedAt = now().toISOString();
  if (problem) {
    payment.status = 'refund_due';
    payment.failureReason = problem;
    raiseException('duplicate_collection', payment.id, `${problem}; refund required`, { reference });
    audit(actor, 'PAYMENT_REFUND_DUE', 'payment', payment.id, { reference, problem });
  } else {
    payment.status = 'success';
    audit(actor, 'PAYMENT_SUCCEEDED', 'payment', payment.id, { reference, amount: payment.amount, purpose: payment.purpose });
  }
  db.touch(payment);
  return { payment, duplicate: false };
}

// ---------------- payouts ----------------
export function initiatePayout(actor, { claimType, claimId, beneficiaryId }) {
  if (claimType === 'health') {
    const claim = db.get('healthClaims', claimId);
    if (!claim) throw notFound('Claim not found');
    if (claim.status !== 'Approved') throw conflict('Only approved claims can be paid out');
    if (claim.type === 'reimbursement' && !claim.payoutVerified) throw conflict('Verify the payout bank details first');
    if (db.findOne('payouts', (p) => p.claimId === claim.id && ['initiated', 'success'].includes(p.status))) throw conflict('A payout for this claim is already in progress or completed');
    const payee = claim.type === 'cashless' ? { name: claim.hospitalName, account: 'Network hospital settlement account' } : { name: claim.payoutDetails.accountName, account: maskAcct(claim.payoutDetails.accountNumber) };
    const payout = db.insert('payouts', {
      reference: uniqueRef('PO', 'payouts'), claimType, claimId, claimNumber: claim.claimNumber, policyId: claim.policyId,
      payee, amount: claim.assessment.approvedAmount, status: 'initiated', callbacks: [], initiatedBy: actor.id,
    });
    audit(actor, 'PAYOUT_INITIATED', 'payout', payout.id, { reference: payout.reference, amount: payout.amount, claimNumber: claim.claimNumber });
    return payout;
  }
  if (claimType === 'life') {
    const claim = db.get('lifeClaims', claimId);
    if (!claim) throw notFound('Claim not found');
    if (claim.status !== 'Approved' && claim.status !== 'Partially Paid') throw conflict('Only fully approved claims (two approvals) can be paid out');
    const ben = claim.beneficiaries.find((b) => b.id === beneficiaryId);
    if (!ben) throw notFound('Beneficiary not found');
    if (!ben.verified || !ben.payoutDetails?.accountNumber) throw conflict('Beneficiary identity and payout details must be verified');
    if (ben.paid) throw conflict('This beneficiary has already been paid');
    if (db.findOne('payouts', (p) => p.claimId === claim.id && p.beneficiaryId === ben.id && ['initiated', 'success'].includes(p.status))) throw conflict('A payout for this beneficiary is already in progress');
    const payout = db.insert('payouts', {
      reference: uniqueRef('PO', 'payouts'), claimType, claimId, claimNumber: claim.claimNumber, policyId: claim.policyId,
      beneficiaryId: ben.id, payee: { name: ben.name, account: maskAcct(ben.payoutDetails.accountNumber) },
      amount: ben.allocation, status: 'initiated', callbacks: [], initiatedBy: actor.id,
    });
    audit(actor, 'PAYOUT_INITIATED', 'payout', payout.id, { reference: payout.reference, amount: payout.amount, claimNumber: claim.claimNumber });
    return payout;
  }
  throw bad('claimType must be health or life');
}

const maskAcct = (a = '') => `XXXX${String(a).slice(-4)}`;

export function processPayoutCallback({ reference, status }, actor = { name: 'Bank Rail', role: 'system' }) {
  const payout = db.findOne('payouts', (p) => p.reference === reference);
  if (!payout) throw notFound('Payout reference not found');
  payout.callbacks.push({ at: now().toISOString(), status });
  if (payout.status !== 'initiated') {
    audit(actor, 'PAYOUT_CALLBACK_DUPLICATE', 'payout', payout.id, { reference, status });
    return { payout, duplicate: true };
  }
  if (status === 'failed') {
    payout.status = 'failed';
    payout.completedAt = now().toISOString();
    raiseException('payout_failed', payout.id, 'Payout transfer failed', { reference, claimNumber: payout.claimNumber });
    audit(actor, 'PAYOUT_FAILED', 'payout', payout.id, { reference });
    return { payout, duplicate: false };
  }
  if (status !== 'success') throw bad('status must be success or failed');
  payout.status = 'success';
  payout.completedAt = now().toISOString();
  if (payout.claimType === 'health') {
    const claim = db.get('healthClaims', payout.claimId);
    const policy = db.get('policies', claim.policyId);
    // Funds were reserved at approval: move reservation to paid exactly once.
    policy.balance.reserved -= claim.reservedAmount;
    policy.balance.paid += payout.amount;
    claim.reservedAmount = 0;
    claim.paidAmount = payout.amount;
    transition(claim, 'Settled', actor, `Paid ${payout.amount} paise via ${reference}`);
    notify(claim.userId, 'Claim settled', `Claim ${claim.claimNumber} has been settled.`, { type: 'success', link: `/claims/${claim.id}` });
  } else {
    const claim = db.get('lifeClaims', payout.claimId);
    const ben = claim.beneficiaries.find((b) => b.id === payout.beneficiaryId);
    ben.paid = true;
    ben.paidRef = reference;
    ben.paidAt = now().toISOString();
    const policy = db.get('policies', claim.policyId);
    if (claim.beneficiaries.filter((b) => b.allocation > 0).every((b) => b.paid)) {
      transition(claim, 'Settled', actor, 'All beneficiary payouts completed');
      policy.deathBenefitSettled = true;
      policy.terminatedOn = today();
      policy.terminationReason = `Death claim ${claim.claimNumber} settled`;
      audit(actor, 'POLICY_TERMINATED', 'policy', policy.id, { reason: policy.terminationReason });
    } else if (claim.status !== 'Partially Paid') {
      transition(claim, 'Partially Paid', actor, `Paid ${ben.name}`);
    }
  }
  audit(actor, 'PAYOUT_SUCCEEDED', 'payout', payout.id, { reference, amount: payout.amount });
  return { payout, duplicate: false };
}

export function assertCanSimulate(user, payment) {
  if (user.role === 'customer' && payment.userId !== user.id) throw forbidden();
}

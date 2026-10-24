// Insurer Integration Hub.
//
// Every insurer is reached through an adapter chosen by insurer.integration.adapter. Insurers do not
// share one API, so each adapter maps its own protocol, auth, timeouts and status codes onto the small
// set of operations below. Only the sandbox simulator ships here; real adapters are added per signed
// agreement (see registerAdapter).
//
// Policy issuance is the insurer's decision. Flow:
//   payment captured (payments.js) → PAYMENT_CAPTURED event → premium posted to the facilitated ledger
//   → adapter.requestIssuance() → issued | pending | declined
//   issued   → policy record created from the insurer's confirmation, commission accrued, POLICY_ISSUED
//   pending  → proposal stays "Issuance Pending" until the insurer (portal/callback) decides
//   declined → proposal "Declined by Insurer", refund created, POLICY_DECLINED
import crypto from 'node:crypto';
import { db, meta } from '../db.js';
import { now } from '../clock.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { pct } from '../utils/money.js';
import { APP_STATUS, issuePolicy, transition } from './lifecycle.js';
import { audit, notify } from './audit.js';
import { on, publish } from './events.js';
import { commissionBpFor, gatewayFee, post as postLedger } from './ledger.js';
import { createRefund } from './refunds.js';

export const SANDBOX_INSURER_ID = 'ins_sandbox';
export const ISSUANCE_MODES = ['auto', 'manual', 'decline'];

const adapters = new Map();
export function registerAdapter(key, adapter) { adapters.set(key, adapter); }
export const adapterKeys = () => [...adapters.keys()];
export const getAdapter = (key) => adapters.get(key) || null;

/**
 * Operations an insurer integration can offer. Each adapter declares which ones it supports so the
 * Integration Hub shows gaps honestly instead of implying a capability exists.
 */
export const OPERATIONS = [
  ['catalog', 'Product catalogue'], ['quotation', 'Quotation / rating'], ['proposal', 'Proposal submission'],
  ['underwriting_status', 'Underwriting status'], ['payment_reconciliation', 'Payment reconciliation'], ['issuance', 'Policy issuance'],
  ['document_retrieval', 'Policy document retrieval'], ['endorsements', 'Endorsements'], ['renewal', 'Renewal'], ['cancellation', 'Cancellation'],
  ['claims_intimation', 'Claims intimation'], ['claims_status', 'Claims status'], ['network_hospitals', 'Network hospitals'], ['servicing', 'Policy servicing'],
].map(([key, label]) => ({ key, label }));

/** Sandbox simulator. Behaviour is controlled from Integrations (admin) via meta.mockInsurer. */
registerAdapter('mock-sandbox', {
  name: 'Sandbox insurer simulator (synthetic)',
  protocol: 'in-process',
  sandboxOnly: true,
  // What the simulator really does; every other operation is unsupported (handled by VHC staff or not available).
  operations: {
    catalog: 'VHC-hosted sandbox product catalogue',
    quotation: 'VHC sandbox rating engine (synthetic rates)',
    proposal: 'Proposal accepted in-process',
    payment_reconciliation: 'Premium ledger reconciled inside VHC (test mode only)',
    issuance: 'Auto / manual / decline modes (meta.mockInsurer.issuanceMode)',
    renewal: 'Renewal proposals use the same issuance path',
    network_hospitals: 'Uses the synthetic VHC hospital network',
  },
  requestIssuance() {
    const mode = meta().mockInsurer?.issuanceMode || 'auto';
    if (mode === 'auto') return { status: 'issued', insurerReference: `SBX-${crypto.randomBytes(4).toString('hex').toUpperCase()}` };
    if (mode === 'decline') return { status: 'declined', reason: 'Sandbox insurer declined the proposal (simulated underwriting decision)' };
    return { status: 'pending' };
  },
  /** Certification dry run: no side effects; confirms the simulator answers for each supported operation. */
  certify(ins) {
    if (!ins?.sandbox) return { ok: false, reason: 'The sandbox simulator may only be used by synthetic sandbox insurers' };
    const mode = meta().mockInsurer?.issuanceMode || 'auto';
    return { ok: ISSUANCE_MODES.includes(mode), checks: Object.keys(this.operations).map((operation) => ({ operation, ok: true })), note: `Simulator reachable in-process; current issuance mode "${mode}"` };
  },
});

/** Adapter catalogue for the Integration Hub: which operations each registered adapter supports. */
export function adapterCatalogue() {
  return [...adapters.entries()].map(([key, a]) => ({
    key, name: a.name, protocol: a.protocol, sandboxOnly: !!a.sandboxOnly, certifiable: typeof a.certify === 'function',
    operations: OPERATIONS.map((o) => ({ ...o, supported: !!a.operations?.[o.key], note: a.operations?.[o.key] || 'Not supported by this adapter' })),
  }));
}

export function insurerOf(planOrPolicy) {
  return planOrPolicy?.insurerId ? db.get('insurers', planOrPolicy.insurerId) : null;
}

/**
 * Whether a product may be sold right now. Live distribution requires an active insurer with a valid
 * agreement that authorises the product; sandbox products are only sellable in test payment mode.
 */
export function distributionStatus(plan, at = now().toISOString().slice(0, 10)) {
  const ins = insurerOf(plan);
  if (!ins) return { allowed: false, reason: 'No insurer is linked to this product' };
  const live = process.env.PAYMENT_MODE === 'live';
  if (ins.status !== 'Active') return { allowed: false, reason: `Insurer status is ${ins.status}` };
  // The original sandbox insurer self-authorises its synthetic products; every other insurer (including
  // additional synthetic ones) must list the product under its agreement.
  const authorised = ins.id === SANDBOX_INSURER_ID || (ins.authorizedPlanIds || []).includes(plan.id);
  if (ins.sandbox) {
    if (live) return { allowed: false, reason: 'Sandbox products cannot be sold in live mode' };
    if (!authorised) return { allowed: false, reason: 'Product is not authorised for this sandbox insurer' };
    return { allowed: true, sandbox: true };
  }
  const a = ins.agreement;
  if (!a || !a.signedAt || (a.validTo && a.validTo < at) || (a.validFrom && a.validFrom > at)) return { allowed: false, reason: 'No valid insurer agreement' };
  if (!authorised) return { allowed: false, reason: 'Product is not authorised under the agreement' };
  if (!ins.regulatoryApproval?.liveSalesApproved) return { allowed: false, reason: 'Live sales are blocked pending regulatory approval', blockedByRegulatoryApproval: true };
  return { allowed: true, sandbox: false };
}

function paymentFor(app) {
  return db.findOne('payments', (p) => p.applicationId === app.id && p.status === 'success');
}

/** Applies an insurer issuance decision to a proposal that is waiting for one. */
export function applyIssuanceDecision(app, { decision, reason, insurerReference }, actor) {
  if (!app) throw notFound('Application not found');
  if (app.status !== APP_STATUS.ISSUANCE_PENDING) throw conflict(`Proposal is ${app.status}, not awaiting issuance`);
  const payment = paymentFor(app);
  if (!payment) throw conflict('No captured payment found for this proposal');
  const plan = db.get('plans', app.planId);
  app.issuance = { ...(app.issuance || {}), decidedAt: now().toISOString(), decidedBy: actor?.name || 'Insurer', decision };
  if (decision === 'issued') {
    const policy = issuePolicy(app, payment, actor);
    policy.insurerPolicyReference = insurerReference || null;
    app.issuance.insurerReference = insurerReference || null;
    const bp = commissionBpFor(policy.insurerId);
    if (bp > 0) {
      postLedger({
        ledger: 'vhc_commission', direction: 'credit', amount: pct(payment.amount, bp), description: `Commission accrued on ${policy.policyNumber} (${bp / 100}%)`,
        refType: 'policy', refId: policy.id, reference: policy.policyNumber, insurerId: policy.insurerId, userId: policy.userId,
        correlationId: payment.correlationId, idempotencyKey: `commission:${policy.id}`, mode: payment.mode,
      });
    }
    publish('POLICY_ISSUED', { policyId: policy.id, applicationId: app.id }, { correlationId: payment.correlationId, idempotencyKey: `issued:${app.id}`, actor, subject: { type: 'policy', id: policy.id } });
    return { status: 'issued', policy };
  }
  if (decision === 'declined') {
    if (!reason?.trim()) throw bad('A decline reason is required');
    app.issuance.reason = reason;
    transition(app, APP_STATUS.INSURER_DECLINED, actor, `${plan?.insurerName || 'Insurer'} declined issuance: ${reason}. A full refund has been initiated.`);
    const refund = createRefund(payment, { reason: `Insurer declined issuance: ${reason}`, idempotencyKey: `decline-refund:${app.id}` }, actor);
    audit(actor, 'POLICY_DECLINED', 'application', app.id, { reason, refund: refund.reference });
    notify(app.userId, 'Policy not issued', `The insurer did not issue a policy for ${app.applicationNumber}. Your payment will be refunded in full.`, { type: 'error', link: `/applications/${app.id}` });
    publish('POLICY_DECLINED', { applicationId: app.id, refundId: refund.id }, { correlationId: payment.correlationId, idempotencyKey: `declined:${app.id}`, actor, subject: { type: 'application', id: app.id } });
    return { status: 'declined', refund };
  }
  throw bad('decision must be issued or declined');
}

/** Asks the insurer to issue; used by the PAYMENT_CAPTURED handler and by manual retries. */
export function requestIssuance(app, actor = { name: 'Integration Hub', role: 'system' }) {
  const plan = db.get('plans', app.planId);
  const ins = insurerOf(plan);
  const adapter = adapters.get(ins?.integration?.adapter || 'mock-sandbox');
  if (!adapter) throw conflict(`No integration adapter configured for ${ins?.name || 'this insurer'}`);
  app.issuance = { ...(app.issuance || {}), insurerId: ins?.id || null, adapter: ins?.integration?.adapter || 'mock-sandbox', requestedAt: now().toISOString(), attempts: (app.issuance?.attempts || 0) + 1, status: 'requested' };
  const pay = paymentFor(app);
  publish('POLICY_ISSUANCE_REQUESTED', { applicationId: app.id, insurerId: ins?.id || null, attempt: app.issuance.attempts }, {
    correlationId: pay?.correlationId, idempotencyKey: `issuance-requested:${app.id}:${app.issuance.attempts}`, actor, subject: { type: 'application', id: app.id },
  });
  const res = adapter.requestIssuance(app, ins);
  app.issuance.status = res.status;
  db.touch(app);
  if (res.status === 'issued') return applyIssuanceDecision(app, { decision: 'issued', insurerReference: res.insurerReference }, { name: ins?.name || 'Insurer', role: 'insurer' });
  if (res.status === 'declined') return applyIssuanceDecision(app, { decision: 'declined', reason: res.reason }, { name: ins?.name || 'Insurer', role: 'insurer' });
  notify(app.userId, 'Payment received — awaiting insurer', `We received your payment for ${app.applicationNumber}. The insurer is confirming issuance; we will notify you when your policy is issued.`, { type: 'info', link: `/applications/${app.id}`, dedupeKey: `issuance-pending:${app.id}` });
  return { status: 'pending' };
}

// ---------- event handlers ----------
on('PAYMENT_CAPTURED', 'ledger.premium', ({ paymentId }) => {
  const p = db.get('payments', paymentId);
  if (!p) throw new Error('Payment not found');
  postLedger({ ledger: 'premium_facilitated', direction: 'credit', amount: p.amount, description: `Premium ${p.reference}: ${p.description}`, refType: 'payment', refId: p.id, reference: p.reference, insurerId: p.insurerId, userId: p.userId, correlationId: p.correlationId, idempotencyKey: `premium:${p.id}`, mode: p.mode });
  const { fee, gst } = gatewayFee(p.amount);
  if (fee > 0) postLedger({ ledger: 'gateway_fee', direction: 'credit', amount: fee, description: `Gateway fee on ${p.reference}`, refType: 'payment', refId: p.id, reference: p.reference, correlationId: p.correlationId, idempotencyKey: `gwfee:${p.id}`, mode: p.mode });
  if (gst > 0) postLedger({ ledger: 'tax', direction: 'credit', amount: gst, description: `GST on gateway fee for ${p.reference}`, refType: 'payment', refId: p.id, reference: p.reference, correlationId: p.correlationId, idempotencyKey: `gwgst:${p.id}`, mode: p.mode });
  return 'posted';
});

on('PAYMENT_CAPTURED', 'insurer.issuance', ({ paymentId }) => {
  const p = db.get('payments', paymentId);
  if (!p || p.purpose !== 'application') return 'not-applicable';
  const app = db.get('applications', p.applicationId);
  if (!app || app.status !== APP_STATUS.ISSUANCE_PENDING) return 'not-awaiting-issuance';
  return requestIssuance(app).status;
});

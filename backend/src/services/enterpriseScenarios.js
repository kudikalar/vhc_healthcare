// Payment scenario catalogue (§10) for admin/QA: every scenario with how to run it by hand and, where it
// can be automated, a self-check. Automated checks run as dry runs: each executes inside a transaction
// that is always rolled back, against a synthetic copy of a seeded proposal, so nothing is persisted —
// no payments, ledger lines, policies or notifications survive a run.
import { db, meta, nextSeq, tx } from '../db.js';
import { now } from '../clock.js';
import { APP_STATUS } from './lifecycle.js';
import { createRefund } from './refunds.js';
import { reconciliation, simulateGatewaySettlement } from './enterpriseFinance.js';
import {
  assertLinkUsable, createPaymentLink, expireStalePayments, handleWebhook, initiateOrResume, linkView, payByCard, payByNetbanking,
  payByQr, payByUpi, pendingExpiryMinutes, signWebhook, upiQr,
} from './enterprisePayments.js';
import { processPaymentCallback } from './payments.js';

class Rollback extends Error { constructor(value) { super('rollback'); this.value = value; } }

/** Runs fn inside a transaction and always rolls it back, returning fn's result (or the thrown error). */
function dryRun(fn) {
  try {
    tx(() => { throw new Rollback(fn()); });
  } catch (e) {
    if (e instanceof Rollback) return e.value;
    return { pass: false, detail: `Error: ${e.message}` };
  }
  return { pass: false, detail: 'Dry run did not complete' };
}

function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
}

/** Synthetic proposal awaiting payment, cloned from a seeded issued proposal (exists only inside the dry run). */
function fixture({ insurerMode = 'auto' } = {}) {
  const src = db.find('applications', (a) => a.status === APP_STATUS.ISSUED && a.product === 'health' && a.offer)[0];
  if (!src) throw new Error('No seeded issued health proposal to clone');
  const { id: _id, ...rest } = structuredClone(src); // eslint-disable-line no-unused-vars
  const app = db.insert('applications', { ...rest, applicationNumber: `SCN-${String(nextSeq('scenario')).padStart(5, '0')}`, status: APP_STATUS.ACCEPTED, policyId: null, paymentRef: null, issuance: null, timeline: [] });
  const owner = db.get('users', app.userId);
  meta().mockInsurer = { ...(meta().mockInsurer || {}), issuanceMode: insurerMode };
  const user = { id: owner.id, role: 'customer', name: owner.name, email: owner.email };
  const start = (key = `scn-${Math.random()}`) => initiateOrResume(user, { purpose: 'application', applicationId: app.id, amount: app.offer.firstPayment, idempotencyKey: key }).payment;
  return { app, user, start };
}

const year = () => new Date().getUTCFullYear() + 2;
const card = (number, extra = {}) => ({ cardNumber: number, expMonth: 12, expYear: year(), cvc: '123', name: 'QA Tester', ...extra });
const policyFor = (app) => db.findOne('policies', (p) => p.applicationId === app.id);
const check = (cond, ok, bad) => ({ pass: !!cond, detail: cond ? ok : bad });

function cardOutcome(number, expect) {
  const f = fixture();
  const p = f.start();
  const first = payByCard(p, card(number));
  if (first.requiresAction !== 'otp') return { pass: false, detail: 'Expected the simulated bank OTP page' };
  payByCard(p, card(number, { otp: '123456' }));
  const pol = policyFor(f.app);
  if (expect === 'success') return check(p.status === 'success' && pol && f.app.status === APP_STATUS.ISSUED, `Payment success, then insurer issued ${pol?.policyNumber}`, `Payment ${p.status}, proposal ${f.app.status}`);
  return check(p.status === 'failed' && p.failureCode === expect && !pol && f.app.status === APP_STATUS.ACCEPTED, `Payment failed (${p.failureCode}); no policy; proposal still awaiting payment`, `Payment ${p.status}/${p.failureCode}, policy ${pol ? 'created' : 'none'}`);
}

const expectThrow = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(`${e.message} ${e.details?.code || ''}`); } };

export const SCENARIOS = [
  { id: 'card-visa-success', group: 'Cards', title: 'Visa test card succeeds', how: 'Checkout → Card → 4100 2800 0000 1007, any future expiry, any CVV → bank OTP page → 123456.', expected: 'Payment success; insurer issuance follows as a separate event (auto mode issues the policy).', run: () => cardOutcome('4100280000001007', 'success') },
  { id: 'card-mastercard-success', group: 'Cards', title: 'Mastercard test card succeeds', how: 'Card 5555 5100 0008 1006 → OTP 123456.', expected: 'Payment success and policy issued by the sandbox insurer.', run: () => cardOutcome('5555510000081006', 'success') },
  { id: 'card-insufficient-funds', group: 'Cards', title: 'Insufficient funds', how: 'Card 4100 2800 0008 0001 → OTP 123456.', expected: 'Payment failed (INSUFFICIENT_FUNDS); no policy; customer can retry.', run: () => cardOutcome('4100280000080001', 'INSUFFICIENT_FUNDS') },
  { id: 'card-cancelled', group: 'Cards', title: 'Payment cancelled', how: 'Card 4100 2800 0007 0002 → OTP 123456 (or press Cancel on the bank page with any card).', expected: 'Payment failed (PAYMENT_CANCELLED); no policy.', run: () => cardOutcome('4100280000070002', 'PAYMENT_CANCELLED') },
  { id: 'card-bank-declined', group: 'Cards', title: 'Bank declined', how: 'Card 4100 2800 0006 0003 → OTP 123456.', expected: 'Payment failed (BANK_DECLINED); no policy.', run: () => cardOutcome('4100280000060003', 'BANK_DECLINED') },
  { id: 'card-otp-failure', group: 'Cards', title: 'Bank OTP authentication fails', how: 'Any Razorpay success card → enter a wrong OTP, or press "Fail authentication".', expected: 'Payment failed (AUTHENTICATION_FAILED); nothing charged.', run: () => {
    const f = fixture(); const p = f.start();
    payByCard(p, card('4100280000001007', { otp: '000000' }));
    return check(p.status === 'failed' && p.failureCode === 'AUTHENTICATION_FAILED' && !policyFor(f.app), 'Authentication failure recorded; no policy', `Payment ${p.status}/${p.failureCode}`);
  } },
  { id: 'card-validation', group: 'Cards', title: 'Expired card / non-test card rejected', how: 'Enter an expiry in the past, or a real-looking card number that is not a published test card.', expected: 'Validation error; the payment stays pending and nothing is stored.', run: () => {
    const f = fixture(); const p = f.start();
    const expired = expectThrow(() => payByCard(p, card('4100280000001007', { expMonth: 1, expYear: 2020 })), /check your card/i);
    const notTest = expectThrow(() => payByCard(p, card('4111111111111111')), /NOT_A_TEST_CARD/);
    return check(expired && notTest && p.status === 'pending' && !p.card, 'Both rejected before any gateway call; payment still pending', 'Validation did not reject as expected');
  } },
  { id: 'upi-success', group: 'UPI', title: 'UPI collect succeeds', how: 'Checkout → UPI → success@razorpay.', expected: 'Payment success; policy issued.', run: () => {
    const f = fixture(); const p = f.start(); payByUpi(p, { vpa: 'success@razorpay' });
    return check(p.status === 'success' && p.method === 'upi' && policyFor(f.app), 'UPI success; policy issued', `Payment ${p.status}`);
  } },
  { id: 'upi-failure', group: 'UPI', title: 'UPI collect fails', how: 'Checkout → UPI → failure@razorpay.', expected: 'Payment failed (UPI_FAILED); no policy.', run: () => {
    const f = fixture(); const p = f.start(); payByUpi(p, { vpa: 'failure@razorpay' });
    return check(p.status === 'failed' && p.failureCode === 'UPI_FAILED' && !policyFor(f.app), 'UPI failure; no policy', `Payment ${p.status}`);
  } },
  { id: 'upi-qr', group: 'UPI', title: 'UPI QR (simulated scan)', how: 'Checkout → UPI QR → "Simulate successful scan".', expected: 'QR payload carries the payment reference and amount; scan completes the payment.', run: () => {
    const f = fixture(); const p = f.start(); const qr = upiQr(p); payByQr(p, { outcome: 'success' });
    return check(qr.payload.includes(p.reference) && p.status === 'success', 'QR payload references the order; simulated scan captured', `Payment ${p.status}`);
  } },
  { id: 'netbanking', group: 'Netbanking', title: 'Netbanking success and failure', how: 'Checkout → Netbanking → "Sandbox Bank A (succeeds)" or "Sandbox Bank B (fails)".', expected: 'Bank A captures; Bank B fails with NETBANKING_FAILED.', run: () => {
    const a = fixture(); const pa = a.start(); payByNetbanking(pa, { bank: 'SBXB_OK' });
    const b = fixture(); const pb = b.start(); payByNetbanking(pb, { bank: 'SBXB_FAIL' });
    return check(pa.status === 'success' && pb.status === 'failed' && pb.failureCode === 'NETBANKING_FAILED', 'Success bank captured; failure bank declined', `A=${pa.status} B=${pb.status}`);
  } },
  { id: 'pending-then-webhook', group: 'Async', title: 'Delayed confirmation, then webhook', how: 'Netbanking → "Sandbox Bank C (delayed)" (or legacy card 4000 0000 0000 0259); then the gateway webhook confirms.', expected: 'Payment pending; customer told not to pay again; webhook success captures it once.', run: () => {
    const f = fixture(); const p = f.start(); payByNetbanking(p, { bank: 'SBXB_SLOW' });
    const wasPending = p.status === 'pending';
    withEnv({ PAYMENT_WEBHOOK_SECRET: null }, () => handleWebhook({ raw: Buffer.from('{}'), body: { reference: p.reference, status: 'success', amount: p.amount }, headers: {} }));
    return check(wasPending && p.status === 'success', 'Pending → captured by webhook', `Pending=${wasPending}, final=${p.status}`);
  } },
  { id: 'timeout-expiry', group: 'Async', title: 'Abandoned / timed-out payment expires', how: 'Start checkout and close it. After the expiry window (PAYMENT_PENDING_EXPIRY_MINUTES, default 30) the scheduled job runs.', expected: 'Payment marked expired (TIMED_OUT); customer notified; not charged; can start again.', run: () => {
    const f = fixture(); const p = f.start();
    p.createdAt = new Date(now().getTime() - (pendingExpiryMinutes() + 1) * 60000).toISOString();
    expireStalePayments();
    return check(p.status === 'expired' && p.failureCode === 'TIMED_OUT', `Expired after ${pendingExpiryMinutes()} minutes`, `Payment ${p.status}`);
  } },
  { id: 'double-click', group: 'Idempotency', title: 'Double click / retry with the same idempotency key', how: 'Submit checkout twice quickly (the client reuses one idempotency key per checkout).', expected: 'One payment record; the second call replays it.', run: () => {
    const f = fixture(); const a = f.start('same-key'); const b = f.start('same-key');
    return check(a.id === b.id, 'Same payment returned', 'Two payments created');
  } },
  { id: 'refresh-resume', group: 'Idempotency', title: 'Customer refreshes and starts the same order again', how: 'Open checkout, refresh the page, open checkout again for the same item.', expected: 'The fresh pending payment is resumed instead of creating a second order.', run: () => {
    const f = fixture(); const a = f.start('k1'); const b = f.start('k2');
    return check(a.id === b.id && db.find('payments', (p) => p.applicationId === f.app.id).length === 1, 'Pending order resumed', 'Second order created');
  } },
  { id: 'duplicate-webhook', group: 'Webhooks', title: 'Duplicate webhook', how: 'Deliver the same success callback twice (different event ids).', expected: 'Second delivery acknowledged as duplicate; one policy, one ledger posting.', run: () => {
    const f = fixture(); const p = f.start();
    processPaymentCallback({ reference: p.reference, status: 'success', amount: p.amount });
    const dup = processPaymentCallback({ reference: p.reference, status: 'success', amount: p.amount });
    const posts = db.find('ledgerEntries', (e) => e.idempotencyKey === `premium:${p.id}`).length;
    const pols = db.find('policies', (x) => x.applicationId === f.app.id).length;
    return check(dup.duplicate && posts === 1 && pols === 1, 'Duplicate ignored; single policy and ledger entry', `duplicate=${dup.duplicate} ledger=${posts} policies=${pols}`);
  } },
  { id: 'invalid-signature', group: 'Webhooks', title: 'Webhook with an invalid signature', how: 'Set PAYMENT_WEBHOOK_SECRET; POST /api/payments/callback with a wrong x-razorpay-signature.', expected: '401 Invalid webhook signature; payment unchanged.', run: () => withEnv({ PAYMENT_WEBHOOK_SECRET: 'scenario-secret' }, () => {
    const f = fixture(); const p = f.start();
    const raw = Buffer.from(JSON.stringify({ reference: p.reference, status: 'success', amount: p.amount }));
    const rejected = expectThrow(() => handleWebhook({ raw, body: JSON.parse(raw), headers: { 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': 'evt_bad' } }), /signature/i);
    return check(rejected && p.status === 'pending', 'Rejected; payment still pending', 'Unsigned/invalid webhook accepted');
  }) },
  { id: 'webhook-replay', group: 'Webhooks', title: 'Webhook replay (same event id)', how: 'Deliver a correctly signed webhook twice with the same x-razorpay-event-id.', expected: 'First processed; the replay is rejected with 409.', run: () => withEnv({ PAYMENT_WEBHOOK_SECRET: 'scenario-secret' }, () => {
    const f = fixture(); const p = f.start();
    const raw = Buffer.from(JSON.stringify({ reference: p.reference, status: 'success', amount: p.amount }));
    const headers = { 'x-razorpay-signature': signWebhook(raw, 'scenario-secret'), 'x-razorpay-event-id': 'evt_scn_1' };
    handleWebhook({ raw, body: JSON.parse(raw), headers });
    const replay = expectThrow(() => handleWebhook({ raw, body: JSON.parse(raw), headers }), /replay/i);
    return check(p.status === 'success' && replay, 'Signed event processed once; replay rejected', `status=${p.status} replayRejected=${replay}`);
  }) },
  { id: 'amount-mismatch', group: 'Webhooks', title: 'Gateway reports a different amount', how: 'Send a success callback with a different amount.', expected: 'Payment failed with an amount-mismatch exception; no policy.', run: () => {
    const f = fixture(); const p = f.start();
    processPaymentCallback({ reference: p.reference, status: 'success', amount: p.amount - 100 });
    const exc = db.findOne('exceptions', (e) => e.refId === p.id && e.type === 'payment_amount_mismatch');
    return check(p.status === 'failed' && exc && !policyFor(f.app), 'Mismatch caught and raised to the exception queue', `Payment ${p.status}`);
  } },
  { id: 'insurer-declines', group: 'Insurer', title: 'Payment captured, insurer declines', how: 'Dev tools → sandbox insurer mode "decline", then pay.', expected: 'Proposal "Declined by Insurer", no policy, full refund created automatically.', run: () => {
    const f = fixture({ insurerMode: 'decline' }); const p = f.start(); payByUpi(p, { vpa: 'success@razorpay' });
    const refund = db.findOne('refunds', (r) => r.paymentId === p.id);
    return check(f.app.status === APP_STATUS.INSURER_DECLINED && !policyFor(f.app) && refund?.amount === p.amount, 'Declined; full refund created', `Proposal ${f.app.status}`);
  } },
  { id: 'issuance-pending', group: 'Insurer', title: 'Payment captured, issuance pending', how: 'Insurer mode "manual", then pay; open Finance → Reconciliation.', expected: 'No policy yet; reconciliation lists "captured but issuance pending".', run: () => {
    const f = fixture({ insurerMode: 'manual' }); const p = f.start(); payByUpi(p, { vpa: 'success@razorpay' });
    const rec = reconciliation({ mode: p.mode || 'test' });
    return check(f.app.status === APP_STATUS.ISSUANCE_PENDING && rec.exceptions.some((e) => e.type === 'captured_issuance_pending' && e.paymentId === p.id), 'Flagged in reconciliation', `Proposal ${f.app.status}`);
  } },
  { id: 'partial-full-refund', group: 'Refunds', title: 'Partial refund then full-refund limit', how: 'Finance → Refunds: refund part of a captured payment, then try to refund the full amount.', expected: 'Partial accepted; refunds beyond the remaining balance are refused.', run: () => {
    const f = fixture(); const p = f.start(); payByUpi(p, { vpa: 'success@razorpay' });
    const half = Math.floor(p.amount / 2);
    createRefund(p, { amount: half, reason: 'Scenario partial' }, { name: 'QA' });
    const over = expectThrow(() => createRefund(p, { amount: p.amount, reason: 'Scenario full' }, { name: 'QA' }), /exceeds/i);
    const rest = createRefund(p, { reason: 'Scenario remaining' }, { name: 'QA' });
    return check(over && rest.amount === p.amount - half, 'Limits enforced; remaining balance refundable', 'Refund limits not enforced');
  } },
  { id: 'payment-link-expiry', group: 'Links', title: 'Payment link expires', how: 'Payments → create a payment link; wait past its expiry (or move the test clock).', expected: 'Link shows expired and cannot start a payment.', run: () => {
    const f = fixture();
    const link = createPaymentLink(f.user, { purpose: 'application', applicationId: f.app.id });
    link.expiresAt = new Date(now().getTime() - 1000).toISOString();
    linkView(link);
    return check(link.status === 'expired' && expectThrow(() => assertLinkUsable(link), /expired/i), 'Expired link refused', `Link ${link.status}`);
  } },
  { id: 'settlement-mismatch', group: 'Settlement', title: 'Gateway settlement mismatch', how: 'Finance → Reconciliation → "Import simulated gateway settlement (with mismatch)".', expected: 'Reconciliation flags the short-settled payment.', run: () => {
    const f = fixture(); const p = f.start(); payByUpi(p, { vpa: 'success@razorpay' });
    simulateGatewaySettlement({ mode: p.mode || 'test', injectMismatch: true }, { name: 'QA' });
    const rec = reconciliation({ mode: p.mode || 'test' });
    return check(rec.exceptions.some((e) => e.type === 'settlement_mismatch'), 'Settlement mismatch flagged', 'Not flagged');
  } },
  { id: 'live-mode-refuses', group: 'Safety', title: 'Live mode refuses simulators', how: 'Start the API with PAYMENT_MODE=live and try any test method.', expected: 'Every simulator returns 403 LIVE_MODE; unsigned webhooks are refused.', run: () => {
    const f = fixture(); const p = f.start();
    return withEnv({ PAYMENT_MODE: 'live', PAYMENT_WEBHOOK_SECRET: null }, () => {
      const refused = expectThrow(() => payByUpi(p, { vpa: 'success@razorpay' }), /live/i);
      const unsigned = expectThrow(() => handleWebhook({ raw: Buffer.from('{}'), body: { reference: p.reference, status: 'success' }, headers: {} }), /live/i);
      return check(refused && unsigned && p.status === 'pending', 'Simulators and unsigned webhooks refused in live mode', 'A simulator ran in live mode');
    });
  } },
];

export function catalogue() {
  const last = db.all('scenarioRuns').at(-1) || null;
  return {
    total: SCENARIOS.length, lastRun: last ? { at: last.at, by: last.by, passed: last.passed, failed: last.failed } : null,
    scenarios: SCENARIOS.map(({ id, group, title, how, expected, run }) => ({ id, group, title, how, expected, automated: !!run, result: last?.results?.[id] || null })),
  };
}

/** Runs every automated scenario as an isolated dry run and stores only the summary. */
export function runScenarios(actor, ids) {
  const results = {};
  for (const s of SCENARIOS.filter((x) => x.run && (!ids?.length || ids.includes(x.id)))) {
    const r = dryRun(s.run);
    results[s.id] = { pass: !!r?.pass, detail: r?.detail || '', at: now().toISOString() };
  }
  const passed = Object.values(results).filter((r) => r.pass).length;
  return tx(() => db.insert('scenarioRuns', { at: now().toISOString(), by: actor.name, results, passed, failed: Object.keys(results).length - passed }));
}

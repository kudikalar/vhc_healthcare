// Payments sandbox (test mode): checkout methods, gateway webhook verification, abandonment/expiry,
// payment links and sandbox receipts / invoices. Gateway state changes always go through
// processPaymentCallback() in services/payments.js so the idempotency rules live in one place.
//
// Nothing here moves real money. PAYMENT_MODE=live refuses every simulator (cards, UPI, QR, netbanking,
// manual simulate) and refuses unsigned webhooks.
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { db, meta } from '../db.js';
import { now } from '../clock.js';
import { AppError, bad, conflict, notFound } from '../utils/errors.js';
import { rupees } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { initiatePayment, processPaymentCallback, resolvePaymentTarget } from './payments.js';
import { resolveTestBank, resolveTestCard, resolveTestVpa, TEST_OTP } from './testCards.js';

export const paymentMode = () => (process.env.PAYMENT_MODE === 'live' ? 'live' : 'test');
export const pendingExpiryMinutes = () => Number(process.env.PAYMENT_PENDING_EXPIRY_MINUTES) || meta().enterprise?.pendingExpiryMinutes || 30;

/** Every simulator refuses to run in live mode. */
export function assertTestMode() {
  if (paymentMode() === 'live') throw new AppError(403, 'Payment simulators are disabled in live mode.', { code: 'LIVE_MODE' });
}

export function findPayment(reference) {
  const p = db.findOne('payments', (x) => x.reference === reference);
  if (!p) throw notFound('Payment not found');
  return p;
}

function assertPayable(payment) {
  if (payment.status === 'expired') throw conflict('This payment timed out. Start a new payment — you have not been charged.', { code: 'PAYMENT_EXPIRED' });
  if (payment.status !== 'pending') throw conflict(`This payment is already ${payment.status}`);
}

const ageMinutes = (p) => (now().getTime() - new Date(p.createdAt).getTime()) / 60000;

/**
 * Initiates (or safely resumes) a payment. Same idempotency key → the same payment; a customer who
 * refreshes or opens checkout twice for the same item while a fresh payment is still pending gets that
 * pending payment back instead of a second order.
 */
export function initiateOrResume(user, body) {
  if (body.idempotencyKey && db.findOne('payments', (p) => p.idempotencyKey === body.idempotencyKey && (user.role !== 'customer' || p.userId === user.id))) {
    return initiatePayment(user, body);
  }
  let target = null;
  try { target = resolvePaymentTarget(user, body); } catch { target = null; }
  if (target && body.amount === target.amount) {
    const open = db.find('payments', (p) => p.targetKey === target.targetKey && p.userId === target.userId && p.status === 'pending' && !p.autoPay && ageMinutes(p) < pendingExpiryMinutes())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (open) {
      audit(user, 'PAYMENT_RESUMED', 'payment', open.id, { reference: open.reference });
      return { payment: open, replayed: true, resumed: true };
    }
  }
  const out = initiatePayment(user, body);
  if (!out.replayed) out.payment.mode = paymentMode();
  return out;
}

/** Applies a simulated gateway outcome and records the attempt (method metadata only — never PAN/CVV/OTP). */
function applyOutcome(payment, { status, code, reason, method, details }) {
  payment.attempts ||= [];
  payment.attempts.push({ at: now().toISOString(), method, status, code: code || null, ...details });
  payment.method = method;
  if (method === 'card') payment.card = { brand: details.brand, last4: details.last4, expMonth: details.expMonth, expYear: details.expYear, set: details.set };
  if (method === 'upi' || method === 'upi_qr') payment.upi = { vpa: details.vpa || null, qr: method === 'upi_qr' };
  if (method === 'netbanking') payment.netbanking = { bank: details.bank, bankName: details.bankName };
  const result = processPaymentCallback({ reference: payment.reference, status, amount: payment.amount });
  if (result.payment.status === 'failed' && !result.duplicate) {
    if (reason) result.payment.failureReason = reason;
    result.payment.failureCode = code || 'FAILED';
  }
  if (status === 'pending') { result.payment.failureReason = undefined; result.payment.failureCode = undefined; }
  db.touch(result.payment);
  return result;
}

/**
 * Card checkout. Razorpay test cards (and legacy 3-D Secure cards) need the simulated bank OTP page:
 * the first call returns requiresAction='otp'; the second carries the OTP (or bankAction fail/cancel).
 */
export function payByCard(payment, body = {}) {
  assertTestMode();
  assertPayable(payment);
  const card = resolveTestCard(body);
  const needsOtp = card.otp || card.outcome === '3ds';
  const { otp, bankAction } = body;
  if (needsOtp && otp == null && !bankAction) {
    return { payment, requiresAction: 'otp', card: { brand: card.brand, last4: card.last4 }, bank: card.set === 'razorpay' ? 'Sandbox bank OTP page (Razorpay test mode)' : '3-D Secure (legacy simulator)' };
  }
  let status = card.outcome === 'failed' ? 'failed' : card.outcome === 'pending' ? 'pending' : 'success';
  let { code, reason } = card;
  if (needsOtp) {
    if (bankAction === 'cancel') { status = 'failed'; code = 'PAYMENT_CANCELLED'; reason = 'Payment cancelled by the customer on the bank page'; }
    else if (bankAction === 'fail' || String(otp) !== TEST_OTP) { status = 'failed'; code = 'AUTHENTICATION_FAILED'; reason = '3-D Secure / bank OTP authentication failed'; }
  }
  const details = { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear, set: card.set };
  return { ...applyOutcome(payment, { status, code, reason, method: 'card', details }), card: { brand: card.brand, last4: card.last4 } };
}

export function payByUpi(payment, { vpa } = {}) {
  assertTestMode();
  assertPayable(payment);
  const v = resolveTestVpa(vpa);
  return applyOutcome(payment, { status: v.outcome, code: v.code, reason: v.reason, method: 'upi', details: { vpa: v.vpa } });
}

/** UPI QR (simulated). The payload is a standard UPI intent string; the QR image is drawn by the client. */
export function upiQr(payment) {
  assertTestMode();
  assertPayable(payment);
  const expiresAt = new Date(Math.min(new Date(payment.createdAt).getTime() + pendingExpiryMinutes() * 60000, now().getTime() + 15 * 60000)).toISOString();
  const am = (payment.amount / 100).toFixed(2);
  return {
    reference: payment.reference, amount: payment.amount, expiresAt,
    payload: `upi://pay?pa=vhc.sandbox@razorpay&pn=${encodeURIComponent('Vision Health Care (Sandbox)')}&am=${am}&cu=INR&tr=${payment.reference}&tn=${encodeURIComponent('Sandbox premium — not a real payment request')}`,
    note: 'Simulated QR for test mode only. Scanning it with a real UPI app will not work and no money can move.',
  };
}

export function payByQr(payment, { outcome = 'success' } = {}) {
  assertTestMode();
  assertPayable(payment);
  if (!['success', 'failed'].includes(outcome)) throw bad('outcome must be success or failed');
  return applyOutcome(payment, { status: outcome, code: outcome === 'failed' ? 'UPI_FAILED' : null, reason: outcome === 'failed' ? 'UPI QR payment failed (simulated)' : null, method: 'upi_qr', details: { vpa: null } });
}

export function payByNetbanking(payment, { bank, outcome } = {}) {
  assertTestMode();
  assertPayable(payment);
  const b = resolveTestBank(bank);
  let status = b.outcome;
  if (b.outcome === 'choose') {
    if (!['success', 'failed'].includes(outcome)) return { payment, requiresAction: 'bank', bank: { code: b.code, name: b.name } };
    status = outcome;
  }
  return applyOutcome(payment, {
    status, code: status === 'failed' ? b.codeOnFail || 'NETBANKING_FAILED' : null, reason: status === 'failed' ? b.reason || 'Netbanking authorisation failed (simulated)' : null,
    method: 'netbanking', details: { bank: b.code, bankName: b.name },
  });
}

// ---------------------------------------------------------------- webhook
export function signWebhook(raw, secret) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}
export function verifyWebhookSignature(raw, signature, secret) {
  if (!signature || !secret) return false;
  const expected = Buffer.from(signWebhook(raw, secret), 'hex');
  let got;
  try { got = Buffer.from(String(signature), 'hex'); } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Normalises the legacy simulator body and a Razorpay-style event body to { reference, status, amount }. */
function parseWebhook(body = {}) {
  if (body.reference) return { reference: body.reference, status: body.status, amount: body.amount };
  const entity = body.payload?.payment?.entity;
  if (body.event && entity) {
    const map = { 'payment.captured': 'success', 'payment.authorized': 'pending', 'payment.failed': 'failed', 'order.paid': 'success' };
    return { reference: entity.notes?.reference || entity.receipt || null, status: map[body.event] || null, amount: entity.amount, gatewayPaymentId: entity.id || null };
  }
  return { reference: null };
}

/**
 * Gateway webhook. With PAYMENT_WEBHOOK_SECRET set, an HMAC-SHA256 hex signature of the raw body is
 * required in x-razorpay-signature and an event id (x-razorpay-event-id or body.id/eventId) may be
 * processed only once (replays are rejected). Unsigned callbacks are accepted only in test mode when no
 * secret is configured. Repeated callbacks for a finished payment are acknowledged with no effect.
 */
export function handleWebhook({ raw, body, headers }) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  const eventId = headers['x-razorpay-event-id'] || body?.eventId || (body?.event ? body?.id : null) || null;
  const signature = headers['x-razorpay-signature'];
  if (secret) {
    if (!verifyWebhookSignature(raw, signature, secret)) {
      audit({ name: 'Payment Gateway', role: 'system' }, 'WEBHOOK_SIGNATURE_REJECTED', 'webhook', eventId, { hasSignature: !!signature });
      throw new AppError(401, 'Invalid webhook signature', { code: 'INVALID_SIGNATURE' });
    }
    if (!eventId) throw bad('Signed webhooks must carry an event id (x-razorpay-event-id)');
  } else if (paymentMode() === 'live') {
    throw new AppError(401, 'Unsigned webhooks are refused in live mode; configure PAYMENT_WEBHOOK_SECRET.', { code: 'UNSIGNED_LIVE' });
  }
  if (eventId && db.findOne('webhookEvents', (w) => w.eventId === eventId)) {
    audit({ name: 'Payment Gateway', role: 'system' }, 'WEBHOOK_REPLAY_REJECTED', 'webhook', eventId, {});
    throw new AppError(409, 'Webhook event already processed (replay rejected)', { code: 'REPLAY' });
  }
  const parsed = parseWebhook(body);
  if (!parsed.reference) throw bad('reference is required');
  const record = db.insert('webhookEvents', { eventId: eventId || null, reference: parsed.reference, status: parsed.status, signed: !!secret, receivedAt: now().toISOString() });
  const out = processPaymentCallback({ reference: parsed.reference, status: parsed.status, amount: parsed.amount });
  if (parsed.gatewayPaymentId) out.payment.gatewayPaymentId ||= parsed.gatewayPaymentId;
  record.result = out.duplicate ? 'duplicate' : out.payment.status;
  return out;
}

// ---------------------------------------------------------------- abandonment / timeout
/** Pending payments older than the expiry window become `expired` (the customer was not charged). */
export function expireStalePayments() {
  let expired = 0;
  const limit = pendingExpiryMinutes();
  for (const p of db.find('payments', (x) => x.status === 'pending' && !x.autoPay)) {
    if (ageMinutes(p) < limit) continue;
    p.status = 'expired';
    p.failureReason = `No confirmation from the gateway within ${limit} minutes (abandoned or timed out). You have not been charged.`;
    p.failureCode = 'TIMED_OUT';
    p.completedAt = now().toISOString();
    db.touch(p);
    audit({ name: 'Scheduler', role: 'system' }, 'PAYMENT_EXPIRED', 'payment', p.id, { reference: p.reference });
    notify(p.userId, 'Payment timed out', `Payment ${p.reference} was not completed and has expired. You can start a new payment.`, { type: 'warning', link: '/payments', dedupeKey: `expired:${p.id}` });
    expired += 1;
  }
  return { paymentsExpired: expired };
}

// ---------------------------------------------------------------- payment links
const LINK_HOURS = { min: 1, max: 168, default: 24 };
export function linkView(link) {
  if (link.status === 'active' && link.expiresAt <= now().toISOString()) { link.status = 'expired'; db.touch(link); }
  const paid = (link.paymentIds || []).map((id) => db.get('payments', id)).find((p) => p?.status === 'success');
  if (paid && link.status !== 'paid') { link.status = 'paid'; link.paidReference = paid.reference; db.touch(link); }
  return link;
}

export function createPaymentLink(actor, body = {}) {
  assertTestMode();
  const target = resolvePaymentTarget(actor, body);
  if (db.findOne('payments', (p) => p.targetKey === target.targetKey && p.status === 'success')) throw conflict('This item has already been paid');
  const hours = Math.min(LINK_HOURS.max, Math.max(LINK_HOURS.min, Number(body.expiresInHours) || LINK_HOURS.default));
  const code = `PL${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const link = db.insert('paymentLinks', {
    code, path: `/pay/${code}`, userId: target.userId, amount: target.amount, description: target.description, targetKey: target.targetKey,
    target: { purpose: body.purpose, applicationId: target.applicationId || null, policyId: target.policyId || null, installmentNo: target.installmentNo || null },
    expiresAt: new Date(now().getTime() + hours * 3600000).toISOString(), status: 'active', paymentIds: [], mode: paymentMode(), createdBy: actor.name,
  });
  audit(actor, 'PAYMENT_LINK_CREATED', 'paymentLink', link.id, { code, amount: link.amount, expiresAt: link.expiresAt });
  if (actor.id !== link.userId) notify(link.userId, 'Payment link', `A sandbox payment link for ${link.description} is ready. It expires on ${link.expiresAt.slice(0, 10)}.`, { link: link.path });
  return link;
}

export function loadLink(code, user) {
  const link = db.findOne('paymentLinks', (l) => l.code === code);
  if (!link || (user.role === 'customer' && link.userId !== user.id)) throw notFound('Payment link not found');
  return linkView(link);
}

/** Validates a link before a payment is initiated from it. */
export function assertLinkUsable(link) {
  if (link.status === 'expired') throw conflict('This payment link has expired. Ask for a new link.', { code: 'LINK_EXPIRED' });
  if (link.status === 'paid') throw conflict('This payment link has already been paid.');
  if (link.status !== 'active') throw conflict(`This payment link is ${link.status}.`);
}

// ---------------------------------------------------------------- receipts & invoices (sandbox)
const premiumGstBp = () => meta().enterprise?.premiumGstBp ?? 0;

export function streamPaymentPdf(payment, res, kind = 'receipt') {
  const user = db.get('users', payment.userId);
  const app = payment.applicationId ? db.get('applications', payment.applicationId) : null;
  const policy = payment.policyId ? db.get('policies', payment.policyId) : db.findOne('policies', (p) => p.firstPaymentRef === payment.reference);
  const insurer = payment.insurerId ? db.get('insurers', payment.insurerId) : policy?.insurerId ? db.get('insurers', policy.insurerId) : null;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const name = `${kind === 'invoice' ? 'INV' : 'RCPT'}-${payment.reference}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  doc.pipe(res);
  doc.rect(50, 40, 495, 26).fill('#fff4d6');
  doc.fillColor('#7a4b00').fontSize(10).text('SANDBOX / TEST MODE — no real money moved. Not valid as a tax or payment document.', 58, 48);
  doc.moveDown(2);
  doc.fillColor('#087f8c').fontSize(20).text('Vision Health Care', 50, 80);
  doc.fillColor('#555').fontSize(9).text('Technology platform. Insurance is issued only by the licensed insurer named below.');
  doc.moveDown();
  doc.fillColor('#14283f').fontSize(15).text(kind === 'invoice' ? 'Tax invoice (sandbox specimen)' : 'Payment receipt (sandbox)');
  doc.moveDown(0.5);
  const row = (k, v) => doc.fillColor('#333').fontSize(10.5).text(`${k}: `, { continued: true }).fillColor('#000').text(String(v ?? '-'));
  if (kind === 'invoice') row('Invoice number', `INV-${payment.reference}`);
  row('Payment reference', payment.reference);
  row('Date', (payment.completedAt || payment.createdAt || '').slice(0, 10));
  row('Received from', user?.legalName || user?.name || 'Customer');
  row('For', payment.description);
  if (app) row('Proposal', app.applicationNumber);
  if (policy) row('Policy', `${policy.policyNumber}${policy.productUin ? ` (UIN ${policy.productUin})` : ''}`);
  row('Insurer', insurer ? `${insurer.name}${insurer.sandbox ? ' — synthetic sandbox entity' : ''}` : 'As named on the product');
  row('Payment method', payment.card ? `${payment.card.brand} card ending ${payment.card.last4}` : payment.upi ? (payment.upi.qr ? 'UPI QR (simulated)' : `UPI ${payment.upi.vpa}`) : payment.netbanking ? `Netbanking — ${payment.netbanking.bankName}` : payment.autoPay ? 'Auto-debit (simulated)' : 'Test gateway');
  row('Mode', (payment.mode || 'test').toUpperCase());
  doc.moveDown();
  if (kind === 'invoice') {
    const gstBp = premiumGstBp();
    const base = gstBp ? Math.round((payment.amount * 10000) / (10000 + gstBp)) : payment.amount;
    const gst = payment.amount - base;
    doc.fillColor('#14283f').fontSize(12).text('Line items');
    row('Insurance premium (collected on behalf of the insurer)', rupees(base));
    row(`GST on premium @ ${(gstBp / 100).toFixed(2)}% (configured)`, rupees(gst));
    row('Total', rupees(payment.amount));
    doc.moveDown(0.5).fontSize(8.5).fillColor('#555').text('Premium is collected on behalf of the insurer and is not VHC revenue. The insurer issues the statutory tax invoice for premium. GST treatment shown here is a sandbox configuration and must be confirmed against the insurer\'s invoice. Supplier GSTIN: not applicable (sandbox).');
  } else {
    row('Amount received', rupees(payment.amount));
    if (payment.refundedAmount) row('Refunded', rupees(payment.refundedAmount));
    row('Status', payment.status + (payment.refundStatus ? ` · refund ${payment.refundStatus.replace(/_/g, ' ')}` : ''));
  }
  doc.moveDown(2).fontSize(8).fillColor('#777').text('Generated by the Vision Health Care staging system. All products, people, partners and amounts are synthetic.');
  doc.end();
}


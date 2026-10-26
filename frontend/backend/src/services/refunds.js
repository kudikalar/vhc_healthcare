// Refunds of captured payments (full or partial). A refund is its own record with a lifecycle
// (pending → processing → completed | failed); the original payment is never edited into a refund.
// In test mode refunds are completed by the simulated gateway; nothing moves real money.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { sum } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { publish } from './events.js';
import { post as postLedger } from './ledger.js';

const ref = () => `RFD-${today().replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

export const refundedOrPending = (paymentId) =>
  sum(db.find('refunds', (r) => r.paymentId === paymentId && r.status !== 'failed'), (r) => r.amount);

/** Creates a refund for a successful payment. amount defaults to the full refundable balance. */
export function createRefund(payment, { amount, reason, idempotencyKey } = {}, actor) {
  if (!payment) throw notFound('Payment not found');
  if (payment.status !== 'success' && payment.status !== 'refund_due') throw conflict('Only captured payments can be refunded');
  if (idempotencyKey) {
    const existing = db.findOne('refunds', (r) => r.idempotencyKey === idempotencyKey);
    if (existing) return existing;
  }
  const refundable = payment.amount - refundedOrPending(payment.id);
  const amt = amount ?? refundable;
  if (!Number.isSafeInteger(amt) || amt <= 0) throw bad('Refund amount must be a positive whole number of paise');
  if (amt > refundable) throw conflict(`Refund exceeds the refundable balance (${refundable} paise)`);
  if (!reason?.trim()) throw bad('A refund reason is required');
  const refund = db.insert('refunds', {
    reference: ref(), paymentId: payment.id, paymentReference: payment.reference, userId: payment.userId,
    insurerId: payment.insurerId || null, amount: amt, partial: amt < payment.amount, reason: reason.trim(),
    status: 'pending', mode: payment.mode || 'test', idempotencyKey: idempotencyKey || null, correlationId: payment.correlationId || null,
    requestedBy: actor?.name || 'System', history: [{ at: now().toISOString(), status: 'pending', by: actor?.name || 'System' }],
  });
  payment.refundStatus = 'pending';
  db.touch(payment);
  audit(actor, 'REFUND_CREATED', 'refund', refund.id, { reference: refund.reference, payment: payment.reference, amount: amt });
  notify(payment.userId, 'Refund initiated', `A refund of your payment ${payment.reference} has been initiated.`, { type: 'info', link: '/payments' });
  publish('REFUND_CREATED', { refundId: refund.id }, { correlationId: payment.correlationId, idempotencyKey: `refund-created:${refund.id}`, actor, subject: { type: 'refund', id: refund.id } });
  return refund;
}

/** Applies the gateway outcome to a refund (simulated in test mode). Repeated outcomes are ignored. */
export function settleRefund(refund, outcome = 'completed', actor = { name: 'Payment Gateway', role: 'system' }) {
  if (!refund) throw notFound('Refund not found');
  if (['completed', 'failed'].includes(refund.status)) return { refund, duplicate: true };
  if (!['completed', 'failed'].includes(outcome)) throw bad('outcome must be completed or failed');
  refund.status = outcome;
  refund.completedAt = now().toISOString();
  refund.history.push({ at: refund.completedAt, status: outcome, by: actor.name });
  db.touch(refund);
  const payment = db.get('payments', refund.paymentId);
  if (outcome === 'completed') {
    postLedger({
      ledger: 'refund', direction: 'credit', amount: refund.amount, description: `Refund ${refund.reference} of ${refund.paymentReference}`,
      refType: 'refund', refId: refund.id, reference: refund.reference, insurerId: refund.insurerId, userId: refund.userId,
      correlationId: refund.correlationId, idempotencyKey: `refund:${refund.id}`, mode: refund.mode,
    });
    // The refunded premium is no longer held for the insurer.
    postLedger({
      ledger: 'premium_facilitated', direction: 'debit', amount: refund.amount, description: `Refund ${refund.reference} reverses facilitated premium`,
      refType: 'refund', refId: refund.id, reference: refund.reference, insurerId: refund.insurerId, userId: refund.userId,
      correlationId: refund.correlationId, idempotencyKey: `refund-premium:${refund.id}`, mode: refund.mode,
    });
    if (payment) {
      const done = sum(db.find('refunds', (r) => r.paymentId === payment.id && r.status === 'completed'), (r) => r.amount);
      payment.refundStatus = done >= payment.amount ? 'refunded' : 'partially_refunded';
      payment.refundedAmount = done;
      db.touch(payment);
    }
    notify(refund.userId, 'Refund completed', `Your refund ${refund.reference} has been processed.`, { type: 'success', link: '/payments' });
    publish('REFUND_COMPLETED', { refundId: refund.id }, { correlationId: refund.correlationId, idempotencyKey: `refund-completed:${refund.id}`, actor, subject: { type: 'refund', id: refund.id } });
  } else if (payment) {
    payment.refundStatus = 'refund_failed';
  }
  audit(actor, outcome === 'completed' ? 'REFUND_COMPLETED' : 'REFUND_FAILED', 'refund', refund.id, { reference: refund.reference });
  return { refund, duplicate: false };
}

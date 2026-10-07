import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate, isStaff, requireRole } from '../middleware/auth.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { resolveTestCard, TEST_CARDS, TEST_OTP } from '../services/testCards.js';
import { assertCanSimulate, initiatePayment, processPaymentCallback } from '../services/payments.js';

const r = Router();

// Gateway webhook (simulated). In production this would verify a gateway signature.
r.post('/callback', (req, res) => {
  const { reference, status, amount } = req.body || {};
  if (!reference) throw bad('reference is required');
  const out = tx(() => processPaymentCallback({ reference, status, amount }));
  res.json({ reference, status: out.payment.status, duplicate: out.duplicate });
});

r.use(authenticate);

r.get('/', (req, res) => {
  const list = req.user.role === 'customer'
    ? db.find('payments', (p) => p.userId === req.user.id)
    : isStaff(req.user) ? db.all('payments') : [];
  res.json([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

r.post('/initiate', requireRole('customer'), (req, res) => {
  const out = tx(() => initiatePayment(req.user, req.body || {}));
  res.status(out.replayed ? 200 : 201).json(out);
});

/** Drives the simulated gateway: success | failed | pending. */
r.post('/:reference/simulate', requireRole('customer', 'admin'), (req, res) => {
  const payment = db.findOne('payments', (p) => p.reference === req.params.reference);
  if (!payment) throw notFound('Payment not found');
  assertCanSimulate(req.user, payment);
  const status = req.body?.outcome || 'success';
  const amount = req.body?.amount ?? payment.amount;
  const out = tx(() => processPaymentCallback({ reference: payment.reference, status, amount }));
  res.json(out);
});

/** Published test cards for the checkout (numbers are public test values, not real cards). */
r.get('/test-cards', (req, res) => {
  res.json({ otp: TEST_OTP, cards: TEST_CARDS.map(({ number, brand, outcome, label }) => ({ number, brand, outcome, label })) });
});

/**
 * Test-mode card checkout. Accepts only test card numbers; the card decides the outcome. Stores
 * brand/last4/expiry only. Cards that need 3-D Secure return requiresAction until the OTP is sent.
 */
r.post('/:reference/card', requireRole('customer'), (req, res) => {
  const payment = db.findOne('payments', (p) => p.reference === req.params.reference);
  if (!payment) throw notFound('Payment not found');
  assertCanSimulate(req.user, payment);
  if (payment.status !== 'pending') throw conflict(`This payment is already ${payment.status}`);
  const card = resolveTestCard(req.body || {});
  const otp = req.body?.otp;
  if (card.outcome === '3ds' && otp == null) return res.json({ payment, requiresAction: 'otp', card: { brand: card.brand, last4: card.last4 } });
  let status = card.outcome === 'failed' ? 'failed' : card.outcome === 'pending' ? 'pending' : 'success';
  let reason = card.reason;
  if (card.outcome === '3ds' && String(otp) !== TEST_OTP) { status = 'failed'; reason = '3-D Secure authentication failed'; }
  const out = tx(() => {
    Object.assign(payment, { method: 'test-card', card: { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear } });
    const result = processPaymentCallback({ reference: payment.reference, status, amount: payment.amount });
    if (result.payment.status === 'failed' && reason) result.payment.failureReason = reason;
    if (status === 'pending') result.payment.failureReason = undefined;
    db.touch(result.payment);
    return result;
  });
  res.json({ ...out, card: { brand: card.brand, last4: card.last4 } });
});

r.get('/:reference', (req, res) => {
  const p = db.findOne('payments', (x) => x.reference === req.params.reference);
  if (!p || (req.user.role === 'customer' && p.userId !== req.user.id) || (!isStaff(req.user) && req.user.role !== 'customer')) throw notFound('Payment not found');
  res.json(p);
});

export default r;

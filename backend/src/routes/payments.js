import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate, isStaff, requireRole } from '../middleware/auth.js';
import { bad, notFound } from '../utils/errors.js';
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

r.get('/:reference', (req, res) => {
  const p = db.findOne('payments', (x) => x.reference === req.params.reference);
  if (!p || (req.user.role === 'customer' && p.userId !== req.user.id) || (!isStaff(req.user) && req.user.role !== 'customer')) throw notFound('Payment not found');
  res.json(p);
});

export default r;

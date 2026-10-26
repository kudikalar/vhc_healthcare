import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad } from '../utils/errors.js';
import { initiatePayout, processPayoutCallback } from '../services/payments.js';

const r = Router();

// Bank rail callback (simulated). Repeated callbacks cannot duplicate transfers.
r.post('/callback', (req, res) => {
  if (!req.body?.reference) throw bad('reference is required');
  const out = tx(() => processPayoutCallback(req.body));
  res.json({ reference: out.payout.reference, status: out.payout.status, duplicate: out.duplicate });
});

r.use(authenticate, requireRole('claims_officer', 'admin'));

r.get('/', (req, res) => res.json([...db.all('payouts')].sort((a, b) => b.createdAt.localeCompare(a.createdAt))));

r.post('/initiate', (req, res) => {
  const p = tx(() => initiatePayout(req.user, req.body || {}));
  res.status(201).json(p);
});

r.post('/:reference/simulate', (req, res) => {
  const out = tx(() => processPayoutCallback({ reference: req.params.reference, status: req.body?.outcome || 'success' }, req.user));
  res.json(out);
});

export default r;

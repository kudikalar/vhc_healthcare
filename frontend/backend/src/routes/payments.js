import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate, isStaff, READ_ONLY_ROLES, requireRole } from '../middleware/auth.js';
import { bad, notFound } from '../utils/errors.js';
import { publicTestMethods } from '../services/testCards.js';
import { assertCanSimulate, processPaymentCallback } from '../services/payments.js';
import { audit } from '../services/audit.js';
import {
  assertLinkUsable, assertTestMode, createPaymentLink, findPayment, handleWebhook, initiateOrResume, linkView, loadLink,
  paymentMode, payByCard, payByNetbanking, payByQr, payByUpi, streamPaymentPdf, upiQr,
} from '../services/enterprisePayments.js';

const r = Router();

/**
 * Gateway webhook. When PAYMENT_WEBHOOK_SECRET is set, requires a valid HMAC-SHA256 x-razorpay-signature
 * over the raw body and rejects replayed event ids. Unsigned callbacks are accepted only in test mode
 * without a secret (the existing simulator flow).
 */
r.post('/callback', (req, res) => {
  // app.js may expose the raw body (express.json verify hook); otherwise the canonical JSON is used.
  const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body ?? {}));
  const out = tx(() => handleWebhook({ raw, body: req.body || {}, headers: req.headers }));
  res.json({ reference: out.payment.reference, status: out.payment.status, duplicate: out.duplicate });
});

r.use(authenticate);

const mine = (req, p) => req.user.role === 'customer' && p.userId === req.user.id;
const canSee = (req, p) => mine(req, p) || isStaff(req.user);
const own = (req, reference) => {
  const p = db.findOne('payments', (x) => x.reference === reference);
  if (!p || !canSee(req, p)) throw notFound('Payment not found');
  return p;
};

r.get('/', (req, res) => {
  const list = req.user.role === 'customer'
    ? db.find('payments', (p) => p.userId === req.user.id)
    : isStaff(req.user) ? db.all('payments') : [];
  const refunds = db.all('refunds');
  const out = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => ({
    ...p, mode: p.mode || 'test',
    refunds: refunds.filter((x) => x.paymentId === p.id).map(({ id, reference, amount, status, partial, reason, createdAt, completedAt }) => ({ id, reference, amount, status, partial, reason, createdAt, completedAt })),
  }));
  res.json(out);
});

r.post('/initiate', requireRole('customer'), (req, res) => {
  const body = req.body || {};
  const out = tx(() => {
    let link = null;
    if (body.linkCode) {
      link = loadLink(String(body.linkCode), req.user);
      assertLinkUsable(link);
      if (link.target.purpose !== body.purpose || (link.target.applicationId || null) !== (body.applicationId || null) || (link.target.policyId || null) !== (body.policyId || null)) throw bad('This payment link is for a different item');
    }
    const result = initiateOrResume(req.user, body);
    if (link && !link.paymentIds.includes(result.payment.id)) { link.paymentIds.push(result.payment.id); result.payment.paymentLinkCode = link.code; db.touch(link); }
    return result;
  });
  res.status(out.replayed ? 200 : 201).json(out);
});

/** Drives the simulated gateway: success | failed | pending (test mode only). */
r.post('/:reference/simulate', requireRole('customer', 'admin'), (req, res) => {
  assertTestMode();
  const payment = findPayment(req.params.reference);
  assertCanSimulate(req.user, payment);
  const status = req.body?.outcome || 'success';
  const amount = req.body?.amount ?? payment.amount;
  const out = tx(() => processPaymentCallback({ reference: payment.reference, status, amount }));
  res.json(out);
});

/** Published sandbox methods for the checkout (test cards, test VPAs, simulated banks). */
r.get('/test-cards', (req, res) => res.json({ mode: paymentMode(), ...publicTestMethods() }));
r.get('/methods', (req, res) => res.json({ mode: paymentMode(), ...publicTestMethods() }));

/** Refund status for the signed-in customer (staff see refunds under Finance). */
r.get('/refunds/mine', requireRole('customer'), (req, res) => {
  res.json(db.find('refunds', (x) => x.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

// ---------- payment links ----------
r.get('/links', requireRole('customer', 'admin', 'finance_manager', ...READ_ONLY_ROLES), (req, res) => {
  const list = db.find('paymentLinks', (l) => req.user.role !== 'customer' || l.userId === req.user.id);
  const out = tx(() => list.map(linkView));
  res.json(out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});
r.post('/links', requireRole('customer', 'admin'), (req, res) => {
  const link = tx(() => createPaymentLink(req.user, req.body || {}));
  res.status(201).json(link);
});
r.get('/links/:code', (req, res) => {
  if (req.user.role !== 'customer' && !isStaff(req.user)) throw notFound('Payment link not found');
  res.json(tx(() => loadLink(req.params.code, req.user)));
});
r.post('/links/:code/cancel', requireRole('customer', 'admin'), (req, res) => {
  const link = tx(() => {
    const l = loadLink(req.params.code, req.user);
    if (l.status === 'active') { l.status = 'cancelled'; db.touch(l); audit(req.user, 'PAYMENT_LINK_CANCELLED', 'paymentLink', l.id, { code: l.code }); }
    return l;
  });
  res.json(link);
});

// ---------- checkout methods (test mode) ----------
const customerPayment = (req) => {
  const payment = findPayment(req.params.reference);
  assertCanSimulate(req.user, payment);
  return payment;
};

/**
 * Card checkout. Accepts only test cards; the card decides the outcome. Stores brand/last4/expiry only.
 * Razorpay test cards (and legacy 3-D Secure cards) return requiresAction='otp' until the OTP is sent.
 */
r.post('/:reference/card', requireRole('customer'), (req, res) => {
  const payment = customerPayment(req);
  const out = tx(() => payByCard(payment, req.body || {}));
  res.json(out);
});
r.post('/:reference/upi', requireRole('customer'), (req, res) => {
  const payment = customerPayment(req);
  res.json(tx(() => payByUpi(payment, req.body || {})));
});
r.get('/:reference/upi-qr', requireRole('customer'), (req, res) => {
  const payment = customerPayment(req);
  res.json(upiQr(payment));
});
r.post('/:reference/upi-qr', requireRole('customer'), (req, res) => {
  const payment = customerPayment(req);
  res.json(tx(() => payByQr(payment, req.body || {})));
});
r.post('/:reference/netbanking', requireRole('customer'), (req, res) => {
  const payment = customerPayment(req);
  res.json(tx(() => payByNetbanking(payment, req.body || {})));
});

// ---------- receipts & sandbox GST invoices ----------
for (const kind of ['receipt', 'invoice']) {
  r.get(`/:reference/${kind}.pdf`, (req, res) => {
    const p = own(req, req.params.reference);
    if (!['success', 'refund_due', 'refunded'].includes(p.status)) throw bad(`A ${kind} is available only for a completed payment`);
    tx(() => audit(req.user, kind === 'invoice' ? 'PAYMENT_INVOICE_DOWNLOADED' : 'PAYMENT_RECEIPT_DOWNLOADED', 'payment', p.id, { reference: p.reference }));
    streamPaymentPdf(p, res, kind);
  });
}

r.get('/:reference', (req, res) => {
  const p = db.findOne('payments', (x) => x.reference === req.params.reference);
  if (!p || (req.user.role === 'customer' && p.userId !== req.user.id) || (!isStaff(req.user) && req.user.role !== 'customer')) throw notFound('Payment not found');
  res.json({ ...p, refunds: db.find('refunds', (x) => x.paymentId === p.id) });
});

export default r;

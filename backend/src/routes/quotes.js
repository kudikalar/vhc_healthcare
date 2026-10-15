// Stand-alone quote calculator (anonymous allowed; saved to the user when logged in).
// Every quote gets a reference number (QT-…), a validity window, the versioned product it was rated on and
// the rating source. Anonymous quotes are recorded without personal details (reference, product, premium).
import { Router } from 'express';
import { db, tx } from '../db.js';
import { optionalAuth } from '../middleware/auth.js';
import { notFound } from '../utils/errors.js';
import { computeHealthQuote, computeLifeQuote } from '../services/pricing.js';
import { decorateQuote } from '../services/partnersCatalog.js';
import { publish } from '../services/events.js';

const r = Router();

function save(req, plan, quote) {
  return tx(() => {
    const q = decorateQuote(quote, plan);
    const premium = q.totalAnnualPremium ?? q.annualPremium;
    const rec = req.user
      ? db.insert('quotes', { ...q, userId: req.user.id })
      : db.insert('quotes', {
        reference: q.reference, product: q.product, planId: q.planId, planName: q.planName, planVersion: q.planVersion, userId: null, anonymous: true,
        premium, coverage: q.coverage ?? q.sumAssured ?? null, members: q.members?.length ?? 1, underwritingRequired: q.underwritingRequired,
        issuedAt: q.issuedAt, expiresAt: q.expiresAt, source: q.source,
      });
    publish('QUOTE_CREATED', { quoteId: rec.id, reference: q.reference, planId: plan.id, insurerId: plan.insurerId || null, premium, anonymous: !req.user }, {
      actor: req.user || { name: 'Public quote', role: 'public' }, subject: { type: 'quote', id: rec.id }, idempotencyKey: `quote:${q.reference}`,
    });
    return req.user ? rec : { ...q, id: rec.id };
  });
}

r.post('/health', optionalAuth, (req, res) => {
  const plan = db.get('plans', req.body?.planId);
  if (!plan) throw notFound('Plan not found');
  res.json(save(req, plan, computeHealthQuote(plan, req.body)));
});

r.post('/life', optionalAuth, (req, res) => {
  const plan = db.get('plans', req.body?.planId);
  if (!plan) throw notFound('Plan not found');
  res.json(save(req, plan, computeLifeQuote(plan, req.body)));
});

r.get('/:reference', optionalAuth, (req, res) => {
  const q = db.findOne('quotes', (x) => x.reference === req.params.reference);
  if (!q || (q.userId && q.userId !== req.user?.id)) throw notFound('Quote not found');
  res.json(q);
});

export default r;

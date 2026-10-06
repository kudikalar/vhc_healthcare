// Stand-alone quote calculator (anonymous allowed; saved to the user when logged in).
import { Router } from 'express';
import { db, tx } from '../db.js';
import { now } from '../clock.js';
import { optionalAuth } from '../middleware/auth.js';
import { notFound } from '../utils/errors.js';
import { computeHealthQuote, computeLifeQuote } from '../services/pricing.js';

const r = Router();
const QUOTE_DAYS = 7;
const expiry = () => new Date(now().getTime() + QUOTE_DAYS * 86400000).toISOString();

function save(req, quote) {
  if (!req.user) return { ...quote, expiresAt: expiry() };
  return tx(() => db.insert('quotes', { ...quote, userId: req.user.id, expiresAt: expiry() }));
}

r.post('/health', optionalAuth, (req, res) => {
  const plan = db.get('plans', req.body?.planId);
  if (!plan) throw notFound('Plan not found');
  res.json(save(req, computeHealthQuote(plan, req.body)));
});

r.post('/life', optionalAuth, (req, res) => {
  const plan = db.get('plans', req.body?.planId);
  if (!plan) throw notFound('Plan not found');
  res.json(save(req, computeLifeQuote(plan, req.body)));
});

export default r;

import { Router } from 'express';
import { db } from '../db.js';
import { isStaff, optionalAuth } from '../middleware/auth.js';
import { notFound } from '../utils/errors.js';
import { currentVersion } from '../services/pricing.js';
import { distributionStatus, insurerOf } from '../services/insurerHub.js';
import { MIS_SELLING_NOTE, planCategories, productSpec } from '../services/partnersCatalog.js';

const r = Router();

export const planView = (p) => {
  const v = currentVersion(p);
  const ins = insurerOf(p);
  return {
    id: p.id, code: p.code, name: p.name, product: p.product, type: p.type, description: p.description, active: p.active, version: v.version, config: v.config, versions: p.versions.length,
    versionDate: v.createdAt || null, uin: p.uin || null, sandbox: p.sandbox !== false, categories: planCategories(p),
    insurer: ins ? { id: ins.id, name: ins.name, sandbox: !!ins.sandbox } : null,
    distribution: distributionStatus(p),
    spec: productSpec(p, v),
  };
};

const startingPremium = (p) => (p.product === 'health' ? Math.min(...currentVersion(p).config.ageBands.map((b) => b.premium)) : Number.MAX_SAFE_INTEGER);
const SORTS = {
  // Ordering never uses commission or remuneration (mis-selling guard).
  premium: (a, b) => startingPremium(a) - startingPremium(b),
  name: (a, b) => a.name.localeCompare(b.name),
  cover: (a, b) => Math.max(...(currentVersion(b).config.coverageOptions || [{ amount: 0 }]).map((c) => c.amount)) - Math.max(...(currentVersion(a).config.coverageOptions || [{ amount: 0 }]).map((c) => c.amount)),
};

r.get('/', optionalAuth, (req, res) => {
  const { product, type, includeInactive, category, includeUnavailable, sort, insurer } = req.query;
  const admin = req.user?.role === 'admin';
  const showUnavailable = includeUnavailable === 'true' && isStaff(req.user);
  let list = db.find('plans', (p) =>
    (admin && includeInactive === 'true' ? true : p.active) &&
    (!product || p.product === product) && (!type || p.type === type) &&
    (!category || planCategories(p).includes(category)) && (!insurer || p.insurerId === insurer) &&
    (showUnavailable || (admin && includeInactive === 'true') || distributionStatus(p).allowed));
  if (SORTS[sort]) list = [...list].sort(SORTS[sort]);
  res.setHeader('X-Ranking-Policy', 'no-commission-boost');
  res.json(list.map(planView));
});

r.get('/compare', optionalAuth, (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 4);
  const plans = ids.map((id) => db.get('plans', id)).filter((p) => p && (p.active || req.user?.role === 'admin'));
  res.setHeader('X-Ranking-Policy', 'no-commission-boost');
  res.json(plans.map(planView).map((v) => ({ ...v, rankingNote: MIS_SELLING_NOTE })));
});

r.get('/:id', optionalAuth, (req, res) => {
  const p = db.get('plans', req.params.id);
  if (!p || (!p.active && req.user?.role !== 'admin')) throw notFound('Plan not found');
  res.json(planView(p));
});

export default r;

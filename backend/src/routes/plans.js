import { Router } from 'express';
import { db } from '../db.js';
import { optionalAuth } from '../middleware/auth.js';
import { notFound } from '../utils/errors.js';
import { currentVersion } from '../services/pricing.js';

const r = Router();

export const planView = (p) => {
  const v = currentVersion(p);
  return { id: p.id, code: p.code, name: p.name, product: p.product, type: p.type, description: p.description, active: p.active, version: v.version, config: v.config, versions: p.versions.length };
};

r.get('/', optionalAuth, (req, res) => {
  const { product, type, includeInactive } = req.query;
  const admin = req.user?.role === 'admin';
  const list = db.find('plans', (p) =>
    (admin && includeInactive === 'true' ? true : p.active) &&
    (!product || p.product === product) && (!type || p.type === type));
  res.json(list.map(planView));
});

r.get('/compare', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  res.json(ids.map((id) => db.get('plans', id)).filter(Boolean).map(planView));
});

r.get('/:id', optionalAuth, (req, res) => {
  const p = db.get('plans', req.params.id);
  if (!p || (!p.active && req.user?.role !== 'admin')) throw notFound('Plan not found');
  res.json(planView(p));
});

export default r;

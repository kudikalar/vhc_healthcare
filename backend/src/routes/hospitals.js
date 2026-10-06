import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad, notFound } from '../utils/errors.js';
import { audit } from '../services/audit.js';

const r = Router();
export const NETWORK_DISCLAIMER = 'Network membership enables cashless requests but does not by itself guarantee claim approval.';

r.get('/', (req, res) => {
  const { q, city, postalCode, specialty, network, includeInactive } = req.query;
  const s = (v) => String(v || '').toLowerCase().trim();
  const list = db.find('hospitals', (h) =>
    (includeInactive === 'true' || h.active) &&
    (!q || h.name.toLowerCase().includes(s(q))) &&
    (!city || h.city.toLowerCase().includes(s(city))) &&
    (!postalCode || h.postalCode.startsWith(String(postalCode).trim())) &&
    (!specialty || h.specialties.some((x) => x.toLowerCase().includes(s(specialty)))) &&
    (!network || (network === 'network' ? h.network : !h.network)));
  res.json({ disclaimer: NETWORK_DISCLAIMER, hospitals: list });
});

r.get('/:id', (req, res) => {
  const h = db.get('hospitals', req.params.id);
  if (!h) throw notFound('Hospital not found');
  res.json({ ...h, disclaimer: NETWORK_DISCLAIMER });
});

function clean(b) {
  if (!b.name?.trim() || !b.city?.trim()) throw bad('Name and city are required');
  if (!/^\d{6}$/.test(b.postalCode || '')) throw bad('Postal code must be 6 digits');
  return {
    name: b.name.trim(), address: b.address || '', city: b.city.trim(), state: b.state || '', postalCode: b.postalCode,
    phone: b.phone || '', email: b.email || '', specialties: Array.isArray(b.specialties) ? b.specialties : String(b.specialties || '').split(',').map((x) => x.trim()).filter(Boolean),
    network: !!b.network, active: b.active !== false,
  };
}

r.post('/', authenticate, requireRole('admin'), (req, res) => {
  const h = tx(() => {
    const rec = db.insert('hospitals', clean(req.body || {}));
    audit(req.user, 'HOSPITAL_CREATED', 'hospital', rec.id, { name: rec.name });
    return rec;
  });
  res.status(201).json(h);
});

r.put('/:id', authenticate, requireRole('admin'), (req, res) => {
  const h = db.get('hospitals', req.params.id);
  if (!h) throw notFound('Hospital not found');
  tx(() => {
    Object.assign(h, clean({ ...h, ...req.body }));
    db.touch(h);
    audit(req.user, 'HOSPITAL_UPDATED', 'hospital', h.id, { active: h.active, network: h.network });
  });
  res.json(h);
});

export default r;

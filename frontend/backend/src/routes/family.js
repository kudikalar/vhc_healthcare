// Family roster (VHC-M29, phase-1 scope): a customer's own list of family members, used to see who is
// covered and to prefill quotes. A family member here is a person record only — it never grants that
// person access to the account. Removing someone archives the record; it never touches issued policies.
import { Router } from 'express';
import { db, tx } from '../db.js';
import { today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { notFound, unprocessable } from '../utils/errors.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(authenticate, requireRole('customer'));

export const FAMILY_RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'parent-in-law', 'other'];
const GENDERS = ['', 'female', 'male', 'other'];
const NAME = /^[\p{L}][\p{L}\p{M}' .-]*$/u;

function validate(body) {
  const fields = {};
  const fullName = String(body.fullName ?? '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 1 || fullName.length > 120 || !NAME.test(fullName)) fields.fullName = 'Enter the full name (letters, spaces, apostrophes or hyphens).';
  const dob = String(body.dob ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) fields.dob = 'Enter a valid date of birth.';
  else if (dob > today()) fields.dob = 'Date of birth cannot be in the future.';
  else if (dob < '1900-01-01') fields.dob = 'Enter a realistic date of birth.';
  const relationship = String(body.relationship ?? '');
  if (!FAMILY_RELATIONSHIPS.includes(relationship)) fields.relationship = 'Select a relationship.';
  const gender = String(body.gender ?? '');
  if (!GENDERS.includes(gender)) fields.gender = 'Select a valid option.';
  if (Object.keys(fields).length) throw unprocessable('Check the highlighted fields', { fields });
  return { fullName, dob, relationship, gender };
}

const own = (req) => db.find('familyMembers', (m) => m.userId === req.user.id && m.status !== 'archived');

r.get('/', (req, res) => {
  res.json(own(req).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
});

r.post('/', (req, res) => {
  const data = validate(req.body || {});
  if (own(req).length >= 20) throw unprocessable('You can keep up to 20 family members.');
  const dup = own(req).find((m) => m.fullName.toLowerCase() === data.fullName.toLowerCase() && m.dob === data.dob);
  if (dup) throw unprocessable('This person is already in your family list.', { fields: { fullName: 'Already added.' } });
  if (data.relationship === 'spouse' && own(req).some((m) => m.relationship === 'spouse')) throw unprocessable('You already have a spouse in your family list.', { fields: { relationship: 'Only one spouse can be added.' } });
  const m = tx(() => {
    const rec = db.insert('familyMembers', { userId: req.user.id, ...data, status: 'active', version: 1 });
    audit(req.user, 'FAMILY_MEMBER_ADDED', 'familyMember', rec.id, { relationship: data.relationship });
    return rec;
  });
  res.status(201).json(m);
});

r.put('/:id', (req, res) => {
  const m = own(req).find((x) => x.id === req.params.id);
  if (!m) throw notFound('Family member not found');
  const data = validate(req.body || {});
  const out = tx(() => {
    Object.assign(m, data, { version: (m.version || 1) + 1 });
    db.touch(m);
    audit(req.user, 'FAMILY_MEMBER_UPDATED', 'familyMember', m.id, {});
    return m;
  });
  res.json(out);
});

r.delete('/:id', (req, res) => {
  const m = own(req).find((x) => x.id === req.params.id);
  if (!m) throw notFound('Family member not found');
  tx(() => {
    m.status = 'archived';
    m.archivedAt = new Date().toISOString();
    db.touch(m);
    audit(req.user, 'FAMILY_MEMBER_ARCHIVED', 'familyMember', m.id, {});
  });
  res.json({ ok: true });
});

export default r;

import { Router } from 'express';
import { db, tx } from '../db.js';
import { now } from '../clock.js';
import { authenticate, requireRole, ROLES, STAFF } from '../middleware/auth.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { audit, notify } from '../services/audit.js';
import { initiatePayment, initiatePayout, processPaymentCallback } from '../services/payments.js';
import { planView } from './plans.js';
import { cleanEmail, cleanName, maskEmail, revokeAllSessions } from '../services/security.js';
import { createChallenge } from '../services/challenges.js';
import { displayName, publicUser } from '../services/profile.js';

const r = Router();
r.use(authenticate);
const admin = requireRole('admin');

// ---------- users & roles ----------
r.get('/users', admin, (req, res) => {
  const { role, q } = req.query;
  res.json(db.find('users', (u) => (!role || u.role === role) && (!q || `${u.name} ${u.email}`.toLowerCase().includes(String(q).toLowerCase()))).map((u) => publicUser(u)));
});

/** Staff accounts are created by invitation only; the invitee sets their own password. */
r.post('/users', admin, (req, res) => {
  const { firstName, lastName, email, role } = req.body || {};
  const fields = {};
  const fn = cleanName(firstName);
  if (!fn) fields.firstName = 'Enter a first name.';
  const ln = cleanName(lastName, { required: false });
  if (ln === null) fields.lastName = 'Use letters, spaces, apostrophes or hyphens.';
  const em = cleanEmail(email);
  if (!em) fields.email = 'Enter a valid email address.';
  if (!STAFF.includes(role)) fields.role = 'Select a staff role.';
  if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields });
  if (db.findOne('users', (u) => u.emailLower === em.toLowerCase())) throw conflict('An account with this email already exists');
  const { u, token } = tx(() => {
    const rec = db.insert('users', {
      firstName: fn, lastName: ln, name: displayName({ firstName: fn, lastName: ln }), legalName: displayName({ firstName: fn, lastName: ln }),
      email: em, emailLower: em.toLowerCase(), emailVerified: false, mobile: '', mobileVerified: false, passwordHash: null,
      role, status: 'Invited', active: true, profile: {}, communicationPreference: 'email', invitedBy: req.user.id,
    });
    const { secret } = createChallenge({ subjectId: rec.id, purpose: 'invite', destination: rec.emailLower, kind: 'link' });
    audit(req.user, 'USER_INVITED', 'user', rec.id, { email: maskEmail(em), role });
    return { u: rec, token: secret };
  });
  res.status(201).json({ user: publicUser(u), ...(process.env.NODE_ENV !== 'production' ? { devInviteToken: token } : {}) });
});

r.patch('/users/:id', admin, (req, res) => {
  const u = db.get('users', req.params.id);
  if (!u) throw notFound('User not found');
  const { role, active } = req.body || {};
  if (u.id === req.user.id && (active === false || (role && role !== 'admin'))) throw conflict('You cannot deactivate or demote your own account');
  if (role && (!ROLES.includes(role) || role === 'claimant')) throw bad('Invalid role');
  if (role && (u.role === 'customer') !== (role === 'customer')) throw bad('Customers and staff are separate account types; invite a new staff user instead.');
  tx(() => {
    const before = { role: u.role, active: u.active };
    if (role) u.role = role;
    if (active != null) {
      u.active = !!active;
      if (!u.active) u.status = 'Disabled';
      else if (u.status === 'Disabled') u.status = u.passwordHash ? 'Active' : 'Invited';
    }
    // Role or status changes end existing sessions so access is re-evaluated at next sign-in.
    if (before.role !== u.role || before.active !== u.active) revokeAllSessions(u.id, { reason: 'access_changed' });
    db.touch(u);
    audit(req.user, 'USER_UPDATED', 'user', u.id, { before, after: { role: u.role, active: u.active } });
  });
  res.json(publicUser(u));
});

// ---------- plans & rate configuration ----------
const REQUIRED = {
  health: ['minEntryAge', 'maxEntryAge', 'maxMembers', 'eligibleRelationships', 'ageBands', 'coverageOptions', 'durationMonths', 'initialWaitingDays', 'deductiblePerClaim', 'copayBp'],
  life: ['minEntryAge', 'maxEntryAge', 'maxMaturityAge', 'minSumAssured', 'maxSumAssured', 'policyTerms', 'premiumPaymentTerms', 'frequencies', 'riders', 'rateTable', 'reinstatementWindowDays'],
};
function checkConfig(product, config) {
  if (!config || typeof config !== 'object') throw bad('config object is required');
  const missing = REQUIRED[product].filter((k) => config[k] == null);
  if (missing.length) throw bad(`Plan configuration is missing: ${missing.join(', ')}`);
  if (config.minEntryAge > config.maxEntryAge) throw bad('Minimum entry age cannot exceed maximum entry age');
}

r.get('/plans', admin, (req, res) => res.json(db.all('plans').map((p) => ({ ...planView(p), history: p.versions.map((v) => ({ version: v.version, createdAt: v.createdAt, createdBy: v.createdBy, changeNote: v.changeNote })) }))));

r.post('/plans', admin, (req, res) => {
  const { code, name, product, type, description, config } = req.body || {};
  if (!code?.trim() || !name?.trim()) throw bad('Code and name are required');
  if (!['health', 'life'].includes(product)) throw bad('product must be health or life');
  if (db.findOne('plans', (p) => p.code === code.trim().toUpperCase())) throw conflict('Plan code already exists');
  checkConfig(product, config);
  const plan = tx(() => {
    const p = db.insert('plans', { code: code.trim().toUpperCase(), name: name.trim(), product, type, description: description || '', active: true, versions: [{ version: 1, config, createdAt: now().toISOString(), createdBy: req.user.name, changeNote: 'Created' }] });
    audit(req.user, 'PLAN_CREATED', 'plan', p.id, { code: p.code });
    return p;
  });
  res.status(201).json(planView(plan));
});

/** Edits create a new version; issued policies keep their own frozen snapshot. */
r.put('/plans/:id', admin, (req, res) => {
  const p = db.get('plans', req.params.id);
  if (!p) throw notFound('Plan not found');
  const { name, description, config, changeNote } = req.body || {};
  if (config) checkConfig(p.product, config);
  tx(() => {
    if (name) p.name = name;
    if (description != null) p.description = description;
    if (config) p.versions.push({ version: p.versions.length + 1, config, createdAt: now().toISOString(), createdBy: req.user.name, changeNote: changeNote || 'Updated' });
    db.touch(p);
    audit(req.user, 'PLAN_UPDATED', 'plan', p.id, { newVersion: config ? p.versions.length : null, changeNote });
  });
  res.json(planView(p));
});

r.patch('/plans/:id/status', admin, (req, res) => {
  const p = db.get('plans', req.params.id);
  if (!p) throw notFound('Plan not found');
  tx(() => {
    p.active = !!req.body?.active;
    audit(req.user, p.active ? 'PLAN_ACTIVATED' : 'PLAN_DEACTIVATED', 'plan', p.id);
  });
  res.json(planView(p));
});

// ---------- notifications ----------
r.get('/notifications', admin, (req, res) => {
  const users = new Map(db.all('users').map((u) => [u.id, u]));
  res.json(db.all('notifications').slice(-300).reverse().map((n) => ({ ...n, recipient: users.get(n.userId)?.email || n.userId })));
});

r.post('/notifications/broadcast', admin, (req, res) => {
  const { role = 'customer', title, message } = req.body || {};
  if (!title?.trim() || !message?.trim()) throw bad('Title and message are required');
  const count = tx(() => {
    const targets = db.find('users', (u) => u.active && (role === 'all' || u.role === role));
    for (const u of targets) notify(u.id, title.trim(), message.trim(), { type: 'announcement' });
    audit(req.user, 'NOTIFICATION_BROADCAST', 'notification', null, { role, title, recipients: targets.length });
    return targets.length;
  });
  res.json({ sent: count });
});

// ---------- audit logs ----------
r.get('/audit-logs', admin, (req, res) => {
  const { action, entityType, actor, entityId, limit = 300 } = req.query;
  const list = db.find('auditLogs', (a) =>
    (!action || a.action.includes(String(action).toUpperCase())) && (!entityType || a.entityType === entityType) &&
    (!entityId || a.entityId === entityId) && (!actor || `${a.actorName} ${a.actorRole}`.toLowerCase().includes(String(actor).toLowerCase())));
  res.json(list.slice(-Number(limit)).reverse());
});

// ---------- exception / retry queue ----------
r.get('/exceptions', requireRole('admin', 'claims_officer'), (req, res) => {
  const { status } = req.query;
  res.json(db.find('exceptions', (e) => !status || e.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

r.post('/exceptions/:id/retry', requireRole('admin', 'claims_officer'), (req, res) => {
  const ex = db.get('exceptions', req.params.id);
  if (!ex) throw notFound('Exception not found');
  if (ex.status !== 'open') throw conflict('Exception is already resolved');
  const out = tx(() => {
    ex.attempts++;
    let result;
    if (ex.type === 'autopay_failed') {
      const pay = db.get('payments', ex.refId);
      const owner = { id: pay.userId, role: 'customer' };
      const { payment } = initiatePayment(owner, { purpose: pay.purpose, policyId: pay.policyId, installmentNo: pay.installmentNo, amount: pay.amount, idempotencyKey: `retry:${ex.id}:${ex.attempts}` }, req.user);
      payment.autoPay = false;
      processPaymentCallback({ reference: payment.reference, status: req.body?.outcome || 'success', amount: payment.amount });
      result = { reference: payment.reference, status: payment.status };
      if (payment.status === 'success') ex.status = 'resolved';
    } else if (ex.type === 'payout_failed') {
      const po = db.get('payouts', ex.refId);
      const next = initiatePayout(req.user, { claimType: po.claimType, claimId: po.claimId, beneficiaryId: po.beneficiaryId });
      result = { reference: next.reference, status: next.status, note: 'New payout initiated; confirm via payout review' };
      ex.status = 'resolved';
    } else throw conflict('This exception type requires manual resolution');
    ex.history.push({ at: now().toISOString(), by: req.user.name, action: 'retry', result });
    audit(req.user, 'EXCEPTION_RETRIED', 'exception', ex.id, result);
    return result;
  });
  res.json({ exception: ex, result: out });
});

r.post('/exceptions/:id/resolve', requireRole('admin', 'claims_officer'), (req, res) => {
  const ex = db.get('exceptions', req.params.id);
  if (!ex) throw notFound('Exception not found');
  if (!req.body?.note?.trim()) throw bad('A resolution note is required');
  tx(() => {
    ex.status = 'resolved';
    ex.history.push({ at: now().toISOString(), by: req.user.name, action: 'resolve', note: req.body.note });
    if (ex.type === 'duplicate_collection') {
      const pay = db.get('payments', ex.refId);
      if (pay?.status === 'refund_due') { pay.status = 'refunded'; pay.refundedAt = now().toISOString(); }
    }
    audit(req.user, 'EXCEPTION_RESOLVED', 'exception', ex.id, { note: req.body.note });
  });
  res.json(ex);
});

export default r;

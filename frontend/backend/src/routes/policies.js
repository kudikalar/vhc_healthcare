import { Router } from 'express';
import { db, tx } from '../db.js';
import { now, today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { addDays, diffDays } from '../utils/dates.js';
import { assertPolicyAccess } from '../services/access.js';
import { nomineesAt, policyStatusAt, policyView, validateNominees } from '../services/lifecycle.js';
import { currentVersion } from '../services/pricing.js';
import { overdueInstallments } from '../services/payments.js';
import { streamPolicyPdf } from '../services/pdf.js';
import { audit, notify } from '../services/audit.js';
import { createApplication } from './applications.js';
import { checkOtp, createChallenge } from '../services/challenges.js';
import { maskEmail } from '../services/security.js';
import { bucketFilter } from '../services/buckets.js';

const r = Router();
const DEV = process.env.NODE_ENV !== 'production';
r.use(authenticate);

const load = (req) => assertPolicyAccess(req.user, db.get('policies', req.params.id));
function loadOwn(req) {
  const p = load(req);
  if (p.userId !== req.user.id) throw notFound('Policy not found');
  return p;
}

r.get('/', (req, res) => {
  const list = req.user.role === 'customer'
    ? db.find('policies', (p) => p.userId === req.user.id)
    : ['agent', 'underwriter', 'claims_officer', 'admin'].includes(req.user.role) ? db.all('policies') : [];
  const { bucket, product } = req.query;
  res.json(list.filter(bucketFilter('policies', bucket)).filter((p) => !product || p.product === product).map((p) => policyView(p, { includeSchedule: false })).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)));
});

r.get('/:id', (req, res) => {
  const p = load(req);
  const v = policyView(p);
  v.claims = p.product === 'health'
    ? db.find('healthClaims', (c) => c.policyId === p.id).map((c) => ({ id: c.id, claimNumber: c.claimNumber, status: c.status, type: c.type, requestedAmount: c.requestedAmount, approvedAmount: c.assessment?.approvedAmount ?? null }))
    : [];
  v.payments = db.find('payments', (x) => x.policyId === p.id || x.reference === p.firstPaymentRef);
  v.renewal = p.product === 'health' ? renewalInfo(p) : null;
  v.reinstatements = db.find('reinstatements', (x) => x.policyId === p.id);
  res.json(v);
});

r.get('/:id/pdf', (req, res) => {
  const p = load(req);
  tx(() => audit(req.user, 'POLICY_DOCUMENT_DOWNLOADED', 'policy', p.id, { policyNumber: p.policyNumber }));
  streamPolicyPdf(p, res);
});

r.post('/:id/autopay', requireRole('customer'), (req, res) => {
  const p = loadOwn(req);
  if (p.product !== 'life') throw bad('Auto-pay applies to life premium schedules');
  tx(() => {
    p.autoPay = !!req.body?.enabled;
    audit(req.user, 'AUTOPAY_CHANGED', 'policy', p.id, { enabled: p.autoPay });
  });
  res.json(policyView(p));
});

// ---------- nominees (life) ----------
r.post('/:id/nominees', requireRole('customer'), (req, res) => {
  const p = loadOwn(req);
  if (p.product !== 'life') throw bad('Nominees apply to life policies');
  if (['Terminated', 'Expired'].includes(policyStatusAt(p))) throw conflict('Nominees cannot be changed on an ended policy');
  const { errors, normalized } = validateNominees(req.body?.nominees);
  if (errors.length) throw bad('Nominee details are invalid', { errors });
  const owner = db.get('users', p.userId);
  const { challenge, secret } = tx(() => {
    for (const v of p.nomineeVersions) if (v.status === 'pending') v.status = 'cancelled';
    const ch = createChallenge({ subjectId: p.userId, purpose: 'nominee_change', destination: owner.emailLower, kind: 'otp', meta: { policyId: p.id } });
    p.nomineeVersions.push({ version: p.nomineeVersions.length + 1, nominees: normalized, status: 'pending', requestedAt: now().toISOString(), challengeId: ch.challenge.id, effectiveFrom: null, effectiveTo: null });
    audit(req.user, 'NOMINEE_CHANGE_REQUESTED', 'policy', p.id, { nominees: normalized.map((n) => `${n.name} ${n.sharePct}%`) });
    notify(p.userId, 'Confirm nominee change', 'Enter the verification code we sent to confirm the nominee change.', { type: 'warning' });
    return ch;
  });
  res.status(202).json({
    message: 'Verification code sent. The change takes effect only after verification.',
    challengeId: challenge.id, destination: maskEmail(owner.email), expiresAt: challenge.expiresAt, ...(DEV ? { devOtp: secret } : {}),
  });
});

r.post('/:id/nominees/verify', requireRole('customer'), (req, res) => {
  const p = loadOwn(req);
  const pending = p.nomineeVersions.find((v) => v.status === 'pending');
  if (!pending) throw conflict('No pending nominee change');
  const out = tx(() => {
    const result = checkOtp(pending.challengeId, req.body?.otp, { subjectId: p.userId, purposes: ['nominee_change'] });
    if (!result.ok) return result;
    const t = today();
    const current = p.nomineeVersions.find((v) => v.status === 'effective');
    if (current) Object.assign(current, { status: 'superseded', effectiveTo: addDays(t, -1) });
    Object.assign(pending, { status: 'effective', effectiveFrom: t, verifiedAt: now().toISOString(), changedBy: req.user.name });
    audit(req.user, 'NOMINEE_CHANGED', 'policy', p.id, { version: pending.version, effectiveFrom: t });
    notify(p.userId, 'Nominees updated', `Nominee version ${pending.version} is effective from ${t}.`, { type: 'success' });
    return result;
  });
  if (!out.ok) throw bad(out.error, { attemptsLeft: out.attemptsLeft });
  res.json(policyView(p));
});

r.get('/:id/nominees/at', (req, res) => {
  const p = load(req);
  res.json(nomineesAt(p, req.query.date || today()));
});

// ---------- reinstatement (life) ----------
r.post('/:id/reinstatement', requireRole('customer'), (req, res) => {
  const p = loadOwn(req);
  if (p.product !== 'life') throw bad('Reinstatement applies to life policies');
  if (policyStatusAt(p) !== 'Lapsed') throw conflict('Only lapsed policies can be reinstated');
  const firstOverdue = overdueInstallments(p)[0];
  const window = p.termsSnapshot.reinstatementWindowDays;
  if (diffDays(firstOverdue.dueDate, today()) > window) throw conflict(`Reinstatement is only possible within ${window} days of the first unpaid premium`);
  if (db.findOne('reinstatements', (x) => x.policyId === p.id && ['Requested', 'Approved'].includes(x.status))) throw conflict('A reinstatement request is already open');
  if (typeof req.body?.goodHealthDeclaration !== 'boolean') throw bad('Good health declaration is required');
  const rq = tx(() => {
    const rec = db.insert('reinstatements', {
      policyId: p.id, policyNumber: p.policyNumber, userId: p.userId, status: 'Requested',
      goodHealthDeclaration: req.body.goodHealthDeclaration, healthChanges: req.body.healthChanges || '',
      arrears: overdueInstallments(p).reduce((t, i) => t + i.amount, 0),
    });
    audit(req.user, 'REINSTATEMENT_REQUESTED', 'policy', p.id, { request: rec.id });
    return rec;
  });
  res.status(201).json(rq);
});

// ---------- renewal (health) ----------
function renewalInfo(p) {
  const t = today();
  const cfg = p.termsSnapshot;
  const opensOn = addDays(p.endDate, -(cfg.renewalWindowDays ?? 60));
  const closesOn = addDays(p.endDate, cfg.renewalGraceDays ?? 30);
  const plan = db.get('plans', p.planId);
  const inProgress = db.findOne('applications', (a) => a.renewalOf === p.id && !['Rejected', 'Offer Declined'].includes(a.status));
  let eligible = true; let reason = null;
  if (p.renewedBy) { eligible = false; reason = 'Already renewed'; }
  else if (t < opensOn) { eligible = false; reason = `Renewal opens on ${opensOn}`; }
  else if (t > closesOn) { eligible = false; reason = 'Renewal grace period has ended; continuity cannot be maintained — buy a new policy'; }
  else if (!plan?.active) { eligible = false; reason = 'This plan is no longer offered'; }
  return { eligible, reason, opensOn, closesOn, inProgressApplicationId: inProgress?.id || null, currentPlanVersion: plan ? currentVersion(plan).version : null, previousPlanVersion: p.planVersion };
}

r.post('/:id/renew', requireRole('customer'), (req, res) => {
  const p = loadOwn(req);
  if (p.product !== 'health') throw bad('Renewal applies to health policies');
  const info = renewalInfo(p);
  if (info.inProgressApplicationId) return res.json({ applicationId: info.inProgressApplicationId, existing: true });
  if (!info.eligible) throw conflict(info.reason);
  const plan = db.get('plans', p.planId);
  const app = tx(() => {
    const start = p.endDate < today() ? today() : addDays(p.endDate, 1);
    const a = createApplication(p.userId, plan, { renewalOf: p.id, startDate: start });
    a.health = { coverage: p.coverage, optionalBenefits: [...(p.optionalBenefits || [])], members: structuredClone(p.members) };
    audit(req.user, 'RENEWAL_STARTED', 'policy', p.id, { applicationId: a.id });
    return a;
  });
  res.status(201).json({ applicationId: app.id, existing: false });
});

export default r;

// ---------- reinstatement decisions (underwriter) ----------
export const reinstatementRouter = Router();
reinstatementRouter.use(authenticate, requireRole('underwriter', 'admin', 'customer'));
reinstatementRouter.get('/', (req, res) => {
  const list = req.user.role === 'customer' ? db.find('reinstatements', (x) => x.userId === req.user.id) : db.all('reinstatements');
  res.json([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});
reinstatementRouter.post('/:id/decision', requireRole('underwriter', 'admin'), (req, res) => {
  const rq = db.get('reinstatements', req.params.id);
  if (!rq) throw notFound('Request not found');
  if (rq.status !== 'Requested') throw conflict('Request already decided');
  const { approve, reason } = req.body || {};
  if (!approve && !reason?.trim()) throw bad('A reason is required to decline');
  tx(() => {
    Object.assign(rq, { status: approve ? 'Approved' : 'Declined', decidedBy: req.user.name, decidedAt: now().toISOString(), reason: reason || null, payBy: approve ? addDays(today(), 15) : null });
    audit(req.user, approve ? 'REINSTATEMENT_APPROVED' : 'REINSTATEMENT_DECLINED', 'policy', rq.policyId, { request: rq.id, reason });
    notify(rq.userId, `Reinstatement ${rq.status.toLowerCase()}`, approve ? `Pay the arrears by ${rq.payBy} to reinstate ${rq.policyNumber}.` : `Reinstatement of ${rq.policyNumber} declined: ${reason}`, { type: approve ? 'info' : 'error', link: `/policies/${rq.policyId}` });
  });
  res.json(rq);
});

import { Router } from 'express';
import { db, newId, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { addDays } from '../utils/dates.js';
import { pct } from '../utils/money.js';
import { assertApplicationAccess } from '../services/access.js';
import {
  computeHealthQuote, computeLifeQuote, currentVersion, hashInputs, healthQuoteInputs, lifeQuoteInputs, planVersion,
} from '../services/pricing.js';
import { APP_STATUS as S, EDITABLE, timelineNote, transition, validateNominees } from '../services/lifecycle.js';
import { audit, notify } from '../services/audit.js';
import { bucketFilter } from '../services/buckets.js';
import { profileProblems } from '../services/profile.js';

const r = Router();
r.use(authenticate);

const QUOTE_DAYS = 7;
const OFFER_DAYS = 30;
const MEMBER_FIELDS = ['fullName', 'dob', 'relationship', 'gender', 'heightCm', 'weightKg', 'hasConditions', 'conditions', 'medications', 'surgeries', 'tobacco', 'idType', 'idNumber'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const materialHash = (app) => hashInputs(app.product === 'health' ? healthQuoteInputs(app) : lifeQuoteInputs(app));

function viewFor(user, app) {
  const v = structuredClone(app);
  const owner = db.get('users', app.userId);
  v.customer = owner ? { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone } : null;
  if (user.role === 'customer') {
    delete v.underwriting.notes;
    delete v.review.notes;
  } else {
    v.checklist = checklist(app);
  }
  v.editable = EDITABLE.includes(app.status);
  v.quoteValid = !!(app.quote && app.quote.expiresAt > now().toISOString() && app.quote.inputHash === materialHash(app));
  return v;
}

function load(req) {
  return assertApplicationAccess(req.user, db.get('applications', req.params.id));
}
function loadOwn(req) {
  const app = load(req);
  if (app.userId !== req.user.id) throw notFound('Application not found');
  return app;
}

// ---------- completeness ----------
function declarationProblems(app) {
  const p = [];
  if (app.product === 'health') {
    if (!app.health.members.length) p.push('Add at least one insured member');
    app.health.members.forEach((m, i) => {
      const who = m.fullName || `Member ${i + 1}`;
      if (typeof m.tobacco !== 'boolean') p.push(`${who}: tobacco declaration missing`);
      if (typeof m.hasConditions !== 'boolean') p.push(`${who}: existing medical conditions declaration missing`);
      if (m.hasConditions === true && !m.conditions?.trim()) p.push(`${who}: describe the existing conditions`);
      if (!(m.heightCm > 0) || !(m.weightKg > 0)) p.push(`${who}: height and weight are required`);
      if (m.medications == null) p.push(`${who}: current medications declaration missing (enter "None" if none)`);
      if (m.surgeries == null) p.push(`${who}: previous surgeries/hospitalisations declaration missing (enter "None" if none)`);
    });
  } else {
    const l = app.life;
    const la = l.lifeAssured || {};
    if (!la.fullName?.trim()) p.push('Life assured name is required');
    if (!la.dob) p.push('Life assured date of birth is required');
    if (!la.occupation?.trim()) p.push('Occupation is required');
    if (!(la.annualIncome > 0)) p.push('Annual income is required');
    if (typeof l.tobacco !== 'boolean') p.push('Tobacco declaration missing');
    if (typeof l.medicalHistory?.hasConditions !== 'boolean') p.push('Medical history declaration missing');
    if (l.medicalHistory?.hasConditions && !l.medicalHistory.details?.trim()) p.push('Describe the declared medical history');
    if (typeof l.existingInsurance?.has !== 'boolean') p.push('Existing insurance declaration missing');
    const nom = validateNominees(l.nominees);
    p.push(...nom.errors);
  }
  return p;
}

function checklist(app) {
  const docs = db.find('documents', (d) => d.entityType === 'application' && d.entityId === app.id);
  const has = (cat) => docs.some((d) => d.category === cat);
  const items = [
    { item: 'Declarations complete', ok: declarationProblems(app).length === 0 },
    { item: 'Valid quote attached', ok: !!app.quote },
    { item: 'Consent to declarations given', ok: !!app.consent?.given },
    { item: 'Identity document uploaded', ok: has('identity') },
  ];
  if (app.product === 'life') items.push({ item: 'Income proof uploaded', ok: has('income') });
  if (app.quote?.underwritingRequired) items.push({ item: 'Medical report uploaded (declarations trigger review)', ok: has('medical_report') });
  return items;
}

// ---------- listing / creation ----------
r.get('/', (req, res) => {
  const { status, product } = req.query;
  let list;
  if (req.user.role === 'customer') list = db.find('applications', (a) => a.userId === req.user.id);
  else if (['agent', 'underwriter', 'admin'].includes(req.user.role)) list = db.find('applications', (a) => a.status !== S.DRAFT);
  else return res.json([]);
  list = list.filter((a) => (!status || a.status === status) && (!product || a.product === product)).filter(bucketFilter('applications', req.query.bucket));
  res.json(list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => ({
    id: a.id, applicationNumber: a.applicationNumber, product: a.product, planName: a.planName, status: a.status,
    customerName: db.get('users', a.userId)?.name, createdAt: a.createdAt, updatedAt: a.updatedAt, submittedAt: a.submittedAt,
    premium: a.offer?.annualPremium ?? a.quote?.totalAnnualPremium ?? a.quote?.annualPremium ?? null,
    underwritingRequired: !!a.quote?.underwritingRequired, renewalOf: a.renewalOf || null, policyId: a.policyId || null,
  })));
});

export function createApplication(userId, plan, extra = {}) {
  const base = {
    applicationNumber: `APP-${today().slice(0, 4)}-${String(nextSeq('application')).padStart(6, '0')}`,
    userId, product: plan.product, planId: plan.id, planName: plan.name, planType: plan.type, planVersion: currentVersion(plan).version,
    status: S.DRAFT, startDate: addDays(today(), 1), consent: { given: false }, quote: null, offer: null, offerHistory: [],
    underwriting: { notes: [], requirements: [], decisions: [] }, review: { notes: [] }, timeline: [],
    returnTo: null, renewalOf: null, policyId: null,
  };
  if (plan.product === 'health') base.health = { coverage: null, optionalBenefits: [], members: [] };
  else {
    base.life = {
      lifeAssured: {}, policyholder: { sameAsLifeAssured: true }, sumAssured: null, policyTerm: null, premiumPaymentTerm: null,
      frequency: 'annual', riders: [], tobacco: null, medicalHistory: { hasConditions: null, details: '' },
      existingInsurance: { has: null, details: '', totalSumAssured: 0 }, uwClass: 'standard', nominees: [],
    };
  }
  const app = db.insert('applications', { ...base, ...extra });
  app.timeline.push({ at: now().toISOString(), status: S.DRAFT, by: 'Customer', role: 'customer', note: extra.renewalOf ? 'Renewal draft created' : 'Draft created' });
  return app;
}

r.post('/', requireRole('customer'), (req, res) => {
  const plan = db.get('plans', req.body?.planId);
  if (!plan || !plan.active) throw notFound('Plan not found or inactive');
  const app = tx(() => {
    const a = createApplication(req.user.id, plan);
    if (plan.product === 'health' && req.body.coverage) a.health.coverage = req.body.coverage;
    audit(req.user, 'APPLICATION_CREATED', 'application', a.id, { plan: plan.code });
    return a;
  });
  res.status(201).json(viewFor(req.user, app));
});

r.get('/:id', (req, res) => res.json(viewFor(req.user, load(req))));

// ---------- customer editing ----------
r.put('/:id', requireRole('customer'), (req, res) => {
  const app = loadOwn(req);
  if (!EDITABLE.includes(app.status)) {
    throw conflict(app.status === S.APPROVED || app.status === S.ACCEPTED
      ? 'Declarations are locked after approval. Reopen the review to make changes.'
      : `Application cannot be edited while ${app.status}`);
  }
  const b = req.body || {};
  tx(() => {
    const before = materialHash(app);
    if (b.startDate !== undefined) {
      if (b.startDate < today()) throw bad('Coverage start date cannot be in the past');
      app.startDate = b.startDate;
    }
    if (app.product === 'health') {
      if (b.coverage !== undefined) app.health.coverage = b.coverage;
      if (Array.isArray(b.optionalBenefits)) app.health.optionalBenefits = b.optionalBenefits;
      if (Array.isArray(b.members)) app.health.members = b.members.map((m) => ({ id: m.id || newId('mem'), ...pick(m, MEMBER_FIELDS) }));
    } else {
      const l = b.life || {};
      const cur = app.life;
      Object.assign(cur, pick(l, ['sumAssured', 'policyTerm', 'premiumPaymentTerm', 'frequency', 'riders', 'tobacco']));
      if (l.lifeAssured) cur.lifeAssured = { ...cur.lifeAssured, ...pick(l.lifeAssured, ['fullName', 'dob', 'gender', 'occupation', 'annualIncome', 'phone', 'email', 'address', 'idType', 'idNumber']) };
      if (l.medicalHistory) cur.medicalHistory = { ...cur.medicalHistory, ...l.medicalHistory };
      if (l.existingInsurance) cur.existingInsurance = { ...cur.existingInsurance, ...l.existingInsurance };
      cur.policyholder = { sameAsLifeAssured: true, fullName: cur.lifeAssured.fullName };
      if (Array.isArray(b.nominees)) cur.nominees = b.nominees;
    }
    const changed = before !== materialHash(app);
    if (changed && app.quote) {
      app.quote = null;
      app.quoteInvalidatedReason = 'Application details changed — please recalculate the quote';
    }
    if (b.consent !== undefined) app.consent = b.consent ? { given: true, at: now().toISOString() } : { given: false };
    else if (changed) app.consent = { given: false };
    db.touch(app);
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/quote', requireRole('customer'), (req, res) => {
  const app = loadOwn(req);
  if (!EDITABLE.includes(app.status)) throw conflict('Quotes can only be recalculated while the application is editable');
  const plan = db.get('plans', app.planId);
  const q = app.product === 'health'
    ? computeHealthQuote(plan, { ...app.health, startDate: app.startDate })
    : computeLifeQuote(plan, { ...lifeQuoteInputs(app), medical: app.life.medicalHistory });
  tx(() => {
    app.planVersion = q.planVersion;
    app.quote = { ...q, inputHash: materialHash(app), calculatedAt: now().toISOString(), expiresAt: new Date(now().getTime() + QUOTE_DAYS * 86400000).toISOString() };
    app.quoteInvalidatedReason = null;
    db.insert('quotes', { ...q, userId: req.user.id, applicationId: app.id, expiresAt: app.quote.expiresAt });
    db.touch(app);
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/validate-nominees', requireRole('customer'), (req, res) => {
  const { errors, normalized } = validateNominees(req.body?.nominees);
  res.json({ valid: errors.length === 0, errors, normalized });
});

function declarationSignature(m) {
  return hashInputs(pick(m, ['hasConditions', 'conditions', 'medications', 'surgeries', 'tobacco']));
}

function buildOffer(app, quote, { revised = false, reason = null, extra = {} } = {}) {
  const original = app.quote;
  const common = { planVersion: quote.planVersion, revised, reason, decidedAt: now().toISOString(), expiresAt: addDays(today(), OFFER_DAYS), ...extra };
  if (app.product === 'health') {
    const annualPremium = quote.totalAnnualPremium + (quote.loading || 0);
    return {
      ...common, coverage: quote.coverage, annualPremium, firstPayment: annualPremium, breakdown: quote,
      original: { coverage: original.coverage, annualPremium: original.totalAnnualPremium },
    };
  }
  return {
    ...common, sumAssured: quote.sumAssured, annualPremium: quote.annualPremium, installmentPremium: quote.installmentPremium,
    frequency: quote.frequency, uwClass: quote.uwClass, firstPayment: quote.installmentPremium, breakdown: quote,
    original: { sumAssured: original.sumAssured, annualPremium: original.annualPremium, installmentPremium: original.installmentPremium },
  };
}

r.post('/:id/submit', requireRole('customer'), (req, res) => {
  const app = loadOwn(req);
  // Safe retry: a repeated submit (e.g. after a network failure) returns the current state without duplicating.
  if ([S.SUBMITTED, S.INITIAL_REVIEW, S.UNDERWRITING].includes(app.status)) return res.json({ ...viewFor(req.user, app), alreadySubmitted: true });
  if (!EDITABLE.includes(app.status)) throw conflict(`Application cannot be submitted while ${app.status}`);
  const problems = [];
  if (!app.quote) problems.push(app.quoteInvalidatedReason || 'Calculate a quote before submitting');
  else if (app.quote.inputHash !== materialHash(app)) problems.push('Application details changed after quoting — recalculate the quote');
  else if (app.quote.expiresAt <= now().toISOString()) problems.push('Your quote has expired (quotes are valid for 7 days) — recalculate it');
  problems.push(...profileProblems(db.get('users', app.userId)));
  problems.push(...declarationProblems(app));
  if (!app.consent?.given) problems.push('You must confirm the declarations are true and give consent');
  if (problems.length) throw unprocessable('Application is incomplete', { problems });

  tx(() => {
    if (app.product === 'life') app.life.nominees = validateNominees(app.life.nominees).normalized;
    app.submittedAt = now().toISOString();
    if (app.renewalOf && app.status === S.DRAFT) {
      const prev = db.get('policies', app.renewalOf);
      const prevSigs = new Map(prev.members.map((m) => [`${m.fullName}|${m.dob}`, declarationSignature(m)]));
      const unchanged = app.health.members.every((m) => prevSigs.get(`${m.fullName}|${m.dob}`) === declarationSignature(m));
      if (unchanged) {
        transition(app, S.SUBMITTED, req.user, 'Renewal submitted');
        app.offer = buildOffer(app, app.quote, { extra: { renewal: true, previous: { policyNumber: prev.policyNumber, coverage: prev.coverage, annualPremium: prev.annualPremium, planVersion: prev.planVersion } } });
        transition(app, S.APPROVED, { name: 'Renewal rules engine', role: 'system' }, 'No changes to members or declarations — renewed at current renewal terms');
        audit({ name: 'Renewal rules engine', role: 'system' }, 'APPLICATION_AUTO_APPROVED', 'application', app.id, { renewalOf: prev.id });
        notify(app.userId, 'Renewal offer ready', `Review the renewal terms for ${prev.policyNumber} and accept to proceed to payment.`, { link: `/applications/${app.id}` });
        return;
      }
    }
    const next = app.returnTo || S.SUBMITTED;
    app.returnTo = null;
    transition(app, next, req.user, next === S.SUBMITTED ? 'Application submitted' : 'Information provided — returned for review');
    audit(req.user, 'APPLICATION_SUBMITTED', 'application', app.id, { status: next });
    notify(app.userId, 'Application received', `${app.applicationNumber} has been submitted for review.`, { link: `/applications/${app.id}` });
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/accept-offer', requireRole('customer'), (req, res) => {
  const app = loadOwn(req);
  if (app.status !== S.APPROVED) throw conflict('There is no approved offer to accept');
  if (app.offer.expiresAt < today()) throw conflict('This offer has expired; please contact us to have it re-issued');
  tx(() => {
    app.offer.acceptedAt = now().toISOString();
    transition(app, S.ACCEPTED, req.user, app.offer.revised ? 'Revised terms accepted' : 'Offer accepted');
    audit(req.user, 'OFFER_ACCEPTED', 'application', app.id, { revised: app.offer.revised, premium: app.offer.annualPremium });
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/decline-offer', requireRole('customer'), (req, res) => {
  const app = loadOwn(req);
  if (app.status !== S.APPROVED) throw conflict('There is no approved offer to decline');
  tx(() => {
    transition(app, S.DECLINED, req.user, req.body?.reason || 'Offer declined by customer');
    audit(req.user, 'OFFER_DECLINED', 'application', app.id);
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/reopen', requireRole('customer'), (req, res) => {
  const app = loadOwn(req);
  if (![S.APPROVED, S.ACCEPTED].includes(app.status)) throw conflict('Only approved, unpaid applications can be reopened');
  if (db.findOne('payments', (p) => p.applicationId === app.id && p.status === 'pending')) throw conflict('A payment is in progress for this application');
  tx(() => {
    app.offerHistory.push({ ...app.offer, withdrawnAt: now().toISOString(), withdrawnReason: 'Customer reopened review' });
    app.offer = null;
    app.quote = null;
    app.returnTo = S.UNDERWRITING;
    transition(app, S.MIR, req.user, req.body?.reason || 'Customer reopened the review to change declarations');
    audit(req.user, 'APPLICATION_REOPENED', 'application', app.id);
  });
  res.json(viewFor(req.user, app));
});

// ---------- agent / initial review ----------
const reviewer = requireRole('agent', 'underwriter', 'admin');

r.post('/:id/review/start', reviewer, (req, res) => {
  const app = load(req);
  if (app.status !== S.SUBMITTED) throw conflict('Only submitted applications can enter initial review');
  tx(() => {
    app.review.reviewer = { id: req.user.id, name: req.user.name };
    transition(app, S.INITIAL_REVIEW, req.user, 'Initial review started');
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/review/request-correction', reviewer, (req, res) => {
  const app = load(req);
  const note = req.body?.note?.trim();
  if (!note) throw bad('Describe the correction required');
  if (![S.SUBMITTED, S.INITIAL_REVIEW].includes(app.status)) throw conflict('Corrections can be requested during initial review');
  tx(() => {
    app.returnTo = S.INITIAL_REVIEW;
    app.underwriting.requirements.push({ id: newId('req'), type: 'information', description: note, status: 'requested', requestedBy: req.user.name, requestedAt: now().toISOString() });
    transition(app, S.MIR, req.user, `Correction requested: ${note}`);
    audit(req.user, 'CORRECTION_REQUESTED', 'application', app.id, { note });
    notify(app.userId, 'Action needed on your application', note, { type: 'warning', link: `/applications/${app.id}` });
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/review/forward', reviewer, (req, res) => {
  const app = load(req);
  if (app.status !== S.INITIAL_REVIEW) throw conflict('Application must be in initial review');
  tx(() => {
    app.underwriting.requirements.filter((x) => x.type === 'information' && x.status === 'requested').forEach((x) => { x.status = 'received'; x.receivedAt = now().toISOString(); });
    transition(app, S.UNDERWRITING, req.user, req.body?.note || 'Complete — forwarded to underwriting');
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/notes', requireRole('agent', 'underwriter', 'admin'), (req, res) => {
  const app = load(req);
  const note = req.body?.note?.trim();
  if (!note) throw bad('Note is required');
  tx(() => {
    const target = req.user.role === 'agent' ? app.review.notes : app.underwriting.notes;
    target.push({ at: now().toISOString(), by: req.user.name, role: req.user.role, note });
    db.touch(app);
  });
  res.json(viewFor(req.user, app));
});

// ---------- underwriting ----------
const underwriter = requireRole('underwriter', 'admin');

r.post('/:id/underwriting/requirements', underwriter, (req, res) => {
  const app = load(req);
  if (app.status !== S.UNDERWRITING) throw conflict('Application is not in underwriting');
  const { type, description, scheduledAt, center } = req.body || {};
  if (!['medical_test', 'exam', 'document', 'information'].includes(type)) throw bad('type must be medical_test, exam, document or information');
  if (!description?.trim()) throw bad('Description is required');
  tx(() => {
    const reqmt = { id: newId('req'), type, description: description.trim(), status: scheduledAt ? 'scheduled' : 'requested', scheduledAt: scheduledAt || null, center: center || null, requestedBy: req.user.name, requestedAt: now().toISOString() };
    app.underwriting.requirements.push(reqmt);
    if (type === 'information') {
      app.returnTo = S.UNDERWRITING;
      transition(app, S.MIR, req.user, `More information required: ${reqmt.description}`);
    } else timelineNote(app, req.user, `Requirement added: ${type.replace('_', ' ')} — ${reqmt.description}`);
    audit(req.user, 'UW_REQUIREMENT_ADDED', 'application', app.id, reqmt);
    notify(app.userId, 'Underwriting requirement', `${reqmt.description}${scheduledAt ? ` (scheduled ${scheduledAt}${center ? ` at ${center}` : ''})` : ''}`, { type: 'warning', link: `/applications/${app.id}` });
    db.touch(app);
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/underwriting/requirements/:rid', underwriter, (req, res) => {
  const app = load(req);
  const reqmt = app.underwriting.requirements.find((x) => x.id === req.params.rid);
  if (!reqmt) throw notFound('Requirement not found');
  const { action, scheduledAt, center, documentId, note } = req.body || {};
  tx(() => {
    if (action === 'schedule') Object.assign(reqmt, { status: 'scheduled', scheduledAt, center });
    else if (action === 'received') Object.assign(reqmt, { status: 'received', receivedAt: now().toISOString(), documentId: documentId || null, note: note || null });
    else if (action === 'waive') {
      if (!note?.trim()) throw bad('A reason is required to waive a requirement');
      Object.assign(reqmt, { status: 'waived', note });
    } else throw bad('action must be schedule, received or waive');
    audit(req.user, 'UW_REQUIREMENT_UPDATED', 'application', app.id, { requirement: reqmt.id, action });
    timelineNote(app, req.user, `Requirement "${reqmt.description}" ${reqmt.status}`);
    db.touch(app);
  });
  res.json(viewFor(req.user, app));
});

r.post('/:id/underwriting/decision', underwriter, (req, res) => {
  const app = load(req);
  if (app.status !== S.UNDERWRITING) throw conflict('Application is not in underwriting');
  const { decision, reason, notes } = req.body || {};
  const plan = db.get('plans', app.planId);
  const version = planVersion(plan, app.quote.planVersion);
  const outstanding = app.underwriting.requirements.filter((x) => ['requested', 'scheduled'].includes(x.status));
  if (['approve', 'revise'].includes(decision) && outstanding.length) {
    throw conflict(`Outstanding requirements must be received or waived first: ${outstanding.map((x) => x.description).join('; ')}`);
  }
  if (['revise', 'reject', 'postpone'].includes(decision) && !reason?.trim()) throw bad('A reason is required for this decision');
  if (decision === 'postpone' && app.product !== 'life') throw bad('Postpone applies to life applications');

  tx(() => {
    const rec = { decision, reason: reason || null, notes: notes || null, by: req.user.name, byId: req.user.id, at: now().toISOString() };
    if (decision === 'approve') {
      app.offer = buildOffer(app, app.quote);
      transition(app, S.APPROVED, req.user, 'Approved at standard terms');
    } else if (decision === 'revise') {
      let q;
      if (app.product === 'health') {
        const { revisedCoverage, loadingBp = 0 } = req.body;
        q = computeHealthQuote(plan, { ...app.health, coverage: revisedCoverage ?? app.health.coverage, startDate: app.startDate }, { version, allowInactive: true });
        q.loadingBp = loadingBp;
        q.loading = pct(q.totalAnnualPremium, loadingBp);
      } else {
        const { uwClass, extraLoadingBp = 0, revisedSumAssured } = req.body;
        q = computeLifeQuote(plan, { ...lifeQuoteInputs(app), sumAssured: revisedSumAssured ?? app.life.sumAssured, uwClass: uwClass || app.life.uwClass, extraLoadingBp }, { version, allowInactive: true });
      }
      app.offer = buildOffer(app, q, { revised: true, reason: reason.trim(), extra: { specialConditions: req.body.specialConditions || null } });
      rec.offer = { annualPremium: app.offer.annualPremium, coverage: app.offer.coverage ?? app.offer.sumAssured };
      transition(app, S.APPROVED, req.user, `Revised terms proposed: ${reason}`);
    } else if (decision === 'reject') {
      transition(app, S.REJECTED, req.user, `Rejected: ${reason}`);
    } else if (decision === 'postpone') {
      transition(app, S.POSTPONED, req.user, `Postponed: ${reason}`);
    } else throw bad('decision must be approve, revise, reject or postpone');
    app.underwriting.decisions.push(rec);
    audit(req.user, `UW_${decision.toUpperCase()}`, 'application', app.id, { reason, offerPremium: app.offer?.annualPremium });
    const msg = {
      approve: 'Your application has been approved. Accept the offer to proceed to payment.',
      revise: `Underwriting proposed revised terms: ${reason}. Review and accept to continue.`,
      reject: `Your application was not approved: ${reason}`,
      postpone: `Your application has been postponed: ${reason}`,
    }[decision];
    notify(app.userId, `Application ${app.applicationNumber}: ${app.status}`, msg, { type: decision === 'reject' ? 'error' : 'info', link: `/applications/${app.id}` });
  });
  res.json(viewFor(req.user, app));
});

export default r;

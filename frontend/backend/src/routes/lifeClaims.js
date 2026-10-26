// Life death claims. Claimants use a separate, restricted portal: they never need the
// deceased customer's login, and see policy information only after verification.
import { Router } from 'express';
import { db, newId, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { AppError, bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { isValidDate } from '../utils/dates.js';
import { assertPaise, pct, sum } from '../utils/money.js';
import { assertLifeClaimAccess } from '../services/access.js';
import { nomineesAt, policyStatusAt, transition } from '../services/lifecycle.js';
import { audit, notify } from '../services/audit.js';
import { cleanEmail, cleanName, createSession, maskEmail, normalizeMobile } from '../services/security.js';
import { challengeView, checkOtp, createChallenge } from '../services/challenges.js';
import { validatePayoutDetails } from './healthClaims.js';

const r = Router();
const DEV = process.env.NODE_ENV !== 'production';
const OPEN = (c) => !['Rejected'].includes(c.status);
const PAID_OR_APPROVED = ['Approved', 'Partially Paid', 'Settled'];

// ---------------- public portal ----------------
r.post('/portal/start', (req, res) => {
  const { policyNumber, lifeAssuredName, lifeAssuredDob, claimant = {} } = req.body || {};
  const fields = {};
  if (!cleanName(claimant.name, { max: 120 })) fields.name = 'Enter your full name.';
  if (!claimant.relationship?.trim()) fields.relationship = 'Enter your relationship to the life assured.';
  if (!cleanEmail(claimant.email)) fields.email = 'Enter a valid email address.';
  if (!normalizeMobile(claimant.phone)) fields.phone = 'Enter a valid 10-digit mobile number.';
  if (!claimant.idType || !claimant.idNumber?.trim()) fields.idNumber = 'Enter your identity document details.';
  if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields });
  const policy = db.findOne('policies', (p) => p.product === 'life' && p.policyNumber === String(policyNumber || '').trim().toUpperCase());
  const matches = policy && policy.lifeAssured.dob === lifeAssuredDob &&
    policy.lifeAssured.fullName.trim().toLowerCase() === String(lifeAssuredName || '').trim().toLowerCase();
  // Generic message: never reveal whether a policy number exists.
  if (!matches) throw bad('We could not verify these details. Check the policy number, name and date of birth of the life assured.');
  const email = cleanEmail(claimant.email).toLowerCase();
  const { acc, challenge, secret } = tx(() => {
    let a = db.findOne('claimantAccounts', (x) => x.policyId === policy.id && x.email === email);
    if (!a) a = db.insert('claimantAccounts', { policyId: policy.id, email, name: cleanName(claimant.name, { max: 120 }), claimIds: [], verified: false });
    Object.assign(a, { phone: normalizeMobile(claimant.phone), relationship: claimant.relationship.trim(), idType: claimant.idType, idNumber: claimant.idNumber.trim() });
    const ch = createChallenge({ subjectId: a.id, purpose: 'claimant_access', destination: email, kind: 'otp' });
    audit({ id: a.id, role: 'claimant', name: a.name }, 'CLAIMANT_VERIFICATION_STARTED', 'policy', policy.id, { email: maskEmail(email) });
    return { acc: a, ...ch };
  });
  res.status(201).json({
    accountId: acc.id, ...challengeView(challenge, maskEmail(email)),
    message: 'We sent a 6-digit code to your email.', ...(DEV ? { devOtp: secret } : {}),
  });
});

r.post('/portal/verify', (req, res) => {
  const { accountId, otp } = req.body || {};
  const acc = db.get('claimantAccounts', accountId);
  if (!acc) throw bad('The code is invalid or has expired.');
  const challengeId = req.body?.challengeId || db.find('challenges', (c) => c.subjectId === acc.id && c.purpose === 'claimant_access' && !c.usedAt && !c.supersededAt).pop()?.id;
  const out = tx(() => {
    const result = checkOtp(challengeId, otp, { subjectId: acc.id, purposes: ['claimant_access'] });
    if (!result.ok) return result;
    Object.assign(acc, { verified: true, verifiedAt: now().toISOString() });
    const { csrfToken } = createSession(res, req, { subjectId: acc.id, role: 'claimant' });
    audit({ id: acc.id, role: 'claimant', name: acc.name }, 'CLAIMANT_VERIFIED', 'policy', acc.policyId);
    return { ...result, csrfToken };
  });
  if (!out.ok) throw bad(out.error, { attemptsLeft: out.attemptsLeft });
  res.json({ csrfToken: out.csrfToken, user: { id: acc.id, role: 'claimant', name: acc.name, email: acc.email } });
});

r.use(authenticate);

r.get('/portal/me', requireRole('claimant'), (req, res) => {
  const acc = db.get('claimantAccounts', req.user.id);
  const p = db.get('policies', acc.policyId);
  res.json({
    claimant: { name: acc.name, email: acc.email, phone: acc.phone, relationship: acc.relationship },
    policy: { policyNumber: p.policyNumber, planName: p.planName, lifeAssuredName: p.lifeAssured.fullName, startDate: p.startDate, endDate: p.endDate },
    claims: db.find('lifeClaims', (c) => c.claimantAccountId === acc.id).map((c) => claimView(c, req.user)),
  });
});

// ---------------- claims ----------------
function analysis(c) {
  const p = db.get('policies', c.policyId);
  const others = db.find('lifeClaims', (x) => x.policyId === p.id && x.id !== c.id && OPEN(x));
  const adb = c.causeType === 'accident' && p.riders.includes('ADB') ? pct(p.sumAssured, p.termsSnapshot.riders.find((x) => x.code === 'ADB')?.benefitPctOfSA || 0) : 0;
  return {
    policyStatusAtDeath: policyStatusAt(p, c.dateOfDeath),
    currentPolicyStatus: policyStatusAt(p),
    coveragePeriod: `${p.startDate} to ${p.endDate}`,
    sumAssured: p.sumAssured, riders: p.riders, accidentalBenefit: adb, suggestedBenefit: p.sumAssured + adb,
    nomineesAtDeath: nomineesAt(p, c.dateOfDeath),
    nomineeHistory: p.nomineeVersions.map(({ challengeId, ...v }) => v),
    otherClaims: others.map((x) => ({ id: x.id, claimNumber: x.claimNumber, status: x.status, claimant: x.claimant.name })),
    deathBenefitAlreadySettled: !!p.deathBenefitSettled,
    exclusions: p.termsSnapshot.exclusions,
  };
}

function claimView(c, user) {
  const v = structuredClone(c);
  if (user.role === 'claimant') {
    delete v.internalNotes;
    delete v.flags;
    v.beneficiaries = v.beneficiaries.map((b) => ({ name: b.name, allocation: b.allocation, paid: b.paid }));
  } else {
    v.analysis = analysis(c);
    v.payouts = db.find('payouts', (p) => p.claimId === c.id);
  }
  return v;
}

const load = (req) => assertLifeClaimAccess(req.user, db.get('lifeClaims', req.params.id));
const officer = requireRole('claims_officer', 'admin');

r.get('/', (req, res) => {
  const list = req.user.role === 'claimant' ? db.find('lifeClaims', (c) => c.claimantAccountId === req.user.id)
    : ['claims_officer', 'admin'].includes(req.user.role) ? db.all('lifeClaims') : [];
  res.json([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => ({
    id: c.id, claimNumber: c.claimNumber, policyNumber: c.policyNumber, lifeAssuredName: c.lifeAssuredName, claimantName: c.claimant.name,
    dateOfDeath: c.dateOfDeath, status: c.status, flagged: !!c.flags?.duplicateOf?.length && !c.flags.cleared, approvedAmount: c.approvedAmount, createdAt: c.createdAt,
  })));
});

r.get('/:id', (req, res) => res.json(claimView(load(req), req.user)));

r.post('/', requireRole('claimant'), (req, res) => {
  const b = req.body || {};
  const acc = db.get('claimantAccounts', req.user.id);
  if (b.idempotencyKey) {
    const prior = db.findOne('lifeClaims', (c) => c.idempotencyKey === b.idempotencyKey && c.claimantAccountId === acc.id);
    if (prior) return res.json(claimView(prior, req.user));
  }
  if (!isValidDate(b.dateOfDeath)) throw bad('A valid date of death is required');
  if (b.dateOfDeath > today()) throw bad('Date of death cannot be in the future');
  if (!b.causeOfDeath?.trim()) throw bad('Cause of death is required');
  const policy = db.get('policies', acc.policyId);
  if (b.dateOfDeath < policy.lifeAssured.dob) throw bad('Date of death cannot precede the date of birth');
  const payoutDetails = b.payoutDetails ? validatePayoutDetails(b.payoutDetails) : null;
  const claim = tx(() => {
    const dups = db.find('lifeClaims', (x) => x.policyId === policy.id && OPEN(x));
    const c = db.insert('lifeClaims', {
      claimNumber: `LC-${today().slice(0, 4)}-${String(nextSeq('lifeClaim')).padStart(6, '0')}`,
      idempotencyKey: b.idempotencyKey || null, policyId: policy.id, policyNumber: policy.policyNumber,
      claimantAccountId: acc.id,
      claimant: { name: acc.name, email: acc.email, phone: acc.phone, relationship: acc.relationship, idType: acc.idType, idNumber: acc.idNumber },
      claimantVerified: false, lifeAssuredName: policy.lifeAssured.fullName,
      dateOfDeath: b.dateOfDeath, causeOfDeath: b.causeOfDeath.trim(), causeType: ['natural', 'accident', 'other'].includes(b.causeType) ? b.causeType : 'natural',
      placeOfDeath: b.placeOfDeath || '', claimantPayoutDetails: payoutDetails,
      status: 'Reported', flags: { duplicateOf: dups.map((d) => d.claimNumber), cleared: false },
      beneficiaries: [], approvedAmount: null, firstApproval: null, secondApproval: null,
      documentRequests: [], internalNotes: [], timeline: [],
    });
    c.timeline.push({ at: now().toISOString(), status: 'Reported', by: acc.name, role: 'claimant', note: dups.length ? `Flagged for review: possible duplicate of ${dups.map((d) => d.claimNumber).join(', ')}` : 'Death claim reported' });
    acc.claimIds.push(c.id);
    audit(req.user, 'LIFE_CLAIM_REPORTED', 'lifeClaim', c.id, { claimNumber: c.claimNumber, duplicates: c.flags.duplicateOf });
    // Policy owner gets an informational notice; the policy status itself is NOT changed by a claim.
    notify(policy.userId, 'Death claim reported', `A claim (${c.claimNumber}) has been reported on ${policy.policyNumber}.`);
    return c;
  });
  res.status(201).json(claimView(claim, req.user));
});

r.post('/:id/respond', requireRole('claimant'), (req, res) => {
  const c = load(req);
  if (c.status !== 'Documents Requested') throw conflict('No documents are currently requested');
  tx(() => {
    c.documentRequests.forEach((d) => { d.resolved = true; });
    transition(c, c.resumeStatus || 'Under Review', req.user, req.body?.note || 'Requested documents provided');
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/start-review', officer, (req, res) => {
  const c = load(req);
  if (c.status !== 'Reported') throw conflict('Claim is not awaiting review');
  tx(() => transition(c, 'Under Review', req.user, 'Review started'));
  res.json(claimView(c, req.user));
});

r.post('/:id/request-documents', officer, (req, res) => {
  const c = load(req);
  const note = req.body?.note?.trim();
  if (!note) throw bad('Describe the documents required');
  if (!['Reported', 'Under Review', 'Documents Requested'].includes(c.status)) throw conflict(`Claim is ${c.status}`);
  tx(() => {
    if (c.status !== 'Documents Requested') c.resumeStatus = c.status === 'Reported' ? 'Under Review' : c.status;
    c.documentRequests.push({ note, at: now().toISOString(), by: req.user.name, resolved: false });
    transition(c, 'Documents Requested', req.user, note);
    audit(req.user, 'CLAIM_DOCUMENTS_REQUESTED', 'lifeClaim', c.id, { note });
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/notes', officer, (req, res) => {
  const c = load(req);
  if (!req.body?.note?.trim()) throw bad('Note is required');
  tx(() => c.internalNotes.push({ at: now().toISOString(), by: req.user.name, note: req.body.note.trim() }));
  res.json(claimView(c, req.user));
});

r.post('/:id/verify-claimant', officer, (req, res) => {
  const c = load(req);
  tx(() => {
    c.claimantVerified = true;
    c.claimantVerifiedBy = req.user.name;
    audit(req.user, 'CLAIMANT_IDENTITY_VERIFIED', 'lifeClaim', c.id, { note: req.body?.note });
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/clear-flag', officer, (req, res) => {
  const c = load(req);
  if (!req.body?.note?.trim()) throw bad('Record why the duplicate flag is cleared');
  tx(() => {
    c.flags.cleared = true;
    c.flags.note = req.body.note.trim();
    audit(req.user, 'DUPLICATE_FLAG_CLEARED', 'lifeClaim', c.id, { note: c.flags.note });
  });
  res.json(claimView(c, req.user));
});

r.put('/:id/beneficiaries', officer, (req, res) => {
  const c = load(req);
  if (!['Under Review'].includes(c.status)) throw conflict('Beneficiaries can be set while the claim is under review');
  const list = req.body?.beneficiaries;
  if (!Array.isArray(list) || !list.length) throw bad('At least one beneficiary is required');
  tx(() => {
    c.beneficiaries = list.map((b, i) => {
      if (!b.name?.trim()) throw bad(`Beneficiary ${i + 1}: name is required`);
      return {
        id: b.id || newId('ben'), name: b.name.trim(), relationship: b.relationship || '', entitlement: b.entitlement || 'nominee',
        payoutDetails: b.payoutDetails ? validatePayoutDetails(b.payoutDetails) : null, verified: !!b.verified,
        allocation: 0, paid: false,
      };
    });
    audit(req.user, 'BENEFICIARIES_SET', 'lifeClaim', c.id, { beneficiaries: c.beneficiaries.map((b) => b.name) });
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/assess', officer, (req, res) => {
  const c = load(req);
  if (c.status !== 'Under Review') throw conflict('Claim must be under review');
  if (!c.claimantVerified) throw conflict('Verify the claimant identity first');
  if (c.flags.duplicateOf.length && !c.flags.cleared) throw conflict('Resolve the duplicate-claim flag before approving');
  const policy = db.get('policies', c.policyId);
  if (policy.deathBenefitSettled) throw conflict('The death benefit for this policy has already been settled');
  const { approvedAmount, allocations, note } = req.body || {};
  assertPaise(approvedAmount, 'approvedAmount');
  if (!Array.isArray(allocations) || !allocations.length) throw bad('Provide the payout allocation');
  const total = sum(allocations, (a) => a.amount);
  if (total !== approvedAmount) throw bad(`Payout allocations (${total}) must equal the approved benefit (${approvedAmount})`);
  for (const a of allocations) {
    const ben = c.beneficiaries.find((b) => b.id === a.beneficiaryId);
    if (!ben) throw bad('Allocation refers to an unknown beneficiary');
    assertPaise(a.amount, 'allocation amount', { allowZero: true });
    if (a.amount > 0 && (!ben.verified || !ben.payoutDetails)) throw bad(`${ben.name}: identity and payout details must be verified before allocation`);
  }
  tx(() => {
    for (const b of c.beneficiaries) b.allocation = allocations.find((a) => a.beneficiaryId === b.id)?.amount || 0;
    c.approvedAmount = approvedAmount;
    c.firstApproval = { by: req.user.name, byId: req.user.id, at: now().toISOString(), note: note || null };
    transition(c, 'Pending Second Approval', req.user, `Benefit ${approvedAmount} paise assessed; awaiting independent approval`);
    audit(req.user, 'LIFE_CLAIM_FIRST_APPROVAL', 'lifeClaim', c.id, { approvedAmount, allocations });
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/second-approval', officer, (req, res) => {
  const c = load(req);
  if (c.status !== 'Pending Second Approval') throw conflict('Claim is not awaiting second approval');
  if (c.firstApproval.byId === req.user.id) throw new AppError(403, 'Second approval must be given by a different officer');
  const policy = db.get('policies', c.policyId);
  const other = db.findOne('lifeClaims', (x) => x.policyId === policy.id && x.id !== c.id && PAID_OR_APPROVED.includes(x.status));
  if (policy.deathBenefitSettled || other) throw conflict('Another death benefit for this policy is already approved or settled');
  tx(() => {
    c.secondApproval = { by: req.user.name, byId: req.user.id, at: now().toISOString(), note: req.body?.note || null };
    transition(c, 'Approved', req.user, 'Independent second approval given');
    audit(req.user, 'LIFE_CLAIM_SECOND_APPROVAL', 'lifeClaim', c.id, { approvedAmount: c.approvedAmount });
    const acc = db.get('claimantAccounts', c.claimantAccountId);
    notify(acc?.id, 'Claim approved', `${c.claimNumber} has been approved; payouts will be made to the verified beneficiaries.`);
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/send-back', officer, (req, res) => {
  const c = load(req);
  if (c.status !== 'Pending Second Approval') throw conflict('Claim is not awaiting second approval');
  if (!req.body?.reason?.trim()) throw bad('A reason is required');
  tx(() => {
    c.firstApproval = null;
    transition(c, 'Under Review', req.user, `Returned by second approver: ${req.body.reason}`);
    audit(req.user, 'LIFE_CLAIM_SENT_BACK', 'lifeClaim', c.id, { reason: req.body.reason });
  });
  res.json(claimView(c, req.user));
});

r.post('/:id/reject', officer, (req, res) => {
  const c = load(req);
  const reason = req.body?.reason?.trim();
  if (!reason) throw bad('A rejection must include a recorded explanation');
  if (['Settled', 'Partially Paid', 'Rejected'].includes(c.status)) throw conflict(`Claim is ${c.status}`);
  tx(() => {
    c.rejection = { reason, by: req.user.name, at: now().toISOString() };
    transition(c, 'Rejected', req.user, reason);
    audit(req.user, 'LIFE_CLAIM_REJECTED', 'lifeClaim', c.id, { reason });
  });
  res.json(claimView(c, req.user));
});

export default r;

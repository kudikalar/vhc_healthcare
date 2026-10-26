import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, LAKH, R, isoAddDays, yearsAgo } from './helpers.js';

let s, today, start;
before(async () => {
  s = await startServer();
  today = (await s.api('GET', '/dev/clock')).body.today;
  start = isoAddDays(today, 1);
});
after(() => s.close());

const decl = { heightCm: 170, weightKg: 70, hasConditions: false, conditions: '', medications: 'None', surgeries: 'None', tobacco: false };
const quote = (planId, members, coverage = 5 * LAKH, extra = {}) =>
  s.api('POST', '/quotes/health', { body: { planId, coverage, members, startDate: start, ...extra } });

test('floater pricing: age bands, coverage multiplier, 10% floater discount, optional benefits after discount', async () => {
  const members = [
    { fullName: 'A', relationship: 'self', dob: yearsAgo(start, 30) },
    { fullName: 'B', relationship: 'spouse', dob: yearsAgo(start, 40) },
    { fullName: 'C', relationship: 'child', dob: yearsAgo(start, 10) },
  ];
  const q = await quote('pln_health_floater', members, 10 * LAKH, { optionalBenefits: ['OPD'] });
  assert.equal(q.status, 200);
  assert.equal(q.body.basePremium, R(12000));
  assert.equal(q.body.multipliedPremium, R(21600));
  assert.equal(q.body.floaterDiscount, R(2160));
  assert.equal(q.body.totalAnnualPremium, R(19440 + 1500));
  const ind = await quote('pln_health_individual', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 35) }]);
  assert.equal(ind.body.totalAnnualPremium, R(4000));
  const band = await quote('pln_health_individual', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 36) }]);
  assert.equal(band.body.totalAnnualPremium, R(6000));
});

test('eligibility: age boundary, unsupported relationship, excess members', async () => {
  assert.equal((await quote('pln_health_individual', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 65) }])).status, 200);
  assert.equal((await quote('pln_health_individual', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 66, 1) }])).status, 200);
  const old = await quote('pln_health_individual', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 66) }]);
  assert.equal(old.status, 422);
  assert.match(old.body.details.memberErrors['0'][0], /Age 66/);
  const rel = await quote('pln_health_senior', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 62) }, { fullName: 'B', relationship: 'child', dob: yearsAgo(start, 35) }]);
  assert.equal(rel.status, 422);
  assert.match(rel.body.details.memberErrors['1'].join(), /not allowed/);
  const many = await quote('pln_health_individual', [{ fullName: 'A', relationship: 'self', dob: yearsAgo(start, 30) }, { fullName: 'B', relationship: 'spouse', dob: yearsAgo(start, 30) }]);
  assert.equal(many.status, 422);
  assert.match(many.body.details.errors.join(), /at most 1/);
});

test('purchase flow: quote invalidation, submission, review, underwriting, revised offer, payments, issuance', async () => {
  const t = s.tokens.cust2;
  const app = (await s.api('POST', '/applications', { token: t, body: { planId: 'pln_health_floater' } })).body;
  const members = [
    { fullName: 'Rahul Mehta', relationship: 'self', dob: yearsAgo(start, 40), ...decl },
    { fullName: 'Nisha Mehta', relationship: 'spouse', dob: yearsAgo(start, 38), ...decl },
  ];
  await s.api('PUT', `/applications/${app.id}`, { token: t, body: { members, coverage: 5 * LAKH, consent: true } });
  let a = (await s.api('POST', `/applications/${app.id}/quote`, { token: t })).body;
  assert.equal(a.quote.totalAnnualPremium, R(10800));
  // changing members invalidates the quote
  a = (await s.api('PUT', `/applications/${app.id}`, { token: t, body: { members: [...members, { fullName: 'Kid', relationship: 'child', dob: yearsAgo(start, 5) }] } })).body;
  assert.equal(a.quote, null);
  const incomplete = await s.api('POST', `/applications/${app.id}/submit`, { token: t });
  assert.equal(incomplete.status, 422);
  await s.api('PUT', `/applications/${app.id}`, { token: t, body: { members: [...members, { fullName: 'Kid', relationship: 'child', dob: yearsAgo(start, 5), ...decl, heightCm: 110, weightKg: 18 }], consent: true } });
  await s.api('POST', `/applications/${app.id}/quote`, { token: t });
  a = (await s.api('POST', `/applications/${app.id}/submit`, { token: t })).body;
  assert.equal(a.status, 'Submitted');
  const retry = await s.api('POST', `/applications/${app.id}/submit`, { token: t });
  assert.equal(retry.body.alreadySubmitted, true);

  await s.api('POST', `/applications/${app.id}/review/start`, { token: s.tokens.agent });
  a = (await s.api('POST', `/applications/${app.id}/review/forward`, { token: s.tokens.agent })).body;
  assert.equal(a.status, 'Underwriting');
  a = (await s.api('POST', `/applications/${app.id}/underwriting/requirements`, { token: s.tokens.uw, body: { type: 'medical_test', description: 'Lipid profile for Rahul' } })).body;
  const blocked = await s.api('POST', `/applications/${app.id}/underwriting/decision`, { token: s.tokens.uw, body: { decision: 'approve' } });
  assert.equal(blocked.status, 409);
  await s.api('POST', `/applications/${app.id}/underwriting/requirements/${a.underwriting.requirements[0].id}`, { token: s.tokens.uw, body: { action: 'received' } });
  assert.equal((await s.api('POST', `/applications/${app.id}/underwriting/decision`, { token: s.tokens.uw, body: { decision: 'revise', loadingBp: 1000 } })).status, 400);
  a = (await s.api('POST', `/applications/${app.id}/underwriting/decision`, { token: s.tokens.uw, body: { decision: 'revise', loadingBp: 1000, reason: 'Elevated lipids' } })).body;
  assert.equal(a.status, 'Approved');
  assert.equal(a.offer.revised, true);
  assert.ok(a.offer.annualPremium > a.offer.original.annualPremium);
  assert.equal((await s.api('PUT', `/applications/${app.id}`, { token: t, body: { coverage: 10 * LAKH } })).status, 409);

  const key = () => `k-${Math.random()}`;
  const early = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: a.offer.firstPayment, idempotencyKey: key() } });
  assert.equal(early.status, 409, 'payment blocked until offer accepted');
  a = (await s.api('POST', `/applications/${app.id}/accept-offer`, { token: t })).body;
  const wrong = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: a.offer.firstPayment - 1, idempotencyKey: key() } });
  assert.equal(wrong.status, 400);
  const k1 = key();
  const p1 = (await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: a.offer.firstPayment, idempotencyKey: k1 } })).body.payment;
  const replay = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: a.offer.firstPayment, idempotencyKey: k1 } });
  assert.equal(replay.body.payment.reference, p1.reference);
  const failed = await s.api('POST', `/payments/${p1.reference}/simulate`, { token: t, body: { outcome: 'failed' } });
  assert.equal(failed.body.payment.status, 'failed');
  const p2 = (await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: a.offer.firstPayment, idempotencyKey: key() } })).body.payment;
  assert.notEqual(p2.reference, p1.reference);
  const pending = await s.api('POST', `/payments/${p2.reference}/simulate`, { token: t, body: { outcome: 'pending' } });
  assert.equal(pending.body.payment.status, 'pending');
  const ok = await s.api('POST', '/payments/callback', { body: { reference: p2.reference, status: 'success', amount: p2.amount } });
  assert.equal(ok.body.status, 'success');
  const dup = await s.api('POST', '/payments/callback', { body: { reference: p2.reference, status: 'success', amount: p2.amount } });
  assert.equal(dup.body.duplicate, true);
  a = (await s.api('GET', `/applications/${app.id}`, { token: t })).body;
  assert.equal(a.status, 'Issued');
  const pol = (await s.api('GET', `/policies/${a.policyId}`, { token: t })).body;
  assert.equal(pol.annualPremium, a.offer.annualPremium, 'policy matches the accepted offer');
  assert.equal(pol.members.length, 3);
  const again = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: a.offer.firstPayment, idempotencyKey: key() } });
  assert.equal(again.status, 409);
  const pdf = await s.api('GET', `/policies/${a.policyId}/pdf`, { token: t });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(pdf.body).subarray(0, 4).toString(), '%PDF');
});

test('plan edits create a new version and do not change existing policy terms', async () => {
  const plan = (await s.api('GET', '/plans/pln_health_floater')).body;
  const cfg = { ...plan.config, copayBp: 3000 };
  await s.api('PUT', '/admin/plans/pln_health_floater', { token: s.tokens.admin, body: { config: cfg, changeNote: 'Raise copay' } });
  const pols = (await s.api('GET', '/policies', { token: s.tokens.cust1 })).body;
  const floater = pols.find((p) => p.planCode === 'VHC-FAM');
  assert.equal(floater.termsSnapshot.copayBp, 1000);
  assert.equal((await s.api('GET', '/plans/pln_health_floater')).body.version, 2);
  await s.api('PUT', '/admin/plans/pln_health_floater', { token: s.tokens.admin, body: { config: plan.config, changeNote: 'Revert' } });
});

test('claims: Rs.85,500 settlement, waiting periods, exclusions, invalid dates, cashless network rule', async () => {
  const t = s.tokens.cust1;
  const pol = (await s.api('GET', '/policies', { token: t })).body.find((p) => p.product === 'health');
  const seeded = (await s.api('GET', '/health-claims', { token: t })).body[0];
  let c = (await s.api('POST', `/health-claims/${seeded.id}/assess`, { token: s.tokens.claims, body: {} })).body;
  assert.equal(c.assessment.eligibleAmount, R(100000));
  assert.equal(c.assessment.deductible, R(5000));
  assert.equal(c.assessment.copay, R(9500));
  assert.equal(c.assessment.approvedAmount, R(85500));
  c = (await s.api('POST', `/health-claims/${seeded.id}/approve`, { token: s.tokens.claims })).body;
  assert.equal(c.policy.reserved, R(85500));
  assert.equal((await s.api('POST', '/payouts/initiate', { token: s.tokens.claims, body: { claimType: 'health', claimId: seeded.id } })).status, 409, 'payout details must be verified');
  await s.api('POST', `/health-claims/${seeded.id}/verify-payout`, { token: s.tokens.claims });
  const po = (await s.api('POST', '/payouts/initiate', { token: s.tokens.claims, body: { claimType: 'health', claimId: seeded.id } })).body;
  await s.api('POST', '/payouts/callback', { body: { reference: po.reference, status: 'success' } });
  const dup = await s.api('POST', '/payouts/callback', { body: { reference: po.reference, status: 'success' } });
  assert.equal(dup.body.duplicate, true);
  c = (await s.api('GET', `/health-claims/${seeded.id}`, { token: t })).body;
  assert.equal(c.status, 'Settled');
  assert.equal(c.policy.paid, R(85500), 'paid once, not twice');
  assert.equal(c.policy.reserved, 0);

  const base = { policyId: pol.id, memberId: 'mem_asha', type: 'reimbursement', hospitalId: 'hsp_1', requestedAmount: R(50000), payoutDetails: { accountName: 'Asha Verma', accountNumber: '123456789012', ifsc: 'VHCB0001234' } };
  const bad = await s.api('POST', '/health-claims', { token: t, body: { ...base, admissionDate: isoAddDays(today, -5), dischargeDate: isoAddDays(today, -6), diagnosis: 'x', treatment: 'y' } });
  assert.equal(bad.status, 400);
  const diab = (await s.api('POST', '/health-claims', { token: t, body: { ...base, admissionDate: isoAddDays(today, -10), dischargeDate: isoAddDays(today, -8), diagnosis: 'Uncontrolled diabetes', treatment: 'Insulin stabilisation' } })).body;
  const d = (await s.api('POST', `/health-claims/${diab.id}/assess`, { token: s.tokens.claims, body: {} })).body;
  assert.equal(d.assessment.eligible, false);
  assert.match(d.assessment.reasons.join(), /730 days/);
  assert.equal((await s.api('POST', `/health-claims/${diab.id}/approve`, { token: s.tokens.claims })).status, 422);
  assert.equal((await s.api('POST', `/health-claims/${diab.id}/reject`, { token: s.tokens.claims, body: {} })).status, 400, 'rejection needs a reason');
  assert.equal((await s.api('POST', `/health-claims/${diab.id}/reject`, { token: s.tokens.claims, body: { reason: 'Condition waiting period' } })).body.status, 'Rejected');
  const cos = (await s.api('POST', '/health-claims', { token: t, body: { ...base, admissionDate: isoAddDays(today, -12), dischargeDate: isoAddDays(today, -12), diagnosis: 'Nasal reshaping', treatment: 'Cosmetic rhinoplasty' } })).body;
  const ce = (await s.api('POST', `/health-claims/${cos.id}/assess`, { token: s.tokens.claims, body: {} })).body;
  assert.match(ce.assessment.reasons.join(), /Excluded/);

  const nonNet = await s.api('POST', '/health-claims', { token: t, body: { ...base, type: 'cashless', hospitalId: 'hsp_5', admissionDate: isoAddDays(today, 2), dischargeDate: isoAddDays(today, 4), diagnosis: 'Fracture', treatment: 'ORIF' } });
  assert.equal(nonNet.status, 422);
  const cl = (await s.api('POST', '/health-claims', { token: t, body: { ...base, type: 'cashless', hospitalId: 'hsp_1', admissionDate: isoAddDays(today, 2), dischargeDate: isoAddDays(today, 4), diagnosis: 'Fracture', treatment: 'ORIF' } })).body;
  const pre = (await s.api('POST', `/health-claims/${cl.id}/preauth`, { token: s.tokens.claims, body: { decision: 'reject', reason: 'Insufficient information' } })).body;
  assert.equal(pre.status, 'Preauth Rejected');
  const reimb = await s.api('POST', '/health-claims', { token: t, body: { ...base, admissionDate: isoAddDays(today, -2), dischargeDate: isoAddDays(today, -1), diagnosis: 'Fracture', treatment: 'ORIF' } });
  assert.equal(reimb.status, 201, 'cashless refusal does not block reimbursement');
});

test('floater: concurrent family claims cannot exceed the shared balance', async () => {
  const t = s.tokens.cust1;
  const pol = (await s.api('GET', '/policies', { token: t })).body.find((p) => p.product === 'health');
  const avail0 = (await s.api('GET', `/policies/${pol.id}`, { token: t })).body.balance.available;
  const mk = (memberId, days) => s.api('POST', '/health-claims', { token: t, body: { policyId: pol.id, memberId, type: 'reimbursement', hospitalId: 'hsp_2', requestedAmount: R(600000), admissionDate: isoAddDays(today, -days), dischargeDate: isoAddDays(today, -days + 3), diagnosis: 'Cardiac event', treatment: 'Angioplasty', payoutDetails: { accountName: 'Asha Verma', accountNumber: '123456789012', ifsc: 'VHCB0001234' } } });
  const a = (await mk('mem_vikram', 40)).body;
  const b = (await mk('mem_asha', 50)).body;
  await s.api('POST', `/health-claims/${a.id}/assess`, { token: s.tokens.claims, body: {} });
  await s.api('POST', `/health-claims/${b.id}/assess`, { token: s.tokens.claims, body: {} });
  const ra = (await s.api('POST', `/health-claims/${a.id}/approve`, { token: s.tokens.claims })).body;
  const rb = (await s.api('POST', `/health-claims/${b.id}/approve`, { token: s.tokens.claims })).body;
  assert.equal(ra.assessment.approvedAmount, R(535500));
  assert.equal(rb.assessment.approvedAmount, avail0 - R(535500));
  assert.equal(rb.assessment.cappedByCoverage, true);
  assert.equal(rb.policy.available, 0);
});

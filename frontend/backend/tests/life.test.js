import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, LAKH, R, isoAddDays, sessionFrom, yearsAgo } from './helpers.js';

let s, today, start, lifePolicy;
before(async () => {
  s = await startServer();
  today = (await s.api('GET', '/dev/clock')).body.today;
  start = isoAddDays(today, 1);
  lifePolicy = (await s.api('GET', '/policies', { token: s.tokens.cust1 })).body.find((p) => p.product === 'life');
});
after(() => s.close());

const lq = (over = {}) => s.api('POST', '/quotes/life', { body: {
  planId: 'pln_life_term', dob: yearsAgo(start, 25), startDate: start, sumAssured: 50 * LAKH, policyTerm: 20,
  premiumPaymentTerm: 20, frequency: 'annual', tobacco: false, riders: ['ADB'], ...over,
} });

test('life quote: Rs.50 lakh x Rs.1.20 per 1,000 + Rs.1,000 rider = Rs.7,000; monthly via frequency rule', async () => {
  const q = await lq();
  assert.equal(q.status, 200);
  assert.equal(q.body.basePremium, R(6000));
  assert.equal(q.body.annualPremium, R(7000));
  const m = await lq({ frequency: 'monthly' });
  assert.equal(m.body.installmentPremium, R(616)); // 8.8% modal factor, not 1/12
  assert.notEqual(m.body.installmentPremium, Math.round(R(7000) / 12));
});

test('life eligibility: missing rate, payment term > policy term, unsupported term, max end age', async () => {
  assert.equal((await lq({ uwClass: 'preferred' })).status, 422);
  const ppt = await lq({ premiumPaymentTerm: 25 });
  assert.match(ppt.body.details.errors.join(), /cannot exceed/);
  assert.equal((await lq({ premiumPaymentTerm: 7 })).status, 422);
  const endAge = await lq({ dob: yearsAgo(start, 55), policyTerm: 25, premiumPaymentTerm: 25 });
  assert.match(endAge.body.details.errors.join(), /exceeds the maximum of 75/);
  assert.equal((await lq({ dob: yearsAgo(start, 61) })).status, 422);
});

test('nominee validation: totals must be exactly 100%, minors need guardians', async () => {
  const app = (await s.api('POST', '/applications', { token: s.tokens.cust2, body: { planId: 'pln_life_term' } })).body;
  const v = (nominees) => s.api('POST', `/applications/${app.id}/validate-nominees`, { token: s.tokens.cust2, body: { nominees } });
  const adult = (pct) => ({ name: 'A', relationship: 'Spouse', dob: '1980-01-01', phone: '9', sharePct: pct });
  assert.equal((await v([adult(99)])).body.valid, false);
  assert.equal((await v([adult(101)])).body.valid, false);
  assert.equal((await v([adult(60), adult(40)])).body.valid, true);
  const minor = { name: 'Kid', relationship: 'Son', dob: yearsAgo(today, 5), phone: '9', sharePct: 100 };
  const r = (await v([minor])).body;
  assert.equal(r.valid, false);
  assert.match(r.errors.join(), /guardian/);
  assert.equal((await v([{ ...minor, guardian: { name: 'G', relationship: 'Mother', phone: '9' } }])).body.valid, true);
});

test('nominee change: pending change does not replace current until verified; history kept', async () => {
  const t = s.tokens.cust1;
  const bad = await s.api('POST', `/policies/${lifePolicy.id}/nominees`, { token: t, body: { nominees: [{ name: 'X', relationship: 'Brother', dob: '1990-01-01', phone: '1', sharePct: 99 }] } });
  assert.equal(bad.status, 400);
  const req = await s.api('POST', `/policies/${lifePolicy.id}/nominees`, { token: t, body: { nominees: [{ name: 'Vikram Verma', relationship: 'Spouse', dob: '1985-09-03', phone: '1', sharePct: 100 }] } });
  assert.equal(req.status, 202);
  let p = (await s.api('GET', `/policies/${lifePolicy.id}`, { token: t })).body;
  assert.equal(p.currentNominees.nominees.length, 2, 'pending change has not replaced the effective record');
  assert.equal((await s.api('POST', `/policies/${lifePolicy.id}/nominees/verify`, { token: t, body: { otp: '000000' } })).status, 400);
  p = (await s.api('POST', `/policies/${lifePolicy.id}/nominees/verify`, { token: t, body: { otp: req.body.devOtp } })).body;
  assert.equal(p.currentNominees.nominees.length, 1);
  assert.equal(p.nomineeVersions.filter((x) => x.status === 'superseded').length, 1);
  const atStart = (await s.api('GET', `/policies/${lifePolicy.id}/nominees/at?date=${lifePolicy.startDate}`, { token: t })).body;
  assert.equal(atStart.version, 1);
  const logs = await s.api('GET', '/admin/audit-logs?action=NOMINEE_CHANGED', { token: s.tokens.admin });
  assert.equal(logs.body.length, 1);
});

test('premium schedule: grace boundary, lapse, reinstatement, no double collection', async () => {
  const t = s.tokens.cust1;
  let p = (await s.api('GET', `/policies/${lifePolicy.id}`, { token: t })).body;
  const due = p.nextDue;
  await s.setClock({ setDate: due.dueDate });
  assert.equal((await s.api('GET', `/policies/${p.id}`, { token: t })).body.status, 'Active');
  await s.setClock({ setDate: isoAddDays(due.dueDate, 15) });
  assert.equal((await s.api('GET', `/policies/${p.id}`, { token: t })).body.status, 'Grace Period');
  await s.setClock({ setDate: isoAddDays(due.dueDate, 16) });
  p = (await s.api('GET', `/policies/${p.id}`, { token: t })).body;
  assert.equal(p.status, 'Lapsed');
  const blocked = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'installment', policyId: p.id, installmentNo: due.no, amount: due.amount, idempotencyKey: 'x1' } });
  assert.equal(blocked.status, 409);
  const rq = (await s.api('POST', `/policies/${p.id}/reinstatement`, { token: t, body: { goodHealthDeclaration: true } })).body;
  await s.api('POST', `/reinstatements/${rq.id}/decision`, { token: s.tokens.uw, body: { approve: true } });
  const pay = (await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'reinstatement', policyId: p.id, amount: rq.arrears, idempotencyKey: 'r1' } })).body.payment;
  await s.api('POST', `/payments/${pay.reference}/simulate`, { token: t, body: { outcome: 'success' } });
  p = (await s.api('GET', `/policies/${p.id}`, { token: t })).body;
  assert.equal(p.status, 'Active');
  const next = p.nextDue;
  const pi = (await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'installment', policyId: p.id, installmentNo: next.no, amount: next.amount, idempotencyKey: 'i1' } })).body.payment;
  await s.api('POST', `/payments/${pi.reference}/simulate`, { token: t, body: { outcome: 'success' } });
  const twice = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'installment', policyId: p.id, installmentNo: next.no, amount: next.amount, idempotencyKey: 'i2' } });
  assert.equal(twice.status, 409);
  await s.setClock({ reset: true });
});

test('death claim: verified claimant portal, duplicates flagged, two approvals, idempotent payouts', async () => {
  const startBody = { policyNumber: lifePolicy.policyNumber, lifeAssuredName: 'Asha Verma', lifeAssuredDob: '1990-01-01', claimant: { name: 'Vikram Verma', email: 'vikram@example.test', phone: '9000000001', relationship: 'Spouse', idType: 'Passport', idNumber: 'P1234567' } };
  const wrong = await s.api('POST', '/life-claims/portal/start', { body: startBody });
  assert.equal(wrong.status, 400);
  assert.doesNotMatch(wrong.body.error, /VHC-L/);
  const st = (await s.api('POST', '/life-claims/portal/start', { body: { ...startBody, lifeAssuredDob: '1988-04-12' } })).body;
  assert.equal((await s.api('POST', '/life-claims/portal/verify', { body: { accountId: st.accountId, otp: '111111' } })).status, 400);
  const ct = sessionFrom(await s.api('POST', '/life-claims/portal/verify', { body: { accountId: st.accountId, otp: st.devOtp } }));
  assert.equal((await s.api('GET', `/policies/${lifePolicy.id}`, { token: ct })).status, 404, 'claimant cannot browse the policy record');
  assert.equal((await s.api('POST', '/life-claims', { token: ct, body: { dateOfDeath: isoAddDays(today, 1), causeOfDeath: 'x' } })).status, 400);
  const claim = (await s.api('POST', '/life-claims', { token: ct, body: { dateOfDeath: isoAddDays(today, -1), causeOfDeath: 'Cardiac arrest', causeType: 'natural' } })).body;
  assert.equal(claim.status, 'Reported');
  const pol = (await s.api('GET', `/policies/${lifePolicy.id}`, { token: s.tokens.cust1 })).body;
  assert.notEqual(pol.status, 'Terminated', 'reporting a claim does not change policy status');
  const dup = (await s.api('POST', '/life-claims', { token: ct, body: { dateOfDeath: isoAddDays(today, -1), causeOfDeath: 'Cardiac arrest' } })).body;
  const dupStaff = (await s.api('GET', `/life-claims/${dup.id}`, { token: s.tokens.claims })).body;
  assert.equal(dupStaff.flags.duplicateOf[0], claim.claimNumber);

  const o1 = s.tokens.claims, o2 = s.tokens.claims2;
  let c = (await s.api('POST', `/life-claims/${claim.id}/start-review`, { token: o1 })).body;
  assert.equal(c.analysis.policyStatusAtDeath, 'Active');
  assert.equal((await s.api('POST', `/life-claims/${claim.id}/assess`, { token: o1, body: { approvedAmount: 1, allocations: [] } })).status, 409, 'claimant must be verified');
  await s.api('POST', `/life-claims/${claim.id}/verify-claimant`, { token: o1 });
  const acct = { accountName: 'X', accountNumber: '123456789012', ifsc: 'VHCB0001234' };
  c = (await s.api('PUT', `/life-claims/${claim.id}/beneficiaries`, { token: o1, body: { beneficiaries: [{ name: 'Vikram Verma', relationship: 'Spouse', verified: true, payoutDetails: acct }, { name: 'Diya Verma (guardian: Vikram)', relationship: 'Daughter', verified: true, payoutDetails: acct }] } })).body;
  const [b1, b2] = c.beneficiaries;
  const total = c.analysis.suggestedBenefit;
  assert.equal(total, 50 * LAKH);
  const mismatch = await s.api('POST', `/life-claims/${claim.id}/assess`, { token: o1, body: { approvedAmount: total, allocations: [{ beneficiaryId: b1.id, amount: total * 0.6 }, { beneficiaryId: b2.id, amount: total * 0.3 }] } });
  assert.equal(mismatch.status, 400);
  c = (await s.api('POST', `/life-claims/${claim.id}/assess`, { token: o1, body: { approvedAmount: total, allocations: [{ beneficiaryId: b1.id, amount: total * 0.6 }, { beneficiaryId: b2.id, amount: total * 0.4 }] } })).body;
  assert.equal(c.status, 'Pending Second Approval');
  assert.equal((await s.api('POST', '/payouts/initiate', { token: o1, body: { claimType: 'life', claimId: claim.id, beneficiaryId: b1.id } })).status, 409, 'no payout before second approval');
  assert.equal((await s.api('POST', `/life-claims/${claim.id}/second-approval`, { token: o1 })).status, 403);
  c = (await s.api('POST', `/life-claims/${claim.id}/second-approval`, { token: o2 })).body;
  assert.equal(c.status, 'Approved');

  for (const b of [b1, b2]) {
    const po = (await s.api('POST', '/payouts/initiate', { token: o1, body: { claimType: 'life', claimId: claim.id, beneficiaryId: b.id } })).body;
    await s.api('POST', '/payouts/callback', { body: { reference: po.reference, status: 'success' } });
    const again = await s.api('POST', '/payouts/callback', { body: { reference: po.reference, status: 'success' } });
    assert.equal(again.body.duplicate, true);
  }
  c = (await s.api('GET', `/life-claims/${claim.id}`, { token: o1 })).body;
  assert.equal(c.status, 'Settled');
  assert.equal(c.payouts.filter((p) => p.status === 'success').length, 2);
  const after = (await s.api('GET', `/policies/${lifePolicy.id}`, { token: s.tokens.cust1 })).body;
  assert.equal(after.status, 'Terminated');

  await s.api('POST', `/life-claims/${dup.id}/start-review`, { token: o1 });
  await s.api('POST', `/life-claims/${dup.id}/verify-claimant`, { token: o1 });
  await s.api('POST', `/life-claims/${dup.id}/clear-flag`, { token: o1, body: { note: 'Reviewed' } });
  const second = await s.api('POST', `/life-claims/${dup.id}/assess`, { token: o1, body: { approvedAmount: 1, allocations: [] } });
  assert.equal(second.status, 409, 'death benefit cannot be paid twice');
  assert.equal((await s.api('POST', `/life-claims/${dup.id}/reject`, { token: o1, body: {} })).status, 400);
  assert.equal((await s.api('POST', `/life-claims/${dup.id}/reject`, { token: o1, body: { reason: 'Duplicate of settled claim' } })).body.status, 'Rejected');

  const rep = (await s.api('GET', '/reports/summary', { token: s.tokens.admin })).body;
  assert.equal(rep.reconciliation.balanced, true);
  assert.equal(rep.reconciliation.premiumsCollected, rep.reconciliation.premiumsApplied);
});

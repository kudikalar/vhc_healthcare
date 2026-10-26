// Network module: provider registry, cashless networks (insurer × hospital × product × dates), contracts,
// hospital portal isolation, health-services bookings, TPA portal and read-only oversight.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { isoAddDays, startServer } from './helpers.js';

const { db, tx } = await import('../src/db.js');

let s, today;
before(async () => {
  s = await startServer();
  today = (await s.api('GET', '/dev/clock')).body.today;
  // A second synthetic insurer, to prove cashless is insurer-specific.
  tx(() => db.insert('insurers', { id: 'ins_test_2', name: 'Second Sandbox Insurer (Synthetic)', status: 'Active', publishable: true, sandbox: true }));
});
after(async () => { await s?.close(); });

const N = '/network';
const dir = (q) => s.api('GET', `${N}/directory?${new URLSearchParams(q)}`);
const find = (res, id) => res.body.providers.find((p) => p.id === id);

async function bookableSlot(serviceId, from = 1) {
  for (let d = from; d < from + 10; d++) {
    const date = isoAddDays(today, d);
    const r = await s.api('GET', `${N}/services/${serviceId}/slots?date=${date}`);
    const slot = r.body.slots.find((x) => x.available);
    if (slot) return { date, slot: slot.time };
  }
  throw new Error('no slot');
}

test('directory: cashless depends on insurer and product; restricted and expired records are not cashless', async () => {
  const ind = await dir({ insurerId: 'ins_sandbox', planId: 'pln_health_individual' });
  assert.equal(ind.status, 200);
  assert.match(ind.body.disclaimer, /does not guarantee cashless approval/);
  assert.equal(find(ind, 'hsp_3').cashless.eligible, true);
  assert.match(find(ind, 'hsp_3').cashless.label, /Cashless with VHC Sandbox Insurer \(Synthetic\) for .* last verified \d{4}-\d{2}-\d{2}/);

  const senior = await dir({ planId: 'pln_health_senior' });
  assert.equal(find(senior, 'hsp_3').cashless.eligible, false);
  assert.equal(find(senior, 'hsp_3').cashless.status, 'restricted');
  const seniorCashless = await dir({ planId: 'pln_health_senior', cashless: 'true' });
  assert.ok(!find(seniorCashless, 'hsp_3'), 'restricted hospital is filtered out of cashless search');
  assert.ok(find(seniorCashless, 'hsp_1'));

  // Product-level network: Riverbank (hsp_5) is cashless only for the individual plan.
  assert.equal(find(ind, 'hsp_5').cashless.eligible, true);
  assert.equal(find(await dir({ planId: 'pln_health_floater' }), 'hsp_5').cashless.eligible, false);
  assert.equal(find(await dir({ insurerId: 'ins_sandbox' }), 'hsp_5').cashless.status, 'not_in_network', 'no all-products record');

  // Another insurer: a general VHC contract / sandbox network never implies cashless with it.
  const other = await dir({ insurerId: 'ins_test_2' });
  assert.equal(find(other, 'hsp_3').cashless.eligible, false);
  assert.equal(find(other, 'hsp_1').cashless.eligible, false, 'hsp_1 has an active VHC contract but no network with this insurer');
  const add = await s.api('POST', `${N}/networks`, { token: s.tokens.ops, body: { insurerId: 'ins_test_2', hospitalId: 'hsp_2', scope: 'all_products', status: 'active', effectiveFrom: isoAddDays(today, -10), verificationSource: 'Test network file' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const other2 = await dir({ insurerId: 'ins_test_2', cashless: 'true' });
  assert.deepEqual(other2.body.providers.map((p) => p.id), ['hsp_2']);
  assert.equal(find(await dir({ insurerId: 'ins_sandbox', planId: 'pln_health_individual' }), 'hsp_2').cashless.eligible, true);

  // Expired record: not cashless today, but was cashless on a date inside its validity.
  const exp = await s.api('POST', `${N}/networks`, { token: s.tokens.admin, body: { insurerId: 'ins_test_2', hospitalId: 'hsp_4', status: 'active', effectiveFrom: isoAddDays(today, -100), effectiveTo: isoAddDays(today, -1), verificationSource: 'Test' } });
  assert.equal(exp.status, 201);
  const nowRes = find(await dir({ insurerId: 'ins_test_2' }), 'hsp_4').cashless;
  assert.equal(nowRes.eligible, false);
  assert.equal(nowRes.expired, true);
  assert.equal(find(await dir({ insurerId: 'ins_test_2', date: isoAddDays(today, -10) }), 'hsp_4').cashless.eligible, true);
  // Seeded expired sandbox record (Coastal City).
  assert.equal(find(ind, 'hsp_7').cashless.eligible, false);

  // Candidate (prospect) insurers are never named publicly.
  assert.equal((await dir({ insurerId: 'ins_candidate_1' })).status, 404);
  // Candidate insurers cannot get network records.
  assert.equal((await s.api('POST', `${N}/networks`, { token: s.tokens.admin, body: { insurerId: 'ins_candidate_1', hospitalId: 'hsp_2', status: 'active', effectiveFrom: today } })).status, 422);
});

test('directory never returns candidate prospects; the registry labels them for admins', async () => {
  const all = await dir({});
  assert.ok(all.body.providers.length >= 6);
  assert.ok(all.body.providers.every((p) => !p.id.startsWith('hsp_candidate')));
  for (const name of ['Apollo', 'Fortis', 'Max Healthcare', 'Manipal', 'Aster', 'Yashoda', 'KIMS']) {
    assert.ok(!JSON.stringify(all.body).includes(name), `${name} must not appear publicly`);
    assert.ok(!JSON.stringify((await s.api('GET', '/hospitals?includeInactive=true')).body).includes(name));
    assert.ok(!JSON.stringify((await s.api('GET', `${N}/directory/meta`)).body).includes(name));
  }
  assert.equal((await s.api('GET', `${N}/providers/hsp_candidate_1`)).status, 404);
  assert.equal((await s.api('GET', '/hospitals/hsp_candidate_1')).status, 404);
  assert.ok(!(await s.api('GET', `${N}/services`)).body.services.some((x) => x.hospitalId.startsWith('hsp_candidate')));

  const reg = await s.api('GET', `${N}/registry?candidate=true`, { token: s.tokens.admin });
  assert.equal(reg.body.providers.length, 7);
  assert.ok(reg.body.providers.every((p) => p.candidateLabel === 'Candidate — not a VHC partner' && p.stage === 'Prospect'));
  // Candidates cannot be activated and accreditation is only public when verified.
  const pub = (await s.api('GET', `${N}/providers/hsp_2`)).body;
  assert.equal(pub.accreditations.length, 0, 'NABH claimed but unverified is not shown');
  assert.equal((await s.api('GET', `${N}/providers/hsp_1`)).body.accreditations[0].body, 'NABH');
  assert.match(pub.directionsUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  assert.equal(pub.bedCapacity, null, 'unverified bed capacity is not shown');
});

test('provider onboarding gates: credentials must be verified before contracting', async () => {
  const st = (body) => s.api('POST', `${N}/registry/prv_prospect_1/stage`, { token: s.tokens.ops, body });
  const blocked = await st({ stage: 'Contracting' });
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.details.gaps.includes('Registration verified'));
  await s.api('POST', `${N}/registry/prv_prospect_1/verify`, { token: s.tokens.ops, body: { target: 'registration', source: 'Registry lookup #1' } });
  await s.api('POST', `${N}/registry/prv_prospect_1/verify`, { token: s.tokens.ops, body: { target: 'licence:0', source: 'Licence copy check' } });
  assert.equal((await st({ stage: 'Contracting' })).status, 200);
  const act = await st({ stage: 'Active' });
  assert.equal(act.status, 422, 'activation needs a contract in effect');
  assert.ok(act.body.details.gaps.includes('An approved provider contract in effect'));
  assert.equal((await s.api('POST', `${N}/registry/hsp_candidate_1/stage`, { token: s.tokens.admin, body: { stage: 'Terminated' } })).status, 400, 'reason required');
});

test('contracts: drafted by operations, approval needs an administrator; activation publishes the event once', async () => {
  const body = { hospitalId: 'hsp_4', effectiveFrom: today, effectiveTo: isoAddDays(today, 364), serviceScope: ['Bookings', 'Health checks'], packageRates: [{ name: 'Maternity package (synthetic)', amount: 4500000 }] };
  const c = (await s.api('POST', `${N}/contracts`, { token: s.tokens.ops, body })).body;
  assert.equal(c.status, 'draft');
  assert.equal((await s.api('POST', `${N}/contracts`, { token: s.tokens.auditor, body })).status, 403);
  assert.equal((await s.api('POST', `${N}/contracts/${c.id}/submit`, { token: s.tokens.ops })).body.status, 'pending_approval');
  assert.equal((await s.api('POST', `${N}/contracts/${c.id}/approve`, { token: s.tokens.ops })).status, 403);
  assert.equal((await s.api('POST', `${N}/contracts/${c.id}/approve`, { token: s.tokens.compliance })).status, 403);
  const ok = await s.api('POST', `${N}/contracts/${c.id}/approve`, { token: s.tokens.admin });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'active');
  assert.equal(db.find('events', (e) => e.type === 'HOSPITAL_CONTRACT_ACTIVATED' && e.payload.contractId === c.id).length, 1);

  // Maker-checker: the administrator who submitted cannot approve their own contract.
  const own = (await s.api('POST', `${N}/contracts`, { token: s.tokens.admin, body: { ...body, hospitalId: 'hsp_6' } })).body;
  await s.api('POST', `${N}/contracts/${own.id}/submit`, { token: s.tokens.admin });
  assert.equal((await s.api('POST', `${N}/contracts/${own.id}/approve`, { token: s.tokens.admin })).status, 409);
  assert.equal((await s.api('POST', `${N}/contracts/${own.id}/approve`, { token: s.tokens.superadmin })).status, 200);

  // Versioned amendment, approved by an admin.
  const am = await s.api('POST', `${N}/contracts/${c.id}/amendments`, { token: s.tokens.ops, body: { changes: { packageRates: [{ name: 'Maternity package (synthetic)', amount: 4700000 }] }, note: 'Annual revision' } });
  assert.equal(am.status, 200);
  const dec = await s.api('POST', `${N}/contracts/${c.id}/amendments/2/decision`, { token: s.tokens.admin, body: { decision: 'approve' } });
  assert.equal(dec.body.version, 2);
  assert.equal(dec.body.packageRates[0].amount, 4700000);
  assert.equal(dec.body.versions.length, 2);
  // A VHC contract never makes the hospital cashless for an insurer it has no network with.
  assert.equal(find(await dir({ insurerId: 'ins_test_2' }), 'hsp_4').cashless.eligible, false);
  const expiring = (await s.api('GET', `${N}/contracts/expiring?days=60`, { token: s.tokens.auditor })).body;
  assert.ok(expiring.some((x) => x.id === 'hct_demo_hsp8'));
});

test('hospital portal: own hospital only (404 otherwise); staff cannot edit; verified fields return to pending', async () => {
  const h = s.tokens.hospital;
  assert.equal((await s.api('GET', `${N}/hospital-portal/hsp_1`, { token: h })).status, 200);
  for (const path of ['', '/claims', '/bookings', '/contracts', '/reports', '/staff']) {
    assert.equal((await s.api('GET', `${N}/hospital-portal/hsp_8${path}`, { token: h })).status, 404, path);
  }
  const arjunBooking = db.findOne('healthBookings', (b) => b.userId === 'usr_arjun');
  assert.equal(arjunBooking.hospitalId, 'hsp_8');
  assert.equal((await s.api('GET', `${N}/bookings/${arjunBooking.id}`, { token: h })).status, 404);
  assert.equal((await s.api('POST', `${N}/hospital-portal/hsp_8/bookings/${arjunBooking.id}/cancel`, { token: h, body: { reason: 'x' } })).status, 404);

  const claims = (await s.api('GET', `${N}/hospital-portal/hsp_1/claims`, { token: h })).body.claims;
  assert.ok(claims.every((c) => c.diagnosis === undefined && c.memberFirstName));

  // Verified bed capacity reverts to pending verification when the hospital changes it.
  const upd = await s.api('PUT', `${N}/hospital-portal/hsp_1/profile`, { token: h, body: { bedCapacity: { total: 240 }, insuranceDesk: { name: 'Desk', phone: '044-1', email: 'd@hospital.test', hours: '24x7' } } });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.body.resetToPending, ['bedCapacity']);
  assert.equal(upd.body.bedCapacity.verified, false);
  assert.equal((await s.api('GET', `${N}/providers/hsp_1`)).body.bedCapacity, null);

  // Hospital admin invites staff for their own hospital only.
  assert.equal((await s.api('POST', `${N}/hospital-portal/hsp_2/staff`, { token: h, body: { firstName: 'X', email: 'x@hospital.test' } })).status, 404);
  assert.equal((await s.api('POST', `${N}/hospital-portal/hsp_1/staff`, { token: h, body: { firstName: 'X', email: 'x2@hospital.test', role: 'hospital_admin' } })).status, 422);
  const inv = await s.api('POST', `${N}/hospital-portal/hsp_1/staff`, { token: h, body: { firstName: 'Lata', lastName: 'Desk', email: 'lata.desk@hospital.test' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.user.role, 'hospital_staff');
  await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.devInviteToken, password: 'hospital desk pass 1', confirmPassword: 'hospital desk pass 1' } });
  const staff = await s.login('lata.desk@hospital.test', 'hospital desk pass 1');
  assert.equal((await s.api('GET', `${N}/hospital-portal/hsp_1/bookings`, { token: staff })).status, 200);
  assert.equal((await s.api('PUT', `${N}/hospital-portal/hsp_1/profile`, { token: staff, body: { phone: '044-2' } })).status, 403);
  assert.equal((await s.api('POST', `${N}/hospital-portal/hsp_1/services`, { token: staff, body: { category: 'follow_up', name: 'x', price: 100 } })).status, 403);
  assert.equal((await s.api('POST', `${N}/hospital-portal/hsp_1/contracts/hct_demo_hsp1/complaints`, { token: staff, body: { summary: 'x' } })).status, 403);
  assert.equal((await s.api('GET', `${N}/hospital-portal/hsp_2/claims`, { token: staff })).status, 404);
  assert.equal((await s.api('POST', `${N}/contracts/hct_demo_hsp1/approve`, { token: h })).status, 403);
});

test('bookings disclose payer type, post the booking fee once, and insured-cashless needs a network match', async () => {
  const t = s.tokens.arjun;
  const cat = (await s.api('GET', `${N}/services`)).body;
  assert.match(cat.coverageNote, /not automatically covered by insurance/);
  const svc = cat.services.find((x) => x.id === 'svc_hsp_1_hc');
  assert.ok(svc.payerOptions.some((o) => o.type === 'discounted' && o.disclosure));
  const { date, slot } = await bookableSlot(svc.id);
  const bk = await s.api('POST', `${N}/bookings`, { token: t, body: { serviceId: svc.id, date, slot, payerType: 'discounted' } });
  assert.equal(bk.status, 201, JSON.stringify(bk.body));
  assert.equal(bk.body.payerType, 'discounted');
  assert.match(bk.body.payerDisclosure, /not billed to insurance/);
  assert.match(bk.body.coverageNote, /not automatically covered by insurance/);
  assert.equal(bk.body.amountPayableAtProvider, svc.discountedPrice);
  assert.equal(bk.body.status, 'pending_payment');
  const p1 = await s.api('POST', `${N}/bookings/${bk.body.id}/pay`, { token: t });
  const p2 = await s.api('POST', `${N}/bookings/${bk.body.id}/pay`, { token: t });
  assert.equal(p1.body.status, 'confirmed');
  assert.equal(p2.status, 200);
  const fees = db.find('ledgerEntries', (e) => e.refId === bk.body.id && e.ledger === 'healthcare_booking_fee');
  assert.equal(fees.length, 1);
  assert.equal(fees[0].amount, 4900);
  assert.equal(fees[0].mode, 'test');
  // Other customers cannot see or change it.
  assert.equal((await s.api('POST', `${N}/bookings/${bk.body.id}/cancel`, { token: s.tokens.cust1 })).status, 404);
  // Hospital sees it and can complete it only on/after the date; rescheduling works for the customer.
  assert.ok((await s.api('GET', `${N}/hospital-portal/hsp_1/bookings`, { token: s.tokens.hospital })).body.some((b) => b.id === bk.body.id));
  assert.equal((await s.api('POST', `${N}/hospital-portal/hsp_1/bookings/${bk.body.id}/complete`, { token: s.tokens.hospital })).status, 409);
  const next = await bookableSlot(svc.id, 2);
  const rs = await s.api('POST', `${N}/bookings/${bk.body.id}/reschedule`, { token: t, body: next });
  assert.equal(rs.status, 200);
  assert.equal(rs.body.date, next.date);

  // Insured-cashless: no policy → 404; Asha's floater is cashless at hsp_1 (sandbox insurer network).
  assert.equal((await s.api('POST', `${N}/bookings`, { token: t, body: { serviceId: 'svc_hsp_1_cons', ...(await bookableSlot('svc_hsp_1_cons')), payerType: 'insured_cashless', policyId: 'nope' } })).status, 404);
  const asha = s.tokens.cust1;
  const pol = db.findOne('policies', (p) => p.userId === 'usr_cust1' && p.product === 'health');
  const ins = await s.api('POST', `${N}/bookings`, { token: asha, body: { serviceId: 'svc_hsp_1_cons', ...(await bookableSlot('svc_hsp_1_cons')), payerType: 'insured_cashless', policyId: pol.id } });
  assert.equal(ins.status, 201, JSON.stringify(ins.body));
  assert.equal(ins.body.payerType, 'insured_cashless');
  assert.match(ins.body.network.label, /Cashless with/);
  assert.equal(ins.body.amountPayableAtProvider, null);
  // Telehealth provider has no network record → insured-cashless refused.
  const tele = await s.api('POST', `${N}/bookings`, { token: asha, body: { serviceId: 'svc_prv_tele_1_tele', ...(await bookableSlot('svc_prv_tele_1_tele')), payerType: 'insured_cashless', policyId: pol.id } });
  assert.equal(tele.status, 422);
  // Employer sponsorship requires eligibility: Meera is not an employee of the sponsoring employer…
  const sp = await s.api('POST', `${N}/bookings`, { token: s.tokens.meera, body: { serviceId: 'svc_hsp_8_hc', ...(await bookableSlot('svc_hsp_8_hc', 3)), payerType: 'employer_sponsored' } });
  assert.equal(sp.status, 422);
  // …while Arjun is on the Northwind roster (corporate module) once his membership is linked.
  db.find('groupMembers', (m) => m.emailLower === 'customer_arjun@vhc.test').forEach((m) => { m.userId ||= 'usr_arjun'; });
  const ok = await s.api('POST', `${N}/bookings`, { token: t, body: { serviceId: 'svc_hsp_8_hc', ...(await bookableSlot('svc_hsp_8_hc', 4)), payerType: 'employer_sponsored' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.employerId, 'emp_demo');
  // Customer cancellation well ahead refunds the fee exactly once.
  await s.api('POST', `${N}/bookings/${bk.body.id}/cancel`, { token: t, body: { reason: 'Plans changed' } });
  assert.equal((await s.api('POST', `${N}/bookings/${bk.body.id}/cancel`, { token: t })).status, 409);
  assert.equal(db.find('ledgerEntries', (e) => e.refId === bk.body.id).length, 2);
});

test('TPA sees only claims of insurers it administers and can only recommend', async () => {
  // A claim on a policy of an insurer the TPA does not administer.
  const other = tx(() => {
    const base = db.findOne('policies', (p) => p.userId === 'usr_meera');
    const pol = db.insert('policies', { ...structuredClone(base), id: 'pol_other_ins', policyNumber: 'SBX-OTHER-1', insurerId: 'ins_test_2' });
    return db.insert('healthClaims', { claimNumber: 'HC-OTHER-000001', userId: 'usr_meera', policyId: pol.id, policyNumber: pol.policyNumber, memberId: 'mem_meera', memberName: 'Meera Reddy', type: 'reimbursement', hospitalId: 'hsp_8', hospitalName: 'Meadow Heart Institute', admissionDate: today, dischargeDate: today, diagnosis: 'x', treatment: 'y', requestedAmount: 100000, status: 'Submitted', documentRequests: [], internalNotes: [], timeline: [] });
  });
  const tp = s.tokens.tpa;
  const list = (await s.api('GET', `${N}/tpa-portal/tpa_sandbox/claims`, { token: tp })).body.claims;
  assert.ok(list.some((c) => c.claimNumber === 'HC-SEED-000001'));
  assert.ok(!list.some((c) => c.id === other.id));
  assert.equal((await s.api('GET', `${N}/tpa-portal/tpa_sandbox/claims/${other.id}`, { token: tp })).status, 404);
  assert.equal((await s.api('GET', `${N}/tpa-portal/tpa_other/claims`, { token: tp })).status, 404);

  const seed = list.find((c) => c.claimNumber === 'HC-SEED-000001');
  const rec = await s.api('POST', `${N}/tpa-portal/tpa_sandbox/claims/${seed.id}/recommendation`, { token: tp, body: { recommendation: 'recommend_partial', amount: 5000000, reason: 'Room rent above eligibility' } });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.review.recommendations[0].final, false);
  assert.equal(rec.body.status, 'Submitted', 'a recommendation never changes the claim status');
  assert.equal((await s.api('POST', `${N}/tpa-portal/tpa_sandbox/claims/${seed.id}/notes`, { token: tp, body: { note: 'Called hospital desk' } })).status, 200);
  assert.equal((await s.api('POST', `${N}/tpa-portal/tpa_sandbox/claims/${seed.id}/document-requests`, { token: tp, body: { documents: ['Discharge summary', 'Itemised bill'] } })).status, 200);
  for (const action of ['approve', 'reject', 'assess', 'preauth']) {
    assert.equal((await s.api('POST', `/health-claims/${seed.id}/${action}`, { token: tp, body: { reason: 'x', decision: 'approve', amount: 100 } })).status, 403, action);
  }
  assert.equal((await s.api('GET', `${N}/claims/${seed.id}/tpa-reviews`, { token: s.tokens.claims })).body.length, 1);
  const rep = (await s.api('GET', `${N}/tpa-portal/tpa_sandbox/reports/turnaround`, { token: tp })).body;
  assert.ok(rep.totalClaims >= 1 && rep.recommended === 1);

  // Ending the insurer relationship removes access.
  await s.api('POST', `${N}/tpas/tpa_sandbox/relationships/rel_1/end`, { token: s.tokens.admin, body: { reason: 'Test end' } });
  assert.equal((await s.api('GET', `${N}/tpa-portal/tpa_sandbox/claims`, { token: tp })).body.claims.length, 0);
  await s.api('POST', `${N}/tpas/tpa_sandbox/relationships`, { token: s.tokens.admin, body: { insurerId: 'ins_sandbox', from: today } });
  assert.ok((await s.api('GET', `${N}/tpa-portal/tpa_sandbox/claims`, { token: tp })).body.claims.length >= 1);
});

test('auditor and compliance are read-only; legacy network flag stays in sync', async () => {
  for (const t of [s.tokens.auditor, s.tokens.compliance]) {
    for (const p of ['/registry', '/registry/hsp_1', '/contracts', '/networks', '/tpas', '/bookings', '/analytics', '/hospital-portal/hsp_1', '/tpa-portal/tpa_sandbox/claims']) {
      assert.equal((await s.api('GET', `${N}${p}`, { token: t })).status, 200, p);
    }
    assert.equal((await s.api('PUT', `${N}/registry/hsp_1`, { token: t, body: { phone: '1' } })).status, 403);
    assert.equal((await s.api('POST', `${N}/registry/hsp_1/stage`, { token: t, body: { stage: 'Suspended', note: 'x' } })).status, 403);
    assert.equal((await s.api('POST', `${N}/networks`, { token: t, body: {} })).status, 403);
    assert.equal((await s.api('PUT', `${N}/tpas/tpa_sandbox`, { token: t, body: {} })).status, 403);
    assert.equal((await s.api('PUT', `${N}/hospital-portal/hsp_1/profile`, { token: t, body: { phone: '1' } })).status, 403);
    const c = db.findOne('healthClaims', (x) => x.claimNumber === 'HC-SEED-000001');
    assert.equal((await s.api('POST', `${N}/tpa-portal/tpa_sandbox/claims/${c.id}/notes`, { token: t, body: { note: 'x' } })).status, 403);
  }
  const an = (await s.api('GET', `${N}/analytics`, { token: s.tokens.auditor })).body;
  assert.ok(an.providers.find((p) => p.id === 'hsp_1').contract.status === 'active');
  assert.ok(!an.providers.some((p) => p.id.startsWith('hsp_candidate')));

  // Admin clears the legacy network flag → sandbox network record restricted, directory and claims agree.
  const h = (await s.api('GET', '/hospitals/hsp_6')).body;
  assert.equal(h.network, true);
  await s.api('PUT', '/hospitals/hsp_6', { token: s.tokens.admin, body: { ...h, network: false } });
  assert.equal((await s.api('GET', '/hospitals/hsp_6')).body.network, false);
  assert.equal(find(await dir({ insurerId: 'ins_sandbox' }), 'hsp_6').cashless.status, 'restricted');
  await s.api('PUT', '/hospitals/hsp_6', { token: s.tokens.admin, body: { ...h, network: true } });
  assert.equal(find(await dir({ insurerId: 'ins_sandbox' }), 'hsp_6').cashless.eligible, true);
  const legacy = (await s.api('GET', '/hospitals?network=network')).body;
  assert.ok(legacy.disclaimer && legacy.hospitals.some((x) => x.id === 'hsp_1'));
});

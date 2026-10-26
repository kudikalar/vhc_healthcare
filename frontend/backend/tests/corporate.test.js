// Corporate module: employer onboarding, roster import, group enrolment with sandbox insurer
// confirmation, certificates, tenant isolation, HR privacy, employee self-service, endorsements,
// billing ledger idempotency and read-only oversight.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { isoAddDays, startServer } from './helpers.js';
import { db } from '../src/db.js';
import { proRata } from '../src/services/corporateProduct.js';

const LAKH = 10000000;
const PW = 'Northwind-Test#2026x';
let s;
let empB; // second employer created in the tests
let hrB; // corporate_hr session for employer B
let policyB;

const today = () => new Date().toISOString().slice(0, 10); // this file never moves the test clock
const csv = (rows) => ['employeeId,name,email,dob,gender,grade,joiningDate', ...rows].join('\n');

before(async () => {
  s = await startServer();
  s.tokens.kabir = await s.login('corporate_kabir');
});
after(async () => { await s?.close(); });

async function setupEmployerB() {
  const { api, tokens } = s;
  const created = await api('POST', '/corporate/employers', { token: tokens.ops, body: {
    name: 'Bluefin Synthetic Analytics Pvt Ltd', entityType: 'Private Limited', gstin: '29ABCDE1234F1Z5', employeeCount: 40, locations: 'Bengaluru, Mysuru',
    billing: { email: 'ap@bluefin-demo.test', contactName: 'AP', state: 'Karnataka', postalCode: '560001' }, hrContact: { name: 'HR Bluefin', email: 'hr@bluefin-demo.test' },
    contractValidity: { from: isoAddDays(today(), -200), to: isoAddDays(today(), 400) }, accountOwnerId: 'usr_sales',
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, 'Prospect');
  const id = created.body.id;
  const skip = await api('POST', `/corporate/employers/${id}/status`, { token: tokens.ops, body: { status: 'Active' } });
  assert.equal(skip.status, 409, 'pipeline cannot skip stages');
  assert.equal((await api('POST', `/corporate/employers/${id}/status`, { token: tokens.ops, body: { status: 'Proposal' } })).status, 200);
  const contract = await api('POST', `/corporate/employers/${id}/contracts`, { token: tokens.ops, body: { startDate: isoAddDays(today(), -200), endDate: isoAddDays(today(), 400), services: ['group_health', 'wellness'], serviceFeePerMemberMonth: 3000, signed: true } });
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  assert.equal((await api('POST', `/corporate/employers/${id}/status`, { token: tokens.ops, body: { status: 'Contracted' } })).status, 200);
  const act = await api('POST', `/corporate/employers/${id}/status`, { token: tokens.ops, body: { status: 'Active' } });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.deepEqual(act.body.statusHistory.map((h) => h.status), ['Prospect', 'Proposal', 'Contracted', 'Active']);

  // Admin invites an HR user for employer B; the invitee accepts and signs in.
  const inv = await api('POST', `/corporate/employers/${id}/users`, { token: tokens.admin, body: { firstName: 'Bina', lastName: 'Shetty', email: 'bina.hr@bluefin-demo.test', role: 'corporate_hr' } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.user.status, 'Invited');
  assert.equal(inv.body.user.orgId, id);
  const acc = await api('POST', '/auth/accept-invite', { body: { token: inv.body.devInviteToken, password: PW, confirmPassword: PW } });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  hrB = await s.login('bina.hr@bluefin-demo.test', PW);

  const pol = await api('POST', '/corporate/group-policies', { token: tokens.ops, body: { employerId: id, sumInsured: 5 * LAKH, familyDefinition: 'ESC', startDate: isoAddDays(today(), -100), enrolmentWindow: { opensOn: isoAddDays(today(), -110), closesOn: isoAddDays(today(), 10) } } });
  assert.equal(pol.status, 201, JSON.stringify(pol.body));
  assert.equal(pol.body.status, 'Active', 'auto mode: sandbox insurer confirms the master policy');
  assert.equal(pol.body.insurerId, 'ins_sandbox');
  empB = created.body;
  policyB = pol.body;
}

test('employer onboarding: GSTIN validation, pipeline with audit, invites scoped to the employer', async () => {
  const { api, tokens } = s;
  const badGst = await api('POST', '/corporate/employers', { token: tokens.admin, body: { name: 'Bad GST Demo Ltd', gstin: '29ABCDE1234F1X5' } });
  assert.equal(badGst.status, 422);
  assert.ok(badGst.body.details.fields.gstin);
  const badOwner = await api('POST', '/corporate/employers', { token: tokens.admin, body: { name: 'Owner Demo Ltd', accountOwnerId: 'usr_cust1' } });
  assert.equal(badOwner.status, 422, 'account owner must be a sales user');
  await setupEmployerB();
  assert.ok(db.find('auditLogs', (a) => a.action === 'EMPLOYER_STATUS_CHANGED' && a.entityId === empB.id).length >= 3);

  // corporate_admin may invite HR for their own employer only.
  const own = await api('POST', '/corporate/employers/emp_demo/users', { token: tokens.kabir, body: { firstName: 'Hari', lastName: 'Rao', email: 'hari.hr@northwind-demo.test', role: 'corporate_hr' } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal((await api('POST', '/corporate/employers/emp_demo/users', { token: tokens.kabir, body: { firstName: 'Ana', lastName: 'Das', email: 'ana.admin@northwind-demo.test', role: 'corporate_admin' } })).status, 403);
  assert.equal((await api('POST', `/corporate/employers/${empB.id}/users`, { token: tokens.kabir, body: { firstName: 'X', lastName: 'Y', email: 'x.y@bluefin-demo.test', role: 'corporate_hr' } })).status, 404);
  assert.equal((await api('POST', '/corporate/employers/emp_demo/users', { token: tokens.sana, body: { firstName: 'Q', lastName: 'R', email: 'q.r@northwind-demo.test', role: 'corporate_hr' } })).status, 403, 'HR cannot manage users');
});

test('CSV roster import validates columns and rows and reports row errors', async () => {
  const { api } = s;
  const missing = await api('POST', '/corporate/members/import', { token: hrB, body: { csv: 'employeeId,name,email\nB-1,Asha K,asha@b.test' } });
  assert.equal(missing.status, 422);
  assert.match(missing.body.error, /dob/);

  const rows = [
    'B-001,Kavya Nair,kavya.nair@bluefin-demo.test,1990-05-10,female,L1,2024-01-15',
    'B-002,Manoj Kumar,not-an-email,1988-02-30,male,L2,2023-06-01',
    'B-001,Duplicate Person,dup@bluefin-demo.test,1991-01-01,unknown,L1,2024-02-01',
    '"B-003","Rahul ""RJ"" Jain",rahul.jain@bluefin-demo.test,1993-07-07,male,,2024-03-01',
  ];
  const dry = await api('POST', '/corporate/members/import', { token: hrB, body: { csv: csv(rows), dryRun: true } });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.totalRows, 4);
  assert.equal(dry.body.validRows, 1);
  const byRow = (n) => dry.body.rowErrors.filter((e) => e.row === n).map((e) => e.field).sort();
  assert.deepEqual(byRow(3), ['dob', 'email']);
  assert.deepEqual(byRow(4), ['employeeId', 'gender']);
  assert.ok(byRow(5).includes('grade') && byRow(5).includes('name'));

  const strict = await api('POST', '/corporate/members/import', { token: hrB, body: { csv: csv(rows) } });
  assert.equal(strict.status, 422, 'all-or-nothing by default');
  assert.equal(db.find('groupMembers', (m) => m.employerId === empB.id).length, 0);

  const partial = await api('POST', '/corporate/members/import', { token: hrB, body: { csv: csv(rows), skipInvalid: true } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.imported, 1);

  const good = [];
  for (let i = 4; i <= 9; i++) good.push(`B-00${i},Employee Number ${'ABCDEFGHI'[i - 1]},emp${i}@bluefin-demo.test,198${i}-0${i % 9 || 1}-1${i % 9},${i % 2 ? 'male' : 'female'},L${i % 3 + 1},2023-0${i % 9 || 1}-01`);
  const ok = await api('POST', '/corporate/members/import', { token: hrB, body: { csv: csv(good) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.imported, 6);
  const again = await api('POST', '/corporate/members/import', { token: hrB, body: { csv: csv(good), dryRun: true } });
  assert.equal(again.body.validRows, 0, 'existing employee IDs are rejected');
});

test('enrolment → sandbox insurer confirmation → certificate PDF; event published once', async () => {
  const { api } = s;
  const res = await api('POST', `/corporate/group-policies/${policyB.id}/enrol`, { token: hrB, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.submitted.length, 7);
  assert.ok(res.body.submitted.every((x) => x.status === 'Enrolled'));
  const rows = (await api('GET', `/corporate/group-policies/${policyB.id}/enrolments`, { token: hrB })).body;
  const one = rows.find((r) => r.employeeId === 'B-001');
  assert.equal(one.status, 'Enrolled');
  assert.match(one.certificateNumber, /^COI-/);
  const events = db.find('events', (e) => e.type === 'CORPORATE_MEMBER_ENROLLED' && e.payload.enrolmentId === one.enrolmentId);
  assert.equal(events.length, 1);
  const retry = await api('POST', `/corporate/group-policies/${policyB.id}/enrol`, { token: hrB, body: { memberIds: [one.memberId] } });
  assert.equal(retry.body.submitted.length, 0);
  assert.equal(retry.body.skipped.length, 1, 'resubmission is a no-op');
  assert.equal(db.find('events', (e) => e.type === 'CORPORATE_MEMBER_ENROLLED' && e.payload.enrolmentId === one.enrolmentId).length, 1);
  const pdf = await api('GET', `/corporate/enrolments/${one.enrolmentId}/certificate`, { token: hrB });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);
  assert.equal(Buffer.from(pdf.body).subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.headers.get('content-disposition'), new RegExp(one.certificateNumber));
});

test('manual mode: enrolment stays pending until the insurer decides; decline mode rejects', async () => {
  const { api, tokens } = s;
  await s.setInsurerMode('manual');
  const add = await api('POST', '/corporate/members', { token: hrB, body: { employeeId: 'B-020', name: 'Pending Person', email: 'pending@bluefin-demo.test', dob: '1990-01-01', gender: 'female', grade: 'L1', joiningDate: '2023-01-01' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const sub = await api('POST', `/corporate/members/${add.body.id}/enrol`, { token: hrB });
  assert.equal(sub.body.enrolment.status, 'Pending Insurer');
  const eid = sub.body.enrolment.id;
  assert.equal((await api('GET', `/corporate/enrolments/${eid}/certificate`, { token: hrB })).status, 404, 'no certificate before confirmation');
  assert.equal(db.find('events', (e) => e.type === 'CORPORATE_MEMBER_ENROLLED' && e.payload.enrolmentId === eid).length, 0);
  const pending = (await api('GET', '/corporate/confirmations?status=pending', { token: tokens.neha })).body.find((c) => c.refId === eid);
  assert.ok(pending, 'sandbox insurer sees the pending request');
  assert.equal((await api('POST', `/corporate/confirmations/${pending.id}/decision`, { token: hrB, body: { decision: 'confirmed' } })).status, 403, 'HR cannot confirm on the insurer\'s behalf');
  const ok = await api('POST', `/corporate/confirmations/${pending.id}/decision`, { token: tokens.neha, body: { decision: 'confirmed', insurerReference: 'SBX-MEM-MANUAL1' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(db.get('groupEnrolments', eid).status, 'Enrolled');
  assert.equal((await api('POST', `/corporate/confirmations/${pending.id}/decision`, { token: tokens.neha, body: { decision: 'confirmed' } })).status, 409, 'duplicate callback has no effect');
  assert.equal(db.find('events', (e) => e.type === 'CORPORATE_MEMBER_ENROLLED' && e.payload.enrolmentId === eid).length, 1);

  await s.setInsurerMode('decline');
  const add2 = await api('POST', '/corporate/members', { token: hrB, body: { employeeId: 'B-021', name: 'Declined Person', email: 'declined@bluefin-demo.test', dob: '1985-01-01', gender: 'male', grade: 'L1', joiningDate: '2023-01-01' } });
  const sub2 = await api('POST', `/corporate/members/${add2.body.id}/enrol`, { token: hrB });
  assert.equal(sub2.body.enrolment.status, 'Rejected by Insurer');
  await s.setInsurerMode('auto');
});

test('tenant isolation: employer B HR cannot read employer A roster (404) and vice versa', async () => {
  const { api, tokens } = s;
  const mine = (await api('GET', '/corporate/members', { token: hrB })).body;
  assert.ok(mine.length > 0 && mine.every((m) => m.employerId === empB.id));
  assert.equal((await api('GET', '/corporate/members?employerId=emp_demo', { token: hrB })).status, 404);
  assert.equal((await api('GET', '/corporate/members/gm_demo_01', { token: hrB })).status, 404);
  assert.equal((await api('GET', '/corporate/employers/emp_demo', { token: hrB })).status, 404);
  assert.equal((await api('GET', '/corporate/dashboard?employerId=emp_demo', { token: hrB })).status, 404);
  assert.equal((await api('GET', '/corporate/group-policies/gp_demo', { token: hrB })).status, 404);
  assert.equal((await api('GET', '/corporate/enrolments/ge_demo_01/certificate', { token: hrB })).status, 404);
  assert.equal((await api('GET', '/corporate/invoices/inv_demo_01', { token: hrB })).status, 404);
  assert.equal((await api('POST', '/corporate/members/gm_demo_01/leave', { token: hrB, body: { leavingDate: today() } })).status, 404);
  assert.equal((await api('GET', `/corporate/members/${mine[0].id}`, { token: tokens.sana })).status, 404);
  const sanaList = (await api('GET', '/corporate/members', { token: tokens.sana })).body;
  assert.ok(sanaList.every((m) => m.employerId === 'emp_demo'));
  assert.equal((await api('GET', '/corporate/employers', { token: tokens.sana })).status, 403, 'HR cannot list all employers');
});

test('HR dashboard is aggregate-only and suppresses cohorts below 5', async () => {
  const { api, tokens } = s;
  // Employer A (seed): 6 distinct claimants → aggregate shown, but never names/diagnoses/claim refs.
  const a = await api('GET', '/corporate/dashboard', { token: tokens.sana });
  assert.equal(a.status, 200);
  assert.equal(a.body.claims.suppressed, false);
  assert.equal(a.body.claims.claimsReported, 6);
  assert.ok(a.body.claims.claimedAmountBand);
  const text = JSON.stringify(a.body);
  for (const c of db.find('groupClaims', (x) => x.employerId === 'emp_demo')) {
    assert.ok(!text.includes(c.claimRef), 'no claim references');
    assert.ok(!text.includes(c.memberId), 'no member ids');
    assert.ok(!text.includes(db.get('groupMembers', c.memberId).name), 'no claimant names');
  }
  assert.ok(!/diagnos/i.test(text.replace(/no individual medical/gi, '')), 'no diagnosis field');
  // Small cells (< 5) inside the aggregate are withheld.
  assert.equal(a.body.claims.byStatus.Settled.suppressed, true);
  assert.equal(a.body.claims.byStatus.Settled.value, null);
  assert.equal(a.body.wellness.programmes.find((p) => p.id === 'wp_demo_01').participation.value, 6);
  assert.equal((await api('GET', '/corporate/group-claims', { token: tokens.sana })).status, 403, 'HR cannot read the claims feed');

  // Employer B: two claimants → whole claims section suppressed.
  const rows = (await api('GET', `/corporate/group-policies/${policyB.id}/enrolments`, { token: hrB })).body.filter((r) => r.status === 'Enrolled');
  for (const r of rows.slice(0, 2)) {
    const c = await api('POST', '/corporate/group-claims', { token: tokens.neha, body: { groupPolicyId: policyB.id, memberId: r.memberId, claimedAmount: 250000_00, status: 'Settled', diagnosis: 'Synthetic fracture' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
  }
  const b = await api('GET', '/corporate/dashboard', { token: hrB });
  assert.equal(b.body.claims.suppressed, true);
  assert.match(b.body.claims.note, /privacy/i);
  assert.equal(b.body.claims.claimedAmountBand, undefined);
  assert.ok(!JSON.stringify(b.body).includes('fracture'));
  const an = await api('GET', '/corporate/analytics', { token: hrB });
  assert.equal(an.body.rows.length, 1);
  assert.equal(an.body.rows[0].utilisation.suppressed, true);
});

test('employee self-service: Arjun sees only his own membership and can enrol himself', async () => {
  const { api, tokens } = s;
  const me = await api('GET', '/corporate/benefits/me', { token: tokens.arjun });
  assert.equal(me.status, 200);
  assert.equal(me.body.memberships.length, 1);
  const ms = me.body.memberships[0];
  assert.equal(ms.member.email, 'customer_arjun@vhc.test');
  assert.equal(ms.employer.id, 'emp_demo');
  assert.ok(!JSON.stringify(me.body).includes('Aditi Rao'), 'no other employees');
  const pol = ms.policies[0];
  assert.equal(pol.enrolment.status, 'Not Enrolled');
  assert.ok(pol.canSubmit);
  assert.equal((await api('POST', '/corporate/benefits/enrolments/submit', { token: tokens.arjun, body: { memberId: ms.member.id, groupPolicyId: pol.id } })).status, 422, 'declaration required');
  const sub = await api('POST', '/corporate/benefits/enrolments/submit', { token: tokens.arjun, body: { memberId: ms.member.id, groupPolicyId: pol.id, declaration: true } });
  assert.equal(sub.body.status, 'Enrolled');
  const cert = await api('GET', `/corporate/benefits/enrolments/${sub.body.enrolmentId}/certificate`, { token: tokens.arjun });
  assert.equal(cert.status, 200);
  // Someone else's records are invisible.
  assert.equal((await api('GET', '/corporate/benefits/enrolments/ge_demo_01/certificate', { token: tokens.arjun })).status, 404);
  assert.equal((await api('POST', '/corporate/benefits/members/gm_demo_01/dependents', { token: tokens.arjun, body: { name: 'X Y', relationship: 'spouse', dob: '1990-01-01', gender: 'female' } })).status, 404);
  assert.equal((await api('GET', '/corporate/members', { token: tokens.arjun })).status, 403);
  const asha = await api('GET', '/corporate/benefits/me', { token: tokens.cust1 });
  assert.equal(asha.body.memberships.length, 0);
  // Wellness: opt-in needs explicit consent.
  const wp = ms.wellness.find((w) => w.id === 'wp_demo_01');
  assert.equal(wp.participation, undefined, 'employees do not see participation counts');
  assert.equal((await api('POST', '/corporate/benefits/wellness/wp_demo_01/opt-in', { token: tokens.arjun, body: { memberId: ms.member.id } })).status, 422);
  assert.equal((await api('POST', '/corporate/benefits/wellness/wp_demo_01/opt-in', { token: tokens.arjun, body: { memberId: ms.member.id, consent: true } })).status, 200);
});

test('endorsement pro-rata premium is exact in paise (additions debit, deletions credit)', async () => {
  const { api } = s;
  // Pure function, fixed dates: 365-day term, ₹5,220 annual (18-35 band at ₹5 lakh).
  assert.deepEqual(proRata(522000, { startDate: '2026-01-01', endDate: '2026-12-31' }, '2026-07-01', 'addition'), { days: 184, policyDays: 365, amount: 263145 });
  assert.deepEqual(proRata(522000, { startDate: '2026-01-01', endDate: '2026-12-31' }, '2026-07-01', 'deletion'), { days: 183, policyDays: 365, amount: 261715 });
  assert.deepEqual(proRata(522000, { startDate: '2026-01-01', endDate: '2026-12-31' }, '2026-01-01', 'addition').amount, 522000);

  const rows = (await api('GET', `/corporate/group-policies/${policyB.id}/enrolments`, { token: hrB })).body;
  const kavya = rows.find((r) => r.employeeId === 'B-001');
  const eff = isoAddDays(today(), -3);
  const dep = await api('POST', `/corporate/members/${kavya.memberId}/dependents`, { token: hrB, body: { name: 'Arun Nair', relationship: 'spouse', dob: '1992-03-03', gender: 'male', effectiveDate: eff } });
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  const en = dep.body.endorsement;
  const policyDays = Math.round((Date.parse(policyB.endDate) - Date.parse(policyB.startDate)) / 86400000) + 1;
  const days = Math.round((Date.parse(policyB.endDate) - Date.parse(eff)) / 86400000) + 1;
  assert.equal(en.annualPremium, 522000, '₹3,600 × 1.45 for the 18-35 band at ₹5 lakh');
  assert.equal(en.days, days);
  assert.equal(en.policyDays, policyDays);
  assert.equal(en.proRataPremium, Math.round((522000 * days) / policyDays));
  assert.equal(en.gst, Math.round((en.proRataPremium * 1800) / 10000));
  assert.equal(en.total, en.proRataPremium + en.gst);
  assert.equal(en.status, 'Confirmed');
  assert.equal(db.get('groupEnrolments', kavya.enrolmentId).lives.filter((l) => l.status === 'Covered').length, 2);

  // Leaver: deletion endorsement credits the days after the last covered day for every covered life.
  const leave = isoAddDays(today(), 5);
  const out = await api('POST', `/corporate/members/${kavya.memberId}/leave`, { token: hrB, body: { leavingDate: leave } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const del = out.body.endorsements[0];
  const daysAfter = Math.round((Date.parse(policyB.endDate) - Date.parse(leave)) / 86400000);
  const annual = db.get('groupEnrolments', kavya.enrolmentId).lives.reduce((t, l) => t + l.annualPremium, 0);
  assert.equal(del.type, 'deletion');
  assert.equal(del.direction, 'credit');
  assert.equal(del.annualPremium, annual);
  assert.equal(del.proRataPremium, Math.round((annual * daysAfter) / policyDays));
  assert.equal(db.get('groupEnrolments', kavya.enrolmentId).status, 'Ended');
});

test('invoices: premium + endorsement notes; test-mode payment; ledger posting is idempotent', async () => {
  const { api, tokens } = s;
  assert.equal((await api('POST', `/corporate/group-policies/${policyB.id}/invoices`, { token: hrB })).status, 403, 'HR cannot raise invoices');
  const gen = await api('POST', `/corporate/group-policies/${policyB.id}/invoices`, { token: tokens.finance });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const types = gen.body.map((i) => i.type).sort();
  assert.deepEqual(types, ['credit_note', 'debit_note', 'premium']);
  assert.ok(gen.body.every((i) => /^INV-CORP-\d{4}-\d{6}$/.test(i.invoiceNumber)));
  const premium = gen.body.find((i) => i.type === 'premium');
  assert.equal(premium.gst, Math.round((premium.netAmount * 1800) / 10000));
  assert.equal(premium.total, premium.netAmount + premium.gst);
  assert.equal((await api('POST', `/corporate/group-policies/${policyB.id}/invoices`, { token: tokens.finance })).status, 409, 'nothing is billed twice');

  assert.equal((await api('POST', `/corporate/invoices/${premium.id}/pay`, { token: hrB, body: { method: 'test_netbanking' } })).status, 403, 'only corporate_admin pays');
  assert.equal((await api('POST', `/corporate/invoices/${premium.id}/pay`, { token: tokens.finance, body: { method: 'test_netbanking', cardNumber: '4111111111111111' } })).status, 400, 'no card data');
  const paid = await api('POST', `/corporate/invoices/${premium.id}/pay`, { token: tokens.finance, body: { method: 'test_neft' } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.invoice.status, 'Paid');
  const entries = () => db.find('ledgerEntries', (e) => e.refId === premium.id);
  assert.equal(entries().length, 1);
  assert.equal(entries()[0].ledger, 'premium_facilitated');
  assert.equal(entries()[0].insurerId, 'ins_sandbox');
  assert.equal(entries()[0].amount, premium.total);
  assert.equal((await api('POST', `/corporate/invoices/${premium.id}/pay`, { token: tokens.finance, body: { method: 'test_neft' } })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await api('POST', `/corporate/invoices/${premium.id}/post-ledger`, { token: tokens.finance })).status, 200);
  assert.equal(entries().length, 1, 'reposting never duplicates');

  const credit = gen.body.find((i) => i.type === 'credit_note');
  assert.equal((await api('POST', `/corporate/invoices/${credit.id}/apply-credit`, { token: tokens.finance })).status, 200);
  assert.equal(db.find('ledgerEntries', (e) => e.refId === credit.id && e.direction === 'debit').length, 1);

  // Service fee (VHC revenue) is separate from premium.
  const month = today().slice(0, 7);
  const fee = await api('POST', `/corporate/employers/${empB.id}/service-fee-invoice`, { token: tokens.finance, body: { month } });
  assert.equal(fee.status, 201, JSON.stringify(fee.body));
  assert.equal((await api('POST', `/corporate/employers/${empB.id}/service-fee-invoice`, { token: tokens.finance, body: { month } })).status, 409);
  assert.equal((await api('POST', `/corporate/invoices/${fee.body.id}/pay`, { token: tokens.finance, body: {} })).status, 200);
  await api('POST', `/corporate/invoices/${fee.body.id}/post-ledger`, { token: tokens.finance });
  const feeEntries = db.find('ledgerEntries', (e) => e.refId === fee.body.id);
  assert.deepEqual(feeEntries.map((e) => e.ledger).sort(), ['corporate_service_fee', 'tax']);
  assert.equal(feeEntries.find((e) => e.ledger === 'corporate_service_fee').amount, fee.body.netAmount);

  const rec = await api('GET', `/corporate/reconciliation?employerId=${empB.id}`, { token: tokens.finance });
  assert.equal(rec.body.mismatches.length, 0);
  assert.equal(rec.body.totals.serviceFeeRevenue, fee.body.netAmount);
  assert.equal(rec.body.totals.premiumFacilitatedNet, premium.total - credit.total);

  // corporate_admin pays their own invoice (simulated) but not another employer's.
  assert.equal((await api('POST', '/corporate/invoices/inv_demo_01/pay', { token: tokens.kabir, body: { method: 'test_upi' } })).status, 200);
  assert.equal((await api('POST', `/corporate/invoices/${gen.body.find((i) => i.type === 'debit_note').id}/pay`, { token: tokens.kabir, body: {} })).status, 404);
});

test('auditor and compliance officer are read-only; sales can read employers but not change them', async () => {
  const { api, tokens } = s;
  for (const t of [tokens.auditor, tokens.compliance]) {
    assert.equal((await api('GET', '/corporate/employers', { token: t })).status, 200);
    assert.equal((await api('GET', '/corporate/dashboard?employerId=emp_demo', { token: t })).status, 200);
    assert.equal((await api('GET', '/corporate/group-policies', { token: t })).status, 200);
    assert.equal((await api('POST', '/corporate/employers', { token: t, body: { name: 'Should Not Exist Ltd' } })).status, 403);
    assert.equal((await api('PUT', '/corporate/employers/emp_demo', { token: t, body: { industry: 'x' } })).status, 403);
    assert.equal((await api('POST', '/corporate/members/import', { token: t, body: { employerId: 'emp_demo', csv: 'x' } })).status, 403);
    assert.equal((await api('POST', '/corporate/invoices/inv_demo_01/post-ledger', { token: t })).status, 403);
  }
  assert.equal((await api('GET', '/corporate/employers/emp_demo', { token: tokens.sales })).status, 200);
  assert.equal((await api('POST', '/corporate/employers/emp_demo/status', { token: tokens.sales, body: { status: 'Suspended', note: 'x' } })).status, 403);
  const q = await api('POST', '/corporate/quotes', { token: tokens.sales, body: { employerId: 'emp_demo', sumInsured: 5 * LAKH, familyDefinition: 'ESC', census: [{ band: '18-35', lives: 10 }, { band: '36-45', lives: 2 }] } });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.equal(q.body.netPremium, 10 * 522000 + 2 * 754000);
  assert.equal(q.body.gst, Math.round((q.body.netPremium * 1800) / 10000));
  assert.ok(!db.findOne('employers', (e) => e.name === 'Should Not Exist Ltd'));
});

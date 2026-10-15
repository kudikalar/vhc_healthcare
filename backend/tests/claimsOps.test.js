// Claims operations: regulatory TAT clocks and breach detection, SLA policy versions, unified status
// and responsibility, claim intimation, settlement breakdown and events, grievances & appeals,
// fraud/anomaly review (never auto-deny), document intelligence and role restrictions.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, R, isoAddDays, pdfBytes, fileForm } from './helpers.js';

const { db } = await import('../src/db.js');
const { unifiedStatus } = await import('../src/services/claimsOps.js');

const MIN = 60_000;
const DAY = 86_400_000;
const payout = { accountName: 'Asha Verma', accountNumber: '123456789012', ifsc: 'VHCB0001234' };
const eventsFor = (type, claimId) => db.find('events', (e) => e.type === type && (e.payload.claimId === claimId || e.payload.grievanceId === claimId));

// Each test gets a fresh server: the in-memory database is a process-wide singleton, so seeding a
// second server would invalidate the first one's sessions.
let s;
let today;
beforeEach(async () => {
  s = await startServer();
  today = (await s.api('GET', '/dev/clock')).body.today;
});
afterEach(() => s.close());

const meeraPolicy = async (srv = s) => (await srv.api('GET', '/policies', { token: srv.tokens.meera })).body.find((p) => p.product === 'health');
const ashaPolicy = async (srv = s) => (await srv.api('GET', '/policies', { token: srv.tokens.cust1 })).body.find((p) => p.product === 'health');
const cashless = async (srv, policyId, extra = {}) => srv.api('POST', '/health-claims', {
  token: srv.tokens.meera,
  body: { policyId, memberId: 'mem_suresh', type: 'cashless', hospitalId: 'hsp_1', requestedAmount: R(200000), admissionDate: isoAddDays(today, 1), dischargeDate: isoAddDays(today, 3), diagnosis: 'Fracture of femur', treatment: 'ORIF surgery', ...extra },
});

test('seed: SLA policy v1, at-risk cashless claim for Meera, Asha grievance and an explainable fraud flag', async () => {
  const pols = (await s.api('GET', '/claims-ops/sla/policies', { token: s.tokens.claims })).body;
  assert.equal(pols.versions[0].version, 1);
  assert.equal(pols.versions[0].rules.preauthMinutes, 60);
  assert.equal(pols.versions[0].rules.finalAuthMinutes, 180);
  assert.equal(pols.versions[0].rules.settlementDays, 15);
  assert.equal(pols.versions[0].rules.grievanceDays, 14);
  assert.match(pols.versions[0].source, /IRDAI health insurance master circular baseline/);

  const board = (await s.api('GET', '/claims-ops/sla', { token: s.tokens.claims })).body;
  const seeded = board.rows.find((r) => r.claimNumber === 'HC-SEED-000002');
  assert.equal(seeded.sla.key, 'preauth');
  assert.equal(seeded.sla.state, 'at_risk', 'requested ~40 minutes ago against a 60-minute clock');
  assert.ok(board.counts.atRisk >= 1);
  assert.equal(seeded.tpaName, 'Sandbox TPA Services (Synthetic)');
  assert.match(seeded.insurerClaimRef, /^SBX-CLM-\d{4}-\d{6}$/);

  const flags = (await s.api('GET', '/claims-ops/fraud-flags', { token: s.tokens.claims })).body.flags;
  const f = flags.find((x) => x.claimNumber === 'HC-SEED-000002');
  assert.equal(f.ruleId, 'FR08');
  assert.ok(f.explanation && f.evidence.sumInsured);

  const g = (await s.api('GET', '/claims-ops/grievances', { token: s.tokens.cust1 })).body;
  assert.equal(g.length, 1);
  assert.equal(g[0].reference, 'GRV-SEED-000001');
});

test('SLA: pre-auth due 60 min after request, settlement due 15 days, document waits pause the clock', async () => {
  const pol = await meeraPolicy();
  const c = (await cashless(s, pol.id)).body;
  const pre = c.ops.sla.clocks.find((k) => k.key === 'preauth');
  assert.equal(Date.parse(pre.dueAt) - Date.parse(pre.startAt), 60 * MIN);
  assert.equal(pre.state, 'running');
  assert.equal(pre.policyVersion, 1);
  assert.equal(c.ops.sla.primary.key, 'preauth');

  // Backdated request timestamps are honoured (clocks are computed from the claim's own timestamps).
  const rec = db.get('healthClaims', c.id);
  const back = new Date(Date.now() - 75 * MIN).toISOString();
  rec.requests.preauthRequestedAt = back;
  let v = (await s.api('GET', `/health-claims/${c.id}`, { token: s.tokens.meera })).body;
  let k = v.ops.sla.clocks.find((x) => x.key === 'preauth');
  assert.equal(k.state, 'breached');
  assert.ok(k.remainingMs < 0);

  // A decision stops the clock (late → breached_closed); final authorisation clock is 180 minutes.
  v = (await s.api('POST', `/health-claims/${c.id}/preauth`, { token: s.tokens.claims, body: { decision: 'approve', amount: R(200000) } })).body;
  assert.equal(v.ops.sla.clocks.find((x) => x.key === 'preauth').state, 'breached_closed');
  v = (await s.api('POST', `/health-claims/${c.id}/final-bill`, { token: s.tokens.claims, body: { finalAmount: R(180000) } })).body;
  k = v.ops.sla.clocks.find((x) => x.key === 'final_auth');
  assert.equal(Date.parse(k.dueAt) - Date.parse(k.startAt), 180 * MIN);

  // Reimbursement settlement clock: 15 days, paused while waiting for the customer's documents.
  const asha = (await s.api('GET', '/health-claims', { token: s.tokens.cust1 })).body.find((x) => x.claimNumber === 'HC-SEED-000001');
  let a = (await s.api('GET', `/health-claims/${asha.id}`, { token: s.tokens.cust1 })).body;
  const st = a.ops.sla.clocks.find((x) => x.key === 'settlement');
  assert.equal(Date.parse(st.dueAt) - Date.parse(st.startAt), 15 * DAY);
  a = (await s.api('POST', `/health-claims/${asha.id}/request-documents`, { token: s.tokens.claims, body: { note: 'Please upload the itemised bill' } })).body;
  assert.equal(a.ops.sla.clocks.find((x) => x.key === 'settlement').state, 'paused');
  assert.equal(a.ops.unified.status, 'Awaiting Documents');
  assert.equal(a.ops.unified.responsible, 'Customer');
  assert.ok(a.ops.pendingDocuments.some((p) => p.kind === 'request'));
  a = (await s.api('POST', `/health-claims/${asha.id}/respond`, { token: s.tokens.cust1, body: {} })).body;
  const st2 = a.ops.sla.clocks.find((x) => x.key === 'settlement');
  assert.equal(st2.state, 'running');
  assert.ok(st2.startAt >= st.startAt, 'settlement clock runs from the last necessary document');
});

test('SLA breach job: advancing the clock records each breach once, notifies the claims team and raises an exception', async () => {
  const srv = s;
  {
    const pol = await meeraPolicy(srv);
    const c = (await cashless(srv, pol.id)).body;
    const res = await srv.setClock({ advanceDays: 1 });
    assert.ok(res.body.jobs.slaBreaches >= 1, 'breach job ran with the clock change');
    const forClaim = async () => (await srv.api('GET', '/claims-ops/sla/breaches', { token: srv.tokens.claims })).body.filter((b) => b.entityId === c.id);
    assert.equal((await forClaim()).length, 1);
    assert.equal((await forClaim())[0].clock, 'preauth');
    await srv.api('POST', '/dev/run-jobs', { token: srv.tokens.admin });
    const again = await srv.api('POST', '/claims-ops/sla/check', { token: srv.tokens.claims });
    assert.equal(again.status, 200);
    assert.equal((await forClaim()).length, 1, 'breach recorded once');
    const ex = (await srv.api('GET', '/admin/exceptions', { token: srv.tokens.admin })).body.filter((e) => e.type === 'sla_breach' && e.refId === c.id);
    assert.equal(ex.length, 1);
    const n = (await srv.api('GET', '/notifications', { token: srv.tokens.claims })).body.notifications;
    assert.ok(n.some((x) => x.title === 'SLA breached' && x.message.includes(c.claimNumber)));
    const board = (await srv.api('GET', '/claims-ops/sla?state=breached', { token: srv.tokens.claims })).body;
    assert.ok(board.rows.some((r) => r.id === c.id && r.breachRecorded));
    assert.ok(board.counts.breached >= 1);
  }
});

test('SLA policy versions: admin-only, audited, existing claims keep the version they started under', async () => {
  const srv = s;
  {
    const pol = await meeraPolicy(srv);
    const before = (await cashless(srv, pol.id)).body;
    const body = { rules: { preauthMinutes: 30 }, changeNote: 'Tighter internal target for testing' };
    assert.equal((await srv.api('POST', '/claims-ops/sla/policies', { token: srv.tokens.claims, body })).status, 403);
    assert.equal((await srv.api('POST', '/claims-ops/sla/policies', { token: srv.tokens.compliance, body })).status, 403);
    assert.equal((await srv.api('POST', '/claims-ops/sla/policies', { token: srv.tokens.admin, body: { rules: { preauthMinutes: 30 } } })).status, 400, 'change note required');
    const v2 = await srv.api('POST', '/claims-ops/sla/policies', { token: srv.tokens.admin, body });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version, 2);
    assert.equal(v2.body.rules.finalAuthMinutes, 180, 'unspecified rules carry over');
    assert.ok(db.find('auditLogs', (l) => l.action === 'SLA_POLICY_VERSION_CREATED' && l.entityId === v2.body.id).length === 1);

    const old = (await srv.api('GET', `/health-claims/${before.id}`, { token: srv.tokens.claims })).body.ops.sla.clocks.find((k) => k.key === 'preauth');
    assert.equal(old.policyVersion, 1);
    assert.equal(old.durationMs, 60 * MIN);
    const after2 = (await cashless(srv, pol.id, { memberId: 'mem_anika' })).body.ops.sla.clocks.find((k) => k.key === 'preauth');
    assert.equal(after2.policyVersion, 2);
    assert.equal(Date.parse(after2.dueAt) - Date.parse(after2.startAt), 30 * MIN);
  }
});

test('unified status, responsibility, events and settlement breakdown across the cashless flow', async () => {
  // Pure mapping
  assert.equal(unifiedStatus({ status: 'Submitted' }).status, 'Pending');
  assert.equal(unifiedStatus({ status: 'Preauth Requested', tpaId: 'tpa_x' }).responsible, 'TPA');
  assert.equal(unifiedStatus({ status: 'Preauth Requested', tpaId: null }).responsible, 'Insurer');
  assert.equal(unifiedStatus({ status: 'Preauth Approved', preauth: { status: 'approved', amount: 10 }, requestedAmount: 20 }).status, 'Partially Authorized');
  assert.equal(unifiedStatus({ status: 'Preauth Approved', preauth: { status: 'approved', amount: 20 }, requestedAmount: 20 }).status, 'Authorized');
  assert.equal(unifiedStatus({ status: 'Final Bill Submitted' }).status, 'Discharged');
  assert.equal(unifiedStatus({ status: 'Approved', type: 'cashless' }).status, 'Settlement Pending');
  assert.equal(unifiedStatus({ status: 'Settled' }).status, 'Settled');
  assert.equal(unifiedStatus({ status: 'Settled', closedAt: 'x' }).status, 'Closed');
  assert.equal(unifiedStatus({ status: 'Preauth Rejected' }).status, 'Rejected');
  assert.equal(unifiedStatus({ status: 'Documents Requested', type: 'reimbursement' }).status, 'Awaiting Documents');

  const pol = await meeraPolicy();
  let c = (await cashless(s, pol.id, { memberId: 'mem_meera', requestedAmount: R(150000), diagnosis: 'Gallstones', treatment: 'Laparoscopic cholecystectomy' })).body;
  assert.equal(c.ops.unified.status, 'Under Review');
  assert.equal(c.ops.unified.responsible, 'TPA');
  assert.match(c.ops.disclaimer, /does not control insurer decisions/);
  assert.match(c.ops.insurer.claimRef, /^SBX-CLM-/);
  assert.equal(eventsFor('CLAIM_INTIMATED', c.id).length, 1);
  assert.equal(eventsFor('PREAUTH_REQUESTED', c.id).length, 1);
  assert.ok(c.ops.insurerComms.length >= 1);
  assert.ok(c.ops.documents.checklist.some((i) => i.key === 'photo_id' && i.status === 'missing'));
  assert.ok(c.ops.documents.checklist.some((i) => i.key === 'final_bill' && i.status === 'not_yet_needed'));

  c = (await s.api('POST', `/health-claims/${c.id}/preauth`, { token: s.tokens.claims, body: { decision: 'approve', amount: R(100000) } })).body;
  assert.equal(c.ops.unified.status, 'Partially Authorized');
  assert.equal(c.ops.unified.responsible, 'Hospital');
  assert.equal(eventsFor('PREAUTH_DECIDED', c.id).length, 1);
  c = (await s.api('POST', `/health-claims/${c.id}/final-bill`, { token: s.tokens.meera, body: { finalAmount: R(120000) } })).body;
  assert.equal(c.ops.unified.status, 'Discharged');
  await s.api('POST', `/health-claims/${c.id}/assess`, { token: s.tokens.claims, body: { billItems: [{ description: 'Surgery', category: 'surgery', amount: R(110000) }, { description: 'Gloves & masks', category: 'non_medical', amount: R(10000) }] } });
  c = (await s.api('POST', `/health-claims/${c.id}/approve`, { token: s.tokens.claims })).body;
  assert.equal(c.ops.unified.status, 'Settlement Pending');
  assert.ok(c.ops.timestamps.finalBillDecidedAt, 'final authorisation timestamp recorded');
  const sb = c.ops.settlement;
  assert.equal(sb.billedAmount, R(120000));
  assert.equal(sb.customerPayable, sb.billedAmount - sb.approvedAmount);
  assert.equal(sb.deductions.reduce((t, d) => t + d.amount, 0), sb.customerPayable, 'deductions explain the customer-payable amount');
  assert.ok(sb.deductions.some((d) => d.key === 'non_payable' && d.amount === R(10000)));

  const po = (await s.api('POST', '/payouts/initiate', { token: s.tokens.claims, body: { claimType: 'health', claimId: c.id } })).body;
  await s.api('POST', '/payouts/callback', { body: { reference: po.reference, status: 'success' } });
  c = (await s.api('GET', `/health-claims/${c.id}`, { token: s.tokens.meera })).body;
  assert.equal(c.ops.unified.status, 'Settled');
  await s.api('GET', `/health-claims/${c.id}`, { token: s.tokens.meera });
  await s.api('POST', '/dev/run-jobs', { token: s.tokens.admin });
  assert.equal(eventsFor('CLAIM_SETTLED', c.id).length, 1, 'CLAIM_SETTLED published once');
  assert.ok(c.ops.timestamps.settledAt);
  assert.equal(c.ops.fraud, undefined, 'customers never see anomaly flags');
  assert.equal(c.ops.auditHistory, undefined);

  const closed = await s.api('POST', `/claims-ops/claims/${c.id}/close`, { token: s.tokens.claims, body: { note: 'Settled; no open queries' } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.unified.status, 'Closed');
});

test('claim intimation converts into a claim once and stays private to its owner', async () => {
  const pol = await meeraPolicy();
  const bad = await s.api('POST', '/claims-ops/intimations', { token: s.tokens.meera, body: { policyId: pol.id, memberId: 'mem_x', hospitalId: 'hsp_1', expectedAdmissionDate: isoAddDays(today, 5), natureOfIllness: 'Knee pain' } });
  assert.equal(bad.status, 400);
  const res = await s.api('POST', '/claims-ops/intimations', { token: s.tokens.meera, body: { policyId: pol.id, memberId: 'mem_lakshmi', hospitalId: 'hsp_8', expectedAdmissionDate: isoAddDays(today, 5), natureOfIllness: 'Planned knee replacement', admissionType: 'planned' } });
  assert.equal(res.status, 201);
  const i = res.body;
  assert.match(i.intimationNumber, /^INT-\d{4}-\d{6}$/);
  assert.equal(i.status, 'Intimated');
  assert.equal(i.preferredType, 'cashless');
  assert.equal(db.find('events', (e) => e.type === 'CLAIM_INTIMATED' && e.payload.intimationId === i.id).length, 1);
  assert.equal((await s.api('GET', `/claims-ops/intimations/${i.id}`, { token: s.tokens.cust2 })).status, 404);
  assert.equal((await s.api('GET', '/claims-ops/intimations', { token: s.tokens.hospital })).status, 403);
  assert.ok((await s.api('GET', '/claims-ops/intimations', { token: s.tokens.claims })).body.some((x) => x.id === i.id));

  const claim = await cashless(s, pol.id, { memberId: 'mem_lakshmi', hospitalId: 'hsp_8', admissionDate: isoAddDays(today, 5), dischargeDate: isoAddDays(today, 9), diagnosis: 'Osteoarthritis knee', treatment: 'Total knee replacement', intimationId: i.id });
  assert.equal(claim.status, 201);
  assert.equal(claim.body.ops.intimation.id, i.id);
  assert.ok(claim.body.ops.timestamps.intimatedAt);
  assert.equal(eventsFor('CLAIM_INTIMATED', claim.body.id).length, 0, 'the intimation event is not repeated for the converted claim');
  assert.equal(eventsFor('PREAUTH_REQUESTED', claim.body.id).length, 1);
  const after2 = (await s.api('GET', `/claims-ops/intimations/${i.id}`, { token: s.tokens.meera })).body;
  assert.equal(after2.status, 'Converted');
  assert.equal(after2.claim.id, claim.body.id);
  const again = await cashless(s, pol.id, { memberId: 'mem_lakshmi', hospitalId: 'hsp_8', admissionDate: isoAddDays(today, 6), dischargeDate: isoAddDays(today, 9), diagnosis: 'x', treatment: 'y', intimationId: i.id });
  assert.equal(again.status, 409);
});

test('fraud rules flag overlapping claims and reused documents; a claims officer can still approve (no auto-deny)', async () => {
  const pol = await ashaPolicy();
  const base = { policyId: pol.id, memberId: 'mem_diya', type: 'reimbursement', hospitalId: 'hsp_2', requestedAmount: R(40000), diagnosis: 'Fracture of wrist', treatment: 'Closed reduction', payoutDetails: payout };
  const a = (await s.api('POST', '/health-claims', { token: s.tokens.cust1, body: { ...base, admissionDate: isoAddDays(today, -10), dischargeDate: isoAddDays(today, -6) } })).body;
  const b = (await s.api('POST', '/health-claims', { token: s.tokens.cust1, body: { ...base, admissionDate: isoAddDays(today, -8), dischargeDate: isoAddDays(today, -5) } })).body;
  let flags = (await s.api('GET', `/claims-ops/fraud-flags?claimId=${b.id}`, { token: s.tokens.claims })).body.flags;
  const overlap = flags.find((f) => f.ruleId === 'FR01');
  assert.ok(overlap, 'overlapping dates for the same member are flagged');
  assert.equal(overlap.evidence.otherClaim, a.claimNumber);

  const pdf = pdfBytes();
  assert.equal((await s.api('POST', '/documents', { token: s.tokens.cust1, form: fileForm({ entityType: 'healthClaim', entityId: a.id, category: 'bill' }, pdf) })).status, 201);
  const up = await s.api('POST', '/documents', { token: s.tokens.cust1, form: fileForm({ entityType: 'healthClaim', entityId: b.id, category: 'bill' }, pdf) });
  assert.equal(up.status, 201, 'uploads are never blocked by anomaly rules');
  assert.match(up.body.sha256, /^[0-9a-f]{64}$/);
  flags = (await s.api('GET', `/claims-ops/fraud-flags?claimId=${b.id}`, { token: s.tokens.claims })).body.flags;
  const dupDoc = flags.find((f) => f.ruleId === 'FR02');
  assert.ok(dupDoc, 'the same file on two claims is flagged');
  assert.equal(dupDoc.evidence.otherClaim, a.claimNumber);

  // Staff see a warning banner payload; the customer never sees flags.
  const staffView = (await s.api('GET', `/health-claims/${b.id}`, { token: s.tokens.claims })).body;
  assert.ok(staffView.ops.fraud.open >= 2);
  assert.match(staffView.ops.fraud.disclaimer, /never be the sole reason/);
  assert.ok(staffView.ops.documents.crossClaimMatches.length >= 1);
  const custView = (await s.api('GET', `/health-claims/${b.id}`, { token: s.tokens.cust1 })).body;
  assert.equal(custView.ops.fraud, undefined);
  assert.equal(custView.ops.documents.crossClaimMatches, undefined);
  assert.equal((await s.api('GET', '/claims-ops/fraud-flags', { token: s.tokens.cust1 })).status, 403);
  assert.equal((await s.api('GET', '/claims-ops/fraud-flags', { token: s.tokens.auditor })).status, 403);

  // Approval is still possible with open flags.
  await s.api('POST', `/health-claims/${b.id}/assess`, { token: s.tokens.claims, body: {} });
  const ap = await s.api('POST', `/health-claims/${b.id}/approve`, { token: s.tokens.claims });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.status, 'Approved');

  // Human review workflow
  assert.equal((await s.api('POST', `/claims-ops/fraud-flags/${dupDoc.id}/review`, { token: s.tokens.claims, body: { action: 'clear' } })).status, 400, 'decision note required');
  assert.equal((await s.api('POST', `/claims-ops/fraud-flags/${dupDoc.id}/review`, { token: s.tokens.claims, body: { action: 'start_review' } })).body.status, 'In Review');
  const esc = await s.api('POST', `/claims-ops/fraud-flags/${dupDoc.id}/review`, { token: s.tokens.priya, body: { action: 'escalate', note: 'Same bill on two claims — referring to insurer SIU' } });
  assert.equal(esc.body.status, 'Escalated to insurer SIU');
  assert.equal((await s.api('POST', `/claims-ops/fraud-flags/${dupDoc.id}/review`, { token: s.tokens.claims, body: { action: 'clear', note: 'x' } })).status, 409);
  const cleared = await s.api('POST', `/claims-ops/fraud-flags/${overlap.id}/review`, { token: s.tokens.claims, body: { action: 'clear', note: 'Second claim is a follow-up admission; dates verified with the hospital' } });
  assert.equal(cleared.body.status, 'Cleared');
  // Re-running the rules does not reopen reviewed flags.
  const rescan = (await s.api('POST', `/claims-ops/claims/${b.id}/fraud-scan`, { token: s.tokens.claims })).body;
  assert.equal(rescan.created.filter((f) => ['FR01', 'FR02'].includes(f.ruleId)).length, 0);
});

test('grievances: acknowledgement, deadline, guidance, privacy, thread, appeal once, closure', async () => {
  const claim = (await s.api('GET', '/health-claims', { token: s.tokens.cust1 })).body[0];
  const bad = await s.api('POST', '/claims-ops/grievances', { token: s.tokens.cust1, body: { category: 'nope', subject: 'x', description: 'something went wrong' } });
  assert.equal(bad.status, 400);
  const res = await s.api('POST', '/claims-ops/grievances', { token: s.tokens.cust1, body: { category: 'claim', subject: 'Deduction not explained', description: 'The claim amount was reduced without an explanation of the deductions.', claimId: claim.id } });
  assert.equal(res.status, 201);
  const g = res.body;
  assert.match(g.reference, /^GRV-\d{4}-\d{6}$/);
  assert.equal(g.status, 'Acknowledged');
  assert.equal(Date.parse(g.responseDueAt) - Date.parse(g.acknowledgedAt), 14 * DAY);
  assert.ok(g.ownerName, 'a case owner is assigned');
  assert.match(g.messages[0].text, /received your grievance/);
  assert.match(g.guidance.nature, /neither the insurer nor the regulator/);
  assert.match(g.guidance.insurer, /Grievance Redressal Officer/);
  assert.ok(g.guidance.escalation.some((e) => e.url === 'https://bimabharosa.irdai.gov.in'));
  assert.ok(g.guidance.escalation.some((e) => /Ombudsman/.test(e.name)));
  assert.equal(g.sla.primary.key, 'grievance');
  assert.equal(db.find('events', (e) => e.type === 'GRIEVANCE_CREATED' && e.payload.grievanceId === g.id).length, 1);
  assert.equal((await s.api('POST', '/claims-ops/grievances', { token: s.tokens.cust1, body: { category: 'claim', subject: 'x', description: 'linked to a claim that is not mine', claimId: db.find('healthClaims', (c) => c.userId === 'usr_meera')[0].id } })).status, 404);

  // Privacy and roles
  assert.equal((await s.api('GET', `/claims-ops/grievances/${g.id}`, { token: s.tokens.cust2 })).status, 404);
  assert.ok(!(await s.api('GET', '/claims-ops/grievances', { token: s.tokens.cust2 })).body.some((x) => x.id === g.id));
  for (const t of ['tpa', 'hospital', 'neha', 'sana', 'agent']) {
    assert.equal((await s.api('GET', '/claims-ops/grievances', { token: s.tokens[t] })).status, 403, `${t} cannot list grievances`);
    assert.equal((await s.api('GET', `/claims-ops/grievances/${g.id}`, { token: s.tokens[t] })).status, 403, `${t} cannot read a grievance`);
  }
  for (const t of ['auditor', 'compliance']) {
    assert.equal((await s.api('GET', `/claims-ops/grievances/${g.id}`, { token: s.tokens[t] })).status, 200);
    assert.equal((await s.api('POST', `/claims-ops/grievances/${g.id}/messages`, { token: s.tokens[t], body: { text: 'hello' } })).status, 403);
    assert.equal((await s.api('POST', `/claims-ops/grievances/${g.id}/resolve`, { token: s.tokens[t], body: { summary: 'Resolved by auditor', outcome: 'upheld' } })).status, 403);
  }

  // Attachments on the grievance (documents entity type `grievance`)
  const doc = await s.api('POST', '/documents', { token: s.tokens.cust1, form: fileForm({ entityType: 'grievance', entityId: g.id, category: 'other' }, pdfBytes()) });
  assert.equal(doc.status, 201);
  assert.equal((await s.api('GET', `/documents?entityType=grievance&entityId=${g.id}`, { token: s.tokens.cust2 })).status, 404);
  assert.equal((await s.api('GET', `/documents?entityType=grievance&entityId=${g.id}`, { token: s.tokens.tpa })).status, 404);
  assert.equal((await s.api('POST', '/documents', { token: s.tokens.auditor, form: fileForm({ entityType: 'grievance', entityId: g.id, category: 'other' }, pdfBytes()) })).status, 403);

  // Thread, internal notes, insurer communication, escalation
  let v = (await s.api('POST', `/claims-ops/grievances/${g.id}/messages`, { token: s.tokens.support, body: { text: 'We are reviewing the deductions with the insurer.' } })).body;
  assert.equal(v.status, 'In Progress');
  await s.api('POST', `/claims-ops/grievances/${g.id}/messages`, { token: s.tokens.claims, body: { text: 'Internal: co-pay applies', internal: true } });
  await s.api('POST', `/claims-ops/grievances/${g.id}/insurer-comms`, { token: s.tokens.claims, body: { direction: 'outbound', subject: 'Request for deduction breakdown', message: 'Please share the deduction sheet.' } });
  v = (await s.api('POST', `/claims-ops/grievances/${g.id}/escalate`, { token: s.tokens.claims, body: { level: 'insurer', note: 'Escalated to the insurer grievance desk' } })).body;
  assert.equal(v.status, 'Escalated to Insurer');
  const custV = (await s.api('GET', `/claims-ops/grievances/${g.id}`, { token: s.tokens.cust1 })).body;
  assert.ok(!custV.messages.some((m) => m.internal), 'internal notes hidden from the customer');
  assert.ok(custV.insurerComms.length >= 1);
  await s.api('POST', `/claims-ops/grievances/${g.id}/messages`, { token: s.tokens.cust1, body: { text: 'Thank you, waiting for the update.' } });

  // Resolution → appeal once → appeal resolution → closure
  v = (await s.api('POST', `/claims-ops/grievances/${g.id}/resolve`, { token: s.tokens.claims, body: { summary: 'Deductions explained: co-payment and deductible per policy terms.', outcome: 'not_upheld', documentIds: [doc.body.id] } })).body;
  assert.equal(v.status, 'Resolved');
  assert.equal(v.resolution.documents.length, 1);
  assert.equal(v.sla.clocks.find((k) => k.key === 'grievance').state, 'met');
  assert.equal((await s.api('POST', `/claims-ops/grievances/${g.id}/appeal`, { token: s.tokens.cust2, body: { reason: 'Not my grievance but appealing' } })).status, 404);
  v = (await s.api('POST', `/claims-ops/grievances/${g.id}/appeal`, { token: s.tokens.cust1, body: { reason: 'The co-payment should not apply to my plan.' } })).body;
  assert.equal(v.status, 'Appealed');
  assert.ok(v.sla.clocks.some((k) => k.key === 'appeal' && k.running));
  v = (await s.api('POST', `/claims-ops/grievances/${g.id}/resolve`, { token: s.tokens.support, body: { summary: 'Appeal reviewed; insurer confirmed the co-payment clause applies.', outcome: 'not_upheld' } })).body;
  assert.equal(v.resolution.stage, 'appeal');
  assert.equal((await s.api('POST', `/claims-ops/grievances/${g.id}/appeal`, { token: s.tokens.cust1, body: { reason: 'Appealing a second time please' } })).status, 409, 'only one appeal');
  v = (await s.api('POST', `/claims-ops/grievances/${g.id}/close`, { token: s.tokens.cust1, body: {} })).body;
  assert.equal(v.status, 'Closed');
  assert.equal((await s.api('POST', `/claims-ops/grievances/${g.id}/messages`, { token: s.tokens.cust1, body: { text: 'one more thing' } })).status, 409);
  assert.ok(db.find('auditLogs', (l) => l.entityType === 'grievance' && l.entityId === g.id && l.action === 'GRIEVANCE_APPEALED').length === 1);
});

test('oversight roles read the SLA board (no medical details) but cannot mutate; partners have no access', async () => {
  for (const t of ['auditor', 'compliance']) {
    const board = await s.api('GET', '/claims-ops/sla', { token: s.tokens[t] });
    assert.equal(board.status, 200);
    assert.equal(board.body.readOnly, true);
    const json = JSON.stringify(board.body.rows);
    assert.ok(!/diagnosis|treatment|Coronary/i.test(json), 'no medical details on the board');
    assert.equal((await s.api('POST', '/claims-ops/sla/check', { token: s.tokens[t] })).status, 403);
    const claimId = board.body.rows[0].id;
    assert.equal((await s.api('POST', `/claims-ops/claims/${claimId}/insurer-comms`, { token: s.tokens[t], body: { subject: 'x' } })).status, 403);
    assert.equal((await s.api('GET', `/claims-ops/claims/${claimId}/insights`, { token: s.tokens[t] })).status, 404, 'claim medical insights are claims-team only');
  }
  for (const t of ['tpa', 'hospital', 'cust1', 'support']) assert.equal((await s.api('GET', '/claims-ops/sla', { token: s.tokens[t] })).status, 403);
  const claimId = db.find('healthClaims', (c) => c.userId === 'usr_meera')[0].id;
  assert.equal((await s.api('GET', `/claims-ops/claims/${claimId}/insights`, { token: s.tokens.cust1 })).status, 404, 'other customers cannot read claim insights');
  const ins = await s.api('GET', `/claims-ops/claims/${claimId}/insights`, { token: s.tokens.meera });
  assert.equal(ins.status, 200);
  assert.match(ins.body.documents.disclaimer, /not a claim decision/);
  assert.ok(ins.body.timelineSummary.text.includes('cashless'));
  const logged = await s.api('POST', `/claims-ops/claims/${claimId}/insurer-comms`, { token: s.tokens.claims, body: { direction: 'inbound', subject: 'Query from insurer', message: 'Please share the ECG report', visibleToCustomer: false } });
  assert.equal(logged.status, 201);
  const cust = (await s.api('GET', `/health-claims/${claimId}`, { token: s.tokens.meera })).body;
  assert.ok(!cust.ops.insurerComms.some((m) => m.subject === 'Query from insurer'), 'internal insurer comms hidden from the customer');
});

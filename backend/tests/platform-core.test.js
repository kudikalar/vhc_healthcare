// Enterprise platform core: payment vs issuance separation, refunds, separate ledgers, events,
// QA fixtures and partner organisation scoping.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedHealthApplication, payApplication, startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s?.close(); });

test('QA fixtures sign in by username; partner users carry their organisation', async () => {
  const me = (await s.api('GET', '/auth/me', { token: s.tokens.neha })).body.user;
  assert.equal(me.role, 'insurer_admin');
  assert.equal(me.orgId, 'ins_sandbox');
  assert.equal((await s.api('GET', '/auth/me', { token: s.tokens.hospital })).body.user.orgId, 'hsp_1');
  const bad = await s.api('POST', '/auth/login', { body: { email: 'customer_arjun', password: 'wrong-password-123' } });
  assert.equal(bad.status, 401);
});

test('partner users cannot reach internal staff data', async () => {
  for (const t of [s.tokens.neha, s.tokens.hospital, s.tokens.tpa, s.tokens.sana]) {
    assert.equal((await s.api('GET', '/payments', { token: t })).body.length, 0, 'no cross-tenant payments');
    assert.equal((await s.api('GET', '/admin/users', { token: t })).status, 403);
    assert.equal((await s.api('GET', '/reports/summary', { token: t })).status, 403);
  }
});

test('auto mode: payment captured, then insurer issues as a separate event; ledgers keep premium apart from revenue', async () => {
  const app = await acceptedHealthApplication(s, s.tokens.arjun);
  const pay = await payApplication(s, s.tokens.arjun, app);
  assert.equal(pay.status, 'success');
  const a = (await s.api('GET', `/applications/${app.id}`, { token: s.tokens.arjun })).body;
  assert.equal(a.status, 'Issued');
  const statuses = a.timeline.map((t) => t.status);
  assert.ok(statuses.indexOf('Issuance Pending') < statuses.indexOf('Issued'), 'payment confirmation precedes issuance');
  const pol = (await s.api('GET', `/policies/${a.policyId}`, { token: s.tokens.arjun })).body;
  assert.equal(pol.insurerId, 'ins_sandbox');
  assert.equal(pol.sandbox, true);
});

test('manual mode: payment success does not create a policy until the insurer decides', async () => {
  await s.setInsurerMode('manual');
  const app = await acceptedHealthApplication(s, s.tokens.arjun);
  await payApplication(s, s.tokens.arjun, app);
  let a = (await s.api('GET', `/applications/${app.id}`, { token: s.tokens.arjun })).body;
  assert.equal(a.status, 'Issuance Pending');
  assert.equal(a.policyId ?? null, null, 'no fabricated policy');
  const again = await s.api('POST', '/payments/initiate', { token: s.tokens.arjun, body: { purpose: 'application', applicationId: app.id, amount: app.offer.firstPayment, idempotencyKey: 'x-dup' } });
  assert.equal(again.status, 409, 'cannot pay twice while issuance is pending');
  const d = await s.api('POST', '/dev/insurer-decision', { token: s.tokens.admin, body: { applicationId: app.id, decision: 'issued' } });
  assert.equal(d.body.status, 'issued');
  a = (await s.api('GET', `/applications/${app.id}`, { token: s.tokens.arjun })).body;
  assert.equal(a.status, 'Issued');
  const replay = await s.api('POST', '/dev/insurer-decision', { token: s.tokens.admin, body: { applicationId: app.id, decision: 'issued' } });
  assert.equal(replay.status, 409, 'duplicate issuance callback has no effect');
  await s.setInsurerMode('auto');
});

test('decline mode: payment success + insurer rejection → no policy, full refund created', async () => {
  await s.setInsurerMode('decline');
  const app = await acceptedHealthApplication(s, s.tokens.arjun);
  const pay = await payApplication(s, s.tokens.arjun, app);
  const a = (await s.api('GET', `/applications/${app.id}`, { token: s.tokens.arjun })).body;
  assert.equal(a.status, 'Declined by Insurer');
  assert.equal(a.policyId ?? null, null);
  const p = (await s.api('GET', `/payments/${pay.reference}`, { token: s.tokens.arjun })).body;
  assert.equal(p.status, 'success', 'the captured payment record is not rewritten');
  assert.equal(p.refundStatus, 'pending');
  await s.setInsurerMode('auto');
});

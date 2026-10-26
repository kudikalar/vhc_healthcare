// Enterprise module: payments sandbox (Razorpay test cards, webhooks), refunds, ledgers & settlement,
// reconciliation, command centre, support desk isolation, oversight read-only rules and data rights.
// (i18n is client-side only and is not testable here.)
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptedHealthApplication, payApplication, startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s?.close(); });

const year = new Date().getUTCFullYear() + 2;
const card = (cardNumber, extra = {}) => ({ cardNumber, expMonth: '12', expYear: String(year).slice(2), cvc: '987', name: 'Arjun Kapoor', ...extra });
const key = () => `k-${crypto.randomUUID()}`;

async function initiate(token, app) {
  const r = await s.api('POST', '/payments/initiate', { token, body: { purpose: 'application', applicationId: app.id, amount: app.offer.firstPayment, idempotencyKey: key() } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return r.body.payment;
}
async function payWithCard(token, payment, number) {
  const first = await s.api('POST', `/payments/${payment.reference}/card`, { token, body: card(number) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.requiresAction, 'otp', 'Razorpay test cards go through the simulated bank OTP page');
  const second = await s.api('POST', `/payments/${payment.reference}/card`, { token, body: card(number, { otp: '123456' }) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  return second.body.payment;
}

test('Razorpay test cards: failures leave no policy; success captures payment then insurer issues', async () => {
  const t = s.tokens.arjun;
  const app = await acceptedHealthApplication(s, t);
  for (const [number, code] of [['4100 2800 0008 0001', 'INSUFFICIENT_FUNDS'], ['4100 2800 0007 0002', 'PAYMENT_CANCELLED'], ['4100 2800 0006 0003', 'BANK_DECLINED']]) {
    const p = await payWithCard(t, await initiate(t, app), number);
    assert.equal(p.status, 'failed');
    assert.equal(p.failureCode, code);
    assert.equal(p.card.last4, number.slice(-4));
    assert.equal(p.card.number, undefined, 'full card number never stored');
    const a = (await s.api('GET', `/applications/${app.id}`, { token: t })).body;
    assert.equal(a.status, 'Offer Accepted');
    assert.equal(a.policyId ?? null, null, 'no policy after a failed payment');
  }
  const ok = await payWithCard(t, await initiate(t, app), '4100 2800 0000 1007');
  assert.equal(ok.status, 'success');
  const a = (await s.api('GET', `/applications/${app.id}`, { token: t })).body;
  assert.equal(a.status, 'Issued');
  const statuses = a.timeline.map((x) => x.status);
  assert.ok(statuses.indexOf('Issuance Pending') < statuses.indexOf('Issued'), 'payment success precedes insurer issuance');
  const methods = (await s.api('GET', '/payments/methods', { token: t })).body;
  assert.ok(methods.cards.some((c) => c.number === '5555510000081006' && c.set === 'razorpay'));
  assert.ok(methods.cards.some((c) => c.set === 'legacy' && /legacy simulator/.test(c.label)));
  const bad = await s.api('POST', `/payments/${ok.reference}/card`, { token: t, body: card('4100280000001007') });
  assert.equal(bad.status, 409, 'a captured payment cannot be charged again');
});

test('UPI test VPAs, same-order resume and receipt/invoice PDFs', async () => {
  const t = s.tokens.arjun;
  const app = await acceptedHealthApplication(s, t);
  const p1 = await initiate(t, app);
  const p2 = await initiate(t, app);
  assert.equal(p2.reference, p1.reference, 'refresh / second checkout resumes the pending order');
  const fail = await s.api('POST', `/payments/${p1.reference}/upi`, { token: t, body: { vpa: 'failure@razorpay' } });
  assert.equal(fail.body.payment.status, 'failed');
  const notTest = await s.api('POST', `/payments/${(await initiate(t, app)).reference}/upi`, { token: t, body: { vpa: 'someone@okbank' } });
  assert.equal(notTest.status, 400);
  const p3 = await initiate(t, app);
  const ok = await s.api('POST', `/payments/${p3.reference}/upi`, { token: t, body: { vpa: 'success@razorpay' } });
  assert.equal(ok.body.payment.status, 'success');
  const pdf = await s.api('GET', `/payments/${p3.reference}/invoice.pdf`, { token: t });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(pdf.body).subarray(0, 4).toString(), '%PDF');
  assert.equal((await s.api('GET', `/payments/${p3.reference}/receipt.pdf`, { token: s.tokens.cust2 })).status, 404, 'another customer cannot download it');
});

test('webhook: signature required when a secret is set, replays rejected, duplicates have no effect', async () => {
  const t = s.tokens.arjun;
  const app = await acceptedHealthApplication(s, t);
  const p = await initiate(t, app);
  const secret = 'whsec_enterprise_test';
  process.env.PAYMENT_WEBHOOK_SECRET = secret;
  try {
    const body = { reference: p.reference, status: 'success', amount: p.amount };
    const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
    assert.equal((await s.api('POST', '/payments/callback', { body })).status, 401, 'unsigned rejected');
    assert.equal((await s.api('POST', '/payments/callback', { body, headers: { 'x-razorpay-signature': 'deadbeef', 'x-razorpay-event-id': 'evt_1' } })).status, 401, 'bad signature rejected');
    const ok = await s.api('POST', '/payments/callback', { body, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'success');
    const replay = await s.api('POST', '/payments/callback', { body, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' } });
    assert.equal(replay.status, 409, 'replayed event id rejected');
    const dup = await s.api('POST', '/payments/callback', { body, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_2' } });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true, 'duplicate delivery acknowledged without effect');
  } finally {
    delete process.env.PAYMENT_WEBHOOK_SECRET;
  }
  const entries = (await s.api('GET', `/enterprise/finance/entries?q=${p.reference}&ledger=premium_facilitated`, { token: s.tokens.finance })).body;
  assert.equal(entries.filter((e) => e.direction === 'credit').length, 1, 'premium posted exactly once');
  const policies = (await s.api('GET', '/policies', { token: t })).body.filter((x) => x.applicationId === app.id);
  assert.equal(policies.length, 1, 'exactly one policy');
});

test('refunds: partial then full limits; customer sees refund status', async () => {
  const t = s.tokens.arjun;
  const app = await acceptedHealthApplication(s, t);
  const pay = await payApplication(s, t, app);
  const half = Math.floor(pay.amount / 2);
  const f = s.tokens.finance;
  const r1 = await s.api('POST', '/enterprise/finance/refunds', { token: f, body: { paymentReference: pay.reference, amount: half, reason: 'Pro-rata adjustment', settleNow: true } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.partial, true);
  const tooMuch = await s.api('POST', '/enterprise/finance/refunds', { token: f, body: { paymentReference: pay.reference, amount: pay.amount, reason: 'Full refund' } });
  assert.equal(tooMuch.status, 409, 'cannot refund beyond the remaining balance');
  const rest = await s.api('POST', '/enterprise/finance/refunds', { token: f, body: { paymentReference: pay.reference, reason: 'Remaining balance' } });
  assert.equal(rest.status, 201);
  assert.equal(rest.body.amount, pay.amount - half);
  assert.equal((await s.api('POST', '/enterprise/finance/refunds', { token: f, body: { paymentReference: pay.reference, amount: 1, reason: 'Again' } })).status, 409);
  assert.equal((await s.api('POST', `/enterprise/finance/refunds/${rest.body.id}/settle`, { token: f, body: { outcome: 'completed' } })).status, 200);
  const mine = (await s.api('GET', '/payments', { token: t })).body.find((p) => p.reference === pay.reference);
  assert.equal(mine.refundStatus, 'refunded');
  assert.equal(mine.refunds.length, 2);
  assert.equal((await s.api('POST', '/enterprise/finance/refunds', { token: t, body: { paymentReference: pay.reference, reason: 'x' } })).status, 403, 'customers cannot issue refunds');
});

test('ledgers: facilitated premium is not VHC revenue on the command centre; insurer settlement is idempotent', async () => {
  const cc = (await s.api('GET', '/enterprise/command', { token: s.tokens.admin })).body;
  const k = Object.fromEntries(cc.kpis.business.map((x) => [x.key, x.value]));
  const sum = (await s.api('GET', '/enterprise/finance/summary', { token: s.tokens.finance })).body;
  assert.ok(k.premiumFacilitated > 0);
  assert.notEqual(k.premiumFacilitated, k.vhcRevenue);
  assert.equal(k.vhcRevenue, sum.headline.vhcEarnedRevenue);
  assert.equal(sum.headline.vhcEarnedRevenue, sum.balances.vhc_commission.net + sum.balances.corporate_service_fee.net + sum.balances.healthcare_booking_fee.net + sum.balances.hospital_service_income.net, 'revenue = commission + fees only');
  assert.equal(cc.charts.length, 12);
  assert.ok(cc.retention.groups.length >= 5);

  const held = sum.headline.premiumsHeldForInsurers;
  assert.ok(held > 0);
  const a = await s.api('POST', '/enterprise/finance/settlements', { token: s.tokens.finance, body: { insurerId: 'ins_sandbox', idempotencyKey: 'stl-001' } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await s.api('POST', '/enterprise/finance/settlements', { token: s.tokens.finance, body: { insurerId: 'ins_sandbox', idempotencyKey: 'stl-001' } });
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.settlement.reference, a.body.settlement.reference);
  assert.equal((await s.api('POST', '/enterprise/finance/settlements', { token: s.tokens.finance, body: { insurerId: 'ins_sandbox', idempotencyKey: 'stl-002' } })).status, 409, 'nothing left to settle');
  const after = (await s.api('GET', '/enterprise/finance/summary?insurerId=ins_sandbox', { token: s.tokens.finance })).body;
  assert.equal(after.balances.premium_facilitated.net, 0);
  assert.equal(after.balances.insurer_settlement.net, a.body.settlement.amount);
});

test('reconciliation flags captured-but-issuance-pending (manual insurer)', async () => {
  await s.setInsurerMode('manual');
  try {
    const app = await acceptedHealthApplication(s, s.tokens.arjun);
    const pay = await payApplication(s, s.tokens.arjun, app);
    const rec = (await s.api('GET', '/enterprise/finance/reconciliation', { token: s.tokens.finance })).body;
    assert.ok(rec.exceptions.some((e) => e.type === 'captured_issuance_pending' && e.reference === pay.reference));
    assert.ok(rec.insurer.issuancePending >= 1);
    const summary = (await s.api('GET', '/reports/summary', { token: s.tokens.admin })).body.reconciliation;
    assert.ok(summary.awaitingIssuance.some((x) => x.reference === pay.reference));
    assert.ok(!summary.paymentMismatches.some((x) => x.reference === pay.reference), 'issuance pending is not a payment mismatch');
  } finally {
    await s.setInsurerMode('auto');
  }
});

test('support tickets are isolated between customers; internal notes hidden', async () => {
  const create = await s.api('POST', '/enterprise/support/tickets', { token: s.tokens.cust1, body: { category: 'payment', subject: 'Receipt question', message: 'Where is my premium receipt for last month?' } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const id = create.body.id;
  assert.match(create.body.reference, /^TKT-/);
  assert.equal((await s.api('GET', `/enterprise/support/tickets/${id}`, { token: s.tokens.cust2 })).status, 404);
  assert.equal((await s.api('POST', `/enterprise/support/tickets/${id}/messages`, { token: s.tokens.cust2, body: { body: 'hi' } })).status, 404);
  assert.ok(!(await s.api('GET', '/enterprise/support/tickets', { token: s.tokens.cust2 })).body.some((t) => t.id === id));
  await s.api('POST', `/enterprise/support/tickets/${id}/messages`, { token: s.tokens.support, body: { body: 'Internal: check gateway', internal: true } });
  await s.api('POST', `/enterprise/support/tickets/${id}/messages`, { token: s.tokens.support, body: { body: 'You can download it from Payments.' } });
  const mine = (await s.api('GET', `/enterprise/support/tickets/${id}`, { token: s.tokens.cust1 })).body;
  assert.equal(mine.messages.length, 2, 'customer sees their message and the public reply only');
  assert.ok(mine.sla.firstRespondedAt);
  const staff = (await s.api('GET', `/enterprise/support/tickets/${id}`, { token: s.tokens.support })).body;
  assert.equal(staff.messages.length, 3);
  const ev = (await s.api('POST', `/enterprise/support/tickets/${id}/escalate`, { token: s.tokens.support, body: { type: 'claims', note: 'Needs claims team' } })).body;
  assert.equal(ev.status, 'escalated');
});

test('auditor and compliance officer can read but cannot mutate', async () => {
  for (const tok of [s.tokens.auditor, s.tokens.compliance]) {
    assert.equal((await s.api('GET', '/enterprise/finance/summary', { token: tok })).status, 200);
    assert.equal((await s.api('GET', '/enterprise/command', { token: tok })).status, 200);
    assert.equal((await s.api('GET', '/enterprise/compliance/audit', { token: tok })).status, 200);
    assert.equal((await s.api('POST', '/enterprise/finance/settlements', { token: tok, body: { insurerId: 'ins_sandbox' } })).status, 403);
    assert.equal((await s.api('POST', '/enterprise/finance/refunds', { token: tok, body: { paymentReference: 'x', reason: 'x' } })).status, 403);
    assert.equal((await s.api('POST', '/enterprise/finance/gateway-settlement', { token: tok, body: {} })).status, 403);
    assert.equal((await s.api('POST', '/enterprise/support/tickets/tkt_demo_1/status', { token: tok, body: { status: 'closed' } })).status, 403);
    assert.equal((await s.api('POST', '/enterprise/payment-scenarios/run', { token: tok })).status, 403);
    assert.equal((await s.api('POST', '/admin/users', { token: tok, body: {} })).status, 403);
  }
  assert.equal((await s.api('POST', '/enterprise/compliance/data-requests/x/decision', { token: s.tokens.auditor, body: { action: 'complete' } })).status, 403);
  for (const tok of [s.tokens.neha, s.tokens.cust1]) assert.equal((await s.api('GET', '/enterprise/finance/summary', { token: tok })).status, 403);
});

test('payment scenario catalogue: 25 scenarios, automated dry runs pass and persist nothing', async () => {
  const before = (await s.api('GET', '/payments', { token: s.tokens.admin })).body.length;
  const r = await s.api('POST', '/enterprise/payment-scenarios/run', { token: s.tokens.admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 25);
  const failed = r.body.scenarios.filter((x) => x.automated && !x.result?.pass);
  assert.deepEqual(failed.map((x) => `${x.id}: ${x.result?.detail}`), []);
  assert.equal((await s.api('GET', '/payments', { token: s.tokens.admin })).body.length, before, 'dry runs leave no payments behind');
});

test('AI assistant: cites CIS sections, emergency guidance (112), escalation creates a ticket, feedback logged', async () => {
  const t = s.tokens.cust1;
  const a = (await s.api('POST', '/ai/ask', { token: t, body: { question: 'What is not covered by my health policy?', language: 'hi' } })).body;
  assert.ok(a.evidence.length > 0);
  assert.ok(a.evidence.some((e) => /CIS/.test(e.document?.section || '')));
  assert.ok(a.policyVersions.length > 0);
  assert.equal(a.language, 'hi');
  const urgent = (await s.api('POST', '/ai/ask', { token: t, body: { question: 'My father has chest pain right now' } })).body;
  assert.match(urgent.answer, /112/);
  const med = (await s.api('POST', '/ai/ask', { token: t, body: { question: 'What medicine should I take for fever?' } })).body;
  assert.equal(med.refused, 'medical_advice');
  const c = (await s.api('POST', '/ai/ask', { token: t, body: { question: 'I want to complain, why was my claim rejected?' } })).body;
  assert.equal(c.escalation?.suggested, true);
  const esc = await s.api('POST', '/ai/escalate', { token: t, body: { interactionId: c.interactionId } });
  assert.equal(esc.status, 201);
  const fb = await s.api('POST', '/ai/feedback', { token: t, body: { interactionId: a.interactionId, rating: 'down', comment: 'Too long' } });
  assert.equal(fb.status, 200);
  assert.equal((await s.api('POST', '/ai/feedback', { token: s.tokens.cust2, body: { interactionId: a.interactionId, rating: 'up' } })).status, 404);
  const evals = (await s.api('GET', '/ai/evaluations', { token: s.tokens.compliance })).body;
  assert.equal(evals.totals.down, 1);
});

test('payment link expires; live mode refuses simulators', async () => {
  const t = s.tokens.arjun;
  const app = await acceptedHealthApplication(s, t);
  const link = (await s.api('POST', '/payments/links', { token: t, body: { purpose: 'application', applicationId: app.id, expiresInHours: 1 } })).body;
  assert.equal(link.status, 'active');
  await s.setClock({ advanceDays: 1 });
  try {
    const l2 = (await s.api('GET', `/payments/links/${link.code}`, { token: t })).body;
    assert.equal(l2.status, 'expired');
    const r = await s.api('POST', '/payments/initiate', { token: t, body: { purpose: 'application', applicationId: app.id, amount: app.offer.firstPayment, idempotencyKey: key(), linkCode: link.code } });
    assert.equal(r.status, 409);
  } finally {
    await s.setClock({ reset: true });
  }
  const p = await initiate(t, app);
  process.env.PAYMENT_MODE = 'live';
  try {
    assert.equal((await s.api('POST', `/payments/${p.reference}/upi`, { token: t, body: { vpa: 'success@razorpay' } })).status, 403);
    assert.equal((await s.api('POST', `/payments/${p.reference}/simulate`, { token: t, body: { outcome: 'success' } })).status, 403);
    assert.equal((await s.api('POST', '/payments/callback', { body: { reference: p.reference, status: 'success', amount: p.amount } })).status, 401, 'unsigned webhook refused in live mode');
  } finally {
    delete process.env.PAYMENT_MODE;
  }
});

test('data deletion request: compliance completes it, account closed, policies and claims retained', async () => {
  const t = s.tokens.meera;
  const policies = (await s.api('GET', '/policies', { token: t })).body;
  assert.ok(policies.length > 0);
  const priv = (await s.api('GET', '/enterprise/privacy', { token: t })).body;
  assert.ok(priv.consents.length > 0, 'consent records visible');
  const req = await s.api('POST', '/enterprise/privacy/requests', { token: t, body: { type: 'deletion', reason: 'No longer need the account' } });
  assert.equal(req.status, 201);
  assert.equal((await s.api('POST', '/enterprise/privacy/requests', { token: t, body: { type: 'deletion' } })).status, 409, 'one open request per type');
  const queue = (await s.api('GET', '/enterprise/compliance/data-requests', { token: s.tokens.auditor })).body;
  assert.ok(queue.some((x) => x.id === req.body.id && x.retained.policies === policies.length));
  const done = await s.api('POST', `/enterprise/compliance/data-requests/${req.body.id}/decision`, { token: s.tokens.compliance, body: { action: 'complete', note: 'Account closed; regulated records retained' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');
  assert.equal((await s.api('GET', '/auth/me', { token: t })).status, 401, 'sessions revoked');
  for (const p of policies) assert.equal((await s.api('GET', `/policies/${p.id}`, { token: s.tokens.admin })).status, 200, 'policy retained');
});

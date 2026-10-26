// Partners module: insurer onboarding gates, partner-portal tenant isolation and issuance decisions,
// quote references, distribution blocking, leads, portability decisions and read-only oversight roles.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedHealthApplication, isoAddDays, LAKH, payApplication, startServer } from './helpers.js';

let s;
let today;
before(async () => {
  s = await startServer();
  today = (await s.api('GET', '/dev/clock')).body.today;
});
after(async () => { await s?.close(); });

const STAGES = ['Prospect', 'Due Diligence', 'Legal Review', 'Agreement Signed', 'API Integration', 'Sandbox Testing', 'Certified', 'Active'];
let planSeq = 0;

async function createInsurer(body) {
  const r = await s.api('POST', '/partners/insurers', { token: s.tokens.admin, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function completeStageTasks(ins) {
  for (const t of ins.onboardingTasks.filter((x) => x.stage === ins.status && !x.done)) {
    const r = await s.api('POST', `/partners/insurers/${ins.id}/tasks/${t.id}`, { token: s.tokens.admin, body: { done: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ins = r.body;
  }
  return ins;
}
const move = (id, status, note) => s.api('POST', `/partners/insurers/${id}/status`, { token: s.tokens.admin, body: { status, note } });

/** A new health plan (copy of the individual plan's terms) created through the admin API. */
async function createPlan(name) {
  const base = (await s.api('GET', '/plans/pln_health_individual')).body;
  planSeq += 1;
  const r = await s.api('POST', '/admin/plans', { token: s.tokens.admin, body: { code: `TST-${planSeq}-${Date.now() % 100000}`, name, product: 'health', type: 'individual', description: 'Synthetic test product', config: base.config } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const agreement = () => ({ reference: 'TST-AGR-1', signedAt: today, validFrom: today, validTo: isoAddDays(today, 365), commissionBp: 1000, premiumCollection: 'Test gateway', remuneration: 'Synthetic' });

/** Walks a synthetic sandbox insurer through every onboarding stage to Active, with one authorised product. */
async function activeSyntheticInsurer(name) {
  let ins = await createInsurer({
    name, legalName: `${name} — synthetic test entity`, sandbox: true, type: 'Health (sandbox)',
    contacts: [{ name: 'Partner Admin', email: 'partner@example.test' }], irdai: { registrationNo: 'SANDBOX-TEST' },
    agreement: agreement(), integration: { type: 'in-process', adapter: 'mock-sandbox', credentialsRef: 'none (sandbox)' },
  });
  const plan = await createPlan(`${name} Care`);
  ins = (await s.api('POST', `/partners/insurers/${ins.id}/products`, { token: s.tokens.admin, body: { planId: plan.id, uin: `SBX-${plan.code}` } })).body;
  for (const next of STAGES.slice(1)) {
    ins = await completeStageTasks(ins);
    if (next === 'Certified') {
      const t = await s.api('POST', `/partners/insurers/${ins.id}/integration/test`, { token: s.tokens.admin });
      assert.equal(t.body.result.ok, true, JSON.stringify(t.body.result));
      ins = t.body.insurer;
    }
    const r = await move(ins.id, next);
    assert.equal(r.status, 200, `${next}: ${JSON.stringify(r.body)}`);
    ins = r.body;
  }
  assert.equal(ins.status, 'Active');
  return { ins, plan };
}

/** Invites a partner user for an insurer and signs them in. */
async function partnerUser(role, orgId, email) {
  const inv = await s.api('POST', '/admin/users', { token: s.tokens.admin, body: { firstName: 'Test', lastName: role.replace('_', ' '), email, role, orgId } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const pw = 'partner passphrase 7';
  assert.equal((await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.devInviteToken, password: pw, confirmPassword: pw } })).status, 200);
  return s.login(email, pw);
}

test('onboarding gates: checklist, IRDAI, agreement, certification and regulatory approval', async () => {
  let ins = await createInsurer({ name: 'Gatekeeper Test Partner', legalName: 'Gatekeeper Test Partner (synthetic test record)', contacts: [{ name: 'A', email: 'a@example.test' }] });
  assert.equal(ins.status, 'Prospect');
  assert.equal((await move(ins.id, 'Active')).status, 409, 'cannot skip stages');
  let r = await move(ins.id, 'Due Diligence');
  assert.equal(r.status, 422);
  assert.equal(r.body.details.code, 'ONBOARDING_GATE_FAILED');
  ins = await completeStageTasks(ins);
  assert.equal((await move(ins.id, 'Due Diligence')).status, 200);

  ins = await completeStageTasks((await s.api('GET', `/partners/insurers/${ins.id}`, { token: s.tokens.admin })).body);
  r = await move(ins.id, 'Legal Review');
  assert.equal(r.status, 422);
  assert.ok(r.body.details.blockedBy.includes('irdai'), 'IRDAI verification gate');
  assert.equal((await s.api('PUT', `/partners/insurers/${ins.id}`, { token: s.tokens.admin, body: { irdai: { registrationNo: 'TEST-000', verified: true } } })).status, 200);
  assert.equal((await move(ins.id, 'Legal Review')).status, 200);

  ins = await completeStageTasks((await s.api('GET', `/partners/insurers/${ins.id}`, { token: s.tokens.admin })).body);
  assert.equal((await move(ins.id, 'Agreement Signed')).status, 422, 'agreement required');
  assert.equal((await s.api('PUT', `/partners/insurers/${ins.id}`, { token: s.tokens.admin, body: { agreement: agreement() } })).status, 200);
  ins = (await move(ins.id, 'Agreement Signed')).body;
  assert.equal(ins.status, 'Agreement Signed');

  // Secrets are never stored; the sandbox simulator cannot be used by a non-sandbox insurer.
  assert.equal((await s.api('PUT', `/partners/insurers/${ins.id}`, { token: s.tokens.admin, body: { integration: { adapter: 'rest-generic', apiKey: 'abc' } } })).status, 400);
  assert.equal((await s.api('PUT', `/partners/insurers/${ins.id}`, { token: s.tokens.admin, body: { integration: { adapter: 'mock-sandbox' } } })).status, 400);

  ins = await completeStageTasks(ins);
  assert.equal((await move(ins.id, 'API Integration')).status, 422, 'needs an authorised product');
  const plan = await createPlan('Gatekeeper Health');
  await s.api('POST', `/partners/insurers/${ins.id}/products`, { token: s.tokens.admin, body: { planId: plan.id, uin: 'TST-UIN-1' } });
  ins = (await move(ins.id, 'API Integration')).body;
  ins = await completeStageTasks(ins);
  await s.api('PUT', `/partners/insurers/${ins.id}`, { token: s.tokens.admin, body: { integration: { type: 'rest-api', adapter: 'rest-generic', credentialsRef: 'vault://partners/gatekeeper' } } });
  ins = (await move(ins.id, 'Sandbox Testing')).body;
  ins = await completeStageTasks(ins);
  assert.equal((await move(ins.id, 'Certified')).status, 422, 'certification test required');
  const auto = await s.api('POST', `/partners/insurers/${ins.id}/integration/test`, { token: s.tokens.admin });
  assert.equal(auto.body.result.ok, false, 'undeployed adapter cannot pass the automated test');
  await s.api('POST', `/partners/insurers/${ins.id}/integration/certify`, { token: s.tokens.admin, body: { evidenceRef: 'UAT-REPORT-1' } });
  ins = (await move(ins.id, 'Certified')).body;
  ins = await completeStageTasks(ins);

  r = await move(ins.id, 'Active');
  assert.equal(r.status, 422);
  assert.equal(r.body.details.code, 'BLOCKED_BY_REGULATORY_APPROVAL');
  assert.match(r.body.error, /BLOCKED BY REGULATORY APPROVAL/);
  const detail = (await s.api('GET', `/partners/insurers/${ins.id}`, { token: s.tokens.admin })).body;
  assert.equal(detail.liveSales.label, 'BLOCKED BY REGULATORY APPROVAL');
  assert.equal(detail.status, 'Certified');
  assert.equal(detail.integration.credentialsRef, 'vault://partners/gatekeeper');

  const events = (await s.api('GET', '/partners/hub/events?type=INSURER_STATUS_CHANGED', { token: s.tokens.admin })).body;
  assert.ok(events.some((e) => e.subject?.id === ins.id), 'INSURER_STATUS_CHANGED published');
  assert.ok(detail.onboardingHistory.length >= 7, 'history kept');

  // Candidates are labelled and never publishable.
  const cand = (await s.api('GET', '/partners/insurers/ins_candidate_1', { token: s.tokens.admin })).body;
  assert.equal(cand.label, 'Candidate — no agreement');
  assert.equal((await s.api('PUT', '/partners/insurers/ins_candidate_1', { token: s.tokens.admin, body: { publishable: true } })).status, 409);
  const pub = (await s.api('GET', '/partners/public/insurers')).body;
  assert.ok(pub.every((i) => !i.id.startsWith('ins_candidate_')));
  assert.ok(pub.some((i) => i.id === 'ins_sandbox' && i.sandbox === true));
});

test('distribution is blocked for a Prospect insurer\'s product', async () => {
  const ins = await createInsurer({ name: 'Prospect Only Insurer', sandbox: true, contacts: [{ name: 'B', email: 'b@example.test' }] });
  const plan = await createPlan('Prospect Product');
  await s.api('POST', `/partners/insurers/${ins.id}/products`, { token: s.tokens.admin, body: { planId: plan.id, uin: 'SBX-PROSPECT-1' } });
  const r = await s.api('POST', '/applications', { token: s.tokens.arjun, body: { planId: plan.id } });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.code, 'DISTRIBUTION_BLOCKED');
  assert.match(r.body.error, /Prospect/);
  const listed = (await s.api('GET', '/plans?product=health')).body;
  assert.ok(!listed.some((p) => p.id === plan.id), 'not listed publicly');
  assert.ok(listed.every((p) => p.distribution.allowed && p.uin && p.insurer));
  const cats = (await s.api('GET', '/partners/public/categories')).body;
  assert.equal(cats.find((c) => c.key === 'individual').productCount, 1);
  assert.equal(cats.find((c) => c.key === 'maternity').productCount, 0);
  const cat = (await s.api('GET', '/partners/public/categories/top_up')).body;
  assert.equal(cat.products.length, 0);
  assert.match(cat.empty, /No authorised products/);
});

test('quotes carry a reference, validity, versioned product, source and GST split', async () => {
  const body = { planId: 'pln_health_individual', coverage: 5 * LAKH, startDate: isoAddDays(today, 1), members: [{ fullName: 'Quote Person', relationship: 'self', dob: '1990-01-01' }] };
  const q = (await s.api('POST', '/quotes/health', { body })).body;
  assert.match(q.reference, /^QT-\d{4}-\d{6}$/);
  assert.equal(q.validityDays, 7);
  assert.ok(new Date(q.expiresAt) - new Date(q.issuedAt) === 7 * 86400000);
  assert.equal(q.source, 'Sandbox insurer rating engine (synthetic)');
  assert.equal(q.productInfo.uin, 'SBX-HLT-IND-001');
  assert.equal(q.productInfo.version, q.planVersion);
  assert.equal(q.tax.gstBp, 1800);
  assert.equal(q.tax.netPremium + q.tax.gst, q.totalAnnualPremium);
  assert.ok(q.underwritingExplanation);
  const stored = (await s.api('GET', `/quotes/${q.reference}`)).body;
  assert.equal(stored.reference, q.reference);
  assert.equal(stored.members, 1);
  assert.ok(!JSON.stringify(stored).includes('Quote Person'), 'anonymous quotes keep no personal details');
  const ev = (await s.api('GET', '/partners/hub/events?type=QUOTE_CREATED', { token: s.tokens.ops })).body;
  assert.ok(ev.length >= 1);
});

test('insurer portal: own-organisation scoping, read-only insurer_user, manual issuance and decline', async () => {
  await s.setInsurerMode('manual');
  const { ins: other, plan: otherPlan } = await activeSyntheticInsurer('Second Synthetic Insurer');
  const otherAdmin = await partnerUser('insurer_admin', other.id, 'partner.admin@example.test');
  const sandboxUser = await partnerUser('insurer_user', 'ins_sandbox', 'partner.user@example.test');

  const otherApp = await acceptedHealthApplication(s, s.tokens.arjun, { planId: otherPlan.id });
  await payApplication(s, s.tokens.arjun, otherApp);
  const sbxApp = await acceptedHealthApplication(s, s.tokens.arjun);
  await payApplication(s, s.tokens.arjun, sbxApp);
  const sbxApp2 = await acceptedHealthApplication(s, s.tokens.arjun);
  await payApplication(s, s.tokens.arjun, sbxApp2);

  // ins_sandbox admin (Neha) cannot see or decide another insurer's proposal.
  const nehaList = (await s.api('GET', '/partners/portal/proposals?status=Issuance%20Pending', { token: s.tokens.neha })).body;
  assert.ok(nehaList.some((a) => a.id === sbxApp.id));
  assert.ok(!nehaList.some((a) => a.id === otherApp.id));
  assert.equal((await s.api('GET', `/partners/portal/proposals/${otherApp.id}`, { token: s.tokens.neha })).status, 404);
  assert.equal((await s.api('POST', `/partners/portal/proposals/${otherApp.id}/decision`, { token: s.tokens.neha, body: { decision: 'issued' } })).status, 404);
  assert.equal((await s.api('GET', `/partners/portal/proposals/${sbxApp.id}`, { token: otherAdmin })).status, 404);

  // insurer_user can read but not decide.
  assert.equal((await s.api('GET', `/partners/portal/proposals/${sbxApp.id}`, { token: sandboxUser })).status, 200);
  assert.equal((await s.api('POST', `/partners/portal/proposals/${sbxApp.id}/decision`, { token: sandboxUser, body: { decision: 'issued' } })).status, 403);

  // Manual issuance through the portal.
  assert.equal((await s.api('POST', `/partners/portal/proposals/${sbxApp.id}/decision`, { token: s.tokens.neha, body: { decision: 'declined' } })).status, 400, 'decline needs a reason');
  const issued = await s.api('POST', `/partners/portal/proposals/${sbxApp.id}/decision`, { token: s.tokens.neha, body: { decision: 'issued', insurerReference: 'SBX-PORTAL-1' } });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.status, 'issued');
  const app1 = (await s.api('GET', `/applications/${sbxApp.id}`, { token: s.tokens.arjun })).body;
  assert.equal(app1.status, 'Issued');
  assert.equal(app1.purchase.status, 'Issued');
  assert.equal((await s.api('POST', `/partners/portal/proposals/${sbxApp.id}/decision`, { token: s.tokens.neha, body: { decision: 'issued' } })).status, 409, 'no double issuance');

  const declined = await s.api('POST', `/partners/portal/proposals/${sbxApp2.id}/decision`, { token: s.tokens.neha, body: { decision: 'declined', reason: 'Outside sandbox underwriting appetite' } });
  assert.equal(declined.body.status, 'declined');
  const app2 = (await s.api('GET', `/applications/${sbxApp2.id}`, { token: s.tokens.arjun })).body;
  assert.equal(app2.purchase.status, 'Declined by Insurer');
  assert.ok(app2.purchase.flags.includes('Refund Pending'));
  assert.match(app2.purchase.message, /full refund initiated/);

  // The other insurer decides its own proposal; issued-policy lists hold no medical declarations.
  const own = await s.api('POST', `/partners/portal/proposals/${otherApp.id}/decision`, { token: otherAdmin, body: { decision: 'issued' } });
  assert.equal(own.status, 200);
  const pols = (await s.api('GET', '/partners/portal/policies', { token: otherAdmin })).body;
  assert.equal(pols.length, 1);
  assert.equal(pols[0].id, own.body.policyId);
  assert.ok(!('members' in pols[0]) && !JSON.stringify(pols[0]).includes('hasConditions'));
  const nehaPols = (await s.api('GET', '/partners/portal/policies', { token: s.tokens.neha })).body;
  assert.ok(!nehaPols.some((p) => p.id === own.body.policyId));
  const analytics = (await s.api('GET', '/partners/portal/analytics', { token: s.tokens.neha })).body;
  assert.ok(analytics.proposalSuccessRateBp > 0 && analytics.declinedByInsurer >= 1);
  assert.equal(analytics.quoteResponseTime.value, null);

  // Partner users never reach the registry or hub.
  assert.equal((await s.api('GET', '/partners/insurers', { token: s.tokens.neha })).status, 403);
  assert.equal((await s.api('GET', '/partners/hub', { token: s.tokens.neha })).status, 403);
  await s.setInsurerMode('auto');
});

test('wallet: qualified active sum insured, CIS/wording and e-card PDFs', async () => {
  const w = (await s.api('GET', '/partners/wallet', { token: s.tokens.cust1 })).body;
  assert.ok(w.policies.length >= 2);
  assert.match(w.activeSumInsured.qualifier, /floater/i);
  const health = w.policies.find((p) => p.product === 'health');
  assert.ok(health.uin && health.insurer.name && health.claimsContacts.length >= 1);
  const card = await s.api('GET', `/partners/wallet/policies/${health.policyId}/ecard.pdf`, { token: s.tokens.cust1 });
  assert.equal(card.status, 200);
  assert.equal(Buffer.from(card.body).subarray(0, 4).toString(), '%PDF');
  assert.equal((await s.api('GET', `/partners/wallet/policies/${health.policyId}/ecard.pdf`, { token: s.tokens.cust2 })).status, 404, 'other customers cannot fetch it');
  const cis = await s.api('GET', '/partners/products/pln_health_floater/cis.pdf');
  assert.equal(Buffer.from(cis.body).subarray(0, 4).toString(), '%PDF');
  assert.equal((await s.api('GET', '/partners/products/pln_health_floater/wording.pdf?version=99')).status, 404);
});

test('portability: only the receiving insurer decides; customers cannot approve', async () => {
  const mine = (await s.api('GET', '/partners/portability', { token: s.tokens.meera })).body;
  const demo = mine.find((p) => p.id === 'prt_demo_meera');
  assert.equal(demo.status, 'Submitted');
  assert.equal((await s.api('POST', `/partners/portability/${demo.id}/action`, { token: s.tokens.meera, body: { action: 'approve' } })).status, 403);
  assert.equal((await s.api('GET', `/partners/portability/${demo.id}`, { token: s.tokens.meera })).body.status, 'Submitted', 'never shown approved before the insurer decides');
  assert.equal((await s.api('GET', `/partners/portability/${demo.id}`, { token: s.tokens.arjun })).status, 404);

  const bad = await s.api('POST', '/partners/portability', { token: s.tokens.arjun, body: { toPlanId: 'pln_health_individual', from: { insurerName: 'X' } } });
  assert.equal(bad.status, 400);
  const created = await s.api('POST', '/partners/portability', { token: s.tokens.arjun, body: {
    toPlanId: 'pln_health_individual', from: { insurerName: 'Previous Demo Insurer (synthetic)', policyNumber: 'PDI-1', policyEndDate: isoAddDays(today, 30), continuousCoverYears: 3 },
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal((await s.api('POST', `/partners/portal/portability/${id}/action`, { token: s.tokens.neha, body: { action: 'approve' } })).status, 409, 'must review first');
  await s.api('POST', `/partners/portal/portability/${id}/action`, { token: s.tokens.neha, body: { action: 'start_review' } });
  const ok = await s.api('POST', `/partners/portal/portability/${id}/action`, { token: s.tokens.neha, body: { action: 'approve', note: 'Continuity credit 3 years' } });
  assert.equal(ok.body.status, 'Approved by Insurer');

  // A VHC admin may act only for the synthetic sandbox insurer; documents loop back through the customer.
  const docs = await s.api('POST', `/partners/portability/${demo.id}/action`, { token: s.tokens.admin, body: { action: 'request_documents', documents: ['Previous policy schedule'] } });
  assert.equal(docs.body.status, 'Documents Requested');
  const resp = await s.api('POST', `/partners/portability/${demo.id}/action`, { token: s.tokens.meera, body: { action: 'respond', note: 'Uploaded the schedule' } });
  assert.equal(resp.body.status, 'Under Insurer Review');
  assert.equal((await s.api('POST', `/partners/portability/${demo.id}/action`, { token: s.tokens.admin, body: { action: 'reject' } })).status, 400);
});

test('auditor and compliance are read-only; hub is admin/operations only', async () => {
  for (const t of [s.tokens.auditor, s.tokens.compliance]) {
    assert.equal((await s.api('GET', '/partners/insurers', { token: t })).status, 200);
    const d = await s.api('GET', '/partners/insurers/ins_sandbox', { token: t });
    assert.equal(d.status, 200);
    assert.equal(d.body.readOnly, true);
    assert.equal((await s.api('POST', '/partners/insurers', { token: t, body: { name: 'Nope' } })).status, 403);
    assert.equal((await s.api('PUT', '/partners/insurers/ins_sandbox', { token: t, body: { type: 'x' } })).status, 403);
    assert.equal((await s.api('POST', '/partners/insurers/ins_sandbox/status', { token: t, body: { status: 'Suspended', note: 'x' } })).status, 403);
    assert.equal((await s.api('POST', '/partners/hub/sandbox', { token: t, body: { issuanceMode: 'manual' } })).status, 403);
    assert.equal((await s.api('POST', '/partners/portability/prt_demo_meera/action', { token: t, body: { action: 'approve' } })).status, 403);
    assert.equal((await s.api('PATCH', '/partners/sales/leads/lead_demo_1', { token: t, body: { status: 'Won' } })).status, 403);
  }
  assert.equal((await s.api('GET', '/partners/hub', { token: s.tokens.auditor })).status, 403);
  const hub = await s.api('GET', '/partners/hub', { token: s.tokens.ops });
  assert.equal(hub.status, 200);
  const sbx = hub.body.adapters.find((a) => a.key === 'mock-sandbox');
  assert.ok(sbx.operations.find((o) => o.key === 'issuance').supported);
  assert.ok(!sbx.operations.find((o) => o.key === 'claims_intimation').supported);
  assert.equal((await s.api('POST', '/partners/insurers', { token: s.tokens.ops, body: { name: 'Ops cannot create' } })).status, 403);
  const mode = await s.api('POST', '/partners/hub/sandbox', { token: s.tokens.ops, body: { issuanceMode: 'auto' } });
  assert.equal(mode.body.issuanceMode, 'auto');
});

test('leads: validation, consent, explainable score, pipeline and rate limit', async () => {
  const good = { name: 'Lead Person', mobile: '98765 43210', email: 'lead@example.test', city: 'Hyderabad', interest: 'category:family_floater', consent: true };
  const noConsent = await s.api('POST', '/partners/leads', { body: { ...good, consent: false } });
  assert.equal(noConsent.status, 422);
  assert.ok(noConsent.body.details.fields.consent);
  const badMobile = await s.api('POST', '/partners/leads', { body: { ...good, mobile: '12345' } });
  assert.equal(badMobile.status, 422);
  assert.ok(badMobile.body.details.fields.mobile);
  const ok = await s.api('POST', '/partners/leads', { body: good });
  assert.equal(ok.status, 201);
  assert.deepEqual(Object.keys(ok.body).sort(), ['id', 'reference']);
  assert.match(ok.body.reference, /^LD-\d{4}-\d{6}$/);

  const lead = (await s.api('GET', `/partners/sales/leads/${ok.body.id}`, { token: s.tokens.sales })).body;
  assert.equal(lead.mobile, '+919876543210');
  assert.ok(lead.score.factors.length >= 3 && lead.score.total > 0);
  assert.match(lead.score.note, /commission/);
  assert.equal((await s.api('PATCH', `/partners/sales/leads/${lead.id}`, { token: s.tokens.agent, body: { assignedTo: 'usr_sales' } })).status, 400, 'agents only self-assign');
  const mineLead = await s.api('PATCH', `/partners/sales/leads/${lead.id}`, { token: s.tokens.agent, body: { assignedTo: (await s.api('GET', '/auth/me', { token: s.tokens.agent })).body.user.id, followUpAt: today } });
  assert.equal(mineLead.status, 200);
  assert.equal((await s.api('PATCH', `/partners/sales/leads/${lead.id}`, { token: s.tokens.sales, body: { status: 'Lost' } })).status, 400, 'lost needs a reason');
  assert.equal((await s.api('PATCH', `/partners/sales/leads/${lead.id}`, { token: s.tokens.sales, body: { status: 'Qualified', note: 'Family of four' } })).body.status, 'Qualified');
  const f = (await s.api('GET', '/partners/sales/funnel', { token: s.tokens.sales })).body;
  assert.deepEqual(f.stages.map((x) => x.key), ['leads', 'quotes', 'proposals', 'issued']);
  assert.equal((await s.api('GET', '/partners/sales/leads', { token: s.tokens.auditor })).status, 403);
  assert.equal((await s.api('GET', '/partners/sales/leads', { token: s.tokens.cust1 })).status, 403);

  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await s.api('POST', '/partners/leads', { body: { ...good, mobile: '9000000000' } })).status === 429;
  assert.ok(limited, 'per-IP rate limit applies');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fileForm, pdfBytes } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

test("customers cannot access another customer's policy, claim or documents", async () => {
  const pols = await s.api('GET', '/policies', { token: s.tokens.cust1 });
  const pol = pols.body[0];
  assert.equal((await s.api('GET', `/policies/${pol.id}`, { token: s.tokens.cust2 })).status, 404);
  assert.equal((await s.api('GET', `/policies/${pol.id}/pdf`, { token: s.tokens.cust2 })).status, 404);
  const claims = await s.api('GET', '/health-claims', { token: s.tokens.cust1 });
  assert.equal((await s.api('GET', `/health-claims/${claims.body[0].id}`, { token: s.tokens.cust2 })).status, 404);
  const up = await s.api('POST', '/documents', { token: s.tokens.cust1, form: fileForm({ entityType: 'healthClaim', entityId: claims.body[0].id, category: 'discharge_summary' }, pdfBytes()) });
  assert.equal(up.status, 201);
  assert.equal((await s.api('GET', `/documents/${up.body.id}/download`, { token: s.tokens.cust2 })).status, 404);
  assert.equal((await s.api('GET', `/documents/${up.body.id}/download`, { token: s.tokens.claims })).status, 200);
  assert.equal((await s.api('GET', '/health-claims', { token: s.tokens.cust2 })).body.length, 0);
});

test('document uploads reject oversized files and invalid content; agents cannot open medical reports', async () => {
  const apps = await s.api('GET', '/applications', { token: s.tokens.cust2 });
  const appId = apps.body[0].id;
  const big = Buffer.concat([pdfBytes(), Buffer.alloc(5 * 1024 * 1024 + 10)]);
  assert.equal((await s.api('POST', '/documents', { token: s.tokens.cust2, form: fileForm({ entityType: 'application', entityId: appId, category: 'medical_report' }, big) })).status, 413);
  const fake = await s.api('POST', '/documents', { token: s.tokens.cust2, form: fileForm({ entityType: 'application', entityId: appId, category: 'medical_report' }, Buffer.from('MZ not really a pdf'), 'report.pdf') });
  assert.equal(fake.status, 400);
  const ok = await s.api('POST', '/documents', { token: s.tokens.cust2, form: fileForm({ entityType: 'application', entityId: appId, category: 'medical_report' }, pdfBytes()) });
  assert.equal(ok.status, 201);
  assert.equal((await s.api('GET', `/documents/${ok.body.id}/download`, { token: s.tokens.agent })).status, 403);
  assert.equal((await s.api('GET', `/documents/${ok.body.id}/download`, { token: s.tokens.uw })).status, 200);
  const logs = await s.api('GET', '/admin/audit-logs?action=MEDICAL_DOCUMENT_ACCESSED', { token: s.tokens.admin });
  assert.ok(logs.body.some((l) => l.actorRole === 'underwriter'));
});

test('agents cannot make underwriting decisions', async () => {
  const apps = await s.api('GET', '/applications', { token: s.tokens.cust2 });
  const r = await s.api('POST', `/applications/${apps.body[0].id}/underwriting/decision`, { token: s.tokens.agent, body: { decision: 'approve' } });
  assert.equal(r.status, 403);
});

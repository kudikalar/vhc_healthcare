// Enterprise module API (mounted at /api/enterprise): command centre, finance ledgers & reconciliation,
// refunds, insurer settlements, support desk, data rights & compliance views, payment scenario catalogue
// and the public site configuration.
//
// Read-only oversight roles (auditor, compliance_officer) can read finance, command centre and audit
// views but every mutation here excludes them — the single exception is that a compliance officer
// decides customers' data-rights requests, which is that role's own regulatory duty.
import { Router } from 'express';
import { db, meta, tx } from '../db.js';
import { now } from '../clock.js';
import { authenticate, ORG_COLLECTION, READ_ONLY_ROLES, requireRole } from '../middleware/auth.js';
import { bad, notFound } from '../utils/errors.js';
import { audit } from '../services/audit.js';
import { registerJob } from '../services/jobs.js';
import { createRefund, settleRefund } from '../services/refunds.js';
import { findPayment, expireStalePayments } from '../services/enterprisePayments.js';
import {
  backfillLedger, commissionStatements, financeSummary, ledgerEntries, reconciliation, refundsView, settleInsurer, simulateGatewaySettlement,
} from '../services/enterpriseFinance.js';
import { commandCentre } from '../services/enterpriseCommand.js';
import {
  addMessage, assign, CATEGORIES, createTicket, ESCALATIONS, escalate, inboundEmail, KB_ARTICLES, loadTicket, PRIORITIES, setSla, setStatus, slaConfig,
  STATUSES, stampSlaBreaches, SUPPORT_READ_ROLES, SUPPORT_ROLES, ticketView,
} from '../services/enterpriseSupport.js';
import {
  buildExport, consentRegister, createDataRequest, decideDataRequest, REQUEST_TYPES, requestView, RETENTION_RULES, searchAudit,
} from '../services/enterpriseCompliance.js';
import { catalogue, runScenarios } from '../services/enterpriseScenarios.js';
import { publicConfig, updatePublicConfig } from '../services/enterpriseSeed.js';

// Scheduled work: payment timeouts, support SLA breach stamping, ledger backfill for legacy payments.
registerJob(() => ({ ...expireStalePayments(), ...stampSlaBreaches(), ...backfillLedger() }));

const r = Router();

// ---------------------------------------------------------------- public
r.get('/public/config', (req, res) => res.json(publicConfig()));
r.get('/support/kb', (req, res) => res.json(KB_ARTICLES.map(({ slug, title, category, body }) => ({ slug, title, category, summary: body[0] }))));
r.get('/support/kb/:slug', (req, res) => {
  const a = KB_ARTICLES.find((x) => x.slug === req.params.slug);
  if (!a) throw notFound('Article not found');
  res.json(a);
});

r.use(authenticate);

const ADMIN = requireRole('admin');
const COMMAND_READ = requireRole('admin', 'operations_admin', 'sales_manager', 'finance_manager', ...READ_ONLY_ROLES);
const FINANCE_READ = requireRole('admin', 'finance_manager', ...READ_ONLY_ROLES);
const FINANCE_WRITE = requireRole('admin', 'finance_manager');
const OVERSIGHT = requireRole('admin', ...READ_ONLY_ROLES);
const modeQ = (q) => (q.mode === 'live' ? 'live' : 'test');

r.put('/public/config', ADMIN, (req, res) => res.json(tx(() => updatePublicConfig(req.body || {}, req.user))));

/** Organisations for partner-user invitations (id + name per type). */
r.get('/orgs', requireRole('admin', 'operations_admin', 'finance_manager', ...READ_ONLY_ROLES), (req, res) => {
  const out = {};
  for (const [type, col] of Object.entries(ORG_COLLECTION)) {
    out[type] = db.all(col).map((o) => ({ id: o.id, name: o.name || o.legalName, status: o.status || (o.active === false ? 'Inactive' : 'Active'), sandbox: !!o.sandbox }));
  }
  res.json(out);
});

// ---------------------------------------------------------------- command centre
r.get('/command', COMMAND_READ, (req, res) => res.json(commandCentre({ mode: modeQ(req.query) })));

// ---------------------------------------------------------------- finance
r.get('/finance/summary', FINANCE_READ, (req, res) => {
  const { insurerId, from, to } = req.query;
  res.json(financeSummary({ mode: modeQ(req.query), insurerId: insurerId || undefined, from: from || undefined, to: to || undefined }));
});
r.get('/finance/entries', FINANCE_READ, (req, res) => res.json(ledgerEntries({ ...req.query, mode: req.query.mode === 'all' ? undefined : modeQ(req.query) })));
r.get('/finance/commission', FINANCE_READ, (req, res) => res.json(commissionStatements({ mode: modeQ(req.query), from: req.query.from, to: req.query.to })));
r.get('/finance/settlements', FINANCE_READ, (req, res) => res.json(db.all('insurerSettlements').slice().reverse()));
r.post('/finance/settlements', FINANCE_WRITE, (req, res) => {
  const { insurerId, mode, idempotencyKey, note } = req.body || {};
  if (!insurerId) throw bad('insurerId is required');
  const out = tx(() => settleInsurer(insurerId, { mode: mode || 'test', idempotencyKey, note }, req.user));
  res.status(out.duplicate ? 200 : 201).json(out);
});
r.get('/finance/refunds', FINANCE_READ, (req, res) => res.json(refundsView({ status: req.query.status, mode: req.query.mode })));
r.post('/finance/refunds', FINANCE_WRITE, (req, res) => {
  const { paymentReference, amount, reason, idempotencyKey, settleNow } = req.body || {};
  if (!paymentReference) throw bad('paymentReference is required');
  if (amount != null && !Number.isSafeInteger(amount)) throw bad('amount must be a whole number of paise');
  const refund = tx(() => {
    const payment = findPayment(paymentReference);
    const rf = createRefund(payment, { amount: amount ?? undefined, reason, idempotencyKey }, req.user);
    if (settleNow && (payment.mode || 'test') === 'test') settleRefund(rf, 'completed', { name: 'Payment Gateway (test mode)', role: 'system' });
    return rf;
  });
  res.status(201).json(refund);
});
r.post('/finance/refunds/:id/settle', FINANCE_WRITE, (req, res) => {
  const out = tx(() => {
    const rf = db.get('refunds', req.params.id);
    if (!rf) throw notFound('Refund not found');
    if ((rf.mode || 'test') !== 'test') throw bad('Live refunds are confirmed by the gateway, not simulated');
    return settleRefund(rf, req.body?.outcome || 'completed', { name: `Payment Gateway (simulated by ${req.user.name})`, role: 'system' });
  });
  res.json(out);
});
r.get('/finance/reconciliation', FINANCE_READ, (req, res) => res.json(reconciliation({ mode: modeQ(req.query) })));
r.post('/finance/gateway-settlement', FINANCE_WRITE, (req, res) => {
  const batch = tx(() => simulateGatewaySettlement({ mode: modeQ(req.body || {}), injectMismatch: !!req.body?.injectMismatch }, req.user));
  res.status(201).json(batch);
});
r.post('/finance/backfill', FINANCE_WRITE, (req, res) => res.json(tx(() => backfillLedger())));

// ---------------------------------------------------------------- support desk
const SUPPORT_WRITE = requireRole(...SUPPORT_ROLES);
const SUPPORT_READ = requireRole('customer', ...SUPPORT_READ_ROLES);

r.get('/support/meta', SUPPORT_READ, (req, res) => res.json({ categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES, escalations: ESCALATIONS, sla: slaConfig() }));
r.put('/support/sla', requireRole('admin', 'support_manager'), (req, res) => res.json(tx(() => setSla(req.body || {}, req.user))));
r.get('/support/agents', SUPPORT_WRITE, (req, res) => res.json(db.find('users', (u) => SUPPORT_ROLES.includes(u.role) && u.active).map((u) => ({ id: u.id, name: u.name, role: u.role }))));

r.get('/support/tickets', SUPPORT_READ, (req, res) => {
  const { status, category, assignee, q, breached } = req.query;
  const list = db.find('supportTickets', (t) => {
    if (req.user.role === 'customer' && t.userId !== req.user.id) return false;
    if (status && t.status !== status) return false;
    if (category && t.category !== category) return false;
    if (assignee === 'me' && t.assigneeId !== req.user.id) return false;
    if (assignee === 'none' && t.assigneeId) return false;
    if (q && !`${t.reference} ${t.subject} ${t.customerName}`.toLowerCase().includes(String(q).toLowerCase())) return false;
    return true;
  }).map((t) => ticketView(t, req.user));
  const out = breached === '1' ? list.filter((t) => t.sla.firstResponseBreached || t.sla.resolutionBreached) : list;
  res.json(out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});
r.post('/support/tickets', requireRole('customer'), (req, res) => {
  const { category, subject, message, priority, relatedRef } = req.body || {};
  const t = tx(() => createTicket({ user: req.user, category, subject, message, priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal', relatedRef }));
  res.status(201).json(ticketView(t, req.user, { withMessages: true }));
});
r.get('/support/tickets/:id', SUPPORT_READ, (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  if (req.user.role !== 'customer') tx(() => audit(req.user, 'SUPPORT_TICKET_VIEWED', 'supportTicket', t.id, { reference: t.reference }));
  res.json(ticketView(t, req.user, { withMessages: true }));
});
r.post('/support/tickets/:id/messages', requireRole('customer', ...SUPPORT_ROLES), (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  tx(() => addMessage(t, req.user, { body: req.body?.body, internal: !!req.body?.internal }));
  res.status(201).json(ticketView(t, req.user, { withMessages: true }));
});
r.post('/support/tickets/:id/close', requireRole('customer'), (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  tx(() => setStatus(t, req.user, 'closed', 'Closed by customer'));
  res.json(ticketView(t, req.user, { withMessages: true }));
});
r.post('/support/tickets/:id/status', SUPPORT_WRITE, (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  tx(() => setStatus(t, req.user, req.body?.status, req.body?.note));
  res.json(ticketView(t, req.user, { withMessages: true }));
});
r.post('/support/tickets/:id/priority', SUPPORT_WRITE, (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  if (!PRIORITIES.includes(req.body?.priority)) throw bad('Invalid priority');
  tx(() => { t.priority = req.body.priority; db.touch(t); audit(req.user, 'SUPPORT_TICKET_PRIORITY', 'supportTicket', t.id, { priority: t.priority }); });
  res.json(ticketView(t, req.user, { withMessages: true }));
});
r.post('/support/tickets/:id/assign', SUPPORT_WRITE, (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  tx(() => assign(t, req.user, req.body?.assigneeId ?? null));
  res.json(ticketView(t, req.user, { withMessages: true }));
});
r.post('/support/tickets/:id/escalate', SUPPORT_WRITE, (req, res) => {
  const t = loadTicket(req.params.id, req.user);
  tx(() => escalate(t, req.user, req.body || {}));
  res.json(ticketView(t, req.user, { withMessages: true }));
});
/** Email-to-ticket simulation (in production this is the mail provider's inbound webhook). */
r.post('/support/email-inbound', SUPPORT_WRITE, (req, res) => {
  const out = tx(() => inboundEmail(req.body || {}, req.user));
  res.status(out.threaded ? 200 : 201).json({ threaded: out.threaded, ticket: ticketView(out.ticket, req.user) });
});

// ---------------------------------------------------------------- privacy (customer data rights)
r.get('/privacy', requireRole('customer'), (req, res) => {
  const u = db.get('users', req.user.id);
  res.json({
    marketingOptIn: !!u.marketingOptIn,
    consents: db.find('consents', (c) => c.userId === req.user.id).sort((a, b) => (b.at || '').localeCompare(a.at || '')),
    requests: db.find('dataRequests', (x) => x.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(requestView),
    requestTypes: REQUEST_TYPES, retentionRules: RETENTION_RULES,
  });
});
r.post('/privacy/marketing/withdraw', requireRole('customer'), (req, res) => {
  const u = db.get('users', req.user.id);
  tx(() => {
    if (u.marketingOptIn) {
      u.marketingOptIn = false;
      db.insert('consents', { userId: u.id, type: 'marketing', granted: false, at: now().toISOString(), source: 'privacy_centre', ip: req.ip });
      db.touch(u);
    }
    audit(req.user, 'MARKETING_CONSENT_WITHDRAWN', 'user', u.id);
  });
  res.json({ marketingOptIn: false });
});
r.post('/privacy/requests', requireRole('customer'), (req, res) => {
  const rq = tx(() => createDataRequest(req.user, req.body || {}));
  res.status(201).json(requestView(rq));
});
r.get('/privacy/requests/:id/export', requireRole('customer'), (req, res) => {
  const rq = db.get('dataRequests', req.params.id);
  if (!rq || rq.userId !== req.user.id) throw notFound('Request not found');
  const data = buildExport(rq);
  tx(() => audit(req.user, 'DATA_EXPORT_DOWNLOADED', 'dataRequest', rq.id, { reference: rq.reference }));
  res.setHeader('Content-Disposition', `attachment; filename="vhc-data-export-${rq.reference}.json"`);
  res.json(data);
});

// ---------------------------------------------------------------- compliance & audit oversight
r.get('/compliance/audit', OVERSIGHT, (req, res) => res.json(searchAudit(req.query)));
r.get('/compliance/access-log', OVERSIGHT, (req, res) => res.json(searchAudit({ ...req.query, access: true })));
r.get('/compliance/consents', OVERSIGHT, (req, res) => res.json(consentRegister(req.query)));
r.get('/compliance/data-requests', OVERSIGHT, (req, res) => {
  const { status } = req.query;
  res.json(db.find('dataRequests', (x) => !status || x.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(requestView));
});
r.post('/compliance/data-requests/:id/decision', requireRole('compliance_officer', 'admin'), (req, res) => {
  res.json(requestView(tx(() => decideDataRequest(req.params.id, req.user, req.body || {}))));
});

// ---------------------------------------------------------------- payment scenario catalogue (§10)
r.get('/payment-scenarios', requireRole('admin', 'finance_manager', ...READ_ONLY_ROLES), (req, res) => res.json(catalogue()));
r.post('/payment-scenarios/run', ADMIN, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
  const run = runScenarios(req.user, ids);
  res.json({ run: { at: run.at, passed: run.passed, failed: run.failed }, ...catalogue() });
});

r.get('/settings', ADMIN, (req, res) => res.json({ enterprise: meta().enterprise || {}, publicConfig: publicConfig() }));

export default r;

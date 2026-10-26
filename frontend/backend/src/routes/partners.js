// Partners module API (mounted at /api/partners): insurer registry & onboarding, Integration Hub admin,
// insurer partner portal, marketplace catalogue/documents, policy wallet, portability and sales leads.
//
// Public:   GET  /public/insurers, /public/categories, /public/categories/:key
//           POST /leads                         { name, mobile, email?, city?, interest, consent: true } → 201 { id, reference }
//           GET  /products/:planId/cis.pdf, /products/:planId/wording.pdf  (?version=)
// Registry: GET /insurers, /insurers/:id, /insurers/:id/audit, /insurers/:id/analytics (admin, operations_admin, compliance_officer, auditor)
//           POST /insurers, PUT /insurers/:id, POST /insurers/:id/status|tasks/:taskId|integration/test|integration/certify|products|products/:planId/revoke (admin)
//           GET /categories, PUT /categories/:key (admin)
// Hub:      GET /hub, /hub/events, /hub/events/:id, /hub/exceptions, /hub/sandbox; POST /hub/events/retry, /hub/sandbox,
//           /hub/issuance/:applicationId/retry, /hub/issuance/:applicationId/decision (admin, operations_admin)
// Portal:   GET /portal/summary|proposals|proposals/:id|policies|products|analytics|portability; POST /portal/proposals/:id/decision,
//           /portal/portability/:id/action (insurer_admin; insurer_user read-only; own organisation only)
// Wallet:   GET /wallet, /wallet/policies/:id, /wallet/policies/:id/ecard.pdf
// Portability: GET/POST /portability, GET /portability/:id, POST /portability/:id/action
// Sales:    GET /sales/leads, /sales/leads/:id, /sales/funnel, /sales/team; POST /sales/leads; PATCH /sales/leads/:id
import { Router } from 'express';
import { db, meta, tx } from '../db.js';
import { authenticate, requireOrg, requireRole } from '../middleware/auth.js';
import { AppError, bad, forbidden, notFound } from '../utils/errors.js';
import { audit } from '../services/audit.js';
import { retryPendingEvents } from '../services/events.js';
import { applyIssuanceDecision, ISSUANCE_MODES, requestIssuance } from '../services/insurerHub.js';
import { APP_STATUS } from '../services/lifecycle.js';
import { assertPolicyAccess } from '../services/access.js';
import { planVersion } from '../services/pricing.js';
import {
  applyInsurerUpdate, authoriseProduct, createInsurer, insurerDetail, insurerSummary, loadInsurer, revokeProduct, runIntegrationTest,
  setTask, STATUSES, transitionInsurer,
} from '../services/partners.js';
import { categories, categoryByKey, MIS_SELLING_NOTE, planCategories, productListing } from '../services/partnersCatalog.js';
import { streamCis, streamECard, streamWording } from '../services/partnersDocs.js';
import { eventDetail, hubOverview, integrationExceptions, listEvents } from '../services/partnersHub.js';
import { insurerAnalytics, insurerPolicies, insurerProducts, insurerProposals, loadInsurerProposal, proposalView } from '../services/partnersPortal.js';
import { createPortability, customerAction, insurerAction, PORT_STATUS } from '../services/partnersPortability.js';
import { createLead, funnel, LEAD_CONSENT_TEXT, LEAD_STATUSES, leadRateLimit, leadView, loadLead, updateLead } from '../services/partnersSales.js';
import { wallet, walletEntry } from '../services/partnersWallet.js';

const r = Router();

const REGISTRY_READ = ['admin', 'operations_admin', 'compliance_officer', 'auditor'];
const HUB = ['admin', 'operations_admin'];
const SALES = ['sales_manager', 'agent', 'admin'];
const INSURER_ROLES = ['insurer_admin', 'insurer_user'];
const PORTABILITY_OVERSIGHT = ['admin', 'operations_admin', 'compliance_officer', 'auditor'];

// =====================================================================================================
// Public
// =====================================================================================================
r.get('/public/insurers', (req, res) => {
  res.json(db.find('insurers', (i) => i.publishable && i.status === 'Active' && !i.candidate).map((i) => ({ id: i.id, name: i.name, sandbox: !!i.sandbox, type: i.type || null })));
});

const publicProducts = () => db.find('plans', (p) => p.active).map(productListing).filter((x) => x.distribution.allowed);

r.get('/public/categories', (req, res) => {
  const products = publicProducts();
  res.json(categories().filter((c) => c.enabled).map((c) => ({
    key: c.key, label: c.label, description: c.description, order: c.order,
    productCount: products.filter((p) => p.categories.includes(c.key)).length,
  })));
});

r.get('/public/categories/:key', (req, res) => {
  const c = categoryByKey(req.params.key);
  if (!c || !c.enabled) throw notFound('Category not found');
  const products = publicProducts().filter((p) => p.categories.includes(c.key));
  res.json({
    key: c.key, label: c.label, description: c.description, products, rankingNote: MIS_SELLING_NOTE,
    empty: products.length === 0 ? 'No authorised products in this category yet. Leave your details and we will call you when one is available.' : null,
  });
});

r.post('/leads', (req, res) => {
  if (!leadRateLimit(req.ip || 'unknown')) throw new AppError(429, 'Too many requests. Please try again in a few minutes.');
  const lead = tx(() => createLead(req.body, { ip: req.ip, source: 'website' }));
  res.status(201).json({ id: lead.id, reference: lead.reference });
});
r.get('/leads/consent-text', (req, res) => res.json({ text: LEAD_CONSENT_TEXT }));

function productDoc(kind) {
  return (req, res) => {
    const plan = db.get('plans', req.params.planId);
    if (!plan) throw notFound('Product not found');
    const versionNo = req.query.version ? Number(req.query.version) : undefined;
    if (versionNo && !plan.versions.some((v) => v.version === versionNo)) throw notFound('Product version not found');
    (kind === 'cis' ? streamCis : streamWording)(plan, versionNo ?? planVersion(plan).version, res);
  };
}
r.get('/products/:planId/cis.pdf', productDoc('cis'));
r.get('/products/:planId/wording.pdf', productDoc('wording'));

// Everything below requires a signed-in user.
r.use(authenticate);

// =====================================================================================================
// Insurer registry & onboarding
// =====================================================================================================
const loadIns = (req) => loadInsurer(req.params.id);

r.get('/insurers', requireRole(...REGISTRY_READ), (req, res) => {
  const { status, q } = req.query;
  const list = db.find('insurers', (i) => (!status || i.status === status) && (!q || `${i.name} ${i.legalName}`.toLowerCase().includes(String(q).toLowerCase())));
  res.json({ insurers: list.map(insurerSummary).sort((a, b) => Number(b.sandbox) - Number(a.sandbox) || Number(a.candidate) - Number(b.candidate) || a.name.localeCompare(b.name)), statuses: STATUSES, readOnly: req.user.role !== 'admin' });
});

r.get('/insurers/:id', requireRole(...REGISTRY_READ), (req, res) => {
  res.json({ ...insurerDetail(loadIns(req)), readOnly: req.user.role !== 'admin' });
});

r.get('/insurers/:id/audit', requireRole(...REGISTRY_READ), (req, res) => {
  const ins = loadIns(req);
  res.json(db.find('auditLogs', (a) => a.entityType === 'insurer' && a.entityId === ins.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200));
});

r.get('/insurers/:id/analytics', requireRole(...REGISTRY_READ), (req, res) => res.json(insurerAnalytics(loadIns(req).id)));

r.post('/insurers', requireRole('admin'), (req, res) => {
  const ins = tx(() => createInsurer(req.body, req.user));
  res.status(201).json(insurerDetail(ins));
});

r.put('/insurers/:id', requireRole('admin'), (req, res) => {
  const ins = loadIns(req);
  tx(() => {
    applyInsurerUpdate(ins, req.body);
    db.touch(ins);
    audit(req.user, 'INSURER_UPDATED', 'insurer', ins.id, { fields: Object.keys(req.body || {}) });
  });
  res.json(insurerDetail(ins));
});

r.post('/insurers/:id/status', requireRole('admin'), (req, res) => {
  const ins = loadIns(req);
  tx(() => transitionInsurer(ins, req.body?.status, req.user, req.body?.note));
  res.json(insurerDetail(ins));
});

r.post('/insurers/:id/tasks/:taskId', requireRole('admin'), (req, res) => {
  const ins = loadIns(req);
  tx(() => setTask(ins, req.params.taskId, req.body || {}, req.user));
  res.json(insurerDetail(ins));
});

r.post('/insurers/:id/integration/test', requireRole(...HUB), (req, res) => {
  const ins = loadIns(req);
  const result = tx(() => runIntegrationTest(ins, req.user));
  res.json({ result, insurer: insurerDetail(ins) });
});

r.post('/insurers/:id/integration/certify', requireRole('admin'), (req, res) => {
  const ins = loadIns(req);
  const result = tx(() => runIntegrationTest(ins, req.user, { evidenceRef: req.body?.evidenceRef ?? '' }));
  res.json({ result, insurer: insurerDetail(ins) });
});

r.post('/insurers/:id/products', requireRole('admin'), (req, res) => {
  const ins = loadIns(req);
  tx(() => authoriseProduct(ins, req.body || {}, req.user));
  res.json(insurerDetail(ins));
});

r.post('/insurers/:id/products/:planId/revoke', requireRole('admin'), (req, res) => {
  const ins = loadIns(req);
  tx(() => revokeProduct(ins, req.params.planId, req.user));
  res.json(insurerDetail(ins));
});

// Configurable product categories
r.get('/categories', requireRole(...REGISTRY_READ), (req, res) => {
  const plans = db.find('plans', (p) => p.active);
  res.json(categories().map((c) => ({ ...c, products: plans.filter((p) => planCategories(p).includes(c.key)).map((p) => ({ id: p.id, name: p.name })) })));
});
r.put('/categories/:key', requireRole('admin'), (req, res) => {
  const c = categoryByKey(req.params.key);
  if (!c) throw notFound('Category not found');
  const b = req.body || {};
  tx(() => {
    if (b.label !== undefined) { if (!String(b.label).trim()) throw bad('Label is required'); c.label = String(b.label).trim().slice(0, 60); }
    if (b.description !== undefined) c.description = String(b.description).trim().slice(0, 300);
    if (b.enabled !== undefined) c.enabled = b.enabled === true;
    if (b.order !== undefined) c.order = Number(b.order) || c.order;
    db.touch(c);
    audit(req.user, 'PRODUCT_CATEGORY_UPDATED', 'productCategory', c.id, b);
  });
  res.json(c);
});

// =====================================================================================================
// Integration Hub
// =====================================================================================================
r.get('/hub', requireRole(...HUB), (req, res) => res.json(hubOverview()));
r.get('/hub/events', requireRole(...HUB), (req, res) => res.json(listEvents(req.query)));
r.get('/hub/events/:id', requireRole(...HUB), (req, res) => {
  const e = db.get('events', req.params.id);
  if (!e) throw notFound('Event not found');
  res.json(eventDetail(e));
});
r.post('/hub/events/retry', requireRole(...HUB), (req, res) => {
  const eventId = req.body?.eventId || undefined;
  if (eventId && !db.get('events', eventId)) throw notFound('Event not found');
  const out = tx(() => {
    const result = retryPendingEvents({ force: true, eventId });
    audit(req.user, eventId ? 'EVENT_REPLAYED' : 'EVENTS_RETRIED', 'event', eventId || null, result);
    return result;
  });
  res.json({ ...out, event: eventId ? eventDetail(db.get('events', eventId)) : null });
});
r.get('/hub/exceptions', requireRole(...HUB), (req, res) => res.json(integrationExceptions()));
r.get('/hub/sandbox', requireRole(...HUB), (req, res) => res.json({ ...(meta().mockInsurer || { issuanceMode: 'auto' }), modes: ISSUANCE_MODES }));
r.post('/hub/sandbox', requireRole(...HUB), (req, res) => {
  const mode = req.body?.issuanceMode;
  if (!ISSUANCE_MODES.includes(mode)) throw bad(`issuanceMode must be one of ${ISSUANCE_MODES.join(', ')}`);
  tx(() => {
    meta().mockInsurer = { ...(meta().mockInsurer || {}), issuanceMode: mode };
    audit(req.user, 'MOCK_INSURER_MODE', 'system', null, { mode });
  });
  res.json({ ...meta().mockInsurer, modes: ISSUANCE_MODES });
});
r.post('/hub/issuance/:applicationId/retry', requireRole(...HUB), (req, res) => {
  const app = db.get('applications', req.params.applicationId);
  if (!app) throw notFound('Application not found');
  if (app.status !== APP_STATUS.ISSUANCE_PENDING) throw bad(`Proposal is ${app.status}, not awaiting issuance`);
  const out = tx(() => {
    const result = requestIssuance(app, req.user);
    audit(req.user, 'ISSUANCE_REQUEST_RETRIED', 'application', app.id, { status: result.status });
    return result;
  });
  res.json({ status: out.status, policyId: out.policy?.id || null });
});
/** VHC admins may record a decision only for synthetic sandbox insurers (real insurers decide in their portal/API). */
r.post('/hub/issuance/:applicationId/decision', requireRole('admin'), (req, res) => {
  const app = db.get('applications', req.params.applicationId);
  if (!app) throw notFound('Application not found');
  const ins = db.get('insurers', db.get('plans', app.planId)?.insurerId);
  if (!ins?.sandbox) throw forbidden('Only the insurer can decide issuance for a non-sandbox product');
  const { decision, reason } = req.body || {};
  const out = tx(() => applyIssuanceDecision(app, { decision, reason, insurerReference: decision === 'issued' ? `SBX-ADMIN-${Date.now()}` : undefined }, { id: req.user.id, name: `${req.user.name} (for ${ins.name})`, role: req.user.role }));
  res.json({ status: out.status, policyId: out.policy?.id || null });
});

// =====================================================================================================
// Insurer partner portal (own organisation only)
// =====================================================================================================
const portal = [requireRole(...INSURER_ROLES), requireOrg('insurer', { allowAdmin: false })];

r.get('/portal/summary', ...portal, (req, res) => {
  const ins = db.get('insurers', req.user.orgId);
  res.json({
    insurer: { id: ins.id, name: ins.name, status: ins.status, sandbox: !!ins.sandbox, agreementValidTo: ins.agreement?.validTo || null },
    canDecide: req.user.role === 'insurer_admin',
    analytics: insurerAnalytics(ins.id),
    pendingPortability: db.find('portabilityRequests', (p) => p.toInsurerId === ins.id && [PORT_STATUS.SUBMITTED, PORT_STATUS.DOCS, PORT_STATUS.REVIEW].includes(p.status)).length,
  });
});
r.get('/portal/proposals', ...portal, (req, res) => res.json(insurerProposals(req.user.orgId, { status: req.query.status })));
r.get('/portal/proposals/:id', ...portal, (req, res) => {
  const app = loadInsurerProposal(req.user.orgId, req.params.id);
  tx(() => audit(req.user, 'PARTNER_PROPOSAL_VIEWED', 'application', app.id, { insurerId: req.user.orgId }));
  res.json(proposalView(app, { detail: true }));
});
r.post('/portal/proposals/:id/decision', ...portal, (req, res) => {
  const app = loadInsurerProposal(req.user.orgId, req.params.id);
  if (req.user.role !== 'insurer_admin') throw forbidden('Only insurer partner admins can issue or decline proposals');
  const { decision, reason, insurerReference } = req.body || {};
  if (!['issued', 'declined'].includes(decision)) throw bad('decision must be issued or declined');
  if (decision === 'declined' && !String(reason || '').trim()) throw bad('A decline reason is required');
  const out = tx(() => {
    const result = applyIssuanceDecision(app, { decision, reason, insurerReference: String(insurerReference || '').trim().slice(0, 60) || `${req.user.orgId.toUpperCase()}-${Date.now()}` }, { id: req.user.id, name: `${req.user.name} (${req.user.orgName})`, role: req.user.role });
    audit(req.user, decision === 'issued' ? 'PARTNER_ISSUED_POLICY' : 'PARTNER_DECLINED_PROPOSAL', 'application', app.id, { insurerId: req.user.orgId, reason: reason || null });
    return result;
  });
  res.json({ status: out.status, policyId: out.policy?.id || null, policyNumber: out.policy?.policyNumber || null, refund: out.refund ? { reference: out.refund.reference, status: out.refund.status } : null, proposal: proposalView(app) });
});
r.get('/portal/policies', ...portal, (req, res) => res.json(insurerPolicies(req.user.orgId)));
r.get('/portal/products', ...portal, (req, res) => res.json(insurerProducts(req.user.orgId)));
r.get('/portal/analytics', ...portal, (req, res) => res.json(insurerAnalytics(req.user.orgId)));
r.get('/portal/portability', ...portal, (req, res) => {
  res.json(db.find('portabilityRequests', (p) => p.toInsurerId === req.user.orgId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(portabilityView));
});
r.post('/portal/portability/:id/action', ...portal, (req, res) => {
  const p = db.get('portabilityRequests', req.params.id);
  if (!p || p.toInsurerId !== req.user.orgId) throw notFound('Request not found');
  tx(() => insurerAction(req.user, p, req.body || {}));
  res.json(portabilityView(p));
});

// =====================================================================================================
// Portability & migration
// =====================================================================================================
function portabilityView(p) {
  const owner = db.get('users', p.userId);
  return { ...p, customerName: owner?.name || null, toInsurerSandbox: !!db.get('insurers', p.toInsurerId)?.sandbox, decided: [PORT_STATUS.APPROVED, PORT_STATUS.REJECTED].includes(p.status) };
}
const loadPortability = (req) => {
  const p = db.get('portabilityRequests', req.params.id);
  const u = req.user;
  const visible = p && ((u.role === 'customer' && p.userId === u.id) || PORTABILITY_OVERSIGHT.includes(u.role) || (INSURER_ROLES.includes(u.role) && u.orgId === p.toInsurerId));
  if (!visible) throw notFound('Request not found');
  return p;
};

r.get('/portability', requireRole('customer', ...PORTABILITY_OVERSIGHT), (req, res) => {
  const list = req.user.role === 'customer' ? db.find('portabilityRequests', (p) => p.userId === req.user.id) : db.all('portabilityRequests');
  res.json(list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(portabilityView));
});
r.post('/portability', requireRole('customer'), (req, res) => {
  const p = tx(() => createPortability(req.user, req.body));
  res.status(201).json(portabilityView(p));
});
r.get('/portability/:id', (req, res) => res.json(portabilityView(loadPortability(req))));
r.post('/portability/:id/action', requireRole('customer', 'admin', ...INSURER_ROLES), (req, res) => {
  const p = loadPortability(req);
  const action = req.body?.action;
  tx(() => {
    if (req.user.role === 'customer') {
      if (!['respond', 'withdraw'].includes(action)) throw forbidden('Only the receiving insurer can review or decide on a portability request');
      customerAction(req.user, p, req.body || {});
    } else insurerAction(req.user, p, req.body || {});
  });
  res.json(portabilityView(p));
});

// =====================================================================================================
// Policy wallet
// =====================================================================================================
r.get('/wallet', requireRole('customer'), (req, res) => res.json(wallet(req.user.id)));
r.get('/wallet/policies/:id', (req, res) => res.json(walletEntry(assertPolicyAccess(req.user, db.get('policies', req.params.id)))));
r.get('/wallet/policies/:id/ecard.pdf', (req, res) => {
  const p = assertPolicyAccess(req.user, db.get('policies', req.params.id));
  if (p.product !== 'health') throw bad('E-cards are issued for health policies');
  tx(() => audit(req.user, 'ECARD_DOWNLOADED', 'policy', p.id, {}));
  streamECard(p, res);
});

// =====================================================================================================
// Sales leads & funnel
// =====================================================================================================
r.get('/sales/leads', requireRole(...SALES), (req, res) => {
  const { status, assignee, q, due } = req.query;
  const me = req.user;
  const list = db.find('leads', (l) => (['sales_manager', 'admin'].includes(me.role) || l.assignedTo === me.id || !l.assignedTo)
    && (!status || l.status === status)
    && (!assignee || (assignee === 'unassigned' ? !l.assignedTo : assignee === 'me' ? l.assignedTo === me.id : l.assignedTo === assignee))
    && (!q || `${l.name} ${l.reference} ${l.city || ''} ${l.interest}`.toLowerCase().includes(String(q).toLowerCase())))
    .map(leadView).filter((l) => !due || l.followUpDue);
  res.json({ leads: list.sort((a, b) => b.score.total - a.score.total || b.createdAt.localeCompare(a.createdAt)), statuses: LEAD_STATUSES, rankingNote: 'Leads are ordered by the explainable score; insurer commission is never a factor.' });
});
r.post('/sales/leads', requireRole(...SALES), (req, res) => {
  const lead = tx(() => {
    const l = createLead(req.body, { source: req.body?.source || 'phone' });
    if (req.user.role === 'agent') updateLead(req.user, l, { assignedTo: req.user.id });
    return l;
  });
  res.status(201).json(leadView(lead));
});
r.get('/sales/leads/:id', requireRole(...SALES), (req, res) => res.json(leadView(loadLead(req.user, req.params.id))));
r.patch('/sales/leads/:id', requireRole(...SALES), (req, res) => {
  const lead = loadLead(req.user, req.params.id);
  tx(() => updateLead(req.user, lead, req.body));
  res.json(leadView(lead));
});
r.get('/sales/funnel', requireRole(...SALES), (req, res) => res.json(funnel(req.query)));
r.get('/sales/team', requireRole(...SALES), (req, res) => {
  res.json(db.find('users', (u) => ['agent', 'sales_manager'].includes(u.role) && u.active && u.status === 'Active').map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

export default r;

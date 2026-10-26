// Corporate module API (mounted at /api/corporate): employer registry & onboarding, contracts, group
// quotations and policies, roster & enrolment, insurer confirmations, endorsements, billing, HR
// dashboard, wellness, support, employer analytics and the employee self-service (/benefits) endpoints.
//
// Access summary
//   admin, operations_admin ........ manage everything
//   finance_manager ................ read + billing actions
//   sales_manager .................. read; may prepare group quotations
//   compliance_officer, auditor .... read-only (any mutation → 403)
//   corporate_admin / corporate_hr . own employer only (other employers → 404); HR manages roster and
//                                    enrolment, corporate_admin additionally users and billing
//   insurer_* @ ins_sandbox ........ decide sandbox insurer confirmations, feed the claims MIS
//   customer ....................... /benefits: only their own linked membership(s)
import { Router } from 'express';
import { db } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { today } from '../clock.js';
import { publicUser, STATES } from '../services/profile.js';
import { SANDBOX_INSURER_ID } from '../services/insurerHub.js';
import {
  BILLING_ARRANGEMENTS, BILLING_FREQUENCIES, changeEmployerStatus, CONTRACT_SERVICES, CORP, createContract, createEmployer, createQuote, EMPLOYER_STATUSES,
  employerFor, employerUsers, employerView, EMPLOYMENT_TYPES, ENTITY_TYPES, FINANCE, inviteEmployerUser, isCorp, MANAGE, readOnlyGuard, SANDBOX_LABEL, scoped,
  setContractStatus, setEmployerUserActive, SUPPORT_STAFF, updateEmployer, VIEW_ALL, visibleEmployerIds,
} from '../services/corporate.js';
import { FAMILY_DEFINITIONS, GROUP_PRODUCTS } from '../services/corporateProduct.js';
import {
  addDependent, addMember, bulkSubmit, createGroupPolicy, CSV_OPTIONAL, CSV_REQUIRED, decideConfirmation, eligibilityFor, ENROL, endorsementView, enrolmentRows,
  importRoster, inviteMember, leaveMember, linkMembersForUser, openPolicies, policyView, PRO_RATA_ASSUMPTION, removeDependent, renewalQuote, renewalsDue, renewPolicy, rulesFor,
  setEnrolmentWindow, submitEnrolment, updateMember, windowOpen,
} from '../services/corporateEnrolment.js';
import { applyCreditNote, forecast, generatePolicyInvoices, generateServiceFeeInvoice, INVOICE_TYPES, ledgerFor, payInvoice, postInvoiceLedger, reconciliation, TEST_PAYMENT_METHODS } from '../services/corporateBilling.js';
import {
  announceProgramme, CLAIM_STATUSES, claimsAggregate, createProgramme, employerAnalytics, hrDashboard, MIN_COHORT, optIn, optOut, programmeView, raiseSupport,
  recordGroupClaim, respondSupport, setProgrammeStatus, SUPPORT_CATEGORIES, supportForEmployer, updateGroupClaim, WELLNESS_CONSENT_TEXT, WELLNESS_STATUSES, WELLNESS_TYPES,
} from '../services/corporateInsights.js';
import { streamCertificate, streamInvoice } from '../services/corporatePdf.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(authenticate, readOnlyGuard);

const role = (...roles) => requireRole(...roles);
const CORP_VIEW = [...VIEW_ALL, ...CORP];
const ROSTER_WRITE = [...MANAGE, ...CORP];
const INSURER_SANDBOX = (u) => ['insurer_admin', 'insurer_user'].includes(u.role) && u.orgId === SANDBOX_INSURER_ID;
const canDecideInsurer = (u) => MANAGE.includes(u.role) || INSURER_SANDBOX(u);
const qEmployer = (req) => req.query.employerId || req.body?.employerId || undefined;

// ---------- reference ----------
r.get('/meta', role(...CORP_VIEW, 'customer', 'insurer_admin', 'insurer_user'), (req, res) => res.json({
  products: GROUP_PRODUCTS, familyDefinitions: FAMILY_DEFINITIONS, employerStatuses: EMPLOYER_STATUSES, entityTypes: ENTITY_TYPES, billingArrangements: BILLING_ARRANGEMENTS,
  billingFrequencies: BILLING_FREQUENCIES, employmentTypes: EMPLOYMENT_TYPES, contractServices: CONTRACT_SERVICES, csvColumns: { required: CSV_REQUIRED, optional: CSV_OPTIONAL },
  invoiceTypes: INVOICE_TYPES, testPaymentMethods: TEST_PAYMENT_METHODS, wellnessTypes: WELLNESS_TYPES, wellnessStatuses: WELLNESS_STATUSES, supportCategories: SUPPORT_CATEGORIES,
  claimStatuses: CLAIM_STATUSES, states: STATES, minCohort: MIN_COHORT, proRataNote: PRO_RATA_ASSUMPTION, sandboxLabel: SANDBOX_LABEL,
  salesUsers: VIEW_ALL.includes(req.user.role) ? db.find('users', (u) => ['sales_manager', 'agent'].includes(u.role) && u.active).map((u) => ({ id: u.id, name: u.name, role: u.role })) : [],
  employers: VIEW_ALL.includes(req.user.role) ? db.all('employers').map((e) => ({ id: e.id, name: e.name, status: e.status })) : [],
}));

// ---------- employers ----------
r.get('/employers', role(...VIEW_ALL), (req, res) => {
  const { status, q } = req.query;
  const needle = String(q || '').toLowerCase();
  res.json(db.find('employers', (e) => (!status || e.status === status) && (!needle || `${e.name} ${e.gstin || ''} ${e.industry || ''}`.toLowerCase().includes(needle))).map((e) => employerView(e, { full: false })));
});
r.post('/employers', role(...MANAGE), (req, res) => res.status(201).json(employerView(createEmployer(req.user, req.body))));
r.get('/employer', role(...CORP), (req, res) => res.json(employerView(employerFor(req.user))));
r.get('/employers/:id', role(...CORP_VIEW), (req, res) => {
  const emp = employerFor(req.user, req.params.id);
  res.json({ ...employerView(emp), contracts: db.find('corporateContracts', (c) => c.employerId === emp.id), quotes: db.find('groupQuotes', (q) => q.employerId === emp.id).reverse() });
});
r.put('/employers/:id', role(...MANAGE), (req, res) => res.json(employerView(updateEmployer(req.user, employerFor(req.user, req.params.id), req.body))));
/** Corporate admins maintain their own billing details and HR contact. */
r.patch('/employers/:id/billing', role(...MANAGE, 'corporate_admin'), (req, res) => {
  const emp = employerFor(req.user, req.params.id, { write: true });
  res.json(employerView(updateEmployer(req.user, emp, req.body, { billingOnly: isCorp(req.user) })));
});
r.post('/employers/:id/status', role(...MANAGE), (req, res) => res.json(employerView(changeEmployerStatus(req.user, employerFor(req.user, req.params.id), req.body || {}))));

// ---------- employer users (invitations) ----------
r.get('/employers/:id/users', role(...VIEW_ALL, 'corporate_admin'), (req, res) => res.json(employerUsers(employerFor(req.user, req.params.id))));
r.post('/employers/:id/users', role(...MANAGE, 'corporate_admin'), (req, res) => {
  const emp = employerFor(req.user, req.params.id, { write: true });
  const { user, token } = inviteEmployerUser(req.user, emp, req.body);
  res.status(201).json({ user: publicUser(user), ...(process.env.NODE_ENV !== 'production' ? { devInviteToken: token } : {}) });
});
r.patch('/employers/:id/users/:userId', role(...MANAGE, 'corporate_admin'), (req, res) => {
  const emp = employerFor(req.user, req.params.id, { write: true });
  res.json(publicUser(setEmployerUserActive(req.user, emp, req.params.userId, req.body?.active)));
});

// ---------- contracts & quotations ----------
r.get('/employers/:id/contracts', role(...CORP_VIEW), (req, res) => res.json(db.find('corporateContracts', (c) => c.employerId === employerFor(req.user, req.params.id).id)));
r.post('/employers/:id/contracts', role(...MANAGE), (req, res) => res.status(201).json(createContract(req.user, employerFor(req.user, req.params.id), req.body)));
r.post('/contracts/:id/status', role(...MANAGE), (req, res) => res.json(setContractStatus(req.user, scoped(req.user, 'corporateContracts', req.params.id, 'Contract'), req.body?.status)));
r.get('/quotes', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  res.json(db.find('groupQuotes', (q) => ids.includes(q.employerId)).reverse());
});
r.post('/quotes', role(...MANAGE, 'sales_manager'), (req, res) => res.status(201).json(createQuote(req.user, employerFor(req.user, req.body?.employerId), req.body)));

// ---------- group policies ----------
r.get('/group-policies', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  res.json(db.find('groupPolicies', (p) => ids.includes(p.employerId) && (!req.query.status || p.status === req.query.status)).reverse().map(policyView));
});
r.post('/group-policies', role(...MANAGE), (req, res) => res.status(201).json(policyView(createGroupPolicy(req.user, employerFor(req.user, req.body?.employerId), req.body))));
r.get('/group-policies/:id', role(...CORP_VIEW), (req, res) => {
  const p = scoped(req.user, 'groupPolicies', req.params.id, 'Group policy');
  const confirmation = p.confirmationId ? db.get('insurerConfirmations', p.confirmationId) : null;
  res.json({ ...policyView(p), confirmation, renewal: renewalsDue([p.employerId], 120).find((x) => x.id === p.id) || null, quotes: db.find('groupQuotes', (q) => q.renewalOf === p.id).reverse() });
});
r.get('/group-policies/:id/enrolments', role(...CORP_VIEW), (req, res) => res.json(enrolmentRows(scoped(req.user, 'groupPolicies', req.params.id, 'Group policy'))));
r.post('/group-policies/:id/enrolment-window', role(...ROSTER_WRITE), (req, res) => res.json(policyView(setEnrolmentWindow(req.user, scoped(req.user, 'groupPolicies', req.params.id, 'Group policy', { write: true }), req.body || {}))));
/** HR submits enrolments to the insurer: { memberIds?: [] } (omitted → all eligible not yet enrolled). */
r.post('/group-policies/:id/enrol', role(...ROSTER_WRITE), (req, res) => {
  const p = scoped(req.user, 'groupPolicies', req.params.id, 'Group policy', { write: true });
  res.json(bulkSubmit(req.user, p, Array.isArray(req.body?.memberIds) ? req.body.memberIds : null));
});
r.post('/group-policies/:id/renewal-quote', role(...MANAGE, 'corporate_admin'), (req, res) => {
  const p = scoped(req.user, 'groupPolicies', req.params.id, 'Group policy', { write: true });
  res.status(201).json(renewalQuote(req.user, p, db.get('employers', p.employerId)));
});
r.post('/group-policies/:id/renew', role(...MANAGE), (req, res) => {
  const p = scoped(req.user, 'groupPolicies', req.params.id, 'Group policy');
  res.status(201).json(policyView(renewPolicy(req.user, p, db.get('employers', p.employerId), req.body || {})));
});
r.get('/renewals', role(...CORP_VIEW), (req, res) => res.json(renewalsDue(visibleEmployerIds(req.user, qEmployer(req)), Number(req.query.withinDays) || 90)));

// ---------- insurer confirmations (sandbox insurer step) ----------
r.get('/confirmations', (req, res) => {
  if (!VIEW_ALL.includes(req.user.role) && !INSURER_SANDBOX(req.user)) throw forbidden();
  res.json(db.find('insurerConfirmations', (c) => !req.query.status || c.status === req.query.status).reverse().map((c) => ({ ...c, employerName: db.get('employers', c.employerId)?.name || null })));
});
r.post('/confirmations/:id/decision', (req, res) => {
  if (!canDecideInsurer(req.user)) throw forbidden();
  const c = db.get('insurerConfirmations', req.params.id);
  if (!c) throw notFound('Confirmation not found');
  res.json(decideConfirmation(c, req.body || {}, req.user));
});

// ---------- roster ----------
const memberView = (m) => {
  const enrolments = db.find('groupEnrolments', (e) => e.memberId === m.id).map((e) => ({ ...e, policyNumber: db.get('groupPolicies', e.groupPolicyId)?.policyNumber }));
  return { ...m, linked: !!m.userId, dependents: db.find('groupDependents', (d) => d.memberId === m.id), enrolments };
};
r.get('/members', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  const { status, q } = req.query;
  const needle = String(q || '').toLowerCase();
  const policies = new Map();
  const statusOf = (m) => {
    const e = db.find('groupEnrolments', (x) => x.memberId === m.id).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
    return e?.status || ENROL.NOT;
  };
  res.json(db.find('groupMembers', (m) => ids.includes(m.employerId) && (!status || m.status === status) && (!needle || `${m.name} ${m.employeeId} ${m.email} ${m.grade}`.toLowerCase().includes(needle)))
    .map((m) => {
      if (!policies.has(m.employerId)) policies.set(m.employerId, openPolicies(m.employerId)[0] || null);
      const p = policies.get(m.employerId);
      return { ...m, history: undefined, linked: !!m.userId, dependents: db.find('groupDependents', (d) => d.memberId === m.id && d.status === 'Active').length, enrolmentStatus: statusOf(m), eligible: p ? eligibilityFor(p, m).eligible : null };
    }));
});
r.post('/members', role(...ROSTER_WRITE), (req, res) => res.status(201).json(memberView(addMember(req.user, employerFor(req.user, qEmployer(req), { write: true }), req.body))));
r.post('/members/import', role(...ROSTER_WRITE), (req, res) => res.json(importRoster(req.user, employerFor(req.user, qEmployer(req), { write: true }), req.body || {})));
r.get('/members/:id', role(...CORP_VIEW), (req, res) => {
  const m = scoped(req.user, 'groupMembers', req.params.id, 'Employee');
  res.json({ ...memberView(m), rules: rulesFor(m.employerId) });
});
r.patch('/members/:id', role(...ROSTER_WRITE), (req, res) => res.json(memberView(updateMember(req.user, scoped(req.user, 'groupMembers', req.params.id, 'Employee', { write: true }), req.body))));
r.post('/members/:id/leave', role(...ROSTER_WRITE), (req, res) => {
  const out = leaveMember(req.user, scoped(req.user, 'groupMembers', req.params.id, 'Employee', { write: true }), req.body || {});
  res.json({ member: memberView(out.member), endorsements: out.endorsements.map(endorsementView) });
});
r.post('/members/:id/invite', role(...ROSTER_WRITE), (req, res) => res.json(inviteMember(req.user, scoped(req.user, 'groupMembers', req.params.id, 'Employee', { write: true }))));
r.post('/members/:id/enrol', role(...ROSTER_WRITE), (req, res) => {
  const m = scoped(req.user, 'groupMembers', req.params.id, 'Employee', { write: true });
  const p = req.body?.groupPolicyId ? scoped(req.user, 'groupPolicies', req.body.groupPolicyId, 'Group policy') : openPolicies(m.employerId)[0];
  if (!p) throw notFound('No active group policy to enrol into');
  res.json(submitEnrolment(req.user, p, m));
});
r.post('/members/:id/dependents', role(...ROSTER_WRITE), (req, res) => {
  const out = addDependent(req.user, scoped(req.user, 'groupMembers', req.params.id, 'Employee', { write: true }), req.body);
  res.status(201).json({ dependent: out.dependent, endorsement: out.endorsement && endorsementView(out.endorsement) });
});
r.post('/dependents/:id/remove', role(...ROSTER_WRITE), (req, res) => {
  const out = removeDependent(req.user, scoped(req.user, 'groupDependents', req.params.id, 'Dependent', { write: true }), req.body || {});
  res.json({ dependent: out.dependent, endorsement: out.endorsement && endorsementView(out.endorsement) });
});

// ---------- enrolments & certificates ----------
r.get('/enrolments/:id', role(...CORP_VIEW), (req, res) => res.json(scoped(req.user, 'groupEnrolments', req.params.id, 'Enrolment')));
r.get('/enrolments/:id/certificate', role(...CORP_VIEW), (req, res) => {
  const e = scoped(req.user, 'groupEnrolments', req.params.id, 'Enrolment');
  if (!e.certificateNumber) throw notFound('A certificate is issued once the insurer confirms the enrolment');
  audit(req.user, 'CERTIFICATE_DOWNLOADED', 'groupEnrolment', e.id, { certificateNumber: e.certificateNumber });
  streamCertificate(e, res);
});

// ---------- endorsements ----------
r.get('/endorsements', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  res.json(db.find('endorsements', (e) => ids.includes(e.employerId) && (!req.query.status || e.status === req.query.status) && (!req.query.groupPolicyId || e.groupPolicyId === req.query.groupPolicyId)).reverse().map(endorsementView));
});
r.get('/endorsements/:id', role(...CORP_VIEW), (req, res) => {
  const en = scoped(req.user, 'endorsements', req.params.id, 'Endorsement');
  res.json({ ...endorsementView(en), confirmation: db.findOne('insurerConfirmations', (c) => c.kind === 'endorsement' && c.refId === en.id) || (en.enrolmentId && db.findOne('insurerConfirmations', (c) => c.kind === 'enrolment' && c.refId === en.enrolmentId)) || null });
});

// ---------- billing ----------
const invoiceView = (inv, user) => ({ ...inv, ledgerEntries: FINANCE.includes(user.role) || VIEW_ALL.includes(user.role) ? ledgerFor(inv) : undefined });
r.get('/invoices', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  res.json(db.find('corporateInvoices', (i) => ids.includes(i.employerId) && (!req.query.status || i.status === req.query.status)).reverse());
});
r.get('/invoices/:id', role(...CORP_VIEW), (req, res) => res.json(invoiceView(scoped(req.user, 'corporateInvoices', req.params.id, 'Invoice'), req.user)));
r.get('/invoices/:id/pdf', role(...CORP_VIEW), (req, res) => streamInvoice(scoped(req.user, 'corporateInvoices', req.params.id, 'Invoice'), res));
r.post('/group-policies/:id/invoices', role(...FINANCE), (req, res) => {
  const p = scoped(req.user, 'groupPolicies', req.params.id, 'Group policy');
  res.status(201).json(generatePolicyInvoices(req.user, p, db.get('employers', p.employerId)));
});
r.post('/employers/:id/service-fee-invoice', role(...FINANCE), (req, res) => res.status(201).json(generateServiceFeeInvoice(req.user, employerFor(req.user, req.params.id), req.body || {})));
/** Simulated test-mode payment. corporate_admin pays their own employer's invoices; finance can record receipt. */
r.post('/invoices/:id/pay', role(...FINANCE, 'corporate_admin'), (req, res) => {
  const inv = scoped(req.user, 'corporateInvoices', req.params.id, 'Invoice', { write: true });
  const out = payInvoice(req.user, inv, req.body || {});
  res.json({ invoice: out.invoice, ledgerEntries: isCorp(req.user) ? undefined : out.ledgerEntries });
});
r.post('/invoices/:id/apply-credit', role(...FINANCE), (req, res) => res.json(applyCreditNote(req.user, scoped(req.user, 'corporateInvoices', req.params.id, 'Invoice'))));
/** Re-runs the (idempotent) ledger posting for a settled invoice — used from reconciliation. */
r.post('/invoices/:id/post-ledger', role(...FINANCE), (req, res) => {
  const inv = scoped(req.user, 'corporateInvoices', req.params.id, 'Invoice');
  const entries = postInvoiceLedger(inv);
  audit(req.user, 'CORPORATE_LEDGER_REPOSTED', 'corporateInvoice', inv.id, { entries: entries.length });
  res.json({ invoice: inv, ledgerEntries: ledgerFor(inv) });
});
r.get('/reconciliation', role(...VIEW_ALL, 'corporate_admin'), (req, res) => res.json(reconciliation(visibleEmployerIds(req.user, qEmployer(req)))));
r.get('/forecast', role(...VIEW_ALL, 'corporate_admin'), (req, res) => res.json(forecast(visibleEmployerIds(req.user, qEmployer(req)))));

// ---------- HR dashboard & analytics ----------
r.get('/dashboard', role(...CORP_VIEW), (req, res) => res.json(hrDashboard(employerFor(req.user, qEmployer(req)))));
r.get('/analytics', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  const rows = ids.map((id) => employerAnalytics(db.get('employers', id)));
  res.json({ rows, minCohort: MIN_COHORT, portfolio: isCorp(req.user) ? undefined : { employers: rows.length, active: rows.filter((x) => x.status === 'Active').length, utilisation: claimsAggregate(ids) } });
});

// ---------- wellness ----------
r.get('/wellness', role(...CORP_VIEW), (req, res) => {
  const ids = visibleEmployerIds(req.user, qEmployer(req));
  res.json(db.find('wellnessProgrammes', (p) => ids.includes(p.employerId)).reverse().map((p) => ({ ...programmeView(p), employerName: db.get('employers', p.employerId)?.name })));
});
r.post('/wellness', role(...MANAGE), (req, res) => res.status(201).json(programmeView(createProgramme(req.user, employerFor(req.user, req.body?.employerId), req.body))));
r.post('/wellness/:id/status', role(...MANAGE), (req, res) => res.json(programmeView(setProgrammeStatus(req.user, scoped(req.user, 'wellnessProgrammes', req.params.id, 'Programme'), req.body?.status))));
r.post('/wellness/:id/announce', role(...ROSTER_WRITE), (req, res) => res.json(announceProgramme(req.user, scoped(req.user, 'wellnessProgrammes', req.params.id, 'Programme', { write: true }))));

// ---------- support ----------
r.get('/support', role(...CORP_VIEW, 'support_manager', 'support_agent'), (req, res) => {
  if (isCorp(req.user)) return res.json(supportForEmployer(employerFor(req.user).id));
  const ids = qEmployer(req) ? [qEmployer(req)] : null;
  res.json({ requests: db.find('corporateSupportRequests', (x) => !ids || ids.includes(x.employerId)).reverse().map((x) => ({ ...x, employerName: db.get('employers', x.employerId)?.name })) });
});
r.post('/support', role(...CORP), (req, res) => res.status(201).json(raiseSupport(req.user, { employerId: employerFor(req.user, null, { write: true }).id, source: 'employer' }, req.body)));
r.post('/support/:id/respond', role(...SUPPORT_STAFF), (req, res) => {
  const s = db.get('corporateSupportRequests', req.params.id);
  if (!s) throw notFound('Request not found');
  res.json(respondSupport(req.user, s, req.body || {}));
});

// ---------- sandbox insurer claims MIS (never exposed to employers) ----------
r.get('/group-claims', (req, res) => {
  if (!VIEW_ALL.includes(req.user.role) && !INSURER_SANDBOX(req.user)) throw forbidden();
  res.json(db.find('groupClaims', (c) => !req.query.groupPolicyId || c.groupPolicyId === req.query.groupPolicyId).reverse());
});
r.post('/group-claims', (req, res) => {
  if (!canDecideInsurer(req.user)) throw forbidden();
  res.status(201).json(recordGroupClaim(req.user, req.body));
});
r.patch('/group-claims/:id', (req, res) => {
  if (!canDecideInsurer(req.user)) throw forbidden();
  const c = db.get('groupClaims', req.params.id);
  if (!c) throw notFound('Claim not found');
  res.json(updateGroupClaim(req.user, c, req.body));
});

// =====================================================================================
// Employee self-service (/benefits) — customers see only memberships linked to their verified email
// =====================================================================================
const benefits = Router();
benefits.use(requireRole('customer'));
const ownMember = (req, id) => {
  const m = id ? db.get('groupMembers', id) : null;
  if (!m || m.userId !== req.user.id) throw notFound('Membership not found');
  return m;
};
const assertEmployerOpen = (employerId) => {
  const emp = db.get('employers', employerId);
  if (!emp || ['Suspended', 'Ended'].includes(emp.status)) throw conflict('Your employer\'s benefits account is not active. Contact your HR team.');
};
const ownEnrolment = (req, id) => {
  const e = id ? db.get('groupEnrolments', id) : null;
  if (!e) throw notFound('Enrolment not found');
  ownMember(req, e.memberId);
  return e;
};

function membershipView(m) {
  const emp = db.get('employers', m.employerId);
  const { relationships, rules } = rulesFor(m.employerId);
  const enrols = db.find('groupEnrolments', (e) => e.memberId === m.id);
  const policies = db.find('groupPolicies', (p) => p.employerId === m.employerId && ((p.status === 'Active' && p.endDate >= today()) || enrols.some((e) => e.groupPolicyId === p.id)))
    .map((p) => {
      const e = enrols.find((x) => x.groupPolicyId === p.id) || null;
      const el = eligibilityFor(p, m);
      return {
        id: p.id, policyNumber: p.policyNumber, productName: p.productName, insurerName: p.insurerName, sumInsured: p.terms.sumInsured, familyLabel: p.terms.familyLabel,
        startDate: p.startDate, endDate: p.endDate, status: p.status, waivers: p.terms.waivers, contacts: p.contacts, label: p.label, windowOpen: windowOpen(p), enrolmentWindow: p.enrolmentWindow,
        eligibility: { eligible: el.eligible, reasons: el.reasons, eligibleFrom: el.eligibleFrom },
        enrolment: e ? { id: e.id, status: e.status, coverFrom: e.coverFrom, coverTo: e.coverTo, certificateNumber: e.certificateNumber || null, rejectReason: e.rejectReason || null, lives: e.lives.map((l) => ({ name: l.name, relationship: l.relationship, dob: l.dob, coverFrom: l.coverFrom, coverTo: l.coverTo, status: l.status })), excludedLives: e.excludedLives || [] } : { id: null, status: ENROL.NOT },
        canSubmit: p.status === 'Active' && el.eligible && (!e || [ENROL.NOT, ENROL.REJECTED].includes(e.status)),
      };
    });
  const programmes = db.find('wellnessProgrammes', (p) => p.employerId === m.employerId && ['Open', 'Scheduled'].includes(p.status));
  return {
    member: { id: m.id, employeeId: m.employeeId, name: m.name, email: m.email, dob: m.dob, gender: m.gender, grade: m.grade, joiningDate: m.joiningDate, status: m.status, leavingDate: m.leavingDate },
    employer: { id: emp.id, name: emp.name, sandbox: !!emp.sandbox },
    policies,
    dependents: db.find('groupDependents', (d) => d.memberId === m.id && d.status === 'Active').map((d) => ({ id: d.id, name: d.name, relationship: d.relationship, dob: d.dob, gender: d.gender, coverStatus: d.coverStatus })),
    dependentRules: { relationships, rules },
    wellness: programmes.map((p) => {
      const mine = db.findOne('wellnessEnrolments', (w) => w.programmeId === p.id && w.memberId === m.id);
      const { participation, ...rest } = programmeView(p, { forEmployer: false }); // eslint-disable-line no-unused-vars
      return { ...rest, myStatus: mine?.status || null };
    }),
    claims: db.find('groupClaims', (c) => c.memberId === m.id).map((c) => ({ id: c.id, claimRef: c.claimRef, relationship: c.relationship, status: c.status, claimedAmount: c.claimedAmount, settledAmount: c.settledAmount, admissionDate: c.admissionDate })),
    support: db.find('corporateSupportRequests', (x) => x.memberId === m.id && x.source === 'employee').reverse(),
  };
}

benefits.get('/me', (req, res) => {
  linkMembersForUser(req.user.id);
  const u = db.get('users', req.user.id);
  const members = db.find('groupMembers', (m) => m.userId === req.user.id);
  res.json({ emailVerified: !!u?.emailVerified, email: u?.email, memberships: members.map(membershipView), consentText: WELLNESS_CONSENT_TEXT, categories: SUPPORT_CATEGORIES, label: SANDBOX_LABEL });
});
benefits.post('/members/:id/dependents', (req, res) => {
  const m = ownMember(req, req.params.id);
  assertEmployerOpen(m.employerId);
  const out = addDependent(req.user, m, req.body);
  res.status(201).json({ dependent: out.dependent, endorsement: out.endorsement ? { endorsementNumber: out.endorsement.endorsementNumber, status: out.endorsement.status, effectiveDate: out.endorsement.effectiveDate } : null });
});
benefits.post('/dependents/:id/remove', (req, res) => {
  const d = db.get('groupDependents', req.params.id);
  if (!d) throw notFound('Dependent not found');
  ownMember(req, d.memberId);
  const out = removeDependent(req.user, d, req.body || {});
  res.json({ dependent: out.dependent });
});
benefits.post('/enrolments/submit', (req, res) => {
  const m = ownMember(req, req.body?.memberId);
  const p = db.get('groupPolicies', req.body?.groupPolicyId);
  if (!p || p.employerId !== m.employerId) throw notFound('Group policy not found');
  if (req.body?.declaration !== true) throw unprocessable('Please confirm the declaration to submit your enrolment.', { fields: { declaration: 'Required.' } });
  assertEmployerOpen(m.employerId);
  const out = submitEnrolment(req.user, p, m, { source: 'employee' });
  res.json({ status: out.enrolment.status, skipped: out.skipped || null, enrolmentId: out.enrolment.id });
});
benefits.get('/enrolments/:id/certificate', (req, res) => {
  const e = ownEnrolment(req, req.params.id);
  if (!e.certificateNumber) throw notFound('A certificate is issued once the insurer confirms your enrolment');
  audit(req.user, 'CERTIFICATE_DOWNLOADED', 'groupEnrolment', e.id, { certificateNumber: e.certificateNumber, by: 'employee' });
  streamCertificate(e, res);
});
benefits.post('/support', (req, res) => {
  const m = ownMember(req, req.body?.memberId);
  res.status(201).json(raiseSupport(req.user, { employerId: m.employerId, memberId: m.id, source: 'employee' }, req.body));
});
benefits.post('/wellness/:id/opt-in', (req, res) => {
  const m = ownMember(req, req.body?.memberId);
  const p = db.get('wellnessProgrammes', req.params.id);
  if (!p) throw notFound('Programme not found');
  res.json(optIn(req.user, m, p, req.body || {}));
});
benefits.post('/wellness/:id/opt-out', (req, res) => {
  const m = ownMember(req, req.body?.memberId);
  const p = db.get('wellnessProgrammes', req.params.id);
  if (!p) throw notFound('Programme not found');
  res.json(optOut(req.user, m, p));
});
r.use('/benefits', benefits);

export default r;

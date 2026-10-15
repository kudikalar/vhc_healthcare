// Idempotent reference/demo data for the enterprise module. Called by ensureReferenceData() after a fresh
// seed (ctx.fresh === true) and at start-up on existing databases (ctx.fresh === false).
// Must upsert by fixed ids and never delete or overwrite existing records.
import { db, meta } from '../db.js';
import { now } from '../clock.js';
import { bad } from '../utils/errors.js';
import { audit } from './audit.js';
import { backfillLedger } from './enterpriseFinance.js';

const DEFAULT_PUBLIC_CONFIG = {
  brand: 'Vision Health Care',
  role: 'VHC is a technology platform that helps people compare and buy health insurance and access healthcare services. VHC is not an insurer. Insurance is solicited and issued only by the licensed entities named on each product.',
  environment: 'sandbox',
  environmentNote: 'This is a staging / sandbox environment. No live insurance is sold and no real payment is taken. All insurers, hospitals and products shown are synthetic test entities unless clearly stated otherwise.',
  irdai: { status: 'pending', registrationNo: '', category: '', validTill: '', note: 'IRDAI registration: pending / not applicable for this sandbox. VHC will display its registration category and number here once granted.' },
  contact: { email: 'support@vhc.test', phone: 'Not available in the sandbox', hours: 'In-app support tickets are answered within 4 working hours (sandbox SLA).', address: 'Sandbox environment — no customer-facing office' },
  grievanceOfficer: { name: 'To be appointed', email: 'grievance@vhc.test' },
};

export function publicConfig() {
  const c = meta().enterprise?.publicConfig || {};
  return { ...DEFAULT_PUBLIC_CONFIG, ...c, irdai: { ...DEFAULT_PUBLIC_CONFIG.irdai, ...(c.irdai || {}) }, contact: { ...DEFAULT_PUBLIC_CONFIG.contact, ...(c.contact || {}) }, grievanceOfficer: { ...DEFAULT_PUBLIC_CONFIG.grievanceOfficer, ...(c.grievanceOfficer || {}) } };
}

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/** Admin-configurable public disclosures (IRDAI registration placeholder, contact details). */
export function updatePublicConfig(body, actor) {
  const next = publicConfig();
  if (body.irdai) {
    const status = body.irdai.status ?? next.irdai.status;
    if (!['pending', 'not_applicable', 'registered'].includes(status)) throw bad('IRDAI status must be pending, not_applicable or registered');
    const registrationNo = str(body.irdai.registrationNo ?? next.irdai.registrationNo, 60);
    if (status === 'registered' && !registrationNo) throw bad('Enter the IRDAI registration number shown on the certificate');
    next.irdai = { ...next.irdai, status, registrationNo, category: str(body.irdai.category ?? next.irdai.category, 120), validTill: str(body.irdai.validTill ?? next.irdai.validTill, 20), note: str(body.irdai.note ?? next.irdai.note, 500) };
  }
  if (body.contact) for (const k of ['email', 'phone', 'hours', 'address']) if (body.contact[k] != null) next.contact[k] = str(body.contact[k]);
  if (body.grievanceOfficer) for (const k of ['name', 'email']) if (body.grievanceOfficer[k] != null) next.grievanceOfficer[k] = str(body.grievanceOfficer[k]);
  meta().enterprise ||= {};
  meta().enterprise.publicConfig = { irdai: next.irdai, contact: next.contact, grievanceOfficer: next.grievanceOfficer };
  audit(actor, 'PUBLIC_DISCLOSURES_UPDATED', 'system', null, { irdaiStatus: next.irdai.status });
  return publicConfig();
}

function ensureDemoTicket() {
  const user = db.get('users', 'usr_cust1');
  if (!user || db.get('supportTickets', 'tkt_demo_1')) return;
  const at = now().toISOString();
  const plus = (h) => new Date(now().getTime() + h * 3600000).toISOString();
  db.insert('supportTickets', {
    id: 'tkt_demo_1', reference: 'TKT-DEMO01', userId: user.id, customerName: user.name, customerEmail: user.email, category: 'payment',
    subject: 'Where can I download my premium receipt?', priority: 'normal', status: 'open', channel: 'web', relatedRef: null, source: 'seed',
    assigneeId: null, assigneeName: null, escalation: null, history: [{ at, status: 'open', by: user.name, note: 'Raised via web (demo data)' }],
    sla: { firstResponseHours: 4, resolutionHours: 72, firstResponseDueAt: plus(4), resolutionDueAt: plus(72), firstRespondedAt: null, resolvedAt: null },
  });
  db.insert('supportMessages', { id: 'tmsg_demo_1', ticketId: 'tkt_demo_1', authorId: user.id, authorName: user.name, authorRole: 'customer', body: 'I paid my family floater premium earlier this year. Where do I find the receipt and the invoice? (Demo ticket — synthetic data.)', internal: false, channel: 'web' });
}

export function ensureEnterpriseData(ctx) {
  meta().enterprise ||= {};
  meta().enterprise.sla ||= { firstResponseHours: 4, resolutionHours: 72 };
  if (meta().enterprise.premiumGstBp === undefined) meta().enterprise.premiumGstBp = 0;
  // Ledger lines for successful payments that pre-date the ledger (same idempotency keys as insurerHub).
  backfillLedger();
  if (ctx?.demo) ensureDemoTicket();
}

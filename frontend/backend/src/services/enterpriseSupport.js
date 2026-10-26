// Support desk (§44). A support ticket is a service request handled by VHC's help desk. It is NOT a
// formal grievance (VHC grievance process at /grievances, owned by the claims module) and NOT a complaint
// to the insurer or to IRDAI's Bima Bharosa portal — the UI says so wherever tickets are raised.
import { db, meta, nextSeq } from '../db.js';
import { now } from '../clock.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { audit, notify } from './audit.js';
import { publish } from './events.js';

export const CATEGORIES = {
  policy: 'Policy', payment: 'Payment', claim_help: 'Claim help', hospital: 'Hospital', corporate_employee: 'Corporate employee',
  technical: 'Technical', other: 'Other',
};
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const STATUSES = ['open', 'in_progress', 'awaiting_customer', 'escalated', 'resolved', 'closed'];
export const ESCALATIONS = { insurance_specialist: 'Insurance specialist', hospital: 'Hospital coordination', claims: 'Claims team' };
export const SUPPORT_ROLES = ['support_manager', 'support_agent', 'admin'];
export const SUPPORT_READ_ROLES = [...SUPPORT_ROLES, 'compliance_officer', 'auditor', 'operations_admin'];

export const slaConfig = () => ({ firstResponseHours: 4, resolutionHours: 72, ...(meta().enterprise?.sla || {}) });

export function setSla({ firstResponseHours, resolutionHours }, actor) {
  const f = Number(firstResponseHours);
  const r = Number(resolutionHours);
  if (!Number.isFinite(f) || f < 1 || f > 72) throw bad('First response must be between 1 and 72 hours');
  if (!Number.isFinite(r) || r < f || r > 720) throw bad('Resolution must be at least the first-response time and at most 720 hours');
  meta().enterprise ||= {};
  meta().enterprise.sla = { firstResponseHours: f, resolutionHours: r };
  audit(actor, 'SUPPORT_SLA_UPDATED', 'system', null, meta().enterprise.sla);
  return slaConfig();
}

const plusHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600000).toISOString();

/** SLA status computed from the stored due dates (breaches are also stamped by the scheduled job). */
export function slaView(t, at = now().toISOString()) {
  const s = t.sla || {};
  const frBreached = s.firstRespondedAt ? s.firstRespondedAt > s.firstResponseDueAt : at > s.firstResponseDueAt;
  const done = ['resolved', 'closed'].includes(t.status);
  const resBreached = done ? (s.resolvedAt || at) > s.resolutionDueAt : at > s.resolutionDueAt;
  return { ...s, firstResponseBreached: frBreached, resolutionBreached: resBreached };
}

export function ticketView(t, user, { withMessages = false } = {}) {
  const v = { ...t, sla: slaView(t), categoryLabel: CATEGORIES[t.category] || t.category };
  if (withMessages) {
    const staff = user && user.role !== 'customer';
    v.messages = db.find('supportMessages', (m) => m.ticketId === t.id && (staff || !m.internal)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return v;
}

/** Customers only see their own tickets; anything else is "not found" (no existence leak). */
export function loadTicket(id, user) {
  const t = db.get('supportTickets', id) || db.findOne('supportTickets', (x) => x.reference === id);
  if (!t) throw notFound('Ticket not found');
  if (user.role === 'customer' && t.userId !== user.id) throw notFound('Ticket not found');
  if (user.role !== 'customer' && !SUPPORT_READ_ROLES.includes(user.role)) throw notFound('Ticket not found');
  return t;
}

export function createTicket({ user, category, subject, message, priority = 'normal', channel = 'web', relatedRef, source }, actor = user) {
  if (!CATEGORIES[category]) throw bad('Choose a ticket category', { fields: { category: 'Choose a category.' } });
  const subj = String(subject || '').trim();
  const body = String(message || '').trim();
  const fields = {};
  if (subj.length < 4 || subj.length > 140) fields.subject = 'Enter a subject (4–140 characters).';
  if (body.length < 10 || body.length > 5000) fields.message = 'Describe the issue (10–5000 characters).';
  if (Object.keys(fields).length) throw bad('Please complete the ticket', { fields });
  if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
  const sla = slaConfig();
  const at = now().toISOString();
  const t = db.insert('supportTickets', {
    reference: `TKT-${String(nextSeq('supportTicket')).padStart(6, '0')}`, userId: user.id, customerName: user.name, customerEmail: user.email,
    category, subject: subj, priority, status: 'open', channel, relatedRef: relatedRef ? String(relatedRef).slice(0, 60) : null, source: source || null,
    assigneeId: null, assigneeName: null, escalation: null, history: [{ at, status: 'open', by: actor.name, note: `Raised via ${channel}` }],
    sla: { firstResponseHours: sla.firstResponseHours, resolutionHours: sla.resolutionHours, firstResponseDueAt: plusHours(at, sla.firstResponseHours), resolutionDueAt: plusHours(at, sla.resolutionHours), firstRespondedAt: null, resolvedAt: null },
  });
  db.insert('supportMessages', { ticketId: t.id, authorId: actor.id || null, authorName: actor.name, authorRole: actor.role || 'customer', body, internal: false, channel });
  audit(actor, 'SUPPORT_TICKET_CREATED', 'supportTicket', t.id, { reference: t.reference, category, channel });
  publish('SUPPORT_TICKET_CREATED', { ticketId: t.id }, { idempotencyKey: `ticket-created:${t.id}`, actor, subject: { type: 'supportTicket', id: t.id } });
  notify(user.id, 'Support ticket raised', `We received ${t.reference}. First response target: within ${sla.firstResponseHours} hours.`, { link: `/support/tickets/${t.id}` });
  return t;
}

const isStaffActor = (u) => u.role !== 'customer';

export function addMessage(t, actor, { body, internal = false }) {
  const text = String(body || '').trim();
  if (text.length < 1 || text.length > 5000) throw bad('Write a message (up to 5000 characters).');
  if (t.status === 'closed') throw conflict('This ticket is closed. Raise a new ticket if you need more help.');
  const staff = isStaffActor(actor);
  const m = db.insert('supportMessages', { ticketId: t.id, authorId: actor.id, authorName: actor.name, authorRole: actor.role, body: text, internal: staff && !!internal });
  if (staff && !internal) {
    if (!t.sla.firstRespondedAt) t.sla.firstRespondedAt = m.createdAt;
    if (['open', 'escalated'].includes(t.status)) t.status = 'in_progress';
    notify(t.userId, `Reply on ${t.reference}`, `${actor.name} replied to your support ticket.`, { link: `/support/tickets/${t.id}` });
  }
  if (!staff && ['awaiting_customer', 'resolved'].includes(t.status)) {
    t.status = 'open';
    t.history.push({ at: m.createdAt, status: 'open', by: actor.name, note: 'Customer replied' });
  }
  db.touch(t);
  return m;
}

export function setStatus(t, actor, status, note) {
  if (!STATUSES.includes(status)) throw bad('Invalid status');
  if (t.status === status) return t;
  const at = now().toISOString();
  t.status = status;
  if (['resolved', 'closed'].includes(status)) t.sla.resolvedAt ||= at;
  else t.sla.resolvedAt = null;
  t.history.push({ at, status, by: actor.name, note: note || null });
  db.touch(t);
  audit(actor, 'SUPPORT_TICKET_STATUS', 'supportTicket', t.id, { reference: t.reference, status });
  if (['resolved', 'awaiting_customer'].includes(status)) notify(t.userId, `${t.reference} ${status === 'resolved' ? 'resolved' : 'needs your reply'}`, note || 'Open the ticket for details.', { link: `/support/tickets/${t.id}` });
  return t;
}

export function assign(t, actor, assigneeId) {
  const a = assigneeId ? db.get('users', assigneeId) : null;
  if (assigneeId && (!a || !SUPPORT_ROLES.includes(a.role) || !a.active)) throw bad('Assign to an active support user');
  if (actor.role === 'support_agent' && assigneeId && assigneeId !== actor.id) throw bad('Support agents can only assign tickets to themselves');
  t.assigneeId = a?.id || null;
  t.assigneeName = a?.name || null;
  t.history.push({ at: now().toISOString(), status: t.status, by: actor.name, note: a ? `Assigned to ${a.name}` : 'Unassigned' });
  db.touch(t);
  audit(actor, 'SUPPORT_TICKET_ASSIGNED', 'supportTicket', t.id, { reference: t.reference, assigneeId: t.assigneeId });
  return t;
}

export function escalate(t, actor, { type, note }) {
  if (!ESCALATIONS[type]) throw bad('Choose an escalation team');
  if (!String(note || '').trim()) throw bad('Add an escalation note');
  t.escalation = { type, label: ESCALATIONS[type], note: String(note).trim(), at: now().toISOString(), by: actor.name };
  t.status = 'escalated';
  t.history.push({ at: t.escalation.at, status: 'escalated', by: actor.name, note: `Escalated to ${ESCALATIONS[type]}: ${t.escalation.note}` });
  db.touch(t);
  audit(actor, 'SUPPORT_TICKET_ESCALATED', 'supportTicket', t.id, { reference: t.reference, type });
  return t;
}

/**
 * Email-to-ticket simulation: an inbound email from a registered customer becomes a ticket, or a reply on
 * an existing ticket when the subject carries its reference (e.g. "Re: [TKT-000012] …").
 */
export function inboundEmail({ from, subject, body }, actor) {
  const email = String(from || '').trim().toLowerCase();
  const user = db.findOne('users', (u) => u.emailLower === email && u.role === 'customer');
  if (!user) throw bad('Inbound email is accepted only from a registered customer address (simulation).');
  const ref = /\[?(TKT-\d{6})\]?/.exec(String(subject || ''))?.[1];
  const existing = ref && db.findOne('supportTickets', (t) => t.reference === ref && t.userId === user.id);
  if (existing) {
    addMessage(existing, { id: user.id, name: user.name, role: 'customer' }, { body });
    audit(actor, 'SUPPORT_EMAIL_REPLY', 'supportTicket', existing.id, { reference: existing.reference });
    return { ticket: existing, threaded: true };
  }
  const ticket = createTicket({ user: { id: user.id, name: user.name, email: user.email, role: 'customer' }, category: 'other', subject: String(subject || 'Email enquiry').slice(0, 140) || 'Email enquiry', message: body, channel: 'email' }, { id: user.id, name: user.name, role: 'customer' });
  return { ticket, threaded: false };
}

/** Scheduled: stamps SLA breaches so the board and trend reflect them. */
export function stampSlaBreaches() {
  const at = now().toISOString();
  let breaches = 0;
  for (const t of db.find('supportTickets', (x) => !['resolved', 'closed'].includes(x.status))) {
    const v = slaView(t, at);
    if (v.firstResponseBreached && !t.sla.firstResponseBreachedAt) { t.sla.firstResponseBreachedAt = at; breaches += 1; }
    if (v.resolutionBreached && !t.sla.resolutionBreachedAt) { t.sla.resolutionBreachedAt = at; breaches += 1; }
  }
  return { supportSlaBreaches: breaches };
}

// ---------------------------------------------------------------- knowledge base (public)
export const KB_ARTICLES = [
  { slug: 'support-vs-grievance', title: 'Support ticket, grievance or insurer complaint — which one do I need?', category: 'Getting help', body: [
    'A support ticket is a request for help from the VHC help desk — for example a payment question, a document upload problem or help understanding your policy.',
    'A grievance is a formal complaint about VHC\'s service. Use the Grievances page; it has its own acknowledgement and resolution timelines.',
    'Decisions about your insurance cover or claims are made by the insurer. You can complain to the insurer\'s grievance officer, and if you are not satisfied, escalate through IRDAI\'s Bima Bharosa system or the Insurance Ombudsman.',
    'Raising a support ticket does not stop or replace any of these formal routes.',
  ] },
  { slug: 'payment-failed', title: 'My payment failed or is pending — what now?', category: 'Payments', body: [
    'If a payment fails you have not been charged; you can try again with another method.',
    'If a payment shows as pending, do not pay again. It will update automatically when the bank confirms. Pending payments that are never confirmed expire and are not charged.',
    'Payment confirmation and policy issuance are separate: after a successful payment the insurer decides issuance. If the insurer declines, you receive a full refund.',
  ] },
  { slug: 'refund-timelines', title: 'How refunds work', category: 'Payments', body: [
    'Refunds are made to the original payment method. You can see each refund and its status on the Payments page.',
    'Partial refunds can happen (for example a pro-rata adjustment). The total refunded can never exceed what you paid.',
  ] },
  { slug: 'cashless-basics', title: 'Cashless treatment at a network hospital', category: 'Claims', body: [
    'At a network hospital, the hospital requests pre-authorisation from the insurer/TPA. Approval is provisional until the final bill is assessed.',
    'A network listing does not guarantee approval. In an emergency get treatment first — claims can be raised afterwards.',
  ] },
  { slug: 'data-rights', title: 'Your data rights: export and deletion', category: 'Privacy', body: [
    'You can request a copy of your data or ask us to delete your account from Profile → Privacy & data.',
    'A compliance officer reviews each request. Policy, claim, payment and audit records must be retained for the period required by insurance, tax and anti-money-laundering law, so they are not deleted; we explain exactly what is retained and why.',
  ] },
  { slug: 'languages-accessibility', title: 'Language and text size', category: 'Accessibility', body: [
    'Use the language selector in the top bar to switch between English, Hindi and Telugu, and the A+ button for larger text.',
    'Legally binding documents (policy wording, disclosures) remain in English; translations are provided for convenience only.',
  ] },
];

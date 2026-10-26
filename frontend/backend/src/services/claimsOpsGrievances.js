// VHC grievances & appeals.
//
// A grievance here is a complaint about the service VHC provides as a technology platform / claims-
// assistance intermediary. It is acknowledged immediately (GRV- reference), assigned to a case owner,
// carries a response deadline from the SLA policy, a customer↔VHC message thread, insurer communication
// entries, escalation/appeal history and a resolution. VHC is neither the insurer nor the regulator: the
// guidance always points customers to the insurer's grievance officer, IRDAI Bima Bharosa and the
// Insurance Ombudsman.
import crypto from 'node:crypto';
import { db, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, forbidden, notFound } from '../utils/errors.js';
import { audit, notify } from './audit.js';
import { publish } from './events.js';
import { currentPolicy, grievanceClocks, primaryClock, rulesOf, breachesFor } from './claimsOpsSla.js';
import { GRIEVANCE_READ_ROLES } from './access.js';

export { assertGrievanceAccess } from './access.js';
export const GRIEVANCE_STAFF = ['claims_officer', 'admin', 'support_manager', 'support_agent'];
export const GRIEVANCE_READERS = GRIEVANCE_READ_ROLES;
export const GRIEVANCE_ASSIGNERS = ['claims_officer', 'admin', 'support_manager'];
export const GRIEVANCE_CATEGORIES = {
  claim: 'Claim', policy_servicing: 'Policy servicing', sales_mis_selling: 'Sales / mis-selling', refund: 'Refund', other: 'Other',
};
export const GRIEVANCE_STATUSES = ['Acknowledged', 'In Progress', 'Awaiting Customer', 'Escalated to Insurer', 'Resolved', 'Appealed', 'Closed'];
export const OUTCOMES = { upheld: 'Upheld', partially_upheld: 'Partially upheld', not_upheld: 'Not upheld', referred_to_insurer: 'Referred to insurer' };
const OPEN = ['Acknowledged', 'In Progress', 'Awaiting Customer', 'Escalated to Insurer', 'Appealed'];

export const GRIEVANCE_GUIDANCE = {
  nature: 'This is a VHC grievance about the service provided by Vision Health Care, a technology platform and claims-assistance intermediary. VHC is neither the insurer nor the regulator and cannot overturn an insurer’s decision.',
  insurer: 'A formal complaint about an insurer’s decision (for example a claim rejection, deduction or delay) should also be made to the insurer’s Grievance Redressal Officer — the contact details are in your policy document. VHC can help you prepare it.',
  escalation: [
    { name: 'IRDAI Bima Bharosa', url: 'https://bimabharosa.irdai.gov.in', text: 'If the insurer does not resolve your complaint within the prescribed time, or you are not satisfied with its reply, you can register the complaint on IRDAI’s Bima Bharosa portal.' },
    { name: 'Insurance Ombudsman', url: 'https://www.cioins.co.in', text: 'If the complaint remains unresolved, you may approach the Insurance Ombudsman for your area (Council for Insurance Ombudsmen), subject to its eligibility rules and time limits.' },
  ],
};

const isStaff = (u) => GRIEVANCE_STAFF.includes(u.role);

const openLoad = (uid) => db.find('grievances', (g) => g.ownerId === uid && OPEN.includes(g.status)).length;
const activeStaff = (roles) => db.find('users', (u) => roles.includes(u.role) && u.active !== false && u.status === 'Active');

/** Least-loaded case owner: claims grievances → claims team; others → support team (with fallbacks). */
export function pickOwner(category) {
  const tiers = category === 'claim'
    ? [['claims_officer'], ['support_manager', 'support_agent'], ['admin']]
    : [['support_agent', 'support_manager'], ['claims_officer'], ['admin']];
  for (const roles of tiers) {
    const users = activeStaff(roles).sort((a, b) => openLoad(a.id) - openLoad(b.id) || a.id.localeCompare(b.id));
    if (users.length) return users[0];
  }
  return null;
}

function addHistory(g, actor, action, note = null) {
  g.history.push({ at: now().toISOString(), action, by: actor.name, role: actor.role, note });
  db.touch(g);
}

const newMessage = (actor, from, text, internal = false) => ({ id: `msg_${crypto.randomBytes(5).toString('hex')}`, at: now().toISOString(), from, by: actor.name, role: actor.role, text, internal });

export function createGrievance(user, b = {}) {
  if (b.idempotencyKey) {
    const prior = db.findOne('grievances', (g) => g.userId === user.id && g.idempotencyKey === b.idempotencyKey);
    if (prior) return prior;
  }
  if (!GRIEVANCE_CATEGORIES[b.category]) throw bad(`category must be one of ${Object.keys(GRIEVANCE_CATEGORIES).join(', ')}`);
  const subject = String(b.subject || '').trim();
  const description = String(b.description || '').trim();
  if (!subject) throw bad('A short subject is required');
  if (subject.length > 150) throw bad('Keep the subject under 150 characters');
  if (description.length < 10) throw bad('Describe the grievance (at least 10 characters)');
  if (description.length > 5000) throw bad('Keep the description under 5,000 characters');
  let claim = null;
  let policy = null;
  if (b.claimId) {
    claim = db.get('healthClaims', b.claimId);
    if (!claim || claim.userId !== user.id) throw notFound('Claim not found');
  }
  if (b.policyId || claim) {
    policy = db.get('policies', b.policyId || claim.policyId);
    if (!policy || policy.userId !== user.id) throw notFound('Policy not found');
  }
  const sla = currentPolicy();
  const days = rulesOf(sla).grievanceDays;
  const ack = now();
  const owner = pickOwner(b.category);
  const g = db.insert('grievances', {
    reference: `GRV-${today().slice(0, 4)}-${String(nextSeq('grievance')).padStart(6, '0')}`,
    idempotencyKey: b.idempotencyKey || null, userId: user.id, customerName: user.name, category: b.category, subject, description,
    claimId: claim?.id || null, claimNumber: claim?.claimNumber || null, policyId: policy?.id || null, policyNumber: policy?.policyNumber || null,
    insurerId: policy?.insurerId || null, insurerName: policy?.insurerName || null,
    status: 'Acknowledged', acknowledgedAt: ack.toISOString(), slaPolicyId: sla?.id || null, slaPolicyVersion: sla?.version || null,
    responseDueAt: new Date(ack.getTime() + days * 86_400_000).toISOString(),
    ownerId: owner?.id || null, ownerName: owner?.name || null, ownerRole: owner?.role || null,
    messages: [], insurerComms: [], escalations: [], history: [], resolution: null, firstResolvedAt: null, appeal: null, closedAt: null,
  });
  g.messages.push(newMessage({ name: 'VHC (automated)', role: 'system' }, 'vhc', `We have received your grievance ${g.reference}. ${owner ? `${owner.name} is your case owner. ` : ''}We will respond by ${g.responseDueAt.slice(0, 10)}.`));
  addHistory(g, user, 'Created and acknowledged', `Response due ${g.responseDueAt.slice(0, 10)}`);
  if (owner) addHistory(g, { name: 'VHC (automated)', role: 'system' }, 'Assigned', owner.name);
  publish('GRIEVANCE_CREATED', { grievanceId: g.id, reference: g.reference, category: g.category, claimId: g.claimId }, { idempotencyKey: `grievance-created:${g.id}`, actor: user, subject: { type: 'grievance', id: g.id } });
  audit(user, 'GRIEVANCE_CREATED', 'grievance', g.id, { reference: g.reference, category: g.category });
  notify(user.id, 'Grievance acknowledged', `${g.reference}: we will respond by ${g.responseDueAt.slice(0, 10)}.`, { link: `/grievances/${g.id}` });
  if (owner) notify(owner.id, 'New grievance assigned', `${g.reference} · ${GRIEVANCE_CATEGORIES[g.category]} · ${subject}`, { link: `/ops/grievances/${g.id}` });
  return g;
}

/** Customer-safe or staff view with SLA clocks and guidance. */
export function grievanceView(g, user) {
  const v = structuredClone(g);
  delete v.idempotencyKey;
  if (user.role === 'customer') {
    v.messages = v.messages.filter((m) => !m.internal);
    v.insurerComms = v.insurerComms.filter((m) => m.visibleToCustomer !== false);
  }
  const clocks = grievanceClocks(g);
  v.sla = { clocks, primary: primaryClock(clocks.filter((k) => k.running)) || null, breaches: breachesFor('grievance', g.id) };
  v.categoryLabel = GRIEVANCE_CATEGORIES[g.category];
  v.guidance = GRIEVANCE_GUIDANCE;
  v.canAppeal = user.role === 'customer' && g.userId === user.id && !g.appeal && ['Resolved', 'Closed'].includes(g.status);
  v.documents = db.find('documents', (d) => d.entityType === 'grievance' && d.entityId === g.id).length;
  return v;
}

export function grievanceRow(g) {
  const clocks = grievanceClocks(g);
  const primary = primaryClock(clocks.filter((k) => k.running)) || primaryClock(clocks);
  return {
    id: g.id, reference: g.reference, category: g.category, categoryLabel: GRIEVANCE_CATEGORIES[g.category], subject: g.subject, status: g.status,
    customerName: g.customerName, claimNumber: g.claimNumber, policyNumber: g.policyNumber, ownerName: g.ownerName, responseDueAt: g.responseDueAt,
    appealed: !!g.appeal, createdAt: g.createdAt, updatedAt: g.updatedAt,
    sla: primary ? { key: primary.key, state: primary.state, dueAt: primary.dueAt, remainingMs: primary.remainingMs } : null,
  };
}

const assertOpen = (g) => { if (g.status === 'Closed') throw conflict('This grievance is closed'); };

export function addMessage(user, g, { text, internal } = {}) {
  const body = String(text || '').trim();
  if (!body) throw bad('Message text is required');
  if (body.length > 5000) throw bad('Keep messages under 5,000 characters');
  assertOpen(g);
  if (user.role === 'customer') {
    if (internal) throw forbidden('Customers cannot post internal notes');
    g.messages.push(newMessage(user, 'customer', body));
    if (g.status === 'Awaiting Customer') { g.status = 'In Progress'; addHistory(g, user, 'Customer replied'); } else db.touch(g);
    if (g.ownerId) notify(g.ownerId, 'Customer replied to a grievance', `${g.reference}: ${body.slice(0, 120)}`, { link: `/ops/grievances/${g.id}` });
  } else {
    if (!isStaff(user)) throw forbidden();
    g.messages.push(newMessage(user, 'vhc', body, !!internal));
    if (!internal) {
      if (g.status === 'Acknowledged') { g.status = 'In Progress'; addHistory(g, user, 'First response sent'); } else db.touch(g);
      notify(g.userId, 'Update on your grievance', `${g.reference}: ${body.slice(0, 160)}`, { link: `/grievances/${g.id}` });
    } else db.touch(g);
  }
  audit(user, internal ? 'GRIEVANCE_INTERNAL_NOTE' : 'GRIEVANCE_MESSAGE', 'grievance', g.id, { from: user.role });
  return g;
}

export function assignGrievance(actor, g, ownerId) {
  if (!GRIEVANCE_ASSIGNERS.includes(actor.role)) throw forbidden('Only claims officers, support managers and administrators can reassign grievances');
  assertOpen(g);
  const owner = db.get('users', ownerId);
  if (!owner || !GRIEVANCE_STAFF.includes(owner.role) || owner.status !== 'Active') throw bad('Choose an active claims or support team member');
  const prev = g.ownerName;
  Object.assign(g, { ownerId: owner.id, ownerName: owner.name, ownerRole: owner.role });
  addHistory(g, actor, 'Reassigned', `${prev || 'Unassigned'} → ${owner.name}`);
  audit(actor, 'GRIEVANCE_ASSIGNED', 'grievance', g.id, { ownerId: owner.id });
  notify(owner.id, 'Grievance assigned to you', `${g.reference} · ${g.subject}`, { link: `/ops/grievances/${g.id}` });
  return g;
}

export function setGrievanceStatus(actor, g, status, note) {
  if (!['In Progress', 'Awaiting Customer'].includes(status)) throw bad('status must be In Progress or Awaiting Customer');
  assertOpen(g);
  if (['Resolved'].includes(g.status)) throw conflict('Resolved grievances can only be closed or appealed');
  g.status = status;
  addHistory(g, actor, `Status: ${status}`, note || null);
  audit(actor, 'GRIEVANCE_STATUS_CHANGED', 'grievance', g.id, { status });
  if (status === 'Awaiting Customer') notify(g.userId, 'We need information from you', `${g.reference}: ${note || 'Please reply in the grievance thread.'}`, { type: 'warning', link: `/grievances/${g.id}` });
  return g;
}

export function addGrievanceInsurerComm(actor, g, b = {}) {
  assertOpen(g);
  const subject = String(b.subject || '').trim();
  if (!subject) throw bad('Subject is required');
  const entry = {
    at: now().toISOString(), direction: b.direction === 'inbound' ? 'inbound' : 'outbound', channel: String(b.channel || 'Email (sandbox)').slice(0, 60),
    subject, message: String(b.message || '').trim() || null, insurerRef: String(b.insurerRef || '').trim() || null, by: actor.name, visibleToCustomer: b.visibleToCustomer !== false,
  };
  g.insurerComms.push(entry);
  addHistory(g, actor, `Insurer communication (${entry.direction})`, subject);
  audit(actor, 'GRIEVANCE_INSURER_COMM', 'grievance', g.id, { direction: entry.direction, subject });
  return g;
}

export function escalateGrievance(actor, g, { level, note } = {}) {
  assertOpen(g);
  const text = String(note || '').trim();
  if (!['insurer', 'internal'].includes(level)) throw bad('level must be insurer or internal');
  if (!text) throw bad('An escalation note is required');
  g.escalations.push({ at: now().toISOString(), level, note: text, by: actor.name });
  if (level === 'insurer') {
    g.status = 'Escalated to Insurer';
    g.insurerComms.push({ at: now().toISOString(), direction: 'outbound', channel: 'Insurer grievance desk (sandbox)', subject: `Escalation of ${g.reference}`, message: text, insurerRef: null, by: actor.name, visibleToCustomer: true });
    notify(g.userId, 'Grievance escalated to the insurer', `${g.reference}: we have taken this up with ${g.insurerName || 'the insurer'}. You may also complain directly to the insurer's grievance officer.`, { link: `/grievances/${g.id}` });
  }
  addHistory(g, actor, level === 'insurer' ? 'Escalated to insurer' : 'Escalated internally', text);
  audit(actor, 'GRIEVANCE_ESCALATED', 'grievance', g.id, { level });
  return g;
}

export function resolveGrievance(actor, g, { summary, outcome, documentIds = [] } = {}) {
  assertOpen(g);
  if (g.status === 'Resolved') throw conflict('Grievance is already resolved');
  const text = String(summary || '').trim();
  if (text.length < 10) throw bad('A resolution summary (at least 10 characters) is required');
  if (!OUTCOMES[outcome]) throw bad(`outcome must be one of ${Object.keys(OUTCOMES).join(', ')}`);
  const docs = (Array.isArray(documentIds) ? documentIds : []).map((id) => {
    const d = db.get('documents', id);
    if (!d || d.entityType !== 'grievance' || d.entityId !== g.id) throw bad('Resolution documents must be attached to this grievance');
    return { id: d.id, filename: d.filename };
  });
  const t = now().toISOString();
  const resolution = { at: t, by: actor.name, byId: actor.id, summary: text, outcome, outcomeLabel: OUTCOMES[outcome], documents: docs, stage: g.appeal ? 'appeal' : 'initial' };
  if (g.appeal) Object.assign(g.appeal, { resolvedAt: t, resolution });
  else g.firstResolvedAt = t;
  g.resolution = resolution;
  g.status = 'Resolved';
  g.messages.push(newMessage(actor, 'vhc', `Resolution (${OUTCOMES[outcome]}): ${text}`));
  addHistory(g, actor, g.appeal ? 'Appeal resolved' : 'Resolved', OUTCOMES[outcome]);
  audit(actor, 'GRIEVANCE_RESOLVED', 'grievance', g.id, { outcome, stage: resolution.stage });
  notify(g.userId, 'Grievance resolved', `${g.reference}: ${OUTCOMES[outcome]}. ${g.appeal ? 'This was the outcome of your appeal.' : 'If you disagree, you can appeal once.'}`, { link: `/grievances/${g.id}` });
  return g;
}

export function appealGrievance(user, g, { reason } = {}) {
  if (user.role !== 'customer' || g.userId !== user.id) throw notFound('Grievance not found');
  if (g.appeal) throw conflict('An appeal has already been made for this grievance');
  if (!['Resolved', 'Closed'].includes(g.status)) throw conflict('You can appeal once the grievance has been resolved');
  const text = String(reason || '').trim();
  if (text.length < 10) throw bad('Explain why you disagree with the resolution (at least 10 characters)');
  const sla = db.get('slaPolicies', g.slaPolicyId) || currentPolicy();
  const at = now();
  g.appeal = { at: at.toISOString(), reason: text, dueAt: new Date(at.getTime() + rulesOf(sla).grievanceDays * 86_400_000).toISOString(), resolvedAt: null, resolution: null };
  g.status = 'Appealed';
  g.closedAt = null;
  g.messages.push(newMessage(user, 'customer', `Appeal: ${text}`));
  addHistory(g, user, 'Appealed', text);
  audit(user, 'GRIEVANCE_APPEALED', 'grievance', g.id, {});
  for (const u of new Set([g.ownerId, ...activeStaff(['support_manager']).map((x) => x.id)].filter(Boolean))) notify(u, 'Grievance appealed', `${g.reference}: the customer has appealed the resolution.`, { type: 'warning', link: `/ops/grievances/${g.id}` });
  return g;
}

export function closeGrievance(user, g, { note } = {}) {
  if (g.status === 'Closed') throw conflict('Grievance is already closed');
  if (user.role === 'customer') {
    if (g.userId !== user.id) throw notFound('Grievance not found');
  } else if (!isStaff(user)) throw forbidden();
  if (g.status !== 'Resolved') throw conflict('Only a resolved grievance can be closed');
  g.status = 'Closed';
  g.closedAt = now().toISOString();
  addHistory(g, user, user.role === 'customer' ? 'Closed by customer (resolution accepted)' : 'Closed', String(note || '').trim() || null);
  audit(user, 'GRIEVANCE_CLOSED', 'grievance', g.id, {});
  if (user.role !== 'customer') notify(g.userId, 'Grievance closed', `${g.reference} has been closed. ${g.appeal ? '' : 'You can still appeal the resolution once.'} If you remain dissatisfied with the insurer, see the escalation guidance on the grievance page.`, { link: `/grievances/${g.id}` });
  return g;
}

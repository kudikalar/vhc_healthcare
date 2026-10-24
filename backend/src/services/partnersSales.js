// Partners module — sales leads, pipeline and funnel (spec §35).
//
// Public lead capture requires explicit consent and is rate limited per IP. Lead scores are explainable:
// every point comes from a listed factor about the customer's need or engagement. Commission or insurer
// remuneration is never a scoring or ranking factor (mis-selling guard).
import crypto from 'node:crypto';
import { db, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { bad, notFound, unprocessable } from '../utils/errors.js';
import { addDays, diffDays, isValidDate } from '../utils/dates.js';
import { audit, notify } from './audit.js';
import { registerJob } from './jobs.js';
import { categoryByKey } from './partnersCatalog.js';
import { APP_STATUS as S } from './lifecycle.js';

export const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
export const LEAD_CONSENT_TEXT = 'I agree that Vision Health Care may contact me by phone, SMS or email about health insurance options. I can withdraw this consent at any time.';
export const SCORE_NOTE = 'Score = sum of the listed factors (0–100). It reflects the customer\'s stated need and engagement only; commission or insurer remuneration is never used.';
const OPEN = ['New', 'Contacted', 'Qualified', 'Proposal'];

// ---------- rate limit (public endpoint) ----------
const WINDOW_MS = 15 * 60 * 1000;
export const LEAD_LIMIT = 20;
const hits = new Map(); // ip -> [timestamps]
export function leadRateLimit(ip) {
  const t = Date.now();
  const list = (hits.get(ip) || []).filter((x) => t - x < WINDOW_MS);
  list.push(t);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < WINDOW_MS)) hits.delete(k);
  return list.length <= LEAD_LIMIT;
}

// ---------- validation ----------
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
export function normaliseMobile(v) {
  const digits = String(v ?? '').replace(/[\s\-()]/g, '').replace(/^\+?91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export function validateLead(body) {
  const b = body || {};
  const fields = {};
  const name = str(b.name, 100);
  if (name.length < 2 || !/^[\p{L}][\p{L}\s.'-]*$/u.test(name)) fields.name = 'Enter your name (letters only).';
  const mobile = normaliseMobile(b.mobile);
  if (!mobile) fields.mobile = 'Enter a valid 10-digit Indian mobile number.';
  const email = str(b.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email address.';
  const city = str(b.city, 60);
  const interest = str(b.interest, 100);
  if (!interest) fields.interest = 'Tell us what cover you are interested in.';
  if (b.consent !== true) fields.consent = 'Consent is required so we can contact you.';
  if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields, errors: Object.values(fields) });
  return { name, mobile, email: email || null, city: city || null, interest };
}

// ---------- scoring ----------
/** Explainable lead score: [{ factor, points }] with a total clamped to 0–100. */
export function scoreLead(lead, at = today()) {
  const f = [];
  const add = (factor, points) => points && f.push({ factor, points });
  add('Consent to contact recorded', lead.consent?.given ? 10 : 0);
  add('Email provided', lead.email ? 10 : 0);
  add('City provided (local network relevance)', lead.city ? 5 : 0);
  const key = lead.interest?.startsWith('category:') ? lead.interest.slice(9) : lead.interest;
  add('Specific product interest', categoryByKey(key) || /health|floater|senior|term|life|top-?up|critical|accident|maternity|opd/i.test(lead.interest || '') ? 15 : 5);
  const age = diffDays(lead.createdAt.slice(0, 10), at);
  add(age <= 2 ? 'Fresh enquiry (≤ 2 days)' : age <= 7 ? 'Recent enquiry (≤ 7 days)' : 'Older enquiry', age <= 2 ? 20 : age <= 7 ? 10 : 0);
  add(`Pipeline stage: ${lead.status}`, { Contacted: 10, Qualified: 20, Proposal: 30, Won: 40 }[lead.status] || 0);
  if (lead.followUpAt && lead.followUpAt < at && OPEN.includes(lead.status)) add('Follow-up overdue', -10);
  if (lead.duplicateOf) add('Possible duplicate enquiry', -10);
  const total = Math.max(0, Math.min(100, f.reduce((t, x) => t + x.points, 0)));
  return { total, factors: f, note: SCORE_NOTE };
}

export function leadView(lead) {
  const assignee = lead.assignedTo ? db.get('users', lead.assignedTo) : null;
  return {
    ...lead, score: scoreLead(lead), assignee: assignee ? { id: assignee.id, name: assignee.name, role: assignee.role } : null,
    followUpDue: !!(lead.followUpAt && lead.followUpAt <= today() && OPEN.includes(lead.status)),
  };
}

export function createLead(body, { ip, source = 'website' } = {}) {
  const v = validateLead(body);
  const since = addDays(today(), -1);
  const dup = db.findOne('leads', (l) => l.mobile === v.mobile && l.createdAt.slice(0, 10) >= since);
  const lead = db.insert('leads', {
    ...v, reference: `LD-${today().slice(0, 4)}-${String(nextSeq('lead')).padStart(6, '0')}`, status: 'New', source: str(source, 40) || 'website',
    consent: { given: true, at: now().toISOString(), text: LEAD_CONSENT_TEXT }, assignedTo: null, followUpAt: null,
    notes: [], history: [{ at: now().toISOString(), status: 'New', by: 'Website', note: `Lead captured (${v.interest})` }],
    duplicateOf: dup?.id || null, ipHash: ip ? crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16) : null,
  });
  audit({ name: 'Public website', role: 'public' }, 'LEAD_CREATED', 'lead', lead.id, { reference: lead.reference, interest: lead.interest });
  return lead;
}

export const canSeeLead = (user, lead) => ['sales_manager', 'admin'].includes(user.role) || (user.role === 'agent' && (lead.assignedTo === user.id || !lead.assignedTo));
export const loadLead = (user, id) => {
  const lead = db.get('leads', id);
  if (!lead || !canSeeLead(user, lead)) throw notFound('Lead not found');
  return lead;
};

export function updateLead(user, lead, body) {
  const b = body || {};
  const changes = {};
  if (b.status !== undefined) {
    if (!LEAD_STATUSES.includes(b.status)) throw bad(`status must be one of ${LEAD_STATUSES.join(', ')}`);
    if (b.status === 'Lost' && !str(b.note)) throw bad('Record why the lead was lost');
    if (b.status !== lead.status) {
      changes.status = [lead.status, b.status];
      lead.history.push({ at: now().toISOString(), from: lead.status, status: b.status, by: user.name, note: str(b.note, 300) || null });
      lead.status = b.status;
    }
  }
  if (b.assignedTo !== undefined) {
    if (user.role === 'agent' && b.assignedTo !== user.id) throw bad('Sales executives can only assign leads to themselves');
    const a = b.assignedTo ? db.get('users', b.assignedTo) : null;
    if (b.assignedTo && (!a || !['agent', 'sales_manager'].includes(a.role) || !a.active)) throw bad('Assign to an active sales executive or sales manager');
    changes.assignedTo = [lead.assignedTo, a?.id || null];
    lead.assignedTo = a?.id || null;
    lead.history.push({ at: now().toISOString(), status: lead.status, by: user.name, note: a ? `Assigned to ${a.name}` : 'Unassigned' });
    if (a && a.id !== user.id) notify(a.id, 'Lead assigned to you', `${lead.reference} — ${lead.name} (${lead.interest})`, { link: '/sales' });
  }
  if (b.followUpAt !== undefined) {
    if (b.followUpAt && !isValidDate(b.followUpAt)) throw bad('followUpAt must be a date (YYYY-MM-DD)');
    lead.followUpAt = b.followUpAt || null;
    changes.followUpAt = lead.followUpAt;
  }
  if (b.note && b.status === undefined) lead.notes.push({ at: now().toISOString(), by: user.name, note: str(b.note, 1000) });
  db.touch(lead);
  audit(user, 'LEAD_UPDATED', 'lead', lead.id, changes);
  return lead;
}

/** Conversion funnel. Lead stages come from the pipeline; quotes/proposals/issued are platform-wide counts for the same period. */
export function funnel({ from, to } = {}) {
  const inRange = (iso) => (!from || iso.slice(0, 10) >= from) && (!to || iso.slice(0, 10) <= to);
  const leads = db.find('leads', (l) => inRange(l.createdAt));
  const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, leads.filter((l) => l.status === s).length]));
  const quotes = db.find('quotes', (q) => inRange(q.createdAt)).length;
  const proposals = db.find('applications', (a) => a.submittedAt && inRange(a.submittedAt) && !a.renewalOf).length;
  const issued = db.find('policies', (p) => inRange(p.issuedAt) && !p.renewalOf).length;
  return {
    period: { from: from || null, to: to || null },
    stages: [
      { key: 'leads', label: 'Leads', count: leads.length },
      { key: 'quotes', label: 'Quotes', count: quotes },
      { key: 'proposals', label: 'Proposals submitted', count: proposals },
      { key: 'issued', label: 'Policies issued', count: issued },
    ],
    pipeline: byStatus,
    wonRateBp: leads.length ? Math.round((byStatus.Won * 10000) / leads.length) : null,
    note: 'Quotes, proposals and issued policies are platform-wide counts for the period (anonymous quotes included); leads are not yet linked one-to-one to quotes.',
    awaitingIssuance: db.find('applications', (a) => a.status === S.ISSUANCE_PENDING).length,
  };
}

// Daily follow-up reminders for assigned leads (deduplicated per lead per day).
registerJob(() => {
  let n = 0;
  const t = today();
  for (const l of db.all('leads')) {
    if (!l.assignedTo || !l.followUpAt || l.followUpAt > t || !OPEN.includes(l.status)) continue;
    if (notify(l.assignedTo, 'Lead follow-up due', `${l.reference} — ${l.name}: follow-up was due ${l.followUpAt}.`, { type: 'warning', link: '/sales', dedupeKey: `lead-followup:${l.id}:${t}` })) n++;
  }
  return n ? { leadFollowUpReminders: n } : {};
});

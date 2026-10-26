// Regulatory turnaround (TAT) tracking for claims and grievances.
//
// SLA rules live in the versioned `slaPolicies` collection. A claim or grievance pins the policy version
// in effect when it started (`slaPolicyId`); records created before pinning existed fall back to the
// version effective at their createdAt, so publishing a new version never changes running clocks.
//
// Clocks are computed from the record's own timestamps (claim timeline / request fields) against now()
// from clock.js, so the dev test clock and backdated timestamps both work. Time spent waiting for the
// customer's documents is excluded when the policy says so (pauseOnCustomerDocuments).
import { db } from '../db.js';
import { now } from '../clock.js';
import { bad } from '../utils/errors.js';
import { audit, notify, raiseException } from './audit.js';

export const SLA_SOURCE = 'IRDAI health insurance master circular baseline — verify current amendments with compliance';
export const DEFAULT_RULES = Object.freeze({
  preauthMinutes: 60, // cashless pre-authorisation decision, from request
  finalAuthMinutes: 180, // cashless final authorisation, from discharge / final-bill request
  settlementDays: 15, // claim settlement, from the last necessary document
  grievanceDays: 14, // grievance resolution, from acknowledgement
  pauseOnCustomerDocuments: true,
  atRiskPct: 40, // a running clock is "at risk" when this % (or less) of the allowed time remains
});
const MIN = 60_000;
const DAY = 86_400_000;
export const CLAIMS_TEAM_ROLES = ['claims_officer', 'admin'];
const SYSTEM = { id: 'system', role: 'system', name: 'SLA monitor' };

// ---------------- policy versions ----------------
export const slaPolicies = () => [...db.all('slaPolicies')].sort((a, b) => a.version - b.version);

/** The policy version in effect at an ISO timestamp (earliest version if the time predates all of them). */
export function policyAt(iso) {
  const list = slaPolicies();
  if (!list.length) return null;
  const eligible = list.filter((p) => p.effectiveFrom <= iso);
  return eligible.length ? eligible[eligible.length - 1] : list[0];
}
export const currentPolicy = () => policyAt(now().toISOString());

const FALLBACK = { id: null, version: 0, rules: DEFAULT_RULES, source: SLA_SOURCE };
/** The policy a record runs under: its pinned version, else the version effective when it was created. */
export function policyFor(rec) {
  const pinned = rec?.slaPolicyId && db.get('slaPolicies', rec.slaPolicyId);
  return pinned || policyAt(rec?.createdAt || now().toISOString()) || FALLBACK;
}
export const rulesOf = (policy) => ({ ...DEFAULT_RULES, ...(policy?.rules || {}) });

function positiveInt(v, name, max) {
  if (!Number.isInteger(v) || v <= 0 || v > max) throw bad(`${name} must be a whole number between 1 and ${max}`);
  return v;
}

export function validateRules(input = {}, base = DEFAULT_RULES) {
  const r = { ...base, ...input };
  return {
    preauthMinutes: positiveInt(r.preauthMinutes, 'preauthMinutes', 7 * 24 * 60),
    finalAuthMinutes: positiveInt(r.finalAuthMinutes, 'finalAuthMinutes', 7 * 24 * 60),
    settlementDays: positiveInt(r.settlementDays, 'settlementDays', 365),
    grievanceDays: positiveInt(r.grievanceDays, 'grievanceDays', 365),
    pauseOnCustomerDocuments: r.pauseOnCustomerDocuments !== false,
    atRiskPct: positiveInt(r.atRiskPct, 'atRiskPct', 99),
  };
}

/** Creates the next policy version. Existing claims/grievances keep the version they started under. */
export function createSlaPolicyVersion(actor, body = {}) {
  const prev = slaPolicies().at(-1);
  const rules = validateRules(body.rules || {}, prev ? rulesOf(prev) : DEFAULT_RULES);
  let effectiveFrom = now().toISOString();
  if (body.effectiveFrom) {
    const d = new Date(body.effectiveFrom);
    if (Number.isNaN(d.getTime())) throw bad('effectiveFrom must be a valid date/time');
    effectiveFrom = d.toISOString();
  }
  const changeNote = String(body.changeNote || '').trim();
  if (!changeNote) throw bad('Describe the reason for this SLA policy change (changeNote)');
  const version = (prev?.version || 0) + 1;
  const rec = db.insert('slaPolicies', {
    id: `sla_v${version}`, version, effectiveFrom, rules, source: String(body.source || '').trim() || SLA_SOURCE,
    changeNote, createdBy: actor.name, createdById: actor.id,
  });
  audit(actor, 'SLA_POLICY_VERSION_CREATED', 'slaPolicy', rec.id, { version, effectiveFrom, rules, previousVersion: prev?.version || null });
  return rec;
}

// ---------------- clocks ----------------
/** Intervals [startMs, endMs|null] during which the timeline sat in one of `statuses`. */
export function pauseIntervals(timeline = [], statuses = ['Documents Requested']) {
  const out = [];
  let open = null;
  for (const t of [...timeline].sort((a, b) => a.at.localeCompare(b.at))) {
    const inPause = statuses.includes(t.status);
    if (inPause && open == null) open = Date.parse(t.at);
    else if (!inPause && open != null) {
      out.push([open, Date.parse(t.at)]);
      open = null;
    }
  }
  if (open != null) out.push([open, null]);
  return out;
}

/**
 * One SLA clock. state: not_started | running | at_risk | paused | breached | met | breached_closed.
 * dueAt moves out by any paused time (the clock stops while waiting on the customer).
 */
export function computeClock({ key, label, startAt, stopAt = null, durationMs, pauses = [], atRiskPct = DEFAULT_RULES.atRiskPct, owner = null }) {
  const base = { key, label, owner, durationMs, startAt: startAt || null, stopAt: stopAt || null };
  if (!startAt) return { ...base, state: 'not_started', dueAt: null, elapsedMs: 0, remainingMs: durationMs, pausedMs: 0, breached: false, running: false, paused: false };
  const nowMs = now().getTime();
  const start = Date.parse(startAt);
  const end = stopAt ? Date.parse(stopAt) : nowMs;
  let pausedMs = 0;
  let pausedNow = false;
  for (const [a, b] of pauses) {
    const s = Math.max(a, start);
    const e = Math.min(b ?? nowMs, end);
    if (e > s) pausedMs += e - s;
    if (!stopAt && b == null && a <= nowMs) pausedNow = true;
  }
  const elapsedMs = Math.max(0, end - start - pausedMs);
  const remainingMs = durationMs - elapsedMs;
  const breached = elapsedMs > durationMs;
  let state;
  if (stopAt) state = breached ? 'breached_closed' : 'met';
  else if (breached) state = 'breached';
  else if (pausedNow) state = 'paused';
  else if (remainingMs <= (durationMs * atRiskPct) / 100) state = 'at_risk';
  else state = 'running';
  return {
    ...base, dueAt: new Date(start + durationMs + pausedMs).toISOString(), elapsedMs, remainingMs, pausedMs,
    breached, running: !stopAt, paused: pausedNow, state,
  };
}

const firstAt = (tl, pred) => tl.find(pred)?.at || null;
const lastAt = (tl, pred) => [...tl].reverse().find(pred)?.at || null;

/**
 * Request/decision timestamps for a health claim. Explicit `claim.requests` values (recorded by the claim
 * flows from now on) win; older claims are derived from their timeline and decision records.
 */
export function claimTimestamps(c) {
  const tl = [...(c.timeline || [])].sort((a, b) => a.at.localeCompare(b.at));
  const r = c.requests || {};
  const submittedAt = r.submittedAt || tl[0]?.at || c.createdAt;
  const finalBillRequestedAt = r.finalBillRequestedAt || c.finalBill?.at || null;
  const rejectedAt = c.rejection?.at || null;
  const approvedAt = c.assessment?.approvedAt || null;
  const preauthRequestedAt = c.type === 'cashless' ? r.preauthRequestedAt || firstAt(tl, (t) => t.status === 'Preauth Requested') || submittedAt : null;
  const preauthDecidedAt = c.type === 'cashless'
    ? r.preauthDecidedAt || c.preauth?.at || (rejectedAt && !finalBillRequestedAt ? rejectedAt : null)
    : null;
  const finalBillDecidedAt = finalBillRequestedAt
    ? r.finalBillDecidedAt || (approvedAt && approvedAt >= finalBillRequestedAt ? approvedAt : null) || (rejectedAt && rejectedAt >= finalBillRequestedAt ? rejectedAt : null)
    : null;
  const lastDocumentAt = r.lastDocumentAt || lastAt(tl, (t) => t.from === 'Documents Requested') || null;
  const settledAt = r.settledAt || lastAt(tl, (t) => t.status === 'Settled') || null;
  return {
    intimatedAt: r.intimatedAt || null, submittedAt, preauthRequestedAt, preauthDecidedAt, finalBillRequestedAt, finalBillDecidedAt,
    lastDocumentAt, decidedAt: approvedAt || rejectedAt, approvedAt, rejectedAt, settledAt, closedAt: c.closedAt || null,
  };
}

/** All SLA clocks that apply to a health claim, under the policy version it started with. */
export function claimClocks(c) {
  const policy = policyFor(c);
  const rules = rulesOf(policy);
  const ts = claimTimestamps(c);
  const pauses = rules.pauseOnCustomerDocuments ? pauseIntervals(c.timeline) : [];
  const common = { pauses, atRiskPct: rules.atRiskPct };
  const clocks = [];
  if (c.type === 'cashless') {
    clocks.push(computeClock({ ...common, key: 'preauth', label: 'Cashless pre-authorisation decision', owner: c.tpaId ? 'TPA' : 'Insurer', startAt: ts.preauthRequestedAt, stopAt: ts.preauthDecidedAt, durationMs: rules.preauthMinutes * MIN }));
    if (ts.finalBillRequestedAt) {
      clocks.push(computeClock({ ...common, key: 'final_auth', label: 'Cashless final authorisation (discharge)', owner: c.tpaId ? 'TPA' : 'Insurer', startAt: ts.finalBillRequestedAt, stopAt: ts.finalBillDecidedAt, durationMs: rules.finalAuthMinutes * MIN }));
    }
  }
  // Settlement: reimbursement from the last necessary document; cashless from final authorisation.
  const settleStart = c.type === 'cashless'
    ? (ts.approvedAt && ts.finalBillRequestedAt ? ts.approvedAt : null)
    : [ts.submittedAt, ts.lastDocumentAt].filter(Boolean).sort().at(-1);
  const settleStop = ts.settledAt || (settleStart && ts.rejectedAt && ts.rejectedAt >= settleStart ? ts.rejectedAt : null);
  if (c.type !== 'cashless' || settleStart) {
    clocks.push(computeClock({ ...common, key: 'settlement', label: 'Claim settlement (from last necessary document)', owner: 'Insurer', startAt: settleStart, stopAt: settleStop, durationMs: rules.settlementDays * DAY }));
  }
  return clocks.map((k) => ({ ...k, policyVersion: policy.version, policyId: policy.id }));
}

/** The clock that matters most right now (running ones first, most urgent first). */
export function primaryClock(clocks) {
  const rank = { breached: 0, at_risk: 1, paused: 2, running: 3, breached_closed: 4, met: 5, not_started: 6 };
  return [...clocks].sort((a, b) => rank[a.state] - rank[b.state] || (a.remainingMs - b.remainingMs))[0] || null;
}

/** Resolution clock(s) for a grievance (a customer appeal starts a fresh clock). */
export function grievanceClocks(g) {
  const policy = policyFor(g);
  const rules = rulesOf(policy);
  const durationMs = rules.grievanceDays * DAY;
  const clocks = [computeClock({ key: 'grievance', label: 'Grievance resolution', owner: 'VHC claims assistance', startAt: g.acknowledgedAt || g.createdAt, stopAt: g.firstResolvedAt || g.resolution?.at || (g.closedAt && !g.appeal ? g.closedAt : null), durationMs, atRiskPct: rules.atRiskPct })];
  if (g.appeal) {
    clocks.push(computeClock({ key: 'appeal', label: 'Appeal resolution', owner: 'VHC claims assistance', startAt: g.appeal.at, stopAt: g.appeal.resolvedAt || (g.status === 'Closed' ? g.closedAt : null), durationMs, atRiskPct: rules.atRiskPct }));
  }
  return clocks.map((k) => ({ ...k, policyVersion: policy.version, policyId: policy.id }));
}

// ---------------- breach detection ----------------
const activeUsers = (roles) => db.find('users', (u) => roles.includes(u.role) && u.active !== false && u.status === 'Active');

function recordBreach(entityType, rec, clk, ref, recipients, link) {
  if (db.findOne('slaBreaches', (b) => b.entityType === entityType && b.entityId === rec.id && b.clock === clk.key)) return 0;
  const breach = db.insert('slaBreaches', {
    entityType, entityId: rec.id, reference: ref, clock: clk.key, label: clk.label, startAt: clk.startAt, dueAt: clk.dueAt,
    detectedAt: now().toISOString(), policyVersion: clk.policyVersion, owner: clk.owner, closedLate: !clk.running,
  });
  raiseException('sla_breach', rec.id, `${ref}: ${clk.label} SLA breached (due ${clk.dueAt})`, { entityType, clock: clk.key, breachId: breach.id, policyVersion: clk.policyVersion });
  audit(SYSTEM, 'SLA_BREACH_RECORDED', entityType, rec.id, { clock: clk.key, dueAt: clk.dueAt, policyVersion: clk.policyVersion });
  for (const uid of new Set(recipients)) {
    notify(uid, 'SLA breached', `${ref}: ${clk.label} was due ${new Date(clk.dueAt).toISOString().replace('T', ' ').slice(0, 16)} UTC.`, { type: 'warning', dedupeKey: `sla:${entityType}:${rec.id}:${clk.key}:${uid}`, link });
  }
  return 1;
}

/** Scheduled job: records each breached clock exactly once, notifies the team and raises an exception. */
export function checkSlaBreaches() {
  let breaches = 0;
  const team = activeUsers(CLAIMS_TEAM_ROLES).map((u) => u.id);
  for (const c of db.all('healthClaims')) {
    for (const clk of claimClocks(c)) if (clk.breached) breaches += recordBreach('healthClaim', c, clk, c.claimNumber, team, `/ops/health-claims/${c.id}`);
  }
  const support = activeUsers(['support_manager', 'admin']).map((u) => u.id);
  for (const g of db.all('grievances')) {
    for (const clk of grievanceClocks(g)) if (clk.breached) breaches += recordBreach('grievance', g, clk, g.reference, [g.ownerId, ...support].filter(Boolean), `/ops/grievances/${g.id}`);
  }
  return breaches;
}

export const breachesFor = (entityType, id) => db.find('slaBreaches', (b) => b.entityType === entityType && b.entityId === id);

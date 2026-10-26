// Claims operations API (mounted at /api/claims-ops): regulatory TAT tracking, claim intimations,
// claim insights, insurer communications, fraud/anomaly review and VHC grievances & appeals.
//
// Read-only oversight roles (auditor, compliance_officer) may read the SLA board and grievances but can
// never mutate anything here. Medical details are only returned to the customer who owns the record and
// to claims officers / admins; boards and oversight views carry operational fields only.
import { Router } from 'express';
import { db, tx } from '../db.js';
import { now } from '../clock.js';
import { authenticate, READ_ONLY_ROLES, requireRole } from '../middleware/auth.js';
import { bad, conflict, forbidden, notFound } from '../utils/errors.js';
import { assertHealthClaimAccess } from '../services/access.js';
import { audit, notify } from '../services/audit.js';
import {
  addInsurerComm, assertIntimationAccess, CLAIMS_TEAM, claimOpsView, claimRow, createIntimation, DECISION_DISCLAIMER,
  intimationView, reconcileSettledClaims, RESPONSIBLE_ORGS, STATUS_MAP, UNIFIED_STATUSES,
} from '../services/claimsOps.js';
import { checkSlaBreaches, createSlaPolicyVersion, currentPolicy, DEFAULT_RULES, grievanceClocks, rulesOf, SLA_SOURCE, slaPolicies } from '../services/claimsOpsSla.js';
import { FLAG_STATUSES, FRAUD_DISCLAIMER, FRAUD_RULES, reviewFlag, runFraudRules } from '../services/claimsOpsFraud.js';
import { ASSIST_DISCLAIMER } from '../services/claimsOpsDocs.js';
import {
  addGrievanceInsurerComm, addMessage, appealGrievance, assertGrievanceAccess, assignGrievance, closeGrievance, createGrievance,
  escalateGrievance, GRIEVANCE_CATEGORIES, GRIEVANCE_GUIDANCE, GRIEVANCE_READERS, GRIEVANCE_STAFF, GRIEVANCE_STATUSES,
  grievanceRow, grievanceView, OUTCOMES, resolveGrievance, setGrievanceStatus,
} from '../services/claimsOpsGrievances.js';

const r = Router();
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
r.use(authenticate);
// Oversight roles are strictly read-only across this module.
r.use((req, _res, next) => (MUTATING.has(req.method) && READ_ONLY_ROLES.includes(req.user.role) ? next(forbidden('Read-only oversight roles cannot change records')) : next()));

const team = requireRole(...CLAIMS_TEAM);
const slaReaders = requireRole(...CLAIMS_TEAM, ...READ_ONLY_ROLES);
const grievanceStaff = requireRole(...GRIEVANCE_STAFF);
const grievanceReaders = requireRole('customer', ...GRIEVANCE_READERS);
const isTeam = (u) => CLAIMS_TEAM.includes(u.role);

// ---------------- reference ----------------
r.get('/meta', (req, res) => {
  const p = currentPolicy();
  res.json({
    unifiedStatuses: UNIFIED_STATUSES, responsibleOrgs: RESPONSIBLE_ORGS, statusMap: STATUS_MAP, decisionDisclaimer: DECISION_DISCLAIMER,
    documentAssistDisclaimer: ASSIST_DISCLAIMER, sla: { version: p?.version ?? null, rules: rulesOf(p), source: p?.source || SLA_SOURCE },
    grievance: { categories: GRIEVANCE_CATEGORIES, statuses: GRIEVANCE_STATUSES, outcomes: OUTCOMES, guidance: GRIEVANCE_GUIDANCE },
  });
});

// ---------------- SLA / TAT ----------------
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
function turnaround(clocks) {
  const done = clocks.filter((k) => k.stopAt);
  const ms = done.map((k) => k.elapsedMs);
  return {
    completed: done.length, running: clocks.filter((k) => k.running && k.startAt).length,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, medianMs: median(ms),
    withinSlaPct: done.length ? Math.round((done.filter((k) => !k.breached).length * 100) / done.length) : null,
  };
}

r.get('/sla', slaReaders, (req, res) => {
  const { state, clock, type, unified, q, scope = 'open' } = req.query;
  if (isTeam(req.user)) tx(() => reconcileSettledClaims());
  const all = db.all('healthClaims').map(claimRow);
  const clocksByKey = {};
  for (const row of all) for (const k of row.clocks) (clocksByKey[k.key] ||= []).push(k);
  const gClocks = db.all('grievances').flatMap((g) => grievanceClocks(g));
  const needle = String(q || '').trim().toLowerCase();
  const rows = all.filter((row) => (scope === 'all' || row.open)
    && (!type || row.type === type) && (!unified || row.unifiedStatus === unified)
    && (!state || row.clocks.some((k) => k.state === state && (!clock || k.key === clock)))
    && (!clock || row.clocks.some((k) => k.key === clock))
    && (!needle || [row.claimNumber, row.hospitalName, row.policyNumber, row.insurerClaimRef].some((x) => String(x || '').toLowerCase().includes(needle))))
    .sort((a, b) => (a.sla?.remainingMs ?? Infinity) - (b.sla?.remainingMs ?? Infinity));
  const running = all.flatMap((row) => row.clocks.filter((k) => k.running && k.startAt));
  const p = currentPolicy();
  res.json({
    policy: p ? { id: p.id, version: p.version, effectiveFrom: p.effectiveFrom, rules: rulesOf(p), source: p.source } : null,
    counts: {
      openClaims: all.filter((x) => x.open).length, running: running.length,
      atRisk: running.filter((k) => k.state === 'at_risk').length, breached: running.filter((k) => k.state === 'breached').length,
      paused: running.filter((k) => k.state === 'paused').length, breachesRecorded: db.find('slaBreaches', (b) => b.entityType === 'healthClaim').length,
      grievancesOpenBreached: gClocks.filter((k) => k.running && k.breached).length,
    },
    turnaround: {
      preauth: turnaround(clocksByKey.preauth || []), final_auth: turnaround(clocksByKey.final_auth || []),
      settlement: turnaround(clocksByKey.settlement || []), grievance: turnaround(gClocks),
    },
    rows, readOnly: READ_ONLY_ROLES.includes(req.user.role), generatedAt: now().toISOString(),
  });
});

r.get('/sla/policies', slaReaders, (req, res) => res.json({ current: currentPolicy()?.id || null, defaults: DEFAULT_RULES, source: SLA_SOURCE, versions: slaPolicies().reverse() }));

r.post('/sla/policies', requireRole('admin'), (req, res) => {
  const rec = tx(() => createSlaPolicyVersion(req.user, req.body || {}));
  res.status(201).json(rec);
});

r.get('/sla/breaches', slaReaders, (req, res) => res.json([...db.all('slaBreaches')].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))));

r.post('/sla/check', team, (req, res) => {
  const out = tx(() => {
    const o = { claimSettledEvents: reconcileSettledClaims(), newBreaches: checkSlaBreaches() };
    audit(req.user, 'SLA_CHECK_RUN', 'system', null, o);
    return o;
  });
  res.json(out);
});

// ---------------- claims ----------------
const loadClaim = (req) => assertHealthClaimAccess(req.user, db.get('healthClaims', req.params.id));

r.get('/claims/status-map', (req, res) => res.json({ statuses: UNIFIED_STATUSES, map: STATUS_MAP, disclaimer: DECISION_DISCLAIMER }));

r.get('/claims/:id/insights', (req, res) => res.json(claimOpsView(loadClaim(req), req.user)));

r.post('/claims/:id/insurer-comms', team, (req, res) => {
  const c = loadClaim(req);
  const b = req.body || {};
  const subject = String(b.subject || '').trim();
  if (!subject) throw bad('Subject is required');
  const entry = tx(() => {
    const e = addInsurerComm(c, {
      direction: b.direction === 'inbound' ? 'inbound' : 'outbound', channel: String(b.channel || 'Email (sandbox)').slice(0, 60), subject,
      message: String(b.message || '').trim() || null, by: req.user.name, visibleToCustomer: b.visibleToCustomer !== false, insurerRef: String(b.insurerRef || '').trim() || null,
    });
    db.touch(c);
    audit(req.user, 'CLAIM_INSURER_COMM_LOGGED', 'healthClaim', c.id, { direction: e.direction, subject });
    return e;
  });
  res.status(201).json(entry);
});

r.post('/claims/:id/close', team, (req, res) => {
  const c = loadClaim(req);
  if (!['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status)) throw conflict('Only settled or rejected claims can be closed');
  if (c.closedAt) throw conflict('Claim file is already closed');
  if (db.findOne('grievances', (g) => g.claimId === c.id && !['Resolved', 'Closed'].includes(g.status))) throw conflict('Resolve the open grievance on this claim before closing it');
  tx(() => {
    c.closedAt = now().toISOString();
    c.timeline.push({ at: c.closedAt, status: c.status, by: req.user.name, role: req.user.role, note: `Claim file closed${req.body?.note ? `: ${req.body.note}` : ''}` });
    db.touch(c);
    audit(req.user, 'HEALTH_CLAIM_CLOSED', 'healthClaim', c.id, { note: req.body?.note || null });
    notify(c.userId, 'Claim file closed', `${c.claimNumber} has been closed.`, { link: `/claims/${c.id}` });
  });
  res.json(claimOpsView(c, req.user));
});

r.post('/claims/:id/fraud-scan', team, (req, res) => {
  const c = loadClaim(req);
  const created = tx(() => {
    const out = runFraudRules(c, 'manual_rescan');
    audit(req.user, 'FRAUD_RULES_RESCAN', 'healthClaim', c.id, { created: out.length });
    return out;
  });
  res.json({ created, flags: db.find('fraudFlags', (f) => f.claimId === c.id) });
});

// ---------------- intimations ----------------
r.get('/intimations', (req, res) => {
  const { status } = req.query;
  let list;
  if (req.user.role === 'customer') list = db.find('claimIntimations', (x) => x.userId === req.user.id);
  else if (isTeam(req.user)) list = db.all('claimIntimations');
  else throw forbidden();
  res.json(list.filter((x) => !status || x.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => intimationView(x, req.user)));
});

r.post('/intimations', requireRole('customer'), (req, res) => {
  const rec = tx(() => createIntimation(req.user, req.body || {}));
  res.status(201).json(intimationView(rec, req.user));
});

r.get('/intimations/:id', (req, res) => res.json(intimationView(assertIntimationAccess(req.user, db.get('claimIntimations', req.params.id)), req.user)));

r.post('/intimations/:id/cancel', requireRole('customer'), (req, res) => {
  const rec = assertIntimationAccess(req.user, db.get('claimIntimations', req.params.id));
  if (rec.status !== 'Intimated') throw conflict(`Intimation is already ${rec.status.toLowerCase()}`);
  tx(() => {
    rec.status = 'Cancelled';
    rec.history.push({ at: now().toISOString(), action: 'Cancelled', by: req.user.name, note: String(req.body?.reason || '').trim() || null });
    db.touch(rec);
    audit(req.user, 'CLAIM_INTIMATION_CANCELLED', 'claimIntimation', rec.id, {});
  });
  res.json(intimationView(rec, req.user));
});

r.post('/intimations/:id/notes', team, (req, res) => {
  const rec = assertIntimationAccess(req.user, db.get('claimIntimations', req.params.id));
  const note = String(req.body?.note || '').trim();
  if (!note) throw bad('Note is required');
  tx(() => {
    rec.notes.push({ at: now().toISOString(), by: req.user.name, note });
    rec.history.push({ at: now().toISOString(), action: 'Followed up', by: req.user.name, note: null });
    db.touch(rec);
    audit(req.user, 'CLAIM_INTIMATION_NOTE', 'claimIntimation', rec.id, {});
  });
  res.json(intimationView(rec, req.user));
});

// ---------------- fraud & anomaly review ----------------
r.get('/fraud-flags', team, (req, res) => {
  const { status, claimId, ruleId } = req.query;
  const list = db.find('fraudFlags', (f) => (!status || f.status === status) && (!claimId || f.claimId === claimId) && (!ruleId || f.ruleId === ruleId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const all = db.all('fraudFlags');
  res.json({
    disclaimer: FRAUD_DISCLAIMER, rules: FRAUD_RULES, statuses: FLAG_STATUSES,
    counts: Object.fromEntries(FLAG_STATUSES.map((s) => [s, all.filter((f) => f.status === s).length])),
    flags: list.map((f) => ({ ...f, claimStatus: db.get('healthClaims', f.claimId)?.status || null })),
  });
});

r.get('/fraud-flags/:id', team, (req, res) => {
  const f = db.get('fraudFlags', req.params.id);
  if (!f) throw notFound('Flag not found');
  res.json({ ...f, disclaimer: FRAUD_DISCLAIMER, claim: claimRow(db.get('healthClaims', f.claimId)) });
});

r.post('/fraud-flags/:id/review', team, (req, res) => {
  const f = db.get('fraudFlags', req.params.id);
  if (!f) throw notFound('Flag not found');
  res.json(tx(() => reviewFlag(req.user, f, req.body || {})));
});

// ---------------- grievances ----------------
const loadGrievance = (req) => assertGrievanceAccess(req.user, db.get('grievances', req.params.id));

r.get('/grievances', grievanceReaders, (req, res) => {
  const { status, category, owner, q } = req.query;
  const needle = String(q || '').trim().toLowerCase();
  const base = req.user.role === 'customer' ? db.find('grievances', (g) => g.userId === req.user.id) : db.all('grievances');
  const list = base.filter((g) => (!status || g.status === status) && (!category || g.category === category)
    && (!owner || (owner === 'me' ? g.ownerId === req.user.id : g.ownerId === owner))
    && (!needle || [g.reference, g.subject, g.customerName, g.claimNumber].some((x) => String(x || '').toLowerCase().includes(needle))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(grievanceRow);
  res.json(list);
});

r.get('/grievances/assignees', grievanceStaff, (req, res) => {
  res.json(db.find('users', (u) => GRIEVANCE_STAFF.includes(u.role) && u.status === 'Active').map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

r.post('/grievances', requireRole('customer'), (req, res) => {
  const g = tx(() => createGrievance(req.user, req.body || {}));
  res.status(201).json(grievanceView(g, req.user));
});

r.get('/grievances/:id', grievanceReaders, (req, res) => {
  const g = loadGrievance(req);
  if (req.user.role !== 'customer') tx(() => audit(req.user, 'GRIEVANCE_VIEWED', 'grievance', g.id, {}));
  res.json(grievanceView(g, req.user));
});

const grievanceAction = (fn) => (req, res) => {
  const g = loadGrievance(req);
  tx(() => fn(req, g));
  res.json(grievanceView(g, req.user));
};

r.post('/grievances/:id/messages', grievanceReaders, grievanceAction((req, g) => addMessage(req.user, g, req.body || {})));
r.post('/grievances/:id/assign', grievanceStaff, grievanceAction((req, g) => assignGrievance(req.user, g, req.body?.ownerId)));
r.post('/grievances/:id/status', grievanceStaff, grievanceAction((req, g) => setGrievanceStatus(req.user, g, req.body?.status, req.body?.note)));
r.post('/grievances/:id/insurer-comms', grievanceStaff, grievanceAction((req, g) => addGrievanceInsurerComm(req.user, g, req.body || {})));
r.post('/grievances/:id/escalate', grievanceStaff, grievanceAction((req, g) => escalateGrievance(req.user, g, req.body || {})));
r.post('/grievances/:id/resolve', grievanceStaff, grievanceAction((req, g) => resolveGrievance(req.user, g, req.body || {})));
r.post('/grievances/:id/appeal', requireRole('customer'), grievanceAction((req, g) => appealGrievance(req.user, g, req.body || {})));
r.post('/grievances/:id/close', grievanceReaders, grievanceAction((req, g) => closeGrievance(req.user, g, req.body || {})));

// ---------------- summary (nav badges / dashboards) ----------------
r.get('/summary', slaReaders, (req, res) => {
  const rows = db.all('healthClaims').map(claimRow).filter((x) => x.open);
  res.json({
    openClaims: rows.length, slaAtRisk: rows.filter((x) => x.sla?.state === 'at_risk').length, slaBreached: rows.filter((x) => x.sla?.state === 'breached').length,
    openFraudFlags: isTeam(req.user) ? db.find('fraudFlags', (f) => ['Open', 'In Review'].includes(f.status)).length : null,
    openGrievances: db.find('grievances', (g) => !['Resolved', 'Closed'].includes(g.status)).length,
    pendingIntimations: isTeam(req.user) ? db.find('claimIntimations', (x) => x.status === 'Intimated').length : null,
  });
});

export default r;

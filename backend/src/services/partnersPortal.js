// Partners module — insurer partner portal and partner performance analytics (§42).
//
// Every query here is scoped to one insurer id. Callers pass req.user.orgId for insurer users, so a partner
// can only ever see proposals, policies and products of its own organisation; records of another insurer
// are reported as not found. Issued-policy lists never include medical declarations.
import { db } from '../db.js';
import { today } from '../clock.js';
import { notFound } from '../utils/errors.js';
import { ageOn, diffDays } from '../utils/dates.js';
import { APP_STATUS as S, policyStatusAt } from './lifecycle.js';
import { currentVersion } from './pricing.js';
import { distributionStatus } from './insurerHub.js';

export const planIdsOf = (insurerId) => new Set(db.find('plans', (p) => p.insurerId === insurerId).map((p) => p.id));

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Proposal view for the insurer: what an insurer needs to decide issuance, nothing more. */
export function proposalView(app, { detail = false } = {}) {
  const payment = db.findOne('payments', (p) => p.applicationId === app.id && p.status === 'success');
  const owner = db.get('users', app.userId);
  const v = {
    id: app.id, applicationNumber: app.applicationNumber, status: app.status, product: app.product, planId: app.planId, planName: app.planName,
    planVersion: app.offer?.planVersion ?? app.planVersion, proposerName: owner?.name || null, startDate: app.startDate,
    sumInsured: app.product === 'health' ? app.offer?.coverage ?? app.health?.coverage : app.offer?.sumAssured ?? app.life?.sumAssured,
    premium: app.offer?.annualPremium ?? null, firstPayment: app.offer?.firstPayment ?? null,
    paymentReference: payment?.reference || null, paidAt: payment?.completedAt || payment?.updatedAt || null,
    submittedAt: app.submittedAt || null, issuance: app.issuance || null, policyId: app.policyId || null,
    underwriting: { reviewed: (app.underwriting?.decisions || []).length > 0, revisedTerms: !!app.offer?.revised, triggersCount: (app.quote?.underwritingTriggers || []).length },
  };
  if (detail) {
    v.members = app.product === 'health'
      ? app.health.members.map((m) => ({ fullName: m.fullName, relationship: m.relationship, age: m.dob ? ageOn(m.dob, app.startDate) : null, declaredConditions: m.hasConditions === true, tobacco: m.tobacco === true }))
      : [{ fullName: app.life.lifeAssured?.fullName, relationship: 'self', age: app.life.lifeAssured?.dob ? ageOn(app.life.lifeAssured.dob, app.startDate) : null, declaredConditions: app.life.medicalHistory?.hasConditions === true, tobacco: app.life.tobacco === true }];
    v.decisionNote = 'Detailed medical declarations and reports are held by VHC underwriting; request them through the escalation contact if your underwriting rules require them.';
    v.timeline = (app.timeline || []).filter((t) => [S.ACCEPTED, S.ISSUANCE_PENDING, S.ISSUED, S.INSURER_DECLINED].includes(t.status)).map((t) => ({ at: t.at, status: t.status, by: t.by, note: t.note }));
  }
  return v;
}

export function insurerProposals(insurerId, { status } = {}) {
  const ids = planIdsOf(insurerId);
  const visible = [S.ISSUANCE_PENDING, S.ISSUED, S.INSURER_DECLINED];
  return db.find('applications', (a) => ids.has(a.planId) && visible.includes(a.status) && (!status || a.status === status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => proposalView(a));
}

/** Loads one proposal of this insurer; anything else (other insurer, earlier stage) is not found. */
export function loadInsurerProposal(insurerId, id) {
  const app = db.get('applications', id);
  const plan = app && db.get('plans', app.planId);
  if (!app || !plan || plan.insurerId !== insurerId || ![S.ISSUANCE_PENDING, S.ISSUED, S.INSURER_DECLINED].includes(app.status)) throw notFound('Proposal not found');
  return app;
}

export function insurerPolicies(insurerId) {
  return db.find('policies', (p) => p.insurerId === insurerId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).map((p) => ({
    id: p.id, policyNumber: p.policyNumber, insurerPolicyReference: p.insurerPolicyReference || null, product: p.product, planName: p.planName,
    productUin: p.productUin, planVersion: p.planVersion, status: policyStatusAt(p), startDate: p.startDate, endDate: p.endDate, issuedAt: p.issuedAt,
    annualPremium: p.annualPremium, sumInsured: p.product === 'health' ? p.coverage : p.sumAssured, holderName: p.holderName,
    membersCount: p.product === 'health' ? (p.members || []).length : 1, sandbox: p.sandbox !== false,
  }));
}

export function insurerProducts(insurerId) {
  const ins = db.get('insurers', insurerId);
  const ids = new Set([...(ins?.authorizedPlanIds || []), ...planIdsOf(insurerId)]);
  return [...ids].map((id) => db.get('plans', id)).filter(Boolean).map((p) => {
    const v = currentVersion(p);
    return {
      id: p.id, name: p.name, code: p.code, product: p.product, type: p.type, uin: ins?.uins?.[p.id] || p.uin || null, version: v.version,
      versionDate: v.createdAt || null, versions: p.versions.length, active: p.active, sandbox: p.sandbox !== false, linked: p.insurerId === insurerId,
      distribution: p.insurerId === insurerId ? distributionStatus(p) : { allowed: false, reason: 'Linked to another insurer' },
      policiesIssued: db.find('policies', (x) => x.planId === p.id).length,
    };
  });
}

/** Partner performance analytics (spec §42), computed only from this insurer's records. */
export function insurerAnalytics(insurerId) {
  const ins = db.get('insurers', insurerId);
  const ids = planIdsOf(insurerId);
  const apps = db.find('applications', (a) => ids.has(a.planId));
  const quotes = db.find('quotes', (q) => ids.has(q.planId));
  const issued = apps.filter((a) => a.status === S.ISSUED && !a.renewalOf).length;
  const declinedByInsurer = apps.filter((a) => a.status === S.INSURER_DECLINED).length;
  const decided = apps.filter((a) => a.issuance?.decidedAt);
  const turnaroundsMin = decided.map((a) => {
    const from = a.issuance.requestedAt || a.timeline.find((t) => t.status === S.ISSUANCE_PENDING)?.at;
    return from ? Math.max(0, Math.round((new Date(a.issuance.decidedAt) - new Date(from)) / 60000)) : null;
  }).filter((x) => x != null);
  const policies = db.find('policies', (p) => p.insurerId === insurerId);
  const t = today();
  const dueForRenewal = policies.filter((p) => p.product === 'health' && !p.renewedBy && diffDays(t, p.endDate) <= 60 && diffDays(p.endDate, t) <= (p.termsSnapshot?.renewalGraceDays ?? 30));
  const renewed = policies.filter((p) => p.renewedBy).length;
  const renewalCandidates = policies.filter((p) => p.product === 'health' && (p.renewedBy || p.endDate < t)).length;
  const pending = apps.filter((a) => a.status === S.ISSUANCE_PENDING);
  return {
    insurer: { id: ins?.id, name: ins?.name, sandbox: !!ins?.sandbox },
    products: ids.size,
    proposalsAwaitingIssuance: pending.length,
    oldestPendingDays: pending.length ? Math.max(...pending.map((a) => diffDays((a.issuance?.requestedAt || a.updatedAt).slice(0, 10), t))) : null,
    issuedPolicies: policies.length,
    quotes: quotes.length,
    quoteToIssueConversionBp: quotes.length ? Math.round((issued * 10000) / quotes.length) : null,
    proposalSuccessRateBp: issued + declinedByInsurer ? Math.round((issued * 10000) / (issued + declinedByInsurer)) : null,
    declinedByInsurer,
    medianIssuanceTurnaroundMinutes: median(turnaroundsMin),
    issuanceDecisions: turnaroundsMin.length,
    quoteResponseTime: { value: null, note: ins?.sandbox ? 'n/a in sandbox — quotes are rated in-process by the VHC sandbox rating engine, not by an insurer API' : 'n/a — no quotation API integrated yet' },
    renewals: { renewed, eligibleOrLapsed: renewalCandidates, retentionBp: renewalCandidates ? Math.round((renewed * 10000) / renewalCandidates) : null, dueNow: dueForRenewal.length },
    notes: ['Conversion counts first-time issuance against quotes rated for this insurer\'s products.', 'Figures are computed from sandbox (synthetic) activity only.'],
  };
}

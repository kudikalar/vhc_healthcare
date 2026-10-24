// Fraud & anomaly review: an explainable rule engine.
//
// Rules run on claim submission and updates (final bill, document uploads, manual re-scan). Each hit
// becomes a `fraudFlags` record with the rule id, a plain explanation and the evidence it used, for a
// claims officer to review (Open → In Review → Cleared / Escalated to insurer SIU).
//
// Flags are signals for human review only. They NEVER deny, block or delay a claim decision on their own:
// approval and rejection routes do not consult them, and the staff claim view only shows a warning banner.
import { db } from '../db.js';
import { now } from '../clock.js';
import { diffDays } from '../utils/dates.js';
import { bad, conflict } from '../utils/errors.js';
import { audit } from './audit.js';
import { rupees } from './claimsOpsDocs.js';

export const FRAUD_DISCLAIMER = 'Rule-based anomaly signals for human review. A flag is not a finding of fraud and must never be the sole reason to deny or delay a claim.';
export const FLAG_STATUSES = ['Open', 'In Review', 'Cleared', 'Escalated to insurer SIU'];
export const EARLY_CLAIM_DAYS = 30;
export const FREQUENCY_WINDOW_DAYS = 7;
export const PACKAGE_OUTLIER_FACTOR_BP = 15000; // 150% of the package rate
export const HIGH_VALUE_SHARE_BP = 5000; // 50% of the sum insured

export const FRAUD_RULES = {
  FR01: { name: 'Duplicate or overlapping claim', severity: 'high' },
  FR02: { name: 'Document reused across claims', severity: 'high' },
  FR03: { name: 'Date inconsistency', severity: 'medium' },
  FR04: { name: 'Member not on policy', severity: 'high' },
  FR05: { name: 'Provider not matched', severity: 'low' },
  FR06: { name: 'Claim soon after policy start', severity: 'medium' },
  FR07: { name: 'Multiple claims in the same week', severity: 'low' },
  FR08: { name: 'Amount outlier', severity: 'medium' },
};
const ENGINE = { id: 'system', role: 'system', name: 'Anomaly rule engine' };
const CLOSED = ['Rejected', 'Preauth Rejected'];
const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function packageRateFor(claim) {
  const hospital = claim.hospitalId && db.get('hospitals', claim.hospitalId);
  const text = norm(`${claim.treatment} ${claim.diagnosis}`);
  const candidates = [
    ...(hospital?.packageRates || hospital?.packages || []).map((p) => ({ ...p, hospitalId: hospital.id })),
    ...db.find('packageRates', (p) => !p.hospitalId || p.hospitalId === claim.hospitalId),
  ].filter((p) => Number.isInteger(p.amount) && p.amount > 0);
  return candidates.find((p) => [p.name, ...(p.keywords || [])].filter(Boolean).some((k) => text.includes(norm(k)))) || null;
}

/** Evaluates every rule for a claim; returns [{ ruleId, key, explanation, evidence }]. Pure (no writes). */
export function evaluateFraudRules(claim) {
  const hits = [];
  const hit = (ruleId, key, explanation, evidence) => hits.push({ ruleId, key, explanation, evidence });
  const policy = db.get('policies', claim.policyId);
  const others = db.find('healthClaims', (o) => o.id !== claim.id && o.policyId === claim.policyId);

  // FR01 duplicate claim reference / same member with overlapping dates
  for (const o of others) {
    if (CLOSED.includes(o.status) || o.memberId !== claim.memberId) continue;
    if (overlaps(claim.admissionDate, claim.dischargeDate, o.admissionDate, o.dischargeDate)) {
      hit('FR01', `overlap:${o.id}`, `Another claim (${o.claimNumber}) exists for the same member with overlapping hospitalisation dates.`,
        { otherClaim: o.claimNumber, otherClaimId: o.id, otherType: o.type, otherStatus: o.status, otherDates: `${o.admissionDate} → ${o.dischargeDate}`, thisDates: `${claim.admissionDate} → ${claim.dischargeDate}` });
    }
  }
  if (claim.insurerClaimRef) {
    const same = db.find('healthClaims', (o) => o.id !== claim.id && o.insurerClaimRef === claim.insurerClaimRef);
    if (same.length) hit('FR01', `ref:${claim.insurerClaimRef}`, 'The insurer claim reference is already used by another claim.', { insurerClaimRef: claim.insurerClaimRef, otherClaims: same.map((o) => o.claimNumber) });
  }

  // FR02 identical document (SHA-256) already attached to a different claim
  for (const d of db.find('documents', (x) => x.entityType === 'healthClaim' && x.entityId === claim.id && x.sha256)) {
    for (const o of db.find('documents', (x) => x.sha256 === d.sha256 && x.entityType === 'healthClaim' && x.entityId !== claim.id)) {
      const oc = db.get('healthClaims', o.entityId);
      hit('FR02', `doc:${d.sha256}:${o.entityId}`, `An identical file (${d.filename}) is also attached to claim ${oc?.claimNumber || o.entityId}.`,
        { sha256: `${d.sha256.slice(0, 16)}…`, filename: d.filename, category: d.category, otherClaim: oc?.claimNumber || null, otherClaimId: o.entityId, otherFilename: o.filename });
    }
  }

  // FR03 dates: discharge before admission, admission outside the policy period
  if (claim.dischargeDate && claim.admissionDate && claim.dischargeDate < claim.admissionDate) {
    hit('FR03', 'discharge-before-admission', 'The discharge date is before the admission date.', { admissionDate: claim.admissionDate, dischargeDate: claim.dischargeDate });
  }
  if (policy && (claim.admissionDate < policy.startDate || claim.admissionDate > policy.endDate)) {
    hit('FR03', 'outside-policy-period', 'The admission date falls outside the policy period.', { admissionDate: claim.admissionDate, policyStart: policy.startDate, policyEnd: policy.endDate });
  }

  // FR04 member must be on the policy
  if (!policy?.members?.some((m) => m.id === claim.memberId)) {
    hit('FR04', `member:${claim.memberId}`, 'The patient is not listed as an insured member of this policy.', { memberId: claim.memberId, memberName: claim.memberName, policyNumber: claim.policyNumber });
  }

  // FR05 provider identity
  const hospital = claim.hospitalId ? db.get('hospitals', claim.hospitalId) : null;
  if (claim.hospitalId && !hospital) hit('FR05', 'unknown-id', 'The hospital id on the claim does not match any known provider.', { hospitalId: claim.hospitalId });
  else if (hospital && !hospital.active) hit('FR05', 'inactive', 'The hospital is not an active provider.', { hospitalId: hospital.id, hospitalName: hospital.name });
  else if (claim.type === 'cashless' && hospital && !hospital.network) hit('FR05', 'non-network-cashless', 'A cashless request was raised at a non-network hospital.', { hospitalId: hospital.id, hospitalName: hospital.name });
  else if (!claim.hospitalId) {
    const known = db.find('hospitals', (h) => norm(h.name) === norm(claim.hospitalName));
    if (!known.length) hit('FR05', 'free-text', 'The hospital was entered as free text and does not match a known provider record.', { hospitalName: claim.hospitalName });
  }

  // FR06 claim soon after the start of continuous cover (accidents excluded)
  const coverStart = policy?.continuityStartDate || policy?.startDate;
  if (coverStart && !claim.isAccident) {
    const days = diffDays(coverStart, claim.admissionDate);
    if (days >= 0 && days < EARLY_CLAIM_DAYS) hit('FR06', 'early', `Admission is ${days} day(s) after the start of continuous cover (review threshold ${EARLY_CLAIM_DAYS} days).`, { coverStart, admissionDate: claim.admissionDate, days });
  }

  // FR07 several claims on the same policy filed within a week
  const t = Date.parse(claim.createdAt);
  const near = others.filter((o) => Math.abs(Date.parse(o.createdAt) - t) <= FREQUENCY_WINDOW_DAYS * 86_400_000);
  if (near.length >= 1) hit('FR07', `week:${claim.createdAt.slice(0, 10)}`, `${near.length + 1} claims were filed on this policy within ${FREQUENCY_WINDOW_DAYS} days.`, { claims: [claim.claimNumber, ...near.map((o) => o.claimNumber)] });

  // FR08 amount vs package rate (when the provider has one) else vs the sum insured
  const amount = claim.finalBill?.amount ?? claim.requestedAmount;
  const pkg = packageRateFor(claim);
  if (pkg && amount * 10000 > pkg.amount * PACKAGE_OUTLIER_FACTOR_BP) {
    hit('FR08', `package:${pkg.name || pkg.id}`, `The claimed amount ${rupees(amount)} is more than 150% of the provider package rate ${rupees(pkg.amount)}.`, { amount, packageName: pkg.name || pkg.id, packageAmount: pkg.amount });
  } else if (!pkg && policy?.balance?.total && amount * 10000 >= policy.balance.total * HIGH_VALUE_SHARE_BP) {
    hit('FR08', 'high-value', `The claimed amount ${rupees(amount)} is at least half of the sum insured (${rupees(policy.balance.total)}); no package rate is available to compare.`, { amount, sumInsured: policy.balance.total, shareBp: Math.round((amount * 10000) / policy.balance.total) });
  }
  return hits;
}

/** Runs the rules and records new flags (one per claim+rule+evidence key; reviewed flags are not reopened). */
export function runFraudRules(claim, trigger = 'update') {
  if (!claim) return [];
  const created = [];
  for (const h of evaluateFraudRules(claim)) {
    const fingerprint = `${claim.id}:${h.ruleId}:${h.key}`;
    if (db.findOne('fraudFlags', (f) => f.fingerprint === fingerprint)) continue;
    const rule = FRAUD_RULES[h.ruleId];
    const flag = db.insert('fraudFlags', {
      claimId: claim.id, claimNumber: claim.claimNumber, policyNumber: claim.policyNumber, ruleId: h.ruleId, ruleName: rule.name,
      severity: rule.severity, explanation: h.explanation, evidence: h.evidence, fingerprint, trigger, status: 'Open',
      history: [{ at: now().toISOString(), action: 'Raised', by: ENGINE.name, note: `Triggered by ${trigger}` }],
    });
    audit(ENGINE, 'FRAUD_FLAG_RAISED', 'healthClaim', claim.id, { flagId: flag.id, ruleId: h.ruleId, trigger });
    created.push(flag);
  }
  return created;
}

export const openFlagsFor = (claimId) => db.find('fraudFlags', (f) => f.claimId === claimId && ['Open', 'In Review'].includes(f.status));

/** Human review: start_review | clear | escalate (to the insurer's Special Investigation Unit). */
export function reviewFlag(actor, flag, { action, note } = {}) {
  const text = String(note || '').trim();
  const to = { start_review: 'In Review', clear: 'Cleared', escalate: 'Escalated to insurer SIU' }[action];
  if (!to) throw bad('action must be start_review, clear or escalate');
  if (['Cleared', 'Escalated to insurer SIU'].includes(flag.status)) throw conflict(`Flag is already ${flag.status}`);
  if (action !== 'start_review' && !text) throw bad('A review note explaining the decision is required');
  const from = flag.status;
  flag.status = to;
  if (action === 'start_review') flag.reviewer = { id: actor.id, name: actor.name };
  else flag.decision = { status: to, note: text, by: actor.name, byId: actor.id, at: now().toISOString() };
  flag.history.push({ at: now().toISOString(), action: to, by: actor.name, note: text || null, from });
  db.touch(flag);
  audit(actor, action === 'escalate' ? 'FRAUD_FLAG_ESCALATED_SIU' : action === 'clear' ? 'FRAUD_FLAG_CLEARED' : 'FRAUD_FLAG_REVIEW_STARTED', 'healthClaim', flag.claimId, { flagId: flag.id, ruleId: flag.ruleId, note: text || null });
  if (action === 'escalate') {
    const claim = db.get('healthClaims', flag.claimId);
    if (claim) {
      claim.insurerComms ||= [];
      claim.insurerComms.push({ at: now().toISOString(), direction: 'outbound', channel: 'SIU referral (sandbox)', subject: `Anomaly referral: ${flag.ruleName}`, message: `${flag.explanation} Review note: ${text}`, by: actor.name, visibleToCustomer: false });
    }
  }
  return flag;
}

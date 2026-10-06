// Application workflow, policy issuance and policy status rules.
import { db, nextSeq, newId } from '../db.js';
import { now, today } from '../clock.js';
import { addDays, addMonths, addYears, ageOn, isValidDate } from '../utils/dates.js';
import { sum } from '../utils/money.js';
import { AppError } from '../utils/errors.js';
import { planVersion } from './pricing.js';
import { audit, notify } from './audit.js';

export const APP_STATUS = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', INITIAL_REVIEW: 'Initial Review', UNDERWRITING: 'Underwriting',
  MIR: 'More Information Required', APPROVED: 'Approved', REJECTED: 'Rejected', POSTPONED: 'Postponed',
  ACCEPTED: 'Offer Accepted', DECLINED: 'Offer Declined', ISSUED: 'Issued',
};
export const EDITABLE = [APP_STATUS.DRAFT, APP_STATUS.MIR];

export function transition(app, status, actor, note) {
  const from = app.status;
  app.status = status;
  app.timeline.push({ at: now().toISOString(), from, status, by: actor?.name || 'System', role: actor?.role || 'system', note: note || null });
  db.touch(app);
}

export function timelineNote(entity, actor, note) {
  entity.timeline.push({ at: now().toISOString(), status: entity.status, by: actor?.name || 'System', role: actor?.role || 'system', note });
}

// ---------- nominees ----------
export function validateNominees(nominees, asOf = today()) {
  const errors = [];
  if (!Array.isArray(nominees) || nominees.length === 0) return { errors: ['Add at least one nominee'], normalized: [] };
  const normalized = nominees.map((n, i) => {
    const label = `Nominee ${i + 1}`;
    if (!n.name?.trim()) errors.push(`${label}: name is required`);
    if (!n.relationship?.trim()) errors.push(`${label}: relationship is required`);
    if (!isValidDate(n.dob)) errors.push(`${label}: valid date of birth is required`);
    if (!n.phone?.trim() && !n.email?.trim()) errors.push(`${label}: phone or email is required`);
    const share = Number(n.sharePct);
    if (!(share > 0) || Math.round(share * 100) !== share * 100) errors.push(`${label}: share must be a positive percentage (max 2 decimals)`);
    const minor = isValidDate(n.dob) && ageOn(n.dob, asOf) < 18;
    if (minor && (!n.guardian?.name?.trim() || !n.guardian?.relationship?.trim() || !(n.guardian?.phone?.trim() || n.guardian?.email?.trim()))) {
      errors.push(`${label}: is a minor — guardian name, relationship and contact are required`);
    }
    return {
      name: n.name?.trim(), relationship: n.relationship?.trim(), dob: n.dob, phone: n.phone || '', email: n.email || '',
      shareBp: Math.round(share * 100), sharePct: share, isMinor: !!minor, guardian: minor ? n.guardian : null,
    };
  });
  const total = sum(normalized, (n) => n.shareBp || 0);
  if (total !== 10000) errors.push(`Nominee allocations must total exactly 100% (currently ${(total / 100).toFixed(2)}%)`);
  return { errors, normalized };
}

export function nomineesAt(policy, date) {
  return (policy.nomineeVersions || []).find((v) =>
    ['effective', 'superseded'].includes(v.status) && v.effectiveFrom <= date && (!v.effectiveTo || v.effectiveTo >= date)) || null;
}

// ---------- policy status ----------
const dateOf = (isoTs) => (isoTs ? isoTs.slice(0, 10) : null);

/** Installments overdue as they stood on `at` (due before `at`; payments made after `at` are ignored). */
export function unpaidAsOf(policy, at) {
  return (policy.schedule || []).filter((i) => i.dueDate < at && !(i.status === 'paid' && dateOf(i.paidAt) <= at));
}

export function policyStatusAt(policy, at = today()) {
  if (policy.terminatedOn && policy.terminatedOn <= at) return 'Terminated';
  if (at < policy.startDate) return 'Upcoming';
  if (at > policy.endDate) return 'Expired';
  if (policy.product === 'health') return 'Active';
  const overdue = unpaidAsOf(policy, at).sort((a, b) => a.no - b.no)[0];
  if (!overdue) return 'Active';
  const graceEnd = addDays(overdue.dueDate, policy.graceDays);
  return at <= graceEnd ? 'Grace Period' : 'Lapsed';
}

export function policyView(policy, { includeSchedule = true } = {}) {
  const t = today();
  const status = policyStatusAt(policy, t);
  const view = { ...policy, status };
  if (policy.product === 'health') {
    const b = policy.balance;
    view.balance = { ...b, available: b.total - b.reserved - b.paid };
  } else {
    const unpaid = policy.schedule.filter((i) => i.status !== 'paid').sort((a, b) => a.no - b.no);
    const overdue = unpaid.filter((i) => i.dueDate <= t);
    view.nextDue = unpaid[0] ? { no: unpaid[0].no, dueDate: unpaid[0].dueDate, amount: unpaid[0].amount, graceEnds: addDays(unpaid[0].dueDate, policy.graceDays) } : null;
    view.outstandingAmount = sum(overdue, (i) => i.amount);
    view.overdueCount = overdue.length;
    view.paidCount = policy.schedule.length - unpaid.length;
    view.currentNominees = (policy.nomineeVersions || []).find((v) => v.status === 'effective') || null;
    view.pendingNominees = (policy.nomineeVersions || []).find((v) => v.status === 'pending') || null;
    if (view.pendingNominees) view.pendingNominees = { ...view.pendingNominees, otp: undefined };
    view.nomineeVersions = (policy.nomineeVersions || []).map((v) => ({ ...v, otp: undefined }));
    if (!includeSchedule) delete view.schedule;
  }
  return view;
}

// ---------- issuance ----------
export function issuePolicy(app, payment, actor) {
  if (app.status !== APP_STATUS.ACCEPTED) throw new AppError(409, 'Offer has not been accepted');
  const plan = db.get('plans', app.planId);
  const version = planVersion(plan, app.offer.planVersion ?? app.planVersion);
  const cfg = structuredClone(version.config);
  const t = today();
  const start = app.startDate < t ? t : app.startDate;
  const user = db.get('users', app.userId);
  const base = {
    id: newId('pol'),
    policyNumber: `VHC-${app.product === 'health' ? 'H' : 'L'}-${String(nextSeq('policy')).padStart(6, '0')}`,
    userId: app.userId, holderName: user?.name, product: app.product, applicationId: app.id,
    planId: plan.id, planCode: plan.code, planName: plan.name, planType: plan.type, planVersion: version.version,
    termsSnapshot: cfg, // frozen copy: later plan edits never change this policy
    startDate: start, issuedAt: now().toISOString(), firstPaymentRef: payment?.reference || null,
    offer: structuredClone(app.offer),
  };
  let policy;
  if (app.product === 'health') {
    const prev = app.renewalOf ? db.get('policies', app.renewalOf) : null;
    const continuous = prev && start <= addDays(prev.endDate, (cfg.renewalGraceDays ?? 30) + 1);
    policy = {
      ...base,
      endDate: addDays(addMonths(start, cfg.durationMonths), -1),
      members: structuredClone(app.health.members),
      coverage: app.offer.coverage,
      optionalBenefits: app.health.optionalBenefits || [],
      annualPremium: app.offer.annualPremium,
      balance: { total: app.offer.coverage, reserved: 0, paid: 0 },
      renewalOf: prev?.id || null,
      continuityStartDate: continuous ? prev.continuityStartDate : start,
    };
    if (prev) prev.renewedBy = policy.id;
  } else {
    const l = app.life;
    const freq = cfg.frequencies[l.frequency];
    const step = 12 / freq.perYear;
    const n = l.premiumPaymentTerm * freq.perYear;
    const schedule = Array.from({ length: n }, (_, k) => ({
      no: k + 1, dueDate: addMonths(start, k * step), amount: app.offer.installmentPremium,
      status: k === 0 ? 'paid' : 'due', paidAt: k === 0 ? now().toISOString() : null, paymentRef: k === 0 ? payment?.reference : null,
    }));
    policy = {
      ...base,
      endDate: addDays(addYears(start, l.policyTerm), -1),
      lifeAssured: structuredClone(l.lifeAssured), policyholder: structuredClone(l.policyholder || l.lifeAssured),
      sumAssured: app.offer.sumAssured, policyTerm: l.policyTerm, premiumPaymentTerm: l.premiumPaymentTerm,
      frequency: l.frequency, riders: l.riders || [], annualPremium: app.offer.annualPremium,
      installmentPremium: app.offer.installmentPremium, graceDays: freq.graceDays, schedule, autoPay: false,
      nomineeVersions: [{ version: 1, nominees: structuredClone(app.life.nominees), status: 'effective', effectiveFrom: start, effectiveTo: null, verifiedAt: now().toISOString(), changedBy: 'application' }],
      deathBenefitSettled: false,
    };
  }
  policy = db.insert('policies', policy);
  app.policyId = policy.id;
  transition(app, APP_STATUS.ISSUED, actor, `Policy ${policy.policyNumber} issued`);
  audit(actor, 'POLICY_ISSUED', 'policy', policy.id, { policyNumber: policy.policyNumber, applicationId: app.id, paymentRef: payment?.reference });
  notify(app.userId, 'Policy issued', `Your policy ${policy.policyNumber} (${plan.name}) has been issued. You can download the policy document now.`, { type: 'success', link: `/policies/${policy.id}` });
  return policy;
}

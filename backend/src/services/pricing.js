// Authoritative (server-side) mock pricing for health and term life products.
import crypto from 'node:crypto';
import { AppError, bad } from '../utils/errors.js';
import { ageOn, isValidDate } from '../utils/dates.js';
import { pct, sum } from '../utils/money.js';

export const hashInputs = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
export const currentVersion = (plan) => plan.versions[plan.versions.length - 1];
export const planVersion = (plan, v) => plan.versions.find((x) => x.version === v) || currentVersion(plan);

const isYes = (v) => v === true;
const filled = (s) => typeof s === 'string' && s.trim() && !/^(none|no|nil|na|n\/a)$/i.test(s.trim());

/** Reasons a member's declarations should go to medical underwriting (never an automatic rejection). */
export function memberTriggers(m, age, cfg) {
  const t = [];
  if (isYes(m.hasConditions)) t.push(`declared condition(s): ${m.conditions || 'unspecified'}`);
  if (filled(m.medications)) t.push('current medications');
  if (filled(m.surgeries)) t.push('previous surgery/hospitalisation');
  if (isYes(m.tobacco)) t.push('tobacco use');
  if (m.heightCm > 0 && m.weightKg > 0) {
    const bmi = m.weightKg / ((m.heightCm / 100) ** 2);
    if (bmi >= 32) t.push(`BMI ${bmi.toFixed(1)}`);
  }
  if (age != null && cfg.medicalTestAge && age >= cfg.medicalTestAge) t.push(`age ${age} (medical tests from ${cfg.medicalTestAge})`);
  return t;
}

export function healthQuoteInputs(app) {
  return {
    planId: app.planId,
    startDate: app.startDate,
    coverage: app.health.coverage,
    optionalBenefits: [...(app.health.optionalBenefits || [])].sort(),
    members: app.health.members.map(({ id, ...m }) => m),
  };
}

export function computeHealthQuote(plan, { members = [], coverage, optionalBenefits = [], startDate }, opts = {}) {
  if (plan.product !== 'health') throw bad('Not a health plan');
  if (!plan.active && !opts.allowInactive) throw bad('This plan is not currently available');
  const version = opts.version || currentVersion(plan);
  const cfg = version.config;
  const errors = [];
  const memberErrors = {};
  if (!isValidDate(startDate)) errors.push('A valid coverage start date is required');
  if (!Array.isArray(members) || members.length === 0) errors.push('Add at least one insured member');
  else if (members.length > cfg.maxMembers) errors.push(`This plan allows at most ${cfg.maxMembers} insured member(s); ${members.length} added`);

  const limits = cfg.relationshipLimits || {};
  const counts = {};
  for (const m of members) counts[m.relationship] = (counts[m.relationship] || 0) + 1;
  for (const [rel, n] of Object.entries(counts)) {
    if (limits[rel] != null && n > limits[rel]) errors.push(`At most ${limits[rel]} member(s) with relationship "${rel}" allowed`);
  }

  const lines = members.map((m, i) => {
    const errs = [];
    if (!m.fullName?.trim()) errs.push('Full name is required');
    if (!cfg.eligibleRelationships.includes(m.relationship)) {
      errs.push(`Relationship "${m.relationship || '-'}" is not allowed on ${plan.name} (allowed: ${cfg.eligibleRelationships.join(', ')})`);
    }
    if (cfg.genderRequired && !m.gender) errs.push('Gender is required for this plan');
    let age = null, band = null;
    if (!isValidDate(m.dob)) errs.push('A valid date of birth is required');
    else if (isValidDate(startDate)) {
      age = ageOn(m.dob, startDate);
      if (age < 0) errs.push('Date of birth is after the coverage start date');
      else if (age < cfg.minEntryAge || age > cfg.maxEntryAge) {
        errs.push(`Age ${age} at coverage start is outside the eligible entry age ${cfg.minEntryAge}–${cfg.maxEntryAge}`);
      } else {
        band = cfg.ageBands.find((b) => age >= b.minAge && age <= b.maxAge);
        if (!band) errs.push(`No premium is configured for age ${age}`);
      }
    }
    if (errs.length) memberErrors[i] = errs;
    return {
      index: i, fullName: m.fullName, relationship: m.relationship, age,
      band: band ? `${band.minAge}–${band.maxAge}` : null, premium: band ? band.premium : 0,
      underwritingTriggers: memberTriggers(m, age, cfg),
    };
  });

  const cov = cfg.coverageOptions.find((c) => c.amount === coverage);
  if (!cov) errors.push('Select a coverage amount offered by this plan');
  const optional = [];
  for (const code of optionalBenefits) {
    const o = (cfg.optionalBenefits || []).find((x) => x.code === code);
    if (!o) errors.push(`Optional benefit "${code}" is not available on this plan`);
    else optional.push({ code: o.code, name: o.name, charge: o.charge });
  }
  if (errors.length || Object.keys(memberErrors).length) {
    throw new AppError(422, 'Quote could not be calculated', { errors, memberErrors });
  }

  const basePremium = sum(lines, (l) => l.premium);
  const multipliedPremium = pct(basePremium, cov.multiplierBp);
  const floaterDiscount = plan.type === 'floater' ? pct(multipliedPremium, cfg.floaterDiscountBp || 0) : 0;
  const optionalTotal = sum(optional, (o) => o.charge);
  const triggers = lines.flatMap((l) => l.underwritingTriggers.map((t) => `${l.fullName}: ${t}`));
  return {
    product: 'health',
    planId: plan.id, planCode: plan.code, planName: plan.name, planType: plan.type, planVersion: version.version,
    startDate, coverage, planCoverageOptions: cfg.coverageOptions.map((c) => c.amount), members: lines,
    basePremium, coverageMultiplierBp: cov.multiplierBp, multipliedPremium,
    floaterDiscountBp: plan.type === 'floater' ? cfg.floaterDiscountBp || 0 : 0, floaterDiscount,
    optionalBenefits: optional, optionalTotal,
    totalAnnualPremium: multipliedPremium - floaterDiscount + optionalTotal,
    underwritingRequired: triggers.length > 0,
    underwritingTriggers: triggers,
  };
}

export function lifeQuoteInputs(app) {
  const l = app.life;
  return {
    planId: app.planId, startDate: app.startDate, dob: l.lifeAssured?.dob,
    sumAssured: l.sumAssured, policyTerm: l.policyTerm, premiumPaymentTerm: l.premiumPaymentTerm,
    frequency: l.frequency, tobacco: l.tobacco, riders: [...(l.riders || [])].sort(),
    annualIncome: l.lifeAssured?.annualIncome, uwClass: l.uwClass || 'standard',
    medical: l.medicalHistory, existing: l.existingInsurance, occupation: l.lifeAssured?.occupation,
  };
}

export function computeLifeQuote(plan, input, opts = {}) {
  if (plan.product !== 'life') throw bad('Not a life plan');
  if (!plan.active && !opts.allowInactive) throw bad('This plan is not currently available');
  const version = opts.version || currentVersion(plan);
  const cfg = version.config;
  const {
    dob, startDate, sumAssured, policyTerm, premiumPaymentTerm, frequency,
    tobacco, riders = [], uwClass = 'standard', annualIncome, extraLoadingBp = 0,
  } = input;
  const errors = [];
  let age = null;
  if (!isValidDate(startDate)) errors.push('A valid coverage start date is required');
  if (!isValidDate(dob)) errors.push('A valid date of birth is required');
  else if (isValidDate(startDate)) {
    age = ageOn(dob, startDate);
    if (age < cfg.minEntryAge || age > cfg.maxEntryAge) errors.push(`Entry age ${age} is outside ${cfg.minEntryAge}–${cfg.maxEntryAge}`);
  }
  if (!cfg.policyTerms.includes(policyTerm)) errors.push(`Policy term must be one of ${cfg.policyTerms.join(', ')} years`);
  if (!Number.isInteger(premiumPaymentTerm)) errors.push('Premium payment term is required');
  else if (premiumPaymentTerm > policyTerm) errors.push('Premium payment term cannot exceed the policy term');
  else if (premiumPaymentTerm !== policyTerm && !cfg.premiumPaymentTerms.includes(premiumPaymentTerm)) {
    errors.push(`Premium payment term ${premiumPaymentTerm} is not supported (regular pay or ${cfg.premiumPaymentTerms.join('/')} years)`);
  }
  if (age != null && cfg.policyTerms.includes(policyTerm) && age + policyTerm > cfg.maxMaturityAge) {
    errors.push(`Age at policy end (${age + policyTerm}) exceeds the maximum of ${cfg.maxMaturityAge}`);
  }
  if (!Number.isSafeInteger(sumAssured)) errors.push('Sum assured is required');
  else {
    if (sumAssured < cfg.minSumAssured || sumAssured > cfg.maxSumAssured) errors.push('Sum assured is outside the allowed range');
    if (sumAssured % 100000 !== 0) errors.push('Sum assured must be a multiple of Rs. 1,000');
  }
  const freq = cfg.frequencies[frequency];
  if (!freq) errors.push(`Payment frequency must be one of ${Object.keys(cfg.frequencies).join(', ')}`);
  if (typeof tobacco !== 'boolean') errors.push('Tobacco declaration is required');
  const riderLines = [];
  for (const code of riders) {
    const rd = cfg.riders.find((x) => x.code === code);
    if (!rd) errors.push(`Rider "${code}" is not available`);
    else riderLines.push({ code: rd.code, name: rd.name, charge: rd.annualCharge });
  }
  if (errors.length) throw new AppError(422, 'Quote could not be calculated', { errors });

  const rate = cfg.rateTable.find((r) =>
    age >= r.minAge && age <= r.maxAge && r.tobacco === tobacco &&
    policyTerm >= r.minTerm && policyTerm <= r.maxTerm && r.uwClass === uwClass);
  if (!rate) {
    throw new AppError(422, 'No premium rate is configured for this combination', {
      errors: [`No rate for age ${age}, tobacco=${tobacco}, term ${policyTerm}, class "${uwClass}"`],
    });
  }
  const units = sumAssured / 100000; // number of Rs. 1,000 units
  const basePremium = units * rate.ratePer1000;
  const loading = pct(basePremium, extraLoadingBp);
  const riderTotal = sum(riderLines, (x) => x.charge);
  const annualPremium = basePremium + loading + riderTotal;
  const installmentPremium = pct(annualPremium, freq.factorBp);

  const triggers = [];
  const mr = cfg.medicalRules || {};
  if ((mr.ageAbove != null && age > mr.ageAbove) || (mr.sumAssuredAbove != null && sumAssured > mr.sumAssuredAbove)) {
    triggers.push('Medical examination required by age / sum assured rules');
  }
  const fr = cfg.financialRules || {};
  if (annualIncome && fr.maxIncomeMultiple && sumAssured > annualIncome * fr.maxIncomeMultiple) {
    triggers.push(`Sum assured exceeds ${fr.maxIncomeMultiple}x annual income — financial review`);
  }
  if (tobacco) triggers.push('Tobacco user');
  if (input.medical?.hasConditions) triggers.push('Declared medical history');

  return {
    product: 'life',
    planId: plan.id, planCode: plan.code, planName: plan.name, planVersion: version.version,
    startDate, age, maturityAge: age + policyTerm, sumAssured, policyTerm, premiumPaymentTerm,
    frequency, installmentsPerYear: freq.perYear, totalInstallments: premiumPaymentTerm * freq.perYear,
    uwClass, ratePer1000: rate.ratePer1000, units, basePremium, extraLoadingBp, loading,
    riders: riderLines, riderTotal, annualPremium, frequencyFactorBp: freq.factorBp, installmentPremium,
    medicalExamRequired: triggers.some((t) => t.startsWith('Medical')),
    underwritingRequired: triggers.length > 0,
    underwritingTriggers: triggers,
  };
}

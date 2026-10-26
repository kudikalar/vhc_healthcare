// Partners module — marketplace catalogue (Phase 1 §4–§7).
//
// Product categories are configurable records (`productCategories`). A product (plan) belongs to one or
// more categories and is listed publicly only when distributionStatus(plan).allowed. The comparison engine
// summarises the insurer's product terms; the insurer's own documents (CIS and policy wording) always
// override these summaries. Fields the sandbox product terms do not define are reported as "n/a" rather
// than invented.
import { db, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { currentVersion, gstSplit, GST_BP, planVersion } from './pricing.js';
import { distributionStatus, insurerOf } from './insurerHub.js';
import { EDITABLE, APP_STATUS as S } from './lifecycle.js';
import { rupees } from '../utils/money.js';

export const DEFAULT_CATEGORIES = [
  ['individual', 'Individual health', 'Cover for one person with their own sum insured.', ['individual']],
  ['family_floater', 'Family floater', 'One shared sum insured for the whole family.', ['floater']],
  ['senior_citizen', 'Senior citizen', 'Plans designed for people aged 60 and above.', ['senior']],
  ['top_up', 'Top-up', 'Extra cover above a deductible, per claim.', []],
  ['super_top_up', 'Super top-up', 'Extra cover above an aggregate deductible across the year.', []],
  ['critical_illness', 'Critical illness', 'Lump sum on diagnosis of a listed critical illness.', []],
  ['personal_accident', 'Personal accident', 'Cover for accidental death and disability.', []],
  ['disease_specific', 'Disease-specific', 'Cover focused on one condition (for example cancer or diabetes).', []],
  ['maternity', 'Maternity', 'Stand-alone maternity and newborn cover.', []],
  ['opd', 'OPD', 'Out-patient consultations, diagnostics and pharmacy.', []],
  ['hospital_cash', 'Hospital cash', 'A fixed daily amount while hospitalised.', []],
  ['group_medical', 'Group medical', 'Employer-provided group health cover.', []],
  ['group_pa', 'Group personal accident', 'Employer-provided accident cover.', []],
  ['wellness', 'Wellness', 'Preventive care and wellness programmes.', []],
].map(([key, label, description, planTypes], i) => ({ id: `cat_${key}`, key, label, description, planTypes, enabled: true, order: i + 1 }));

export const QUOTE_VALIDITY_DAYS = 7;
export const QUOTE_SOURCE = 'Sandbox insurer rating engine (synthetic)';
export const DOCS_OVERRIDE_NOTE = 'This is a summary. The insurer\'s Customer Information Sheet and policy wording are the governing documents and override anything shown here.';
export const MIS_SELLING_NOTE = 'Rankings and recommendations are never boosted by commission or remuneration. Products are ordered by your filters only.';

export const categories = () => db.all('productCategories').slice().sort((a, b) => a.order - b.order);
export const categoryByKey = (key) => db.findOne('productCategories', (c) => c.key === key);

/** Category keys a plan is listed under (explicit plan.categories, otherwise by plan type). */
export function planCategories(plan) {
  if (Array.isArray(plan.categories) && plan.categories.length) return plan.categories;
  return DEFAULT_CATEGORIES.filter((c) => c.planTypes.includes(plan.type)).map((c) => c.key);
}

const NA = 'n/a';
const daysFrom = (benefits, re) => {
  const m = (benefits || []).map((b) => b.match(re)).find(Boolean);
  return m ? Number(m[1]) : null;
};
export const networkHospitalCount = () => db.find('hospitals', (h) => h.network && h.active !== false).length;

/** Comparison fields for a product version (spec §6). Values not defined in the product terms are 'n/a'. */
export function productSpec(plan, version = currentVersion(plan)) {
  const ins = insurerOf(plan);
  const cfg = version.config;
  const d = plan.productDetails || {};
  const common = {
    insurer: ins ? { id: ins.id, name: ins.name, sandbox: !!ins.sandbox, status: ins.status } : null,
    product: plan.name, planId: plan.id, uin: plan.uin || null, version: version.version, versionDate: version.createdAt || null,
    sandbox: plan.sandbox !== false, categories: planCategories(plan),
    cisUrl: `/api/partners/products/${plan.id}/cis.pdf?version=${version.version}`,
    wordingUrl: `/api/partners/products/${plan.id}/wording.pdf?version=${version.version}`,
    documentsNote: DOCS_OVERRIDE_NOTE,
  };
  if (plan.product === 'life') {
    return {
      ...common, coverType: 'Individual term life',
      sumInsuredOptions: { min: cfg.minSumAssured, max: cfg.maxSumAssured },
      term: `${cfg.policyTerms.join(', ')} years`, ageEligibility: { min: cfg.minEntryAge, max: cfg.maxEntryAge, maxMaturityAge: cfg.maxMaturityAge },
      premium: { note: 'Depends on age, term, sum assured and tobacco use — get a quote', gstBp: GST_BP },
      riders: cfg.riders.map((r) => ({ name: r.name, annualCharge: r.annualCharge })),
      exclusions: cfg.exclusions, maturityBenefit: 'None (pure term cover)',
      portability: NA, networkHospitals: NA,
    };
  }
  const minPremium = Math.min(...cfg.ageBands.map((b) => b.premium));
  const opt = (code) => (cfg.optionalBenefits || []).find((o) => o.code === code);
  const benefitText = (re) => (cfg.benefits || []).find((b) => re.test(b)) || null;
  return {
    ...common,
    coverType: plan.type === 'floater' ? 'Family floater (shared sum insured)' : 'Individual sum insured',
    sumInsuredOptions: cfg.coverageOptions.map((c) => c.amount),
    premium: { from: minPremium, basis: 'per member per year, lowest sum insured and age band, GST-inclusive', gst: gstSplit(minPremium) },
    term: `${cfg.durationMonths} months`,
    ageEligibility: { min: cfg.minEntryAge, max: cfg.maxEntryAge },
    maxMembers: cfg.maxMembers, relationships: cfg.eligibleRelationships,
    copayBp: cfg.copayBp, deductiblePerClaim: cfg.deductiblePerClaim,
    roomRentLimitPerDay: cfg.roomRentLimitPerDay, icuLimit: d.icuLimit ?? NA,
    waitingPeriods: { initialDays: cfg.initialWaitingDays, conditions: cfg.conditionWaitingPeriods || [] },
    pedConditions: d.pedConditions || 'Declared conditions go to underwriting; listed conditions carry the condition waiting periods shown',
    sublimits: d.sublimits?.length ? d.sublimits : [`Room rent up to ${rupees(cfg.roomRentLimitPerDay)} per day`],
    restoration: d.restoration ?? NA,
    ncb: d.ncb ?? NA,
    dayCare: (cfg.benefits || []).some((b) => /day-?care/i.test(b)),
    preHospitalisationDays: daysFrom(cfg.benefits, /pre-hospitali[sz]ation \((\d+) days\)/i),
    postHospitalisationDays: daysFrom(cfg.benefits, /post-hospitali[sz]ation \((\d+) days\)/i),
    ambulance: benefitText(/ambulance/i) || NA,
    maternity: opt('MATERNITY') ? { addOn: true, charge: opt('MATERNITY').charge } : NA,
    opd: opt('OPD') ? { addOn: true, charge: opt('OPD').charge } : NA,
    networkHospitals: networkHospitalCount(),
    exclusions: (cfg.exclusions || []).map((e) => e.label),
    portability: d.portability || 'Portability requests are decided by the insurer (see Portability)',
    benefits: cfg.benefits || [],
  };
}

/** Public product card + spec + distribution status. */
export function productListing(plan) {
  return { ...productSpec(plan), distribution: distributionStatus(plan) };
}

// ---------- quotes ----------
const quoteRef = () => `QT-${today().slice(0, 4)}-${String(nextSeq('quoteRef')).padStart(6, '0')}`;

export function underwritingExplanation(q) {
  if (q.underwritingRequired) {
    return `Your declarations include items the insurer's rules send to a human underwriter (${q.underwritingTriggers.length} item(s) listed). This is not a rejection: the underwriter may accept at standard terms, propose revised terms that you must accept before paying, or decline.`;
  }
  return 'No underwriting review is triggered by your declarations. The insurer still makes the final issuance decision, and incorrect or incomplete declarations can change the outcome.';
}

/** Adds the reference number, validity, versioned product info, source label and tax split to a quote. */
export function decorateQuote(q, plan) {
  const version = planVersion(plan, q.planVersion);
  const ins = insurerOf(plan);
  const issuedAt = now().toISOString();
  return {
    ...q,
    reference: quoteRef(),
    issuedAt,
    validityDays: QUOTE_VALIDITY_DAYS,
    expiresAt: new Date(now().getTime() + QUOTE_VALIDITY_DAYS * 86400000).toISOString(),
    source: QUOTE_SOURCE,
    productInfo: {
      planId: plan.id, name: plan.name, uin: plan.uin || null, version: version.version, versionDate: version.createdAt || null,
      insurerId: ins?.id || null, insurerName: ins?.name || plan.insurerName || null, sandbox: plan.sandbox !== false,
    },
    tax: q.tax || gstSplit(q.totalAnnualPremium ?? q.annualPremium),
    underwritingExplanation: underwritingExplanation(q),
    distribution: distributionStatus(plan),
    documentsNote: DOCS_OVERRIDE_NOTE,
  };
}

// ---------- purchase journey (spec §7) ----------
export const PURCHASE_STATUSES = [
  'Draft', 'Quote Generated', 'Proposal Submitted', 'Additional Information Required', 'Underwriting Review', 'Payment Pending',
  'Payment Confirmed', 'Issuance Pending', 'Issued', 'Declined', 'Declined by Insurer', 'Cancelled', 'Refund Pending',
];
export const JOURNEY_STEPS = [
  ['policy', 'Choose policy'], ['members', 'Members'], ['proposer', 'Proposer'], ['nominee', 'Nominee'], ['declarations', 'Declarations'],
  ['documents', 'Documents'], ['quote', 'Review quote'], ['disclosures', 'Review CIS & wording'], ['consent', 'Consent'], ['submit', 'Submit'],
  ['pay', 'Pay'], ['issuance', 'Await insurer issuance'], ['issued', 'Policy issued'],
].map(([key, label]) => ({ key, label }));

/** Maps the workflow status (+ payment/refund state) to the customer-facing purchase status. */
export function purchaseStatus(app) {
  const payment = db.findOne('payments', (p) => p.applicationId === app.id && p.status === 'success');
  const pendingPayment = db.findOne('payments', (p) => p.applicationId === app.id && p.status === 'pending');
  const quoteOk = !!(app.quote && app.quote.expiresAt > now().toISOString());
  const map = {
    [S.DRAFT]: quoteOk ? 'Quote Generated' : 'Draft',
    [S.SUBMITTED]: 'Proposal Submitted', [S.INITIAL_REVIEW]: 'Proposal Submitted',
    [S.MIR]: 'Additional Information Required', [S.UNDERWRITING]: 'Underwriting Review', [S.POSTPONED]: 'Underwriting Review',
    [S.APPROVED]: 'Payment Pending', [S.ACCEPTED]: 'Payment Pending',
    [S.ISSUANCE_PENDING]: 'Issuance Pending', [S.ISSUED]: 'Issued',
    [S.REJECTED]: 'Declined', [S.DECLINED]: 'Cancelled', [S.INSURER_DECLINED]: 'Declined by Insurer',
  };
  const status = map[app.status] || app.status;
  const refundStatus = payment?.refundStatus || null;
  const flags = [];
  if (payment) flags.push('Payment Confirmed');
  if (app.status === S.INSURER_DECLINED && ['pending', 'refund_failed'].includes(refundStatus)) flags.push('Refund Pending');
  let message = null;
  if (app.status === S.ISSUANCE_PENDING) message = 'Payment received — waiting for the insurer to issue your policy.';
  else if (app.status === S.INSURER_DECLINED) message = refundStatus === 'refunded' ? 'Insurer declined — your premium has been refunded in full.' : 'Insurer declined — full refund initiated.';
  else if (app.status === S.APPROVED) message = 'Accept the offer to continue to payment.';
  else if (app.status === S.ACCEPTED) message = pendingPayment ? 'Payment in progress.' : 'Pay the first premium to send your proposal to the insurer.';
  else if (app.status === S.POSTPONED) message = 'The underwriter has postponed this proposal.';
  return { status, flags, message, paymentReference: payment?.reference || null, refundStatus };
}

/** Step indicator state for the customer purchase journey. */
export function journey(app, { declarationsComplete, proposerComplete, documentsComplete, nomineesComplete }) {
  const done = {
    policy: true,
    members: app.product === 'health' ? app.health.members.some((m) => m.fullName?.trim()) : !!app.life.lifeAssured?.fullName?.trim(),
    proposer: proposerComplete,
    nominee: app.product === 'health' ? null : nomineesComplete,
    declarations: declarationsComplete,
    documents: documentsComplete,
    quote: !!app.quote,
    disclosures: !!app.disclosures?.acknowledgedAt && app.disclosures.planVersion === app.planVersion,
    consent: !!app.consent?.given,
    submit: !!app.submittedAt,
    pay: [S.ISSUANCE_PENDING, S.ISSUED, S.INSURER_DECLINED].includes(app.status),
    issuance: [S.ISSUED, S.INSURER_DECLINED].includes(app.status),
    issued: app.status === S.ISSUED,
  };
  const steps = JOURNEY_STEPS.map((s) => ({ ...s, state: done[s.key] === null ? 'not_applicable' : done[s.key] ? 'done' : 'todo' }));
  // Once a proposal has left the editable stages, earlier steps that were not recorded (e.g. proposals
  // submitted before the step existed) are shown as skipped rather than as outstanding work.
  if (!EDITABLE.includes(app.status)) {
    const submitIdx = steps.findIndex((s) => s.key === 'submit');
    steps.slice(0, submitIdx + 1).forEach((s) => { if (s.state === 'todo') s.state = 'skipped'; });
  }
  const current = steps.find((s) => s.state === 'todo');
  // While VHC/insurer underwriting is reviewing, the next step is blocked on them rather than the customer.
  const reviewing = [S.SUBMITTED, S.INITIAL_REVIEW, S.UNDERWRITING, S.POSTPONED].includes(app.status);
  if (current) current.state = reviewing ? 'waiting' : 'current';
  if (app.status === S.INSURER_DECLINED) steps.find((s) => s.key === 'issued').state = 'failed';
  if ([S.REJECTED, S.DECLINED].includes(app.status)) steps.filter((s) => s.state === 'current' || s.state === 'todo').forEach((s) => { s.state = 'stopped'; });
  return steps;
}

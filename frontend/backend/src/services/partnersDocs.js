// Partners module — synthetic product documents (Customer Information Sheet, policy wording) and the
// health insurance e-card. Every page carries a "SANDBOX — synthetic" banner: these are generated from the
// sandbox product configuration and are not documents issued by a real insurer.
import PDFDocument from 'pdfkit';
import { db } from '../db.js';
import { rupees } from '../utils/money.js';
import { policyStatusAt } from './lifecycle.js';
import { planVersion } from './pricing.js';
import { productSpec } from './partnersCatalog.js';

const BRAND = '#087f8c';
const SANDBOX = 'SANDBOX — synthetic document generated for testing. Not issued by a real insurer. Not valid for any claim or treatment.';

function start(res, filename, { banner: bannerText = SANDBOX, ...opts } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, ...opts });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  const banner = () => {
    const { x, y } = { x: doc.x, y: doc.y };
    doc.save().rect(0, 0, doc.page.width, 22).fill('#fff4d6').restore();
    doc.fillColor('#8a5300').fontSize(8).text(bannerText, 20, 7, { width: doc.page.width - 40, align: 'center', lineBreak: false });
    doc.fillColor('#111');
    doc.x = x; doc.y = Math.max(y, 40);
  };
  banner();
  doc.on('pageAdded', banner);
  return doc;
}
const h = (doc, t) => doc.moveDown(0.6).fillColor(BRAND).fontSize(12).text(t).moveDown(0.2);
const p = (doc, t) => doc.fillColor('#111').fontSize(9.5).text(t);
const row = (doc, k, v) => doc.fillColor('#333').fontSize(9.5).text(`${k}: `, { continued: true }).fillColor('#000').text(String(v ?? 'n/a'));
const na = (v, f = (x) => x) => (v === 'n/a' || v == null ? 'n/a (not defined in the sandbox product terms)' : f(v));

function header(doc, title, plan, version) {
  const ins = db.get('insurers', plan.insurerId);
  doc.fillColor(BRAND).fontSize(18).text(title);
  doc.fillColor('#555').fontSize(9).text(`${plan.name} · UIN ${plan.uin || 'n/a'} · version ${version.version} · insurer: ${ins?.name || plan.insurerName || 'n/a'}`);
  doc.fillColor('#555').fontSize(8).text('Vision Health Care (VHC) is a technology platform / intermediary. The insurance is underwritten and issued only by the insurer named above.');
  doc.moveDown(0.5);
}

/** Customer Information Sheet in the standard IRDAI section order (content from the sandbox configuration). */
export function streamCis(plan, versionNo, res) {
  const version = planVersion(plan, versionNo);
  const s = productSpec(plan, version);
  const cfg = version.config;
  const doc = start(res, `CIS-${plan.code}-v${version.version}.pdf`);
  header(doc, 'Customer Information Sheet', plan, version);
  if (plan.product === 'health') {
    h(doc, '1. Name of product / type'); p(doc, `${plan.name} — ${s.coverType}`);
    h(doc, '2. What am I covered for'); (cfg.benefits || []).forEach((b) => p(doc, `• ${b}`));
    p(doc, `Sum insured options: ${s.sumInsuredOptions.map(rupees).join(', ')}`);
    h(doc, '3. What is not covered (exclusions)'); s.exclusions.forEach((e) => p(doc, `• ${e}`));
    h(doc, '4. Waiting periods');
    p(doc, `Initial waiting period: ${s.waitingPeriods.initialDays} days (except accidents)`);
    s.waitingPeriods.conditions.forEach((w) => p(doc, `• ${w.condition}: ${w.days} days`));
    p(doc, `Pre-existing conditions: ${s.pedConditions}`);
    h(doc, '5. Payout basis'); p(doc, 'Indemnity — reimbursement or cashless settlement of admissible expenses up to the sum insured.');
    h(doc, '6. Cost sharing');
    row(doc, 'Co-payment', `${cfg.copayBp / 100}% of each admissible claim`);
    row(doc, 'Deductible per claim', rupees(cfg.deductiblePerClaim));
    row(doc, 'Room rent limit', `${rupees(cfg.roomRentLimitPerDay)} per day`);
    row(doc, 'ICU limit', na(s.icuLimit));
    h(doc, '7. Sub-limits'); s.sublimits.forEach((x) => p(doc, `• ${x}`));
    h(doc, '8. Renewal conditions'); p(doc, `Renewal window opens ${cfg.renewalWindowDays ?? 60} days before expiry; grace period ${cfg.renewalGraceDays ?? 30} days (no cover for claims during the grace period break unless the insurer's wording says otherwise).`);
    h(doc, '9. Renewal benefits'); row(doc, 'No-claim bonus', na(s.ncb)); row(doc, 'Restoration of sum insured', na(s.restoration));
    h(doc, '10. Cancellation'); p(doc, 'Cancellation and refund terms are set by the insurer\'s policy wording (sandbox: refer to the synthetic wording).');
    h(doc, '11. Claims procedure'); p(doc, 'Intimate the claim through VHC or the insurer/TPA helpline. Cashless at network hospitals subject to pre-authorisation; reimbursement on submission of documents.');
    h(doc, '12. Portability'); p(doc, s.portability);
  } else {
    h(doc, '1. Name of product / type'); p(doc, `${plan.name} — pure term life insurance`);
    h(doc, '2. What am I covered for'); p(doc, 'Death benefit (sum assured) payable to nominees if death occurs during the policy term. No maturity benefit.');
    p(doc, `Sum assured: ${rupees(cfg.minSumAssured)} – ${rupees(cfg.maxSumAssured)} · Terms ${cfg.policyTerms.join(', ')} years`);
    h(doc, '3. Riders'); cfg.riders.forEach((r) => p(doc, `• ${r.name} — ${rupees(r.annualCharge)} per year`));
    h(doc, '4. Exclusions'); cfg.exclusions.forEach((e) => p(doc, `• ${e}`));
    h(doc, '5. Grace period'); Object.entries(cfg.frequencies).forEach(([k, f]) => p(doc, `• ${k}: ${f.graceDays} days`));
    h(doc, '6. Revival'); p(doc, `Lapsed policies may be reinstated within ${cfg.reinstatementWindowDays} days, subject to underwriting.`);
  }
  h(doc, 'Grievance redressal'); p(doc, 'Raise a grievance with VHC support or the insurer\'s grievance officer. Unresolved complaints may be escalated as per the insurer\'s policy wording. (Sandbox: no real grievance officer exists.)');
  doc.moveDown().fontSize(8).fillColor('#555').text('Premiums are quoted inclusive of 18% GST. This CIS summarises the policy wording; in case of any difference, the policy wording prevails.');
  doc.end();
}

/** Synthetic policy wording generated from the product version configuration. */
export function streamWording(plan, versionNo, res) {
  const version = planVersion(plan, versionNo);
  const cfg = version.config;
  const doc = start(res, `Wording-${plan.code}-v${version.version}.pdf`);
  header(doc, 'Policy Wording', plan, version);
  h(doc, 'Preamble');
  p(doc, 'This policy is a contract between the policyholder and the insurer named in the schedule. In consideration of the premium paid and subject to the terms, conditions and exclusions of this policy, the insurer agrees to pay or indemnify as described below. (Synthetic sandbox wording.)');
  if (plan.product === 'health') {
    h(doc, 'Section A — Definitions'); p(doc, 'Hospitalisation means admission for a minimum of 24 consecutive in-patient hours, except for listed day-care procedures. Sum insured means the maximum liability of the insurer for the policy year; on a family floater it is shared by all insured members.');
    h(doc, 'Section B — Coverage'); (cfg.benefits || []).forEach((b) => p(doc, `• ${b}`));
    h(doc, 'Section C — Waiting periods'); p(doc, `Initial ${cfg.initialWaitingDays} days.`); (cfg.conditionWaitingPeriods || []).forEach((w) => p(doc, `• ${w.condition}: ${w.days} days from continuous cover start`));
    h(doc, 'Section D — Cost sharing'); p(doc, `Deductible ${rupees(cfg.deductiblePerClaim)} per claim, then co-payment ${cfg.copayBp / 100}%. Room rent payable up to ${rupees(cfg.roomRentLimitPerDay)} per day.`);
    h(doc, 'Section E — Exclusions'); (cfg.exclusions || []).forEach((e) => p(doc, `• ${e.label}`));
    h(doc, 'Section F — Optional covers'); (cfg.optionalBenefits || []).forEach((o) => p(doc, `• ${o.name} (additional premium ${rupees(o.charge)})`));
    h(doc, 'Section G — General conditions'); p(doc, `Policy period ${cfg.durationMonths} months. Renewal window ${cfg.renewalWindowDays ?? 60} days before expiry; grace period ${cfg.renewalGraceDays ?? 30} days. Disclosure of material facts is required; non-disclosure may affect claims. Portability and migration requests are decided by the insurer.`);
  } else {
    h(doc, 'Section A — Benefit'); p(doc, 'On death of the life assured during the policy term while the policy is in force, the sum assured is payable to the nominee(s)/legal heirs. No maturity or surrender benefit.');
    h(doc, 'Section B — Premiums'); Object.entries(cfg.frequencies).forEach(([k, f]) => p(doc, `• ${k} premiums, grace period ${f.graceDays} days`));
    h(doc, 'Section C — Exclusions'); cfg.exclusions.forEach((e) => p(doc, `• ${e}`));
    h(doc, 'Section D — Revival'); p(doc, `Within ${cfg.reinstatementWindowDays} days of lapse, subject to evidence of good health and payment of arrears.`);
  }
  doc.end();
}

/** Synthetic health insurance e-card (one card per insured member). */
export function streamECard(policy, res) {
  const doc = start(res, `ECard-${policy.policyNumber}.pdf`, { size: [420, 300], margin: 24, banner: 'SANDBOX — synthetic e-card. Not valid for treatment or claims.' });
  const ins = db.get('insurers', policy.insurerId);
  const tpa = db.findOne('tpas', (t) => (t.insurerIds || []).includes(policy.insurerId));
  const status = policyStatusAt(policy);
  policy.members.forEach((m, i) => {
    if (i > 0) doc.addPage({ size: [420, 300], margin: 24 });
    doc.save().roundedRect(18, 34, 384, 240, 10).lineWidth(1.2).stroke(BRAND).restore();
    doc.fillColor(BRAND).fontSize(13).text('Health Insurance E-Card', 32, 46);
    doc.fillColor('#8a5300').fontSize(7.5).text('SANDBOX — SYNTHETIC — NOT VALID FOR TREATMENT', 32, 64);
    const line = (k, v, y) => { doc.fillColor('#555').fontSize(8).text(k, 32, y); doc.fillColor('#000').fontSize(10).text(String(v ?? '—'), 150, y - 1, { width: 240 }); };
    line('Member', m.fullName, 86);
    line('Relationship / DOB', `${m.relationship} · ${m.dob}`, 104);
    line('Member ID', `${policy.policyNumber}-${String(i + 1).padStart(2, '0')}`, 122);
    line('Policy number', policy.policyNumber, 140);
    line('Insurer', ins?.name || policy.insurerName, 158);
    line('Product / UIN', `${policy.planName} · ${policy.productUin || 'n/a'}`, 176);
    line('Valid', `${policy.startDate} to ${policy.endDate} (${status})`, 194);
    line('Sum insured', `${rupees(policy.coverage)}${policy.planType === 'floater' ? ' (shared floater)' : ''}`, 212);
    line('TPA / helpline', `${tpa?.name || 'Insurer direct'} · ${ins?.claimsContact?.phone || 'n/a'}`, 230);
    doc.fillColor('#555').fontSize(7).text('Show this card at a network hospital for cashless pre-authorisation. Cover is subject to policy terms.', 32, 252, { width: 360 });
  });
  doc.end();
}

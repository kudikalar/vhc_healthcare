// Synthetic group health product definitions and the group premium engine.
//
// SANDBOX ONLY. "Group Medical (Sandbox)" is a fictional product of the synthetic sandbox insurer
// (ins_sandbox). Its rates, sum insured options, family definitions and waivers are made up for QA and
// demonstrations; they are not quoted, filed or approved by any real insurer. A real group product is
// added only under a signed insurer agreement, and the insurer's own rating then replaces this engine.
//
// Money is integer paise; rates/multipliers/GST are basis points.
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { ageOn, diffDays } from '../utils/dates.js';
import { pct, sum } from '../utils/money.js';

const LAKH = 100000 * 100; // paise
const R = (rupees) => rupees * 100;

export const GST_BP = 1800;
export const RELATIONSHIPS = ['self', 'spouse', 'child', 'parent'];
export const DEPENDENT_RELATIONSHIPS = ['spouse', 'child', 'parent'];

/** Family definitions: who may be covered under one employee. */
export const FAMILY_DEFINITIONS = {
  E: { label: 'Employee only', relationships: ['self'] },
  ES: { label: 'Employee + spouse', relationships: ['self', 'spouse'] },
  ESC: { label: 'Employee + spouse + children', relationships: ['self', 'spouse', 'child'] },
  ESCP: { label: 'Employee + spouse + children + parents', relationships: ['self', 'spouse', 'child', 'parent'] },
};

export const GROUP_PRODUCTS = [
  {
    id: 'grp_sbx_medical',
    code: 'SBX-GMC-001',
    uin: 'SBX-GMC-001 (synthetic — not a filed UIN)',
    name: 'Group Medical (Sandbox)',
    insurerId: SANDBOX_INSURER_ID,
    insurerName: 'VHC Sandbox Insurer (Synthetic)',
    sandbox: true,
    synthetic: true,
    label: 'SANDBOX — synthetic product for testing. Not a real insurance product; rates are illustrative only.',
    premiumBasis: 'Per life, annual, by age band at cover start; sum insured multiplier; 18% GST added',
    sumInsuredOptions: [3 * LAKH, 5 * LAKH, 10 * LAKH],
    sumInsuredMultiplierBp: { [3 * LAKH]: 10000, [5 * LAKH]: 14500, [10 * LAKH]: 22000 },
    // Annual premium per life for the ₹3 lakh base sum insured (synthetic).
    ageBands: [
      { band: '0-17', min: 0, max: 17, rate: R(2400) },
      { band: '18-35', min: 18, max: 35, rate: R(3600) },
      { band: '36-45', min: 36, max: 45, rate: R(5200) },
      { band: '46-55', min: 46, max: 55, rate: R(8400) },
      { band: '56-65', min: 56, max: 65, rate: R(13200) },
      { band: '66-80', min: 66, max: 80, rate: R(19800) },
    ],
    familyDefinitions: Object.keys(FAMILY_DEFINITIONS),
    defaultDependentRules: { maxSpouses: 1, maxChildren: 2, childMaxAge: 25, maxParents: 2, parentMaxAge: 80 },
    // Waivers typical of group cover (synthetic terms).
    waivers: [
      { code: 'INITIAL_30_DAY', label: '30-day initial waiting period waived' },
      { code: 'PED', label: 'Pre-existing disease waiting period waived' },
      { code: 'SPECIFIC_ILLNESS', label: 'Specific illness waiting periods waived' },
      { code: 'MATERNITY_9M', label: '9-month maternity waiting period waived' },
    ],
    contacts: {
      insurer: { name: 'VHC Sandbox Insurer (Synthetic) — group desk', email: 'group-desk@sandbox-insurer.test', phone: '1800-000-0000 (sandbox)' },
      claims: { name: 'Sandbox TPA Services (Synthetic) — claims helpdesk', email: 'claims@sandbox-tpa.test', phone: '1800-000-0001 (sandbox)', hours: '24x7 (simulated)' },
    },
  },
];

export const productById = (id) => GROUP_PRODUCTS.find((p) => p.id === id) || null;

export function bandFor(product, age) {
  return product.ageBands.find((b) => age >= b.min && age <= b.max) || null;
}

/** Annual per-life premium (paise) for a band and sum insured; throws on an unsupported sum insured. */
export function perLifePremium(product, bandName, sumInsured) {
  const band = product.ageBands.find((b) => b.band === bandName);
  if (!band) return null;
  const mult = product.sumInsuredMultiplierBp[sumInsured];
  if (!mult) return null;
  return pct(band.rate, mult);
}

/** Premium for one covered life given the policy terms and the life's age on `on`. null when ineligible by age. */
export function lifePremium(terms, dob, on) {
  const product = productById(terms.productId);
  const age = ageOn(dob, on);
  const band = bandFor(product, age);
  if (!band) return null;
  return { age, band: band.band, annualPremium: perLifePremium(product, band.band, terms.sumInsured) };
}

/**
 * Census-based group quotation. census: [{ band, lives }]. Returns lines, net premium, GST and total.
 */
export function quoteFromCensus(product, { sumInsured, census }) {
  const lines = [];
  for (const c of census) {
    const lives = Number(c.lives);
    if (!Number.isInteger(lives) || lives < 0) throw new Error(`Lives for band ${c.band} must be a whole number`);
    if (!lives) continue;
    const perLife = perLifePremium(product, c.band, sumInsured);
    if (perLife == null) throw new Error(`Unknown age band ${c.band}`);
    lines.push({ band: c.band, lives, perLife, premium: perLife * lives });
  }
  const netPremium = sum(lines, (l) => l.premium);
  const gst = pct(netPremium, GST_BP);
  return { lines, lives: sum(lines, (l) => l.lives), netPremium, gstBp: GST_BP, gst, total: netPremium + gst };
}

/**
 * Daily pro-rata premium for a mid-term endorsement (SANDBOX ASSUMPTION — a real insurer's short-period
 * or pro-rata rules override this):
 *   addition, effective D (first covered day):  annual × (end − D + 1) / policyDays
 *   deletion, effective D (last covered day):   annual × (end − D) / policyDays   (credit)
 * policyDays = end − start + 1. Rounded to the nearest paisa.
 */
export function proRata(annualPremium, { startDate, endDate }, effectiveDate, type) {
  const policyDays = diffDays(startDate, endDate) + 1;
  const days = type === 'addition' ? diffDays(effectiveDate, endDate) + 1 : diffDays(effectiveDate, endDate);
  const d = Math.max(0, Math.min(days, policyDays));
  return { days: d, policyDays, amount: Math.round((annualPremium * d) / policyDays) };
}

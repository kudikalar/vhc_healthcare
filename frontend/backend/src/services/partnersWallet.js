// Partners module — customer policy wallet: insurer and product identity, documents, claims contacts,
// renewal/grace indicators and a qualified "active sum insured" summary (floater cover is shared, so it is
// counted once per policy, never per member).
import { db } from '../db.js';
import { today } from '../clock.js';
import { addDays, diffDays } from '../utils/dates.js';
import { policyStatusAt } from './lifecycle.js';
import { currentVersion, gstSplit } from './pricing.js';

export function renewalIndicator(p, at = today()) {
  if (p.product !== 'health') return null;
  const cfg = p.termsSnapshot || {};
  const grace = cfg.renewalGraceDays ?? 30;
  const window = cfg.renewalWindowDays ?? 60;
  const daysToEnd = diffDays(at, p.endDate);
  const graceEnds = addDays(p.endDate, grace);
  if (p.renewedBy) return { state: 'renewed', label: 'Renewed', daysToEnd, graceEnds };
  if (daysToEnd >= 0 && daysToEnd <= window) return { state: 'due', label: `Renewal due — ${daysToEnd} day(s) left`, daysToEnd, graceEnds };
  if (daysToEnd < 0 && at <= graceEnds) return { state: 'grace', label: `In renewal grace period until ${graceEnds} — no cover for events during the break`, daysToEnd, graceEnds };
  if (daysToEnd < 0) return { state: 'ended', label: 'Expired — renewal grace period over', daysToEnd, graceEnds };
  return { state: 'ok', label: `Renews on ${addDays(p.endDate, 1)}`, daysToEnd, graceEnds };
}

export function walletEntry(p) {
  const ins = db.get('insurers', p.insurerId);
  const tpa = db.findOne('tpas', (t) => (t.insurerIds || []).includes(p.insurerId));
  const plan = db.get('plans', p.planId);
  const status = policyStatusAt(p);
  const cfg = p.termsSnapshot || {};
  const exclusions = p.product === 'health' ? (cfg.exclusions || []).map((e) => e.label) : cfg.exclusions || [];
  return {
    policyId: p.id, policyNumber: p.policyNumber, insurerPolicyReference: p.insurerPolicyReference || null,
    insurer: ins ? { id: ins.id, name: ins.name, sandbox: !!ins.sandbox } : { id: p.insurerId, name: p.insurerName, sandbox: p.sandbox !== false },
    uin: p.productUin || plan?.uin || null, planVersion: p.planVersion, currentPlanVersion: plan ? currentVersion(plan).version : null, sandbox: p.sandbox !== false,
    product: p.product, planName: p.planName, planType: p.planType, status,
    coveredMembers: p.product === 'health' ? (p.members || []).map((m) => ({ fullName: m.fullName, relationship: m.relationship, dob: m.dob })) : [{ fullName: p.lifeAssured?.fullName, relationship: 'life assured', dob: p.lifeAssured?.dob }],
    sumInsured: p.product === 'health' ? p.coverage : p.sumAssured, sharedFloater: p.planType === 'floater',
    effectiveDate: p.startDate, endDate: p.endDate, renewalDate: addDays(p.endDate, 1),
    premium: { annual: p.annualPremium, installment: p.installmentPremium || null, frequency: p.frequency || 'annual', tax: gstSplit(p.annualPremium) },
    importantExclusions: exclusions.slice(0, 6),
    claimsContacts: [
      ins?.claimsContact ? { kind: 'Insurer', name: ins.name, phone: ins.claimsContact.phone, email: ins.claimsContact.email, hours: ins.claimsContact.hours } : null,
      tpa ? { kind: 'TPA', name: tpa.name, phone: tpa.contacts?.[0]?.phone || null, email: tpa.contacts?.[0]?.email || null } : null,
      { kind: 'VHC support', name: 'Vision Health Care support', link: '/support' },
    ].filter(Boolean),
    documents: {
      policyPdf: `/api/policies/${p.id}/pdf`,
      cis: plan ? `/api/partners/products/${plan.id}/cis.pdf?version=${p.planVersion}` : null,
      wording: plan ? `/api/partners/products/${plan.id}/wording.pdf?version=${p.planVersion}` : null,
      ecard: p.product === 'health' ? `/api/partners/wallet/policies/${p.id}/ecard.pdf` : null,
    },
    networkHospitalsLink: p.product === 'health' ? '/hospitals' : null,
    renewal: renewalIndicator(p),
    servicing: [
      p.product === 'health' && { action: 'renew', label: 'Renew', link: `/policies/${p.id}` },
      p.product === 'health' && { action: 'portability', label: 'Port / migrate', link: `/portability?policy=${p.id}` },
      p.product === 'health' && { action: 'claim', label: 'File a claim', link: `/claims/new?policy=${p.id}` },
      p.product === 'life' && { action: 'nominees', label: 'Update nominees', link: `/policies/${p.id}?tab=nominees` },
      { action: 'support', label: 'Servicing request', link: '/support' },
    ].filter(Boolean),
  };
}

/** Wallet for a customer: per-policy entries and a qualified active-sum-insured summary. */
export function wallet(userId) {
  const policies = db.find('policies', (p) => p.userId === userId).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const entries = policies.map(walletEntry);
  const activeHealth = entries.filter((e) => e.product === 'health' && e.status === 'Active');
  return {
    policies: entries,
    activeSumInsured: {
      total: activeHealth.reduce((t, e) => t + e.sumInsured, 0),
      perPolicy: activeHealth.map((e) => ({ policyNumber: e.policyNumber, sumInsured: e.sumInsured, sharedFloater: e.sharedFloater, members: e.coveredMembers.length })),
      qualifier: 'Sum of active health policies, counted once per policy. A policy\'s sum insured (including a family floater) is shared by all members on that policy — it is not available to each member separately. Life cover is not included.',
    },
  };
}

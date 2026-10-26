// Idempotent reference/demo data for the partners module. Called by ensureReferenceData() after a fresh
// seed (ctx.fresh === true) and at start-up on existing databases (ctx.fresh === false).
// Upserts by fixed ids and never deletes or overwrites existing values (only missing fields are filled).
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { addDays } from '../utils/dates.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { buildTasks } from './partners.js';
import { DEFAULT_CATEGORIES, planCategories } from './partnersCatalog.js';
import { LEAD_CONSENT_TEXT } from './partnersSales.js';
import { PORT_STATUS } from './partnersPortability.js';

const fill = (rec, defaults) => {
  for (const [k, v] of Object.entries(defaults)) if (rec[k] === undefined) rec[k] = v;
  return rec;
};
const upsert = (col, rec) => {
  const existing = db.get(col, rec.id);
  return existing ? fill(existing, rec) : db.insert(col, rec);
};

function ensureCategories() {
  for (const c of DEFAULT_CATEGORIES) upsert('productCategories', { ...c, planTypes: [...c.planTypes] });
}

function ensureInsurerOnboarding() {
  for (const ins of db.all('insurers')) {
    const isSandbox = ins.id === SANDBOX_INSURER_ID;
    const isCandidate = ins.id.startsWith('ins_candidate_');
    fill(ins, {
      candidate: isCandidate,
      onboardingTasks: buildTasks(isSandbox ? 'Active' : null),
      uins: Object.fromEntries((ins.authorizedPlanIds || []).map((id) => [id, db.get('plans', id)?.uin]).filter(([, u]) => u)),
      complianceDocuments: isSandbox
        ? [{ name: 'Synthetic test-entity declaration', reference: 'SBX-DOC-001', status: 'Verified', validTo: null }]
        : [],
      escalation: [],
    });
    if (isCandidate) ins.publishable = false; // candidates are never publishable
    if (isSandbox) {
      fill(ins, { claimsContact: { phone: '1800-000-0000 (sandbox)', email: 'claims@sandbox-insurer.test', hours: '24×7 (simulated)' } });
      ins.integration = fill(ins.integration || {}, {
        type: 'in-process', lastTest: { ok: true, method: 'automated', at: now().toISOString(), by: 'System (seed)', note: 'Sandbox simulator certified at seed time' },
        certifiedAt: now().toISOString(),
      });
      // The sandbox insurer self-authorises the synthetic products linked to it.
      const linked = db.find('plans', (p) => p.insurerId === SANDBOX_INSURER_ID).map((p) => p.id);
      ins.authorizedPlanIds = [...new Set([...(ins.authorizedPlanIds || []), ...linked])];
      for (const id of linked) if (!ins.uins[id] && db.get('plans', id)?.uin) ins.uins[id] = db.get('plans', id).uin;
    }
  }
}

function ensurePlanDetails() {
  for (const p of db.all('plans')) {
    fill(p, { categories: planCategories(p) });
    if (p.product === 'health') {
      fill(p, {
        productDetails: {
          icuLimit: null, restoration: null, ncb: null, sublimits: null,
          portability: 'Portability into this product is available on renewal; the insurer decides each request and applies any waiting-period credit (sandbox).',
        },
      });
    }
  }
}

function ensureDemoLeads(ctx) {
  if (!ctx.fresh || !ctx.demo) return;
  const at = now().toISOString();
  const base = { consent: { given: true, at, text: LEAD_CONSENT_TEXT }, notes: [], duplicateOf: null, ipHash: null, source: 'website' };
  upsert('leads', {
    id: 'lead_demo_1', reference: 'LD-DEMO-000001', name: 'Kavya Iyer', mobile: '+919000000101', email: 'kavya.iyer@example.test', city: 'Chennai',
    interest: 'category:family_floater', status: 'New', assignedTo: null, followUpAt: today(), ...base,
    history: [{ at, status: 'New', by: 'Website', note: 'Lead captured (family floater) — synthetic demo lead' }],
  });
  upsert('leads', {
    id: 'lead_demo_2', reference: 'LD-DEMO-000002', name: 'Rohit Bansal', mobile: '+919000000102', email: null, city: 'Pune',
    interest: 'category:senior_citizen', status: 'Contacted', assignedTo: db.get('users', 'usr_sales') ? 'usr_sales' : null, followUpAt: addDays(today(), 2), ...base,
    history: [{ at, status: 'New', by: 'Website', note: 'Lead captured (senior citizen) — synthetic demo lead' }, { at, from: 'New', status: 'Contacted', by: 'Rohan Batra', note: 'Called; parents aged 64 and 61' }],
  });
}

function ensureDemoPortability(ctx) {
  if (!ctx.fresh || !ctx.demo || !db.get('users', 'usr_meera')) return;
  const plan = db.get('plans', 'pln_health_floater');
  if (!plan) return;
  const at = now().toISOString();
  upsert('portabilityRequests', {
    id: 'prt_demo_meera', reference: 'PRT-DEMO-000001', type: 'portability', userId: 'usr_meera',
    from: { insurerName: 'Northstar Demo General Insurance (synthetic)', policyNumber: 'NDG-SYN-448812', productName: 'Northstar Family Health (synthetic)', sumInsured: 500000 * 100, policyEndDate: addDays(today(), 40), continuousCoverYears: 4, claimsInLastYear: false },
    toPlanId: plan.id, toPlanName: plan.name, toInsurerId: plan.insurerId, toInsurerName: plan.insurerName, requestedSumInsured: 1000000 * 100,
    status: PORT_STATUS.SUBMITTED, timing: { ok: true, note: 'Within the usual 15–60 day window (40 days before renewal).' },
    documentsRequested: [], customerResponses: [],
    history: [{ at, from: null, status: PORT_STATUS.SUBMITTED, by: 'Meera Reddy', role: 'customer', note: 'Portability request submitted (demo data)' }],
  });
}

export function ensurePartnerData(ctx) {
  ensureCategories();
  ensurePlanDetails();
  ensureInsurerOnboarding();
  ensureDemoLeads(ctx);
  ensureDemoPortability(ctx);
}

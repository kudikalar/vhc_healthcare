// Idempotent reference/demo data for the claimsOps module. Called by ensureReferenceData() after a fresh
// seed (ctx.fresh === true) and at start-up on existing databases (ctx.fresh === false).
// Must upsert by fixed ids and never delete or overwrite existing records.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, STORAGE_DIR } from '../db.js';
import { now } from '../clock.js';
import { addDays } from '../utils/dates.js';
import { publish } from './events.js';
import { DEFAULT_RULES, policyAt, SLA_SOURCE } from './claimsOpsSla.js';
import { enrichClaim } from './claimsOps.js';
import { runFraudRules } from './claimsOpsFraud.js';
import { pickOwner } from './claimsOpsGrievances.js';
import { ensureDemoPolicies } from './seed.js';

export const SLA_V1_ID = 'sla_v1';
const DEMO_CLAIM_ID = 'hcl_demo_meera_cashless';
const DEMO_GRIEVANCE_ID = 'grv_demo_asha';
const L = 100; // paise per rupee
const iso = (msAgo) => new Date(now().getTime() - msAgo).toISOString();

function ensureSlaPolicy() {
  if (db.get('slaPolicies', SLA_V1_ID)) return;
  db.insert('slaPolicies', {
    id: SLA_V1_ID, version: 1, effectiveFrom: '2024-01-01T00:00:00.000Z', rules: { ...DEFAULT_RULES }, source: SLA_SOURCE,
    changeNote: 'Baseline turnaround times: cashless pre-authorisation 60 min, final authorisation 180 min from the discharge request, settlement 15 days from the last necessary document, grievance resolution 14 days.',
    createdBy: 'System', createdById: 'system',
  });
}

/** Adds insurer reference / TPA / pinned SLA version to older claims and hashes older documents. */
function backfill() {
  for (const c of db.all('healthClaims')) {
    if (!c.insurerClaimRef || c.tpaId === undefined) enrichClaim(c);
    if (!c.slaPolicyId) c.slaPolicyId = policyAt(c.createdAt)?.id || null;
  }
  for (const d of db.find('documents', (x) => !x.sha256 && x.entityType === 'healthClaim')) {
    const file = path.join(STORAGE_DIR, `${d.id}.bin`);
    if (fs.existsSync(file)) d.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
}

/** A cashless claim for Meera's mother, waiting ~40 minutes for a pre-authorisation decision (at risk). */
function seedMeeraCashless() {
  if (db.get('healthClaims', DEMO_CLAIM_ID) || !db.get('users', 'usr_meera')) return null;
  ensureDemoPolicies(); // the QA family floater may not exist yet during a fresh seed
  const policy = db.findOne('policies', (p) => p.userId === 'usr_meera' && p.product === 'health');
  const hospital = db.get('hospitals', 'hsp_1');
  const member = policy?.members.find((m) => m.id === 'mem_lakshmi');
  if (!policy || !hospital || !member) return null;
  const at = iso(40 * 60_000);
  const t = at.slice(0, 10);
  const c = db.insert('healthClaims', {
    id: DEMO_CLAIM_ID, claimNumber: 'HC-SEED-000002', idempotencyKey: null, userId: 'usr_meera', policyId: policy.id, policyNumber: policy.policyNumber,
    memberId: member.id, memberName: member.fullName, type: 'cashless', hospitalId: hospital.id, hospitalName: hospital.name, networkHospital: true,
    admissionDate: t, dischargeDate: addDays(t, 3), diagnosis: 'Coronary artery disease', treatment: 'Coronary angioplasty with stent',
    isAccident: false, requestedAmount: 600000 * L, payoutDetails: null, payoutVerified: false, status: 'Preauth Requested', preauth: null,
    assessment: null, reservedAmount: 0, paidAmount: 0, documentRequests: [], internalNotes: [],
    timeline: [{ at, status: 'Preauth Requested', by: 'Sunrise insurance desk (demo)', role: 'hospital', note: 'Pre-authorisation requested at admission' }],
    createdAt: at, updatedAt: at, correlationId: `cor_claim_${DEMO_CLAIM_ID}`,
  });
  enrichClaim(c, { slaPolicyId: SLA_V1_ID });
  c.requests = { submittedAt: at, preauthRequestedAt: at };
  c.insurerComms.push({ at, direction: 'outbound', channel: 'Insurer API (sandbox)', subject: 'Cashless pre-authorisation request sent', message: `Insurer claim reference ${c.insurerClaimRef}${c.tpaName ? `; routed via ${c.tpaName}` : ''} (sandbox — simulated exchange).`, by: 'VHC Claims Ops', visibleToCustomer: true, insurerRef: c.insurerClaimRef });
  const actor = { id: 'usr_meera', role: 'customer', name: 'Meera Reddy' };
  const opts = (key) => ({ idempotencyKey: key, actor, subject: { type: 'healthClaim', id: c.id }, correlationId: c.correlationId });
  publish('CLAIM_INTIMATED', { claimId: c.id, claimNumber: c.claimNumber, type: c.type, insurerClaimRef: c.insurerClaimRef }, opts(`claim-intimated:claim:${c.id}`));
  publish('PREAUTH_REQUESTED', { claimId: c.id, claimNumber: c.claimNumber, hospitalId: c.hospitalId, requestedAt: at }, opts(`preauth-requested:${c.id}`));
  runFraudRules(c, 'seed'); // the estimate is over half the sum insured → an explainable FR08 review flag
  return c;
}

/** A claim-related grievance from Asha about her pending reimbursement claim. */
function seedAshaGrievance() {
  if (db.get('grievances', DEMO_GRIEVANCE_ID) || !db.get('users', 'usr_cust1')) return null;
  const claim = db.findOne('healthClaims', (c) => c.claimNumber === 'HC-SEED-000001');
  const ackAt = iso(2 * 86_400_000);
  const owner = db.get('users', 'usr_priya') || pickOwner('claim');
  const g = db.insert('grievances', {
    id: DEMO_GRIEVANCE_ID, reference: 'GRV-SEED-000001', idempotencyKey: null, userId: 'usr_cust1', customerName: 'Asha Verma', category: 'claim',
    subject: 'No update on my reimbursement claim', description: 'I submitted the reimbursement claim for my husband’s surgery but have not received any update on the review. Please tell me what is pending.',
    claimId: claim?.id || null, claimNumber: claim?.claimNumber || null, policyId: claim?.policyId || null, policyNumber: claim?.policyNumber || null,
    insurerId: claim?.insurerId || null, insurerName: claim?.insurerName || null, status: 'In Progress', acknowledgedAt: ackAt,
    slaPolicyId: SLA_V1_ID, slaPolicyVersion: 1, responseDueAt: new Date(Date.parse(ackAt) + DEFAULT_RULES.grievanceDays * 86_400_000).toISOString(),
    ownerId: owner?.id || null, ownerName: owner?.name || null, ownerRole: owner?.role || null,
    messages: [
      { id: 'msg_seed_1', at: ackAt, from: 'vhc', by: 'VHC (automated)', role: 'system', text: 'We have received your grievance GRV-SEED-000001. We will respond within 14 days.', internal: false },
      { id: 'msg_seed_2', at: iso(86_400_000), from: 'vhc', by: owner?.name || 'VHC claims assistance', role: owner?.role || 'claims_officer', text: 'Thank you, we are checking the claim file with the insurer and will update you shortly.', internal: false },
    ],
    insurerComms: [], escalations: [], resolution: null, firstResolvedAt: null, appeal: null, closedAt: null,
    history: [
      { at: ackAt, action: 'Created and acknowledged', by: 'Asha Verma', role: 'customer', note: null },
      { at: ackAt, action: 'Assigned', by: 'VHC (automated)', role: 'system', note: owner?.name || null },
      { at: iso(86_400_000), action: 'First response sent', by: owner?.name || 'VHC', role: owner?.role || 'claims_officer', note: null },
    ],
    createdAt: ackAt, updatedAt: iso(86_400_000),
  });
  publish('GRIEVANCE_CREATED', { grievanceId: g.id, reference: g.reference, category: g.category, claimId: g.claimId }, { idempotencyKey: `grievance-created:${g.id}`, actor: { id: 'usr_cust1', role: 'customer', name: 'Asha Verma' }, subject: { type: 'grievance', id: g.id } });
  return g;
}

export function ensureClaimsOpsData(ctx) {
  ensureSlaPolicy();
  backfill();
  if (ctx?.fresh && ctx?.demo) {
    seedMeeraCashless();
    seedAshaGrievance();
  }
}


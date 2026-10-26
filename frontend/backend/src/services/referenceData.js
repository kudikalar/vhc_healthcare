// Idempotent reference data and data migrations.
//
// ensureReferenceData() runs after a fresh seed AND at start-up on existing databases (staging), so new
// platform records (insurer registry, partner organisations, demo QA accounts, plan→insurer links) are
// added without deleting or rewriting anyone's accounts, policies or claims. Every step upserts by a
// fixed id and only fills fields that are missing.
//
// Each platform module contributes its own ensure step (see AREA_STEPS); those must be idempotent too.
import bcrypt from 'bcryptjs';
import { db, meta } from '../db.js';
import { now } from '../clock.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { newCustomerId, TERMS_VERSION } from './profile.js';
import { ensurePartnerData } from './partnersSeed.js';
import { ensureNetworkData } from './networkSeed.js';
import { ensureClaimsOpsData } from './claimsOpsSeed.js';
import { ensureCorporateData } from './corporateSeed.js';
import { ensureEnterpriseData } from './enterpriseSeed.js';

const DEMO_PASSWORD = 'VisionDemo#2026';
export const DEMO_ACCOUNTS_ENABLED = () => process.env.NODE_ENV !== 'production' || process.env.VHC_DEMO_ACCOUNTS === '1';

const upsert = (col, rec) => {
  const existing = db.get(col, rec.id);
  if (!existing) return db.insert(col, rec);
  for (const [k, v] of Object.entries(rec)) if (existing[k] === undefined) existing[k] = v;
  return existing;
};

// ---------- insurers ----------
// Only the synthetic sandbox insurer is active. The others are a *candidate* list for partnership
// exploration (status Prospect, never published): no agreement exists and none is implied.
const CANDIDATES = ['Star Health and Allied Insurance', 'HDFC ERGO General Insurance', 'Niva Bupa Health Insurance', 'Care Health Insurance', 'Aditya Birla Health Insurance', 'ManipalCigna Health Insurance', 'ICICI Lombard General Insurance', 'ACKO General Insurance'];

function ensureInsurers() {
  upsert('insurers', {
    id: SANDBOX_INSURER_ID, name: 'VHC Sandbox Insurer (Synthetic)', legalName: 'VHC Sandbox Insurer — synthetic test entity, not a real company',
    sandbox: true, status: 'Active', publishable: true, type: 'Health (sandbox)',
    irdai: { registrationNo: 'SANDBOX-0000', verified: false, note: 'Synthetic test entity: no IRDAI registration' },
    contacts: [{ name: 'Neha Sharma', role: 'Partner admin (demo)', email: 'insurance_neha@vhc.test' }],
    agreement: { reference: 'SBX-AGR-001', signedAt: '2026-01-01', validFrom: '2026-01-01', validTo: '2027-12-31', commissionBp: 1500, premiumCollection: 'Collected by VHC test gateway; no real settlement', remuneration: 'Synthetic 15% for ledger testing only' },
    authorizedPlanIds: ['pln_health_individual', 'pln_health_floater', 'pln_health_senior', 'pln_life_term'],
    geographies: ['All India (sandbox)'],
    integration: { adapter: 'mock-sandbox', protocol: 'in-process', status: 'Certified', credentialsRef: 'none (sandbox)' },
    regulatoryApproval: { liveSalesApproved: false, note: 'Sandbox only — no live sales' },
    escalation: [{ level: 1, contact: 'insurance_neha@vhc.test' }],
    onboardingHistory: [{ at: now().toISOString(), status: 'Active', by: 'System', note: 'Sandbox insurer for QA and staging' }],
  });
  CANDIDATES.forEach((name, i) => {
    upsert('insurers', {
      id: `ins_candidate_${i + 1}`, name, legalName: name, sandbox: false, status: 'Prospect', publishable: false, type: 'Health / General',
      irdai: { registrationNo: '', verified: false, note: 'To be sourced from the official IRDAI registry during due diligence' },
      contacts: [], agreement: null, authorizedPlanIds: [], geographies: [],
      integration: { adapter: null, protocol: null, status: 'Not started', credentialsRef: null },
      regulatoryApproval: { liveSalesApproved: false },
      candidateNote: 'Candidate for partnership exploration only. No commercial relationship exists; do not display publicly.',
      onboardingHistory: [{ at: now().toISOString(), status: 'Prospect', by: 'System', note: 'Added from the target list in the product requirements' }],
    });
  });
}

function backfillPlans() {
  const uins = { pln_health_individual: 'SBX-HLT-IND-001', pln_health_floater: 'SBX-HLT-FAM-001', pln_health_senior: 'SBX-HLT-SNR-001', pln_life_term: 'SBX-LIF-TRM-001' };
  for (const p of db.all('plans')) {
    if (p.insurerId === undefined) p.insurerId = SANDBOX_INSURER_ID;
    if (p.insurerName === undefined) p.insurerName = db.get('insurers', p.insurerId)?.name || null;
    if (p.uin === undefined) p.uin = uins[p.id] || `SBX-${p.code}`;
    if (p.sandbox === undefined) p.sandbox = db.get('insurers', p.insurerId)?.sandbox !== false;
  }
  for (const pol of db.all('policies')) {
    if (pol.insurerId == null) {
      const plan = db.get('plans', pol.planId);
      Object.assign(pol, { insurerId: plan?.insurerId || null, insurerName: plan?.insurerName || null, productUin: plan?.uin || null, sandbox: plan?.sandbox !== false });
    }
  }
}

// ---------- partner organisations (synthetic) ----------
function ensureOrgs() {
  upsert('tpas', {
    id: 'tpa_sandbox', name: 'Sandbox TPA Services (Synthetic)', legalName: 'Sandbox TPA Services — synthetic test entity', sandbox: true,
    status: 'Active', irdai: { registrationNo: 'SANDBOX-TPA-0', verified: false }, insurerIds: [SANDBOX_INSURER_ID],
    contacts: [{ name: 'Kiran Joshi', email: 'tpa_kiran@vhc.test' }],
  });
  upsert('employers', {
    id: 'emp_demo', name: 'Northwind Demo Technologies Pvt Ltd', legalName: 'Northwind Demo Technologies Private Limited (synthetic)', sandbox: true,
    status: 'Active', industry: 'IT services', gstin: '33AAAAA0000A1Z5', hrContact: { name: 'Sana Qureshi', email: 'corporate_sana@vhc.test' },
    locations: ['Chennai', 'Hyderabad'], employeeCount: 0,
  });
  // Hospital hsp_1 is the demo hospital partner organisation (users attach to the hospital record).
}

// ---------- demo QA accounts (never created in production unless explicitly enabled) ----------
const DEMO_USERS = [
  // id, username, first, last, role, orgId
  ['usr_superadmin', 'vhc_superadmin', 'Super', 'Admin', 'admin', null],
  ['usr_arjun', 'customer_arjun', 'Arjun', 'Kapoor', 'customer', null],
  ['usr_meera', 'family_meera', 'Meera', 'Reddy', 'customer', null],
  ['usr_neha', 'insurance_neha', 'Neha', 'Sharma', 'insurer_admin', SANDBOX_INSURER_ID],
  ['usr_rahul_h', 'hospital_rahul', 'Rahul', 'Menon', 'hospital_admin', 'hsp_1'],
  ['usr_kiran_t', 'tpa_kiran', 'Kiran', 'Joshi', 'tpa_agent', 'tpa_sandbox'],
  ['usr_sana', 'corporate_sana', 'Sana', 'Qureshi', 'corporate_hr', 'emp_demo'],
  ['usr_priya', 'claims_priya', 'Priya', 'Nair', 'claims_officer', null],
  ['usr_vikram_f', 'finance_vikram', 'Vikram', 'Bose', 'finance_manager', null],
  ['usr_ishaan', 'support_ishaan', 'Ishaan', 'Gupta', 'support_agent', null],
  ['usr_ananya', 'compliance_ananya', 'Ananya', 'Krishnan', 'compliance_officer', null],
  ['usr_dev_audit', 'auditor_dev', 'Dev', 'Malhotra', 'auditor', null],
  ['usr_ops', 'ops_farah', 'Farah', 'Siddiqui', 'operations_admin', null],
  ['usr_sales', 'sales_rohan', 'Rohan', 'Batra', 'sales_manager', null],
];
export const DEMO_USERNAMES = DEMO_USERS.map((u) => u[1]);

let cachedHash = null;
function ensureDemoUsers() {
  if (!DEMO_ACCOUNTS_ENABLED()) return [];
  const created = [];
  for (const [id, username, firstName, lastName, role, orgId] of DEMO_USERS) {
    if (db.get('users', id) || db.findOne('users', (u) => u.username === username)) continue;
    cachedHash ||= bcrypt.hashSync(DEMO_PASSWORD, 10);
    const email = `${username}@vhc.test`;
    const name = `${firstName} ${lastName}`;
    const mobile = `+9190000${String(10 + created.length + DEMO_USERS.findIndex((u) => u[0] === id)).padStart(5, '0')}`;
    db.insert('users', {
      id, username, firstName, lastName, name, legalName: name, email, emailLower: email, emailVerified: true, mobile, mobileVerified: true,
      role, status: 'Active', active: true, passwordHash: cachedHash, passwordChangedAt: now().toISOString(), profile: {},
      communicationPreference: 'email', marketingOptIn: false, profileVersion: 1, qaFixture: true,
      ...(orgId ? { orgId } : {}), ...(role === 'customer' ? { customerId: newCustomerId() } : {}),
    });
    if (role === 'customer') db.insert('consents', { userId: id, type: 'terms_privacy', termsVersion: TERMS_VERSION, privacyVersion: TERMS_VERSION, granted: true, at: now().toISOString() });
    created.push(id);
  }
  const arjun = db.get('users', 'usr_arjun');
  if (arjun && !arjun.profile?.dob) arjun.profile = { dob: '1992-06-18', gender: 'male', address: { line1: '21 Banjara Hills Road 3', line2: '', city: 'Hyderabad', state: 'Telangana', postalCode: '500034', country: 'India' } };
  const meera = db.get('users', 'usr_meera');
  if (meera && !meera.profile?.dob) meera.profile = { dob: '1984-02-09', gender: 'female', address: { line1: '5 Jubilee Enclave', line2: '', city: 'Hyderabad', state: 'Telangana', postalCode: '500033', country: 'India' } };
  return created;
}

const AREA_STEPS = [
  ['partners', ensurePartnerData],
  ['network', ensureNetworkData],
  ['claimsOps', ensureClaimsOpsData],
  ['corporate', ensureCorporateData],
  ['enterprise', ensureEnterpriseData],
];

/** Runs every idempotent step. `fresh` is true right after resetAndSeed (areas may add richer demo data). */
export function ensureReferenceData({ fresh = false } = {}) {
  ensureInsurers();
  backfillPlans();
  ensureOrgs();
  const createdUsers = ensureDemoUsers();
  meta().mockInsurer ||= { issuanceMode: 'auto' };
  const ctx = { fresh, createdUsers, demo: DEMO_ACCOUNTS_ENABLED() };
  for (const [, step] of AREA_STEPS) step(ctx);
  meta().referenceDataAt ||= now().toISOString(); // first run only, so repeat runs change nothing
  return ctx;
}

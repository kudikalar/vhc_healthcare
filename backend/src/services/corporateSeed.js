// Idempotent reference/demo data for the corporate module. Called by ensureReferenceData() after a fresh
// seed (ctx.fresh === true) and at start-up on existing databases (ctx.fresh === false).
// Upserts by fixed ids and only fills missing fields; never deletes or overwrites existing records.
//
// Everything here is SYNTHETIC: Northwind Demo Technologies (emp_demo), its employees, the sandbox group
// policy and its invoice are test data for QA and demos, created only when demo data is enabled.
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { addDays, addYears } from '../utils/dates.js';
import { pct, sum } from '../utils/money.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { FAMILY_DEFINITIONS, GROUP_PRODUCTS, lifePremium, proRata } from './corporateProduct.js';

const upsert = (col, rec) => {
  const existing = db.get(col, rec.id);
  if (!existing) return db.insert(col, rec);
  for (const [k, v] of Object.entries(rec)) if (existing[k] === undefined) existing[k] = v;
  return existing;
};
const fill = (rec, patch) => { for (const [k, v] of Object.entries(patch)) if (rec[k] === undefined || rec[k] === null) rec[k] = v; };

// employeeId, name, email, dob, gender, grade, joiningDate offset (days from policy start), enrolled?
const EMPLOYEES = [
  ['NW-1001', 'Aditi Rao', 'aditi.rao@northwind-demo.test', '1988-03-14', 'female', 'M2', -900, true],
  ['NW-1002', 'Vivek Iyer', 'vivek.iyer@northwind-demo.test', '1985-11-02', 'male', 'M3', -1500, true],
  ['NW-1003', 'Farhan Sheikh', 'farhan.sheikh@northwind-demo.test', '1991-07-21', 'male', 'E2', -700, true],
  ['NW-1004', 'Lakshmi Pillai', 'lakshmi.pillai@northwind-demo.test', '1979-01-30', 'female', 'M4', -2600, true],
  ['NW-1005', 'Rohit Deshmukh', 'rohit.deshmukh@northwind-demo.test', '1994-09-09', 'male', 'E1', -400, true],
  ['NW-1006', 'Sneha Banerjee', 'sneha.banerjee@northwind-demo.test', '1996-05-17', 'female', 'E1', -300, true],
  ['NW-1007', 'Karthik Subramanian', 'karthik.s@northwind-demo.test', '1983-12-05', 'male', 'M3', -1900, true],
  ['NW-1008', 'Nisha Fernandes', 'nisha.fernandes@northwind-demo.test', '1990-02-11', 'female', 'E3', -800, true],
  ['NW-1009', 'Imran Qadri', 'imran.qadri@northwind-demo.test', '1987-08-28', 'male', 'M2', -1100, true],
  ['NW-1010', 'Pooja Menon', 'pooja.menon@northwind-demo.test', '1993-04-03', 'female', 'E2', -500, true],
  ['NW-1011', 'Arjun Kapoor', 'customer_arjun@vhc.test', '1992-06-18', 'male', 'E2', -600, false],
  ['NW-1012', 'Tanvi Joshi', 'tanvi.joshi@northwind-demo.test', '1998-10-22', 'female', 'E1', null, false], // recent joiner
];
// memberIndex, id, name, relationship, dob, gender
const DEPENDENTS = [
  [0, 'gd_demo_01', 'Sameer Rao', 'spouse', '1986-06-01', 'male'],
  [0, 'gd_demo_02', 'Ira Rao', 'child', '2017-09-12', 'female'],
  [1, 'gd_demo_03', 'Meenakshi Iyer', 'spouse', '1987-02-19', 'female'],
  [3, 'gd_demo_04', 'Ravi Pillai', 'spouse', '1977-10-08', 'male'],
  [3, 'gd_demo_05', 'Anand Pillai', 'child', '2008-03-25', 'male'],
  [6, 'gd_demo_06', 'Divya Subramanian', 'spouse', '1985-04-14', 'female'],
];

let hash = null;
function ensureCorporateAdmin() {
  if (db.get('users', 'usr_corp_admin') || db.findOne('users', (u) => u.username === 'corporate_kabir')) return;
  hash ||= bcrypt.hashSync('VisionDemo#2026', 10);
  const email = 'corporate_kabir@vhc.test';
  db.insert('users', {
    id: 'usr_corp_admin', username: 'corporate_kabir', firstName: 'Kabir', lastName: 'Sethi', name: 'Kabir Sethi', legalName: 'Kabir Sethi', email, emailLower: email,
    emailVerified: true, mobile: '+919000099001', mobileVerified: true, role: 'corporate_admin', status: 'Active', active: true, passwordHash: hash,
    passwordChangedAt: now().toISOString(), profile: {}, communicationPreference: 'email', marketingOptIn: false, profileVersion: 1, qaFixture: true, orgId: 'emp_demo',
  });
}

export function ensureCorporateData(ctx) {
  if (!ctx.demo) return;
  const emp = db.get('employers', 'emp_demo');
  if (!emp) return;
  const t = today();
  fill(emp, {
    legalName: 'Northwind Demo Technologies Private Limited (synthetic)', entityType: 'Private Limited', cin: 'U72200TN2020PTC000001',
    billing: { contactName: 'Accounts Payable (demo)', email: 'ap@northwind-demo.test', address: '4th Floor, Demo Tech Park, OMR', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600097', poNumber: 'PO-DEMO-2026' },
    employeeCount: 120, insuranceRequirements: 'Group medical for all full-time and contract staff; spouse and up to two children; cashless at network hospitals.',
    existingArrangement: { hasExisting: false, provider: '', renewalDate: '', notes: 'First group cover (synthetic scenario).' },
    desiredCoverage: { sumInsured: 5 * 100000 * 100, familyDefinition: 'ESC', notes: 'Wellness camps once a year.' },
    contractValidity: { from: '2026-01-01', to: '2027-12-31' }, billingArrangement: 'employer_paid', billingFrequency: 'annual',
    accountOwnerId: db.get('users', 'usr_sales') ? 'usr_sales' : null,
    statusHistory: [{ at: now().toISOString(), status: 'Active', by: 'System', role: 'system', note: 'Synthetic demo employer' }],
  });
  if (emp.hrContact && !emp.hrContact.phone) emp.hrContact.phone = '';
  ensureCorporateAdmin();

  upsert('corporateContracts', {
    id: 'cc_demo', contractNumber: 'CC-DEMO-0001', employerId: emp.id, startDate: '2026-01-01', endDate: '2027-12-31', services: ['group_health', 'wellness', 'benefits_administration'],
    serviceFeePerMemberMonth: 2500, paymentTermsDays: 30, billingArrangement: 'employer_paid', status: 'Active', signedAt: now().toISOString(), signedBy: 'System (demo)', notes: 'Synthetic demo contract', sandbox: true,
  });

  if (db.get('groupPolicies', 'gp_demo')) return; // demo book already created on an earlier run
  const product = GROUP_PRODUCTS[0];
  const sumInsured = 5 * 100000 * 100;
  const startDate = addDays(t, -60);
  const endDate = addDays(addYears(startDate, 1), -1);
  const terms = {
    productId: product.id, sumInsured, familyDefinition: 'ESC', familyLabel: FAMILY_DEFINITIONS.ESC.label, ageBands: product.ageBands,
    sumInsuredMultiplierBp: product.sumInsuredMultiplierBp[sumInsured], gstBp: 1800, waivers: product.waivers, premiumBasis: product.premiumBasis,
  };
  const policy = upsert('groupPolicies', {
    id: 'gp_demo', policyNumber: 'GP-SBX-DEMO01', employerId: emp.id, employerName: emp.name, contractId: 'cc_demo', quoteId: null, productId: product.id, productName: product.name,
    insurerId: SANDBOX_INSURER_ID, insurerName: product.insurerName, sandbox: true, label: 'SANDBOX — synthetic data for testing. Not a real insurance contract.',
    startDate, endDate, status: 'Active', insurerReference: 'SBX-GMP-DEMO01', confirmedAt: now().toISOString(), terms,
    eligibility: { employmentTypes: ['full_time', 'contract'], minServiceDays: 0, grades: [] },
    dependentRules: { spouse: true, children: true, parents: false, maxSpouses: 1, maxChildren: 2, childMaxAge: 25, maxParents: 2, parentMaxAge: 80 },
    enrolmentWindow: { opensOn: addDays(startDate, -15), closesOn: addDays(t, 30) }, renewalOf: null, renewedBy: null, contacts: product.contacts, createdBy: 'System (demo)', confirmationId: 'icf_demo_policy',
  });
  upsert('insurerConfirmations', { id: 'icf_demo_policy', reference: 'ICF-DEMO-001', kind: 'group_policy', refId: policy.id, refNumber: policy.policyNumber, employerId: emp.id, groupPolicyId: policy.id, insurerId: SANDBOX_INSURER_ID, status: 'confirmed', attempt: 1, mode: 'auto', requestedAt: now().toISOString(), requestedBy: 'System (demo)', decidedAt: now().toISOString(), decidedBy: 'VHC Sandbox Insurer (Synthetic)', insurerReference: 'SBX-GMP-DEMO01' });

  const members = EMPLOYEES.map(([employeeId, name, email, dob, gender, grade, joinOffset], i) => {
    const joiningDate = joinOffset == null ? addDays(t, -10) : addDays(startDate, joinOffset);
    const isArjun = email === 'customer_arjun@vhc.test' && db.get('users', 'usr_arjun')?.emailVerified;
    return upsert('groupMembers', {
      id: `gm_demo_${String(i + 1).padStart(2, '0')}`, employerId: emp.id, employeeId, name, email, emailLower: email.toLowerCase(), dob, gender, grade, joiningDate,
      employmentType: i === 9 ? 'contract' : 'full_time', location: i % 2 ? 'Hyderabad' : 'Chennai', status: 'Active', leavingDate: null,
      userId: isArjun ? 'usr_arjun' : null, linkedAt: isArjun ? now().toISOString() : null, inviteSentAt: null, source: 'seed',
      history: [{ at: now().toISOString(), event: 'joined', by: 'System (demo)', note: `Synthetic employee; joining date ${joiningDate}` }],
    });
  });
  for (const [mi, id, name, relationship, dob, gender] of DEPENDENTS) {
    upsert('groupDependents', { id, employerId: emp.id, memberId: members[mi].id, name, relationship, dob, gender, status: 'Active', addedBy: 'System (demo)', addedByRole: 'system', coverStatus: 'Covered' });
  }

  const enrolled = [];
  EMPLOYEES.forEach((row, i) => {
    if (!row[7]) return;
    const m = members[i];
    const self = lifePremium(terms, m.dob, startDate);
    const lives = [{ lifeId: 'self', dependentId: null, name: m.name, relationship: 'self', dob: m.dob, gender: m.gender, age: self.age, band: self.band, annualPremium: self.annualPremium, coverFrom: startDate, coverTo: endDate, status: 'Covered' }];
    for (const d of DEPENDENTS.filter((x) => x[0] === i)) {
      const lp = lifePremium(terms, d[4], startDate);
      lives.push({ lifeId: d[1], dependentId: d[1], name: d[2], relationship: d[3], dob: d[4], gender: d[5], age: lp.age, band: lp.band, annualPremium: lp.annualPremium, coverFrom: startDate, coverTo: endDate, status: 'Covered' });
    }
    const n = String(i + 1).padStart(2, '0');
    const premium = sum(lives, (l) => l.annualPremium);
    enrolled.push(upsert('groupEnrolments', {
      id: `ge_demo_${n}`, enrolmentNumber: `GE-DEMO-${n}`, groupPolicyId: policy.id, employerId: emp.id, memberId: m.id, status: 'Enrolled', coverFrom: startDate, coverTo: endDate,
      lives, excludedLives: [], annualPremium: premium, billablePremium: premium, basePremium: true, submittedAt: now().toISOString(), submittedBy: 'System (demo)', source: 'seed',
      confirmedAt: now().toISOString(), insurerMemberRef: `SBX-MEM-DEMO${n}`, certificateNumber: `COI-DEMO-${String(i + 1).padStart(5, '0')}`, endorsementId: null, invoiceId: 'inv_demo_01',
      history: [{ at: now().toISOString(), status: 'Enrolled', by: 'System (demo)', note: 'Synthetic demo enrolment confirmed by the sandbox insurer' }],
    }));
  });

  // A pending endorsement: newborn child added to NW-1003 mid-term, awaiting the insurer.
  const parent = members[2];
  const e3 = enrolled.find((e) => e.memberId === parent.id);
  const effective = addDays(t, -5);
  const babyDob = addDays(t, -12);
  upsert('groupDependents', { id: 'gd_demo_07', employerId: emp.id, memberId: parent.id, name: 'Zoya Sheikh', relationship: 'child', dob: babyDob, gender: 'female', status: 'Active', addedBy: 'Sana Qureshi', addedByRole: 'corporate_hr', coverStatus: 'Pending insurer endorsement' });
  const lp = lifePremium(terms, babyDob, effective);
  const life = { lifeId: 'gd_demo_07', dependentId: 'gd_demo_07', name: 'Zoya Sheikh', relationship: 'child', dob: babyDob, gender: 'female', age: lp.age, band: lp.band, annualPremium: lp.annualPremium, coverFrom: effective, coverTo: endDate };
  const pr = proRata(lp.annualPremium, policy, effective, 'addition');
  const gst = pct(pr.amount, 1800);
  upsert('endorsements', {
    id: 'end_demo_01', endorsementNumber: 'END-DEMO-001', groupPolicyId: policy.id, policyNumber: policy.policyNumber, employerId: emp.id, memberId: parent.id, dependentId: 'gd_demo_07', enrolmentId: e3.id,
    type: 'addition', reason: 'dependent_added', effectiveDate: effective, lives: [{ lifeId: life.lifeId, relationship: 'child', band: life.band, annualPremium: life.annualPremium }], pendingLives: [life],
    annualPremium: lp.annualPremium, days: pr.days, policyDays: pr.policyDays, proRataPremium: pr.amount, gstBp: 1800, gst, total: pr.amount + gst, direction: 'debit', status: 'Pending Insurer',
    confirmedVia: 'endorsement', invoiceId: null, assumption: 'Daily pro-rata on the annual per-life premium (sandbox assumption — the insurer\'s endorsement rules override this in production).', createdBy: 'Sana Qureshi', confirmationId: 'icf_demo_end01',
  });
  upsert('insurerConfirmations', { id: 'icf_demo_end01', reference: 'ICF-DEMO-002', kind: 'endorsement', refId: 'end_demo_01', refNumber: 'END-DEMO-001', employerId: emp.id, groupPolicyId: policy.id, insurerId: SANDBOX_INSURER_ID, status: 'pending', attempt: 1, mode: 'manual', requestedAt: now().toISOString(), requestedBy: 'Sana Qureshi' });

  // The base premium invoice per the sandbox insurer statement (unpaid).
  const allLives = enrolled.flatMap((e) => e.lives);
  const bands = new Map();
  for (const l of allLives) {
    const k = `${l.band}|${l.annualPremium}`;
    const cur = bands.get(k) || { band: l.band, perLife: l.annualPremium, lives: 0 };
    cur.lives += 1;
    bands.set(k, cur);
  }
  const net = sum(enrolled, (e) => e.billablePremium);
  const igst = pct(net, 1800);
  upsert('corporateInvoices', {
    id: 'inv_demo_01', invoiceNumber: 'INV-CORP-DEMO-000001', employerId: emp.id, employerName: emp.name, gstin: emp.gstin, billing: emp.billing, issueDate: addDays(t, -45), dueDate: addDays(t, -15),
    status: 'Issued', payment: null, ledgerPostedAt: null, sandbox: true, label: 'SANDBOX — synthetic data for testing. Not a real insurance contract.', createdBy: 'System (demo)', typeLabel: 'Group premium invoice',
    groupPolicyId: policy.id, policyNumber: policy.policyNumber, insurerId: SANDBOX_INSURER_ID, insurerName: policy.insurerName, insurerStatementRef: 'SBX-STMT-DEMO01-001',
    type: 'premium', direction: 'debit', period: `${startDate} to ${endDate}`,
    lines: [...[...bands.values()].sort((a, b) => a.band.localeCompare(b.band)).map((x) => ({ kind: 'premium', description: `Annual premium, age band ${x.band} — ${x.lives} li${x.lives === 1 ? 'fe' : 'ves'} × ${x.perLife / 100}`, amount: x.lives * x.perLife })), { kind: 'gst', description: 'GST @ 18% on premium (collected for the insurer)', amount: igst }],
    netAmount: net, gst: igst, total: net + igst, enrolmentIds: enrolled.map((e) => e.id), lives: allLives.length, correlationId: 'cor_demo_inv01',
  });

  upsert('wellnessProgrammes', {
    id: 'wp_demo_01', employerId: emp.id, contractId: 'cc_demo', type: 'annual_checkup_camp', typeLabel: 'Annual check-up camp', name: 'Annual health check-up camp 2026',
    description: 'Basic screening (BP, sugar, BMI, eye check) at the Chennai and Hyderabad offices. Voluntary; separate from your group insurance.',
    provider: 'Sandbox Wellness Partner (Synthetic)', location: 'Chennai & Hyderabad offices', startDate: addDays(t, 14), endDate: addDays(t, 16), capacity: 80, feePerParticipant: 45000,
    status: 'Open', separateFromInsurance: true, sandbox: true, createdBy: 'System (demo)',
  });

  if (!ctx.fresh) return;
  // Richer demo data on a fresh seed: wellness opt-ins, claims MIS feed (aggregate ≥ 5), support, a prospect.
  upsert('wellnessProgrammes', {
    id: 'wp_demo_02', employerId: emp.id, contractId: 'cc_demo', type: 'eap', typeLabel: 'Employee assistance programme (EAP)', name: 'Confidential counselling (EAP)',
    description: 'Free, confidential counselling sessions by phone or video. Your employer never sees who uses it.', provider: 'Sandbox Wellness Partner (Synthetic)', location: 'Online',
    startDate: addDays(t, -30), endDate: addDays(t, 335), capacity: null, feePerParticipant: 0, status: 'Open', separateFromInsurance: true, sandbox: true, createdBy: 'System (demo)',
  });
  members.slice(0, 6).forEach((m, i) => upsert('wellnessEnrolments', { id: `we_demo_${i + 1}`, programmeId: 'wp_demo_01', employerId: emp.id, memberId: m.id, userId: m.userId, status: 'Opted in', consent: { given: true, at: now().toISOString(), text: 'Synthetic demo consent' } }));
  const claimRows = [[0, 'self', 'Settled', 4200000, 3800000], [1, 'self', 'Settled', 1850000, 1850000], [3, 'gd_demo_04', 'Under Review', 7600000, 0], [4, 'self', 'Settled', 960000, 900000], [6, 'self', 'Rejected', 1200000, 0], [8, 'self', 'Intimated', 2500000, 0]];
  claimRows.forEach(([mi, lifeId, status, claimedAmount, settledAmount], i) => upsert('groupClaims', {
    id: `gcl_demo_${i + 1}`, claimRef: `GCL-SBX-DEMO${i + 1}`, groupPolicyId: policy.id, employerId: emp.id, memberId: members[mi].id, lifeId, relationship: lifeId === 'self' ? 'self' : 'spouse',
    claimedAmount, settledAmount, status, admissionDate: addDays(t, -40 + i * 5), diagnosis: 'Synthetic — not shown to employers', source: 'Sandbox insurer claims MIS (simulated)', sandbox: true,
  }));
  upsert('corporateSupportRequests', { id: 'csr_demo_01', reference: 'CSR-DEMO-001', employerId: emp.id, memberId: null, source: 'employer', raisedById: 'usr_sana', raisedByName: 'Sana Qureshi', category: 'billing', subject: 'Invoice copy for finance', message: 'Please share the PDF of the premium invoice for our AP team.', status: 'Open', responses: [] });
  upsert('corporateSupportRequests', { id: 'csr_demo_02', reference: 'CSR-DEMO-002', employerId: emp.id, memberId: members[4].id, source: 'employee', raisedById: null, raisedByName: 'Employee', category: 'certificate', subject: 'Certificate name spelling', message: 'Synthetic employee request.', status: 'Resolved', responses: [] });
  upsert('employers', {
    id: 'emp_demo_prospect', name: 'Lakeside Demo Logistics LLP', legalName: 'Lakeside Demo Logistics LLP (synthetic)', sandbox: true, status: 'Proposal', entityType: 'LLP', llpin: 'AAA-0001', gstin: '',
    industry: 'Logistics', hrContact: { name: 'HR desk (demo)', email: 'hr@lakeside-demo.test', phone: '' }, employeeCount: 45, locations: ['Pune'], billingArrangement: 'cost_shared', billingFrequency: 'quarterly',
    insuranceRequirements: 'Employee + spouse cover; considering wellness camps.', accountOwnerId: db.get('users', 'usr_sales') ? 'usr_sales' : null,
    statusHistory: [{ at: now().toISOString(), status: 'Prospect', by: 'System', role: 'system', note: 'Synthetic prospect' }, { at: now().toISOString(), from: 'Prospect', status: 'Proposal', by: 'Rohan Batra', role: 'sales_manager', note: 'Proposal shared (synthetic)' }],
  });
}

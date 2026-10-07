// Fictional, repeatable seed data. All people, hospitals and products are invented.
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import { db, emptyState, persist, replaceState, STORAGE_DIR } from '../db.js';
import { now, today } from '../clock.js';
import { addDays, addMonths, addYears } from '../utils/dates.js';
import { computeHealthQuote, computeLifeQuote, hashInputs, healthQuoteInputs, lifeQuoteInputs } from './pricing.js';
import { APP_STATUS, issuePolicy } from './lifecycle.js';
import { createApplication } from '../routes/applications.js';
import { newCustomerId, TERMS_VERSION } from './profile.js';
import { resetIpThrottle } from './security.js';

export const SEED_PASSWORD = 'VisionDemo#2026';
const L = 100; // paise per rupee
const LAKH = 100000 * L;

const healthBase = {
  eligibleRelationships: ['self', 'spouse', 'child', 'parent'],
  relationshipLimits: { self: 1, spouse: 1, child: 4, parent: 2 },
  genderRequired: false,
  ageBands: [
    { minAge: 0, maxAge: 17, premium: 2000 * L },
    { minAge: 18, maxAge: 35, premium: 4000 * L },
    { minAge: 36, maxAge: 50, premium: 6000 * L },
    { minAge: 51, maxAge: 65, premium: 9000 * L },
  ],
  coverageOptions: [
    { amount: 5 * LAKH, label: 'Rs. 5 lakh', multiplierBp: 10000 },
    { amount: 10 * LAKH, label: 'Rs. 10 lakh', multiplierBp: 18000 },
  ],
  optionalBenefits: [
    { code: 'OPD', name: 'OPD cover', charge: 1500 * L },
    { code: 'MATERNITY', name: 'Maternity cover', charge: 3000 * L },
    { code: 'CRITICAL', name: 'Critical illness add-on', charge: 2500 * L },
  ],
  durationMonths: 12,
  initialWaitingDays: 30,
  conditionWaitingPeriods: [
    { condition: 'diabetes', days: 730 }, { condition: 'hypertension', days: 730 },
    { condition: 'cataract', days: 730 }, { condition: 'hernia', days: 730 },
  ],
  deductiblePerClaim: 5000 * L,
  copayBp: 1000,
  roomRentLimitPerDay: 5000 * L,
  benefits: ['In-patient hospitalisation', 'Pre-hospitalisation (30 days)', 'Post-hospitalisation (60 days)', 'Day-care procedures', 'Road ambulance up to Rs. 2,000'],
  exclusions: [
    { label: 'Cosmetic or aesthetic treatment', keywords: ['cosmetic', 'aesthetic'] },
    { label: 'Dental treatment (non-accidental)', keywords: ['dental'] },
    { label: 'Infertility treatment', keywords: ['infertility', 'ivf'] },
    { label: 'Self-inflicted injury', keywords: ['self-inflicted'] },
  ],
  medicalTestAge: 46,
  renewalWindowDays: 60,
  renewalGraceDays: 30,
  requiredDocuments: ['Identity proof for each insured member', 'Medical reports for any declared condition'],
};

function lifeRates() {
  const bands = [[18, 30, 120], [31, 40, 180], [41, 50, 300], [51, 60, 520]];
  const rows = [];
  for (const [minAge, maxAge, base] of bands)
    for (const tobacco of [false, true])
      for (const [minTerm, maxTerm, tf] of [[5, 20, 1], [21, 40, 1.15]])
        for (const [uwClass, cf] of [['standard', 1], ['substandard', 1.5]])
          rows.push({ minAge, maxAge, tobacco, minTerm, maxTerm, uwClass, ratePer1000: Math.round(base * (tobacco ? 1.8 : 1) * tf * cf) });
  return rows;
}

export const PLANS = [
  {
    id: 'pln_health_individual', code: 'VHC-IND', name: 'Vision Individual Care', product: 'health', type: 'individual',
    description: 'Separate coverage for one insured person.',
    config: { ...healthBase, minEntryAge: 0, maxEntryAge: 65, maxMembers: 1, floaterDiscountBp: 0 },
  },
  {
    id: 'pln_health_floater', code: 'VHC-FAM', name: 'Vision Family Floater', product: 'health', type: 'floater',
    description: 'One shared sum insured for self, spouse, children and parents.',
    config: { ...healthBase, minEntryAge: 0, maxEntryAge: 65, maxMembers: 6, floaterDiscountBp: 1000 },
  },
  {
    id: 'pln_health_senior', code: 'VHC-SNR', name: 'Vision Senior Shield', product: 'health', type: 'senior',
    description: 'For applicants aged 60–80, with a separate premium table and 20% co-payment.',
    config: {
      ...healthBase, minEntryAge: 60, maxEntryAge: 80, maxMembers: 2, eligibleRelationships: ['self', 'spouse'],
      ageBands: [{ minAge: 60, maxAge: 70, premium: 15000 * L }, { minAge: 71, maxAge: 80, premium: 22000 * L }],
      copayBp: 2000, floaterDiscountBp: 0, medicalTestAge: 60,
    },
  },
  {
    id: 'pln_life_term', code: 'VHC-TERM', name: 'Vision Term Shield', product: 'life', type: 'term',
    description: 'Pure term life cover: death benefit during the policy term. No maturity benefit.',
    config: {
      minEntryAge: 18, maxEntryAge: 60, maxMaturityAge: 75,
      minSumAssured: 25 * LAKH, maxSumAssured: 500 * LAKH,
      policyTerms: [10, 15, 20, 25, 30], premiumPaymentTerms: [5, 10],
      frequencies: {
        annual: { factorBp: 10000, perYear: 1, graceDays: 30 },
        monthly: { factorBp: 880, perYear: 12, graceDays: 15 },
      },
      riders: [
        { code: 'ADB', name: 'Accidental Death Benefit', annualCharge: 1000 * L, benefitPctOfSA: 10000 },
        { code: 'WOP', name: 'Waiver of Premium on disability', annualCharge: 1500 * L },
      ],
      rateTable: lifeRates(),
      medicalRules: { ageAbove: 45, sumAssuredAbove: 100 * LAKH },
      financialRules: { maxIncomeMultiple: 20 },
      reinstatementWindowDays: 730,
      maturityBenefit: null,
      exclusions: ['Suicide within 12 months of the risk commencement date', 'Death due to participation in criminal acts'],
      requiredDocuments: ['Identity proof', 'Income proof', 'Medical reports where requested'],
    },
  },
];

const HOSPITALS = [
  ['Sunrise Multispeciality Hospital', '12 Lake View Road', 'Chennai', 'Tamil Nadu', '600017', ['Cardiology', 'Orthopaedics', 'General Surgery'], true],
  ['Green Valley Medical Centre', '45 MG Road', 'Bengaluru', 'Karnataka', '560001', ['Oncology', 'Neurology', 'Paediatrics'], true],
  ['Harbour Care Hospital', '8 Marine Drive', 'Mumbai', 'Maharashtra', '400020', ['Cardiology', 'Nephrology', 'Maternity'], true],
  ['Lotus Women & Child Hospital', '22 Park Street', 'Kolkata', 'West Bengal', '700016', ['Maternity', 'Paediatrics', 'Gynaecology'], true],
  ['Riverbank General Hospital', '3 Ring Road', 'New Delhi', 'Delhi', '110001', ['General Medicine', 'ENT', 'Orthopaedics'], false],
  ['Hilltop Eye & ENT Clinic', '19 Station Road', 'Pune', 'Maharashtra', '411001', ['Ophthalmology', 'ENT'], true],
  ['Coastal City Hospital', '77 Beach Road', 'Chennai', 'Tamil Nadu', '600041', ['General Medicine', 'Diabetology'], false],
  ['Meadow Heart Institute', '5 Jubilee Hills', 'Hyderabad', 'Telangana', '500033', ['Cardiology', 'Cardiothoracic Surgery'], true],
];

const USERS = [
  ['usr_admin', 'Aditi', 'Rao', 'admin@vhc.test', 'admin', '+919000000001'],
  ['usr_agent', 'Arjun', 'Nair', 'agent@vhc.test', 'agent', '+919000000002'],
  ['usr_uw', 'Uma', 'Iyer', 'underwriter@vhc.test', 'underwriter', '+919000000003'],
  ['usr_claims', 'Kiran', 'Das', 'claims@vhc.test', 'claims_officer', '+919000000004'],
  ['usr_claims2', 'Meera', 'Pillai', 'claims2@vhc.test', 'claims_officer', '+919000000005'],
  ['usr_cust1', 'Asha', 'Verma', 'customer@vhc.test', 'customer', '+919876543210'],
  ['usr_cust2', 'Rahul', 'Mehta', 'customer2@vhc.test', 'customer', '+919812345678'],
];

function backdate(policy, start) {
  policy.startDate = start;
  if (policy.product === 'health') {
    policy.endDate = addDays(addMonths(start, policy.termsSnapshot.durationMonths), -1);
    policy.continuityStartDate = start;
  } else {
    policy.endDate = addDays(addYears(start, policy.policyTerm), -1);
    const step = 12 / policy.termsSnapshot.frequencies[policy.frequency].perYear;
    policy.schedule.forEach((i, k) => { i.dueDate = addMonths(start, k * step); });
    policy.schedule[0].paidAt = `${start}T09:00:00.000Z`;
    policy.issuedAt = `${start}T09:00:00.000Z`;
    policy.nomineeVersions[0].effectiveFrom = start;
  }
}

function seedPolicy(userId, plan, fill, start) {
  const app = createApplication(userId, plan, { startDate: today() });
  fill(app);
  const q = plan.product === 'health' ? computeHealthQuote(plan, { ...app.health, startDate: app.startDate }) : computeLifeQuote(plan, lifeQuoteInputs(app));
  app.quote = { ...q, inputHash: hashInputs(plan.product === 'health' ? healthQuoteInputs(app) : lifeQuoteInputs(app)), calculatedAt: now().toISOString(), expiresAt: addDays(today(), 7) };
  app.consent = { given: true, at: now().toISOString() };
  app.submittedAt = now().toISOString();
  const first = plan.product === 'health' ? q.totalAnnualPremium : q.installmentPremium;
  app.offer = plan.product === 'health'
    ? { planVersion: 1, coverage: q.coverage, annualPremium: q.totalAnnualPremium, firstPayment: first, revised: false, original: {}, acceptedAt: now().toISOString() }
    : { planVersion: 1, sumAssured: q.sumAssured, annualPremium: q.annualPremium, installmentPremium: q.installmentPremium, frequency: q.frequency, firstPayment: first, revised: false, original: {}, acceptedAt: now().toISOString() };
  app.status = APP_STATUS.ACCEPTED;
  app.timeline.push({ at: now().toISOString(), status: APP_STATUS.ACCEPTED, by: 'Seed', role: 'system', note: 'Seeded as approved and accepted' });
  const payment = db.insert('payments', {
    reference: `PAY-SEED-${app.applicationNumber.slice(-4)}`, purpose: 'application', targetKey: `app:${app.id}`, applicationId: app.id,
    userId, amount: first, status: 'success', idempotencyKey: `seed:${app.id}`, method: 'simulated-gateway', callbacks: [], description: `First premium for ${app.applicationNumber}`, completedAt: now().toISOString(),
  });
  const policy = issuePolicy(app, payment, { name: 'Seed', role: 'system' });
  backdate(policy, start);
  return policy;
}

export function resetAndSeed() {
  replaceState(emptyState());
  resetIpThrottle();
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  const hash = bcrypt.hashSync(SEED_PASSWORD, 10);
  for (const [id, firstName, lastName, email, role, mobile] of USERS) {
    const name = `${firstName} ${lastName}`;
    db.insert('users', {
      id, firstName, lastName, name, legalName: name, email, emailLower: email, emailVerified: true, mobile, mobileVerified: true,
      role, status: 'Active', active: true, passwordHash: hash, passwordChangedAt: now().toISOString(), profile: {},
      communicationPreference: 'email', marketingOptIn: false, profileVersion: 1,
      ...(role === 'customer' ? { customerId: newCustomerId() } : {}),
    });
    if (role === 'customer') db.insert('consents', { userId: id, type: 'terms_privacy', termsVersion: TERMS_VERSION, privacyVersion: TERMS_VERSION, granted: true, at: now().toISOString() });
  }
  db.get('users', 'usr_cust1').profile = { dob: '1988-04-12', gender: 'female', address: { line1: '14 Palm Grove, Adyar', line2: '', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600017', country: 'India' } };
  db.get('users', 'usr_cust2').profile = { dob: '1979-11-02', gender: 'male', address: { line1: '9 Rose Lane, Koregaon Park', line2: '', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'India' } };

  for (const p of PLANS) {
    db.insert('plans', { id: p.id, code: p.code, name: p.name, product: p.product, type: p.type, description: p.description, active: true, versions: [{ version: 1, config: p.config, createdAt: now().toISOString(), createdBy: 'Seed', changeNote: 'Initial version' }] });
  }
  HOSPITALS.forEach(([name, address, city, state, postalCode, specialties, network], i) => {
    db.insert('hospitals', { id: `hsp_${i + 1}`, name, address, city, state, postalCode, specialties, network, active: true, phone: `044-4000${String(i).padStart(4, '0')}`, email: `contact${i + 1}@hospital.test` });
  });

  const t = today();
  const decl = { hasConditions: false, conditions: '', medications: 'None', surgeries: 'None', tobacco: false };
  const floater = seedPolicy('usr_cust1', db.get('plans', 'pln_health_floater'), (app) => {
    app.health = {
      coverage: 10 * LAKH, optionalBenefits: [],
      members: [
        { id: 'mem_asha', fullName: 'Asha Verma', dob: '1988-04-12', relationship: 'self', gender: 'female', heightCm: 162, weightKg: 58, ...decl },
        { id: 'mem_vikram', fullName: 'Vikram Verma', dob: '1985-09-03', relationship: 'spouse', gender: 'male', heightCm: 175, weightKg: 76, ...decl },
        { id: 'mem_diya', fullName: 'Diya Verma', dob: '2016-01-20', relationship: 'child', gender: 'female', heightCm: 120, weightKg: 24, ...decl },
      ],
    };
  }, addDays(t, -120));

  seedPolicy('usr_cust1', db.get('plans', 'pln_life_term'), (app) => {
    Object.assign(app.life, {
      lifeAssured: { fullName: 'Asha Verma', dob: '1988-04-12', gender: 'female', occupation: 'Architect', annualIncome: 1800000 * L },
      policyholder: { sameAsLifeAssured: true, fullName: 'Asha Verma' },
      sumAssured: 50 * LAKH, policyTerm: 25, premiumPaymentTerm: 25, frequency: 'monthly', riders: ['ADB'], tobacco: false,
      medicalHistory: { hasConditions: false, details: '' }, existingInsurance: { has: false, details: '', totalSumAssured: 0 },
      nominees: [
        { name: 'Vikram Verma', relationship: 'Spouse', dob: '1985-09-03', phone: '9000000001', email: '', shareBp: 6000, sharePct: 60, isMinor: false, guardian: null },
        { name: 'Diya Verma', relationship: 'Daughter', dob: '2016-01-20', phone: '', email: '', shareBp: 4000, sharePct: 40, isMinor: true, guardian: { name: 'Vikram Verma', relationship: 'Father', phone: '9000000001' } },
      ],
    });
  }, addDays(t, -25));

  // Rahul: an application waiting in the underwriting queue.
  const plan = db.get('plans', 'pln_health_individual');
  const app = createApplication('usr_cust2', plan, { startDate: addDays(t, 7) });
  app.health = { coverage: 5 * LAKH, optionalBenefits: ['OPD'], members: [{ id: 'mem_rahul', fullName: 'Rahul Mehta', dob: '1979-11-02', relationship: 'self', gender: 'male', heightCm: 170, weightKg: 92, hasConditions: true, conditions: 'Type 2 diabetes (diagnosed 2021)', medications: 'Metformin 500mg', surgeries: 'None', tobacco: false }] };
  const q = computeHealthQuote(plan, { ...app.health, startDate: app.startDate });
  app.quote = { ...q, inputHash: hashInputs(healthQuoteInputs(app)), calculatedAt: now().toISOString(), expiresAt: addDays(t, 7) };
  app.consent = { given: true, at: now().toISOString() };
  app.submittedAt = now().toISOString();
  app.status = APP_STATUS.UNDERWRITING;
  app.timeline.push({ at: now().toISOString(), from: 'Draft', status: 'Underwriting', by: 'Seed', role: 'system', note: 'Submitted and forwarded to underwriting' });

  // Asha's family roster: two members already covered, plus her mother who has no cover yet.
  for (const [fullName, dob, relationship, gender] of [['Vikram Verma', '1985-09-03', 'spouse', 'male'], ['Diya Verma', '2016-01-20', 'child', 'female'], ['Kamala Iyer', '1962-03-14', 'parent', 'female']]) {
    db.insert('familyMembers', { userId: 'usr_cust1', fullName, dob, relationship, gender, status: 'active', version: 1 });
  }

  // A reimbursement claim on the floater policy for the claims workspace.
  db.insert('healthClaims', {
    claimNumber: 'HC-SEED-000001', userId: 'usr_cust1', policyId: floater.id, policyNumber: floater.policyNumber,
    memberId: 'mem_vikram', memberName: 'Vikram Verma', type: 'reimbursement', hospitalId: 'hsp_5', hospitalName: 'Riverbank General Hospital', networkHospital: false,
    admissionDate: addDays(t, -20), dischargeDate: addDays(t, -16), diagnosis: 'Acute appendicitis', treatment: 'Laparoscopic appendectomy',
    isAccident: false, requestedAmount: 100000 * L, payoutDetails: { accountName: 'Asha Verma', accountNumber: '123456789012', ifsc: 'VHCB0001234' }, payoutVerified: false,
    status: 'Submitted', preauth: null, assessment: null, reservedAmount: 0, paidAmount: 0, documentRequests: [], internalNotes: [],
    timeline: [{ at: now().toISOString(), status: 'Submitted', by: 'Asha Verma', role: 'customer', note: 'Reimbursement claim submitted' }],
  });
  persist();
  return { users: USERS.map(([, , , email, role]) => ({ email, role, password: SEED_PASSWORD })) };
}

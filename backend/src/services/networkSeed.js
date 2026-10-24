// Idempotent reference/demo data for the network module. Called by ensureReferenceData() after a fresh
// seed (ctx.fresh === true) and at start-up on existing databases (ctx.fresh === false).
// Must upsert by fixed ids and never delete or overwrite existing records.
//
// Always: enrich the fictional hospitals with registry fields (only fields that are missing), add the
// admin-only candidate prospects (real chains, never public), and migrate the legacy `hospital.network`
// boolean into insurer network records for the sandbox insurer. Demo only (ctx.demo): extra fictional
// providers, product-level network examples, contracts, service catalogues, TPA links and a booking.
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { addDays } from '../utils/dates.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { CANDIDATE_LABEL, syncAllLegacyFlags } from './networkCore.js';
import { approveContract, createContract, submitContract } from './networkContracts.js';
import { createBooking, payBookingFee, slotsFor } from './networkBookings.js';

const OPS = { id: 'usr_ops', name: 'Farah Siddiqui', role: 'operations_admin' };
const ADMIN = { id: 'usr_admin', name: 'Aditi Rao', role: 'admin' };

const fill = (rec, values) => {
  for (const [k, v] of Object.entries(values)) if (rec[k] === undefined) rec[k] = v;
  return rec;
};
const upsert = (col, rec) => {
  const existing = db.get(col, rec.id);
  if (!existing) return db.insert(col, rec);
  return fill(existing, rec);
};

// id → [lat, lng, beds, bedsVerified, icuBeds, nabh: 'verified'|'claimed'|null, type, regState]
const ENRICH = {
  hsp_1: [13.0418, 80.2341, 220, true, 24, 'verified', 'hospital', 'TN'],
  hsp_2: [12.9756, 77.6050, 180, false, 16, 'claimed', 'hospital', 'KA'],
  hsp_3: [18.9220, 72.8250, 260, true, 30, 'verified', 'hospital', 'MH'],
  hsp_4: [22.5530, 88.3520, 140, true, 12, 'verified', 'hospital', 'WB'],
  hsp_5: [28.6315, 77.2167, 120, false, 8, null, 'hospital', 'DL'],
  hsp_6: [18.5286, 73.8740, 0, false, 0, null, 'clinic', 'MH'],
  hsp_7: [13.0012, 80.2565, 90, false, 6, 'claimed', 'hospital', 'TN'],
  hsp_8: [17.4326, 78.4071, 160, true, 28, 'claimed', 'hospital', 'TS'],
};
const SERVICES_BY_TYPE = {
  hospital: ['Cashless insurance desk', 'Health check packages', 'Lab diagnostics', 'Imaging', 'Pharmacy', 'Ambulance'],
  clinic: ['Cashless insurance desk', 'Out-patient consultations', 'Day-care procedures', 'Teleconsultation'],
};

function enrichHospitals() {
  for (const [id, [lat, lng, beds, bedsVerified, icuBeds, nabh, type, st]] of Object.entries(ENRICH)) {
    const h = db.get('hospitals', id);
    if (!h) continue;
    const n = id.split('_')[1];
    const verifiedAt = now().toISOString();
    fill(h, {
      providerType: type, legalName: `${h.name} (synthetic entity)`, sandbox: true, candidate: false, publishable: true, lat, lng, website: '',
      registration: { number: `SBX-CEA-${st}-${n.padStart(4, '0')}`, authority: 'State Clinical Establishments Registry (synthetic)', validFrom: '2024-04-01', validTo: addDays(today(), 900), verified: true, verifiedAt, source: 'Sandbox registry fixture' },
      licences: [
        { type: 'Clinical establishment licence', number: `SBX-LIC-${st}-${n}01`, authority: 'State Health Department (synthetic)', validFrom: '2024-04-01', validTo: addDays(today(), 600), verified: true, verifiedAt, source: 'Sandbox registry fixture' },
        ...(type === 'hospital' ? [{ type: 'Fire safety NOC', number: `SBX-FIRE-${st}-${n}`, authority: 'Fire Services (synthetic)', validFrom: '2025-01-01', validTo: addDays(today(), 300), verified: id !== 'hsp_7', verifiedAt: id !== 'hsp_7' ? verifiedAt : null, source: id !== 'hsp_7' ? 'Sandbox registry fixture' : null }] : []),
      ],
      accreditations: nabh ? [{ body: 'NABH', level: 'Full accreditation', certificateNo: `SBX-NABH-${n.padStart(3, '0')}`, validTo: addDays(today(), 500), claimed: true, verified: nabh === 'verified', verifiedAt: nabh === 'verified' ? verifiedAt : null, source: nabh === 'verified' ? 'Sandbox accreditation fixture (synthetic)' : null }] : [],
      contacts: [{ name: `Medical Superintendent (Hospital ${n})`, role: 'Medical superintendent', phone: h.phone, email: h.email }],
      insuranceDesk: { name: 'Insurance / TPA desk', phone: h.phone ? `${h.phone.slice(0, -1)}9` : '', email: `insurance${n}@hospital.test`, hours: type === 'clinic' ? 'Mon–Sat 9:00–18:00' : '24x7' },
      emergency: type === 'hospital' ? { available: true, hours: '24x7', verified: true, verifiedAt, source: 'Sandbox inspection fixture' } : { available: false, hours: '', verified: false },
      icu: { available: icuBeds > 0, beds: icuBeds, verified: icuBeds > 0 && bedsVerified, verifiedAt: icuBeds > 0 && bedsVerified ? verifiedAt : null },
      bedCapacity: beds ? { total: beds, verified: bedsVerified, verifiedAt: bedsVerified ? verifiedAt : null, source: bedsVerified ? 'Sandbox inspection fixture' : null } : null,
      diagnostics: type === 'hospital' ? ['Pathology lab', 'X-ray', 'Ultrasound', ...(Number(n) % 2 ? ['CT scan'] : ['MRI'])] : ['Audiometry', 'Optical coherence tomography'],
      supportedServices: SERVICES_BY_TYPE[type],
      branches: id === 'hsp_1' ? [{ id: 'hsp_1_br1', name: 'Sunrise Diagnostics — Velachery', address: '4 Taramani Link Road', city: 'Chennai', postalCode: '600042', facilities: ['Lab diagnostics', 'Imaging'], active: true }] : [],
      qualityRecords: id === 'hsp_1' ? [{ at: addDays(today(), -90), type: 'Patient feedback audit', summary: 'Quarterly feedback audit (synthetic)', outcome: 'Satisfactory' }] : [],
      integration: { status: id === 'hsp_1' ? 'Live (sandbox)' : 'Not started', protocol: id === 'hsp_1' ? 'REST (sandbox)' : null, notes: null },
      pendingVerification: [], verificationStatus: nabh === 'claimed' || !bedsVerified ? 'partially verified' : 'verified',
      onboarding: { stage: h.active === false ? 'Suspended' : 'Active', history: [{ at: now().toISOString(), from: null, status: h.active === false ? 'Suspended' : 'Active', by: 'System', role: 'system', note: 'Existing sandbox hospital migrated into the provider registry' }] },
    });
  }
}

// Real chains: admin-only partnership candidates. Never public, never activated, no network records.
const CANDIDATES = ['Apollo Hospitals', 'Fortis Healthcare', 'Max Healthcare', 'Manipal Hospitals', 'Aster DM Healthcare', 'Yashoda Hospitals', 'KIMS Hospitals'];
function ensureCandidates() {
  CANDIDATES.forEach((name, i) => upsert('hospitals', {
    id: `hsp_candidate_${i + 1}`, name, legalName: '', providerType: 'hospital', candidate: true, publishable: false, active: false, network: false, sandbox: false,
    address: '', city: '', state: '', postalCode: '', phone: '', email: '', specialties: [], diagnostics: [], supportedServices: [], branches: [], contacts: [],
    registration: { number: '', authority: '', validFrom: null, validTo: null, verified: false }, licences: [], accreditations: [],
    emergency: { available: false, verified: false }, icu: { available: false, beds: 0, verified: false }, bedCapacity: null, insuranceDesk: null, qualityRecords: [],
    integration: { status: 'Not started', protocol: null, notes: null }, pendingVerification: [], verificationStatus: 'unverified',
    candidateNote: `${CANDIDATE_LABEL}. Listed for partnership exploration only; no agreement exists and none is implied. Never shown publicly.`,
    onboarding: { stage: 'Prospect', history: [{ at: now().toISOString(), from: null, status: 'Prospect', by: 'System', role: 'system', note: 'Added from the target list in the product requirements (candidate — no agreement)' }] },
  }));
}

/** Legacy boolean → network records for the sandbox insurer (only for hospitals with no sandbox record yet). */
function migrateLegacyNetworkFlags() {
  for (const h of db.all('hospitals')) {
    if (h.candidate || !h.network) continue;
    if (db.findOne('hospitalNetworks', (r) => r.hospitalId === h.id && r.insurerId === SANDBOX_INSURER_ID)) continue;
    upsert('hospitalNetworks', {
      id: `hnw_${h.id}_sbx`, insurerId: SANDBOX_INSURER_ID, hospitalId: h.id, scope: 'all_products', planIds: [], services: [], status: 'active',
      effectiveFrom: addDays(today(), -180), effectiveTo: addDays(today(), 730), verifiedAt: now().toISOString(), verifiedBy: 'System', verificationSource: 'Migrated from legacy hospital network flag (sandbox)',
      publicNote: null, internalNote: 'Created by the network module migration', legacyMigrated: true,
      history: [{ at: now().toISOString(), by: 'System', role: 'system', action: 'migrated', status: 'active' }],
    });
  }
}

function ensureDemoProviders() {
  const verifiedAt = now().toISOString();
  const common = {
    sandbox: true, candidate: false, publishable: true, network: false, branches: [], qualityRecords: [], pendingVerification: [], verificationStatus: 'verified',
    integration: { status: 'Not started', protocol: null, notes: null }, icu: { available: false, beds: 0, verified: false }, bedCapacity: null,
    emergency: { available: false, hours: '', verified: false }, accreditations: [],
  };
  upsert('hospitals', {
    ...common, id: 'prv_diag_1', name: 'Pearl Diagnostics & Imaging', legalName: 'Pearl Diagnostics & Imaging (synthetic entity)', providerType: 'diagnostic_centre', active: true,
    address: '11 Road No. 2, Banjara Hills', city: 'Hyderabad', state: 'Telangana', postalCode: '500034', lat: 17.4156, lng: 78.4347, phone: '040-4000-0101', email: 'desk@pearl-diagnostics.test',
    specialties: ['Pathology', 'Radiology'], diagnostics: ['Pathology lab', 'Ultrasound', 'X-ray', 'CT scan'], supportedServices: ['Lab diagnostics', 'Imaging', 'Home sample collection', 'Health check packages'],
    registration: { number: 'SBX-CEA-TS-0901', authority: 'State Clinical Establishments Registry (synthetic)', validFrom: '2025-01-01', validTo: addDays(today(), 700), verified: true, verifiedAt, source: 'Sandbox registry fixture' },
    licences: [{ type: 'Diagnostic laboratory licence', number: 'SBX-LAB-TS-0901', authority: 'State Health Department (synthetic)', validFrom: '2025-01-01', validTo: addDays(today(), 500), verified: true, verifiedAt, source: 'Sandbox registry fixture' }],
    accreditations: [{ body: 'NABL', level: 'Medical laboratory', certificateNo: 'SBX-NABL-0901', validTo: addDays(today(), 400), claimed: true, verified: true, verifiedAt, source: 'Sandbox accreditation fixture (synthetic)' }],
    contacts: [{ name: 'Lab manager', role: 'Operations', phone: '040-4000-0101', email: 'desk@pearl-diagnostics.test' }],
    insuranceDesk: { name: 'Front desk', phone: '040-4000-0102', email: 'insurance@pearl-diagnostics.test', hours: 'Mon–Sat 7:00–20:00' },
    onboarding: { stage: 'Active', history: [{ at: verifiedAt, from: null, status: 'Active', by: 'System', role: 'system', note: 'Synthetic demo provider' }] },
  });
  upsert('hospitals', {
    ...common, id: 'prv_tele_1', name: 'CareConnect Telehealth', legalName: 'CareConnect Telehealth (synthetic entity)', providerType: 'telehealth', active: true,
    address: '3rd Floor, 40 Anna Salai', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600002', lat: 13.0604, lng: 80.2496, phone: '044-4000-0201', email: 'care@careconnect.test',
    specialties: ['General Medicine', 'Dermatology', 'Paediatrics'], diagnostics: [], supportedServices: ['Teleconsultation', 'E-prescriptions (by registered doctors)'],
    registration: { number: 'SBX-TEL-TN-0201', authority: 'Telemedicine registration (synthetic)', validFrom: '2025-06-01', validTo: addDays(today(), 600), verified: true, verifiedAt, source: 'Sandbox registry fixture' },
    licences: [{ type: 'Telemedicine practice registration', number: 'SBX-TML-0201', authority: 'Medical council (synthetic)', validFrom: '2025-06-01', validTo: addDays(today(), 600), verified: true, verifiedAt, source: 'Sandbox registry fixture' }],
    contacts: [{ name: 'Clinical lead', role: 'Medical director', phone: '044-4000-0201', email: 'care@careconnect.test' }],
    insuranceDesk: null,
    onboarding: { stage: 'Active', history: [{ at: verifiedAt, from: null, status: 'Active', by: 'System', role: 'system', note: 'Synthetic demo provider' }] },
  });
  upsert('hospitals', {
    ...common, id: 'prv_prospect_1', name: 'Silverline Community Clinic', legalName: 'Silverline Community Clinic (synthetic entity)', providerType: 'clinic', active: false, verificationStatus: 'unverified',
    address: '7 Gandhi Bazaar', city: 'Bengaluru', state: 'Karnataka', postalCode: '560004', lat: 12.9450, lng: 77.5730, phone: '080-4000-0301', email: 'hello@silverline.test',
    specialties: ['General Medicine', 'Diabetology'], diagnostics: [], supportedServices: ['Out-patient consultations'],
    registration: { number: 'SBX-CEA-KA-0301', authority: 'State Clinical Establishments Registry (synthetic)', validFrom: '2025-02-01', validTo: addDays(today(), 400), verified: false },
    licences: [{ type: 'Clinical establishment licence', number: 'SBX-LIC-KA-0301', authority: 'State Health Department (synthetic)', validFrom: '2025-02-01', validTo: addDays(today(), 400), verified: false, verifiedAt: null, source: null }],
    contacts: [{ name: 'Clinic owner', role: 'Owner', phone: '080-4000-0301', email: 'hello@silverline.test' }],
    insuranceDesk: null,
    onboarding: { stage: 'Credential Verification', history: [
      { at: verifiedAt, from: null, status: 'Prospect', by: 'Farah Siddiqui', role: 'operations_admin', note: 'Synthetic prospect added' },
      { at: verifiedAt, from: 'Prospect', status: 'Credential Verification', by: 'Farah Siddiqui', role: 'operations_admin', note: 'Documents received' },
    ] },
  });
}

function ensureDemoNetworks() {
  const t = today();
  const rec = (id, o) => upsert('hospitalNetworks', {
    id, insurerId: SANDBOX_INSURER_ID, planIds: [], services: [], verifiedAt: now().toISOString(), verifiedBy: 'System', publicNote: null, internalNote: 'Sandbox demo record',
    history: [{ at: now().toISOString(), by: 'System', role: 'system', action: 'seeded', status: o.status }], ...o,
  });
  // Product-level networks: Harbour Care is cashless for all sandbox products except the senior plan.
  if (db.get('hospitals', 'hsp_3')) rec('hnw_demo_hsp3_senior', { hospitalId: 'hsp_3', scope: 'plans', planIds: ['pln_health_senior'], status: 'restricted', effectiveFrom: addDays(t, -60), effectiveTo: addDays(t, 300), verificationSource: 'Sandbox insurer network file (synthetic) v3', publicNote: 'Senior plan: cashless not offered at this hospital' });
  // Riverbank: cashless only for the individual plan (in-patient & day-care).
  if (db.get('hospitals', 'hsp_5')) rec('hnw_demo_hsp5_individual', { hospitalId: 'hsp_5', scope: 'plans', planIds: ['pln_health_individual'], services: ['inpatient', 'daycare'], status: 'active', effectiveFrom: addDays(t, -30), effectiveTo: addDays(t, 335), verificationSource: 'Sandbox insurer network file (synthetic) v3' });
  // Coastal City: arrangement expired last month.
  if (db.get('hospitals', 'hsp_7')) rec('hnw_demo_hsp7_expired', { hospitalId: 'hsp_7', scope: 'all_products', status: 'active', effectiveFrom: addDays(t, -400), effectiveTo: addDays(t, -30), verificationSource: 'Sandbox insurer network file (synthetic) v2' });
  // Diagnostic centre: cashless for diagnostics and health checks only.
  if (db.get('hospitals', 'prv_diag_1')) rec('hnw_demo_diag1', { hospitalId: 'prv_diag_1', scope: 'all_products', services: ['diagnostics', 'health_check'], status: 'active', effectiveFrom: addDays(t, -90), effectiveTo: addDays(t, 640), verificationSource: 'Sandbox insurer network file (synthetic) v3' });
}

function ensureDemoContracts() {
  const t = today();
  const make = (id, hospitalId, from, to, rates, { approve = true } = {}) => {
    if (db.get('providerContracts', id) || !db.get('hospitals', hospitalId)) return;
    const c = createContract({
      hospitalId, effectiveFrom: from, effectiveTo: to, facilities: ['main', ...(db.get('hospitals', hospitalId).branches || []).map((b) => b.id)],
      serviceScope: ['Appointment bookings via VHC', 'Health check packages', 'Diagnostics', 'Cashless desk co-ordination (insurer networks are separate)'],
      packageRates: rates, terms: { summary: 'Synthetic sandbox provider services agreement. Does not create cashless eligibility with any insurer.', noticeDays: 90 },
      paymentObligations: { creditDays: 30, billingCycle: 'monthly', note: 'Booking fees retained by VHC; service charges paid by patient/payer directly to the provider (sandbox)' },
      referralRestrictions: 'No incentives for referrals; patients choose providers freely.',
      qualityObligations: ['Respond to booking changes within 2 hours', 'Maintain valid licences and accreditation', 'Share insurance-desk contact for cashless queries'],
      escalation: [{ level: 1, name: 'Provider relations (VHC)', email: 'ops_farah@vhc.test' }, { level: 2, name: 'Hospital insurance desk head', email: db.get('hospitals', hospitalId).insuranceDesk?.email || '' }],
      renewal: { auto: false, noticeDays: 60 },
    }, OPS, { id });
    submitContract(c, OPS);
    if (approve) approveContract(c, { note: 'Sandbox demo approval' }, ADMIN);
  };
  make('hct_demo_hsp1', 'hsp_1', addDays(t, -200), addDays(t, 165), [
    { code: 'HC-EXEC', name: 'Executive health check', amount: 450000 }, { code: 'CARD-ANGIO', name: 'Coronary angiography package', amount: 1800000 }, { code: 'ORTHO-ARTH', name: 'Knee arthroscopy package', amount: 6500000 },
  ]);
  make('hct_demo_hsp8', 'hsp_8', addDays(t, -340), addDays(t, 25), [{ code: 'HC-CARDIAC', name: 'Cardiac screening package', amount: 350000 }]);
  make('hct_demo_hsp3', 'hsp_3', addDays(t, 7), addDays(t, 372), [{ code: 'HC-BASIC', name: 'Basic health check', amount: 180000 }], { approve: false });
}

// [suffix, category, name, price, discounted, schedule]
const CATALOGUE = {
  hsp_1: [['cons', 'doctor_consultation', 'General physician consultation', 70000, 60000], ['card', 'specialist_consultation', 'Cardiology consultation', 120000, 100000], ['hc', 'preventive_health_check', 'Executive health check', 450000, 399000, { start: '07:30', end: '10:30', intervalMin: 30, capacity: 3 }], ['lab', 'diagnostic_lab', 'Lipid profile & HbA1c', 120000, null], ['vac', 'vaccination', 'Influenza vaccination', 150000, null], ['fu', 'follow_up', 'Follow-up visit', 40000, null]],
  hsp_2: [['onc', 'specialist_consultation', 'Oncology consultation', 150000, null], ['tele', 'teleconsultation', 'Paediatrics teleconsultation', 50000, 45000, { start: '10:00', end: '18:00', intervalMin: 20, capacity: 1 }]],
  hsp_3: [['card', 'specialist_consultation', 'Cardiology consultation', 130000, null], ['img', 'imaging', 'Echocardiogram', 250000, 220000]],
  hsp_4: [['obg', 'specialist_consultation', 'Obstetrics consultation', 90000, null], ['vac', 'vaccination', 'Child immunisation visit', 120000, null]],
  hsp_6: [['eye', 'specialist_consultation', 'Ophthalmology consultation', 80000, 70000], ['ent', 'specialist_consultation', 'ENT consultation', 80000, null]],
  hsp_8: [['hc', 'preventive_health_check', 'Cardiac screening package', 350000, 320000, { start: '07:00', end: '11:00', intervalMin: 30, capacity: 2 }], ['card', 'specialist_consultation', 'Cardiology consultation', 120000, null]],
  prv_diag_1: [['lab', 'diagnostic_lab', 'Complete blood count + thyroid panel', 90000, 75000, { start: '07:00', end: '12:00', intervalMin: 15, capacity: 4 }], ['home', 'home_sample_collection', 'Home sample collection (Hyderabad)', 30000, null, { start: '06:30', end: '10:30', intervalMin: 30, capacity: 2 }], ['img', 'imaging', 'Ultrasound abdomen', 180000, 160000], ['hc', 'preventive_health_check', 'Basic wellness package', 199900, null]],
  prv_tele_1: [['tele', 'teleconsultation', 'Online GP consultation', 39900, 34900, { start: '08:00', end: '22:00', intervalMin: 15, capacity: 2 }], ['derm', 'teleconsultation', 'Online dermatology consultation', 59900, null, { start: '10:00', end: '19:00', intervalMin: 20, capacity: 1 }]],
};
function ensureCatalogue() {
  for (const [hid, items] of Object.entries(CATALOGUE)) {
    if (!db.get('hospitals', hid)) continue;
    for (const [suffix, category, name, price, discountedPrice, schedule] of items) {
      upsert('providerServices', {
        id: `svc_${hid}_${suffix}`, hospitalId: hid, branchId: null, category, name, description: `${name} (synthetic sandbox price)`, inclusions: [],
        price, discountedPrice, durationMin: schedule?.intervalMin || 30, mode: category === 'teleconsultation' ? 'video' : category === 'home_sample_collection' ? 'home' : 'in_person',
        schedule: { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00', intervalMin: 30, capacity: 2, ...(schedule || {}) },
        sponsoredEmployerIds: suffix === 'hc' && hid === 'hsp_8' && db.get('employers', 'emp_demo') ? ['emp_demo'] : [], active: true, synthetic: true,
      });
    }
  }
}

function ensureTpa() {
  const tpa = db.get('tpas', 'tpa_sandbox');
  if (!tpa) return;
  fill(tpa, {
    relationships: [{
      id: 'rel_1', insurerId: SANDBOX_INSURER_ID, insurerName: db.get('insurers', SANDBOX_INSURER_ID)?.name || SANDBOX_INSURER_ID, from: addDays(today(), -365), to: null, status: 'active',
      scope: 'Health claims administration (cashless & reimbursement) — sandbox', agreementRef: 'SBX-TPA-AGR-001', authorisedNetworkScope: 'insurer_network', authorisedHospitalIds: [],
      history: [{ at: now().toISOString(), by: 'System', note: 'Sandbox relationship' }],
    }],
    servicingContacts: [{ name: 'Kiran Joshi', role: 'Claims servicing', phone: '+91 90000 00000', email: 'tpa_kiran@vhc.test', region: 'All India (sandbox)' }],
    hospitalNetworkRefs: db.find('hospitalNetworks', (r) => r.insurerId === SANDBOX_INSURER_ID).map((r) => r.id),
    escalations: [], escalationMatrix: [{ level: 1, contact: 'tpa_kiran@vhc.test' }, { level: 2, contact: 'insurance_neha@vhc.test' }],
  });
}

function ensureDemoBooking() {
  const user = db.get('users', 'usr_arjun');
  const svc = db.get('providerServices', 'svc_hsp_8_hc');
  if (!user || !svc || db.findOne('healthBookings', (b) => b.userId === user.id)) return;
  for (let d = 2; d <= 10; d++) {
    const date = addDays(today(), d);
    const slot = slotsFor(svc, date).find((x) => x.available);
    if (!slot) continue;
    const actor = { id: user.id, name: user.name, role: 'customer' };
    const bk = createBooking({ serviceId: svc.id, date, slot: slot.time, payerType: 'self_pay', idempotencyKey: 'seed-arjun-booking' }, actor);
    payBookingFee(bk, actor);
    return;
  }
}

export function ensureNetworkData(ctx) {
  enrichHospitals();
  ensureCandidates();
  migrateLegacyNetworkFlags();
  if (ctx.demo) {
    ensureDemoProviders();
    ensureDemoNetworks();
    ensureDemoContracts();
    ensureCatalogue();
  }
  ensureTpa();
  syncAllLegacyFlags();
  if (ctx.demo && ctx.fresh) ensureDemoBooking();
}

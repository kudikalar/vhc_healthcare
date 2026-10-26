// Network module API (mounted at /api/network): provider registry & onboarding, provider contracts,
// insurer cashless networks, public directory, health-services booking, hospital partner portal,
// TPA registry & TPA portal, and provider analytics.
//
// Access model
//   public           directory, provider detail, service catalogue and slots
//   customer         own bookings
//   admin/operations registry, contracts (admin approves), networks, TPAs, services, bookings
//   compliance/auditor  read-only across the above
//   hospital_*       /hospital-portal/:hid — strictly own hospital (404 otherwise); staff are read/operate only
//   tpa_*            /tpa-portal/:tpaId — own TPA; claims of administered insurers only; recommendations, never decisions
import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad, conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { audit } from '../services/audit.js';
import { registerJob } from '../services/jobs.js';
import { cleanEmail, cleanName, maskEmail } from '../services/security.js';
import { createChallenge } from '../services/challenges.js';
import { displayName, publicUser } from '../services/profile.js';
import {
  HOSPITAL_ROLES, REGISTRY_READ, REGISTRY_WRITE, TPA_ROLES, CANDIDATE_LABEL, applyProviderFields, cashlessStatus, changeStage, createNetworkRecord,
  createProvider, directoryMeta, expiringNetworks, getProvider, isPublicProvider, networkView, publicProvider, registryRow, registryView,
  searchDirectory, stageOf, syncAllLegacyFlags, updateNetworkRecord, verifyNetworkRecord, verifyProviderField,
} from '../services/networkCore.js';
import {
  addComplaint, approveContract, contractView, createContract, decideAmendment, expiringContracts, getContract, hospitalContractView,
  proposeAmendment, refreshAllContracts, refreshContract, rejectContract, renewContract, resolveComplaint, submitContract, terminateContract, updateDraft,
} from '../services/networkContracts.js';
import {
  BOOKING_FEE_PAISE, COVERAGE_NOTE, PAYER_TYPES, SERVICE_CATEGORIES, bookingView, cancelBooking, completeBooking, createBooking, createService,
  getPublicService, listServices, payBookingFee, rescheduleBooking, serviceView, slotsFor, updateService,
} from '../services/networkBookings.js';
import {
  RECOMMENDATIONS, addEscalation, addRelationship, addTpaNote, endRelationship, getTpa, recommendDocuments, recordRecommendation, resolveEscalation,
  tpaClaim, tpaClaimView, tpaClaims, tpaTurnaround, tpaView, updateTpa,
} from '../services/networkTpa.js';
import { hospitalClaimRow, hospitalClaims, hospitalReport, networkAnalytics } from '../services/networkReports.js';
import { policyStatusAt } from '../services/lifecycle.js';

const r = Router();
const auth = authenticate;
const read = [auth, requireRole(...REGISTRY_READ)];
const write = [auth, requireRole(...REGISTRY_WRITE)];
const adminOnly = [auth, requireRole('admin')];
const s = (v) => String(v ?? '').trim();
const byUpdated = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));

// Scheduled work: contracts move along the calendar (activation publishes the event once); network
// records that expire or start today are reflected in the legacy boolean used by the claims workflow.
registerJob(() => ({ networkContractsChanged: refreshAllContracts(), networkFlagsSynced: syncAllLegacyFlags() }));

// =====================================================================================================
// Public directory & catalogue
// =====================================================================================================
r.get('/directory', (req, res) => res.json(searchDirectory(req.query)));
r.get('/directory/meta', (req, res) => res.json(directoryMeta()));

r.get('/providers/:id', (req, res) => {
  const h = db.get('hospitals', req.params.id);
  if (!isPublicProvider(h)) throw notFound('Provider not found');
  const { insurerId, planId, date } = req.query;
  const view = { ...publicProvider(h), disclaimer: searchDirectory({}).disclaimer, services: listServices({ hospitalId: h.id }) };
  if (insurerId || planId) view.cashless = searchDirectory({ insurerId, planId, date, q: h.name }).providers.find((p) => p.id === h.id)?.cashless || null;
  res.json(view);
});

r.get('/services', (req, res) => res.json({ coverageNote: COVERAGE_NOTE, payerTypes: PAYER_TYPES, categories: SERVICE_CATEGORIES, bookingFee: BOOKING_FEE_PAISE, services: listServices(req.query) }));
r.get('/services/:id', (req, res) => res.json(serviceView(getPublicService(req.params.id))));
r.get('/services/:id/slots', (req, res) => res.json({ date: req.query.date, slots: slotsFor(getPublicService(req.params.id), s(req.query.date)) }));

// =====================================================================================================
// Customer bookings
// =====================================================================================================
const customer = [auth, requireRole('customer')];
const ownBooking = (req) => {
  const bk = db.get('healthBookings', req.params.id);
  if (!bk || bk.userId !== req.user.id) throw notFound('Booking not found');
  return bk;
};

r.get('/bookings/mine', customer, (req, res) => {
  res.json({ coverageNote: COVERAGE_NOTE, bookings: db.find('healthBookings', (b) => b.userId === req.user.id).sort((a, b) => `${b.date}${b.slot}`.localeCompare(`${a.date}${a.slot}`)).map(bookingView) });
});

/** Checks insured-cashless eligibility for one of the customer's policies before booking. */
r.get('/bookings/eligibility', customer, (req, res) => {
  const svc = getPublicService(req.query.serviceId);
  const date = s(req.query.date) || undefined;
  const policies = db.find('policies', (p) => p.userId === req.user.id && p.product === 'health' && (!req.query.policyId || p.id === req.query.policyId));
  res.json({
    coverageNote: COVERAGE_NOTE,
    policies: policies.map((p) => {
      const st = cashlessStatus({ hospitalId: svc.hospitalId, insurerId: p.insurerId, planId: p.planId, service: SERVICE_CATEGORIES[svc.category].networkService, date });
      const active = policyStatusAt(p, st.date) === 'Active';
      return { policyId: p.id, policyNumber: p.policyNumber, planName: p.planName, insurerName: st.insurerName, policyActive: active, eligible: active && st.eligible, status: st.status, text: st.text, label: st.label || null, lastVerifiedAt: st.lastVerifiedAt || null };
    }),
  });
});

r.post('/bookings', customer, (req, res) => {
  const bk = tx(() => createBooking(req.body || {}, req.user));
  res.status(201).json(bookingView(bk));
});
r.post('/bookings/:id/pay', customer, (req, res) => {
  const bk = ownBooking(req);
  res.json(bookingView(tx(() => payBookingFee(bk, req.user))));
});
r.post('/bookings/:id/reschedule', customer, (req, res) => {
  const bk = ownBooking(req);
  res.json(bookingView(tx(() => rescheduleBooking(bk, req.body || {}, req.user))));
});
r.post('/bookings/:id/cancel', customer, (req, res) => {
  const bk = ownBooking(req);
  res.json(bookingView(tx(() => cancelBooking(bk, req.body || {}, req.user))));
});

// Internal oversight of bookings.
r.get('/bookings', read, (req, res) => {
  const { status, hospitalId, payerType } = req.query;
  res.json(db.find('healthBookings', (b) => (!status || b.status === status) && (!hospitalId || b.hospitalId === hospitalId) && (!payerType || b.payerType === payerType)).sort(byUpdated).map(bookingView));
});

r.get('/bookings/:id', auth, (req, res) => {
  const bk = db.get('healthBookings', req.params.id);
  const u = req.user;
  const ok = bk && ((u.role === 'customer' && bk.userId === u.id) || (HOSPITAL_ROLES.includes(u.role) && u.orgId === bk.hospitalId) || REGISTRY_READ.includes(u.role));
  if (!ok) throw notFound('Booking not found');
  res.json(bookingView(bk));
});

// =====================================================================================================
// Provider registry & onboarding (internal)
// =====================================================================================================
r.get('/registry', read, (req, res) => {
  const { q, stage, providerType, candidate } = req.query;
  const rows = db.all('hospitals').filter((h) => (!q || `${h.name} ${h.city}`.toLowerCase().includes(String(q).toLowerCase()))
    && (!stage || stageOf(h) === stage) && (!providerType || (h.providerType || 'hospital') === providerType)
    && (candidate === undefined || candidate === '' || String(!!h.candidate) === String(candidate))).map(registryRow);
  res.json({ candidateLabel: CANDIDATE_LABEL, providers: rows.sort((a, b) => Number(a.candidate) - Number(b.candidate) || a.name.localeCompare(b.name)) });
});
r.get('/registry/:id', read, (req, res) => res.json(registryView(getProvider(req.params.id))));
r.post('/registry', write, (req, res) => {
  const h = tx(() => createProvider(req.body || {}, req.user));
  res.status(201).json(registryView(h));
});
r.put('/registry/:id', write, (req, res) => {
  const h = getProvider(req.params.id);
  const pending = tx(() => {
    const p = applyProviderFields(h, req.body || {});
    audit(req.user, 'PROVIDER_UPDATED', 'hospital', h.id, { fields: Object.keys(req.body || {}), pendingVerification: p });
    return p;
  });
  res.json({ ...registryView(h), resetToPending: pending });
});
r.post('/registry/:id/verify', write, (req, res) => {
  const h = getProvider(req.params.id);
  tx(() => verifyProviderField(h, req.body || {}, req.user));
  res.json(registryView(h));
});
r.post('/registry/:id/stage', write, (req, res) => {
  const h = getProvider(req.params.id);
  tx(() => changeStage(h, req.body || {}, req.user));
  res.json(registryView(h));
});

// =====================================================================================================
// Insurer cashless networks (internal)
// =====================================================================================================
r.get('/networks', read, (req, res) => {
  const { hospitalId, insurerId, status } = req.query;
  res.json(db.find('hospitalNetworks', (n) => (!hospitalId || n.hospitalId === hospitalId) && (!insurerId || n.insurerId === insurerId) && (!status || n.status === status)).map(networkView).sort((a, b) => a.hospitalName.localeCompare(b.hospitalName)));
});
r.get('/networks/expiring', read, (req, res) => res.json(expiringNetworks(Number(req.query.days) || 60)));
r.get('/networks/check', read, (req, res) => res.json(cashlessStatus({ hospitalId: req.query.hospitalId, insurerId: req.query.insurerId, planId: req.query.planId, service: req.query.service, date: req.query.date || undefined })));
r.post('/networks', write, (req, res) => res.status(201).json(networkView(tx(() => createNetworkRecord(req.body || {}, req.user)))));
const getNetwork = (id) => {
  const n = db.get('hospitalNetworks', id);
  if (!n) throw notFound('Network record not found');
  return n;
};
r.put('/networks/:id', write, (req, res) => {
  const n = getNetwork(req.params.id);
  res.json(networkView(tx(() => updateNetworkRecord(n, req.body || {}, req.user))));
});
r.post('/networks/:id/verify', write, (req, res) => {
  const n = getNetwork(req.params.id);
  res.json(networkView(tx(() => verifyNetworkRecord(n, req.body || {}, req.user))));
});

// =====================================================================================================
// Provider contracts (internal; admin approves)
// =====================================================================================================
r.get('/contracts', read, (req, res) => {
  const { hospitalId, status } = req.query;
  const list = tx(() => db.all('providerContracts').map((c) => refreshContract(c)));
  res.json(list.filter((c) => (!hospitalId || c.hospitalId === hospitalId) && (!status || c.status === status)).sort(byUpdated).map(contractView));
});
r.get('/contracts/expiring', read, (req, res) => res.json(tx(() => expiringContracts(Number(req.query.days) || 60)).map(contractView)));
r.get('/contracts/:id', read, (req, res) => res.json(contractView(tx(() => getContract(req.params.id)))));
r.post('/contracts', write, (req, res) => {
  const { id: _ignored, ...body } = req.body || {};
  res.status(201).json(contractView(tx(() => createContract(body, req.user))));
});
const contractAction = (fn) => (req, res) => {
  const c = tx(() => getContract(req.params.id));
  res.json(contractView(tx(() => fn(c, req.body || {}, req.user, req))));
};
r.put('/contracts/:id', write, contractAction((c, b, u) => updateDraft(c, b, u)));
r.post('/contracts/:id/submit', write, contractAction((c, b, u) => submitContract(c, u)));
r.post('/contracts/:id/approve', adminOnly, contractAction((c, b, u) => approveContract(c, b, u)));
r.post('/contracts/:id/reject', adminOnly, contractAction((c, b, u) => rejectContract(c, b, u)));
r.post('/contracts/:id/amendments', write, contractAction((c, b, u) => proposeAmendment(c, b, u)));
r.post('/contracts/:id/amendments/:version/decision', adminOnly, contractAction((c, b, u, req) => decideAmendment(c, req.params.version, b, u)));
r.post('/contracts/:id/terminate', adminOnly, contractAction((c, b, u) => terminateContract(c, b, u)));
r.post('/contracts/:id/complaints', write, contractAction((c, b, u) => addComplaint(c, b, u)));
r.post('/contracts/:id/complaints/:cid/resolve', write, contractAction((c, b, u, req) => resolveComplaint(c, req.params.cid, b, u)));
r.post('/contracts/:id/renew', write, (req, res) => {
  const c = tx(() => getContract(req.params.id));
  res.status(201).json(contractView(tx(() => renewContract(c, req.body || {}, req.user))));
});

// Internal management of service catalogues (admin/operations).
r.get('/catalogue', read, (req, res) => res.json(db.find('providerServices', (x) => !req.query.hospitalId || x.hospitalId === req.query.hospitalId).map(serviceView)));
r.post('/catalogue', write, (req, res) => {
  const h = getProvider(req.body?.hospitalId);
  if (h.candidate) throw unprocessable(`${CANDIDATE_LABEL}: services cannot be listed`);
  res.status(201).json(serviceView(tx(() => createService(req.body || {}, h, req.user))));
});
r.put('/catalogue/:id', write, (req, res) => {
  const svc = db.get('providerServices', req.params.id);
  if (!svc) throw notFound('Service not found');
  res.json(serviceView(tx(() => updateService(svc, req.body || {}, getProvider(svc.hospitalId), req.user))));
});

r.get('/analytics', read, (req, res) => res.json(tx(() => networkAnalytics())));

// =====================================================================================================
// Hospital partner portal — strictly the user's own hospital (404 for any other id)
// =====================================================================================================
/**
 * Resolves :hid for the caller. Hospital users: own hospital only (404 otherwise); `adminOnly` requires
 * hospital_admin. Internal staff: read for oversight roles, write only for admin/operations.
 */
function portalHospital(req, { mutate = false, hospitalAdmin = false } = {}) {
  const u = req.user;
  const h = db.get('hospitals', req.params.hid);
  if (HOSPITAL_ROLES.includes(u.role)) {
    if (!h || u.orgId !== h.id) throw notFound('Hospital not found');
    if (hospitalAdmin && u.role !== 'hospital_admin') throw forbidden('Only the hospital administrator can do this');
    return h;
  }
  if (!REGISTRY_READ.includes(u.role)) throw notFound('Hospital not found');
  if (!h) throw notFound('Hospital not found');
  if (mutate && !REGISTRY_WRITE.includes(u.role)) throw forbidden();
  return h;
}
const portal = [auth, requireRole(...HOSPITAL_ROLES, ...REGISTRY_READ)];

/** Fields a hospital administrator may edit; verified attributes return to pending verification. */
const HOSPITAL_EDITABLE = ['phone', 'email', 'website', 'contacts', 'insuranceDesk', 'specialties', 'diagnostics', 'supportedServices', 'branches', 'emergency', 'icu', 'bedCapacity', 'accreditations', 'licences', 'registration', 'address', 'city', 'state', 'postalCode', 'lat', 'lng'];

function hospitalProfile(h) {
  const v = registryView(h);
  delete v.candidateNote;
  v.networkRecords = v.networkRecords.map(({ internalNote, history, ...n }) => n); // eslint-disable-line no-unused-vars
  v.onboarding = { stage: v.stage, history: (h.onboarding?.history || []).map(({ at, status, note }) => ({ at, status, note })) };
  v.editableFields = HOSPITAL_EDITABLE;
  return v;
}

r.get('/hospital-portal/:hid', portal, (req, res) => res.json(hospitalProfile(portalHospital(req))));

r.put('/hospital-portal/:hid/profile', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true, hospitalAdmin: true });
  const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => HOSPITAL_EDITABLE.includes(k)));
  if (!Object.keys(body).length) throw bad(`Nothing to update. Editable fields: ${HOSPITAL_EDITABLE.join(', ')}`);
  // Address changes need re-verification of the location too.
  const addrChanged = ['address', 'city', 'state', 'postalCode'].some((k) => body[k] !== undefined && s(body[k]) !== s(h[k]));
  const pending = tx(() => {
    const p = applyProviderFields(h, body, { allowed: HOSPITAL_EDITABLE });
    if (addrChanged) {
      h.pendingVerification = [...new Set([...(h.pendingVerification || []), 'address'])];
      h.verificationStatus = 'pending verification';
      p.push('address');
    }
    audit(req.user, 'HOSPITAL_PROFILE_UPDATED', 'hospital', h.id, { fields: Object.keys(body), pendingVerification: p });
    return p;
  });
  res.json({ ...hospitalProfile(h), resetToPending: pending });
});

r.get('/hospital-portal/:hid/staff', portal, (req, res) => {
  const h = portalHospital(req);
  res.json(db.find('users', (u) => u.orgId === h.id && HOSPITAL_ROLES.includes(u.role)).map((u) => publicUser(u)));
});

/** Hospital admins invite hospital_staff for their own hospital only (mirrors POST /admin/users). */
r.post('/hospital-portal/:hid/staff', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true, hospitalAdmin: true });
  if (h.candidate || !isPublicProvider(h)) throw conflict('Staff can be invited only for active providers');
  const { firstName, lastName, email } = req.body || {};
  const fields = {};
  const fn = cleanName(firstName);
  if (!fn) fields.firstName = 'Enter a first name.';
  const ln = cleanName(lastName, { required: false });
  if (ln === null) fields.lastName = 'Use letters, spaces, apostrophes or hyphens.';
  const em = cleanEmail(email);
  if (!em) fields.email = 'Enter a valid email address.';
  if (req.body?.role && req.body.role !== 'hospital_staff') fields.role = 'Hospital administrators can invite hospital staff only.';
  if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields });
  if (db.findOne('users', (u) => u.emailLower === em.toLowerCase())) throw conflict('An account with this email already exists');
  const { u, token } = tx(() => {
    const rec = db.insert('users', {
      firstName: fn, lastName: ln, name: displayName({ firstName: fn, lastName: ln }), legalName: displayName({ firstName: fn, lastName: ln }),
      email: em, emailLower: em.toLowerCase(), emailVerified: false, mobile: '', mobileVerified: false, passwordHash: null,
      role: 'hospital_staff', status: 'Invited', active: true, profile: {}, communicationPreference: 'email', invitedBy: req.user.id, orgId: h.id,
    });
    const { secret } = createChallenge({ subjectId: rec.id, purpose: 'invite', destination: rec.emailLower, kind: 'link' });
    audit(req.user, 'USER_INVITED', 'user', rec.id, { email: maskEmail(em), role: 'hospital_staff', orgId: h.id });
    return { u: rec, token: secret };
  });
  res.status(201).json({ user: publicUser(u), ...(process.env.NODE_ENV !== 'production' ? { devInviteToken: token } : {}) });
});

r.get('/hospital-portal/:hid/bookings', portal, (req, res) => {
  const h = portalHospital(req);
  const { status, date } = req.query;
  res.json(db.find('healthBookings', (b) => b.hospitalId === h.id && (!status || b.status === status) && (!date || b.date === date))
    .sort((a, b) => `${a.date}${a.slot}`.localeCompare(`${b.date}${b.slot}`)).map(bookingView));
});
const portalBooking = (req, h) => {
  const bk = db.get('healthBookings', req.params.bid);
  if (!bk || bk.hospitalId !== h.id) throw notFound('Booking not found');
  return bk;
};
r.post('/hospital-portal/:hid/bookings/:bid/complete', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true });
  const bk = portalBooking(req, h);
  res.json(bookingView(tx(() => completeBooking(bk, req.body || {}, req.user))));
});
r.post('/hospital-portal/:hid/bookings/:bid/cancel', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true });
  const bk = portalBooking(req, h);
  res.json(bookingView(tx(() => cancelBooking(bk, req.body || {}, req.user))));
});

r.get('/hospital-portal/:hid/services', portal, (req, res) => {
  const h = portalHospital(req);
  res.json(db.find('providerServices', (x) => x.hospitalId === h.id).map(serviceView));
});
r.post('/hospital-portal/:hid/services', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true, hospitalAdmin: true });
  res.status(201).json(serviceView(tx(() => createService(req.body || {}, h, req.user))));
});
r.put('/hospital-portal/:hid/services/:sid', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true, hospitalAdmin: true });
  const svc = db.get('providerServices', req.params.sid);
  if (!svc || svc.hospitalId !== h.id) throw notFound('Service not found');
  res.json(serviceView(tx(() => updateService(svc, req.body || {}, h, req.user))));
});

// Insurance desk: cashless/reimbursement claims at this hospital (limited fields; read is audited).
r.get('/hospital-portal/:hid/claims', portal, (req, res) => {
  const h = portalHospital(req);
  const rows = hospitalClaims(h.id).filter((c) => !req.query.type || c.type === req.query.type).map(hospitalClaimRow);
  tx(() => audit(req.user, 'HOSPITAL_CLAIMS_VIEWED', 'hospital', h.id, { count: rows.length }));
  res.json({ note: 'Claim decisions are made by the insurer / authorised claims officer. Medical details are not shown here.', claims: rows });
});

r.get('/hospital-portal/:hid/contracts', portal, (req, res) => {
  const h = portalHospital(req);
  const list = tx(() => db.find('providerContracts', (c) => c.hospitalId === h.id && !['draft', 'rejected'].includes(c.status)).map((c) => refreshContract(c)));
  res.json({ note: 'A VHC provider contract does not make you cashless for any insurer; cashless status comes only from each insurer\'s network.', contracts: list.map(hospitalContractView) });
});
r.post('/hospital-portal/:hid/contracts/:cid/complaints', portal, (req, res) => {
  const h = portalHospital(req, { mutate: true, hospitalAdmin: true });
  const c = db.get('providerContracts', req.params.cid);
  if (!c || c.hospitalId !== h.id || ['draft', 'rejected'].includes(c.status)) throw notFound('Contract not found');
  res.json(hospitalContractView(tx(() => addComplaint(c, { summary: req.body?.summary, raisedBy: h.name }, req.user))));
});

r.get('/hospital-portal/:hid/networks', portal, (req, res) => {
  const h = portalHospital(req);
  res.json(db.find('hospitalNetworks', (n) => n.hospitalId === h.id).map(networkView).map(({ internalNote, history, ...n }) => n)); // eslint-disable-line no-unused-vars
});

r.get('/hospital-portal/:hid/reports', portal, (req, res) => res.json(hospitalReport(portalHospital(req).id)));

// =====================================================================================================
// TPAs — registry (internal) and portal (own TPA)
// =====================================================================================================
r.get('/tpas', read, (req, res) => res.json(db.all('tpas').map(tpaView)));
r.get('/tpas/:id', read, (req, res) => res.json(tpaView(getTpa(req.params.id))));
r.put('/tpas/:id', write, (req, res) => {
  const t = getTpa(req.params.id);
  res.json(tpaView(tx(() => updateTpa(t, req.body || {}, req.user))));
});
r.post('/tpas/:id/relationships', write, (req, res) => {
  const t = getTpa(req.params.id);
  res.status(201).json(tpaView(tx(() => addRelationship(t, req.body || {}, req.user))));
});
r.post('/tpas/:id/relationships/:rid/end', write, (req, res) => {
  const t = getTpa(req.params.id);
  res.json(tpaView(tx(() => endRelationship(t, req.params.rid, req.body || {}, req.user))));
});
r.post('/tpas/:id/escalations/:eid/resolve', write, (req, res) => {
  const t = getTpa(req.params.id);
  res.json(tpaView(tx(() => resolveEscalation(t, req.params.eid, req.body || {}, req.user))));
});

function portalTpa(req, { mutate = false } = {}) {
  const u = req.user;
  const t = db.get('tpas', req.params.tpaId);
  if (TPA_ROLES.includes(u.role)) {
    if (!t || u.orgId !== t.id) throw notFound('TPA not found');
    return t;
  }
  if (!REGISTRY_READ.includes(u.role) || !t) throw notFound('TPA not found');
  if (mutate) throw forbidden('TPA notes and recommendations are recorded by the TPA');
  return t;
}
const tpaPortal = [auth, requireRole(...TPA_ROLES, ...REGISTRY_READ)];

r.get('/tpa-portal/:tpaId', tpaPortal, (req, res) => {
  const t = portalTpa(req);
  res.json({ tpa: tpaView(t), report: tpaTurnaround(t), recommendations: RECOMMENDATIONS });
});
r.get('/tpa-portal/:tpaId/claims', tpaPortal, (req, res) => {
  const t = portalTpa(req);
  const { status, type } = req.query;
  const rows = tpaClaims(t).filter((c) => (!status || c.status === status) && (!type || c.type === type)).sort(byUpdated).map((c) => tpaClaimView(c, t));
  res.json({ note: 'Claims on policies of insurers this TPA administers. Final decisions rest with the insurer / authorised claims officer.', claims: rows });
});
r.get('/tpa-portal/:tpaId/claims/:claimId', tpaPortal, (req, res) => {
  const t = portalTpa(req);
  const c = tpaClaim(t, req.params.claimId);
  tx(() => audit(req.user, 'TPA_CLAIM_VIEWED', 'healthClaim', c.id, { tpaId: t.id }));
  res.json(tpaClaimView(c, t, { detail: true }));
});
const tpaAction = (fn) => (req, res) => {
  const t = portalTpa(req, { mutate: true });
  const c = tpaClaim(t, req.params.claimId);
  tx(() => fn(t, c, req.body || {}, req.user));
  res.json(tpaClaimView(c, t, { detail: true }));
};
r.post('/tpa-portal/:tpaId/claims/:claimId/notes', tpaPortal, tpaAction(addTpaNote));
r.post('/tpa-portal/:tpaId/claims/:claimId/document-requests', tpaPortal, tpaAction(recommendDocuments));
r.post('/tpa-portal/:tpaId/claims/:claimId/recommendation', tpaPortal, tpaAction(recordRecommendation));
r.post('/tpa-portal/:tpaId/escalations', tpaPortal, (req, res) => {
  const t = portalTpa(req, { mutate: true });
  res.status(201).json(tpaView(tx(() => addEscalation(t, req.body || {}, req.user))));
});
r.get('/tpa-portal/:tpaId/reports/turnaround', tpaPortal, (req, res) => res.json(tpaTurnaround(portalTpa(req))));

/** Claims officers (and oversight roles) see TPA recommendations alongside the claim. */
r.get('/claims/:claimId/tpa-reviews', [auth, requireRole('claims_officer', ...REGISTRY_READ)], (req, res) => {
  const c = db.get('healthClaims', req.params.claimId);
  if (!c) throw notFound('Claim not found');
  res.json(db.find('tpaClaimReviews', (x) => x.claimId === c.id).map((x) => ({ ...x, tpaName: db.get('tpas', x.tpaId)?.name })));
});

export default r;

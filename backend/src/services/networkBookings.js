// Health-services catalogue, slots and bookings (consultations, health checks, diagnostics, imaging,
// teleconsultation, home sample collection, vaccination, follow-ups) at public network providers.
//
// Every service and booking discloses the payer type: self-pay, discounted (synthetic VHC rate),
// employer-sponsored (eligible employees only) or insured-cashless (only when the insurer's network record
// covers this provider, the patient's plan and the service line on the booking date). A booking is never
// automatically covered by insurance. The synthetic booking fee is taken by a sandbox (test-mode)
// payment and posted once to the healthcare_booking_fee ledger.
import { db, newId, nextSeq } from '../db.js';
import { now, today } from '../clock.js';
import { addDays } from '../utils/dates.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { assertPaise } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { post } from './ledger.js';
import { policyStatusAt } from './lifecycle.js';
import { cashlessStatus, isPublicProvider } from './networkCore.js';

export const BOOKING_FEE_PAISE = 4900; // ₹49 synthetic sandbox booking fee
export const BOOKING_WINDOW_DAYS = 60;
export const COVERAGE_NOTE = 'A booking is not automatically covered by insurance. Insured-cashless applies only where your insurer\'s network covers this provider and service on the appointment date, and remains subject to the insurer\'s authorisation and your policy terms.';

export const SERVICE_CATEGORIES = {
  doctor_consultation: { label: 'Doctor consultation', networkService: 'opd', mode: 'in_person' },
  specialist_consultation: { label: 'Specialist consultation', networkService: 'opd', mode: 'in_person' },
  preventive_health_check: { label: 'Preventive health check', networkService: 'health_check', mode: 'in_person' },
  diagnostic_lab: { label: 'Diagnostic lab test', networkService: 'diagnostics', mode: 'in_person' },
  imaging: { label: 'Imaging', networkService: 'diagnostics', mode: 'in_person' },
  teleconsultation: { label: 'Teleconsultation', networkService: 'opd', mode: 'video' },
  home_sample_collection: { label: 'Home sample collection', networkService: 'diagnostics', mode: 'home' },
  vaccination: { label: 'Vaccination', networkService: 'opd', mode: 'in_person' },
  follow_up: { label: 'Follow-up visit', networkService: 'opd', mode: 'in_person' },
};
export const PAYER_TYPES = {
  self_pay: 'Self-pay — you pay the provider\'s listed price; not billed to insurance.',
  discounted: 'Discounted self-pay — synthetic VHC-negotiated rate; you pay the discounted price; not billed to insurance.',
  employer_sponsored: 'Employer-sponsored — paid by your employer\'s programme if you are eligible; not an insurance claim.',
  insured_cashless: 'Insured — cashless request to your insurer. Subject to the insurer\'s authorisation and policy terms; any amount not approved is payable by you.',
};
const BOOKING_FINAL = ['completed', 'cancelled', 'no_show'];
const s = (v) => String(v ?? '').trim();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Appointment instant (slots are local India time, UTC+05:30). */
export const slotInstant = (date, slot) => new Date(`${date}T${slot}:00+05:30`);

// ---------- catalogue ----------
export function cleanService(b, h, existing = {}) {
  const v = { ...existing };
  for (const [k, val] of Object.entries(b || {})) if (val !== undefined) v[k] = val;
  if (!SERVICE_CATEGORIES[v.category]) throw unprocessable('Select a service category');
  if (!s(v.name)) throw unprocessable('Service name is required');
  assertPaise(v.price, 'price');
  if (v.discountedPrice != null && v.discountedPrice !== '') {
    assertPaise(v.discountedPrice, 'discountedPrice');
    if (v.discountedPrice >= v.price) throw unprocessable('The discounted price must be lower than the listed price');
  }
  const sch = v.schedule || {};
  const days = (Array.isArray(sch.days) ? sch.days : [1, 2, 3, 4, 5, 6]).map(Number).filter((d) => d >= 0 && d <= 6);
  const start = isTime(sch.start) ? sch.start : '09:00', end = isTime(sch.end) ? sch.end : '17:00';
  const intervalMin = Math.max(10, Math.min(240, Number(sch.intervalMin) || 30));
  const capacity = Math.max(1, Math.min(50, Number(sch.capacity) || 1));
  if (toMin(end) <= toMin(start)) throw unprocessable('Schedule end time must be after the start time');
  if (v.branchId && !(h.branches || []).some((x) => x.id === v.branchId)) throw unprocessable('Unknown branch');
  return {
    hospitalId: h.id, branchId: v.branchId || null, category: v.category, name: s(v.name), description: s(v.description),
    inclusions: (Array.isArray(v.inclusions) ? v.inclusions : s(v.inclusions).split(',')).map(s).filter(Boolean),
    price: v.price, discountedPrice: v.discountedPrice == null || v.discountedPrice === '' ? null : v.discountedPrice,
    durationMin: Number(v.durationMin) || intervalMin, mode: SERVICE_CATEGORIES[v.category].mode,
    schedule: { days, start, end, intervalMin, capacity },
    sponsoredEmployerIds: (Array.isArray(v.sponsoredEmployerIds) ? v.sponsoredEmployerIds : []).filter((id) => db.get('employers', id)),
    active: v.active !== false, synthetic: true,
  };
}

export function createService(b, h, actor) {
  const svc = db.insert('providerServices', { id: newId('svc'), ...cleanService(b, h) });
  audit(actor, 'PROVIDER_SERVICE_CREATED', 'providerService', svc.id, { hospitalId: h.id, category: svc.category, price: svc.price });
  return svc;
}
export function updateService(svc, b, h, actor) {
  const before = { price: svc.price, discountedPrice: svc.discountedPrice, active: svc.active };
  Object.assign(svc, cleanService(b, h, svc));
  db.touch(svc);
  audit(actor, 'PROVIDER_SERVICE_UPDATED', 'providerService', svc.id, { before, after: { price: svc.price, discountedPrice: svc.discountedPrice, active: svc.active } });
  return svc;
}

/** Payer options a service can offer (insured-cashless is only confirmed per booking). */
export function payerOptions(svc) {
  const out = [{ type: 'self_pay', amount: svc.price, disclosure: PAYER_TYPES.self_pay }];
  if (svc.discountedPrice != null) out.push({ type: 'discounted', amount: svc.discountedPrice, disclosure: PAYER_TYPES.discounted });
  if (svc.sponsoredEmployerIds?.length) out.push({ type: 'employer_sponsored', amount: 0, disclosure: PAYER_TYPES.employer_sponsored, eligibility: 'Eligible employees of the sponsoring employer only' });
  out.push({ type: 'insured_cashless', amount: null, disclosure: PAYER_TYPES.insured_cashless, eligibility: 'Checked against your insurer\'s network record for this provider and service at booking' });
  return out;
}

export function serviceView(svc) {
  const h = db.get('hospitals', svc.hospitalId);
  return {
    id: svc.id, hospitalId: svc.hospitalId, hospitalName: h?.name, city: h?.city, providerType: h?.providerType || 'hospital', branchId: svc.branchId,
    category: svc.category, categoryLabel: SERVICE_CATEGORIES[svc.category]?.label, name: svc.name, description: svc.description, inclusions: svc.inclusions,
    price: svc.price, discountedPrice: svc.discountedPrice, durationMin: svc.durationMin, mode: svc.mode, schedule: svc.schedule, active: svc.active,
    sponsored: !!svc.sponsoredEmployerIds?.length, payerOptions: payerOptions(svc), bookingFee: BOOKING_FEE_PAISE, coverageNote: COVERAGE_NOTE, synthetic: true,
  };
}

export function listServices(q = {}) {
  const lc = (x) => s(x).toLowerCase();
  return db.find('providerServices', (svc) => {
    const h = db.get('hospitals', svc.hospitalId);
    if (!svc.active || !isPublicProvider(h)) return false;
    if (q.category && svc.category !== q.category) return false;
    if (q.hospitalId && svc.hospitalId !== q.hospitalId) return false;
    if (q.city && !lc(h.city).includes(lc(q.city))) return false;
    if (q.q && !`${svc.name} ${svc.description} ${h.name}`.toLowerCase().includes(lc(q.q))) return false;
    return true;
  }).map(serviceView).sort((a, b) => a.hospitalName.localeCompare(b.hospitalName) || a.price - b.price);
}

export function getPublicService(id) {
  const svc = db.get('providerServices', id);
  if (!svc || !svc.active || !isPublicProvider(db.get('hospitals', svc.hospitalId))) throw notFound('Service not found');
  return svc;
}

const activeAt = (serviceId, date, slot, exceptId) => db.find('healthBookings', (b) => b.serviceId === serviceId && b.date === date && b.slot === slot && !['cancelled'].includes(b.status) && b.id !== exceptId).length;

export function slotsFor(svc, date) {
  if (!isDate(date)) throw bad('date must be YYYY-MM-DD');
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (!svc.schedule.days.includes(dow)) return [];
  const out = [];
  const t = now();
  for (let m = toMin(svc.schedule.start); m + svc.schedule.intervalMin <= toMin(svc.schedule.end); m += svc.schedule.intervalMin) {
    const time = fromMin(m);
    const taken = activeAt(svc.id, date, time);
    const remaining = Math.max(0, svc.schedule.capacity - taken);
    out.push({ time, remaining, available: remaining > 0 && slotInstant(date, time) > t });
  }
  return out;
}

function assertSlot(svc, date, slot, exceptId) {
  if (!isDate(date) || !isTime(slot)) throw bad('Choose a date and time slot');
  if (date < today() || date > addDays(today(), BOOKING_WINDOW_DAYS)) throw unprocessable(`Appointments can be booked from today up to ${BOOKING_WINDOW_DAYS} days ahead`);
  const sl = slotsFor(svc, date).find((x) => x.time === slot);
  if (!sl) throw unprocessable('That time is not an available slot for this service');
  if (slotInstant(date, slot) <= now()) throw unprocessable('That slot has already started');
  if (activeAt(svc.id, date, slot, exceptId) >= svc.schedule.capacity) throw conflict('That slot is fully booked. Choose another time.');
}

/** Employer ids the user is enrolled with (corporate module records, if present). */
export function employerIdsFor(userId) {
  const u = db.get('users', userId);
  const ids = new Set([u?.employerId].filter(Boolean));
  for (const col of ['corporateMembers', 'corporateEmployees', 'employees', 'groupMembers']) {
    for (const m of db.find(col, (x) => x.userId === userId && (x.status == null || ['active', 'Active', 'enrolled', 'Enrolled'].includes(x.status)))) if (m.employerId) ids.add(m.employerId);
  }
  return [...ids];
}

function resolvePayer(svc, b, user, date) {
  const type = b.payerType || 'self_pay';
  if (!PAYER_TYPES[type]) throw bad('Choose how this appointment will be paid');
  const out = { payerType: type, payerDisclosure: PAYER_TYPES[type], coverageNote: COVERAGE_NOTE, policyId: null, insurerId: null, planId: null, network: null, employerId: null };
  if (type === 'self_pay') out.amountPayableAtProvider = svc.price;
  if (type === 'discounted') {
    if (svc.discountedPrice == null) throw unprocessable('No discounted rate is available for this service');
    out.amountPayableAtProvider = svc.discountedPrice;
  }
  if (type === 'employer_sponsored') {
    const emp = employerIdsFor(user.id).find((id) => svc.sponsoredEmployerIds?.includes(id));
    if (!emp) throw unprocessable('You are not eligible for employer sponsorship for this service. Choose self-pay instead.');
    out.employerId = emp;
    out.amountPayableAtProvider = 0;
  }
  if (type === 'insured_cashless') {
    const policy = db.get('policies', b.policyId);
    if (!policy || policy.userId !== user.id || policy.product !== 'health') throw notFound('Policy not found');
    if (policyStatusAt(policy, date) !== 'Active') throw unprocessable('Your policy is not active on the appointment date');
    const st = cashlessStatus({ hospitalId: svc.hospitalId, insurerId: policy.insurerId, planId: policy.planId, service: SERVICE_CATEGORIES[svc.category].networkService, date });
    if (!st.eligible) throw unprocessable(`Cashless is not available here for your plan and this service (${st.text}). You can book as self-pay and claim reimbursement where your policy allows.`);
    Object.assign(out, { policyId: policy.id, policyNumber: policy.policyNumber, insurerId: policy.insurerId, planId: policy.planId, network: { recordId: st.recordId, status: st.status, lastVerifiedAt: st.lastVerifiedAt, label: st.label } });
    out.amountPayableAtProvider = null; // decided by the insurer's authorisation
    out.estimatedPrice = svc.discountedPrice ?? svc.price;
  }
  return out;
}

export function createBooking(b, user) {
  const svc = getPublicService(b.serviceId);
  if (b.idempotencyKey) {
    const prior = db.findOne('healthBookings', (x) => x.userId === user.id && x.idempotencyKey === b.idempotencyKey);
    if (prior) return prior;
  }
  assertSlot(svc, b.date, b.slot);
  if (db.findOne('healthBookings', (x) => x.userId === user.id && x.serviceId === svc.id && x.date === b.date && x.slot === b.slot && x.status !== 'cancelled')) throw conflict('You already have this appointment');
  const payer = resolvePayer(svc, b, user, b.date);
  const h = db.get('hospitals', svc.hospitalId);
  const patientName = s(b.patientName) || user.name;
  const rec = db.insert('healthBookings', {
    id: newId('bkg'),
    reference: `BK-${today().replaceAll('-', '')}-${String(nextSeq('healthBooking')).padStart(5, '0')}`,
    idempotencyKey: b.idempotencyKey || null, userId: user.id, userName: user.name, patientName, patientRelation: s(b.patientRelation) || 'self',
    hospitalId: h.id, hospitalName: h.name, branchId: svc.branchId, serviceId: svc.id, serviceName: svc.name, category: svc.category, mode: svc.mode,
    date: b.date, slot: b.slot, listedPrice: svc.price, ...payer, bookingFee: BOOKING_FEE_PAISE,
    status: 'pending_payment', payment: { status: 'pending', mode: 'test' }, notes: s(b.notes).slice(0, 500) || null, rescheduleCount: 0,
    history: [{ at: now().toISOString(), status: 'pending_payment', by: user.name, role: user.role, note: `Booked ${svc.name} for ${b.date} ${b.slot} (${b.payerType || 'self_pay'})` }],
  });
  audit(user, 'HEALTH_BOOKING_CREATED', 'healthBooking', rec.id, { reference: rec.reference, payerType: rec.payerType, hospitalId: h.id });
  return rec;
}

/** Sandbox payment of the booking fee (no card data). Idempotent: the fee is posted once. */
export function payBookingFee(bk, user) {
  if (bk.status === 'cancelled') throw conflict('This booking was cancelled');
  if (bk.payment?.status === 'paid') return bk;
  if (bk.status !== 'pending_payment') throw conflict(`Booking is ${bk.status}`);
  const t = now().toISOString();
  const entry = post({
    ledger: 'healthcare_booking_fee', direction: 'credit', amount: bk.bookingFee, description: `Booking fee ${bk.reference} (${bk.serviceName})`,
    refType: 'healthBooking', refId: bk.id, reference: bk.reference, orgId: bk.hospitalId, userId: bk.userId, idempotencyKey: `booking-fee:${bk.id}`, mode: 'test',
  });
  bk.payment = { status: 'paid', mode: 'test', reference: `SBX-PAY-${bk.reference}`, amount: bk.bookingFee, paidAt: t, ledgerEntryId: entry.id, note: 'Simulated sandbox payment — no real money moved' };
  bk.status = 'confirmed';
  bk.history.push({ at: t, status: 'confirmed', by: user.name, role: user.role, note: 'Booking fee paid (sandbox)' });
  db.touch(bk);
  audit(user, 'HEALTH_BOOKING_CONFIRMED', 'healthBooking', bk.id, { reference: bk.reference, fee: bk.bookingFee });
  notify(bk.userId, 'Appointment confirmed', `${bk.serviceName} at ${bk.hospitalName} on ${bk.date} ${bk.slot}. ${COVERAGE_NOTE}`, { type: 'success', link: '/appointments' });
  for (const u of db.find('users', (x) => x.orgId === bk.hospitalId && ['hospital_admin', 'hospital_staff'].includes(x.role) && x.active)) {
    notify(u.id, 'New appointment', `${bk.reference}: ${bk.serviceName} on ${bk.date} ${bk.slot}`, { link: '/hospital?tab=appointments', dedupeKey: `booking-new:${bk.id}:${u.id}` });
  }
  return bk;
}

export function rescheduleBooking(bk, { date, slot }, user) {
  if (!['pending_payment', 'confirmed'].includes(bk.status)) throw conflict(`Booking is ${bk.status}`);
  if (slotInstant(bk.date, bk.slot) <= now()) throw conflict('Appointments cannot be rescheduled after the start time');
  if (bk.rescheduleCount >= 3) throw conflict('This booking has been rescheduled the maximum number of times; cancel and book again');
  const svc = db.get('providerServices', bk.serviceId);
  assertSlot(svc, date, slot, bk.id);
  if (bk.payerType === 'insured_cashless') {
    const policy = db.get('policies', bk.policyId);
    const st = cashlessStatus({ hospitalId: bk.hospitalId, insurerId: bk.insurerId, planId: bk.planId, service: SERVICE_CATEGORIES[bk.category].networkService, date });
    if (!st.eligible || policyStatusAt(policy, date) !== 'Active') throw unprocessable('Cashless is not available on the new date. Choose another date or cancel and book as self-pay.');
    bk.network = { recordId: st.recordId, status: st.status, lastVerifiedAt: st.lastVerifiedAt, label: st.label };
  }
  const from = `${bk.date} ${bk.slot}`;
  bk.date = date;
  bk.slot = slot;
  bk.rescheduleCount += 1;
  bk.history.push({ at: now().toISOString(), status: bk.status, by: user.name, role: user.role, note: `Rescheduled from ${from} to ${date} ${slot}` });
  db.touch(bk);
  audit(user, 'HEALTH_BOOKING_RESCHEDULED', 'healthBooking', bk.id, { from, to: `${date} ${slot}` });
  return bk;
}

export function cancelBooking(bk, { reason }, user) {
  if (BOOKING_FINAL.includes(bk.status)) throw conflict(`Booking is already ${bk.status.replace('_', ' ')}`);
  const byProvider = ['hospital_admin', 'hospital_staff', 'admin', 'operations_admin'].includes(user.role);
  if (byProvider && !s(reason)) throw bad('A reason is required when the provider cancels');
  const hoursAhead = (slotInstant(bk.date, bk.slot) - now()) / 3600000;
  const prev = bk.status;
  bk.status = 'cancelled';
  bk.cancellation = { by: user.name, role: user.role, at: now().toISOString(), reason: s(reason) || null };
  // Fee is refunded when the provider cancels or the customer cancels at least 4 hours ahead.
  if (bk.payment?.status === 'paid' && (byProvider || hoursAhead >= 4)) {
    post({
      ledger: 'healthcare_booking_fee', direction: 'debit', amount: bk.bookingFee, description: `Booking fee refund ${bk.reference}`,
      refType: 'healthBooking', refId: bk.id, reference: bk.reference, orgId: bk.hospitalId, userId: bk.userId, idempotencyKey: `booking-fee-refund:${bk.id}`, mode: 'test',
    });
    bk.payment.status = 'refunded';
    bk.payment.refundedAt = now().toISOString();
  }
  bk.history.push({ at: now().toISOString(), status: 'cancelled', by: user.name, role: user.role, note: `${s(reason) || 'Cancelled'}${bk.payment?.status === 'refunded' ? ' — booking fee refunded (sandbox)' : prev === 'confirmed' ? ' — booking fee not refundable (less than 4 hours notice)' : ''}` });
  db.touch(bk);
  audit(user, 'HEALTH_BOOKING_CANCELLED', 'healthBooking', bk.id, { reason: s(reason) || null, refunded: bk.payment?.status === 'refunded' });
  if (user.id !== bk.userId) notify(bk.userId, 'Appointment cancelled', `${bk.reference} at ${bk.hospitalName} was cancelled: ${s(reason)}`, { type: 'warning', link: '/appointments' });
  return bk;
}

export function completeBooking(bk, { outcome = 'completed', note }, user) {
  if (bk.status !== 'confirmed') throw conflict('Only confirmed appointments can be completed or marked no-show');
  if (!['completed', 'no_show'].includes(outcome)) throw bad('outcome must be completed or no_show');
  if (bk.date > today()) throw conflict('An appointment cannot be completed before its date');
  bk.status = outcome;
  bk.completedAt = now().toISOString();
  bk.history.push({ at: bk.completedAt, status: outcome, by: user.name, role: user.role, note: s(note) || (outcome === 'completed' ? 'Service provided' : 'Patient did not attend') });
  db.touch(bk);
  audit(user, 'HEALTH_BOOKING_COMPLETED', 'healthBooking', bk.id, { outcome });
  return bk;
}

/** Customer-safe and provider-safe booking view (no internal ledger ids beyond the payment summary). */
export const bookingView = (bk) => ({
  ...bk, categoryLabel: SERVICE_CATEGORIES[bk.category]?.label, startsAt: slotInstant(bk.date, bk.slot).toISOString(),
  canReschedule: ['pending_payment', 'confirmed'].includes(bk.status) && slotInstant(bk.date, bk.slot) > now(),
  canCancel: !BOOKING_FINAL.includes(bk.status),
});

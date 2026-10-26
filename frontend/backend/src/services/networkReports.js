// Hospital insurance-desk views and provider analytics (contract status, services provided, appointment
// completion, pre-authorisation turnaround and documentation quality).
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { diffDays } from '../utils/dates.js';
import { refreshContract } from './networkContracts.js';
import { isPublicProvider, stageOf } from './networkCore.js';

const hours = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const avg = (xs) => (xs.length ? Math.round((xs.reduce((t, x) => t + x, 0) / xs.length) * 10) / 10 : null);
const bp = (n, d) => (d ? Math.round((n * 10000) / d) : null);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '—';

/**
 * Insurance-desk row for a cashless/reimbursement claim at the hospital. Hospitals see claim number, member
 * first name, status, pre-auth amount/decision and timestamps — no diagnosis, policy financials or payout data.
 */
export const hospitalClaimRow = (c) => ({
  id: c.id, claimNumber: c.claimNumber, type: c.type, memberFirstName: firstName(c.memberName), status: c.status,
  admissionDate: c.admissionDate, dischargeDate: c.dischargeDate,
  preauth: c.preauth ? { decision: c.preauth.status, amount: c.preauth.amount ?? null, decidedAt: c.preauth.at, provisional: !!c.preauth.provisional } : null,
  finalBillSubmittedAt: c.finalBill?.at || null, createdAt: c.createdAt, updatedAt: c.updatedAt,
});

export const hospitalClaims = (hospitalId) => db.find('healthClaims', (c) => c.hospitalId === hospitalId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export function preauthTurnaround(claims) {
  const xs = claims.filter((c) => c.type === 'cashless' && c.preauth?.at).map((c) => hours(c.createdAt, c.preauth.at));
  return {
    decided: xs.length, pending: claims.filter((c) => c.status === 'Preauth Requested').length,
    approved: claims.filter((c) => c.preauth?.status === 'approved').length, rejected: claims.filter((c) => c.preauth?.status === 'rejected').length,
    avgHours: avg(xs), maxHours: xs.length ? Math.round(Math.max(...xs) * 10) / 10 : null,
  };
}

export function appointmentStats(bookings) {
  const t = today();
  const by = (st) => bookings.filter((b) => b.status === st).length;
  const due = bookings.filter((b) => b.date <= t && ['confirmed', 'completed', 'no_show'].includes(b.status));
  const completed = by('completed');
  const byCategory = {};
  for (const b of bookings.filter((x) => x.status === 'completed')) byCategory[b.category] = (byCategory[b.category] || 0) + 1;
  const byPayer = {};
  for (const b of bookings.filter((x) => x.status !== 'cancelled')) byPayer[b.payerType] = (byPayer[b.payerType] || 0) + 1;
  return {
    total: bookings.length, pendingPayment: by('pending_payment'), confirmed: by('confirmed'), completed, cancelled: by('cancelled'), noShow: by('no_show'),
    upcoming: bookings.filter((b) => b.status === 'confirmed' && b.date >= t).length,
    completionRateBp: bp(completed, due.length), servicesProvided: byCategory, byPayerType: byPayer,
  };
}

export function documentationQuality(claims) {
  const withRequests = claims.filter((c) => (c.documentRequests || []).length > 0).length;
  const docs = claims.map((c) => db.find('documents', (d) => d.entityId === c.id).length);
  return {
    claims: claims.length, claimsWithDocumentRequests: withRequests,
    completeFirstTimeBp: bp(claims.length - withRequests, claims.length), avgDocumentsPerClaim: avg(docs),
  };
}

export function hospitalReport(hospitalId) {
  const claims = hospitalClaims(hospitalId);
  const bookings = db.find('healthBookings', (b) => b.hospitalId === hospitalId);
  return { hospitalId, asOf: now().toISOString(), appointments: appointmentStats(bookings), preauth: preauthTurnaround(claims), documentation: documentationQuality(claims) };
}

/** Network analytics across providers (internal oversight). */
export function networkAnalytics() {
  const t = today();
  const providers = db.find('hospitals', (h) => !h.candidate).map((h) => {
    const contracts = db.find('providerContracts', (c) => c.hospitalId === h.id).map((c) => refreshContract(c));
    const live = contracts.find((c) => c.status === 'active');
    const latest = [...contracts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const r = hospitalReport(h.id);
    return {
      id: h.id, name: h.name, city: h.city, providerType: h.providerType || 'hospital', stage: stageOf(h), public: isPublicProvider(h), network: !!h.network,
      contract: live ? { reference: live.reference, status: 'active', daysToExpiry: diffDays(t, live.effectiveTo) } : latest ? { reference: latest.reference, status: latest.status, daysToExpiry: null } : { reference: null, status: 'none', daysToExpiry: null },
      appointments: r.appointments, preauth: r.preauth, documentation: r.documentation,
    };
  });
  const contracts = db.all('providerContracts');
  const statusCount = {};
  for (const c of contracts) statusCount[c.status] = (statusCount[c.status] || 0) + 1;
  const bookings = db.all('healthBookings');
  const claims = db.find('healthClaims', (c) => !!c.hospitalId);
  return {
    asOf: now().toISOString(),
    totals: {
      providers: providers.length, publicProviders: providers.filter((p) => p.public).length, candidates: db.find('hospitals', (h) => h.candidate).length,
      contractsByStatus: statusCount, appointments: appointmentStats(bookings), preauth: preauthTurnaround(claims), documentation: documentationQuality(claims),
      networkRecords: db.all('hospitalNetworks').length,
    },
    providers,
  };
}

// Employer HR dashboard (§29), wellness (§31), support requests, the sandbox insurer claims MIS feed and
// employer analytics (§42).
//
// PRIVACY: employers only ever receive aggregates about health and claims. Claims utilisation is
// reported as counts and amount BANDS, and only when the cohort has at least MIN_COHORT distinct
// claimants; any non-zero cell below MIN_COHORT is suppressed. No names, member ids, diagnoses,
// hospitals, dates of admission or claim references are included in employer-facing output. Wellness
// participation is reported the same way, and employee-raised support requests are counted, not shown.
import { db, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { addDays, diffDays, isValidDate } from '../utils/dates.js';
import { sum } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { activeContract, SANDBOX_LABEL } from './corporate.js';
import { openPolicies, policyStats, renewalsDue } from './corporateEnrolment.js';

export const MIN_COHORT = 5;
export const SUPPRESSED_NOTE = `Suppressed for privacy — fewer than ${MIN_COHORT} people in this group.`;

/** Small-cell suppression: non-zero counts below MIN_COHORT are withheld. */
export const cell = (n) => (n > 0 && n < MIN_COHORT ? { value: null, suppressed: true } : { value: n, suppressed: false });

const AMOUNT_BANDS = [
  [0, 'None'], [1, 'Under ₹1 lakh'], [100000_00, '₹1–5 lakh'], [500000_00, '₹5–10 lakh'], [1000000_00, '₹10–25 lakh'], [2500000_00, '₹25 lakh–₹1 crore'], [10000000_00, 'Above ₹1 crore'],
];
export function amountBand(paise) {
  let label = AMOUNT_BANDS[0][1];
  for (const [min, l] of AMOUNT_BANDS) if (paise >= min) label = l;
  return label;
}

// =====================================================================================
// Group claims MIS (sandbox insurer / TPA feed) — staff & insurer side only
// =====================================================================================
export const CLAIM_STATUSES = ['Intimated', 'Under Review', 'Approved', 'Settled', 'Rejected'];

export function recordGroupClaim(actor, body = {}) {
  const f = {};
  const policy = db.get('groupPolicies', body.groupPolicyId);
  if (!policy) f.groupPolicyId = 'Group policy not found.';
  const e = policy && db.findOne('groupEnrolments', (x) => x.groupPolicyId === policy.id && x.memberId === body.memberId && x.confirmedAt);
  if (policy && !e) f.memberId = 'The employee is not enrolled under this policy.';
  const lifeId = body.dependentId || 'self';
  const life = e?.lives.find((l) => l.lifeId === lifeId);
  if (e && !life) f.dependentId = 'This person is not a covered life on the enrolment.';
  const claimedAmount = Number(body.claimedAmount);
  if (!Number.isSafeInteger(claimedAmount) || claimedAmount <= 0) f.claimedAmount = 'Claimed amount must be a positive whole number of paise.';
  const status = body.status || 'Intimated';
  if (!CLAIM_STATUSES.includes(status)) f.status = `Status must be one of ${CLAIM_STATUSES.join(', ')}.`;
  const admissionDate = body.admissionDate || today();
  if (!isValidDate(admissionDate)) f.admissionDate = 'Enter a valid date.';
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  return tx(() => {
    const c = db.insert('groupClaims', {
      claimRef: `GCL-SBX-${String(nextSeq('groupClaim')).padStart(6, '0')}`, groupPolicyId: policy.id, employerId: policy.employerId, memberId: body.memberId, lifeId,
      relationship: life.relationship, claimedAmount, settledAmount: status === 'Settled' ? Number(body.settledAmount ?? claimedAmount) : 0, status, admissionDate,
      // Medical detail is held for the insurer/TPA view only and is never sent to the employer.
      diagnosis: String(body.diagnosis || '').slice(0, 200), source: 'Sandbox insurer claims MIS (simulated)', sandbox: true,
    });
    audit(actor, 'GROUP_CLAIM_RECORDED', 'groupClaim', c.id, { groupPolicyId: policy.id, status });
    return c;
  });
}

export function updateGroupClaim(actor, c, body = {}) {
  if (body.status && !CLAIM_STATUSES.includes(body.status)) throw unprocessable(`Status must be one of ${CLAIM_STATUSES.join(', ')}.`);
  return tx(() => {
    if (body.status) c.status = body.status;
    if (body.settledAmount != null) {
      const v = Number(body.settledAmount);
      if (!Number.isSafeInteger(v) || v < 0) throw unprocessable('Settled amount must be a whole number of paise.');
      c.settledAmount = v;
    }
    db.touch(c);
    audit(actor, 'GROUP_CLAIM_UPDATED', 'groupClaim', c.id, { status: c.status });
    return c;
  });
}

/** Employer-safe claims aggregate (k-anonymous). */
export function claimsAggregate(employerIds) {
  const claims = db.find('groupClaims', (c) => employerIds.includes(c.employerId));
  const claimants = new Set(claims.map((c) => `${c.memberId}:${c.lifeId}`)).size;
  const base = { minCohort: MIN_COHORT, source: 'Aggregated from the sandbox insurer claims feed', identifiable: false };
  if (claimants < MIN_COHORT) return { ...base, suppressed: true, note: claims.length ? SUPPRESSED_NOTE : 'No claims reported yet.', claimsReported: claims.length ? null : 0 };
  const byStatus = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, cell(claims.filter((c) => c.status === s).length)]));
  return {
    ...base, suppressed: false, claimsReported: claims.length, claimants: cell(claimants).value, byStatus,
    claimedAmountBand: amountBand(sum(claims, (c) => c.claimedAmount)), settledAmountBand: amountBand(sum(claims, (c) => c.settledAmount)),
  };
}

// =====================================================================================
// Wellness programmes (separately contracted, not insurance)
// =====================================================================================
export const WELLNESS_TYPES = {
  health_screening: 'Health screening', annual_checkup_camp: 'Annual check-up camp', telehealth: 'Telehealth', eap: 'Employee assistance programme (EAP)',
  health_education: 'Health education', vaccination_drive: 'Vaccination drive',
};
export const WELLNESS_STATUSES = ['Scheduled', 'Open', 'Completed', 'Cancelled'];
export const WELLNESS_CONSENT_TEXT = 'I choose to take part in this wellness programme. I understand it is a separate service from my group health insurance, that my participation is voluntary, and that my employer will only see total participation numbers — never my individual results.';

export function createProgramme(actor, emp, body = {}) {
  const f = {};
  if (!WELLNESS_TYPES[body.type]) f.type = 'Select a programme type.';
  const name = String(body.name || '').trim().slice(0, 120) || WELLNESS_TYPES[body.type];
  if (!isValidDate(body.startDate)) f.startDate = 'Enter a valid start date.';
  if (!isValidDate(body.endDate) || (isValidDate(body.startDate) && body.endDate < body.startDate)) f.endDate = 'End must be on or after the start.';
  const capacity = body.capacity == null || body.capacity === '' ? null : Number(body.capacity);
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000)) f.capacity = 'Capacity must be a whole number.';
  const fee = body.feePerParticipant == null || body.feePerParticipant === '' ? 0 : Number(body.feePerParticipant);
  if (!Number.isSafeInteger(fee) || fee < 0) f.feePerParticipant = 'Fee must be a whole number of paise.';
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  const contract = activeContract(emp.id);
  if (!contract?.services.includes('wellness')) throw conflict('Wellness is a separately contracted service. Add it to an active corporate contract first.');
  return tx(() => {
    const p = db.insert('wellnessProgrammes', {
      employerId: emp.id, contractId: contract.id, type: body.type, typeLabel: WELLNESS_TYPES[body.type], name, description: String(body.description || '').slice(0, 1000),
      provider: String(body.provider || '').trim().slice(0, 120) || 'Sandbox Wellness Partner (Synthetic)', location: String(body.location || '').slice(0, 120) || 'Online / on-site',
      startDate: body.startDate, endDate: body.endDate, capacity, feePerParticipant: fee, status: 'Open', separateFromInsurance: true, sandbox: true, createdBy: actor.name,
    });
    audit(actor, 'WELLNESS_PROGRAMME_CREATED', 'wellnessProgramme', p.id, { employerId: emp.id, type: p.type });
    return p;
  });
}

export function setProgrammeStatus(actor, p, status) {
  if (!WELLNESS_STATUSES.includes(status)) throw unprocessable(`Status must be one of ${WELLNESS_STATUSES.join(', ')}.`);
  return tx(() => {
    const from = p.status;
    p.status = status;
    db.touch(p);
    audit(actor, 'WELLNESS_PROGRAMME_STATUS', 'wellnessProgramme', p.id, { from, to: status });
    return p;
  });
}

const optedIn = (programmeId) => db.find('wellnessEnrolments', (w) => w.programmeId === programmeId && w.status === 'Opted in');

/** Employer view: programme details + aggregate participation only. */
export function programmeView(p, { forEmployer = true } = {}) {
  const n = optedIn(p.id).length;
  // Seats-left would reveal exact participation, so employees only learn whether the programme is full.
  return forEmployer ? { ...p, participation: cell(n) } : { ...p, full: !!p.capacity && n >= p.capacity };
}

export function announceProgramme(actor, p) {
  if (!['Open', 'Scheduled'].includes(p.status)) throw conflict(`Programme is ${p.status}`);
  return tx(() => {
    let sent = 0;
    for (const m of db.find('groupMembers', (x) => x.employerId === p.employerId && x.status === 'Active' && x.userId)) {
      if (notify(m.userId, `Wellness: ${p.name}`, `${p.typeLabel} from ${p.startDate} to ${p.endDate} (${p.location}). Participation is voluntary and separate from your insurance.`, { link: '/benefits', dedupeKey: `wellness-announce:${p.id}:${m.id}` })) sent += 1;
    }
    p.announcedAt = now().toISOString();
    audit(actor, 'WELLNESS_PROGRAMME_ANNOUNCED', 'wellnessProgramme', p.id, { recipients: sent });
    return { sent };
  });
}

export function optIn(user, m, p, { consent } = {}) {
  if (p.employerId !== m.employerId) throw notFound('Programme not found');
  if (m.status !== 'Active') throw conflict('Only current employees can join wellness programmes');
  if (consent !== true) throw unprocessable('Please confirm your consent to take part.', { fields: { consent: 'Consent is required.' } });
  if (!['Open', 'Scheduled'].includes(p.status) || p.endDate < today()) throw conflict('This programme is not open for registration');
  const existing = db.findOne('wellnessEnrolments', (w) => w.programmeId === p.id && w.memberId === m.id);
  if (existing?.status === 'Opted in') return existing;
  if (p.capacity && optedIn(p.id).length >= p.capacity) throw conflict('This programme is full');
  return tx(() => {
    const rec = existing || db.insert('wellnessEnrolments', { programmeId: p.id, employerId: p.employerId, memberId: m.id, userId: user.id });
    Object.assign(rec, { status: 'Opted in', consent: { given: true, at: now().toISOString(), text: WELLNESS_CONSENT_TEXT }, withdrawnAt: null });
    db.touch(rec);
    audit(user, 'WELLNESS_OPT_IN', 'wellnessEnrolment', rec.id, { programmeId: p.id });
    return rec;
  });
}

export function optOut(user, m, p) {
  const rec = db.findOne('wellnessEnrolments', (w) => w.programmeId === p.id && w.memberId === m.id && w.status === 'Opted in');
  if (!rec) throw notFound('You are not registered for this programme');
  return tx(() => {
    Object.assign(rec, { status: 'Withdrawn', withdrawnAt: now().toISOString() });
    db.touch(rec);
    audit(user, 'WELLNESS_OPT_OUT', 'wellnessEnrolment', rec.id, { programmeId: p.id });
    return rec;
  });
}

// =====================================================================================
// Support requests
// =====================================================================================
export const SUPPORT_CATEGORIES = { enrolment: 'Enrolment', dependents: 'Dependents', certificate: 'Certificate', billing: 'Billing & invoices', claims_help: 'Claims help', wellness: 'Wellness', other: 'Other' };

export function raiseSupport(actor, { employerId, memberId = null, source }, body = {}) {
  const f = {};
  if (!SUPPORT_CATEGORIES[body.category]) f.category = 'Select a category.';
  const subject = String(body.subject || '').trim().slice(0, 120);
  if (subject.length < 3) f.subject = 'Enter a short subject.';
  const message = String(body.message || '').trim().slice(0, 2000);
  if (message.length < 5) f.message = 'Describe what you need help with.';
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  return tx(() => {
    const r = db.insert('corporateSupportRequests', {
      reference: `CSR-${String(nextSeq('corpSupport')).padStart(6, '0')}`, employerId, memberId, source, raisedById: actor.id, raisedByName: actor.name,
      category: body.category, subject, message, status: 'Open', responses: [],
    });
    audit(actor, 'CORPORATE_SUPPORT_RAISED', 'corporateSupportRequest', r.id, { source, category: r.category });
    return r;
  });
}

export function respondSupport(actor, r, { message, status } = {}) {
  const text = String(message || '').trim().slice(0, 2000);
  if (!text) throw unprocessable('Enter a response.', { fields: { message: 'Required.' } });
  if (status && !['Open', 'In Progress', 'Resolved'].includes(status)) throw unprocessable('Invalid status.');
  return tx(() => {
    r.responses.push({ at: now().toISOString(), by: actor.name, role: actor.role, message: text });
    r.status = status || 'In Progress';
    db.touch(r);
    audit(actor, 'CORPORATE_SUPPORT_RESPONDED', 'corporateSupportRequest', r.id, { status: r.status });
    const target = r.source === 'employee' ? db.get('groupMembers', r.memberId)?.userId : r.raisedById;
    notify(target, `Update on ${r.reference}`, `${r.subject}: ${r.status}`, { link: r.source === 'employee' ? '/benefits' : '/corporate' });
    return r;
  });
}

/** Employer view: their own requests in full, employee-raised requests as counts only. */
export function supportForEmployer(employerId) {
  const all = db.find('corporateSupportRequests', (r) => r.employerId === employerId);
  const emp = all.filter((r) => r.source === 'employee');
  const byCategory = Object.fromEntries(Object.keys(SUPPORT_CATEGORIES).map((k) => [k, emp.filter((r) => r.category === k).length]));
  return {
    requests: all.filter((r) => r.source === 'employer').reverse(),
    employeeRequests: { total: emp.length, open: emp.filter((r) => r.status !== 'Resolved').length, byCategory, note: 'Employee requests are handled by VHC support; only totals are shown to the employer.' },
  };
}

// =====================================================================================
// HR dashboard & analytics
// =====================================================================================
export function hrDashboard(emp) {
  const members = db.find('groupMembers', (m) => m.employerId === emp.id);
  const active = members.filter((m) => m.status === 'Active');
  const policies = openPolicies(emp.id);
  const policyRows = policies.map((p) => ({ id: p.id, policyNumber: p.policyNumber, productName: p.productName, insurerName: p.insurerName, sumInsured: p.terms.sumInsured, familyLabel: p.terms.familyLabel, startDate: p.startDate, endDate: p.endDate, enrolmentWindow: p.enrolmentWindow, stats: policyStats(p) }));
  const eligible = sum(policyRows, (p) => p.stats.eligible);
  const enrolled = sum(policyRows, (p) => p.stats.enrolled);
  const pendingEnd = db.find('endorsements', (e) => e.employerId === emp.id && e.status === 'Pending Insurer');
  const invoices = db.find('corporateInvoices', (i) => i.employerId === emp.id);
  const debitOpen = invoices.filter((i) => i.direction === 'debit' && i.status === 'Issued');
  const programmes = db.find('wellnessProgrammes', (p) => p.employerId === emp.id && p.status !== 'Cancelled');
  const support = supportForEmployer(emp.id);
  return {
    employer: { id: emp.id, name: emp.name, status: emp.status, sandbox: !!emp.sandbox },
    asOf: today(),
    totals: {
      employeesOnRoster: active.length, eligibleEmployees: eligible, enrolledEmployees: enrolled,
      pendingConfirmation: sum(policyRows, (p) => p.stats.pending), coveredDependents: sum(policyRows, (p) => p.stats.coveredDependents), coveredLives: sum(policyRows, (p) => p.stats.coveredLives),
      activeGroupPolicies: policyRows.length, enrolmentCompletionBp: eligible ? Math.round((enrolled * 10000) / eligible) : 0,
      linkedEmployeeAccounts: active.filter((m) => m.userId).length,
    },
    policies: policyRows,
    upcomingRenewals: renewalsDue([emp.id], 90),
    pendingEndorsements: { count: pendingEnd.length, items: pendingEnd.slice(-10).reverse().map((e) => ({ id: e.id, endorsementNumber: e.endorsementNumber, type: e.type, reason: e.reason, effectiveDate: e.effectiveDate, total: e.total, direction: e.direction, status: e.status })) },
    invoices: {
      outstandingCount: debitOpen.length, outstandingAmount: sum(debitOpen, (i) => i.total), overdueCount: debitOpen.filter((i) => i.dueDate < today()).length,
      paidCount: invoices.filter((i) => i.status === 'Paid').length, paidAmount: sum(invoices.filter((i) => i.status === 'Paid'), (i) => i.total),
      recent: invoices.slice(-5).reverse().map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, typeLabel: i.typeLabel, total: i.total, status: i.status, dueDate: i.dueDate, direction: i.direction })),
    },
    wellness: { programmes: programmes.map((p) => ({ id: p.id, name: p.name, typeLabel: p.typeLabel, status: p.status, startDate: p.startDate, endDate: p.endDate, participation: cell(optedIn(p.id).length) })), minCohort: MIN_COHORT },
    support: { employerOpen: support.requests.filter((r) => r.status !== 'Resolved').length, employerTotal: support.requests.length, employee: support.employeeRequests },
    claims: claimsAggregate([emp.id]),
    privacy: `Aggregates only. Claims and wellness figures are shown when at least ${MIN_COHORT} people are in the group; no individual medical or claim information is shared with employers.`,
    label: emp.sandbox ? SANDBOX_LABEL : null,
  };
}

export function employerAnalytics(emp) {
  const members = db.find('groupMembers', (m) => m.employerId === emp.id);
  const active = members.filter((m) => m.status === 'Active');
  const policies = openPolicies(emp.id);
  const stats = policies.map(policyStats);
  const eligible = sum(stats, (s) => s.eligible);
  const enrolled = sum(stats, (s) => s.enrolled);
  const renewals = renewalsDue([emp.id], 120);
  const programmes = db.find('wellnessProgrammes', (p) => p.employerId === emp.id);
  const wellnessParticipants = new Set(db.find('wellnessEnrolments', (w) => w.employerId === emp.id && w.status === 'Opted in').map((w) => w.memberId)).size;
  const support = db.find('corporateSupportRequests', (r) => r.employerId === emp.id);
  const since = addDays(today(), -30);
  const contract = activeContract(emp.id);
  return {
    employerId: emp.id, employerName: emp.name, status: emp.status,
    enrolment: { eligible, enrolled, completionBp: eligible ? Math.round((enrolled * 10000) / eligible) : 0, pending: sum(stats, (s) => s.pending), rejected: sum(stats, (s) => s.rejected) },
    renewal: {
      activePolicies: policies.length, nextRenewal: renewals[0] || null,
      status: !policies.length ? 'No active policy' : renewals.length ? (renewals[0].renewalQuote ? 'Renewal quoted' : 'Renewal due') : 'In force',
      contractEnds: contract?.endDate || null, contractDaysLeft: contract ? diffDays(today(), contract.endDate) : null,
    },
    adoption: {
      rosterActive: active.length, linkedAccounts: active.filter((m) => m.userId).length,
      linkedBp: active.length ? Math.round((active.filter((m) => m.userId).length * 10000) / active.length) : 0,
      coveredDependents: sum(stats, (s) => s.coveredDependents), dependentsPerEnrolledBp: enrolled ? Math.round((sum(stats, (s) => s.coveredDependents) * 10000) / enrolled) : 0,
      wellnessProgrammes: programmes.length, wellnessParticipants: cell(wellnessParticipants),
    },
    utilisation: claimsAggregate([emp.id]),
    support: { total: support.length, open: support.filter((r) => r.status !== 'Resolved').length, last30Days: support.filter((r) => r.createdAt.slice(0, 10) >= since).length, employeeRaised: support.filter((r) => r.source === 'employee').length },
  };
}

// Super-admin command centre (§41) and retention intelligence (§36).
//
// Every number is computed server-side from the live collections. Collections owned by modules that may
// not exist yet (leads, hospitalNetworks, providerContracts, employers, groupMembers, grievances,
// supportTickets, fraudFlags) are read defensively: a missing collection simply counts as zero.
// Facilitated premium is reported separately from VHC earned revenue (commission + fees only).
import { load } from '../db.js';
import { now, today } from '../clock.js';
import { addDays, diffDays } from '../utils/dates.js';
import { sum } from '../utils/money.js';
import { APP_STATUS, policyStatusAt } from './lifecycle.js';
import { LEDGERS } from './ledger.js';
import { reconciliation, FACILITATED_NOTE } from './enterpriseFinance.js';
import { slaView } from './enterpriseSupport.js';

const all = (c) => load()[c] || []; // never creates another module's collection
const monthOf = (iso) => (iso || '').slice(0, 7);
const REVENUE = Object.entries(LEDGERS).filter(([, v]) => v.vhcRevenue).map(([k]) => k);
const OPEN_HEALTH = (c) => !['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status);
const OPEN_LIFE = (c) => !['Settled', 'Rejected'].includes(c.status);
const isOpenStatus = (s) => !/(closed|resolved|rejected|settled|withdrawn|completed|cancelled)/i.test(String(s || ''));

export function lastMonths(n = 12) {
  const [y, m] = today().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}
const countByMonth = (rows, at, months) => months.map((mo) => rows.filter((r) => monthOf(at(r)) === mo).length);
const sumByMonth = (rows, at, val, months) => months.map((mo) => sum(rows.filter((r) => monthOf(at(r)) === mo), val));
const tally = (rows, f) => rows.reduce((m, r) => { const k = f(r) || 'Unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});

function kpis(mode) {
  const t = today();
  const policies = all('policies');
  const apps = all('applications');
  const ledger = all('ledgerEntries').filter((e) => (e.mode || 'test') === mode);
  const net = (k) => sum(ledger.filter((e) => e.ledger === k), (e) => (e.direction === 'credit' ? e.amount : -e.amount));
  const submitted = apps.filter((a) => a.submittedAt);
  const issued = apps.filter((a) => a.status === APP_STATUS.ISSUED);
  const hc = all('healthClaims');
  const lc = all('lifeClaims');
  const settled = hc.filter((c) => c.status === 'Settled');
  const tat = settled.map((c) => {
    const end = [...(c.timeline || [])].reverse().find((x) => x.status === 'Settled')?.at;
    return end ? diffDays(c.createdAt.slice(0, 10), end.slice(0, 10)) : null;
  }).filter((x) => x != null);
  const tickets = all('supportTickets');
  const openTickets = tickets.filter((x) => !['resolved', 'closed'].includes(x.status));
  const responded = tickets.filter((x) => x.sla?.firstRespondedAt);
  const leads = all('leads');
  const employers = all('employers');
  const hospitals = all('hospitals');
  const insurers = all('insurers');
  return {
    business: [
      { key: 'policiesIssued', label: 'Policies issued', value: policies.length, unit: 'count' },
      { key: 'activePolicies', label: 'Active policies', value: policies.filter((p) => ['Active', 'Grace Period'].includes(policyStatusAt(p, t))).length, unit: 'count' },
      { key: 'premiumFacilitated', label: 'Premium facilitated (held for insurers)', value: sum(ledger.filter((e) => e.ledger === 'premium_facilitated' && e.direction === 'credit'), (e) => e.amount), unit: 'money', note: FACILITATED_NOTE },
      { key: 'vhcRevenue', label: 'VHC earned revenue', value: sum(REVENUE, net), unit: 'money', note: 'Commission + corporate, booking and hospital service fees only' },
      { key: 'customers', label: 'Customers', value: all('users').filter((u) => u.role === 'customer').length, unit: 'count' },
      { key: 'conversion', label: 'Proposal → issued conversion', value: submitted.length ? Math.round((issued.length / submitted.length) * 10000) : 0, unit: 'bp' },
    ],
    partners: [
      { key: 'activeInsurers', label: 'Active insurers', value: insurers.filter((i) => i.status === 'Active').length, unit: 'count', note: `${insurers.filter((i) => i.status === 'Active' && i.sandbox).length} sandbox` },
      { key: 'prospects', label: 'Insurer prospects (no agreement)', value: insurers.filter((i) => i.status === 'Prospect').length, unit: 'count' },
      { key: 'networkHospitals', label: 'Network hospitals', value: hospitals.filter((h) => h.network && h.active !== false).length, unit: 'count' },
      { key: 'providerContracts', label: 'Active provider contracts', value: all('providerContracts').filter((c) => /active/i.test(c.status || '')).length, unit: 'count' },
      { key: 'tpas', label: 'TPAs', value: all('tpas').length, unit: 'count' },
      { key: 'employers', label: 'Corporate clients', value: employers.length, unit: 'count' },
    ],
    claims: [
      { key: 'openHealth', label: 'Open health claims', value: hc.filter(OPEN_HEALTH).length, unit: 'count' },
      { key: 'openLife', label: 'Open life claims', value: lc.filter(OPEN_LIFE).length, unit: 'count' },
      { key: 'settled', label: 'Health claims settled', value: settled.length, unit: 'count' },
      { key: 'tat', label: 'Average settlement time', value: tat.length ? Math.round(sum(tat) / tat.length) : null, unit: 'days' },
      { key: 'fraudFlags', label: 'Open fraud-review flags', value: all('fraudFlags').filter((f) => isOpenStatus(f.status)).length, unit: 'count' },
      { key: 'grievances', label: 'Open grievances', value: all('grievances').filter((g) => isOpenStatus(g.status)).length, unit: 'count' },
    ],
    sales: [
      { key: 'leads', label: 'Leads', value: leads.length, unit: 'count' },
      { key: 'leadsConverted', label: 'Leads converted', value: leads.filter((l) => /convert|won/i.test(l.status || l.stage || '')).length, unit: 'count' },
      { key: 'quotes', label: 'Quotes', value: all('quotes').length, unit: 'count' },
      { key: 'pipeline', label: 'Proposals in progress', value: apps.filter((a) => ![APP_STATUS.ISSUED, APP_STATUS.REJECTED, APP_STATUS.DECLINED, APP_STATUS.INSURER_DECLINED].includes(a.status)).length, unit: 'count' },
      { key: 'groupMembers', label: 'Corporate members enrolled', value: all('groupMembers').length, unit: 'count' },
    ],
    experience: [
      { key: 'openTickets', label: 'Open support tickets', value: openTickets.length, unit: 'count' },
      { key: 'slaBreaches', label: 'Tickets breaching SLA', value: openTickets.filter((x) => { const s = slaView(x); return s.firstResponseBreached || s.resolutionBreached; }).length, unit: 'count' },
      { key: 'firstResponse', label: 'First response within SLA', value: responded.length ? Math.round((responded.filter((x) => !slaView(x).firstResponseBreached).length / responded.length) * 10000) : null, unit: 'bp' },
      { key: 'refundsPending', label: 'Refunds pending', value: all('refunds').filter((r) => ['pending', 'processing'].includes(r.status)).length, unit: 'count' },
      { key: 'paymentFailures', label: 'Payment failures (30 days)', value: all('payments').filter((p) => ['failed', 'expired'].includes(p.status) && (p.createdAt || '') >= addDays(t, -30)).length, unit: 'count' },
    ],
  };
}

function charts(mode, recon) {
  const months = lastMonths(12);
  const policies = all('policies');
  const ledger = all('ledgerEntries').filter((e) => (e.mode || 'test') === mode && e.direction === 'credit');
  const apps = all('applications');
  const hc = all('healthClaims');
  const lc = all('lifeClaims');
  const hospitals = all('hospitals').filter((h) => h.network);
  const contracts = all('providerContracts');
  const tickets = all('supportTickets');
  const members = all('groupMembers');
  const cumulative = (arr) => arr.reduce((out, v, i) => [...out, (out[i - 1] || 0) + v], []);
  const baseHosp = hospitals.filter((h) => monthOf(h.createdAt) < months[0]).length;
  const issuedAt = (p) => p.issuedAt || p.createdAt;
  const cancelledAt = (p) => (p.terminatedOn && !p.deathBenefitSettled ? p.terminatedOn : null);
  const byInsurer = tally(policies, (p) => p.insurerName || 'Unassigned');
  const claimStatus = { ...tally(hc, (c) => `Health: ${c.status}`), ...tally(lc, (c) => `Life: ${c.status}`) };
  const funnel = [
    ['Quotes', all('quotes').length],
    ['Proposals started', apps.length],
    ['Submitted', apps.filter((a) => a.submittedAt).length],
    ['Offer accepted', apps.filter((a) => a.offer?.acceptedAt || [APP_STATUS.ACCEPTED, APP_STATUS.ISSUANCE_PENDING, APP_STATUS.ISSUED, APP_STATUS.INSURER_DECLINED].includes(a.status)).length],
    ['Paid', apps.filter((a) => [APP_STATUS.ISSUANCE_PENDING, APP_STATUS.ISSUED, APP_STATUS.INSURER_DECLINED].includes(a.status)).length],
    ['Issued', apps.filter((a) => a.status === APP_STATUS.ISSUED).length],
  ];
  return [
    { id: 'issuance', title: 'Policy issuance trend', desc: 'Policies issued by insurers per month', kind: 'line', unit: 'count', labels: months, series: [{ name: 'Policies issued', values: countByMonth(policies, issuedAt, months) }] },
    { id: 'premium', title: 'Facilitated premium trend', desc: `Premium collected and held for insurers per month (${mode} mode). ${FACILITATED_NOTE}`, kind: 'line', unit: 'money', labels: months, series: [{ name: 'Premium facilitated', values: sumByMonth(ledger.filter((e) => e.ledger === 'premium_facilitated'), (e) => e.postedAt, (e) => e.amount, months) }] },
    { id: 'revenue', title: 'VHC earned revenue trend', desc: 'VHC commission and service/booking fees only — premiums are excluded', kind: 'line', unit: 'money', labels: months, series: [{ name: 'Earned revenue', values: sumByMonth(ledger.filter((e) => REVENUE.includes(e.ledger)), (e) => e.postedAt, (e) => e.amount, months) }] },
    { id: 'byInsurer', title: 'Policies by insurer', desc: 'Issued policies grouped by the issuing insurer', kind: 'hbar', unit: 'count', labels: Object.keys(byInsurer), series: [{ name: 'Policies', values: Object.values(byInsurer) }] },
    { id: 'acquisition', title: 'Customer acquisition', desc: 'New customer accounts per month', kind: 'bar', unit: 'count', labels: months, series: [{ name: 'New customers', values: countByMonth(all('users').filter((u) => u.role === 'customer'), (u) => u.createdAt, months) }] },
    { id: 'funnel', title: 'Conversion funnel', desc: 'Quotes through to issued policies (all time)', kind: 'funnel', unit: 'count', labels: funnel.map((f) => f[0]), series: [{ name: 'Count', values: funnel.map((f) => f[1]) }] },
    { id: 'claims', title: 'Claims status distribution', desc: 'Current status of health and life claims', kind: 'hbar', unit: 'count', labels: Object.keys(claimStatus), series: [{ name: 'Claims', values: Object.values(claimStatus) }] },
    { id: 'hospitals', title: 'Hospital partnership growth', desc: 'Cumulative network hospitals and provider contracts', kind: 'line', unit: 'count', labels: months, series: [{ name: 'Network hospitals', values: cumulative(countByMonth(hospitals, (h) => h.createdAt, months)).map((v) => v + baseHosp) }, { name: 'Provider contracts', values: cumulative(countByMonth(contracts, (c) => c.createdAt, months)) }] },
    { id: 'corporate', title: 'Corporate enrolment trend', desc: 'Employees/dependants enrolled under group policies per month', kind: 'bar', unit: 'count', labels: months, series: [{ name: 'Members enrolled', values: countByMonth(members, (m) => m.enrolledAt || m.createdAt, months) }] },
    { id: 'renewals', title: 'Renewals vs cancellations', desc: 'Renewal policies issued vs policies terminated (excluding death-claim settlements)', kind: 'bar', unit: 'count', labels: months, series: [{ name: 'Renewals', values: countByMonth(policies.filter((p) => p.renewalOf), issuedAt, months) }, { name: 'Cancellations', values: countByMonth(policies.filter(cancelledAt), cancelledAt, months) }] },
    { id: 'reconciliation', title: 'Payment reconciliation exceptions', desc: `Open exceptions by type (${mode} mode)`, kind: 'hbar', unit: 'count', labels: Object.keys(recon.byType).map((k) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())), series: [{ name: 'Exceptions', values: Object.values(recon.byType) }] },
    { id: 'sla', title: 'Support SLA trend', desc: 'Tickets raised per month that met or breached the first-response SLA', kind: 'bar', unit: 'count', labels: months, series: [
      { name: 'Within SLA', values: months.map((mo) => tickets.filter((x) => monthOf(x.createdAt) === mo && !slaView(x).firstResponseBreached).length) },
      { name: 'Breached', values: months.map((mo) => tickets.filter((x) => monthOf(x.createdAt) === mo && slaView(x).firstResponseBreached).length) },
    ] },
  ];
}

const mask = (name = '') => name.split(/\s+/).filter(Boolean).map((w, i) => (i === 0 ? w : `${w[0]}.`)).join(' ');

/**
 * Retention intelligence: explainable lists only. Items are ordered by date/urgency — never by premium
 * size or commission — and each carries the rule that put it on the list and a suggested service action.
 */
export function retention() {
  const t = today();
  const users = new Map(all('users').map((u) => [u.id, u]));
  const who = (id) => ({ userId: id, customer: mask(users.get(id)?.name || 'Customer') });
  const renewals = all('policies').filter((p) => p.product === 'health' && !p.renewedBy && !p.terminatedOn && diffDays(t, p.endDate) >= 0 && diffDays(t, p.endDate) <= 45)
    .map((p) => ({ ...who(p.userId), ref: p.policyNumber, link: `/policies/${p.id}`, due: p.endDate, reason: `Cover ends on ${p.endDate} (${diffDays(t, p.endDate)} days); no renewal started`, action: 'Send a renewal reminder with the current terms; do not change the premium shown.' }))
    .sort((a, b) => a.due.localeCompare(b.due));
  const incomplete = all('applications').filter((a) => [APP_STATUS.DRAFT, APP_STATUS.MIR, APP_STATUS.APPROVED, APP_STATUS.ACCEPTED].includes(a.status) && diffDays((a.updatedAt || a.createdAt).slice(0, 10), t) >= 3)
    .map((a) => ({ ...who(a.userId), ref: a.applicationNumber, due: (a.updatedAt || a.createdAt).slice(0, 10), reason: `${a.status} — no activity for ${diffDays((a.updatedAt || a.createdAt).slice(0, 10), t)} days`, action: a.status === APP_STATUS.MIR ? 'Remind the customer which information is outstanding.' : a.status === APP_STATUS.APPROVED ? 'Remind the customer the offer is waiting for acceptance.' : a.status === APP_STATUS.ACCEPTED ? 'Offer accepted but unpaid — check for a payment problem.' : 'Offer help completing the proposal.' }))
    .sort((a, b) => a.due.localeCompare(b.due));
  const payments = all('payments');
  const failures = payments.filter((p) => ['failed', 'expired'].includes(p.status) && (p.createdAt || '') >= addDays(t, -30) && !payments.some((x) => x.targetKey === p.targetKey && x.status === 'success'))
    .map((p) => ({ ...who(p.userId), ref: p.reference, due: (p.createdAt || '').slice(0, 10), reason: `${p.status === 'expired' ? 'Timed out' : 'Failed'}${p.failureReason ? `: ${p.failureReason}` : ''}; no later successful payment`, action: 'Contact the customer to help retry; never ask for card details or OTPs.' }))
    .sort((a, b) => b.due.localeCompare(a.due));
  const longClaims = all('healthClaims').filter((c) => OPEN_HEALTH(c) && diffDays(c.createdAt.slice(0, 10), t) >= 15)
    .map((c) => ({ ...who(c.userId), ref: c.claimNumber, due: c.createdAt.slice(0, 10), reason: `Open for ${diffDays(c.createdAt.slice(0, 10), t)} days (status ${c.status})`, action: 'Proactively update the customer on the next step and who is acting.' }))
    .sort((a, b) => a.due.localeCompare(b.due));
  const activeHolders = new Set(all('policies').filter((p) => ['Active', 'Grace Period'].includes(policyStatusAt(p, t))).map((p) => p.userId));
  const inactive = all('users').filter((u) => u.role === 'customer' && u.active && activeHolders.has(u.id) && diffDays((u.lastLoginAt || u.createdAt).slice(0, 10), t) >= 90)
    .map((u) => ({ ...who(u.id), ref: u.customerId, due: (u.lastLoginAt || u.createdAt).slice(0, 10), reason: `Has active cover but no sign-in for ${diffDays((u.lastLoginAt || u.createdAt).slice(0, 10), t)} days`, action: 'Send a service check-in (policy documents, nominee and contact details).' }))
    .sort((a, b) => a.due.localeCompare(b.due));
  return {
    principle: 'Lists are explainable and ordered by date or urgency only — never by premium size, commission or insurer — and suggest service actions, not sales pressure.',
    groups: [
      { key: 'renewals', title: 'Upcoming renewals (next 45 days)', items: renewals },
      { key: 'incomplete', title: 'Incomplete proposals (idle 3+ days)', items: incomplete },
      { key: 'paymentFailures', title: 'Payment failures (30 days, not recovered)', items: failures },
      { key: 'longClaims', title: 'Long-running claims (15+ days)', items: longClaims },
      { key: 'inactive', title: 'Inactive customers with active cover (90+ days)', items: inactive },
    ],
  };
}

export function commandCentre({ mode = 'test' } = {}) {
  const recon = reconciliation({ mode });
  return { asOf: now().toISOString(), mode, note: FACILITATED_NOTE, kpis: kpis(mode), charts: charts(mode, recon), retention: retention(), reconciliation: { byType: recon.byType, balanced: recon.balanced, exceptions: recon.exceptions.length } };
}

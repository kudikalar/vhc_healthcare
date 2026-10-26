// Corporate billing (spec §32): employer premium invoices per the insurer statement, endorsement debit
// and credit notes, VHC corporate service-fee invoices, simulated test-mode payment, ledger postings,
// reconciliation and the renewal forecast.
//
// Group premiums (incl. the GST collected for the insurer) are posted to premium_facilitated against the
// insurer — they are never VHC revenue. Only the contracted corporate service fee is VHC income
// (corporate_service_fee), with GST on that fee in the tax ledger. Every posting carries an idempotency
// key derived from the invoice, so re-running a posting never duplicates entries.
import crypto from 'node:crypto';
import { db, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, unprocessable } from '../utils/errors.js';
import { addDays, addMonths, diffDays } from '../utils/dates.js';
import { pct, sum } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { newCorrelationId } from './events.js';
import { post } from './ledger.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { activeContract, SANDBOX_LABEL } from './corporate.js';
import { policyStats, POLICY_STATUS, renewalCensus } from './corporateEnrolment.js';
import { GST_BP, productById, quoteFromCensus } from './corporateProduct.js';

export const INVOICE_TYPES = {
  premium: 'Group premium invoice',
  debit_note: 'Debit note — endorsement additions',
  credit_note: 'Credit note — endorsement deletions',
  service_fee: 'VHC corporate service fee',
};
export const TEST_PAYMENT_METHODS = ['test_netbanking', 'test_neft', 'test_upi'];
const SETTLED = ['Paid', 'Credit Applied'];

function insertInvoice(actor, emp, data) {
  const terms = activeContract(emp.id)?.paymentTermsDays ?? 30;
  return db.insert('corporateInvoices', {
    invoiceNumber: `INV-CORP-${today().slice(0, 4)}-${String(nextSeq('corpInvoice')).padStart(6, '0')}`,
    employerId: emp.id, employerName: emp.name, gstin: emp.gstin || null, billing: emp.billing || null,
    issueDate: today(), dueDate: data.direction === 'debit' ? addDays(today(), terms) : null, status: 'Issued', payment: null, ledgerPostedAt: null,
    correlationId: newCorrelationId(), sandbox: true, label: SANDBOX_LABEL, createdBy: actor.name, typeLabel: INVOICE_TYPES[data.type], ...data,
  });
}

function bandLines(lives) {
  const by = new Map();
  for (const l of lives) {
    const k = `${l.band}|${l.annualPremium}`;
    const cur = by.get(k) || { band: l.band, perLife: l.annualPremium, lives: 0 };
    cur.lives += 1;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => a.band.localeCompare(b.band)).map((x) => ({ kind: 'premium', description: `Annual premium, age band ${x.band} — ${x.lives} li${x.lives === 1 ? 'fe' : 'ves'} × ${x.perLife / 100}`, amount: x.lives * x.perLife }));
}

/**
 * Bills everything confirmed and not yet invoiced on a group policy, as the sandbox insurer's
 * statement: base premium (lives covered from the policy start), a debit note for confirmed additions
 * and a credit note for confirmed deletions.
 */
export function generatePolicyInvoices(actor, policy, emp) {
  if (![POLICY_STATUS.ACTIVE, POLICY_STATUS.EXPIRED].includes(policy.status)) throw conflict(`Policy is ${policy.status}; nothing can be invoiced yet.`);
  const base = db.find('groupEnrolments', (e) => e.groupPolicyId === policy.id && e.basePremium && e.confirmedAt && !e.invoiceId);
  const ends = db.find('endorsements', (en) => en.groupPolicyId === policy.id && en.status === 'Confirmed' && !en.invoiceId);
  const additions = ends.filter((en) => en.direction === 'debit');
  const deletions = ends.filter((en) => en.direction === 'credit');
  if (!base.length && !ends.length) throw conflict('Nothing new to invoice: all confirmed enrolments and endorsements are already billed.');
  return tx(() => {
    const statementRef = `SBX-STMT-${policy.policyNumber.replace('GP-SBX-', '')}-${String(nextSeq(`stmt:${policy.id}`)).padStart(3, '0')}`;
    const common = { groupPolicyId: policy.id, policyNumber: policy.policyNumber, insurerId: SANDBOX_INSURER_ID, insurerName: policy.insurerName, insurerStatementRef: statementRef };
    const created = [];
    if (base.length) {
      const lives = base.flatMap((e) => e.lives.filter((l) => !l.endorsementId));
      const net = sum(base, (e) => e.billablePremium ?? e.annualPremium);
      const gst = pct(net, GST_BP);
      const inv = insertInvoice(actor, emp, { ...common, type: 'premium', direction: 'debit', period: `${policy.startDate} to ${policy.endDate}`, lines: [...bandLines(lives), { kind: 'gst', description: 'GST @ 18% on premium (collected for the insurer)', amount: gst }], netAmount: net, gst, total: net + gst, enrolmentIds: base.map((e) => e.id), lives: lives.length });
      for (const e of base) e.invoiceId = inv.id;
      created.push(inv);
    }
    for (const [type, list] of [['debit_note', additions], ['credit_note', deletions]]) {
      if (!list.length) continue;
      const net = sum(list, (en) => en.proRataPremium);
      const gst = sum(list, (en) => en.gst);
      const inv = insertInvoice(actor, emp, {
        ...common, type, direction: type === 'debit_note' ? 'debit' : 'credit', period: `Endorsements to ${today()}`,
        lines: [...list.map((en) => ({ kind: 'premium', endorsementId: en.id, description: `${en.endorsementNumber}: ${en.type} effective ${en.effectiveDate} — ${en.days}/${en.policyDays} days of ${en.annualPremium / 100}`, amount: en.proRataPremium })), { kind: 'gst', description: 'GST @ 18% on endorsement premium', amount: gst }],
        netAmount: net, gst, total: net + gst, endorsementIds: list.map((en) => en.id),
      });
      for (const en of list) en.invoiceId = inv.id;
      created.push(inv);
    }
    audit(actor, 'CORPORATE_INVOICES_GENERATED', 'groupPolicy', policy.id, { invoices: created.map((i) => i.invoiceNumber), statementRef });
    for (const u of db.find('users', (x) => x.orgId === emp.id && x.role === 'corporate_admin' && x.status === 'Active')) {
      notify(u.id, 'New invoice', `${created.map((i) => i.invoiceNumber).join(', ')} issued for ${policy.policyNumber}.`, { link: '/corporate/invoices' });
    }
    return created;
  });
}

/** Monthly VHC service fee (VHC revenue), when the employer's contract sets a per-member fee. */
export function generateServiceFeeInvoice(actor, emp, { month } = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw unprocessable('Select a month (YYYY-MM).', { fields: { month: 'Use YYYY-MM.' } });
  const monthStart = `${month}-01`;
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  if (monthStart > today()) throw unprocessable('A future month cannot be billed.', { fields: { month: 'Choose the current or a past month.' } });
  const contract = db.findOne('corporateContracts', (c) => c.employerId === emp.id && c.status === 'Active' && c.startDate <= monthEnd && c.endDate >= monthStart);
  if (!contract?.serviceFeePerMemberMonth) throw conflict('The employer\'s contract has no per-member service fee for this month.');
  const dup = db.findOne('corporateInvoices', (i) => i.employerId === emp.id && i.type === 'service_fee' && i.period === month && i.status !== 'Cancelled');
  if (dup) throw conflict(`The service fee for ${month} is already invoiced (${dup.invoiceNumber}).`);
  const covered = new Set(db.find('groupEnrolments', (e) => e.employerId === emp.id && e.confirmedAt && e.coverFrom <= monthEnd && (e.coverTo || '9999') >= monthStart).map((e) => e.memberId));
  if (!covered.size) throw conflict('No employees were covered in this month.');
  const net = covered.size * contract.serviceFeePerMemberMonth;
  const gst = pct(net, GST_BP);
  return tx(() => {
    const inv = insertInvoice(actor, emp, {
      type: 'service_fee', direction: 'debit', period: month, contractId: contract.id, contractNumber: contract.contractNumber,
      lines: [{ kind: 'service_fee', description: `Corporate benefits administration fee — ${covered.size} employees × ${contract.serviceFeePerMemberMonth / 100} (${month})`, amount: net }, { kind: 'gst', description: 'GST @ 18% on VHC service fee', amount: gst }],
      netAmount: net, gst, total: net + gst, members: covered.size,
    });
    audit(actor, 'CORPORATE_SERVICE_FEE_INVOICED', 'corporateInvoice', inv.id, { month, members: covered.size, total: inv.total });
    return inv;
  });
}

/** Ledger postings for a settled invoice. Idempotent: keys derive from the invoice id. */
export function postInvoiceLedger(inv) {
  if (!SETTLED.includes(inv.status)) throw conflict('Ledger postings are made once the invoice is settled.');
  return tx(() => {
    const base = { refType: 'corporateInvoice', refId: inv.id, reference: inv.invoiceNumber, orgId: inv.employerId, correlationId: inv.correlationId, mode: 'test' };
    const entries = [];
    if (inv.type === 'premium' || inv.type === 'debit_note') {
      entries.push(post({ ...base, ledger: 'premium_facilitated', direction: 'credit', amount: inv.total, insurerId: SANDBOX_INSURER_ID, description: `Group premium ${inv.invoiceNumber} for ${inv.policyNumber} (incl. GST collected for the insurer) — held for the insurer, not VHC revenue`, idempotencyKey: `corp-inv:${inv.id}:premium` }));
    } else if (inv.type === 'credit_note') {
      entries.push(post({ ...base, ledger: 'premium_facilitated', direction: 'debit', amount: inv.total, insurerId: SANDBOX_INSURER_ID, description: `Credit note ${inv.invoiceNumber} for ${inv.policyNumber} applied`, idempotencyKey: `corp-inv:${inv.id}:credit` }));
    } else if (inv.type === 'service_fee') {
      entries.push(post({ ...base, ledger: 'corporate_service_fee', direction: 'credit', amount: inv.netAmount, description: `Corporate service fee ${inv.invoiceNumber} (${inv.period})`, idempotencyKey: `corp-inv:${inv.id}:fee` }));
      if (inv.gst > 0) entries.push(post({ ...base, ledger: 'tax', direction: 'credit', amount: inv.gst, description: `GST on corporate service fee ${inv.invoiceNumber}`, idempotencyKey: `corp-inv:${inv.id}:fee-gst` }));
    }
    inv.ledgerPostedAt ||= now().toISOString();
    db.touch(inv);
    return entries;
  });
}

/** Simulated test-mode payment (bank transfer / UPI in sandbox). No card data is ever accepted. */
export function payInvoice(actor, inv, body = {}) {
  if (['cardNumber', 'card', 'cvv', 'cardNo', 'expiry'].some((k) => k in (body || {}))) throw bad('Card details are not accepted here. Use a test-mode bank transfer method.');
  if (inv.direction !== 'debit') throw conflict('Credit notes are applied, not paid.');
  if (inv.status === 'Paid') throw conflict(`${inv.invoiceNumber} is already paid.`);
  if (inv.status !== 'Issued') throw conflict(`${inv.invoiceNumber} is ${inv.status}.`);
  if (process.env.PAYMENT_MODE === 'live') throw conflict('Live corporate payments are not enabled. This environment only supports the sandbox.');
  const method = body.method || 'test_netbanking';
  if (!TEST_PAYMENT_METHODS.includes(method)) throw unprocessable('Select a test payment method.', { fields: { method: `One of ${TEST_PAYMENT_METHODS.join(', ')}` } });
  return tx(() => {
    inv.payment = { reference: `CPAY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, method, mode: 'test', amount: inv.total, paidAt: now().toISOString(), paidBy: actor.name, note: 'Simulated test-mode payment (no money moved)' };
    inv.status = 'Paid';
    db.touch(inv);
    const entries = postInvoiceLedger(inv);
    audit(actor, 'CORPORATE_INVOICE_PAID', 'corporateInvoice', inv.id, { reference: inv.payment.reference, amount: inv.total, method });
    return { invoice: inv, ledgerEntries: entries };
  });
}

export function applyCreditNote(actor, inv) {
  if (inv.direction !== 'credit') throw conflict('Only credit notes can be applied.');
  if (inv.status !== 'Issued') throw conflict(`${inv.invoiceNumber} is ${inv.status}.`);
  return tx(() => {
    Object.assign(inv, { status: 'Credit Applied', appliedAt: now().toISOString(), appliedBy: actor.name });
    db.touch(inv);
    const entries = postInvoiceLedger(inv);
    audit(actor, 'CORPORATE_CREDIT_APPLIED', 'corporateInvoice', inv.id, { amount: inv.total });
    return { invoice: inv, ledgerEntries: entries };
  });
}

export const ledgerFor = (inv) => db.find('ledgerEntries', (e) => e.refType === 'corporateInvoice' && e.refId === inv.id);

export function expectedLedger(inv) {
  if (!SETTLED.includes(inv.status)) return 0;
  return inv.total;
}

export function reconciliation(employerIds) {
  const invoices = db.find('corporateInvoices', (i) => employerIds.includes(i.employerId));
  const rows = invoices.map((inv) => {
    const entries = ledgerFor(inv);
    const posted = sum(entries, (e) => e.amount);
    const expected = expectedLedger(inv);
    return {
      id: inv.id, invoiceNumber: inv.invoiceNumber, employerId: inv.employerId, employerName: inv.employerName, type: inv.type, typeLabel: INVOICE_TYPES[inv.type],
      direction: inv.direction, total: inv.total, status: inv.status, issueDate: inv.issueDate, dueDate: inv.dueDate, overdue: inv.status === 'Issued' && inv.dueDate && inv.dueDate < today(),
      ledgerPosted: posted, expectedLedger: expected, entries: entries.length, reconciled: posted === expected,
    };
  });
  const debit = rows.filter((r) => r.direction === 'debit');
  const credit = rows.filter((r) => r.direction === 'credit');
  const ledger = db.find('ledgerEntries', (e) => e.refType === 'corporateInvoice' && employerIds.includes(e.orgId));
  const net = (l) => sum(ledger.filter((e) => e.ledger === l), (e) => (e.direction === 'credit' ? e.amount : -e.amount));
  const unbilledEnrolments = db.find('groupEnrolments', (e) => employerIds.includes(e.employerId) && e.basePremium && e.confirmedAt && !e.invoiceId);
  const unbilledEndorsements = db.find('endorsements', (en) => employerIds.includes(en.employerId) && en.status === 'Confirmed' && !en.invoiceId);
  return {
    rows,
    totals: {
      billed: sum(debit, (r) => r.total), paid: sum(debit.filter((r) => r.status === 'Paid'), (r) => r.total), outstanding: sum(debit.filter((r) => r.status === 'Issued'), (r) => r.total),
      overdue: sum(debit.filter((r) => r.overdue), (r) => r.total), credits: sum(credit, (r) => r.total), creditsApplied: sum(credit.filter((r) => r.status === 'Credit Applied'), (r) => r.total),
      premiumFacilitatedNet: net('premium_facilitated'), serviceFeeRevenue: net('corporate_service_fee'), gstOnFees: net('tax'),
    },
    unbilled: {
      enrolments: unbilledEnrolments.length, enrolmentPremium: sum(unbilledEnrolments, (e) => e.billablePremium ?? e.annualPremium),
      endorsements: unbilledEndorsements.length, endorsementNet: sum(unbilledEndorsements, (en) => (en.direction === 'debit' ? en.total : -en.total)),
    },
    mismatches: rows.filter((r) => !r.reconciled),
    note: 'Premiums are facilitated for the insurer and are not VHC revenue. Only the corporate service fee is VHC income.',
  };
}

/** Renewal forecast: same synthetic rates, lives aged to the renewal date (no claims-experience loading). */
export function forecast(employerIds) {
  const t = today();
  const policies = db.find('groupPolicies', (p) => employerIds.includes(p.employerId) && p.status === POLICY_STATUS.ACTIVE);
  const rows = policies.map((p) => {
    const stats = policyStats(p);
    const product = productById(p.productId);
    const { startDate, census } = renewalCensus(p);
    const q = quoteFromCensus(product, { sumInsured: p.terms.sumInsured, census });
    const contract = db.get('corporateContracts', p.contractId);
    const feePerMonth = (contract?.serviceFeePerMemberMonth || 0) * stats.enrolled;
    return {
      groupPolicyId: p.id, policyNumber: p.policyNumber, employerId: p.employerId, employerName: p.employerName, endDate: p.endDate, renewalDate: startDate, daysToRenewal: diffDays(t, p.endDate),
      currentAnnualPremium: stats.annualPremium, currentLives: stats.coveredLives, projectedNetPremium: q.netPremium, projectedGst: q.gst, projectedTotal: q.total, projectedLives: q.lives,
      changeBp: stats.annualPremium ? Math.round(((q.netPremium - stats.annualPremium) * 10000) / stats.annualPremium) : 0,
      contractNumber: contract?.contractNumber || null, contractEnds: contract?.endDate || null, contractRenewalNeeded: !!contract && contract.endDate < startDate,
      serviceFeeRunRateAnnual: feePerMonth * 12, renewed: !!p.renewedBy,
    };
  }).sort((a, b) => a.daysToRenewal - b.daysToRenewal);
  return { rows, assumption: 'Sandbox projection: synthetic group rates with each covered life aged to the renewal date; no claims-experience loading. Actual renewal terms come from the insurer.' };
}

export const outstandingFor = (employerId) => db.find('corporateInvoices', (i) => i.employerId === employerId && i.direction === 'debit' && i.status === 'Issued');

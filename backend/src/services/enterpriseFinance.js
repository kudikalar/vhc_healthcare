// Finance & commission (§43): ledger views, insurer settlements, commission statements and the
// three-way reconciliation of gateway (payments) vs insurer (issuance decisions) vs internal ledgers.
//
// Premiums facilitated are held for insurers and are NOT VHC revenue. VHC revenue is only
// vhc_commission + corporate/booking/hospital service fees (ledgers flagged vhcRevenue in ledger.js).
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, notFound } from '../utils/errors.js';
import { pct, sum } from '../utils/money.js';
import { APP_STATUS } from './lifecycle.js';
import { audit } from './audit.js';
import { balances, commissionBpFor, gatewayFee, LEDGERS, post as postLedger } from './ledger.js';

export const FACILITATED_NOTE = 'Premiums facilitated are held for insurers and are not VHC revenue.';
export const REVENUE_LEDGERS = Object.entries(LEDGERS).filter(([, v]) => v.vhcRevenue).map(([k]) => k);
const modeOf = (x) => x?.mode || 'test';
const refOf = (prefix) => `${prefix}-${today().replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** Insurer that a payment's premium belongs to (payment → policy → proposal plan). */
export function insurerIdFor(p) {
  if (p.insurerId) return p.insurerId;
  const pol = p.policyId ? db.get('policies', p.policyId) : db.findOne('policies', (x) => x.firstPaymentRef === p.reference);
  if (pol?.insurerId) return pol.insurerId;
  const app = p.applicationId && db.get('applications', p.applicationId);
  return (app && db.get('plans', app.planId)?.insurerId) || null;
}

/**
 * Posts ledger lines for successful payments that pre-date the ledger (seeded/legacy data). Uses the same
 * idempotency keys as insurerHub (premium:/gwfee:/gwgst:/commission:) so nothing is ever posted twice.
 */
export function backfillLedger() {
  let premiums = 0;
  let commissions = 0;
  const has = (key) => !!db.findOne('ledgerEntries', (e) => e.idempotencyKey === key);
  for (const p of db.find('payments', (x) => x.status === 'success')) {
    if (has(`premium:${p.id}`)) continue;
    p.insurerId ||= insurerIdFor(p);
    p.mode ||= 'test';
    postLedger({ ledger: 'premium_facilitated', direction: 'credit', amount: p.amount, description: `Premium ${p.reference}: ${p.description} (backfilled)`, refType: 'payment', refId: p.id, reference: p.reference, insurerId: p.insurerId, userId: p.userId, correlationId: p.correlationId || null, idempotencyKey: `premium:${p.id}`, mode: p.mode });
    const { fee, gst } = gatewayFee(p.amount);
    if (fee > 0) postLedger({ ledger: 'gateway_fee', direction: 'credit', amount: fee, description: `Gateway fee on ${p.reference} (backfilled)`, refType: 'payment', refId: p.id, reference: p.reference, idempotencyKey: `gwfee:${p.id}`, mode: p.mode });
    if (gst > 0) postLedger({ ledger: 'tax', direction: 'credit', amount: gst, description: `GST on gateway fee for ${p.reference} (backfilled)`, refType: 'payment', refId: p.id, reference: p.reference, idempotencyKey: `gwgst:${p.id}`, mode: p.mode });
    premiums += 1;
  }
  for (const pol of db.find('policies', (x) => x.firstPaymentRef && x.insurerId)) {
    if (has(`commission:${pol.id}`)) continue;
    const pay = db.findOne('payments', (x) => x.reference === pol.firstPaymentRef && x.status === 'success');
    const bp = commissionBpFor(pol.insurerId);
    if (!pay || bp <= 0) continue;
    postLedger({ ledger: 'vhc_commission', direction: 'credit', amount: pct(pay.amount, bp), description: `Commission accrued on ${pol.policyNumber} (${bp / 100}%, backfilled)`, refType: 'policy', refId: pol.id, reference: pol.policyNumber, insurerId: pol.insurerId, userId: pol.userId, idempotencyKey: `commission:${pol.id}`, mode: modeOf(pay) });
    commissions += 1;
  }
  return { ledgerBackfilledPremiums: premiums, ledgerBackfilledCommissions: commissions };
}

const insurerName = (id) => (id && db.get('insurers', id)?.name) || (id ? id : 'Unassigned');

export function ledgerEntries({ mode, insurerId, ledger, from, to, q, limit = 500 } = {}) {
  const list = db.find('ledgerEntries', (e) => {
    if (mode && e.mode !== mode) return false;
    if (insurerId && e.insurerId !== insurerId) return false;
    if (ledger && e.ledger !== ledger) return false;
    const d = e.postedAt.slice(0, 10);
    if ((from && d < from) || (to && d > to)) return false;
    if (q && !`${e.reference || ''} ${e.description}`.toLowerCase().includes(String(q).toLowerCase())) return false;
    return true;
  });
  return list.sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, Math.min(Number(limit) || 500, 2000))
    .map((e) => ({ ...e, ledgerLabel: LEDGERS[e.ledger]?.label, vhcRevenue: !!LEDGERS[e.ledger]?.vhcRevenue, insurerName: e.insurerId ? insurerName(e.insurerId) : null }));
}

/** Ledger balances plus the headline split between money held for insurers and VHC's own revenue. */
export function financeSummary(filters = {}) {
  const b = balances(filters);
  const vhcRevenue = sum(REVENUE_LEDGERS, (k) => b[k].net);
  return {
    filters, note: FACILITATED_NOTE, balances: b,
    headline: {
      premiumsHeldForInsurers: b.premium_facilitated.net,
      premiumsFacilitatedGross: b.premium_facilitated.credits,
      settledToInsurers: b.insurer_settlement.net,
      vhcEarnedRevenue: vhcRevenue,
      gatewayFees: b.gateway_fee.net, taxOnFees: b.tax.net, refunds: b.refund.net, claimPayouts: b.claim_payout.net,
    },
  };
}

// ---------------------------------------------------------------- insurer settlement
/**
 * Moves the outstanding facilitated premium for one insurer (and one mode) to insurer_settlement under a
 * settlement reference. Idempotent: the same idempotencyKey returns the original settlement; with nothing
 * outstanding the request is refused.
 */
export function settleInsurer(insurerId, { mode = 'test', idempotencyKey, note } = {}, actor) {
  const ins = db.get('insurers', insurerId);
  if (!ins) throw notFound('Insurer not found');
  if (!['test', 'live'].includes(mode)) throw bad('mode must be test or live');
  if (idempotencyKey) {
    const existing = db.findOne('insurerSettlements', (s) => s.idempotencyKey === idempotencyKey);
    if (existing) return { settlement: existing, duplicate: true };
  }
  const outstanding = balances({ mode, insurerId }).premium_facilitated.net;
  if (outstanding <= 0) throw conflict(`No unsettled ${mode} premium is held for ${ins.name}`);
  const settlement = db.insert('insurerSettlements', {
    reference: refOf('STL'), insurerId, insurerName: ins.name, sandbox: !!ins.sandbox, mode, amount: outstanding,
    idempotencyKey: idempotencyKey || null, note: note?.trim() || null, settledBy: actor?.name || 'System', settledAt: now().toISOString(),
    commissionReceivable: balances({ mode, insurerId }).vhc_commission.net,
  });
  const common = { amount: outstanding, refType: 'insurerSettlement', refId: settlement.id, reference: settlement.reference, insurerId, mode };
  postLedger({ ...common, ledger: 'premium_facilitated', direction: 'debit', description: `Premium remitted to ${ins.name} (${settlement.reference})`, idempotencyKey: `settle-out:${settlement.id}` });
  postLedger({ ...common, ledger: 'insurer_settlement', direction: 'credit', description: `Settlement ${settlement.reference} to ${ins.name}`, idempotencyKey: `settle-in:${settlement.id}` });
  audit(actor, 'INSURER_SETTLEMENT_CREATED', 'insurerSettlement', settlement.id, { reference: settlement.reference, insurerId, amount: outstanding, mode });
  return { settlement, duplicate: false };
}

/** Commission statement per insurer: premium base, refunds, commission accrued, settlements, outstanding. */
export function commissionStatements({ mode = 'test', from, to } = {}) {
  const ids = new Set([...db.all('insurers').filter((i) => i.status === 'Active' || i.sandbox).map((i) => i.id), ...db.all('ledgerEntries').map((e) => e.insurerId).filter(Boolean)]);
  return [...ids].map((id) => {
    const b = balances({ mode, insurerId: id, from, to });
    const lines = ledgerEntries({ mode, insurerId: id, ledger: 'vhc_commission', from, to, limit: 200 });
    return {
      insurerId: id, insurerName: insurerName(id), sandbox: !!db.get('insurers', id)?.sandbox, commissionBp: commissionBpFor(id),
      premiumFacilitated: b.premium_facilitated.credits, premiumReversed: b.premium_facilitated.debits - b.insurer_settlement.credits,
      settledToInsurer: b.insurer_settlement.net, heldForInsurer: b.premium_facilitated.net,
      commissionAccrued: b.vhc_commission.net, commissionLines: lines,
      settlements: db.find('insurerSettlements', (s) => s.insurerId === id && s.mode === mode),
    };
  });
}

// ---------------------------------------------------------------- refunds view
export function refundsView({ status, mode } = {}) {
  return db.find('refunds', (r) => (!status || r.status === status) && (!mode || modeOf(r) === mode))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const p = db.get('payments', r.paymentId);
      return { ...r, paymentAmount: p?.amount ?? null, paymentDescription: p?.description || null, customer: db.get('users', r.userId)?.name || null, insurerName: r.insurerId ? insurerName(r.insurerId) : null };
    });
}

// ---------------------------------------------------------------- gateway settlement report (simulated)
/** Simulates the gateway's settlement file for captured payments not yet settled. injectMismatch shorts one line by ₹1. */
export function simulateGatewaySettlement({ mode = 'test', injectMismatch = false } = {}, actor) {
  const settled = new Set(db.all('gatewaySettlements').flatMap((s) => s.lines.map((l) => l.paymentId)));
  const pay = db.find('payments', (p) => p.status === 'success' && modeOf(p) === mode && !settled.has(p.id));
  if (!pay.length) throw conflict('No captured payments are awaiting a gateway settlement');
  const lines = pay.map((p, i) => {
    const { fee, gst } = gatewayFee(p.amount);
    const expectedNet = p.amount - fee - gst;
    return { paymentId: p.id, reference: p.reference, captured: p.amount, fee, gst, expectedNet, settledNet: injectMismatch && i === 0 ? expectedNet - 100 : expectedNet };
  });
  const batch = db.insert('gatewaySettlements', { reference: refOf('GWS'), mode, date: today(), lines, simulated: true, createdBy: actor?.name || 'System', total: sum(lines, (l) => l.settledNet) });
  audit(actor, 'GATEWAY_SETTLEMENT_IMPORTED', 'gatewaySettlement', batch.id, { reference: batch.reference, lines: lines.length, injectMismatch: !!injectMismatch });
  return batch;
}

// ---------------------------------------------------------------- reconciliation
const ageDays = (iso) => Math.max(0, Math.floor((now().getTime() - new Date(iso).getTime()) / 86400000));

/**
 * Three-way reconciliation. Every captured premium should end in exactly one of: policy issued by the
 * insurer, refund after an insurer decline, or (temporarily) waiting for the insurer's decision.
 */
export function reconciliation({ mode = 'test' } = {}) {
  const payments = db.find('payments', (p) => modeOf(p) === mode);
  const captured = payments.filter((p) => p.status === 'success');
  const exceptions = [];
  const ex = (type, severity, payload) => exceptions.push({ type, severity, ...payload });
  const insurer = { issued: 0, issuancePending: 0, declined: 0, notApplicable: 0 };
  const ledgerByKey = new Map(db.all('ledgerEntries').filter((e) => e.idempotencyKey).map((e) => [e.idempotencyKey, e]));

  for (const p of captured) {
    const base = { reference: p.reference, paymentId: p.id, amount: p.amount, customerId: p.userId, insurerId: insurerIdFor(p), insurerName: insurerName(insurerIdFor(p)), at: p.completedAt || p.createdAt };
    if (p.purpose === 'application') {
      const app = db.get('applications', p.applicationId);
      if (app?.status === APP_STATUS.ISSUED) {
        insurer.issued += 1;
        if (!db.findOne('policies', (x) => x.firstPaymentRef === p.reference)) ex('issued_without_policy', 'high', { ...base, detail: `Proposal ${app.applicationNumber} is Issued but no policy references ${p.reference}` });
      } else if (app?.status === APP_STATUS.ISSUANCE_PENDING) {
        insurer.issuancePending += 1;
        ex('captured_issuance_pending', ageDays(base.at) >= 2 ? 'high' : 'medium', { ...base, applicationId: app.id, applicationNumber: app.applicationNumber, ageDays: ageDays(base.at), detail: `Premium captured; ${app.issuance?.insurerId ? insurerName(app.issuance.insurerId) : 'insurer'} has not decided issuance yet` });
      } else if (app?.status === APP_STATUS.INSURER_DECLINED) {
        insurer.declined += 1;
        const refunded = sum(db.find('refunds', (r) => r.paymentId === p.id && r.status === 'completed'), (r) => r.amount);
        if (refunded < p.amount) ex('declined_awaiting_refund', 'high', { ...base, applicationId: app.id, applicationNumber: app.applicationNumber, refunded, detail: `Insurer declined; ${refunded ? 'partially refunded' : 'refund not yet completed'}` });
      } else if (app) {
        ex('captured_unexpected_state', 'high', { ...base, applicationId: app.id, detail: `Captured payment but proposal is ${app.status}` });
      }
      if (app?.offer && app.offer.firstPayment !== p.amount) ex('amount_mismatch', 'high', { ...base, detail: `Offer expects ${app.offer.firstPayment} paise, captured ${p.amount}` });
    } else {
      insurer.notApplicable += 1;
    }
    const prem = ledgerByKey.get(`premium:${p.id}`);
    if (!prem) ex('missing_ledger_entry', 'medium', { ...base, detail: 'No facilitated-premium ledger entry for this captured payment' });
    else if (prem.amount !== p.amount) ex('amount_mismatch', 'high', { ...base, detail: `Ledger shows ${prem.amount} paise, gateway captured ${p.amount}` });
  }
  for (const p of payments.filter((x) => x.status === 'failed' && /amount mismatch/i.test(x.failureReason || ''))) {
    ex('gateway_amount_mismatch', 'high', { reference: p.reference, paymentId: p.id, amount: p.amount, at: p.completedAt || p.createdAt, detail: p.failureReason });
  }
  for (const p of payments.filter((x) => x.status === 'refund_due')) {
    ex('duplicate_collection_refund_due', 'high', { reference: p.reference, paymentId: p.id, amount: p.amount, at: p.completedAt || p.createdAt, detail: p.failureReason || 'Collected after the item was already paid' });
  }
  for (const s of db.find('gatewaySettlements', (x) => x.mode === mode)) {
    for (const l of s.lines.filter((x) => x.settledNet !== x.expectedNet)) {
      ex('settlement_mismatch', 'high', { reference: l.reference, paymentId: l.paymentId, amount: l.captured, at: s.createdAt, settlement: s.reference, detail: `Gateway settled ${l.settledNet} paise, expected ${l.expectedNet} (captured − fee − GST)` });
    }
  }
  const insurerIds = new Set(db.all('ledgerEntries').filter((e) => e.ledger === 'premium_facilitated' && e.mode === mode).map((e) => e.insurerId));
  for (const id of insurerIds) {
    const held = balances({ mode, insurerId: id }).premium_facilitated.net;
    if (held > 0) {
      const lastSettled = db.find('insurerSettlements', (s) => s.insurerId === id && s.mode === mode).sort((a, b) => b.settledAt.localeCompare(a.settledAt))[0];
      ex('unsettled_premium', 'low', { insurerId: id, insurerName: insurerName(id), amount: held, at: lastSettled?.settledAt || null, detail: `Premium held for ${insurerName(id)} not yet remitted${lastSettled ? ` (last settlement ${lastSettled.reference})` : ''}` });
    }
  }
  const byType = exceptions.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {});
  const b = balances({ mode });
  return {
    mode, asOf: now().toISOString(), note: FACILITATED_NOTE,
    gateway: {
      captured: captured.length, capturedAmount: sum(captured, (p) => p.amount),
      failed: payments.filter((p) => p.status === 'failed').length, pending: payments.filter((p) => p.status === 'pending').length,
      expired: payments.filter((p) => p.status === 'expired').length, refundDue: payments.filter((p) => p.status === 'refund_due').length,
    },
    insurer,
    ledger: { premiumsHeld: b.premium_facilitated.net, settledToInsurers: b.insurer_settlement.net, refunds: b.refund.net, gatewayFees: b.gateway_fee.net },
    exceptions: exceptions.sort((a, b2) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b2.severity])),
    byType,
    balanced: exceptions.filter((e) => e.severity !== 'low').length === 0,
  };
}

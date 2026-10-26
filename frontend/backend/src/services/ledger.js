// Separate financial ledgers. Premiums VHC facilitates for insurers are NOT VHC revenue; they are held
// for (and settled to) the insurer. VHC's own earned income (commission/remuneration, service and booking
// fees) is kept in its own ledgers, as are refunds, gateway fees, tax and claim payouts (insurer money).
//
// Every entry records the payment mode (test/live) and environment so sandbox activity can never be
// mixed into live reporting. Posting with an idempotencyKey that already exists returns the original.
import { db } from '../db.js';
import { now } from '../clock.js';
import { bad } from '../utils/errors.js';

export const LEDGERS = {
  premium_facilitated: { label: 'Insurance premiums facilitated', vhcRevenue: false, owner: 'insurer' },
  insurer_settlement: { label: 'Insurer premium settlements', vhcRevenue: false, owner: 'insurer' },
  vhc_commission: { label: 'VHC earned commission / remuneration', vhcRevenue: true, owner: 'vhc' },
  corporate_service_fee: { label: 'Corporate service fees', vhcRevenue: true, owner: 'vhc' },
  healthcare_booking_fee: { label: 'Healthcare booking fees', vhcRevenue: true, owner: 'vhc' },
  hospital_service_income: { label: 'Hospital service income', vhcRevenue: true, owner: 'vhc' },
  provider_payable: { label: 'Healthcare provider payments', vhcRevenue: false, owner: 'provider' },
  refund: { label: 'Refunds', vhcRevenue: false, owner: 'customer' },
  adjustment: { label: 'Adjustments', vhcRevenue: false, owner: 'vhc' },
  tax: { label: 'Tax (GST on fees)', vhcRevenue: false, owner: 'government' },
  gateway_fee: { label: 'Payment gateway fees', vhcRevenue: false, owner: 'vhc' },
  claim_payout: { label: 'Claim payouts (insurer funds)', vhcRevenue: false, owner: 'insurer' },
  partner_payout: { label: 'Partner payouts', vhcRevenue: false, owner: 'partner' },
};

export const PAYMENT_MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'test';
export const ENVIRONMENT = process.env.VHC_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox');

/**
 * Posts one ledger line. direction: 'credit' increases the ledger balance, 'debit' decreases it.
 * Required: ledger, direction, amount (integer paise > 0), description. Optional references:
 * refType/refId/reference, insurerId, orgId, userId, correlationId, idempotencyKey.
 */
export function post(entry) {
  const { ledger, direction, amount } = entry;
  if (!LEDGERS[ledger]) throw bad(`Unknown ledger ${ledger}`);
  if (!['credit', 'debit'].includes(direction)) throw bad('direction must be credit or debit');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw bad('Ledger amount must be a positive whole number of paise');
  if (entry.idempotencyKey) {
    const existing = db.findOne('ledgerEntries', (e) => e.idempotencyKey === entry.idempotencyKey);
    if (existing) return existing;
  }
  return db.insert('ledgerEntries', {
    ledger, direction, amount, currency: 'INR', description: entry.description || '',
    refType: entry.refType || null, refId: entry.refId || null, reference: entry.reference || null,
    insurerId: entry.insurerId || null, orgId: entry.orgId || null, userId: entry.userId || null,
    correlationId: entry.correlationId || null, idempotencyKey: entry.idempotencyKey || null,
    mode: entry.mode || PAYMENT_MODE, environment: ENVIRONMENT, postedAt: now().toISOString(),
  });
}

/** Net balance per ledger (credits − debits), optionally filtered (mode, insurerId, from/to dates). */
export function balances({ mode, insurerId, from, to } = {}) {
  const out = Object.fromEntries(Object.keys(LEDGERS).map((k) => [k, { ...LEDGERS[k], credits: 0, debits: 0, net: 0, entries: 0 }]));
  for (const e of db.all('ledgerEntries')) {
    if (mode && e.mode !== mode) continue;
    if (insurerId && e.insurerId !== insurerId) continue;
    const d = e.postedAt.slice(0, 10);
    if ((from && d < from) || (to && d > to)) continue;
    const b = out[e.ledger];
    b[e.direction === 'credit' ? 'credits' : 'debits'] += e.amount;
    b.net = b.credits - b.debits;
    b.entries += 1;
  }
  return out;
}

/** Commission rate in basis points for an insurer's active agreement (0 when none). */
export function commissionBpFor(insurerId) {
  const ins = insurerId && db.get('insurers', insurerId);
  return ins?.agreement?.commissionBp || 0;
}

/** Simulated gateway fee: 2% + 18% GST on the fee (sandbox values; real values come from the gateway contract). */
export function gatewayFee(amount) {
  const fee = Math.round((amount * 200) / 10000);
  return { fee, gst: Math.round((fee * 1800) / 10000) };
}

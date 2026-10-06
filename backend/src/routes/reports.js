import { Router } from 'express';
import { db } from '../db.js';
import { today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { sum } from '../utils/money.js';
import { policyStatusAt } from '../services/lifecycle.js';

const r = Router();
r.use(authenticate, requireRole('agent', 'underwriter', 'claims_officer', 'admin'));

const countBy = (arr, f) => arr.reduce((m, x) => ({ ...m, [f(x)]: (m[f(x)] || 0) + 1 }), {});

/** Confirms each successful payment/payout is reflected exactly once on its target record. */
function reconcile() {
  const payments = db.find('payments', (p) => p.status === 'success');
  const policies = db.all('policies');
  const mismatches = [];
  let confirmed = 0;
  for (const p of payments) {
    let applied = 0;
    if (p.purpose === 'application') {
      const pol = policies.find((x) => x.firstPaymentRef === p.reference);
      applied = pol ? p.amount : 0;
    } else {
      const pol = policies.find((x) => x.id === p.policyId);
      applied = sum((pol?.schedule || []).filter((i) => i.paymentRef === p.reference), (i) => i.amount);
    }
    confirmed += applied;
    if (applied !== p.amount) mismatches.push({ reference: p.reference, amount: p.amount, applied });
  }
  const payouts = db.find('payouts', (p) => p.status === 'success');
  const claimPaid = sum(db.all('healthClaims'), (c) => c.paidAmount || 0) +
    sum(db.all('lifeClaims'), (c) => sum(c.beneficiaries.filter((b) => b.paid), (b) => b.allocation));
  return {
    premiumsCollected: sum(payments, (p) => p.amount), premiumsApplied: confirmed, paymentMismatches: mismatches,
    payoutsCompleted: sum(payouts, (p) => p.amount), claimAmountsPaid: claimPaid,
    balanced: mismatches.length === 0 && sum(payouts, (p) => p.amount) === claimPaid,
  };
}

r.get('/summary', (req, res) => {
  const t = today();
  const apps = db.all('applications');
  const policies = db.all('policies');
  const hc = db.all('healthClaims');
  const lc = db.all('lifeClaims');
  const payments = db.all('payments');
  res.json({
    asOf: t,
    queues: {
      initialReview: apps.filter((a) => ['Submitted', 'Initial Review'].includes(a.status)).length,
      underwriting: apps.filter((a) => a.status === 'Underwriting').length,
      awaitingCustomer: apps.filter((a) => ['More Information Required', 'Approved'].includes(a.status)).length,
      healthClaimsOpen: hc.filter((c) => !['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status)).length,
      lifeClaimsOpen: lc.filter((c) => !['Settled', 'Rejected'].includes(c.status)).length,
      payoutsPending: db.find('payouts', (p) => p.status === 'initiated').length + hc.filter((c) => c.status === 'Approved').length,
      reinstatements: db.find('reinstatements', (x) => x.status === 'Requested').length,
      exceptionsOpen: db.find('exceptions', (e) => e.status === 'open').length,
    },
    applicationsByStatus: countBy(apps, (a) => a.status),
    policiesByStatus: countBy(policies, (p) => `${p.product}: ${policyStatusAt(p, t)}`),
    healthClaimsByStatus: countBy(hc, (c) => c.status),
    lifeClaimsByStatus: countBy(lc, (c) => c.status),
    paymentsByStatus: countBy(payments, (p) => p.status),
    premiumByProduct: {
      health: sum(payments.filter((p) => p.status === 'success' && policies.find((x) => x.firstPaymentRef === p.reference)?.product === 'health'), (p) => p.amount),
      life: sum(payments.filter((p) => p.status === 'success' && (p.policyId || policies.find((x) => x.firstPaymentRef === p.reference)?.product === 'life')), (p) => p.amount),
    },
    reconciliation: reconcile(),
  });
});

export default r;

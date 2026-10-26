// Health claim assessment: coverage date, waiting periods, exclusions, limits,
// deductible, co-payment and the (shared) remaining benefit balance.
import { now } from '../clock.js';
import { diffDays } from '../utils/dates.js';
import { pct, sum } from '../utils/money.js';

export const available = (policy) => policy.balance.total - policy.balance.reserved - policy.balance.paid;

export function evaluateHealthClaim(policy, claim, billItems) {
  const cfg = policy.termsSnapshot;
  const reasons = [];
  const incident = claim.admissionDate; // plan rule: coverage evaluated on admission/treatment date
  if (incident < policy.startDate || incident > policy.endDate) reasons.push('Treatment date is outside the policy coverage period');

  const daysCovered = diffDays(policy.continuityStartDate, incident);
  if (!claim.isAccident && daysCovered < cfg.initialWaitingDays) {
    reasons.push(`Initial waiting period of ${cfg.initialWaitingDays} days not completed (treatment on day ${daysCovered})`);
  }
  const text = `${claim.diagnosis} ${claim.treatment}`.toLowerCase();
  for (const w of cfg.conditionWaitingPeriods || []) {
    if (text.includes(w.condition.toLowerCase()) && daysCovered < w.days) {
      reasons.push(`Waiting period of ${w.days} days applies to ${w.condition} (treatment on day ${daysCovered})`);
    }
  }
  for (const ex of cfg.exclusions || []) {
    if ((ex.keywords || []).some((k) => text.includes(k.toLowerCase()))) reasons.push(`Excluded treatment: ${ex.label}`);
  }

  const items = billItems?.length ? billItems : [{ description: 'Claimed amount', category: 'medical', amount: claim.requestedAmount }];
  const stayDays = Math.max(1, diffDays(claim.admissionDate, claim.dischargeDate));
  let roomCapLeft = (cfg.roomRentLimitPerDay || Infinity) * stayDays;
  const assessedItems = items.map((it) => {
    let admissible = it.admissible === false ? 0 : it.amount;
    let note = it.admissible === false ? 'Marked non-admissible by assessor' : null;
    if (it.category === 'non_medical') { admissible = 0; note = 'Non-medical consumables are not payable'; }
    if (it.category === 'room' && admissible > roomCapLeft) {
      note = `Room rent capped at ${cfg.roomRentLimitPerDay / 100}/day x ${stayDays} day(s)`;
      admissible = roomCapLeft;
    }
    if (it.category === 'room') roomCapLeft -= admissible;
    return { description: it.description, category: it.category, amount: it.amount, admissible, note };
  });

  const billedAmount = sum(assessedItems, (i) => i.amount);
  const eligibleAmount = reasons.length ? 0 : sum(assessedItems, (i) => i.admissible);
  const deductible = Math.min(cfg.deductiblePerClaim || 0, eligibleAmount);
  const afterDeductible = eligibleAmount - deductible;
  const copay = pct(afterDeductible, cfg.copayBp || 0);
  const calculatedAmount = afterDeductible - copay;
  const availableCoverage = available(policy) + (claim.reservedAmount || 0); // the claim's own reservation is released on re-approval
  const approvedAmount = Math.min(calculatedAmount, availableCoverage);
  return {
    eligible: reasons.length === 0,
    reasons,
    inputs: {
      incidentDate: incident, continuityStartDate: policy.continuityStartDate, daysCovered, stayDays,
      deductiblePerClaim: cfg.deductiblePerClaim, copayBp: cfg.copayBp, roomRentLimitPerDay: cfg.roomRentLimitPerDay,
      sharedCoverage: policy.planType === 'floater', policyCoverage: policy.balance.total,
    },
    items: assessedItems,
    requestedAmount: claim.requestedAmount, billedAmount, eligibleAmount, deductible, copay, calculatedAmount,
    availableCoverage, approvedAmount,
    cappedByCoverage: approvedAmount < calculatedAmount,
    totalDeducted: claim.requestedAmount - approvedAmount,
    evaluatedAt: now().toISOString(),
  };
}

// Scheduled jobs (run on demand from dev tools / after clock changes, and hourly in the server).
import { db, meta, tx } from '../db.js';
import { today } from '../clock.js';
import { addDays, diffDays } from '../utils/dates.js';
import { notify } from './audit.js';
import { policyStatusAt } from './lifecycle.js';
import { initiatePayment, processPaymentCallback } from './payments.js';

export function runJobs() {
  return tx(() => {
    const t = today();
    const out = { renewalReminders: 0, dueReminders: 0, graceNotices: 0, lapseNotices: 0, autoPayAttempts: 0 };
    for (const p of db.all('policies')) {
      if (p.product === 'health') {
        const days = diffDays(t, p.endDate);
        if (!p.renewedBy && days >= 0 && days <= 30) {
          if (notify(p.userId, 'Renewal due', `${p.policyNumber} ends on ${p.endDate}. Review your members and renew to keep continuity.`, { dedupeKey: `renew:${p.id}`, link: `/policies/${p.id}` })) out.renewalReminders++;
        }
        continue;
      }
      const status = policyStatusAt(p, t);
      if (['Terminated', 'Expired', 'Upcoming'].includes(status)) continue;
      const next = p.schedule.filter((i) => i.status !== 'paid').sort((a, b) => a.no - b.no)[0];
      if (!next) continue;
      const until = diffDays(t, next.dueDate);
      if (until >= 0 && until <= 7 && notify(p.userId, 'Premium due soon', `Installment ${next.no} of ${p.policyNumber} is due on ${next.dueDate}.`, { dedupeKey: `due:${p.id}:${next.no}`, link: `/policies/${p.id}` })) out.dueReminders++;
      if (status === 'Grace Period' && notify(p.userId, 'Premium overdue — grace period', `Installment ${next.no} of ${p.policyNumber} is overdue. Pay by ${addDays(next.dueDate, p.graceDays)} to avoid lapse.`, { type: 'warning', dedupeKey: `grace:${p.id}:${next.no}`, link: `/policies/${p.id}` })) out.graceNotices++;
      if (status === 'Lapsed' && notify(p.userId, 'Policy lapsed', `${p.policyNumber} has lapsed due to unpaid premium. You may request reinstatement.`, { type: 'error', dedupeKey: `lapse:${p.id}:${next.no}`, link: `/policies/${p.id}` })) out.lapseNotices++;

      if (p.autoPay && status !== 'Lapsed' && next.dueDate <= t) {
        const key = `autopay:${p.id}:${next.no}:${t}`;
        if (!db.findOne('payments', (x) => x.idempotencyKey === key)) {
          const owner = { id: p.userId, role: 'customer', name: 'Auto-debit' };
          const { payment } = initiatePayment(owner, { purpose: 'installment', policyId: p.id, installmentNo: next.no, amount: next.amount, idempotencyKey: key });
          payment.autoPay = true;
          const outcome = meta().autoPayOutcome === 'failure' ? 'failed' : 'success';
          processPaymentCallback({ reference: payment.reference, status: outcome, amount: payment.amount });
          out.autoPayAttempts++;
        }
      }
    }
    return out;
  });
}

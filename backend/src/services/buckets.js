// Shared definitions so dashboard KPIs always reconcile with the filtered lists they link to.
import { today } from '../clock.js';
import { addDays } from '../utils/dates.js';
import { policyStatusAt } from './lifecycle.js';

export const CLOSED_APP = ['Issued', 'Rejected', 'Offer Declined'];
export const CLOSED_CLAIM = ['Settled', 'Rejected', 'Preauth Rejected'];
export const DUE_WINDOW_DAYS = 30;

export function nextUnpaid(policy) {
  return (policy.schedule || []).filter((i) => i.status !== 'paid').sort((a, b) => a.no - b.no)[0] || null;
}

export const BUCKETS = {
  policies: {
    active: (p) => ['Active', 'Grace Period'].includes(policyStatusAt(p)),
    due: (p) => {
      if (p.product !== 'life' || ['Terminated', 'Expired'].includes(policyStatusAt(p))) return false;
      const n = nextUnpaid(p);
      return !!n && n.dueDate <= addDays(today(), DUE_WINDOW_DAYS);
    },
  },
  applications: {
    pending: (a) => !CLOSED_APP.includes(a.status),
    action: (a) => ['Draft', 'More Information Required', 'Approved', 'Offer Accepted'].includes(a.status),
  },
  claims: {
    open: (c) => !CLOSED_CLAIM.includes(c.status),
  },
};

export function bucketFilter(kind, name) {
  if (!name) return () => true;
  const f = BUCKETS[kind]?.[name];
  return f || (() => true);
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** Formats integer paise as rupees. */
export const money = (paise) => (paise == null ? '—' : inr.format(paise / 100));

/** Parses a rupee string ("1,250.50") into exact integer paise without floating-point rounding. */
export function toPaise(input) {
  const s = String(input ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
export const toRupeesInput = (paise) => (paise == null ? '' : (paise / 100).toFixed(2).replace(/\.00$/, ''));

export const date = (s) => (s ? new Date(s.length === 10 ? `${s}T00:00:00Z` : s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
export const dateTime = (s) => (s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const pct = (bp) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const ROLE_LABEL = { customer: 'Customer', claimant: 'Claimant', agent: 'Insurance Agent', underwriter: 'Underwriter', claims_officer: 'Claims Officer', admin: 'Administrator' };

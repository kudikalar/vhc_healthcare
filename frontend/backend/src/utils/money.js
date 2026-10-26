// Money is always stored as integer paise (1 rupee = 100 paise) so arithmetic is exact.
// Percentages are basis points (10000 = 100%).
import { bad } from './errors.js';

export const pct = (amount, bp) => Math.round((amount * bp) / 10000);
export const sum = (arr, f = (x) => x) => arr.reduce((t, x) => t + f(x), 0);
export function assertPaise(v, name = 'amount', { allowZero = false } = {}) {
  if (!Number.isSafeInteger(v) || v < 0 || (!allowZero && v === 0)) {
    throw bad(`${name} must be a positive whole number of paise`);
  }
  return v;
}
export const rupees = (p) =>
  `Rs. ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

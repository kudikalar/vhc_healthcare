// All date-only values are ISO strings (YYYY-MM-DD) interpreted in UTC.
export const DAY_MS = 86400000;
export const toDate = (s) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
export const iso = (d) => d.toISOString().slice(0, 10);
export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = toDate(s);
  return !Number.isNaN(d.getTime()) && iso(d) === s;
}
export function addDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
export function addMonths(s, n) {
  const d = toDate(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
export const addYears = (s, n) => addMonths(s, n * 12);
/** b - a in whole days */
export const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);
export function ageOn(dob, on) {
  const b = toDate(dob), o = toDate(on);
  let age = o.getUTCFullYear() - b.getUTCFullYear();
  const m = o.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && o.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

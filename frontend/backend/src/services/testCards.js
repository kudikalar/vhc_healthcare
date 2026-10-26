// Test-mode payment methods. Only the published gateway test values below are accepted; any other
// card number / VPA / bank is rejected before use. Full card numbers, CVVs and OTPs are never stored or
// logged — a payment keeps only brand, last four digits and expiry (cards), the test VPA handle (UPI) or
// the simulated bank code (netbanking).
//
// Primary set: the Razorpay test-mode cards and VPAs (documented by the gateway for sandbox use).
// Legacy set: the original in-house simulator cards, kept so existing demos/tests keep working.
import { bad } from '../utils/errors.js';

export const TEST_OTP = '123456';

/** Razorpay test cards (primary). Each goes through the simulated bank OTP page before the outcome applies. */
export const RAZORPAY_CARDS = [
  { number: '4100280000001007', brand: 'Visa', outcome: 'success', label: 'Payment succeeds', set: 'razorpay', otp: true },
  { number: '5555510000081006', brand: 'Mastercard', outcome: 'success', label: 'Payment succeeds', set: 'razorpay', otp: true },
  { number: '4100280000080001', brand: 'Visa', outcome: 'failed', code: 'INSUFFICIENT_FUNDS', reason: 'Insufficient funds in the account', label: 'Insufficient funds', set: 'razorpay', otp: true },
  { number: '4100280000070002', brand: 'Visa', outcome: 'failed', code: 'PAYMENT_CANCELLED', reason: 'Payment cancelled by the customer on the bank page', label: 'Payment cancelled', set: 'razorpay', otp: true },
  { number: '4100280000060003', brand: 'Visa', outcome: 'failed', code: 'BANK_DECLINED', reason: 'Payment declined by the issuing bank', label: 'Bank declined', set: 'razorpay', otp: true },
];

/** Original simulator cards — still accepted, labelled "legacy simulator" in the checkout. */
export const LEGACY_CARDS = [
  { number: '4242424242424242', brand: 'Visa', outcome: 'success', label: 'Payment succeeds' },
  { number: '5555555555554444', brand: 'Mastercard', outcome: 'success', label: 'Payment succeeds' },
  { number: '6521500000000006', brand: 'RuPay', outcome: 'success', label: 'Payment succeeds' },
  { number: '378282246310005', brand: 'Amex', outcome: 'success', label: 'Payment succeeds (4-digit CVC)' },
  { number: '4000002760003184', brand: 'Visa', outcome: '3ds', label: 'Requires 3-D Secure OTP (use 123456)' },
  { number: '4000000000000259', brand: 'Visa', outcome: 'pending', label: 'Bank confirmation delayed (pending)' },
  { number: '4000000000000002', brand: 'Visa', outcome: 'failed', code: 'CARD_DECLINED', reason: 'Card declined by the issuing bank', label: 'Declined' },
  { number: '4000000000009995', brand: 'Visa', outcome: 'failed', code: 'INSUFFICIENT_FUNDS', reason: 'Insufficient funds', label: 'Insufficient funds' },
  { number: '4000000000000069', brand: 'Visa', outcome: 'failed', code: 'CARD_EXPIRED', reason: 'Card expired', label: 'Expired card' },
  { number: '4000000000000127', brand: 'Visa', outcome: 'failed', code: 'INCORRECT_CVC', reason: 'Incorrect CVC', label: 'Incorrect CVC' },
].map((c) => ({ ...c, set: 'legacy' }));

export const TEST_CARDS = [...RAZORPAY_CARDS, ...LEGACY_CARDS];

/** Razorpay test VPAs. Anything else is refused in test mode. */
export const TEST_VPAS = [
  { vpa: 'success@razorpay', outcome: 'success', label: 'UPI payment succeeds' },
  { vpa: 'failure@razorpay', outcome: 'failed', code: 'UPI_FAILED', reason: 'UPI payment failed (test VPA failure@razorpay)', label: 'UPI payment fails' },
];

/** Simulated netbanking banks (synthetic names — no real bank is represented). */
export const TEST_BANKS = [
  { code: 'SBXB_OK', name: 'Sandbox Bank A (succeeds)', outcome: 'success' },
  { code: 'SBXB_FAIL', name: 'Sandbox Bank B (fails)', outcome: 'failed', codeOnFail: 'NETBANKING_FAILED', reason: 'Netbanking authorisation failed at the simulated bank' },
  { code: 'SBXB_SLOW', name: 'Sandbox Bank C (delayed confirmation)', outcome: 'pending' },
  { code: 'SBXB_CHOICE', name: 'Sandbox Bank D (choose outcome on bank page)', outcome: 'choose' },
];

export const luhn = (n) => {
  let sum = 0;
  let alt = false;
  for (let i = n.length - 1; i >= 0; i -= 1) {
    let d = Number(n[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/** Validates the submitted card and returns the matching test card (never the raw number). */
export function resolveTestCard({ cardNumber, expMonth, expYear, cvc, name }, now = new Date()) {
  const number = String(cardNumber || '').replace(/[\s-]/g, '');
  const fields = {};
  const card = TEST_CARDS.find((c) => c.number === number);
  // Documented test numbers are accepted by exact match even if a number were to fail the Luhn check.
  if (!/^\d{13,19}$/.test(number) || (!card && !luhn(number))) fields.cardNumber = 'Enter a valid card number.';
  const m = Number(expMonth);
  let y = Number(expYear);
  if (y < 100) y += 2000;
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) fields.expiry = 'Enter the expiry as MM/YY.';
  else if (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1)) fields.expiry = 'This card has expired.';
  // Razorpay test cards accept any CVV (3 or 4 digits); legacy cards keep their brand-specific length.
  const cvcOk = card?.set === 'razorpay' ? /^\d{3,4}$/.test(String(cvc || '')) : new RegExp(`^\\d{${card?.brand === 'Amex' ? 4 : 3}}$`).test(String(cvc || ''));
  if (!cvcOk) fields.cvc = `Enter the ${card?.brand === 'Amex' ? 4 : 3}-digit security code.`;
  const holder = String(name || '').trim();
  if (holder.length < 2 || holder.length > 80) fields.name = 'Enter the name on the card.';
  if (Object.keys(fields).length) throw bad('Check your card details', { fields });
  if (!card) throw bad('Only test cards are accepted in this sandbox — no real cards or money. Choose one of the listed test cards.', { fields: { cardNumber: 'Use a test card number.' }, code: 'NOT_A_TEST_CARD' });
  return { ...card, number: undefined, last4: number.slice(-4), expMonth: m, expYear: y, holder };
}

export function resolveTestVpa(vpa) {
  const v = String(vpa || '').trim().toLowerCase();
  if (!/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/.test(v)) throw bad('Enter a valid UPI ID (for example name@bank).', { fields: { vpa: 'Enter a valid UPI ID.' } });
  const hit = TEST_VPAS.find((x) => x.vpa === v);
  if (!hit) throw bad('Only test UPI IDs work in this sandbox: success@razorpay or failure@razorpay.', { fields: { vpa: 'Use success@razorpay or failure@razorpay.' }, code: 'NOT_A_TEST_VPA' });
  return hit;
}

export function resolveTestBank(code) {
  const b = TEST_BANKS.find((x) => x.code === code);
  if (!b) throw bad('Choose one of the simulated sandbox banks.', { fields: { bank: 'Choose a bank.' } });
  return b;
}

/** Public view of the test methods for the checkout (numbers are public test values, not real cards). */
export const publicTestMethods = () => ({
  otp: TEST_OTP,
  cards: TEST_CARDS.map(({ number, brand, outcome, label, set, code }) => ({ number, brand, outcome, label: set === 'legacy' ? `${label} · legacy simulator` : label, set, code: code || null })),
  vpas: TEST_VPAS.map(({ vpa, outcome, label }) => ({ vpa, outcome, label })),
  banks: TEST_BANKS.map(({ code, name, outcome }) => ({ code, name, outcome })),
});

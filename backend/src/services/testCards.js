// Test-mode card gateway. Only the published test card numbers below are accepted; any other
// number is rejected before use. Full card numbers and CVCs are never stored or logged — a payment
// keeps only brand, last four digits and expiry.
import { bad } from '../utils/errors.js';

export const TEST_OTP = '123456';

export const TEST_CARDS = [
  { number: '4242424242424242', brand: 'Visa', outcome: 'success', label: 'Payment succeeds' },
  { number: '5555555555554444', brand: 'Mastercard', outcome: 'success', label: 'Payment succeeds' },
  { number: '6521500000000006', brand: 'RuPay', outcome: 'success', label: 'Payment succeeds' },
  { number: '378282246310005', brand: 'Amex', outcome: 'success', label: 'Payment succeeds (4-digit CVC)' },
  { number: '4000002760003184', brand: 'Visa', outcome: '3ds', label: 'Requires 3-D Secure OTP (use 123456)' },
  { number: '4000000000000259', brand: 'Visa', outcome: 'pending', label: 'Bank confirmation delayed (pending)' },
  { number: '4000000000000002', brand: 'Visa', outcome: 'failed', reason: 'Card declined by the issuing bank', label: 'Declined' },
  { number: '4000000000009995', brand: 'Visa', outcome: 'failed', reason: 'Insufficient funds', label: 'Insufficient funds' },
  { number: '4000000000000069', brand: 'Visa', outcome: 'failed', reason: 'Card expired', label: 'Expired card' },
  { number: '4000000000000127', brand: 'Visa', outcome: 'failed', reason: 'Incorrect CVC', label: 'Incorrect CVC' },
];

const luhn = (n) => {
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
  if (!/^\d{13,19}$/.test(number) || !luhn(number)) fields.cardNumber = 'Enter a valid card number.';
  const m = Number(expMonth);
  let y = Number(expYear);
  if (y < 100) y += 2000;
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) fields.expiry = 'Enter the expiry as MM/YY.';
  else if (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1)) fields.expiry = 'This card has expired.';
  const card = TEST_CARDS.find((c) => c.number === number);
  const cvcLen = card?.brand === 'Amex' ? 4 : 3;
  if (!new RegExp(`^\\d{${cvcLen}}$`).test(String(cvc || ''))) fields.cvc = `Enter the ${cvcLen}-digit security code.`;
  const holder = String(name || '').trim();
  if (holder.length < 2 || holder.length > 80) fields.name = 'Enter the name on the card.';
  if (Object.keys(fields).length) throw bad('Check your card details', { fields });
  if (!card) throw bad('Only test cards are accepted in this demo — no real cards or money. Choose one of the listed test cards.', { fields: { cardNumber: 'Use a test card number.' }, code: 'NOT_A_TEST_CARD' });
  return { ...card, number: undefined, last4: number.slice(-4), expMonth: m, expYear: y, holder };
}

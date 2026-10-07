import { useEffect, useState } from 'react';
import { api, ApiError, idempotencyKey } from '../api.js';
import { money } from '../format.js';
import { Alert, ErrorBox, Modal, useAction } from './ui.jsx';

/**
 * Test-mode card checkout. `target` = { purpose, applicationId?, policyId?, installmentNo? },
 * `amount` in paise (the server re-validates it). One idempotency key is kept per checkout so a
 * retry after a network failure never creates a duplicate payment. Only published test cards are
 * accepted by the server; card details are never stored in the browser.
 */
const brandOf = (n) => (/^4/.test(n) ? 'Visa' : /^5[1-5]/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : /^(60|65|81|82|508)/.test(n) ? 'RuPay' : '');
const fmtCard = (v) => {
  const d = v.replace(/\D/g, '').slice(0, 19);
  return /^3[47]/.test(d) ? d.replace(/^(\d{0,4})(\d{0,6})(\d{0,5}).*/, (m, a, b, c) => [a, b, c].filter(Boolean).join(' ')) : d.replace(/(\d{4})(?=\d)/g, '$1 ');
};
const fmtExp = (v) => { const d = v.replace(/\D/g, '').slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; };
const OUTCOME_KIND = { success: 'ok', '3ds': 'info', pending: 'warn', failed: 'error' };

let cardsCache;
function useTestCards(open) {
  const [cards, setCards] = useState(cardsCache || null);
  useEffect(() => {
    if (!open || cardsCache) return;
    api.get('/payments/test-cards').then((r) => { cardsCache = r; setCards(r); }).catch(() => {});
  }, [open]);
  return cards;
}

export default function PayButton({ target, amount, label = 'Pay now', onDone, className = 'btn' }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(idempotencyKey);
  const [payment, setPayment] = useState(null);
  const [card, setCard] = useState({ number: '', exp: '', cvc: '', name: '' });
  const [otpStep, setOtpStep] = useState(null);
  const [otp, setOtp] = useState('');
  const act = useAction();
  const tc = useTestCards(open);
  const digits = card.number.replace(/\D/g, '');
  const brand = brandOf(digits);
  const fields = act.error instanceof ApiError ? act.error.fields : {};

  const submit = (withOtp) => act.run(async () => {
    let p = payment;
    if (!p || p.status !== 'pending') {
      const r = await api.post('/payments/initiate', { ...target, amount, idempotencyKey: key, method: 'test-card' });
      p = r.payment;
      setPayment(p);
    }
    const [mm, yy] = card.exp.split('/');
    const out = await api.post(`/payments/${p.reference}/card`, { cardNumber: digits, expMonth: mm, expYear: yy, cvc: card.cvc, name: card.name, ...(withOtp ? { otp } : {}) });
    if (out.requiresAction === 'otp') { setOtpStep(out.card); return null; }
    setOtpStep(null);
    setOtp('');
    setPayment(out.payment);
    if (out.payment.status === 'failed') setKey(idempotencyKey()); // next attempt is a new payment
    return out.payment;
  });

  const fillCard = (c) => setCard({ number: fmtCard(c.number), exp: '12/30', cvc: c.brand === 'Amex' ? '1234' : '123', name: card.name || 'Test Customer' });

  const close = () => {
    if (payment?.status === 'success') setKey(idempotencyKey()); // a new checkout must never replay the old payment
    const paid = payment?.status === 'success' ? payment : null;
    setOpen(false);
    setPayment(null);
    setOtpStep(null);
    setOtp('');
    setCard({ number: '', exp: '', cvc: '', name: '' });
    act.setError(null);
    if (paid) onDone?.(paid); // refresh the page only after the customer has seen the confirmation
  };

  const done = payment?.status === 'success';
  const retry = () => { setPayment(null); act.setError(null); };

  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>{label} · {money(amount)}</button>
      <Modal open={open} title="Secure checkout" onClose={close} large>
        <div className="checkout">
          <div className="co-summary">
            <span className="eyebrow">Amount due</span>
            <div className="co-amount">{money(amount)}</div>
            <dl className="kv">
              <dt>Merchant</dt><dd>Vision Health Care (demo)</dd>
              <dt>For</dt><dd>{target.purpose === 'application' ? 'First premium · policy issuance' : target.purpose === 'installment' ? `Premium installment ${target.installmentNo ?? ''}` : target.purpose === 'reinstatement' ? 'Reinstatement arrears' : 'Premium'}</dd>
              <dt>Taxes</dt><dd>Not modelled</dd>
            </dl>
            <Alert kind="warn"><strong>Test mode.</strong> Only test cards work — no real card is charged and no money moves. Your policy is issued only after the gateway confirms the payment on the server.</Alert>
          </div>

          <div className="co-pay">
            {done ? (
              <div className="co-result ok">
                <div className="co-check" aria-hidden="true">✓</div>
                <h3>Payment successful</h3>
                <p>{money(payment.amount)} paid with {payment.card?.brand} •••• {payment.card?.last4}</p>
                <p className="muted">Reference <code>{payment.reference}</code></p>
                <button className="btn" onClick={close}>Done</button>
              </div>
            ) : payment?.status === 'pending' && !otpStep && payment.card ? (
              <div className="co-result warn">
                <h3>Waiting for bank confirmation</h3>
                <p>Payment <code>{payment.reference}</code> is pending. Don't pay again — we'll update it when the bank confirms. You can track it under Payments.</p>
                <button className="btn secondary" onClick={close}>Close</button>
              </div>
            ) : payment?.status === 'failed' ? (
              <div className="co-result error">
                <h3>Payment failed</h3>
                <p>{payment.failureReason || 'The card was declined.'} Nothing was charged.</p>
                <button className="btn" onClick={retry}>Try another card</button>
              </div>
            ) : otpStep ? (
              <form className="co-otp" onSubmit={(e) => { e.preventDefault(); submit(true); }}>
                <span className="eyebrow">3-D Secure</span>
                <h3>Verify it's you</h3>
                <p>Your bank sent a one-time password for the {otpStep.brand} card ending {otpStep.last4}. <span className="muted">(Test OTP: {tc?.otp || '123456'})</span></p>
                <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} aria-label="One-time password" autoFocus />
                <ErrorBox error={act.error} />
                <div className="row end" style={{ marginTop: '.8rem' }}>
                  <button type="button" className="btn secondary" onClick={() => setOtpStep(null)}>Cancel</button>
                  <button className="btn" disabled={act.busy || otp.length !== 6}>{act.busy ? 'Verifying…' : `Verify & pay ${money(amount)}`}</button>
                </div>
              </form>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); submit(false); }} noValidate>
                <label className="field">Card number
                  <span className="card-input">
                    <input inputMode="numeric" autoComplete="off" placeholder="4242 4242 4242 4242" value={card.number} aria-invalid={!!fields.cardNumber}
                      onChange={(e) => setCard((c) => ({ ...c, number: fmtCard(e.target.value) }))} />
                    {brand && <span className="card-brand">{brand}</span>}
                  </span>
                  {fields.cardNumber && <span className="err">{fields.cardNumber}</span>}
                </label>
                <div className="form-row-2" style={{ marginTop: '.8rem' }}>
                  <label className="field">Expiry
                    <input inputMode="numeric" autoComplete="off" placeholder="MM/YY" value={card.exp} aria-invalid={!!fields.expiry} onChange={(e) => setCard((c) => ({ ...c, exp: fmtExp(e.target.value) }))} />
                    {fields.expiry && <span className="err">{fields.expiry}</span>}
                  </label>
                  <label className="field">CVC
                    <input inputMode="numeric" autoComplete="off" type="password" placeholder={brand === 'Amex' ? '4 digits' : '3 digits'} maxLength={4} value={card.cvc} aria-invalid={!!fields.cvc} onChange={(e) => setCard((c) => ({ ...c, cvc: e.target.value.replace(/\D/g, '') }))} />
                    {fields.cvc && <span className="err">{fields.cvc}</span>}
                  </label>
                </div>
                <label className="field" style={{ marginTop: '.8rem' }}>Name on card
                  <input autoComplete="off" value={card.name} aria-invalid={!!fields.name} onChange={(e) => setCard((c) => ({ ...c, name: e.target.value }))} />
                  {fields.name && <span className="err">{fields.name}</span>}
                </label>
                {act.error && !Object.keys(fields).length && <ErrorBox error={act.error} />}
                {act.error && Object.keys(fields).length > 0 && <Alert kind="error">{act.error.message}</Alert>}
                <button className="btn block" style={{ marginTop: '1rem' }} disabled={act.busy}>{act.busy ? 'Processing…' : `Pay ${money(amount)}`}</button>

                <details className="test-cards" open>
                  <summary>Test cards</summary>
                  <p className="muted">Click a card to fill it in. Any future expiry and any CVC work.</p>
                  <ul>
                    {(tc?.cards || []).map((c) => (
                      <li key={c.number}>
                        <button type="button" onClick={() => fillCard(c)}>
                          <span className="tc-num">{fmtCard(c.number)}</span>
                          <span className="tc-brand">{c.brand}</span>
                          <span className={`badge ${OUTCOME_KIND[c.outcome]}`}>{c.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </form>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

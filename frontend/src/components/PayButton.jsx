import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, idempotencyKey } from '../api.js';
import { money } from '../format.js';
import { Alert, ErrorBox, Modal, useAction } from './ui.jsx';
import '../pages/enterprise/enterprise.css';

/**
 * Test-mode checkout (Razorpay sandbox simulation): card (with simulated bank OTP page), UPI collect,
 * UPI QR and netbanking. `target` = { purpose, applicationId?, policyId?, installmentNo?, linkCode? },
 * `amount` in paise (the server re-validates it). One idempotency key is kept per checkout so a retry after
 * a network failure never creates a duplicate payment. Only published test values are accepted by the
 * server; card details live only in this component's memory and are never stored.
 */
const brandOf = (n) => (/^4/.test(n) ? 'Visa' : /^5[1-5]/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : /^(60|65|81|82|508)/.test(n) ? 'RuPay' : '');
const fmtCard = (v) => {
  const d = v.replace(/\D/g, '').slice(0, 19);
  return /^3[47]/.test(d) ? d.replace(/^(\d{0,4})(\d{0,6})(\d{0,5}).*/, (m, a, b, c) => [a, b, c].filter(Boolean).join(' ')) : d.replace(/(\d{4})(?=\d)/g, '$1 ');
};
const fmtExp = (v) => { const d = v.replace(/\D/g, '').slice(0, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; };
const OUTCOME_KIND = { success: 'ok', '3ds': 'info', pending: 'warn', failed: 'error' };
const METHODS = [['card', 'Card'], ['upi', 'UPI ID'], ['qr', 'UPI QR'], ['netbanking', 'Netbanking']];

let methodsCache;
function useMethods(open) {
  const [m, setM] = useState(methodsCache || null);
  useEffect(() => {
    if (!open || methodsCache) return;
    api.get('/payments/methods').then((r) => { methodsCache = r; setM(r); }).catch(() => {});
  }, [open]);
  return m;
}

/** Decorative, deterministic QR-like pattern for the simulated UPI QR (not scannable — sandbox only). */
function FakeQr({ text }) {
  const cells = useMemo(() => {
    let h = 2166136261;
    const out = [];
    for (let i = 0; i < 625; i += 1) { h ^= text.charCodeAt(i % text.length) + i; h = Math.imul(h, 16777619) >>> 0; out.push(h % 3 === 0); }
    return out;
  }, [text]);
  const finder = (x, y) => (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17);
  return (
    <svg viewBox="0 0 25 25" role="img" aria-label="Simulated UPI QR code (not scannable)" shapeRendering="crispEdges">
      <rect width="25" height="25" fill="#fff" />
      {cells.map((on, i) => { const x = i % 25; const y = Math.floor(i / 25); return !finder(x, y) && on ? <rect key={i} x={x} y={y} width="1" height="1" fill="#14283f" /> : null; })}
      {[[0, 0], [18, 0], [0, 18]].map(([x, y]) => <g key={`${x}${y}`}><rect x={x} y={y} width="7" height="7" fill="#14283f" /><rect x={x + 1} y={y + 1} width="5" height="5" fill="#fff" /><rect x={x + 2} y={y + 2} width="3" height="3" fill="#14283f" /></g>)}
    </svg>
  );
}

export default function PayButton({ target, amount, label = 'Pay now', onDone, className = 'btn' }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(idempotencyKey);
  const [payment, setPayment] = useState(null);
  const [method, setMethod] = useState('card');
  const [card, setCard] = useState({ number: '', exp: '', cvc: '', name: '' });
  const [otpStep, setOtpStep] = useState(null);
  const [otp, setOtp] = useState('');
  const [vpa, setVpa] = useState('');
  const [qr, setQr] = useState(null);
  const [bank, setBank] = useState('');
  const [bankPage, setBankPage] = useState(null);
  const act = useAction();
  const tm = useMethods(open);
  const digits = card.number.replace(/\D/g, '');
  const brand = brandOf(digits);
  const fields = act.error instanceof ApiError ? act.error.fields : {};

  /** Creates (or resumes) the payment for this checkout. */
  const ensurePayment = async () => {
    if (payment && payment.status === 'pending') return payment;
    const r = await api.post('/payments/initiate', { ...target, amount, idempotencyKey: key, method });
    setPayment(r.payment);
    return r.payment;
  };
  const finish = (out) => {
    setPayment(out.payment);
    if (['failed', 'expired'].includes(out.payment.status)) setKey(idempotencyKey()); // next attempt is a new payment
    return out.payment;
  };

  const payCard = (extra = {}) => act.run(async () => {
    const p = await ensurePayment();
    const [mm, yy] = card.exp.split('/');
    const out = await api.post(`/payments/${p.reference}/card`, { cardNumber: digits, expMonth: mm, expYear: yy, cvc: card.cvc, name: card.name, ...extra });
    if (out.requiresAction === 'otp') { setOtpStep({ ...out.card, bank: out.bank }); return null; }
    setOtpStep(null);
    setOtp('');
    return finish(out);
  });
  const payUpi = () => act.run(async () => { const p = await ensurePayment(); return finish(await api.post(`/payments/${p.reference}/upi`, { vpa })); });
  const loadQr = () => act.run(async () => { const p = await ensurePayment(); setQr(await api.get(`/payments/${p.reference}/upi-qr`)); });
  const scanQr = (outcome) => act.run(async () => { const p = await ensurePayment(); return finish(await api.post(`/payments/${p.reference}/upi-qr`, { outcome })); });
  const payBank = (outcome) => act.run(async () => {
    const p = await ensurePayment();
    const out = await api.post(`/payments/${p.reference}/netbanking`, { bank, outcome });
    if (out.requiresAction === 'bank') { setBankPage(out.bank); return null; }
    setBankPage(null);
    return finish(out);
  });

  const fillCard = (c) => setCard({ number: fmtCard(c.number), exp: '12/30', cvc: c.brand === 'Amex' ? '1234' : '123', name: card.name || 'Test Customer' });

  const close = () => {
    if (payment?.status === 'success') setKey(idempotencyKey()); // a new checkout must never replay the old payment
    const paid = payment?.status === 'success' ? payment : null;
    setOpen(false);
    setPayment(null);
    setOtpStep(null);
    setOtp('');
    setQr(null);
    setBankPage(null);
    setCard({ number: '', exp: '', cvc: '', name: '' });
    act.setError(null);
    if (paid) onDone?.(paid); // refresh the page only after the customer has seen the confirmation
  };

  const done = payment?.status === 'success';
  const retry = () => { setPayment(null); setQr(null); setBankPage(null); act.setError(null); };
  const paidWith = (p) => (p.card ? `${p.card.brand} •••• ${p.card.last4}` : p.upi ? (p.upi.qr ? 'UPI QR' : `UPI ${p.upi.vpa}`) : p.netbanking ? p.netbanking.bankName : 'test gateway');
  const razorpay = (tm?.cards || []).filter((c) => c.set === 'razorpay');
  const legacy = (tm?.cards || []).filter((c) => c.set === 'legacy');
  const cardList = (list) => (
    <ul>
      {list.map((c) => (
        <li key={c.number}>
          <button type="button" onClick={() => fillCard(c)}>
            <span className="tc-num">{fmtCard(c.number)}</span>
            <span className="tc-brand">{c.brand}</span>
            <span className={`badge ${OUTCOME_KIND[c.outcome]}`}>{c.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  let body;
  if (done) {
    body = (
      <div className="co-result ok">
        <div className="co-check" aria-hidden="true">✓</div>
        <h3>Payment successful</h3>
        <p>{money(payment.amount)} paid with {paidWith(payment)}</p>
        <p className="muted">Reference <code>{payment.reference}</code>{target.purpose === 'application' ? '. The insurer now confirms issuance — you will be notified when your policy is issued.' : ''}</p>
        <button className="btn" onClick={close}>Done</button>
      </div>
    );
  } else if (payment?.status === 'pending' && payment.attempts?.length && !otpStep && !bankPage) {
    body = (
      <div className="co-result warn">
        <h3>Waiting for bank confirmation</h3>
        <p>Payment <code>{payment.reference}</code> is pending. Don't pay again — it updates automatically when the bank confirms, and expires uncharged if it never does. You can track it under Payments.</p>
        <button className="btn secondary" onClick={close}>Close</button>
      </div>
    );
  } else if (['failed', 'expired'].includes(payment?.status)) {
    body = (
      <div className="co-result error">
        <h3>{payment.status === 'expired' ? 'Payment timed out' : 'Payment failed'}</h3>
        <p>{payment.failureReason || 'The payment was declined.'} Nothing was charged.</p>
        <button className="btn" onClick={retry}>Try again</button>
      </div>
    );
  } else if (otpStep) {
    body = (
      <form className="co-bank" onSubmit={(e) => { e.preventDefault(); payCard({ otp }); }}>
        <div className="bank-head"><span>{otpStep.bank || 'Sandbox bank'}</span><span className="badge warn">Simulated</span></div>
        <h3 style={{ marginTop: 0 }}>Verify it's you</h3>
        <p>Enter the one-time password for the {otpStep.brand} card ending {otpStep.last4}. <span className="muted">(Test OTP: {tm?.otp || '123456'})</span></p>
        <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} aria-label="One-time password" autoFocus />
        <ErrorBox error={act.error} />
        <div className="row end" style={{ marginTop: '.8rem' }}>
          <button type="button" className="btn ghost" disabled={act.busy} onClick={() => payCard({ bankAction: 'fail' })}>Fail authentication</button>
          <button type="button" className="btn secondary" disabled={act.busy} onClick={() => payCard({ bankAction: 'cancel' })}>Cancel payment</button>
          <button className="btn" disabled={act.busy || otp.length !== 6}>{act.busy ? 'Verifying…' : `Verify & pay ${money(amount)}`}</button>
        </div>
      </form>
    );
  } else if (bankPage) {
    body = (
      <div className="co-bank">
        <div className="bank-head"><span>{bankPage.name}</span><span className="badge warn">Simulated bank page</span></div>
        <p>Approve the netbanking payment of {money(amount)} to Vision Health Care (sandbox)?</p>
        <ErrorBox error={act.error} />
        <div className="row end"><button className="btn danger" disabled={act.busy} onClick={() => payBank('failed')}>Decline</button><button className="btn" disabled={act.busy} onClick={() => payBank('success')}>Approve</button></div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="co-methods" role="tablist" aria-label="Payment method">
          {METHODS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={method === k} onClick={() => { setMethod(k); act.setError(null); }}>{l}</button>)}
        </div>
        {method === 'card' && (
          <form onSubmit={(e) => { e.preventDefault(); payCard(); }} noValidate>
            <label className="field">Card number
              <span className="card-input">
                <input inputMode="numeric" autoComplete="off" placeholder="4100 2800 0000 1007" value={card.number} aria-invalid={!!fields.cardNumber}
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
              <label className="field">CVV
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
              <summary>Razorpay test cards</summary>
              <p className="muted">Click a card to fill it in. Any future expiry and any CVV work; the bank OTP page accepts 123456.</p>
              {cardList(razorpay)}
            </details>
            <details className="test-cards">
              <summary>Legacy simulator cards</summary>
              {cardList(legacy)}
            </details>
          </form>
        )}
        {method === 'upi' && (
          <form onSubmit={(e) => { e.preventDefault(); payUpi(); }}>
            <label className="field">UPI ID
              <input autoComplete="off" value={vpa} onChange={(e) => setVpa(e.target.value.trim())} placeholder="success@razorpay" aria-invalid={!!fields.vpa} />
              {fields.vpa && <span className="err">{fields.vpa}</span>}
            </label>
            <div className="row" style={{ marginTop: '.5rem' }}>{(tm?.vpas || []).map((v) => <button key={v.vpa} type="button" className="btn sm secondary" onClick={() => setVpa(v.vpa)}>{v.vpa}</button>)}</div>
            {act.error && <ErrorBox error={act.error} />}
            <button className="btn block" style={{ marginTop: '1rem' }} disabled={act.busy || !vpa}>{act.busy ? 'Waiting for approval…' : `Pay ${money(amount)} via UPI`}</button>
            <p className="muted" style={{ fontSize: '.85rem' }}>Test VPAs: success@razorpay succeeds, failure@razorpay fails. Real UPI IDs are refused.</p>
          </form>
        )}
        {method === 'qr' && (
          <div className="co-qr">
            {!qr ? <button className="btn" disabled={act.busy} onClick={loadQr}>Show UPI QR</button> : (
              <>
                <FakeQr text={qr.payload} />
                <p className="muted" style={{ fontSize: '.85rem', maxWidth: 320 }}>{qr.note}</p>
                <div className="row"><button className="btn" disabled={act.busy} onClick={() => scanQr('success')}>Simulate successful scan</button><button className="btn secondary" disabled={act.busy} onClick={() => scanQr('failed')}>Simulate failed scan</button></div>
              </>
            )}
            <ErrorBox error={act.error} />
          </div>
        )}
        {method === 'netbanking' && (
          <form onSubmit={(e) => { e.preventDefault(); payBank(); }}>
            <label className="field">Bank (simulated)
              <select value={bank} onChange={(e) => setBank(e.target.value)} required>
                <option value="">Choose a bank…</option>
                {(tm?.banks || []).map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
              </select>
            </label>
            {act.error && <ErrorBox error={act.error} />}
            <button className="btn block" style={{ marginTop: '1rem' }} disabled={act.busy || !bank}>{act.busy ? 'Redirecting…' : `Continue to bank · ${money(amount)}`}</button>
          </form>
        )}
      </>
    );
  }

  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>{label} · {money(amount)}</button>
      <Modal open={open} title="Secure checkout" onClose={close} large>
        <div className="checkout">
          <div className="co-summary">
            <span className="eyebrow">Amount due</span>
            <div className="co-amount">{money(amount)}</div>
            <dl className="kv">
              <dt>Merchant</dt><dd>Vision Health Care (sandbox)</dd>
              <dt>For</dt><dd>{target.purpose === 'application' ? 'First premium · insurer issues the policy after payment' : target.purpose === 'installment' ? `Premium installment ${target.installmentNo ?? ''}` : target.purpose === 'reinstatement' ? 'Reinstatement arrears' : 'Premium'}</dd>
              <dt>Gateway</dt><dd>Razorpay-style test mode</dd>
            </dl>
            <Alert kind="warn"><strong>Test mode.</strong> Only published test cards, test UPI IDs and simulated banks work — no real money moves. We never store card numbers, CVV or OTPs.</Alert>
          </div>
          <div className="co-pay">{body}</div>
        </div>
      </Modal>
    </>
  );
}

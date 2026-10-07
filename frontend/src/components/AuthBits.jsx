import { useEffect, useId, useState } from 'react';
import { Alert, DevHint } from './ui.jsx';

/** Password input with a show/hide toggle. Never trims the value. */
export function PasswordField({ label, value, onChange, error, autoComplete = 'current-password', hint, name, placeholder }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      {label}
      {hint && <span className="hint">{hint}</span>}
      <div className="pw-wrap">
        <input id={id} name={name} type={show ? 'text' : 'password'} autoComplete={autoComplete} placeholder={placeholder} value={value}
          onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} />
        <button type="button" className="pw-toggle" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {error && <span className="err" id={`${id}-err`}>{error}</span>}
    </label>
  );
}

/** Counts down to zero once per second; restart() begins again from `seconds`. */
export function useCountdown(initial = 0) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((x) => x - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft];
}

export function useMinutesUntil(iso) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 15000); return () => clearInterval(t); }, []);
  if (!iso) return null;
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
}

/**
 * One-time-code entry: masked destination, single numeric input (typing and paste both work),
 * expiry helper, Verify button and a resend countdown.
 */
export function OtpCard({ destination, expiresAt, onVerify, onResend, busy, error, devCode, resendAfter = 60, title = 'Enter your verification code' }) {
  const [code, setCode] = useState('');
  const [left, setLeft] = useCountdown(resendAfter);
  const mins = useMinutesUntil(expiresAt);
  const id = useId();
  const submit = (e) => { e.preventDefault(); if (code.length === 6) onVerify(code); };
  return (
    <form onSubmit={submit} className="stack">
      <div>
        <h3 style={{ marginBottom: '.2rem' }}>{title}</h3>
        <p className="muted" style={{ margin: 0 }}>We sent a 6-digit code to <strong>{destination}</strong>.</p>
      </div>
      <label htmlFor={id} className="sr-only">Verification code</label>
      <input id={id} className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-invalid={!!error}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onPaste={(e) => { e.preventDefault(); setCode(e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)); }} />
      {mins != null && <small className="muted">{mins > 0 ? `The code expires in about ${mins} minute${mins === 1 ? '' : 's'}.` : 'This code has expired — request a new one.'}</small>}
      {error && <Alert kind="error">{error}</Alert>}
      <button className="btn block" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify'}</button>
      {onResend && (
        <div className="row between">
          <small className="muted">Didn't get it?</small>
          <button type="button" className="btn ghost sm" disabled={left > 0 || busy} onClick={async () => { if (await onResend()) { setLeft(resendAfter); setCode(''); } }}>
            {left > 0 ? `Resend in ${left}s` : 'Resend code'}
          </button>
        </div>
      )}
      {devCode && <DevHint>code is <code>{devCode}</code></DevHint>}
    </form>
  );
}

/** Brand panel used on the left of registration / sign-in pages. */
export function AuthBrandPanel({ title = 'Cover that is clear from the first click.', subtitle = 'Health and life insurance with transparent pricing, simple claims and no surprises.' }) {
  return (
    <aside className="auth-brand" aria-hidden="false">
      <img src="/logo.png" alt="Vision Health Care" className="auth-logo" />
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <ul className="auth-points">
        <li><span className="tick">✓</span><span>Instant quotes with a full price breakdown — no hidden loadings.</span></li>
        <li><span className="tick">✓</span><span>Track applications, premiums and claims in one place.</span></li>
        <li><span className="tick">✓</span><span>We never ask for medical or bank details when you sign up.</span></li>
      </ul>
    </aside>
  );
}

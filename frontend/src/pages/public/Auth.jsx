import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, idempotencyKey } from '../../api.js';
import { homeFor, useAuth } from '../../auth.jsx';
import { Alert, Card, DevHint, ErrorBox, Field, Loading, useAction } from '../../components/ui.jsx';
import { AuthBrandPanel, PasswordField, useCountdown } from '../../components/AuthBits.jsx';

const DEMO_PASSWORD = 'VisionDemo#2026';
const DEMO = [
  ['customer@vhc.test', 'Customer'], ['customer2@vhc.test', 'Customer 2'], ['agent@vhc.test', 'Agent'], ['underwriter@vhc.test', 'Underwriter'],
  ['claims@vhc.test', 'Claims officer'], ['claims2@vhc.test', 'Claims officer 2'], ['admin@vhc.test', 'Admin'],
];

// Client-side checks mirror the server rules; the server remains authoritative.
const NAME_RE = /^[\p{L}\p{M}'’ -]+$/u;
const nameOk = (v, required) => { const s = v.trim(); if (!s) return !required; return [...s].length <= 60 && NAME_RE.test(s) && /\p{L}/u.test(s); };
const emailOk = (v) => v.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
const mobileOk = (v) => { let d = v.replace(/[\s\-().]/g, ''); if (d.startsWith('+91')) d = d.slice(3); else if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); return /^[6-9]\d{9}$/.test(d); };
const pwLen = (p) => [...p].length;
const PW_MSG = 'Use 12–128 characters and choose a stronger password.';

function useFieldErrors() {
  const [errs, setErrs] = useState({});
  const fromError = (e) => { if (e instanceof ApiError && Object.keys(e.fields).length) setErrs(e.fields); };
  return [errs, setErrs, fromError];
}

// ---------------- M03 login ----------------
export function Login() {
  const { login, expired, setExpired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [form, setForm] = useState({ email: '', password: '', remember: false });
  const [errs, setErrs] = useState({});
  const [unverified, setUnverified] = useState(false);
  const act = useAction();

  const submit = (e) => {
    e.preventDefault();
    const fe = {};
    if (!emailOk(form.email)) fe.email = 'Enter a valid email address.';
    if (!form.password) fe.password = 'Enter your password.';
    setErrs(fe);
    if (Object.keys(fe).length) return;
    setUnverified(false);
    act.run(async () => {
      try {
        const u = await login(form.email, form.password, form.remember);
        setExpired(false);
        nav(loc.state?.from && !loc.state.from.startsWith('/login') ? loc.state.from : homeFor(u), { replace: true });
      } catch (err) {
        if (err.details?.code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
        throw err;
      }
    });
  };

  return (
    <div className="auth-split">
      <AuthBrandPanel title="Welcome back." subtitle="Sign in to manage your policies, premiums and claims." />
      <div className="auth-pane">
        <div className="auth-card">
          <Card>
            <h1 className="auth-title">Sign in</h1>
            <p className="auth-sub">Use the email address you registered with.</p>
            {expired && <Alert kind="warn">Your session has ended. Please sign in again.</Alert>}
            {act.error && !unverified && (
              <Alert kind="error" >{act.error.message}{act.error.status === 429 && <> <Link to="/forgot-password">Reset your password</Link></>}</Alert>
            )}
            {unverified && <Alert kind="warn">Verify your email address before signing in. <Link to={`/verify-email?email=${encodeURIComponent(form.email)}`}>Resend the link</Link></Alert>}
            <form onSubmit={submit} className="stack" noValidate>
              <Field label="Email address" error={errs.email}>
                <input type="email" autoComplete="username" maxLength={254} value={form.email} aria-invalid={!!errs.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <PasswordField label="Password" value={form.password} error={errs.password} onChange={(password) => setForm({ ...form, password })} />
              <div className="row between">
                <label className="check"><input type="checkbox" checked={form.remember} onChange={(e) => setForm({ ...form, remember: e.target.checked })} /> Remember this device for 7 days</label>
                <Link to="/forgot-password" style={{ fontSize: '.88rem' }}>Forgot password?</Link>
              </div>
              <button className="btn block" disabled={act.busy}>{act.busy ? 'Signing in…' : 'Sign in'}</button>
              <p className="muted" style={{ textAlign: 'center', margin: 0 }}>New here? <Link to="/register">Create an account</Link></p>
            </form>
            <small className="muted" style={{ display: 'block', marginTop: '.75rem' }}>"Remember this device" is ignored for staff accounts. Use it only on a personal device.</small>
          </Card>
          <Card>
            <div className="divider-text" style={{ marginTop: 0 }}>Fictional demo accounts</div>
            <div className="demo-grid">
              {DEMO.map(([email, label]) => <button key={email} type="button" className="btn sm secondary" onClick={() => setForm({ ...form, email, password: DEMO_PASSWORD })}>{label}</button>)}
            </div>
            <p className="muted" style={{ marginBottom: 0, fontSize: '.84rem' }}>Password: <code>{DEMO_PASSWORD}</code>. Claimants use <Link to="/life-claim">Report a life claim</Link> instead.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------- M01 registration ----------------
export function Register() {
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', mobile: '', password: '', confirmPassword: '', acceptTerms: false, marketingOptIn: false });
  const [errs, setErrs, fromError] = useFieldErrors();
  const [done, setDone] = useState(null);
  const act = useAction();
  const key = useRef(idempotencyKey());
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const validate = () => {
    const e = {};
    if (!nameOk(f.firstName, true)) e.firstName = 'Enter your first name.';
    if (!nameOk(f.lastName, false)) e.lastName = 'Use letters, spaces, apostrophes or hyphens.';
    if (!emailOk(f.email)) e.email = 'Enter a valid email address.';
    if (!mobileOk(f.mobile)) e.mobile = 'Enter a valid 10-digit mobile number.';
    if (pwLen(f.password) < 12 || pwLen(f.password) > 128) e.password = PW_MSG;
    if (f.confirmPassword !== f.password) e.confirmPassword = 'Passwords do not match.';
    if (!f.acceptTerms) e.acceptTerms = 'Accept the terms and acknowledge the privacy notice.';
    return e;
  };
  const submit = (ev) => {
    ev.preventDefault();
    const e = validate();
    setErrs(e);
    if (Object.keys(e).length) return;
    act.run(async () => {
      try {
        const mobile = f.mobile.trim().startsWith('+') ? f.mobile : `+91${f.mobile.replace(/\D/g, '').slice(-10)}`;
        setDone(await api.post('/auth/register', { ...f, mobile, idempotencyKey: key.current }));
      } catch (err) { fromError(err); throw err; }
    });
  };

  if (done) {
    return (
      <div className="center-card">
        <Card>
          <div className="icon-circle">✉</div>
          <h1 style={{ fontSize: '1.35rem' }}>Check your email</h1>
          <p className="muted">{done.message}</p>
          <p className="muted" style={{ fontSize: '.86rem' }}>The link is valid for 24 hours. You can sign in once your email is verified.</p>
          {done.devVerificationToken && <DevHint>emails are simulated. <Link to={`/verify-email?token=${done.devVerificationToken}`}>Open the verification link</Link></DevHint>}
          <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
            <Link className="btn secondary" to={`/verify-email?email=${encodeURIComponent(f.email)}`}>Resend link</Link>
            <Link className="btn" to="/login">Go to sign in</Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-split">
      <AuthBrandPanel />
      <div className="auth-pane">
        <div className="auth-card">
          <Card>
            <h1 className="auth-title">Create your account</h1>
            <p className="auth-sub">It takes a minute. You'll verify your email before you can sign in.</p>
            {act.error && !Object.keys(errs).length && <ErrorBox error={act.error} />}
            {Object.keys(errs).length > 0 && <Alert kind="error">Please correct the highlighted fields.</Alert>}
            <form onSubmit={submit} className="stack" noValidate>
              <div className="form-row-2">
                <Field label="First name" error={errs.firstName}><input autoComplete="given-name" maxLength={60} value={f.firstName} onChange={set('firstName')} aria-invalid={!!errs.firstName} /></Field>
                <Field label="Last name" hint="Optional" error={errs.lastName}><input autoComplete="family-name" maxLength={60} value={f.lastName} onChange={set('lastName')} aria-invalid={!!errs.lastName} /></Field>
              </div>
              <Field label="Email address" error={errs.email}><input type="email" autoComplete="email" maxLength={254} value={f.email} onChange={set('email')} aria-invalid={!!errs.email} /></Field>
              <Field label="Mobile number" hint="India only, 10 digits" error={errs.mobile}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: '.4rem' }}>
                  <span className="badge" style={{ marginTop: '.3rem', padding: '.5rem .6rem' }}>+91</span>
                  <input type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={f.mobile} onChange={set('mobile')} aria-invalid={!!errs.mobile} />
                </div>
              </Field>
              <PasswordField label="Password" hint={`12–128 characters. Spaces are fine — a passphrase works well. (${pwLen(f.password)}/128)`} autoComplete="new-password" value={f.password} error={errs.password} onChange={(password) => setF({ ...f, password })} />
              <PasswordField label="Confirm password" autoComplete="new-password" value={f.confirmPassword} error={errs.confirmPassword} onChange={(confirmPassword) => setF({ ...f, confirmPassword })} />
              <div>
                <label className="check"><input type="checkbox" checked={f.acceptTerms} onChange={set('acceptTerms')} aria-invalid={!!errs.acceptTerms} />
                  <span>I accept the <a href="#terms" onClick={(e) => e.preventDefault()}>terms of use</a> and acknowledge the <a href="#privacy" onClick={(e) => e.preventDefault()}>privacy notice</a>.</span></label>
                {errs.acceptTerms && <span className="field-error">{errs.acceptTerms}</span>}
              </div>
              <label className="check"><input type="checkbox" checked={f.marketingOptIn} onChange={set('marketingOptIn')} /> <span>Send me product news and offers (optional — you can stop anytime).</span></label>
              <button className="btn block" disabled={act.busy}>{act.busy ? 'Creating account…' : 'Create account'}</button>
              <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Already have an account? <Link to="/login">Sign in</Link></p>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------- M02 email verification ----------------
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [email, setEmail] = useState(params.get('email') || '');
  const verify = useAction();
  const resend = useAction();
  const [left, setLeft] = useCountdown(0);
  const [devToken, setDevToken] = useState(null);
  const ran = useRef(false);
  useEffect(() => {
    if (token && !ran.current) { ran.current = true; verify.run(() => api.post('/auth/verify-email', { token }), (r) => r.message); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const doResend = () => resend.run(async () => {
    const r = await api.post('/auth/resend-verification', { email });
    setLeft(r.resendAfterSeconds || 60);
    setDevToken(r.devVerificationToken || null);
    return r;
  }, (r) => `${r.message} (${r.destination})`);

  return (
    <div className="center-card">
      <Card>
        <div className="icon-circle">{verify.message ? '✓' : '✉'}</div>
        <h1 style={{ fontSize: '1.35rem' }}>{verify.message ? 'Email verified' : 'Verify your email'}</h1>
        {token && verify.busy && <Loading text="Checking your link…" />}
        {verify.message && <><p className="muted">{verify.message}</p><Link className="btn block" to="/login">Sign in</Link></>}
        {verify.error && <Alert kind="error">{verify.error.message}</Alert>}
        {(!token || verify.error) && (
          <form className="stack" style={{ textAlign: 'left' }} onSubmit={(e) => { e.preventDefault(); doResend(); }}>
            <p className="muted" style={{ textAlign: 'center', margin: 0 }}>Enter your email and we'll send a new link. Links expire after 24 hours, and a new link replaces older ones.</p>
            <Field label="Email address"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <button className="btn block" disabled={resend.busy || left > 0 || !emailOk(email)}>{left > 0 ? `Resend available in ${left}s` : 'Send a new link'}</button>
            {resend.message && <Alert kind="ok">{resend.message}</Alert>}
            {resend.error && <Alert kind="error">{resend.error.message}</Alert>}
            {devToken && <DevHint><Link to={`/verify-email?token=${devToken}`} onClick={() => { ran.current = false; }}>Open the new verification link</Link></DevHint>}
          </form>
        )}
      </Card>
    </div>
  );
}

// ---------------- M03 recovery ----------------
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState(null);
  const act = useAction();
  const [res, setRes] = useState(null);
  return (
    <div className="center-card">
      <Card>
        <div className="icon-circle">🔑</div>
        <h1 style={{ fontSize: '1.35rem' }}>Reset your password</h1>
        <form className="stack" style={{ textAlign: 'left' }} noValidate onSubmit={(e) => {
          e.preventDefault();
          if (!emailOk(email)) { setErr('Enter a valid email address.'); return; }
          setErr(null);
          act.run(async () => setRes(await api.post('/auth/forgot-password', { email })));
        }}>
          <p className="muted" style={{ margin: 0, textAlign: 'center' }}>We'll email a reset link that works once and expires in 30 minutes.</p>
          <Field label="Email address" error={err}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!err} /></Field>
          <button className="btn block" disabled={act.busy}>Send reset link</button>
          {res && <Alert kind="ok">{res.message}</Alert>}
          {res?.devResetToken && <DevHint><Link to={`/reset-password?token=${res.devResetToken}`}>Open the reset link</Link></DevHint>}
          <ErrorBox error={act.error} />
          <p style={{ textAlign: 'center', margin: 0 }}><Link to="/login">Back to sign in</Link></p>
        </form>
      </Card>
    </div>
  );
}

function SetPasswordForm({ checkPath, submitPath, title, intro, successText }) {
  const [params] = useSearchParams();
  const token = params.get('token');
  const check = useLoad2(() => api.get(`${checkPath}?token=${encodeURIComponent(token || '')}`), [token]);
  const [f, setF] = useState({ password: '', confirmPassword: '' });
  const [errs, setErrs, fromError] = useFieldErrors();
  const act = useAction();
  const submit = (e) => {
    e.preventDefault();
    const fe = {};
    if (pwLen(f.password) < 12 || pwLen(f.password) > 128) fe.password = PW_MSG;
    if (f.confirmPassword !== f.password) fe.confirmPassword = 'Passwords do not match.';
    setErrs(fe);
    if (Object.keys(fe).length) return;
    act.run(async () => { try { return await api.post(submitPath, { token, ...f }); } catch (err) { fromError(err); throw err; } }, (r) => r.message);
  };
  return (
    <div className="center-card">
      <Card>
        <div className="icon-circle">🔒</div>
        <h1 style={{ fontSize: '1.35rem' }}>{title}</h1>
        {check.loading ? <Loading /> : check.error ? (
          <>
            <Alert kind="error">{check.error.message}</Alert>
            <Link className="btn block" to="/forgot-password">Request a new link</Link>
          </>
        ) : act.message ? (
          <><Alert kind="ok">{successText || act.message}</Alert><Link className="btn block" to="/login">Sign in</Link></>
        ) : (
          <form className="stack" style={{ textAlign: 'left' }} onSubmit={submit} noValidate>
            {intro && <p className="muted" style={{ margin: 0, textAlign: 'center' }}>{intro(check.data)}</p>}
            <PasswordField label="New password" hint="12–128 characters; spaces allowed" autoComplete="new-password" value={f.password} error={errs.password} onChange={(password) => setF({ ...f, password })} />
            <PasswordField label="Confirm new password" autoComplete="new-password" value={f.confirmPassword} error={errs.confirmPassword} onChange={(confirmPassword) => setF({ ...f, confirmPassword })} />
            {act.error && !Object.keys(errs).length && <Alert kind="error">{act.error.message}</Alert>}
            <button className="btn block" disabled={act.busy}>Save password</button>
          </form>
        )}
      </Card>
    </div>
  );
}

// small local loader to avoid a circular import with ui.jsx's useLoad semantics
function useLoad2(fn, deps) {
  const [s, setS] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    fn().then((data) => alive && setS({ loading: false, data, error: null })).catch((error) => alive && setS({ loading: false, data: null, error }));
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

export const ResetPassword = () => (
  <SetPasswordForm checkPath="/auth/reset-password/check" submitPath="/auth/reset-password" title="Choose a new password"
    intro={() => 'Resetting your password signs you out on all devices.'} successText="Your password has been reset. All devices were signed out." />
);

export const AcceptInvite = () => (
  <SetPasswordForm checkPath="/auth/invite/check" submitPath="/auth/accept-invite" title="Set up your staff account"
    intro={(d) => `Welcome ${d?.name}. Choose a password for ${d?.email}.`} />
);

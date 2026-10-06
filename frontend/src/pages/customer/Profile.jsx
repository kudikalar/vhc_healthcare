import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime } from '../../format.js';
import { Alert, Badge, Card, DevHint, ErrorBox, Field, Loading, Modal, PageHeader, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { OtpCard, PasswordField } from '../../components/AuthBits.jsx';

const fieldsOf = (e) => (e instanceof ApiError ? e.fields : {});

export default function Profile() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'personal';
  const { refresh } = useAuth();
  const res = useLoad(() => api.get('/profile'));
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const p = res.data;
  const update = (u) => { res.setData({ ...p, ...u }); refresh(); };
  const required = (p.checklist || []).filter((c) => c.required);
  const done = required.filter((c) => c.ok).length;

  return (
    <>
      <PageHeader title="Your profile" subtitle={p.customerId ? `Customer ID ${p.customerId}` : undefined} />
      <div className="profile-layout">
        <div>
          <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'personal', label: 'Personal' }, { value: 'address', label: 'Address' }, { value: 'security', label: 'Security & contact' }]} />
          {tab === 'personal' && <Personal p={p} onSaved={update} />}
          {tab === 'address' && <Address p={p} onSaved={update} />}
          {tab === 'security' && <Security p={p} onSaved={update} reload={res.reload} />}
        </div>
        {p.checklist && (
          <aside>
            <Card className="completion" title="Profile completion">
              <div className="pct">{Math.round((done / required.length) * 100)}%</div>
              <div className="meter" style={{ margin: '.4rem 0 .9rem' }}><span style={{ width: `${(done / required.length) * 100}%` }} /></div>
              <ul className="checklist">
                {p.checklist.map((c) => <li key={c.key}><span aria-hidden="true">{c.ok ? '✅' : c.required ? '⭕' : '◻️'}</span><span>{c.label}{!c.required && <small className="muted"> (optional)</small>}</span></li>)}
              </ul>
              <small className="muted">Required items must be complete before you can submit an application. You can save a partial profile at any time.</small>
            </Card>
            <Card>
              <small className="muted">Profile edits don't rewrite issued policy documents. To change details on an issued policy, raise a service request.</small>
            </Card>
          </aside>
        )}
      </div>
    </>
  );
}

function Personal({ p, onSaved }) {
  const [f, setF] = useState({ legalName: p.legalName, dob: p.profile.dob, gender: p.profile.gender });
  const act = useAction();
  const errs = fieldsOf(act.error);
  const dirty = f.legalName !== p.legalName || f.dob !== p.profile.dob || f.gender !== p.profile.gender;
  return (
    <Card title="Personal details">
      <div className="form-grid">
        {p.customerId && <Field label="Customer ID"><input value={p.customerId} disabled /></Field>}
        <Field label="Legal full name" hint="As on your identity documents" error={errs.legalName} className="full">
          <input maxLength={120} value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} aria-invalid={!!errs.legalName} />
        </Field>
        <Field label="Date of birth" hint="Policyholders must be at least 18" error={errs.dob}>
          <input type="date" max={new Date().toISOString().slice(0, 10)} value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} aria-invalid={!!errs.dob} />
        </Field>
        <Field label="Gender" hint="Optional" error={errs.gender}>
          <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}>
            <option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefer not to say</option>
          </select>
        </Field>
      </div>
      {act.error && !Object.keys(errs).length && <ErrorBox error={act.error} />}
      <div className="save-footer">
        {act.message && <span className="badge ok">{act.message}</span>}
        <button className="btn secondary" disabled={!dirty || act.busy} onClick={() => setF({ legalName: p.legalName, dob: p.profile.dob, gender: p.profile.gender })}>Discard</button>
        <button className="btn" disabled={!dirty || act.busy} onClick={() => act.run(async () => onSaved(await api.put('/profile/personal', f)), 'Saved')}>Save changes</button>
      </div>
    </Card>
  );
}

function Address({ p, onSaved }) {
  const init = { line1: '', line2: '', city: '', state: '', postalCode: '', ...p.profile.address };
  const [f, setF] = useState(init);
  const act = useAction();
  const errs = fieldsOf(act.error);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="Address">
      <div className="form-grid">
        <Field label="Address line 1" hint="House / building and street" error={errs.line1} className="full"><input maxLength={150} value={f.line1} onChange={set('line1')} aria-invalid={!!errs.line1} /></Field>
        <Field label="Address line 2" hint="Optional" error={errs.line2} className="full"><input maxLength={150} value={f.line2} onChange={set('line2')} /></Field>
        <Field label="City" error={errs.city}><input maxLength={80} value={f.city} onChange={set('city')} aria-invalid={!!errs.city} /></Field>
        <Field label="State" error={errs.state}>
          <select value={f.state} onChange={set('state')} aria-invalid={!!errs.state}><option value="">— select —</option>{p.states.map((s) => <option key={s}>{s}</option>)}</select>
        </Field>
        <Field label="Postal code" error={errs.postalCode}><input inputMode="numeric" maxLength={6} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value.replace(/\D/g, '') })} aria-invalid={!!errs.postalCode} /></Field>
        <Field label="Country"><input value="India" disabled /></Field>
      </div>
      <div className="save-footer">
        {act.message && <span className="badge ok">{act.message}</span>}
        <button className="btn" disabled={act.busy} onClick={() => act.run(async () => onSaved(await api.put('/profile/address', f)), 'Saved')}>Save changes</button>
      </div>
    </Card>
  );
}

function Security({ p, onSaved, reload }) {
  return (
    <>
      <Contacts p={p} onSaved={onSaved} reload={reload} />
      <Preferences p={p} onSaved={onSaved} />
      <ChangePassword />
      <Sessions />
    </>
  );
}

function Contacts({ p, onSaved, reload }) {
  const [emailForm, setEmailForm] = useState(null);
  const [mobileForm, setMobileForm] = useState(null);
  const [otp, setOtp] = useState(null);
  const [emailSent, setEmailSent] = useState(null);
  const act = useAction();
  const verifyAct = useAction();

  const sendMobile = (newMobile) => act.run(async () => {
    const r = newMobile ? await api.post('/profile/mobile-change', { newMobile }) : await api.post('/auth/mobile/send');
    setOtp(r);
    setMobileForm(null);
    reload();
    return true;
  });

  return (
    <Card title="Contact details">
      <div className="contact-row">
        <div>
          <strong>Email</strong> {p.emailVerified ? <Badge kind="ok">Verified</Badge> : <Badge kind="warn">Unverified</Badge>}
          <div className="muted">{p.email}</div>
          {p.pendingEmail && <div><Badge kind="warn">Pending</Badge> <small>{p.pendingEmail} — your current email keeps working until the new one is verified.</small></div>}
        </div>
        <div className="row">
          {p.pendingEmail && <button className="btn sm ghost" onClick={() => act.run(async () => onSaved(await api.post('/profile/cancel-contact-change', { type: 'email' })))}>Cancel change</button>}
          <button className="btn sm secondary" onClick={() => setEmailForm('')}>Change email</button>
        </div>
      </div>
      <div className="contact-row">
        <div>
          <strong>Mobile</strong> {p.mobileVerified ? <Badge kind="ok">Verified</Badge> : <Badge kind="warn">Unverified</Badge>}
          <div className="muted">{p.mobile || '—'}</div>
          {p.pendingMobile && <div><Badge kind="warn">Pending</Badge> <small>{p.pendingMobile} awaiting verification</small></div>}
          {!p.mobileVerified && <small className="muted">Verify your mobile before claim payouts or SMS updates.</small>}
        </div>
        <div className="row">
          {(!p.mobileVerified || p.pendingMobile) && <button className="btn sm" disabled={act.busy} onClick={() => sendMobile()}>Verify now</button>}
          <button className="btn sm secondary" onClick={() => setMobileForm('')}>Change mobile</button>
        </div>
      </div>
      <ErrorBox error={act.error} />
      {emailSent && <Alert kind="ok">{emailSent.message} ({emailSent.destination})</Alert>}
      {emailSent?.devVerificationToken && <DevHint><a href={`/verify-email?token=${emailSent.devVerificationToken}`}>Open the verification link for the new email</a></DevHint>}

      <Modal open={emailForm != null} title="Change email address" onClose={() => setEmailForm(null)}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); act.run(async () => { const r = await api.post('/profile/email-change', { newEmail: emailForm }); setEmailSent(r); setEmailForm(null); reload(); }); }}>
          <p className="muted" style={{ margin: 0 }}>We'll send a link to the new address. Until you open it, you keep signing in with {p.email}.</p>
          <Field label="New email address" error={fieldsOf(act.error).newEmail}><input type="email" value={emailForm || ''} onChange={(e) => setEmailForm(e.target.value)} /></Field>
          <button className="btn">Send verification link</button>
        </form>
      </Modal>
      <Modal open={mobileForm != null} title="Change mobile number" onClose={() => setMobileForm(null)}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); sendMobile(mobileForm); }}>
          <Field label="New mobile number" hint="India only, 10 digits" error={fieldsOf(act.error).newMobile}><input type="tel" value={mobileForm || ''} onChange={(e) => setMobileForm(e.target.value)} /></Field>
          <button className="btn" disabled={act.busy}>Send code</button>
        </form>
      </Modal>
      <Modal open={!!otp} title="Verify your mobile" onClose={() => setOtp(null)}>
        {otp && (
          <OtpCard title="" destination={otp.destination} expiresAt={otp.expiresAt} devCode={otp.devCode} busy={verifyAct.busy}
            error={verifyAct.error?.message}
            onVerify={(code) => verifyAct.run(async () => { const r = await api.post('/auth/mobile/verify', { challengeId: otp.challengeId, code }); onSaved(r.user); setOtp(null); })}
            onResend={async () => { try { const r = await api.post('/auth/mobile/send'); setOtp(r); return true; } catch (e) { verifyAct.setError(e); return false; } }} />
        )}
      </Modal>
    </Card>
  );
}

function Preferences({ p, onSaved }) {
  const [f, setF] = useState({ communicationPreference: p.communicationPreference, marketingOptIn: p.marketingOptIn });
  const act = useAction();
  useEffect(() => setF({ communicationPreference: p.communicationPreference, marketingOptIn: p.marketingOptIn }), [p.communicationPreference, p.marketingOptIn]);
  return (
    <Card title="Communication preferences">
      <Field label="Service notices" hint="Policy, payment and claim updates are always sent" error={fieldsOf(act.error).communicationPreference}>
        <select value={f.communicationPreference} onChange={(e) => setF({ ...f, communicationPreference: e.target.value })} style={{ maxWidth: 320 }}>
          <option value="email">Email</option>
          <option value="email_sms">Email and SMS{!p.mobileVerified ? ' (verify mobile first)' : ''}</option>
        </select>
      </Field>
      <label className="check" style={{ marginTop: '.8rem' }}><input type="checkbox" checked={f.marketingOptIn} onChange={(e) => setF({ ...f, marketingOptIn: e.target.checked })} /> Product news and offers (marketing). You can withdraw this at any time.</label>
      <div className="row" style={{ marginTop: '.8rem' }}>
        <button className="btn secondary" disabled={act.busy} onClick={() => act.run(async () => onSaved(await api.put('/profile/preferences', f)), 'Preferences saved')}>Save preferences</button>
        {act.message && <span className="badge ok">{act.message}</span>}
      </div>
    </Card>
  );
}

function ChangePassword() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const act = useAction();
  const errs = fieldsOf(act.error);
  return (
    <Card title="Password">
      <form className="stack" style={{ maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); act.run(async () => { const r = await api.post('/auth/change-password', f); setF({ currentPassword: '', newPassword: '', confirmPassword: '' }); return r; }, (r) => r.message); }}>
        <PasswordField label="Current password" value={f.currentPassword} onChange={(v) => setF({ ...f, currentPassword: v })} />
        <PasswordField label="New password" hint="12–128 characters" autoComplete="new-password" value={f.newPassword} error={errs.newPassword} onChange={(v) => setF({ ...f, newPassword: v })} />
        <PasswordField label="Confirm new password" autoComplete="new-password" value={f.confirmPassword} error={errs.confirmPassword} onChange={(v) => setF({ ...f, confirmPassword: v })} />
        {act.error && !Object.keys(errs).length && <Alert kind="error">{act.error.message}</Alert>}
        {act.message && <Alert kind="ok">{act.message}</Alert>}
        <div><button className="btn" disabled={act.busy}>Update password</button></div>
      </form>
    </Card>
  );
}

function Sessions() {
  const res = useLoad(() => api.get('/auth/sessions'));
  const act = useAction();
  const nav = useNavigate();
  const { setUser } = useAuth();
  return (
    <Card title="Signed-in devices">
      {res.loading ? <Loading /> : res.data.map((s) => (
        <div className="contact-row" key={s.id}>
          <div>
            <strong>{s.userAgent?.split(')')[0]?.replace('(', '· ') || 'Unknown device'}</strong> {s.current && <Badge kind="ok">This device</Badge>} {s.remembered && <Badge>Remembered</Badge>}
            <div className="muted" style={{ fontSize: '.84rem' }}>Signed in {dateTime(s.createdAt)} · last active {dateTime(s.lastSeenAt)} · {s.ip}</div>
          </div>
          <button className="btn sm secondary" disabled={act.busy} onClick={() => act.run(async () => {
            await api.post(`/auth/sessions/${s.id}/revoke`);
            if (s.current) { setUser(null); nav('/login', { replace: true }); } else res.reload();
          })}>{s.current ? 'Sign out' : 'Revoke'}</button>
        </div>
      ))}
      <ErrorBox error={act.error} />
    </Card>
  );
}

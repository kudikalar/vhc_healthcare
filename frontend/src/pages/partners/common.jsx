// Shared building blocks for the partners module (also used by the catalogue, applications and policies).
import { useState } from 'react';
import { api } from '../../api.js';
import { Alert, ErrorBox, Field, useAction } from '../../components/ui.jsx';
import './partners.css';

/** API URLs returned by the server start with /api; the client prefixes that itself. */
export const apiPath = (url) => String(url || '').replace(/^\/api(?=\/)/, '');

export function SandboxTag({ show = true, children = 'Sandbox · synthetic' }) {
  return show ? <span className="pt-tag sandbox" title="Synthetic test product/insurer — not a real insurance offer">{children}</span> : null;
}
export function CandidateTag() {
  return <span className="pt-tag candidate" title="No commercial relationship exists">Candidate — no agreement</span>;
}
export function BlockedTag({ children }) {
  return <span className="pt-tag blocked">{children}</span>;
}

/** Insurer · UIN · version line with the sandbox label. */
export function ProductMeta({ insurer, uin, version, sandbox }) {
  return (
    <div className="pt-product-meta">
      <span>Insurer: <strong>{insurer?.name || '—'}</strong></span>
      <span>UIN <span className="pt-mono">{uin || 'n/a'}</span></span>
      {version != null && <span>v{version}</span>}
      <SandboxTag show={sandbox !== false && (sandbox || insurer?.sandbox)} />
    </div>
  );
}

/** Downloads CIS / policy wording (and e-card) PDFs through the authenticated client. */
export function DocLinks({ cisUrl, wordingUrl, ecardUrl, name = 'product' }) {
  const act = useAction();
  const dl = (url, file) => act.run(() => api.download(apiPath(url), file));
  return (
    <>
      <div className="pt-doc-links">
        {cisUrl && <button type="button" className="btn sm secondary" disabled={act.busy} onClick={() => dl(cisUrl, `CIS-${name}.pdf`)}>Customer Information Sheet</button>}
        {wordingUrl && <button type="button" className="btn sm secondary" disabled={act.busy} onClick={() => dl(wordingUrl, `Wording-${name}.pdf`)}>Policy wording</button>}
        {ecardUrl && <button type="button" className="btn sm secondary" disabled={act.busy} onClick={() => dl(ecardUrl, `ECard-${name}.pdf`)}>Health e-card</button>}
      </div>
      <ErrorBox error={act.error} />
    </>
  );
}

const STEP_MARK = { done: '✓', failed: '✕', stopped: '–', not_applicable: '–', skipped: '–' };
const STEP_SR = { done: 'done', current: 'current step', failed: 'failed', stopped: 'stopped', not_applicable: 'not applicable', skipped: 'not recorded', todo: 'to do', waiting: 'waiting for review' };
/** Purchase journey step indicator (13 steps from the server). */
export function PurchaseStepper({ steps }) {
  if (!steps?.length) return null;
  return (
    <ol className="pt-stepper" aria-label="Purchase steps">
      {steps.map((s, i) => (
        <li key={s.key} className={s.state} aria-current={['current', 'waiting'].includes(s.state) ? 'step' : undefined}>
          <span className="dot" aria-hidden="true">{STEP_MARK[s.state] || i + 1}</span>
          <span>{s.label}<span className="sr-only"> ({STEP_SR[s.state] || s.state})</span></span>
        </li>
      ))}
    </ol>
  );
}

/** Public request-callback / lead form (POST /partners/leads). */
export function LeadForm({ interest, title = 'Request a callback', intro, onDone }) {
  const [f, setF] = useState({ name: '', mobile: '', email: '', city: '', consent: false });
  const [done, setDone] = useState(null);
  const act = useAction();
  const errs = act.error?.details?.fields || {};
  const submit = (e) => {
    e.preventDefault();
    act.run(async () => {
      const r = await api.post('/partners/leads', { ...f, interest, email: f.email || undefined, city: f.city || undefined });
      setDone(r);
      onDone?.(r);
    });
  };
  if (done) return <Alert kind="ok">Thank you — your request {done.reference} is with our team. We will call you on the number you gave.</Alert>;
  return (
    <form onSubmit={submit} noValidate>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {intro && <p className="muted" style={{ marginTop: 0 }}>{intro}</p>}
      <div className="form-grid">
        <Field label="Name" error={errs.name}><input autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Mobile number" error={errs.mobile}><input inputMode="tel" autoComplete="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} required /></Field>
        <Field label="Email (optional)" error={errs.email}><input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="City (optional)"><input autoComplete="address-level2" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <div className="full">
          <label className="check"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> I agree that Vision Health Care may contact me by phone, SMS or email about health insurance options. I can withdraw this consent at any time.</label>
          {errs.consent && <span className="err">{errs.consent}</span>}
        </div>
      </div>
      {act.error && !Object.keys(errs).length && <ErrorBox error={act.error} />}
      <div className="row" style={{ marginTop: '.75rem' }}><button className="btn" disabled={act.busy}>{act.busy ? 'Sending…' : 'Request callback'}</button></div>
    </form>
  );
}

export const bp = (v) => (v == null ? '—' : `${(v / 100).toFixed(v % 100 ? 1 : 0)}%`);
export const minutes = (m) => (m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`);

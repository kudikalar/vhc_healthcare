// Payment scenario catalogue (admin/QA), payment-link page and the customer privacy centre.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime, money, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, Loading, PageHeader, Table, useAction, useLoad } from '../../components/ui.jsx';
import PayButton from '../../components/PayButton.jsx';
import { useT } from './i18n.jsx';
import './enterprise.css';

export function PaymentScenarios() {
  const t = useT();
  const { user } = useAuth();
  const res = useLoad(() => api.get('/enterprise/payment-scenarios'));
  const act = useAction();
  const run = () => act.run(async () => { const r = await api.post('/enterprise/payment-scenarios/run'); res.setData(r); return r; }, (r) => `Ran ${r.run.passed + r.run.failed} automated checks: ${r.run.passed} passed, ${r.run.failed} failed`);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const d = res.data;
  const groups = [...new Set(d.scenarios.map((s) => s.group))];
  return (
    <>
      <PageHeader title={t('Payment scenarios')} subtitle={`${d.total} sandbox payment scenarios (§10): how to run each by hand, and an automated self-check.`}
        actions={user.role === 'admin' && <button className="btn" disabled={act.busy} onClick={run}>{act.busy ? 'Running…' : 'Run automated checks'}</button>} />
      <Alert kind="info">Automated checks are dry runs: each runs inside a transaction against a synthetic copy of a seeded proposal and is rolled back, so no payment, policy, ledger line or notification is kept. Test cards: Visa 4100 2800 0000 1007 (success), Mastercard 5555 5100 0008 1006 (success), 4100 2800 0008 0001 (insufficient funds), 4100 2800 0007 0002 (cancelled), 4100 2800 0006 0003 (bank declined); any future expiry, any CVV, bank OTP 123456. UPI: success@razorpay / failure@razorpay.</Alert>
      {act.message && <Alert kind={act.error ? 'error' : 'ok'}>{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {d.lastRun && <p className="muted">Last run {dateTime(d.lastRun.at)} by {d.lastRun.by}: <strong>{d.lastRun.passed}</strong> passed, <strong>{d.lastRun.failed}</strong> failed.</p>}
      {groups.map((g) => (
        <section key={g} className="ent-scn-group" aria-label={g}>
          <h2 style={{ fontSize: '1.05rem' }}>{g}</h2>
          <Card>
            <Table rows={d.scenarios.filter((s) => s.group === g)} columns={[
              { key: 'title', label: 'Scenario', render: (s) => <><strong>{s.title}</strong><div className="muted ent-mono">{s.id}</div></> },
              { key: 'how', label: 'How to run', render: (s) => <span className="ent-wrap">{s.how}</span> },
              { key: 'expected', label: 'Expected result' },
              { key: 'result', label: 'Automated result', render: (s) => (!s.automated ? <span className="muted">Manual</span> : !s.result ? <span className="muted">Not run</span> : <><Badge kind={s.result.pass ? 'ok' : 'error'}>{s.result.pass ? 'Pass' : 'Fail'}</Badge><div className="muted" style={{ fontSize: '.8rem' }}>{s.result.detail}</div></>) },
            ]} />
          </Card>
        </section>
      ))}
    </>
  );
}

/** /pay/:code — opens a shareable sandbox payment link (owner only; expiry enforced by the server). */
export function PayLinkPage() {
  const { code } = useParams();
  const res = useLoad(() => api.get(`/payments/links/${code}`), [code]);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const l = res.data;
  const target = { purpose: l.target.purpose, applicationId: l.target.applicationId || undefined, policyId: l.target.policyId || undefined, installmentNo: l.target.installmentNo || undefined, linkCode: l.code };
  return (
    <>
      <PageHeader title="Payment link" subtitle={l.description} />
      <Card>
        <dl className="kv">
          <dt>Amount</dt><dd>{money(l.amount)}</dd>
          <dt>Status</dt><dd><Badge>{l.status}</Badge></dd>
          <dt>Expires</dt><dd>{dateTime(l.expiresAt)}</dd>
          <dt>Mode</dt><dd><Badge kind="warn">{l.mode} — sandbox, no real money</Badge></dd>
        </dl>
        {l.status === 'active' ? <PayButton target={target} amount={l.amount} label="Pay now" onDone={() => res.reload()} /> : l.status === 'paid' ? <Alert kind="ok">Paid ({l.paidReference}).</Alert> : <Alert kind="warn">This link is {l.status}. Ask for a new link or pay from your application or policy page.</Alert>}
      </Card>
      <Link to="/payments">← Payments</Link>
    </>
  );
}

/** Privacy & data tab on the customer's profile: consents, marketing withdrawal, export / deletion requests. */
export function PrivacyPanel() {
  const res = useLoad(() => api.get('/enterprise/privacy'));
  const [form, setForm] = useState({ type: 'export', reason: '' });
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const d = res.data;
  const download = (r) => act.run(() => api.download(`/enterprise/privacy/requests/${r.id}/export`, `vhc-data-export-${r.reference}.json`));
  return (
    <>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Card title="Consents">
        <p className="muted" style={{ marginTop: 0 }}>Every consent you gave or withdrew, with the version of the terms it applied to.</p>
        <Table rows={d.consents} empty="No consent records." columns={[
          { key: 'at', label: 'When', render: (c) => dateTime(c.at) },
          { key: 'type', label: 'Consent', render: (c) => (c.type === 'terms_privacy' ? 'Terms of use & privacy notice' : titleCase(c.type)) },
          { key: 'granted', label: 'Decision', render: (c) => <Badge kind={c.granted ? 'ok' : 'warn'}>{c.granted ? 'Given' : 'Withdrawn'}</Badge> },
          { key: 'v', label: 'Version', render: (c) => c.termsVersion || '—' },
        ]} />
        <div className="row" style={{ marginTop: '.8rem' }}>
          {d.marketingOptIn ? (
            <button className="btn secondary" disabled={act.busy} onClick={() => act.run(async () => { await api.post('/enterprise/privacy/marketing/withdraw'); res.reload(); }, 'Marketing consent withdrawn. Service messages about your policies and claims continue.')}>Withdraw marketing consent</button>
          ) : <span className="muted">You are not receiving marketing messages. Service messages about your policies and claims are always sent.</span>}
        </div>
      </Card>
      <Card title="Your data rights">
        <p style={{ marginTop: 0 }}>You can ask for a copy of your data or ask us to delete your account. A compliance officer reviews each request.</p>
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (form.type === 'deletion' && !window.confirm('Request account deletion? If approved you will be signed out and your login closed. Policies, claims and payments are retained as required by law.')) return; act.run(async () => { await api.post('/enterprise/privacy/requests', form); setForm({ ...form, reason: '' }); res.reload(); }, 'Request submitted. We will notify you when it has been reviewed.'); }}>
          <Field label="Request"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(d.requestTypes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Reason (optional)" className="full"><textarea rows={2} maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <div><button className="btn" disabled={act.busy}>Submit request</button></div>
        </form>
        <details style={{ marginTop: '.8rem' }}>
          <summary>What we must keep even after deletion, and why</summary>
          <ul className="ent-list">{d.retentionRules.map((r) => <li key={r.records}><strong>{r.records}</strong><div className="why">{r.basis}</div></li>)}</ul>
        </details>
      </Card>
      <Card title="My requests">
        <Table rows={d.requests} empty="No requests yet." columns={[
          { key: 'reference', label: 'Request', render: (r) => <code>{r.reference}</code> },
          { key: 'type', label: 'Type', render: (r) => r.typeLabel },
          { key: 'createdAt', label: 'Submitted', render: (r) => dateTime(r.createdAt) },
          { key: 'status', label: 'Status', render: (r) => <><Badge>{titleCase(r.status)}</Badge>{r.decision?.note && <div className="muted">{r.decision.note}</div>}</> },
          { key: 'x', label: '', render: (r) => r.type === 'export' && r.status === 'completed' && <button className="btn sm secondary" disabled={act.busy} onClick={() => download(r)}>Download (JSON)</button> },
        ]} />
      </Card>
    </>
  );
}

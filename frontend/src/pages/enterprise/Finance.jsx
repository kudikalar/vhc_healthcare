import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, idempotencyKey } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, pct, titleCase, toPaise } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, Loading, PageHeader, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { useT } from './i18n.jsx';
import './enterprise.css';

const WRITE = ['admin', 'finance_manager'];
const useCanWrite = () => WRITE.includes(useAuth().user?.role);

function ReadOnlyNote() {
  return useCanWrite() ? null : <Alert kind="info">Read-only access: you can review ledgers and reconciliation but cannot post settlements or refunds.</Alert>;
}

function FacilitatedNote() {
  return <div className="ent-callout" role="note"><strong>Premiums facilitated are held for insurers and are not VHC revenue.</strong> VHC's own income is only commission/remuneration and service or booking fees, kept in separate ledgers. Test-mode and live-mode entries are never mixed.</div>;
}

function useInsurers() {
  return useLoad(() => api.get('/enterprise/orgs').then((o) => o.insurer).catch(() => []));
}

export function FinanceOverview() {
  const t = useT();
  const canWrite = useCanWrite();
  const [f, setF] = useState({ mode: 'test', insurerId: '', from: '', to: '', ledger: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const summary = useLoad(() => api.get(`/enterprise/finance/summary?${qs}`), [qs]);
  const entries = useLoad(() => api.get(`/enterprise/finance/entries?${qs}&limit=300`), [qs]);
  const commission = useLoad(() => api.get(`/enterprise/finance/commission?mode=${f.mode}`), [f.mode]);
  const insurers = useInsurers();
  const [tab, setTab] = useState('ledgers');
  const act = useAction();
  const settle = (ins) => {
    if (!window.confirm(`Remit ${money(ins.heldForInsurer)} of ${f.mode} premium to ${ins.insurerName}? This records a settlement; in test mode no money moves.`)) return;
    act.run(async () => { const r = await api.post('/enterprise/finance/settlements', { insurerId: ins.insurerId, mode: f.mode, idempotencyKey: idempotencyKey() }); summary.reload(); commission.reload(); entries.reload(); return r; }, (r) => `Settlement ${r.settlement.reference} recorded`);
  };
  const h = summary.data?.headline;
  return (
    <>
      <PageHeader title={t('Finance')} subtitle="Ledgers, insurer settlements and commission (§43)." actions={<><Link className="btn secondary" to="/finance/refunds">{t('Refunds')}</Link><Link className="btn secondary" to="/finance/reconciliation">{t('Reconciliation')}</Link></>} />
      <ReadOnlyNote />
      <FacilitatedNote />
      <form className="ent-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <Field label="Mode"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="test">Test (sandbox)</option><option value="live">Live</option></select></Field>
        <Field label="Insurer"><select value={f.insurerId} onChange={(e) => setF({ ...f, insurerId: e.target.value })}><option value="">All insurers</option>{(insurers.data || []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </form>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error || summary.error} />
      {h && (
        <div className="ent-kpis" style={{ marginBottom: '1rem' }}>
          {[
            ['Premiums held for insurers', h.premiumsHeldForInsurers, 'Not VHC revenue'],
            ['Premiums facilitated (gross)', h.premiumsFacilitatedGross, 'Collected for insurers'],
            ['Settled to insurers', h.settledToInsurers],
            ['VHC earned revenue', h.vhcEarnedRevenue, 'Commission + fees only'],
            ['Gateway fees', h.gatewayFees], ['GST on fees', h.taxOnFees], ['Refunds completed', h.refunds], ['Claim payouts (insurer funds)', h.claimPayouts],
          ].map(([l, v, n]) => <div key={l} className="ent-kpi money"><div className="label">{l}</div><div className="value">{money(v)}</div>{n && <div className="note">{n}</div>}</div>)}
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'ledgers', label: 'Ledger balances' }, { value: 'entries', label: 'Entries' }, { value: 'commission', label: 'Commission & settlement' }]} />
      {tab === 'ledgers' && (
        <Card>
          {summary.loading ? <Loading /> : (
            <Table rowKey="key" rows={Object.entries(summary.data.balances).map(([key, b]) => ({ key, ...b }))} columns={[
              { key: 'label', label: 'Ledger', render: (b) => <><strong>{b.label}</strong><div className="muted ent-mono">{b.key}</div></> },
              { key: 'owner', label: 'Belongs to', render: (b) => <>{b.owner === "vhc" ? "VHC" : titleCase(b.owner)} {b.vhcRevenue && <Badge kind="ok">VHC revenue</Badge>}</> },
              { key: 'credits', label: 'Credits', num: true, render: (b) => money(b.credits) },
              { key: 'debits', label: 'Debits', num: true, render: (b) => money(b.debits) },
              { key: 'net', label: 'Balance', num: true, render: (b) => <strong>{money(b.net)}</strong> },
              { key: 'entries', label: 'Entries', num: true },
            ]} />
          )}
        </Card>
      )}
      {tab === 'entries' && (
        <Card actions={(
          <label className="field" style={{ minWidth: 200 }}>Ledger
            <select value={f.ledger} onChange={(e) => setF({ ...f, ledger: e.target.value })}>
              <option value="">All ledgers</option>
              {summary.data && Object.entries(summary.data.balances).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
            </select>
          </label>
        )}>
          {entries.loading ? <Loading /> : (
            <Table rows={entries.data} empty="No ledger entries for these filters." columns={[
              { key: 'postedAt', label: 'Posted', render: (e) => dateTime(e.postedAt) },
              { key: 'ledger', label: 'Ledger', render: (e) => <>{e.ledgerLabel}{e.vhcRevenue && <> <Badge kind="ok">revenue</Badge></>}</> },
              { key: 'description', label: 'Description', render: (e) => <span className="ent-wrap">{e.description}</span> },
              { key: 'insurerName', label: 'Insurer', render: (e) => e.insurerName || '—' },
              { key: 'direction', label: 'Dr/Cr', render: (e) => (e.direction === 'credit' ? 'Cr' : 'Dr') },
              { key: 'amount', label: 'Amount', num: true, render: (e) => money(e.amount) },
              { key: 'mode', label: 'Mode', render: (e) => <Badge kind={e.mode === 'live' ? 'info' : 'warn'}>{e.mode}</Badge> },
            ]} />
          )}
        </Card>
      )}
      {tab === 'commission' && (
        commission.loading ? <Loading /> : commission.data.map((c) => (
          <Card key={c.insurerId} title={<h3>{c.insurerName} {c.sandbox && <Badge kind="warn">Sandbox (synthetic)</Badge>}</h3>}
            actions={canWrite && c.heldForInsurer > 0 && <button className="btn sm" disabled={act.busy} onClick={() => settle(c)}>Settle {money(c.heldForInsurer)} to insurer</button>}>
            <dl className="kv">
              <dt>Commission rate (agreement)</dt><dd>{c.commissionBp ? pct(c.commissionBp) : 'No agreement'}</dd>
              <dt>Premium facilitated</dt><dd>{money(c.premiumFacilitated)}</dd>
              <dt>Reversed by refunds</dt><dd>{money(c.premiumReversed)}</dd>
              <dt>Settled to insurer</dt><dd>{money(c.settledToInsurer)}</dd>
              <dt>Still held for insurer</dt><dd><strong>{money(c.heldForInsurer)}</strong></dd>
              <dt>VHC commission accrued (receivable from insurer)</dt><dd>{money(c.commissionAccrued)}</dd>
            </dl>
            <h4 style={{ marginTop: '1rem' }}>Commission statement</h4>
            <Table rows={c.commissionLines} empty="No commission accrued yet." columns={[
              { key: 'postedAt', label: 'Date', render: (e) => date(e.postedAt) }, { key: 'reference', label: 'Policy', render: (e) => <code>{e.reference}</code> },
              { key: 'description', label: 'Basis' }, { key: 'amount', label: 'Commission', num: true, render: (e) => money(e.amount) },
            ]} />
            {c.settlements.length > 0 && (
              <>
                <h4 style={{ marginTop: '1rem' }}>Settlements</h4>
                <Table rows={c.settlements} columns={[
                  { key: 'reference', label: 'Reference', render: (x) => <code>{x.reference}</code> }, { key: 'settledAt', label: 'Date', render: (x) => dateTime(x.settledAt) },
                  { key: 'settledBy', label: 'By' }, { key: 'amount', label: 'Amount', num: true, render: (x) => money(x.amount) },
                ]} />
              </>
            )}
          </Card>
        ))
      )}
    </>
  );
}

export function RefundsPage() {
  const t = useT();
  const canWrite = useCanWrite();
  const [status, setStatus] = useState('');
  const res = useLoad(() => api.get(`/enterprise/finance/refunds${status ? `?status=${status}` : ''}`), [status]);
  const payments = useLoad(() => api.get('/payments'));
  const [form, setForm] = useState({ paymentReference: '', kind: 'full', amount: '', reason: '', settleNow: true });
  const act = useAction();
  const captured = (payments.data || []).filter((p) => p.status === 'success' || p.status === 'refund_due');
  const sel = captured.find((p) => p.reference === form.paymentReference);
  const refunded = sel ? sel.refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amount, 0) : 0;
  const submit = (e) => {
    e.preventDefault();
    const amount = form.kind === 'partial' ? toPaise(form.amount) : undefined;
    if (form.kind === 'partial' && !amount) { act.setError(new Error('Enter the partial refund amount in rupees')); return; }
    act.run(async () => {
      const r = await api.post('/enterprise/finance/refunds', { paymentReference: form.paymentReference, amount, reason: form.reason, settleNow: form.settleNow, idempotencyKey: idempotencyKey() });
      setForm({ ...form, amount: '', reason: '' });
      res.reload(); payments.reload();
      return r;
    }, (r) => `Refund ${r.reference} created${form.settleNow ? ' and completed by the test gateway' : ''}`);
  };
  const settle = (r, outcome) => act.run(async () => { await api.post(`/enterprise/finance/refunds/${r.id}/settle`, { outcome }); res.reload(); payments.reload(); }, `Refund ${outcome}`);
  return (
    <>
      <PageHeader title={t('Refunds')} subtitle="Full and partial refunds of captured payments. A refund never edits the original payment; it is its own record." />
      <ReadOnlyNote />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {canWrite && (
        <Card title="Issue a refund">
          <form className="form-grid" onSubmit={submit}>
            <Field label="Captured payment" className="full">
              <select required value={form.paymentReference} onChange={(e) => setForm({ ...form, paymentReference: e.target.value })}>
                <option value="">Select a payment…</option>
                {captured.map((p) => <option key={p.reference} value={p.reference}>{p.reference} · {money(p.amount)} · {p.description}{p.refundStatus ? ` · ${p.refundStatus.replace(/_/g, ' ')}` : ''}</option>)}
              </select>
            </Field>
            {sel && <p className="muted full" style={{ margin: 0 }}>Refundable balance: <strong>{money(sel.amount - refunded)}</strong> of {money(sel.amount)}.</p>}
            <Field label="Refund type">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="full">Full (remaining balance)</option><option value="partial">Partial</option></select>
            </Field>
            {form.kind === 'partial' && <Field label="Amount (₹)"><input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="e.g. 1500.00" /></Field>}
            <Field label="Reason (shown to the customer)" className="full"><input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={300} /></Field>
            <label className="check full"><input type="checkbox" checked={form.settleNow} onChange={(e) => setForm({ ...form, settleNow: e.target.checked })} /> Complete immediately via the test gateway (test mode only)</label>
            <div><button className="btn" disabled={act.busy || !form.paymentReference}>Create refund</button></div>
          </form>
        </Card>
      )}
      <Card title="Refunds" actions={(
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['pending', 'processing', 'completed', 'failed'].map((s) => <option key={s}>{s}</option>)}</select>
      )}>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No refunds." columns={[
            { key: 'reference', label: 'Refund', render: (r) => <code>{r.reference}</code> },
            { key: 'paymentReference', label: 'Payment', render: (r) => <><code>{r.paymentReference}</code><div className="muted">{r.paymentDescription}</div></> },
            { key: 'customer', label: 'Customer' },
            { key: 'amount', label: 'Amount', num: true, render: (r) => <>{money(r.amount)}{r.partial && <div><Badge kind="info">partial</Badge></div>}</> },
            { key: 'reason', label: 'Reason' },
            { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
            { key: 'createdAt', label: 'Created', render: (r) => dateTime(r.createdAt) },
            { key: 'x', label: '', render: (r) => canWrite && ['pending', 'processing'].includes(r.status) && (r.mode || 'test') === 'test' && (
              <div className="row"><button className="btn sm" disabled={act.busy} onClick={() => settle(r, 'completed')}>Complete (test)</button><button className="btn sm danger" disabled={act.busy} onClick={() => settle(r, 'failed')}>Fail</button></div>
            ) },
          ]} />
        )}
      </Card>
    </>
  );
}

const EXC_LABEL = {
  captured_issuance_pending: 'Captured — issuance pending', declined_awaiting_refund: 'Insurer declined — refund outstanding', amount_mismatch: 'Amount mismatch',
  gateway_amount_mismatch: 'Gateway amount mismatch', duplicate_collection_refund_due: 'Duplicate collection — refund due', settlement_mismatch: 'Gateway settlement mismatch',
  unsettled_premium: 'Premium not yet settled to insurer', missing_ledger_entry: 'Missing ledger entry', issued_without_policy: 'Issued without policy record', captured_unexpected_state: 'Captured — unexpected proposal state',
};

export function ReconciliationPage() {
  const t = useT();
  const canWrite = useCanWrite();
  const [mode, setMode] = useState('test');
  const res = useLoad(() => api.get(`/enterprise/finance/reconciliation?mode=${mode}`), [mode]);
  const act = useAction();
  const run = (fn, msg) => act.run(async () => { const r = await fn(); res.reload(); return r; }, msg);
  const d = res.data;
  return (
    <>
      <PageHeader title={t('Reconciliation')} subtitle="Gateway (payments) vs insurer (issuance decisions) vs internal ledgers."
        actions={<label className="field" style={{ minWidth: 150 }}>Mode<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="test">Test (sandbox)</option><option value="live">Live</option></select></label>} />
      <ReadOnlyNote />
      <FacilitatedNote />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error || res.error} />
      {res.loading && !d ? <Loading /> : d && (
        <>
          <div className="grid grid-3" style={{ marginBottom: '1rem' }}>
            <Card title="Gateway">
              <dl className="kv"><dt>Captured</dt><dd>{d.gateway.captured} · {money(d.gateway.capturedAmount)}</dd><dt>Failed</dt><dd>{d.gateway.failed}</dd><dt>Pending</dt><dd>{d.gateway.pending}</dd><dt>Expired (abandoned)</dt><dd>{d.gateway.expired}</dd><dt>Refund due (duplicate)</dt><dd>{d.gateway.refundDue}</dd></dl>
            </Card>
            <Card title="Insurer decisions">
              <dl className="kv"><dt>Issued</dt><dd>{d.insurer.issued}</dd><dt>Issuance pending</dt><dd>{d.insurer.issuancePending}</dd><dt>Declined by insurer</dt><dd>{d.insurer.declined}</dd><dt>Not an issuance payment</dt><dd>{d.insurer.notApplicable}</dd></dl>
            </Card>
            <Card title="Internal ledgers">
              <dl className="kv"><dt>Held for insurers</dt><dd>{money(d.ledger.premiumsHeld)}</dd><dt>Settled to insurers</dt><dd>{money(d.ledger.settledToInsurers)}</dd><dt>Refunds</dt><dd>{money(d.ledger.refunds)}</dd><dt>Gateway fees</dt><dd>{money(d.ledger.gatewayFees)}</dd></dl>
            </Card>
          </div>
          <Card title={`Exceptions (${d.exceptions.length})`} actions={<Badge kind={d.balanced ? 'ok' : 'error'}>{d.balanced ? 'No blocking exceptions' : 'Action needed'}</Badge>}>
            <Table rows={d.exceptions.map((e, i) => ({ ...e, id: `${e.type}-${e.reference || e.insurerId}-${i}` }))} empty="Everything reconciles." columns={[
              { key: 'severity', label: 'Severity', render: (e) => <Badge kind={e.severity === 'high' ? 'error' : e.severity === 'medium' ? 'warn' : 'info'}>{e.severity}</Badge> },
              { key: 'type', label: 'Exception', render: (e) => EXC_LABEL[e.type] || titleCase(e.type) },
              { key: 'reference', label: 'Reference', render: (e) => (e.reference ? <code>{e.reference}</code> : e.insurerName) },
              { key: 'amount', label: 'Amount', num: true, render: (e) => money(e.amount) },
              { key: 'detail', label: 'Detail', render: (e) => <span className="ent-wrap">{e.detail}{e.ageDays != null ? ` · ${e.ageDays} day(s)` : ''}</span> },
            ]} />
          </Card>
          {canWrite && mode === 'test' && (
            <Card title="Sandbox tools">
              <p className="muted">Import a simulated gateway settlement file for captured payments, optionally short-settling one line to exercise the mismatch check. Backfill posts ledger lines for legacy payments (idempotent).</p>
              <div className="row">
                <button className="btn secondary" disabled={act.busy} onClick={() => run(() => api.post('/enterprise/finance/gateway-settlement', { mode }), (r) => `Imported ${r.reference} (${r.lines.length} lines)`)}>Import gateway settlement</button>
                <button className="btn secondary" disabled={act.busy} onClick={() => run(() => api.post('/enterprise/finance/gateway-settlement', { mode, injectMismatch: true }), (r) => `Imported ${r.reference} with one short-settled line`)}>Import with mismatch</button>
                <button className="btn secondary" disabled={act.busy} onClick={() => run(() => api.post('/enterprise/finance/backfill'), (r) => `Backfilled ${r.ledgerBackfilledPremiums} premium(s), ${r.ledgerBackfilledCommissions} commission(s)`)}>Backfill legacy ledger entries</button>
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

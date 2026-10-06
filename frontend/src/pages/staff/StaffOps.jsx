import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Loading, PageHeader, Stat, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';

export function OpsDashboard() {
  const { user } = useAuth();
  const res = useLoad(() => api.get('/reports/summary'));
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const r = res.data;
  const q = r.queues;
  const tiles = {
    agent: [['Awaiting initial review', q.initialReview, '/ops/applications?status=Submitted'], ['Awaiting customer', q.awaitingCustomer, '/ops/applications?status=More%20Information%20Required']],
    underwriter: [['Underwriting queue', q.underwriting, '/ops/applications?status=Underwriting'], ['Initial review', q.initialReview, '/ops/applications?status=Submitted'], ['Reinstatement requests', q.reinstatements, '/ops/reinstatements']],
    claims_officer: [['Open health claims', q.healthClaimsOpen, '/ops/health-claims'], ['Open life claims', q.lifeClaimsOpen, '/ops/life-claims'], ['Payouts pending', q.payoutsPending, '/ops/payouts'], ['Open exceptions', q.exceptionsOpen, '/ops/exceptions']],
  };
  const mine = user.role === 'admin' ? [...tiles.underwriter, ...tiles.claims_officer] : tiles[user.role] || [];
  const dict = (o) => Object.entries(o).map(([k, v]) => ({ id: k, k, v }));
  return (
    <>
      <PageHeader title="Operations dashboard" subtitle={`As of ${date(r.asOf)}`} />
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>{mine.map(([l, v, to]) => <Stat key={l} label={l} value={v} to={to} />)}</div>
      <div className="grid grid-2">
        <Card title="Applications by status"><Table rows={dict(r.applicationsByStatus)} columns={[{ key: 'k', label: 'Status', render: (x) => <Badge>{x.k}</Badge> }, { key: 'v', label: 'Count', num: true }]} /></Card>
        <Card title="Policies by status"><Table rows={dict(r.policiesByStatus)} columns={[{ key: 'k', label: 'Product: status' }, { key: 'v', label: 'Count', num: true }]} /></Card>
        <Card title="Health claims"><Table rows={dict(r.healthClaimsByStatus)} columns={[{ key: 'k', label: 'Status', render: (x) => <Badge>{x.k}</Badge> }, { key: 'v', label: 'Count', num: true }]} /></Card>
        <Card title="Life claims"><Table rows={dict(r.lifeClaimsByStatus)} columns={[{ key: 'k', label: 'Status', render: (x) => <Badge>{x.k}</Badge> }, { key: 'v', label: 'Count', num: true }]} /></Card>
      </div>
      {['admin', 'claims_officer'].includes(user.role) && <Reconciliation rec={r.reconciliation} />}
    </>
  );
}

export function Reconciliation({ rec }) {
  return (
    <Card title="Financial reconciliation" actions={<Badge kind={rec.balanced ? 'ok' : 'error'}>{rec.balanced ? 'Balanced' : 'Mismatch'}</Badge>}>
      <dl className="kv">
        <dt>Premiums collected (successful payments)</dt><dd>{money(rec.premiumsCollected)}</dd>
        <dt>Premiums applied to policies/installments</dt><dd>{money(rec.premiumsApplied)}</dd>
        <dt>Payouts completed</dt><dd>{money(rec.payoutsCompleted)}</dd>
        <dt>Claim amounts recorded as paid</dt><dd>{money(rec.claimAmountsPaid)}</dd>
      </dl>
      {rec.paymentMismatches.length > 0 && <Alert kind="error">Mismatched payments: {rec.paymentMismatches.map((m) => m.reference).join(', ')}</Alert>}
    </Card>
  );
}

export function Reinstatements() {
  const res = useLoad(() => api.get('/reinstatements'));
  const act = useAction();
  const decide = (r, approve) => {
    const reason = approve ? '' : window.prompt('Reason for declining');
    if (!approve && !reason) return;
    act.run(async () => { await api.post(`/reinstatements/${r.id}/decision`, { approve, reason }); res.reload(); });
  };
  return (
    <>
      <PageHeader title="Reinstatement requests" subtitle="Lapsed life policies — review the good-health declaration before approving." />
      <ErrorBox error={act.error} />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No requests." columns={[
            { key: 'policyNumber', label: 'Policy', render: (r) => <Link to={`/policies/${r.policyId}`}>{r.policyNumber}</Link> },
            { key: 'createdAt', label: 'Requested', render: (r) => dateTime(r.createdAt) },
            { key: 'arrears', label: 'Arrears', num: true, render: (r) => money(r.arrears) },
            { key: 'goodHealthDeclaration', label: 'Good health', render: (r) => (r.goodHealthDeclaration ? 'Declared' : <Badge kind="warn">Not declared</Badge>) },
            { key: 'healthChanges', label: 'Health changes' },
            { key: 'status', label: 'Status', render: (r) => <><Badge>{r.status}</Badge>{r.reason && <div className="muted">{r.reason}</div>}</> },
            { key: 'x', label: '', render: (r) => r.status === 'Requested' && <div className="row"><button className="btn sm" onClick={() => decide(r, true)}>Approve</button><button className="btn sm danger" onClick={() => decide(r, false)}>Decline</button></div> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function PayoutReview() {
  const [tab, setTab] = useState('due');
  const data = useLoad(async () => {
    const [payouts, health, life, payments] = await Promise.all([api.get('/payouts'), api.get('/health-claims?status=Approved'), api.get('/life-claims'), api.get('/payments')]);
    const lifeDetails = await Promise.all(life.filter((c) => ['Approved', 'Partially Paid'].includes(c.status)).map((c) => api.get(`/life-claims/${c.id}`)));
    return { payouts, health, lifeDetails, payments };
  });
  const act = useAction();
  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;
  const { payouts, health, lifeDetails, payments } = data.data;
  const run = (fn, msg) => act.run(async () => { await fn(); data.reload(); }, msg);
  const inFlight = (claimId, benId) => payouts.some((p) => p.claimId === claimId && (!benId || p.beneficiaryId === benId) && ['initiated', 'success'].includes(p.status));
  const due = [
    ...health.filter((c) => !inFlight(c.id)).map((c) => ({ id: c.id, kind: 'health', claimNumber: c.claimNumber, payee: c.type === 'cashless' ? c.hospitalName : c.memberName, amount: c.approvedAmount, body: { claimType: 'health', claimId: c.id } })),
    ...lifeDetails.flatMap((c) => c.beneficiaries.filter((b) => b.allocation > 0 && !b.paid && !inFlight(c.id, b.id)).map((b) => ({ id: `${c.id}-${b.id}`, kind: 'life', claimNumber: c.claimNumber, payee: b.name, amount: b.allocation, body: { claimType: 'life', claimId: c.id, beneficiaryId: b.id } }))),
  ];
  return (
    <>
      <PageHeader title="Payment & payout review" subtitle="Payouts use unique references; repeated bank callbacks never duplicate a transfer." />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'due', label: `Ready for payout (${due.length})` }, { value: 'payouts', label: 'Payouts' }, { value: 'payments', label: 'Premium payments' }]} />
      {tab === 'due' && (
        <Card>
          <Table rows={due} empty="No approved claims awaiting payout." columns={[
            { key: 'claimNumber', label: 'Claim' }, { key: 'kind', label: 'Type', render: (x) => titleCase(x.kind) }, { key: 'payee', label: 'Payee' },
            { key: 'amount', label: 'Amount', num: true, render: (x) => money(x.amount) },
            { key: 'x', label: '', render: (x) => <button className="btn sm" disabled={act.busy} onClick={() => run(() => api.post('/payouts/initiate', x.body), 'Payout initiated')}>Initiate payout</button> },
          ]} />
        </Card>
      )}
      {tab === 'payouts' && (
        <Card>
          <Table rows={payouts} empty="No payouts yet." columns={[
            { key: 'reference', label: 'Reference', render: (p) => <code>{p.reference}</code> }, { key: 'claimNumber', label: 'Claim' },
            { key: 'payee', label: 'Payee', render: (p) => `${p.payee.name} · ${p.payee.account}` }, { key: 'amount', label: 'Amount', num: true, render: (p) => money(p.amount) },
            { key: 'status', label: 'Status', render: (p) => <><Badge>{p.status}</Badge>{p.callbacks.length > 1 && <small className="muted"> {p.callbacks.length} callbacks</small>}</> },
            { key: 'createdAt', label: 'Initiated', render: (p) => dateTime(p.createdAt) },
            { key: 'x', label: 'Simulate bank callback', render: (p) => (
              <div className="row">
                <button className="btn sm" disabled={act.busy} onClick={() => run(() => api.post(`/payouts/${p.reference}/simulate`, { outcome: 'success' }), p.status === 'initiated' ? 'Payout confirmed' : 'Duplicate callback ignored')}>Success</button>
                {p.status === 'initiated' && <button className="btn sm danger" disabled={act.busy} onClick={() => run(() => api.post(`/payouts/${p.reference}/simulate`, { outcome: 'failed' }), 'Payout failed — sent to exception queue')}>Fail</button>}
              </div>
            ) },
          ]} />
        </Card>
      )}
      {tab === 'payments' && (
        <Card>
          <Table rows={payments} empty="No payments." columns={[
            { key: 'reference', label: 'Reference', render: (p) => <code>{p.reference}</code> }, { key: 'description', label: 'For' },
            { key: 'amount', label: 'Amount', num: true, render: (p) => money(p.amount) },
            { key: 'status', label: 'Status', render: (p) => <><Badge>{p.status}</Badge>{p.failureReason && <div className="muted">{p.failureReason}</div>}</> },
            { key: 'createdAt', label: 'Date', render: (p) => dateTime(p.createdAt) },
          ]} />
        </Card>
      )}
    </>
  );
}

export function ExceptionQueue() {
  const [status, setStatus] = useState('open');
  const res = useLoad(() => api.get(`/admin/exceptions?status=${status}`), [status]);
  const act = useAction();
  const run = (fn, msg) => act.run(async () => { await fn(); res.reload(); }, msg);
  return (
    <>
      <PageHeader title="Exception & retry queue" subtitle="Failed auto-debits, failed payouts, amount mismatches and duplicate collections." />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }]} />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No exceptions." columns={[
            { key: 'type', label: 'Type', render: (e) => titleCase(e.type) }, { key: 'error', label: 'Problem' },
            { key: 'ref', label: 'Reference', render: (e) => <code>{e.data?.reference}</code> },
            { key: 'attempts', label: 'Retries', num: true },
            { key: 'createdAt', label: 'Raised', render: (e) => dateTime(e.createdAt) },
            { key: 'history', label: 'History', render: (e) => e.history.map((h, i) => <div key={i}><small>{dateTime(h.at)} {h.by}: {h.action} {h.note || h.result?.reference || ''}</small></div>) },
            { key: 'x', label: '', render: (e) => e.status === 'open' && (
              <div className="row">
                {['autopay_failed', 'payout_failed'].includes(e.type) && <button className="btn sm" disabled={act.busy} onClick={() => run(() => api.post(`/admin/exceptions/${e.id}/retry`, { outcome: 'success' }), 'Retried')}>Retry</button>}
                <button className="btn sm secondary" disabled={act.busy} onClick={() => { const n = window.prompt(e.type === 'duplicate_collection' ? 'Resolution note (marks refund issued)' : 'Resolution note'); if (n) run(() => api.post(`/admin/exceptions/${e.id}/resolve`, { note: n }), 'Resolved'); }}>Resolve</button>
              </div>
            ) },
          ]} />
        )}
      </Card>
    </>
  );
}

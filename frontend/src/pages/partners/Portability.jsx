// Portability & migration: customer requests and VHC oversight (admins act only for the sandbox insurer).
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, money, titleCase, toPaise } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, PageHeader, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { PortabilityDecision } from './InsurerPortal.jsx';

const STATUS_HELP = {
  Submitted: 'Sent to the receiving insurer. Only the insurer can approve or reject it.',
  'Documents Requested': 'The insurer needs more documents from you.',
  'Under Insurer Review': 'The insurer is reviewing your request.',
  'Approved by Insurer': 'Approved by the insurer. Continue with a proposal for the new product; the insurer applies any waiting-period credit.',
  'Rejected by Insurer': 'The insurer did not approve this request.',
  Withdrawn: 'You withdrew this request.',
};

export function CustomerPortability() {
  const [params] = useSearchParams();
  const res = useLoad(() => Promise.all([api.get('/partners/portability'), api.get('/plans?product=health'), api.get('/policies')]));
  const [tab, setTab] = useState(params.get('policy') ? 'new' : 'requests');
  if (res.loading) return <><PageHeader title="Portability & migration" /><Loading /></>;
  if (res.error) return <ErrorBox error={res.error} />;
  const [requests, plans, policies] = res.data;
  return (
    <>
      <PageHeader title="Portability & migration" subtitle="Move your health cover to another product while asking the insurer to keep credit for your continuous cover." />
      <Alert kind="info">Portability (from another insurer) and migration (between products of the same insurer) are decided only by the receiving insurer. VHC passes on your request and never shows it as approved before the insurer decides.</Alert>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'requests', label: `My requests (${requests.length})` }, { value: 'new', label: 'New request' }]} />
      {tab === 'requests' && (requests.length ? requests.map((r) => <RequestCard key={r.id} r={r} reload={res.reload} />) : <Card><Empty>No requests yet.</Empty></Card>)}
      {tab === 'new' && <NewRequest plans={plans} policies={policies.filter((p) => p.product === 'health')} initialPolicy={params.get('policy')} onDone={() => { res.reload(); setTab('requests'); }} />}
    </>
  );
}

function RequestCard({ r, reload }) {
  const [note, setNote] = useState('');
  const act = useAction();
  const go = (body) => act.run(async () => { await api.post(`/partners/portability/${r.id}/action`, body); reload(); });
  const open = !['Approved by Insurer', 'Rejected by Insurer', 'Withdrawn'].includes(r.status);
  return (
    <Card title={`${r.reference} · ${titleCase(r.type)}`} actions={<Badge>{r.status}</Badge>}>
      <p className="muted" style={{ marginTop: 0 }}>{STATUS_HELP[r.status]}</p>
      <div className="grid grid-2">
        <KV items={[['From', `${r.from.insurerName} · ${r.from.policyNumber}`], ['Current policy ends', date(r.from.policyEndDate)], ['Continuous cover', `${r.from.continuousCoverYears} years`],
          ['To', `${r.toPlanName} (${r.toInsurerName})`], ['Requested sum insured', money(r.requestedSumInsured)], r.timing && ['Timing', r.timing.note],
          r.decision && ['Insurer decision', `${titleCase(r.decision.decision)} by ${r.decision.by}${r.decision.reason ? ` — ${r.decision.reason}` : r.decision.note ? ` — ${r.decision.note}` : ''}`]]} />
        <Timeline items={r.history} />
      </div>
      {r.documentsRequested?.length > 0 && <Alert kind={r.status === 'Documents Requested' ? 'warn' : 'info'}>Documents requested: {r.documentsRequested.map((d) => `${d.name} (${d.status})`).join(', ')}. Upload them in <Link to="/documents">Documents</Link>, then confirm below.</Alert>}
      <ErrorBox error={act.error} />
      {r.status === 'Documents Requested' && (
        <div className="row" style={{ marginTop: '.5rem' }}>
          <input aria-label="What you provided" placeholder="What you provided" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button className="btn" disabled={act.busy || !note.trim()} onClick={() => go({ action: 'respond', note })}>Send to insurer</button>
        </div>
      )}
      {open && <button className="btn ghost sm" style={{ marginTop: '.5rem' }} disabled={act.busy} onClick={() => window.confirm('Withdraw this request?') && go({ action: 'withdraw' })}>Withdraw request</button>}
    </Card>
  );
}

function NewRequest({ plans, policies, initialPolicy, onDone }) {
  const [type, setType] = useState(initialPolicy ? 'migration' : 'portability');
  const [f, setF] = useState({ insurerName: '', policyNumber: '', productName: '', sumInsured: '', policyEndDate: '', continuousCoverYears: '', claimsInLastYear: false, fromPolicyId: initialPolicy || '', toPlanId: '', requestedSumInsured: '' });
  const act = useAction();
  const fromPolicy = policies.find((p) => p.id === f.fromPolicyId);
  const targets = type === 'migration' ? plans.filter((p) => fromPolicy && p.id !== fromPolicy.planId && p.insurer?.id === fromPolicy.insurerId) : plans;
  const target = plans.find((p) => p.id === f.toPlanId);
  const submit = () => act.run(async () => {
    const body = type === 'migration'
      ? { type, fromPolicyId: f.fromPolicyId, toPlanId: f.toPlanId, requestedSumInsured: f.requestedSumInsured ? Number(f.requestedSumInsured) : undefined }
      : { type, toPlanId: f.toPlanId, requestedSumInsured: f.requestedSumInsured ? Number(f.requestedSumInsured) : undefined,
        from: { insurerName: f.insurerName, policyNumber: f.policyNumber, productName: f.productName, sumInsured: toPaise(f.sumInsured) || undefined, policyEndDate: f.policyEndDate, continuousCoverYears: f.continuousCoverYears === '' ? null : Number(f.continuousCoverYears), claimsInLastYear: f.claimsInLastYear } };
    await api.post('/partners/portability', body);
    onDone();
  });
  return (
    <Card title="New request">
      <div className="seg" role="group" aria-label="Request type" style={{ marginBottom: '1rem' }}>
        <button type="button" className={type === 'portability' ? 'on' : ''} aria-pressed={type === 'portability'} onClick={() => setType('portability')}>Port from another insurer</button>
        <button type="button" className={type === 'migration' ? 'on' : ''} aria-pressed={type === 'migration'} onClick={() => setType('migration')}>Migrate my VHC policy</button>
      </div>
      <div className="form-grid">
        {type === 'portability' ? (
          <>
            <Field label="Current insurer"><input value={f.insurerName} onChange={(e) => setF({ ...f, insurerName: e.target.value })} /></Field>
            <Field label="Current policy number"><input value={f.policyNumber} onChange={(e) => setF({ ...f, policyNumber: e.target.value })} /></Field>
            <Field label="Current product (optional)"><input value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} /></Field>
            <Field label="Current sum insured (₹)"><input inputMode="decimal" value={f.sumInsured} onChange={(e) => setF({ ...f, sumInsured: e.target.value })} /></Field>
            <Field label="Current policy end date"><input type="date" value={f.policyEndDate} onChange={(e) => setF({ ...f, policyEndDate: e.target.value })} /></Field>
            <Field label="Years of continuous cover" hint="Without a break, across insurers"><input inputMode="numeric" value={f.continuousCoverYears} onChange={(e) => setF({ ...f, continuousCoverYears: e.target.value })} /></Field>
            <label className="check full"><input type="checkbox" checked={f.claimsInLastYear} onChange={(e) => setF({ ...f, claimsInLastYear: e.target.checked })} /> I made a claim in the last policy year</label>
          </>
        ) : (
          <Field label="Policy to migrate" className="full">
            <select value={f.fromPolicyId} onChange={(e) => setF({ ...f, fromPolicyId: e.target.value, toPlanId: '' })}>
              <option value="">— select —</option>
              {policies.map((p) => <option key={p.id} value={p.id}>{p.policyNumber} · {p.planName} · ends {date(p.endDate)}</option>)}
            </select>
          </Field>
        )}
        <Field label="Move to product">
          <select value={f.toPlanId} onChange={(e) => setF({ ...f, toPlanId: e.target.value, requestedSumInsured: '' })}>
            <option value="">— select —</option>
            {targets.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.insurer?.name}{p.sandbox ? ' (sandbox)' : ''}</option>)}
          </select>
        </Field>
        {target && (
          <Field label="Requested sum insured">
            <select value={f.requestedSumInsured} onChange={(e) => setF({ ...f, requestedSumInsured: e.target.value })}>
              <option value="">Same as current</option>
              {target.config.coverageOptions.map((c) => <option key={c.amount} value={c.amount}>{money(c.amount)}</option>)}
            </select>
          </Field>
        )}
      </div>
      {type === 'migration' && fromPolicy && targets.length === 0 && <Alert kind="info">No other product of {fromPolicy.insurerName} is available to migrate to.</Alert>}
      <ErrorBox error={act.error} />
      <div className="row" style={{ marginTop: '1rem' }}><button className="btn" disabled={act.busy || !f.toPlanId} onClick={submit}>Submit to insurer</button></div>
    </Card>
  );
}

/** VHC oversight list (admin, operations, compliance, auditor). Admins can act only for the sandbox insurer. */
export function PortabilityOversight() {
  const { user } = useAuth();
  const res = useLoad(() => api.get('/partners/portability'));
  const [open, setOpen] = useState(null);
  return (
    <>
      <PageHeader title="Portability requests" subtitle="All portability and migration requests. Decisions belong to the receiving insurer." />
      <Card>
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No requests." onRowClick={setOpen} columns={[
            { key: 'reference', label: 'Reference' }, { key: 'customerName', label: 'Customer' }, { key: 'type', label: 'Type', render: (p) => titleCase(p.type) },
            { key: 'toInsurerName', label: 'Receiving insurer' }, { key: 'toPlanName', label: 'Product' }, { key: 'status', label: 'Status', render: (p) => <Badge>{p.status}</Badge> },
          ]} />
        )}
      </Card>
      {open && <PortabilityDecision p={open} canAct={user.role === 'admin' && open.toInsurerSandbox} basePath="/partners/portability" onClose={() => setOpen(null)} onDone={() => { setOpen(null); res.reload(); }} />}
    </>
  );
}

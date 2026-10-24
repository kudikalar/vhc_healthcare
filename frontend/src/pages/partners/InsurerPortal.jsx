// Insurer partner portal (insurer_admin decides; insurer_user reads). Everything is scoped by the server to
// the signed-in user's own insurer organisation.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, titleCase } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { SandboxTag, bp, minutes } from './common.jsx';
import { PerformanceView } from './Insurers.jsx';

const proposalColumns = [
  { key: 'applicationNumber', label: 'Proposal' },
  { key: 'planName', label: 'Product' },
  { key: 'proposerName', label: 'Proposer' },
  { key: 'sumInsured', label: 'Sum insured', num: true, render: (a) => money(a.sumInsured) },
  { key: 'premium', label: 'Premium', num: true, render: (a) => money(a.premium) },
  { key: 'status', label: 'Status', render: (a) => <Badge>{a.status}</Badge> },
  { key: 'paidAt', label: 'Paid', render: (a) => dateTime(a.paidAt) },
];

export function InsurerHome() {
  const { user } = useAuth();
  const res = useLoad(() => Promise.all([api.get('/partners/portal/summary'), api.get('/partners/portal/proposals?status=Issuance%20Pending')]));
  const nav = useNavigate();
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const [s, pending] = res.data;
  const a = s.analytics;
  return (
    <>
      <PageHeader title={s.insurer.name} subtitle={`Insurer partner portal · ${user.role === 'insurer_admin' ? 'Partner admin' : 'Partner user (read-only)'}`} actions={<>{s.insurer.sandbox && <SandboxTag />}<Badge>{s.insurer.status}</Badge></>} />
      {s.insurer.sandbox && <Alert kind="warn">This is a synthetic sandbox insurer. Proposals, payments and policies here are test data; no real cover is issued.</Alert>}
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <Stat label="Authorised products" value={a.products} to="/insurer/products" />
        <Stat label="Proposals awaiting issuance" value={a.proposalsAwaitingIssuance} to="/insurer/proposals" />
        <Stat label="Issued policies" value={a.issuedPolicies} to="/insurer/policies" />
        <Stat label="Quote → issue conversion" value={bp(a.quoteToIssueConversionBp)} to="/insurer/analytics" />
        <Stat label="Median issuance turnaround" value={minutes(a.medianIssuanceTurnaroundMinutes)} to="/insurer/analytics" />
        <Stat label="Portability requests open" value={s.pendingPortability} to="/insurer/portability" />
      </div>
      <Card title="Waiting for your issuance decision" actions={<Link to="/insurer/proposals" className="btn sm secondary">All proposals</Link>}>
        <Table rows={pending.slice(0, 8)} empty="No proposals are waiting for a decision." onRowClick={(p) => nav(`/insurer/proposals/${p.id}`)} columns={proposalColumns} />
        {!s.canDecide && <p className="pt-muted-sm">Your role is read-only; a partner admin issues or declines proposals.</p>}
      </Card>
    </>
  );
}

const PROPOSAL_TABS = [['Issuance Pending', 'Awaiting decision'], ['Issued', 'Issued'], ['Declined by Insurer', 'Declined']];

export function InsurerProposals() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'Issuance Pending';
  const res = useLoad(() => api.get(`/partners/portal/proposals?status=${encodeURIComponent(status)}`), [status]);
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Proposals" subtitle="Proposals for your products after the customer's payment has been captured. Issue or decline each one." />
      <Tabs value={status} onChange={(v) => setParams({ status: v })} tabs={PROPOSAL_TABS.map(([value, label]) => ({ value, label }))} />
      <Card>{res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : <Table rows={res.data} empty="Nothing here." onRowClick={(p) => nav(`/insurer/proposals/${p.id}`)} columns={proposalColumns} />}</Card>
    </>
  );
}

export function InsurerProposal() {
  const { id } = useParams();
  const { user } = useAuth();
  const res = useLoad(() => api.get(`/partners/portal/proposals/${id}`), [id]);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const p = res.data;
  const canDecide = user.role === 'insurer_admin' && p.status === 'Issuance Pending';
  const decide = (decision) => act.run(async () => {
    const r = await api.post(`/partners/portal/proposals/${id}/decision`, { decision, reason: decision === 'declined' ? reason : undefined, insurerReference: ref || undefined });
    setDeclining(false);
    res.reload();
    return r;
  }, (r) => (r.status === 'issued' ? `Policy ${r.policyNumber} issued` : `Declined — refund ${r.refund?.reference} initiated for the customer`));
  return (
    <>
      <PageHeader title={p.applicationNumber} subtitle={`${p.planName} · version ${p.planVersion}`} actions={<Badge>{p.status}</Badge>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <div className="grid grid-2">
        <Card title="Proposal">
          <KV items={[['Proposer', p.proposerName], ['Cover start', date(p.startDate)], ['Sum insured / assured', money(p.sumInsured)], ['Annual premium', money(p.premium)],
            ['First payment', `${money(p.firstPayment)} · ${p.paymentReference || '—'}`], ['Paid', dateTime(p.paidAt)], ['Submitted', dateTime(p.submittedAt)],
            ['VHC underwriting', p.underwriting.reviewed ? `Reviewed${p.underwriting.revisedTerms ? ' — revised terms accepted' : ''}` : 'Not required'],
            p.issuance?.insurerReference && ['Your reference', p.issuance.insurerReference]]} />
        </Card>
        <Card title="Insured persons">
          <Table rows={p.members.map((m, k) => ({ ...m, id: k }))} columns={[
            { key: 'fullName', label: 'Name' }, { key: 'relationship', label: 'Relationship', render: (m) => titleCase(m.relationship) }, { key: 'age', label: 'Age at start', num: true },
            { key: 'declaredConditions', label: 'Declared conditions', render: (m) => (m.declaredConditions ? <Badge kind="warn">Yes</Badge> : 'No') },
            { key: 'tobacco', label: 'Tobacco', render: (m) => (m.tobacco ? 'Yes' : 'No') },
          ]} />
          <p className="pt-muted-sm">{p.decisionNote}</p>
        </Card>
      </div>
      {canDecide && (
        <Card title="Issuance decision">
          <p className="muted" style={{ marginTop: 0 }}>The customer has paid. Issuing creates the policy record from your confirmation; declining triggers a full refund to the customer.</p>
          <div className="form-grid">
            <Field label="Your policy / reference number (optional)"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          </div>
          <div className="row" style={{ marginTop: '.75rem' }}>
            <button className="btn" disabled={act.busy} onClick={() => decide('issued')}>Issue policy</button>
            <button className="btn danger" disabled={act.busy} onClick={() => setDeclining(true)}>Decline</button>
          </div>
        </Card>
      )}
      {user.role !== 'insurer_admin' && p.status === 'Issuance Pending' && <Alert kind="info">Read-only access: a partner admin must issue or decline this proposal.</Alert>}
      <Card title="Issuance timeline"><Timeline items={p.timeline} /></Card>
      <Modal open={declining} title="Decline proposal" onClose={() => setDeclining(false)}>
        <Field label="Reason (shared with VHC and the customer)"><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={act.error} />
        <div className="row end" style={{ marginTop: '1rem' }}><button className="btn danger" disabled={act.busy || !reason.trim()} onClick={() => decide('declined')}>Decline and refund</button></div>
      </Modal>
    </>
  );
}

export function InsurerPolicies() {
  const res = useLoad(() => api.get('/partners/portal/policies'));
  return (
    <>
      <PageHeader title="Issued policies" subtitle="Policies issued on your confirmation. Medical declarations are not shown here." />
      <Card>{res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Table rows={res.data} empty="No policies issued yet." columns={[
          { key: 'policyNumber', label: 'Policy no.', render: (p) => <><strong>{p.policyNumber}</strong>{p.insurerPolicyReference && <div className="pt-muted-sm">{p.insurerPolicyReference}</div>}</> },
          { key: 'planName', label: 'Product', render: (p) => <>{p.planName}<div className="pt-muted-sm pt-mono">{p.productUin} · v{p.planVersion}</div></> },
          { key: 'holderName', label: 'Policyholder' },
          { key: 'status', label: 'Status', render: (p) => <Badge>{p.status}</Badge> },
          { key: 'dates', label: 'Cover', render: (p) => `${date(p.startDate)} – ${date(p.endDate)}` },
          { key: 'sumInsured', label: 'Sum insured', num: true, render: (p) => money(p.sumInsured) },
          { key: 'annualPremium', label: 'Premium', num: true, render: (p) => money(p.annualPremium) },
        ]} />
      )}</Card>
    </>
  );
}

export function InsurerProducts() {
  const res = useLoad(() => api.get('/partners/portal/products'));
  return (
    <>
      <PageHeader title="Your products" subtitle="Products authorised under your agreement with their UIN and current version." />
      <Card>{res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Table rows={res.data} empty="No products authorised yet." columns={[
          { key: 'name', label: 'Product', render: (p) => <>{p.name} {p.sandbox && <SandboxTag />}</> },
          { key: 'uin', label: 'UIN', render: (p) => <span className="pt-mono">{p.uin}</span> },
          { key: 'version', label: 'Version', render: (p) => `v${p.version} (${p.versions} total) · ${date(p.versionDate)}` },
          { key: 'type', label: 'Type', render: (p) => `${titleCase(p.product)} · ${titleCase(p.type)}` },
          { key: 'distribution', label: 'On sale', render: (p) => (p.distribution.allowed ? <Badge kind="ok">Yes{p.distribution.sandbox ? ' (sandbox)' : ''}</Badge> : <span className="pt-muted-sm">{p.distribution.reason}</span>) },
          { key: 'policiesIssued', label: 'Policies', num: true },
        ]} />
      )}</Card>
    </>
  );
}

export function InsurerAnalytics() {
  const res = useLoad(() => api.get('/partners/portal/analytics'));
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <>
      <PageHeader title="Partner performance" subtitle="Computed only from your organisation's proposals, quotes, policies and renewals." />
      <PerformanceView a={res.data} />
    </>
  );
}

export function InsurerPortability() {
  const { user } = useAuth();
  const res = useLoad(() => api.get('/partners/portal/portability'));
  const [open, setOpen] = useState(null);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <>
      <PageHeader title="Portability & migration" subtitle="Requests to move into your products. Only your organisation can approve or reject them." />
      <Card>
        <Table rows={res.data} empty="No requests." onRowClick={(p) => setOpen(p)} columns={[
          { key: 'reference', label: 'Reference' }, { key: 'type', label: 'Type', render: (p) => titleCase(p.type) }, { key: 'customerName', label: 'Customer' },
          { key: 'from', label: 'From', render: (p) => `${p.from.insurerName} · ${p.from.policyNumber}` }, { key: 'toPlanName', label: 'To product' },
          { key: 'years', label: 'Continuous cover', render: (p) => `${p.from.continuousCoverYears} yrs` },
          { key: 'status', label: 'Status', render: (p) => <Badge>{p.status}</Badge> },
        ]} />
      </Card>
      {open && <PortabilityDecision p={open} canAct={user.role === 'insurer_admin'} basePath="/partners/portal/portability" onClose={() => setOpen(null)} onDone={() => { setOpen(null); res.reload(); }} />}
    </>
  );
}

/** Insurer-side review dialog (also used by VHC admins acting for the sandbox insurer). */
export function PortabilityDecision({ p, canAct, basePath, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [docs, setDocs] = useState('');
  const act = useAction();
  const go = (body) => act.run(async () => { await api.post(`${basePath}/${p.id}/action`, body); onDone(); });
  const final = ['Approved by Insurer', 'Rejected by Insurer', 'Withdrawn'].includes(p.status);
  return (
    <Modal open large title={`${p.reference} — ${p.status}`} onClose={onClose}>
      <KV items={[['Customer', p.customerName], ['Type', titleCase(p.type)], ['Current insurer', p.from.insurerName], ['Current policy', `${p.from.policyNumber}${p.from.productName ? ` · ${p.from.productName}` : ''}`],
        ['Current sum insured', money(p.from.sumInsured)], ['Current policy ends', date(p.from.policyEndDate)], ['Continuous cover', `${p.from.continuousCoverYears} years`],
        ['Claims in last year', p.from.claimsInLastYear ? 'Yes' : 'No'], ['Move to', `${p.toPlanName} (${money(p.requestedSumInsured)})`], ['Timing', p.timing?.note || '—']]} />
      {p.customerResponses?.length > 0 && <Alert kind="info">Customer responses: {p.customerResponses.map((r) => r.note).join(' · ')}</Alert>}
      <Timeline items={p.history} />
      <ErrorBox error={act.error} />
      {canAct && !final && (
        <div className="stack" style={{ marginTop: '1rem' }}>
          {p.status === 'Submitted' && <button className="btn secondary" disabled={act.busy} onClick={() => go({ action: 'start_review' })}>Start review</button>}
          {['Submitted', 'Under Insurer Review'].includes(p.status) && (
            <div className="row">
              <input aria-label="Documents to request (comma separated)" placeholder="Documents to request, comma separated" value={docs} onChange={(e) => setDocs(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
              <button className="btn secondary" disabled={act.busy || !docs.trim()} onClick={() => go({ action: 'request_documents', documents: docs.split(',').map((x) => x.trim()).filter(Boolean) })}>Request documents</button>
            </div>
          )}
          <Field label="Decision note / reason"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row">
            <button className="btn" disabled={act.busy || p.status !== 'Under Insurer Review'} title={p.status !== 'Under Insurer Review' ? 'Review the request before approving' : ''} onClick={() => go({ action: 'approve', note })}>Approve</button>
            <button className="btn danger" disabled={act.busy || !note.trim()} onClick={() => go({ action: 'reject', reason: note })}>Reject</button>
          </div>
        </div>
      )}
      {!canAct && !final && <Empty>Read-only. A partner admin decides this request.</Empty>}
    </Modal>
  );
}

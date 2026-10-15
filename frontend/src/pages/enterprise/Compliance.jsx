// Compliance & audit oversight (§45): audit search, access/disclosure log, consent register,
// data-rights request queue (compliance officer decides), AI answer evaluations, public disclosures.
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, Loading, Modal, PageHeader, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { useT } from './i18n.jsx';
import './enterprise.css';

const TABS = [
  ['audit', '/compliance/audit', 'Audit log'],
  ['access', '/compliance/access', 'Access & disclosure log'],
  ['requests', '/compliance/data-requests', 'Data requests'],
  ['consents', '/compliance/consents', 'Consent register'],
  ['ai', '/compliance/ai', 'AI evaluations'],
  ['disclosures', '/compliance/disclosures', 'Public disclosures'],
];

export default function CompliancePage() {
  const t = useT();
  const loc = useLocation();
  const nav = useNavigate();
  const tab = TABS.find(([, path]) => loc.pathname === path)?.[0] || 'audit';
  return (
    <>
      <PageHeader title={t('Compliance')} subtitle="Read-only oversight of who did what, who accessed which records, consents and data-rights requests." />
      <Tabs value={tab} onChange={(v) => nav(TABS.find(([k]) => k === v)[1])} tabs={TABS.map(([value, , label]) => ({ value, label: t(label) }))} />
      {tab === 'audit' && <AuditSearch />}
      {tab === 'access' && <AuditSearch access />}
      {tab === 'requests' && <DataRequests />}
      {tab === 'consents' && <Consents />}
      {tab === 'ai' && <AiEvaluations />}
      {tab === 'disclosures' && <Disclosures />}
    </>
  );
}

function AuditSearch({ access = false }) {
  const [f, setF] = useState({ action: '', entityType: '', actor: '', entityId: '', from: '', to: '' });
  const [q, setQ] = useState(f);
  const res = useLoad(() => api.get(`/enterprise/compliance/${access ? 'access-log' : 'audit'}?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`), [JSON.stringify(q), access]);
  return (
    <Card actions={<small className="muted">{access ? 'Document downloads, profile/ticket views and data exports' : 'Approvals, financial actions, configuration changes and sensitive access'}</small>}>
      <form className="ent-filters" onSubmit={(e) => { e.preventDefault(); setQ(f); }}>
        <Field label="Action contains"><input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="e.g. REFUND, DOWNLOAD" /></Field>
        <Field label="Entity type"><input value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })} placeholder="payment, user…" /></Field>
        <Field label="Entity id"><input value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value })} /></Field>
        <Field label="Actor"><input value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} /></Field>
        <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <button className="btn">Search</button>
      </form>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Table rows={res.data} empty="No matching records." columns={[
          { key: 'at', label: 'When', render: (l) => dateTime(l.at) },
          { key: 'actor', label: 'Actor', render: (l) => <>{l.actorName}<div className="muted">{l.actorRole}</div></> },
          { key: 'action', label: 'Action', render: (l) => <code>{l.action}</code> },
          { key: 'entity', label: 'Record', render: (l) => <span className="ent-wrap">{l.entityType} {l.entityId}</span> },
          { key: 'details', label: 'Details', render: (l) => <small className="ent-wrap ent-mono">{JSON.stringify(l.details)}</small> },
        ]} />
      )}
    </Card>
  );
}

function DataRequests() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const res = useLoad(() => api.get(`/enterprise/compliance/data-requests${status ? `?status=${status}` : ''}`), [status]);
  const [decide, setDecide] = useState(null);
  const act = useAction();
  const canDecide = ['compliance_officer', 'admin'].includes(user.role);
  const run = (r, action, note) => act.run(async () => { await api.post(`/enterprise/compliance/data-requests/${r.id}/decision`, { action, note }); setDecide(null); res.reload(); }, `Request ${action.replace('_', ' ')}`);
  return (
    <>
      {!canDecide && <Alert kind="info">Read-only: data-rights requests are decided by a compliance officer.</Alert>}
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Card actions={<select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['requested', 'under_review', 'completed', 'denied'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select>}>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No data-rights requests." columns={[
            { key: 'reference', label: 'Request', render: (r) => <><code>{r.reference}</code><div className="muted">{dateTime(r.createdAt)}</div></> },
            { key: 'customer', label: 'Customer', render: (r) => <>{r.customerName}<div className="muted">{r.customerEmail}</div></> },
            { key: 'type', label: 'Type', render: (r) => r.typeLabel },
            { key: 'reason', label: 'Reason', render: (r) => r.reason || '—' },
            { key: 'retained', label: 'Records to retain', render: (r) => (r.retained ? <small>{r.retained.policies} policies ({r.retained.activePolicies} active), {r.retained.healthClaims} claims ({r.retained.openClaims} open), {r.retained.payments} payments</small> : '—') },
            { key: 'status', label: 'Status', render: (r) => <><Badge>{titleCase(r.status)}</Badge>{r.decision?.note && <div className="muted">{r.decision.note}</div>}</> },
            { key: 'x', label: '', render: (r) => canDecide && ['requested', 'under_review'].includes(r.status) && (
              <div className="row">
                {r.status === 'requested' && <button className="btn sm secondary" disabled={act.busy} onClick={() => run(r, 'start_review')}>Start review</button>}
                <button className="btn sm" onClick={() => setDecide({ r, action: 'complete', note: '' })}>Complete</button>
                <button className="btn sm danger" onClick={() => setDecide({ r, action: 'deny', note: '' })}>Deny</button>
              </div>
            ) },
          ]} />
        )}
      </Card>
      <Modal open={!!decide} title={decide ? `${decide.action === 'complete' ? 'Complete' : 'Deny'} ${decide.r.reference}` : ''} onClose={() => setDecide(null)}>
        {decide && (
          <form onSubmit={(e) => { e.preventDefault(); run(decide.r, decide.action, decide.note); }}>
            {decide.r.type === 'deletion' && decide.action === 'complete' && (
              <Alert kind="warn">Completing closes the customer's login, withdraws marketing consent and erases optional data. Policies, claims, payments, consents and audit records are <strong>retained</strong> as legally required — they are never deleted.{decide.r.retained?.activePolicies ? ` This customer has ${decide.r.retained.activePolicies} active polic${decide.r.retained.activePolicies === 1 ? 'y' : 'ies'}; cover continues with the insurer.` : ''}</Alert>
            )}
            {decide.r.retentionRules && (
              <ul className="ent-list" style={{ fontSize: '.85rem' }}>{decide.r.retentionRules.map((x) => <li key={x.records}><strong>{x.records}:</strong> {x.basis}</li>)}</ul>
            )}
            <Field label={decide.action === 'deny' ? 'Reason (shown to the customer)' : 'Note (optional)'}><textarea rows={3} value={decide.note} required={decide.action === 'deny'} onChange={(e) => setDecide({ ...decide, note: e.target.value })} /></Field>
            <div className="row end" style={{ marginTop: '.8rem' }}><button className={`btn ${decide.action === 'deny' ? 'danger' : ''}`} disabled={act.busy}>Confirm</button></div>
          </form>
        )}
      </Modal>
    </>
  );
}

function Consents() {
  const [type, setType] = useState('');
  const res = useLoad(() => api.get(`/enterprise/compliance/consents${type ? `?type=${type}` : ''}`), [type]);
  return (
    <Card actions={<select aria-label="Consent type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All consent types</option><option value="terms_privacy">Terms & privacy</option><option value="marketing">Marketing</option></select>}>
      {res.loading ? <Loading /> : (
        <Table rows={res.data} empty="No consent records." columns={[
          { key: 'at', label: 'When', render: (c) => dateTime(c.at) },
          { key: 'name', label: 'Customer', render: (c) => <>{c.name}<div className="muted">{c.customerId} · {c.email}</div></> },
          { key: 'type', label: 'Consent', render: (c) => titleCase(c.type) },
          { key: 'granted', label: 'Decision', render: (c) => <Badge kind={c.granted ? 'ok' : 'warn'}>{c.granted ? 'Granted' : 'Withdrawn'}</Badge> },
          { key: 'version', label: 'Version', render: (c) => c.termsVersion || '—' },
          { key: 'source', label: 'Source', render: (c) => c.source || 'registration / profile' },
        ]} />
      )}
    </Card>
  );
}

function AiEvaluations() {
  const res = useLoad(() => api.get('/ai/evaluations'));
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const tt = res.data.totals;
  return (
    <>
      <div className="ent-kpis" style={{ marginBottom: '1rem' }}>
        {[['Questions answered', tt.interactions], ['Rated helpful', tt.up], ['Rated unhelpful', tt.down], ['Abstained (could not confirm)', tt.abstained], ['Emergencies detected', tt.urgent], ['Handed to a person', tt.escalated]].map(([l, v]) => <div key={l} className="ent-kpi"><div className="label">{l}</div><div className="value">{v}</div></div>)}
      </div>
      <Card title="Recent ratings (no customer identities)">
        <Table rows={res.data.recent} empty="No ratings yet." columns={[
          { key: 'at', label: 'When', render: (e) => dateTime(e.at) }, { key: 'rating', label: 'Rating', render: (e) => <Badge kind={e.rating === 'up' ? 'ok' : 'warn'}>{e.rating === 'up' ? 'Helpful' : 'Unhelpful'}</Badge> },
          { key: 'questionPreview', label: 'Question (preview)' }, { key: 'citations', label: 'Sources cited', render: (e) => (e.citations || []).join(', ') || '—' },
          { key: 'language', label: 'Language' }, { key: 'mode', label: 'Engine' }, { key: 'comment', label: 'Comment', render: (e) => e.comment || '—' },
        ]} />
      </Card>
    </>
  );
}

function Disclosures() {
  const { user } = useAuth();
  const res = useLoad(() => api.get('/enterprise/public/config'));
  const [f, setF] = useState(null);
  const act = useAction();
  if (res.loading) return <Loading />;
  const c = res.data;
  const edit = user.role === 'admin';
  const form = f || { irdai: { ...c.irdai }, contact: { ...c.contact }, grievanceOfficer: { ...c.grievanceOfficer } };
  const set = (sec, k, v) => setF({ ...form, [sec]: { ...form[sec], [k]: v } });
  return (
    <Card title="Public disclosures shown on the website">
      {!edit && <Alert kind="info">Only a super administrator can change these.</Alert>}
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); act.run(async () => { res.setData(await api.put('/enterprise/public/config', form)); setF(null); }, 'Disclosures updated'); }}>
        <Field label="IRDAI registration status">
          <select disabled={!edit} value={form.irdai.status} onChange={(e) => set('irdai', 'status', e.target.value)}><option value="pending">Pending</option><option value="not_applicable">Not applicable</option><option value="registered">Registered</option></select>
        </Field>
        <Field label="Registration number" hint="Exactly as on the IRDAI certificate"><input disabled={!edit} value={form.irdai.registrationNo} onChange={(e) => set('irdai', 'registrationNo', e.target.value)} /></Field>
        <Field label="Registration category"><input disabled={!edit} value={form.irdai.category} onChange={(e) => set('irdai', 'category', e.target.value)} placeholder="e.g. Insurance web aggregator / broker" /></Field>
        <Field label="Valid till"><input disabled={!edit} type="date" value={form.irdai.validTill} onChange={(e) => set('irdai', 'validTill', e.target.value)} /></Field>
        <Field label="Public note" className="full"><textarea disabled={!edit} rows={2} value={form.irdai.note} onChange={(e) => set('irdai', 'note', e.target.value)} /></Field>
        <Field label="Support email"><input disabled={!edit} value={form.contact.email} onChange={(e) => set('contact', 'email', e.target.value)} /></Field>
        <Field label="Support phone"><input disabled={!edit} value={form.contact.phone} onChange={(e) => set('contact', 'phone', e.target.value)} /></Field>
        <Field label="Support hours" className="full"><input disabled={!edit} value={form.contact.hours} onChange={(e) => set('contact', 'hours', e.target.value)} /></Field>
        <Field label="Grievance officer"><input disabled={!edit} value={form.grievanceOfficer.name} onChange={(e) => set('grievanceOfficer', 'name', e.target.value)} /></Field>
        <Field label="Grievance officer email"><input disabled={!edit} value={form.grievanceOfficer.email} onChange={(e) => set('grievanceOfficer', 'email', e.target.value)} /></Field>
        {edit && <div><button className="btn" disabled={act.busy}>Save disclosures</button></div>}
      </form>
    </Card>
  );
}

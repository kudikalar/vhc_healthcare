// VHC grievances & appeals: customer pages (/grievances, /grievances/:id) and the staff queue
// (/ops/grievances, /ops/grievances/:id; read-only for compliance officers and auditors).
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, idempotencyKey } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, PageHeader, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';
import { GrievanceGuidance, InsurerComms, SlaChip } from './components.jsx';

const CATEGORIES = { claim: 'Claim', policy_servicing: 'Policy servicing', sales_mis_selling: 'Sales / mis-selling', refund: 'Refund', other: 'Other' };
const OUTCOMES = { upheld: 'Upheld', partially_upheld: 'Partially upheld', not_upheld: 'Not upheld', referred_to_insurer: 'Referred to insurer' };
const STATUSES = ['Acknowledged', 'In Progress', 'Awaiting Customer', 'Escalated to Insurer', 'Resolved', 'Appealed', 'Closed'];
const STAFF = ['claims_officer', 'admin', 'support_manager', 'support_agent'];
const ASSIGNERS = ['claims_officer', 'admin', 'support_manager'];
const DOC_CATS = ['other', 'bill', 'medical_report', 'discharge_summary', 'identity', 'bank_proof'];

// ---------------- customer ----------------
function NewGrievance({ onCreated, defaultClaim }) {
  const data = useLoad(async () => {
    const [claims, policies] = await Promise.all([api.get('/health-claims'), api.get('/policies')]);
    return { claims, policies };
  });
  const [key] = useState(idempotencyKey);
  const [f, setF] = useState({ category: 'claim', subject: '', description: '', claimId: defaultClaim || '', policyId: '' });
  const act = useAction();
  if (data.loading) return <Loading />;
  const set = (p) => setF({ ...f, ...p });
  const submit = () => act.run(async () => {
    const g = await api.post('/claims-ops/grievances', { ...f, claimId: f.claimId || undefined, policyId: f.policyId || undefined, idempotencyKey: key });
    onCreated(g);
  });
  return (
    <Card title="Raise a grievance with VHC">
      <div className="form-grid">
        <Field label="Category">
          <select value={f.category} onChange={(e) => set({ category: e.target.value })}>
            {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Related claim (optional)">
          <select value={f.claimId} onChange={(e) => set({ claimId: e.target.value })}>
            <option value="">— none —</option>
            {(data.data?.claims || []).map((c) => <option key={c.id} value={c.id}>{c.claimNumber} · {c.memberName}</option>)}
          </select>
        </Field>
        {!f.claimId && (
          <Field label="Related policy (optional)">
            <select value={f.policyId} onChange={(e) => set({ policyId: e.target.value })}>
              <option value="">— none —</option>
              {(data.data?.policies || []).map((p) => <option key={p.id} value={p.id}>{p.policyNumber} · {p.planName}</option>)}
            </select>
          </Field>
        )}
        <Field label="Subject" className="full"><input maxLength={150} value={f.subject} onChange={(e) => set({ subject: e.target.value })} /></Field>
        <Field label="What happened and what outcome you expect" className="full"><textarea rows={5} maxLength={5000} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      </div>
      <ErrorBox error={act.error} />
      <div className="row" style={{ marginTop: '.75rem' }}>
        <button className="btn" disabled={act.busy || !f.subject.trim() || f.description.trim().length < 10} onClick={submit}>{act.busy ? 'Submitting…' : 'Submit grievance'}</button>
        <small className="muted">You will get a GRV reference and a response deadline immediately. You can attach documents next.</small>
      </div>
    </Card>
  );
}

export function GrievancesPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const list = useLoad(() => api.get('/claims-ops/grievances'));
  const meta = useLoad(() => api.get('/claims-ops/meta'));
  const showNew = params.get('new') === '1';
  return (
    <>
      <PageHeader title="Grievances" subtitle="Tell us when something has gone wrong with our service. Every grievance is acknowledged immediately and tracked against a response deadline."
        actions={!showNew && <button className="btn" onClick={() => setParams({ new: '1' })}>Raise a grievance</button>} />
      <GrievanceGuidance guidance={meta.data?.grievance.guidance} />
      {showNew && <NewGrievance defaultClaim={params.get('claim') || ''} onCreated={(g) => nav(`/grievances/${g.id}`)} />}
      <Card title="My grievances">
        {list.loading ? <Loading /> : <ErrorBox error={list.error} />}
        {list.data && (
          <Table rows={list.data} empty="You have not raised any grievances." onRowClick={(g) => nav(`/grievances/${g.id}`)} columns={[
            { key: 'reference', label: 'Reference' }, { key: 'subject', label: 'Subject' }, { key: 'categoryLabel', label: 'Category' },
            { key: 'status', label: 'Status', render: (g) => <Badge>{g.status}</Badge> },
            { key: 'responseDueAt', label: 'Response due', render: (g) => date(g.responseDueAt) },
          ]} />
        )}
      </Card>
    </>
  );
}

function Thread({ messages }) {
  return (
    <div className="co-thread" aria-live="polite">
      {messages.map((m) => (
        <div key={m.id} className={`co-msg ${m.from}${m.internal ? ' internal' : ''}`}>
          <div className="meta">{m.by} · {dateTime(m.at)}{m.internal ? ' · internal note' : ''}</div>
          <p>{m.text}</p>
        </div>
      ))}
    </div>
  );
}

function Reply({ g, onSaved, staff }) {
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const act = useAction();
  const send = () => act.run(async () => { onSaved(await api.post(`/claims-ops/grievances/${g.id}/messages`, { text, internal })); setText(''); });
  return (
    <>
      <Field label={staff ? 'Reply to the customer or add an internal note' : 'Your message'}><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <div className="row" style={{ marginTop: '.5rem' }}>
        <button className="btn" disabled={act.busy || !text.trim()} onClick={send}>{internal ? 'Add internal note' : 'Send'}</button>
        {staff && <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (not shown to the customer)</label>}
      </div>
    </>
  );
}

function Overview({ g }) {
  const clock = g.sla.primary || g.sla.clocks.at(-1);
  return (
    <KV items={[
      ['Reference', g.reference], ['Category', g.categoryLabel], ['Status', <Badge key="s">{g.status}</Badge>],
      ['Acknowledged', dateTime(g.acknowledgedAt)], ['Response due', <span key="d">{date(g.appeal?.dueAt || g.responseDueAt)} {clock && <SlaChip sla={clock} compact />}</span>],
      ['Case owner', g.ownerName || 'Being assigned'], g.claimNumber && ['Claim', g.claimNumber], g.policyNumber && ['Policy', g.policyNumber],
      g.insurerName && ['Insurer', g.insurerName],
    ]} />
  );
}

export function GrievanceDetail() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/claims-ops/grievances/${id}`), [id]);
  const act = useAction();
  const [reason, setReason] = useState('');
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const g = res.data;
  const open = g.status !== 'Closed';
  return (
    <>
      <PageHeader title={g.subject} subtitle={`${g.reference} · raised ${date(g.createdAt)}`} actions={<Badge>{g.status}</Badge>} />
      <Alert kind="ok">We acknowledged your grievance on {dateTime(g.acknowledgedAt)} and will respond by {date(g.responseDueAt)}.</Alert>
      <ErrorBox error={act.error} />
      {g.resolution && (
        <Card title={g.resolution.stage === 'appeal' ? 'Appeal outcome' : 'Resolution'}>
          <p><Badge>{g.resolution.outcomeLabel}</Badge> {g.resolution.summary}</p>
          <small className="muted">By {g.resolution.by} · {dateTime(g.resolution.at)}{g.resolution.documents.length ? ` · documents: ${g.resolution.documents.map((d) => d.filename).join(', ')}` : ''}</small>
          {g.status === 'Resolved' && (
            <div style={{ marginTop: '.8rem' }}>
              <div className="row">
                <button className="btn" disabled={act.busy} onClick={() => act.run(async () => res.setData(await api.post(`/claims-ops/grievances/${g.id}/close`, {})))}>Accept and close</button>
              </div>
            </div>
          )}
          {g.canAppeal && (
            <div style={{ marginTop: '.9rem' }}>
              <Field label="Not satisfied? Appeal once — tell us why" hint="A senior team member reviews appeals against a fresh deadline."><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <button className="btn secondary" style={{ marginTop: '.5rem' }} disabled={act.busy || reason.trim().length < 10} onClick={() => act.run(async () => res.setData(await api.post(`/claims-ops/grievances/${g.id}/appeal`, { reason })))}>Submit appeal</button>
            </div>
          )}
          {g.appeal && !g.canAppeal && g.status !== 'Appealed' && <p className="muted" style={{ marginTop: '.6rem' }}>You have used your appeal. If you remain dissatisfied with the insurer’s position, see the escalation routes below.</p>}
        </Card>
      )}
      <div className="grid grid-2">
        <Card title="Conversation">
          <Thread messages={g.messages} />
          {open && <Reply g={g} onSaved={res.setData} />}
        </Card>
        <div>
          <Card title="Details"><Overview g={g} /><p style={{ marginTop: '.8rem', whiteSpace: 'pre-wrap' }}>{g.description}</p></Card>
          {g.insurerComms.length > 0 && <Card title="Our communication with the insurer"><InsurerComms items={g.insurerComms} /></Card>}
        </div>
      </div>
      <DocumentPanel entityType="grievance" entityId={g.id} title="Attachments" canUpload={open} categories={DOC_CATS} />
      <GrievanceGuidance guidance={g.guidance} />
      <Card title="History"><Timeline items={g.history.map((h) => ({ ...h, status: h.action }))} /></Card>
      <p><Link to="/grievances">← All grievances</Link></p>
    </>
  );
}

// ---------------- staff ----------------
export function GrievanceQueue() {
  const { user } = useAuth();
  const [f, setF] = useState({ status: '', category: '', owner: '', q: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = useLoad(() => api.get(`/claims-ops/grievances${qs ? `?${qs}` : ''}`), [qs]);
  const nav = useNavigate();
  const readOnly = !STAFF.includes(user.role);
  const rows = list.data || [];
  return (
    <>
      <PageHeader title="Grievances" subtitle={readOnly ? 'Read-only oversight view' : 'VHC grievance & appeal case management'} />
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        {[['Open', rows.filter((g) => !['Resolved', 'Closed'].includes(g.status)).length], ['At risk', rows.filter((g) => g.sla?.state === 'at_risk').length], ['Overdue', rows.filter((g) => g.sla?.state === 'breached').length], ['Appeals', rows.filter((g) => g.appealed).length]].map(([l, v]) => (
          <div className="stat" key={l}><div className="label">{l}</div><div className="value">{v}</div></div>
        ))}
      </div>
      <Card>
        <div className="co-filters">
          <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          {!readOnly && <Field label="Owner"><select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="">Anyone</option><option value="me">Assigned to me</option></select></Field>}
          <Field label="Search"><input placeholder="Reference, subject, customer" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        </div>
        {list.loading ? <Loading /> : <ErrorBox error={list.error} />}
        {list.data && (
          <Table rows={rows} empty="No grievances match." onRowClick={(g) => nav(`/ops/grievances/${g.id}`)} columns={[
            { key: 'reference', label: 'Reference' }, { key: 'customerName', label: 'Customer' }, { key: 'subject', label: 'Subject' },
            { key: 'categoryLabel', label: 'Category' }, { key: 'ownerName', label: 'Owner', render: (g) => g.ownerName || '—' },
            { key: 'status', label: 'Status', render: (g) => <>{<Badge>{g.status}</Badge>}{g.appealed && <> <Badge kind="info">Appeal</Badge></>}</> },
            { key: 'sla', label: 'Deadline', render: (g) => <SlaChip sla={g.sla} compact /> },
          ]} />
        )}
      </Card>
    </>
  );
}

function StaffActions({ g, onSaved }) {
  const { user } = useAuth();
  const act = useAction();
  const people = useLoad(() => api.get('/claims-ops/grievances/assignees'));
  const [owner, setOwner] = useState(g.ownerId || '');
  const [note, setNote] = useState('');
  const [res, setRes] = useState({ summary: '', outcome: 'upheld', documentIds: [] });
  const [comm, setComm] = useState({ direction: 'outbound', subject: '', message: '', insurerRef: '' });
  const docs = useLoad(() => api.get(`/documents?entityType=grievance&entityId=${g.id}`), [g.id, g.updatedAt]);
  const post = (path, body, msg) => act.run(async () => onSaved(await api.post(`/claims-ops/grievances/${g.id}${path}`, body)), msg);
  if (g.status === 'Closed') return null;
  const resolved = g.status === 'Resolved';
  return (
    <Card title="Case actions">
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {ASSIGNERS.includes(user.role) && (
        <div className="row" style={{ marginBottom: '.8rem' }}>
          <Field label="Case owner"><select value={owner} onChange={(e) => setOwner(e.target.value)}>{(people.data || []).map((p) => <option key={p.id} value={p.id}>{p.name} ({titleCase(p.role)})</option>)}</select></Field>
          <button className="btn secondary sm" disabled={act.busy || owner === g.ownerId} onClick={() => post('/assign', { ownerId: owner }, 'Reassigned')}>Reassign</button>
        </div>
      )}
      {!resolved && (
        <>
          <Field label="Note (status change / escalation)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row" style={{ margin: '.5rem 0 1rem' }}>
            <button className="btn secondary sm" disabled={act.busy} onClick={() => post('/status', { status: 'In Progress', note }, 'Marked in progress')}>In progress</button>
            <button className="btn secondary sm" disabled={act.busy || !note.trim()} onClick={() => post('/status', { status: 'Awaiting Customer', note }, 'Waiting for customer')}>Ask customer for information</button>
            <button className="btn secondary sm" disabled={act.busy || !note.trim()} onClick={() => post('/escalate', { level: 'insurer', note }, 'Escalated to insurer')}>Escalate to insurer</button>
            <button className="btn secondary sm" disabled={act.busy || !note.trim()} onClick={() => post('/escalate', { level: 'internal', note }, 'Escalated internally')}>Escalate internally</button>
          </div>
          <details>
            <summary>Log insurer communication</summary>
            <div className="form-grid" style={{ marginTop: '.5rem' }}>
              <Field label="Direction"><select value={comm.direction} onChange={(e) => setComm({ ...comm, direction: e.target.value })}><option value="outbound">To insurer</option><option value="inbound">From insurer</option></select></Field>
              <Field label="Insurer reference"><input value={comm.insurerRef} onChange={(e) => setComm({ ...comm, insurerRef: e.target.value })} /></Field>
              <Field label="Subject" className="full"><input value={comm.subject} onChange={(e) => setComm({ ...comm, subject: e.target.value })} /></Field>
              <Field label="Message" className="full"><textarea value={comm.message} onChange={(e) => setComm({ ...comm, message: e.target.value })} /></Field>
            </div>
            <button className="btn sm" style={{ marginTop: '.5rem' }} disabled={act.busy || !comm.subject.trim()} onClick={() => post('/insurer-comms', comm, 'Communication logged').then(() => setComm({ ...comm, subject: '', message: '', insurerRef: '' }))}>Save</button>
          </details>
          <hr />
          <h4>{g.status === 'Appealed' ? 'Resolve appeal' : 'Resolve'}</h4>
          <div className="form-grid">
            <Field label="Outcome"><select value={res.outcome} onChange={(e) => setRes({ ...res, outcome: e.target.value })}>{Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Resolution documents (attached below)">
              <select multiple value={res.documentIds} onChange={(e) => setRes({ ...res, documentIds: [...e.target.selectedOptions].map((o) => o.value) })} style={{ minHeight: 70 }}>
                {(docs.data || []).map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
              </select>
            </Field>
            <Field label="Resolution summary (sent to the customer)" className="full"><textarea rows={3} value={res.summary} onChange={(e) => setRes({ ...res, summary: e.target.value })} /></Field>
          </div>
          <button className="btn" style={{ marginTop: '.5rem' }} disabled={act.busy || res.summary.trim().length < 10} onClick={() => post('/resolve', res, 'Resolved')}>Send resolution</button>
        </>
      )}
      {resolved && <button className="btn secondary" disabled={act.busy} onClick={() => post('/close', { note }, 'Closed')}>Close grievance</button>}
    </Card>
  );
}

export function StaffGrievanceDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const res = useLoad(() => api.get(`/claims-ops/grievances/${id}`), [id]);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const g = res.data;
  const staff = STAFF.includes(user.role);
  return (
    <>
      <PageHeader title={`${g.reference}: ${g.subject}`} subtitle={`${g.customerName} · ${g.categoryLabel} · raised ${dateTime(g.createdAt)}`} actions={<Badge>{g.status}</Badge>} />
      {!staff && <Alert kind="info">Read-only oversight view.</Alert>}
      {g.sla.breaches.length > 0 && <Alert kind="error">Deadline breached: {g.sla.breaches.map((b) => `${b.label} (due ${dateTime(b.dueAt)})`).join('; ')}</Alert>}
      <div className="grid grid-2">
        <Card title="Case"><Overview g={g} /><p style={{ marginTop: '.8rem', whiteSpace: 'pre-wrap' }}>{g.description}</p>
          {g.claimId && ['claims_officer', 'admin'].includes(user.role) && <Link to={`/ops/health-claims/${g.claimId}`}>Open claim {g.claimNumber}</Link>}
        </Card>
        <Card title="Conversation">
          <Thread messages={g.messages} />
          {staff && g.status !== 'Closed' && <Reply g={g} onSaved={res.setData} staff />}
        </Card>
      </div>
      {staff && <StaffActions g={g} onSaved={res.setData} />}
      <div className="grid grid-2">
        <Card title="Insurer communications"><InsurerComms items={g.insurerComms} /></Card>
        <Card title="Escalations & appeal">
          {g.escalations.length === 0 && !g.appeal ? <p className="muted">None.</p> : (
            <ul>
              {g.escalations.map((e, i) => <li key={i}>{dateTime(e.at)} · {e.level === 'insurer' ? 'To insurer' : 'Internal'} · {e.by}: {e.note}</li>)}
              {g.appeal && <li>{dateTime(g.appeal.at)} · Customer appeal: {g.appeal.reason}{g.appeal.resolvedAt ? ` (resolved ${dateTime(g.appeal.resolvedAt)})` : ` (due ${date(g.appeal.dueAt)})`}</li>}
            </ul>
          )}
        </Card>
      </div>
      <DocumentPanel entityType="grievance" entityId={g.id} title="Attachments & resolution documents" canUpload={staff && g.status !== 'Closed'} categories={DOC_CATS} />
      <Card title="History"><Timeline items={g.history.map((h) => ({ ...h, status: h.action }))} /></Card>
      <GrievanceGuidance guidance={g.guidance} compact />
    </>
  );
}

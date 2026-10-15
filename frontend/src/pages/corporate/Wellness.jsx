// Corporate wellness (/corporate/wellness): separately contracted programmes, aggregate participation only.
import { useState } from 'react';
import { api } from '../../api.js';
import { date, money, toPaise } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, useAction, useLoad } from '../../components/ui.jsx';
import { EmployerPicker, Priv, useCorpRole, useEmployerScope, useMeta } from './shared.jsx';

export default function Wellness() {
  const scope = useEmployerScope({ allowAll: true });
  const role = useCorpRole();
  const meta = useMeta();
  const res = useLoad(() => api.get(`/corporate/wellness${scope.qs()}`), [scope.employerId]);
  const [create, setCreate] = useState(false);
  const act = useAction();
  const run = (fn, msg) => act.run(async () => { const r = await fn(); res.reload(); return r; }, msg);
  return (
    <>
      <PageHeader title="Wellness programmes" subtitle="Screening, check-up camps, telehealth, EAP, health education and vaccination drives — contracted separately from insurance." actions={role.manage && <button className="btn" onClick={() => setCreate(true)}>New programme</button>} />
      <div className="corp-toolbar"><span /><EmployerPicker scope={scope} allowAll /></div>
      <Alert kind="info">Employees opt in themselves with explicit consent. Employers only see total participation, and only when at least {meta.data?.minCohort || 5} people take part. Wellness services are not insurance and do not change cover or premiums.</Alert>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : res.data.length === 0 ? <Empty>No wellness programmes yet. Ask your VHC account manager to add wellness to your contract.</Empty> : (
        <div className="grid grid-2 corp-grid">
          {res.data.map((p) => (
            <Card key={p.id} title={p.name} actions={<Badge>{p.status}</Badge>}>
              <p className="muted" style={{ marginTop: 0 }}>{p.typeLabel}{!scope.corp && ` · ${p.employerName}`}</p>
              {p.description && <p>{p.description}</p>}
              <dl className="kv">
                <dt>When</dt><dd>{date(p.startDate)} – {date(p.endDate)}</dd>
                <dt>Where</dt><dd>{p.location}</dd>
                <dt>Provider</dt><dd>{p.provider}</dd>
                {p.capacity && <><dt>Capacity</dt><dd>{p.capacity}</dd></>}
                {p.feePerParticipant > 0 && <><dt>Fee per participant</dt><dd>{money(p.feePerParticipant)} (billed to the employer)</dd></>}
                <dt>Participation</dt><dd><Priv cell={p.participation} format={(v) => `${v} opted in`} /></dd>
              </dl>
              <div className="corp-actions" style={{ marginTop: '.75rem' }}>
                {role.rosterWrite && !role.readOnly && ['Open', 'Scheduled'].includes(p.status) && <button className="btn sm secondary" disabled={act.busy} onClick={() => run(() => api.post(`/corporate/wellness/${p.id}/announce`), (r) => `Announced to ${r.sent} employee(s) with a VHC account`)}>Announce to employees</button>}
                {role.manage && p.status !== 'Completed' && <button className="btn sm ghost" disabled={act.busy} onClick={() => run(() => api.post(`/corporate/wellness/${p.id}/status`, { status: 'Completed' }), 'Marked completed')}>Mark completed</button>}
                {role.manage && p.status !== 'Cancelled' && p.status !== 'Completed' && <button className="btn sm ghost" disabled={act.busy} onClick={() => window.confirm('Cancel this programme?') && run(() => api.post(`/corporate/wellness/${p.id}/status`, { status: 'Cancelled' }), 'Cancelled')}>Cancel</button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {create && <CreateProgramme employerId={scope.employerId} onClose={() => setCreate(false)} onDone={() => { setCreate(false); res.reload(); }} />}
    </>
  );
}

function CreateProgramme({ employerId, onClose, onDone }) {
  const meta = useMeta();
  const [f, setF] = useState({ employerId: employerId || 'emp_demo', type: 'health_screening', name: '', description: '', provider: '', location: '', startDate: '', endDate: '', capacity: '', fee: '' });
  const act = useAction();
  const fe = act.error?.fields || {};
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open title="New wellness programme" onClose={onClose} large>
      <ErrorBox error={act.error} />
      <div className="form-grid">
        <Field label="Employer"><select value={f.employerId} onChange={set('employerId')}>{(meta.data?.employers || []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Type" error={fe.type}><select value={f.type} onChange={set('type')}>{Object.entries(meta.data?.wellnessTypes || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Name"><input value={f.name} onChange={set('name')} placeholder="Defaults to the type" /></Field>
        <Field label="Provider" hint="Synthetic partners only in this environment"><input value={f.provider} onChange={set('provider')} placeholder="Sandbox Wellness Partner (Synthetic)" /></Field>
        <Field label="Location"><input value={f.location} onChange={set('location')} /></Field>
        <Field label="Starts" error={fe.startDate}><input type="date" value={f.startDate} onChange={set('startDate')} /></Field>
        <Field label="Ends" error={fe.endDate}><input type="date" value={f.endDate} onChange={set('endDate')} /></Field>
        <Field label="Capacity (optional)" error={fe.capacity}><input type="number" min="1" value={f.capacity} onChange={set('capacity')} /></Field>
        <Field label="Fee per participant (₹, optional)" error={fe.feePerParticipant}><input inputMode="decimal" value={f.fee} onChange={set('fee')} /></Field>
        <Field label="Description" className="full"><textarea value={f.description} onChange={set('description')} /></Field>
      </div>
      <div className="row end" style={{ marginTop: '.75rem' }}>
        <button className="btn" disabled={act.busy} onClick={() => act.run(async () => {
          const fee = f.fee ? toPaise(f.fee) : 0;
          await api.post('/corporate/wellness', { ...f, feePerParticipant: fee ?? -1, capacity: f.capacity || null });
          onDone();
        })}>Create programme</button>
      </div>
    </Modal>
  );
}

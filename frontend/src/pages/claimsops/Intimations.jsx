// Claim intimation: customers inform the insurer before documents are ready (/claims/intimate,
// /claims/intimations/:id); claims officers follow up from the intimation queue (/ops/intimations).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, idempotencyKey } from '../../api.js';
import { date, dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, PageHeader, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import './claimsops.css';

export function IntimateClaim() {
  const nav = useNavigate();
  const data = useLoad(async () => {
    const [policies, hospitals] = await Promise.all([api.get('/policies'), api.get('/hospitals')]);
    return { policies: policies.filter((p) => p.product === 'health'), hospitals: hospitals.hospitals };
  });
  const [key] = useState(idempotencyKey);
  const [f, setF] = useState({ policyId: '', memberId: '', hospitalId: '', hospitalName: '', expectedAdmissionDate: '', admissionType: 'planned', natureOfIllness: '', preferredType: '' });
  const act = useAction();
  const policy = useMemo(() => data.data?.policies.find((p) => p.id === f.policyId), [data.data, f.policyId]);
  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;
  const hospital = data.data.hospitals.find((h) => h.id === f.hospitalId);
  const set = (p) => setF({ ...f, ...p });
  const submit = () => act.run(async () => {
    const i = await api.post('/claims-ops/intimations', { ...f, hospitalId: f.hospitalId || undefined, preferredType: f.preferredType || undefined, idempotencyKey: key });
    nav(`/claims/intimations/${i.id}`);
  });
  return (
    <>
      <PageHeader title="Intimate a claim" subtitle="Inform the insurer about a planned or emergency hospitalisation now — bills and documents can follow later." />
      <Card>
        <div className="form-grid">
          <Field label="Policy">
            <select value={f.policyId} onChange={(e) => set({ policyId: e.target.value, memberId: '' })}>
              <option value="">— select —</option>
              {data.data.policies.map((p) => <option key={p.id} value={p.id}>{p.policyNumber} · {p.planName}</option>)}
            </select>
          </Field>
          <Field label="Patient (insured member)">
            <select value={f.memberId} disabled={!policy} onChange={(e) => set({ memberId: e.target.value })}>
              <option value="">— select —</option>
              {policy?.members.map((m) => <option key={m.id} value={m.id}>{m.fullName} ({m.relationship})</option>)}
            </select>
          </Field>
          <Field label="Hospital">
            <select value={f.hospitalId} onChange={(e) => set({ hospitalId: e.target.value })}>
              <option value="">— other (type below) —</option>
              {data.data.hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}, {h.city}{h.network ? ' (network)' : ''}</option>)}
            </select>
          </Field>
          {!f.hospitalId && <Field label="Hospital name"><input value={f.hospitalName} onChange={(e) => set({ hospitalName: e.target.value })} /></Field>}
          <Field label="Expected admission date"><input type="date" value={f.expectedAdmissionDate} onChange={(e) => set({ expectedAdmissionDate: e.target.value })} /></Field>
          <Field label="Admission type">
            <select value={f.admissionType} onChange={(e) => set({ admissionType: e.target.value })}><option value="planned">Planned</option><option value="emergency">Emergency</option></select>
          </Field>
          <Field label="Preferred claim route">
            <select value={f.preferredType} onChange={(e) => set({ preferredType: e.target.value })}>
              <option value="">Decide for me</option><option value="cashless" disabled={hospital && !hospital.network}>Cashless</option><option value="reimbursement">Reimbursement</option>
            </select>
          </Field>
          <Field label="Nature of illness or injury" hint="In your own words — e.g. “planned knee surgery”, “high fever”." className="full"><textarea maxLength={500} value={f.natureOfIllness} onChange={(e) => set({ natureOfIllness: e.target.value })} /></Field>
        </div>
        {hospital && !hospital.network && <Alert kind="info">Non-network hospital: the claim will be a reimbursement claim after treatment.</Alert>}
        <ErrorBox error={act.error} />
        <div className="row" style={{ marginTop: '.8rem' }}>
          <button className="btn" disabled={act.busy} onClick={submit}>{act.busy ? 'Sending…' : 'Send intimation'}</button>
          <small className="muted">VHC passes the intimation to the insurer (sandbox). It is not a claim decision.</small>
        </div>
      </Card>
    </>
  );
}

export function IntimationDetail() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/claims-ops/intimations/${id}`), [id]);
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const i = res.data;
  return (
    <>
      <PageHeader title={`Intimation ${i.intimationNumber}`} subtitle={`${i.memberName} · ${i.hospitalName}`} actions={<Badge>{i.status}</Badge>} />
      <ErrorBox error={act.error} />
      {i.status === 'Intimated' && (
        <Alert kind="info">
          {i.preferredType === 'cashless'
            ? 'At admission the hospital insurance desk raises the cashless pre-authorisation. You can also start it here.'
            : 'After treatment, file the reimbursement claim with your bills and documents.'}
          <div className="row" style={{ marginTop: '.5rem' }}>
            <Link className="btn sm" to={`/claims/new?intimation=${i.id}&type=${i.preferredType}`}>File the claim now</Link>
            <button className="btn sm secondary" disabled={act.busy} onClick={() => window.confirm('Cancel this intimation?') && act.run(async () => res.setData(await api.post(`/claims-ops/intimations/${i.id}/cancel`, {})))}>Cancel intimation</button>
          </div>
        </Alert>
      )}
      {i.claim && <Alert kind="ok">Converted to claim <Link to={`/claims/${i.claim.id}`}>{i.claim.claimNumber}</Link> — {i.claim.unifiedStatus}.</Alert>}
      <div className="grid grid-2">
        <Card title="Details">
          <KV items={[
            ['Policy', i.policyNumber], ['Patient', i.memberName], ['Hospital', `${i.hospitalName}${i.networkHospital ? ' (network)' : ''}`],
            ['Expected admission', date(i.expectedAdmissionDate)], ['Admission type', titleCase(i.admissionType)], ['Claim route', titleCase(i.preferredType)],
            ['Nature of illness', i.natureOfIllness], ['Insurer', i.insurerName], i.tpaName && ['TPA', i.tpaName], ['Insurer intimation ref', i.insurerIntimationRef],
          ]} />
        </Card>
        <Card title="History"><Timeline items={i.history.map((h) => ({ ...h, status: h.action }))} /></Card>
      </div>
    </>
  );
}

export function IntimationQueue() {
  const [status, setStatus] = useState('Intimated');
  const list = useLoad(() => api.get(`/claims-ops/intimations${status ? `?status=${status}` : ''}`), [status]);
  const [sel, setSel] = useState(null);
  const [note, setNote] = useState('');
  const act = useAction();
  const addNote = () => act.run(async () => { setSel(await api.post(`/claims-ops/intimations/${sel.id}/notes`, { note })); setNote(''); list.reload(); }, 'Follow-up noted');
  return (
    <>
      <PageHeader title="Claim intimations" subtitle="Customers' advance notice of hospitalisation, before a claim is filed." />
      <Card>
        <Tabs value={status} onChange={(v) => { setStatus(v); setSel(null); }} tabs={[{ value: 'Intimated', label: 'Awaiting claim' }, { value: 'Converted', label: 'Converted' }, { value: 'Cancelled', label: 'Cancelled' }, { value: '', label: 'All' }]} />
        {list.loading ? <Loading /> : <ErrorBox error={list.error} />}
        {list.data && (
          <Table rows={list.data} empty="No intimations." onRowClick={setSel} columns={[
            { key: 'intimationNumber', label: 'Intimation' }, { key: 'customerName', label: 'Customer' }, { key: 'memberName', label: 'Patient' },
            { key: 'hospitalName', label: 'Hospital' }, { key: 'expectedAdmissionDate', label: 'Expected', render: (i) => date(i.expectedAdmissionDate) },
            { key: 'admissionType', label: 'Type', render: (i) => <Badge kind={i.admissionType === 'emergency' ? 'warn' : ''}>{titleCase(i.admissionType)}</Badge> },
            { key: 'preferredType', label: 'Route', render: (i) => titleCase(i.preferredType) },
            { key: 'status', label: 'Status', render: (i) => <>{<Badge>{i.status}</Badge>} {i.claim && <Link to={`/ops/health-claims/${i.claim.id}`} onClick={(e) => e.stopPropagation()}>{i.claim.claimNumber}</Link>}</> },
            { key: 'createdAt', label: 'Received', render: (i) => dateTime(i.createdAt) },
          ]} />
        )}
      </Card>
      {sel && (
        <Card title={`${sel.intimationNumber} · ${sel.customerName}`} actions={<button className="btn ghost sm" onClick={() => setSel(null)}>Close</button>}>
          {act.message && <Alert kind="ok">{act.message}</Alert>}
          <ErrorBox error={act.error} />
          <div className="grid grid-2">
            <KV items={[['Patient', sel.memberName], ['Policy', sel.policyNumber], ['Hospital', sel.hospitalName], ['Nature of illness', sel.natureOfIllness], ['Insurer ref', sel.insurerIntimationRef], ['TPA', sel.tpaName || '—']]} />
            <div>
              <h4>Follow-up notes</h4>
              {(sel.notes || []).length ? <ul>{sel.notes.map((n, k) => <li key={k}><small className="muted">{dateTime(n.at)} · {n.by}</small> {n.note}</li>)}</ul> : <p className="muted">None yet.</p>}
              <Field label="Add a note (e.g. hospital desk contacted)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <button className="btn sm" style={{ marginTop: '.4rem' }} disabled={act.busy || !note.trim()} onClick={addNote}>Save note</button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

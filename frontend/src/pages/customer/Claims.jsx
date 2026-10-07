import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, idempotencyKey } from '../../api.js';
import { date, money, titleCase, toPaise } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, PageHeader, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';
import { BucketFilterNote } from './CustomerPages.jsx';

export function ClaimsList() {
  const [params] = useSearchParams();
  const bucket = params.get('bucket') || '';
  const res = useLoad(() => api.get(`/health-claims${bucket ? `?bucket=${bucket}` : ''}`), [bucket]);
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Health claims" actions={<Link className="btn" to="/claims/new">New claim</Link>} />
      <BucketFilterNote bucket={bucket} path="/claims" />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No claims yet." onRowClick={(c) => nav(`/claims/${c.id}`)} columns={[
            { key: 'claimNumber', label: 'Claim' }, { key: 'type', label: 'Type', render: (c) => titleCase(c.type) },
            { key: 'memberName', label: 'Patient' }, { key: 'hospitalName', label: 'Hospital' },
            { key: 'admissionDate', label: 'Admitted', render: (c) => date(c.admissionDate) },
            { key: 'requestedAmount', label: 'Requested', num: true, render: (c) => money(c.requestedAmount) },
            { key: 'approvedAmount', label: 'Approved', num: true, render: (c) => money(c.approvedAmount) },
            { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function NewClaim() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const data = useLoad(async () => {
    const [policies, hospitals] = await Promise.all([api.get('/policies'), api.get('/hospitals')]);
    return { policies: policies.filter((p) => p.product === 'health'), hospitals: hospitals.hospitals };
  });
  const [key] = useState(idempotencyKey); // stable across retries: no duplicate claims on network failure
  const [f, setF] = useState({ policyId: params.get('policy') || '', memberId: '', type: params.get('type') === 'cashless' ? 'cashless' : 'reimbursement', hospitalId: '', hospitalName: '', admissionDate: '', dischargeDate: '', diagnosis: '', treatment: '', requestedAmount: '', isAccident: false, payoutDetails: { accountName: '', accountNumber: '', ifsc: '' } });
  const act = useAction();
  const policy = useMemo(() => data.data?.policies.find((p) => p.id === f.policyId), [data.data, f.policyId]);
  const hospital = data.data?.hospitals.find((h) => h.id === f.hospitalId);
  if (data.loading) return <Loading />;
  const set = (patch) => setF({ ...f, ...patch });
  const dateError = f.admissionDate && f.dischargeDate && f.dischargeDate < f.admissionDate ? 'Discharge cannot be before admission' : null;
  const hospitals = data.data.hospitals.filter((h) => f.type === 'reimbursement' || h.network);

  const submit = () => act.run(async () => {
    const amount = toPaise(f.requestedAmount);
    if (!amount) throw new Error('Enter the claimed amount in rupees');
    const c = await api.post('/health-claims', { ...f, requestedAmount: amount, payoutDetails: f.type === 'reimbursement' ? f.payoutDetails : undefined, idempotencyKey: key });
    nav(`/claims/${c.id}`);
  });

  return (
    <>
      <PageHeader title="New health claim" subtitle="Cashless: pre-authorisation at a network hospital. Reimbursement: submit bills after treatment." />
      <Card>
        <div className="form-grid">
          <Field label="Policy">
            <select value={f.policyId} onChange={(e) => set({ policyId: e.target.value, memberId: '' })}>
              <option value="">— select —</option>
              {data.data.policies.map((p) => <option key={p.id} value={p.id}>{p.policyNumber} · {p.planName} ({p.status})</option>)}
            </select>
          </Field>
          <Field label="Insured member">
            <select value={f.memberId} onChange={(e) => set({ memberId: e.target.value })} disabled={!policy}>
              <option value="">— select —</option>
              {policy?.members.map((m) => <option key={m.id} value={m.id}>{m.fullName} ({m.relationship})</option>)}
            </select>
          </Field>
          <Field label="Claim type">
            <select value={f.type} onChange={(e) => set({ type: e.target.value, hospitalId: '' })}>
              <option value="reimbursement">Reimbursement (treatment completed)</option>
              <option value="cashless">Cashless pre-authorisation (network hospital)</option>
            </select>
          </Field>
          <Field label="Hospital">
            <select value={f.hospitalId} onChange={(e) => set({ hospitalId: e.target.value })}>
              <option value="">{f.type === 'reimbursement' ? '— other (type below) —' : '— select network hospital —'}</option>
              {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}, {h.city}{h.network ? ' (network)' : ''}</option>)}
            </select>
          </Field>
          {f.type === 'reimbursement' && !f.hospitalId && <Field label="Hospital name"><input value={f.hospitalName} onChange={(e) => set({ hospitalName: e.target.value })} /></Field>}
          <Field label={f.type === 'cashless' ? 'Planned admission date' : 'Admission date'}><input type="date" value={f.admissionDate} onChange={(e) => set({ admissionDate: e.target.value })} /></Field>
          <Field label={f.type === 'cashless' ? 'Expected discharge date' : 'Discharge date'} error={dateError}><input type="date" value={f.dischargeDate} onChange={(e) => set({ dischargeDate: e.target.value })} /></Field>
          <Field label={f.type === 'cashless' ? 'Estimated cost (₹)' : 'Claimed amount (₹)'}><input inputMode="decimal" value={f.requestedAmount} onChange={(e) => set({ requestedAmount: e.target.value })} /></Field>
          <Field label="Diagnosis" className="full"><input value={f.diagnosis} onChange={(e) => set({ diagnosis: e.target.value })} /></Field>
          <Field label="Treatment description" className="full"><textarea value={f.treatment} onChange={(e) => set({ treatment: e.target.value })} /></Field>
          <label className="check full"><input type="checkbox" checked={f.isAccident} onChange={(e) => set({ isAccident: e.target.checked })} /> This treatment is due to an accident</label>
        </div>
        {hospital && !hospital.network && <Alert kind="info">Non-network hospital: only reimbursement is available.</Alert>}
        {f.type === 'reimbursement' && (
          <>
            <h3 style={{ marginTop: '1rem' }}>Payout bank details</h3>
            <div className="form-grid">
              <Field label="Account holder"><input value={f.payoutDetails.accountName} onChange={(e) => set({ payoutDetails: { ...f.payoutDetails, accountName: e.target.value } })} /></Field>
              <Field label="Account number"><input value={f.payoutDetails.accountNumber} onChange={(e) => set({ payoutDetails: { ...f.payoutDetails, accountNumber: e.target.value } })} /></Field>
              <Field label="IFSC" hint="e.g. VHCB0001234"><input value={f.payoutDetails.ifsc} onChange={(e) => set({ payoutDetails: { ...f.payoutDetails, ifsc: e.target.value.toUpperCase() } })} /></Field>
            </div>
            <small className="muted">Payout details are verified by a claims officer before any payment.</small>
          </>
        )}
        <ErrorBox error={act.error} />
        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="btn" disabled={act.busy || !!dateError} onClick={submit}>{act.busy ? 'Submitting…' : 'Submit claim'}</button>
          <small className="muted">You can upload bills, prescriptions and discharge documents on the next screen.</small>
        </div>
      </Card>
    </>
  );
}

export function AssessmentTable({ a }) {
  if (!a) return null;
  return (
    <>
      {!a.eligible && <Alert kind="error">Not payable: <ul>{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></Alert>}
      <div className="table-wrap"><table className="breakdown"><tbody>
        <tr><td>Requested amount</td><td className="num">{money(a.requestedAmount)}</td></tr>
        <tr><td>Eligible amount (after limits & non-payables)</td><td className="num">{money(a.eligibleAmount)}</td></tr>
        <tr><td>Deductible</td><td className="num">− {money(a.deductible)}</td></tr>
        <tr><td>Co-payment ({a.inputs.copayBp / 100}%)</td><td className="num">− {money(a.copay)}</td></tr>
        <tr><td>Calculated settlement</td><td className="num">{money(a.calculatedAmount)}</td></tr>
        <tr><td>Available coverage{a.inputs.sharedCoverage ? ' (shared floater)' : ''}</td><td className="num">{money(a.availableCoverage)}</td></tr>
        <tr className="total"><td>Approved amount{a.cappedByCoverage ? ' (capped by remaining coverage)' : ''}</td><td className="num">{money(a.approvedAmount)}</td></tr>
        <tr><td>Total deducted from request</td><td className="num">{money(a.totalDeducted)}</td></tr>
      </tbody></table></div>
      {a.items?.some((i) => i.note) && <ul>{a.items.filter((i) => i.note).map((i, k) => <li key={k}><small>{i.description}: {i.note}</small></li>)}</ul>}
    </>
  );
}

export function ClaimDetail() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/health-claims/${id}`), [id]);
  const act = useAction();
  const [note, setNote] = useState('');
  const [finalAmount, setFinalAmount] = useState('');
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const c = res.data;
  const run = (fn) => act.run(async () => res.setData(await fn()));
  return (
    <>
      <PageHeader title={`Claim ${c.claimNumber}`} subtitle={`${titleCase(c.type)} · ${c.policy.policyNumber} · ${c.member?.fullName}`} actions={<Badge>{c.status}</Badge>} />
      <ErrorBox error={act.error} />
      {c.status === 'Documents Requested' && (
        <Card title="Documents requested">
          <ul>{c.documentRequests.filter((d) => !d.resolved).map((d, i) => <li key={i}>{d.note}</li>)}</ul>
          <Field label="Note to the claims team (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <button className="btn" style={{ marginTop: '.5rem' }} disabled={act.busy} onClick={() => run(() => api.post(`/health-claims/${c.id}/respond`, { note }))}>I have uploaded the documents</button>
        </Card>
      )}
      {c.status === 'Preauth Approved' && (
        <Card title="Pre-authorisation approved (provisional)">
          <Alert kind="info">Provisional amount {money(c.preauth.amount)}. The final amount is decided after the final bill is reviewed.</Alert>
          <div className="row">
            <input style={{ maxWidth: 200 }} placeholder="Final bill (₹)" value={finalAmount} onChange={(e) => setFinalAmount(e.target.value)} />
            <button className="btn" disabled={act.busy} onClick={() => run(() => api.post(`/health-claims/${c.id}/final-bill`, { finalAmount: toPaise(finalAmount) }))}>Submit final bill</button>
          </div>
        </Card>
      )}
      {c.status === 'Preauth Rejected' && <Alert kind="warn">Cashless request refused: {c.preauth?.reason}. You can still <Link to={`/claims/new?policy=${c.policyId}`}>file a reimbursement claim</Link> after treatment.</Alert>}
      {c.rejection && <Alert kind="error">Rejected: {c.rejection.reason}</Alert>}
      <div className="grid grid-2">
        <Card title="Claim details">
          <KV items={[
            ['Hospital', `${c.hospitalName}${c.networkHospital ? ' (network)' : ''}`], ['Admission – discharge', `${date(c.admissionDate)} – ${date(c.dischargeDate)}`],
            ['Diagnosis', c.diagnosis], ['Treatment', c.treatment], ['Requested', money(c.requestedAmount)],
            c.preauth?.amount && ['Pre-authorised (provisional)', money(c.preauth.amount)], ['Paid', money(c.paidAmount)],
          ]} />
        </Card>
        <Card title="Settlement calculation">
          {c.assessment ? <AssessmentTable a={c.assessment} /> : <div className="empty">Not yet assessed.</div>}
        </Card>
      </div>
      <DocumentPanel entityType="healthClaim" entityId={c.id} canUpload={!['Settled', 'Rejected'].includes(c.status)} categories={['bill', 'prescription', 'medical_report', 'discharge_summary', 'bank_proof', 'other']} />
      <Card title="Timeline"><Timeline items={c.timeline} /></Card>
    </>
  );
}

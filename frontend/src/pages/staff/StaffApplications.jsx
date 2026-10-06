import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, titleCase, toPaise } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, PageHeader, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import QuoteBreakdown from '../../components/QuoteBreakdown.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';

const STATUSES = ['Submitted', 'Initial Review', 'Underwriting', 'More Information Required', 'Approved', 'Offer Accepted', 'Issued', 'Rejected', 'Postponed', 'Offer Declined'];

export function ApplicationQueue() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const res = useLoad(() => api.get(`/applications${status ? `?status=${encodeURIComponent(status)}` : ''}`), [status]);
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Application queue" subtitle="Agents review completeness; underwriters decide." />
      <Card>
        <div className="row" style={{ marginBottom: '.75rem' }}>
          <button className={`btn sm ${status ? 'secondary' : ''}`} onClick={() => setParams({})}>All</button>
          {STATUSES.map((s) => <button key={s} className={`btn sm ${status === s ? '' : 'secondary'}`} onClick={() => setParams({ status: s })}>{s}</button>)}
        </div>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="Queue is empty." onRowClick={(a) => nav(`/ops/applications/${a.id}`)} columns={[
            { key: 'applicationNumber', label: 'Application' }, { key: 'customerName', label: 'Customer' },
            { key: 'planName', label: 'Plan', render: (a) => <>{a.planName} {a.renewalOf && <Badge kind="info">Renewal</Badge>}</> },
            { key: 'status', label: 'Status', render: (a) => <Badge>{a.status}</Badge> },
            { key: 'uw', label: 'Medical review', render: (a) => (a.underwritingRequired ? <Badge kind="warn">Triggers</Badge> : '—') },
            { key: 'premium', label: 'Premium', num: true, render: (a) => money(a.premium) },
            { key: 'submittedAt', label: 'Submitted', render: (a) => dateTime(a.submittedAt) },
          ]} />
        )}
      </Card>
    </>
  );
}

export function UnderwritingWorkspace() {
  const { id } = useParams();
  const { user } = useAuth();
  const res = useLoad(() => api.get(`/applications/${id}`), [id]);
  const act = useAction();
  const [note, setNote] = useState('');
  const [reqForm, setReqForm] = useState({ type: 'medical_test', description: '', scheduledAt: '', center: '' });
  const [dec, setDec] = useState({ decision: 'approve', reason: '', notes: '', loadingPct: '', revisedCoverage: '', uwClass: 'standard', revisedSumAssured: '', specialConditions: '' });
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const a = res.data;
  const isUW = ['underwriter', 'admin'].includes(user.role);
  const run = (fn, msg) => act.run(async () => { res.setData(await fn()); }, msg);
  const post = (path, body) => api.post(`/applications/${id}${path}`, body);

  const decide = () => {
    const body = { decision: dec.decision, reason: dec.reason, notes: dec.notes };
    if (dec.decision === 'revise') {
      const bp = Math.round(Number(dec.loadingPct || 0) * 100);
      if (a.product === 'health') Object.assign(body, { loadingBp: bp, revisedCoverage: dec.revisedCoverage ? Number(dec.revisedCoverage) : undefined, specialConditions: dec.specialConditions });
      else Object.assign(body, { extraLoadingBp: bp, uwClass: dec.uwClass, revisedSumAssured: dec.revisedSumAssured ? toPaise(dec.revisedSumAssured) : undefined, specialConditions: dec.specialConditions });
    }
    return run(() => post('/underwriting/decision', body), 'Decision recorded');
  };

  return (
    <>
      <PageHeader title={`${a.applicationNumber} — ${a.planName}`} subtitle={`${a.customer?.name} · ${a.customer?.email} · ${titleCase(a.product)}${a.renewalOf ? ' renewal' : ''}`} actions={<Badge>{a.status}</Badge>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />

      <div className="grid grid-2">
        <Card title="Completeness checklist">
          <ul className="checklist">{a.checklist.map((c) => <li key={c.item}>{c.ok ? '✅' : '⚠️'} {c.item}</li>)}</ul>
          <div className="row" style={{ marginTop: '.75rem' }}>
            {a.status === 'Submitted' && <button className="btn" disabled={act.busy} onClick={() => run(() => post('/review/start'))}>Start initial review</button>}
            {a.status === 'Initial Review' && <button className="btn" disabled={act.busy} onClick={() => run(() => post('/review/forward'), 'Forwarded to underwriting')}>Forward to underwriting</button>}
          </div>
          {['Submitted', 'Initial Review'].includes(a.status) && (
            <div className="stack" style={{ marginTop: '.75rem' }}>
              <Field label="Request a correction from the customer"><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Upload a clear copy of the identity document" /></Field>
              <button className="btn secondary" disabled={act.busy || !note.trim()} onClick={() => run(() => post('/review/request-correction', { note }), 'Correction requested')}>Request correction</button>
            </div>
          )}
        </Card>
        <Card title="Quote / pricing">{a.quote ? <QuoteBreakdown q={a.quote} /> : <div className="empty">No quote.</div>}</Card>
      </div>

      <Card title={a.product === 'health' ? 'Insured members & declarations' : 'Life assured & declarations'}>
        {a.product === 'health' ? (
          <Table rows={a.health.members} columns={[
            { key: 'fullName', label: 'Member', render: (m) => <>{m.fullName}<div className="muted">{m.relationship} · DOB {date(m.dob)}</div></> },
            { key: 'hw', label: 'Ht / Wt', render: (m) => `${m.heightCm || '—'} cm / ${m.weightKg || '—'} kg` },
            { key: 'cond', label: 'Conditions', render: (m) => (m.hasConditions ? <Badge kind="warn">{m.conditions}</Badge> : 'None declared') },
            { key: 'meds', label: 'Medications', render: (m) => m.medications || '—' },
            { key: 'surg', label: 'Surgeries', render: (m) => m.surgeries || '—' },
            { key: 'tob', label: 'Tobacco', render: (m) => (m.tobacco ? <Badge kind="warn">Yes</Badge> : 'No') },
          ]} />
        ) : (
          <KV items={[
            ['Life assured', `${a.life.lifeAssured.fullName} · DOB ${date(a.life.lifeAssured.dob)} · ${a.life.lifeAssured.occupation}`],
            ['Annual income', money(a.life.lifeAssured.annualIncome)], ['Sum assured', money(a.life.sumAssured)],
            ['Term / payment term / frequency', `${a.life.policyTerm} / ${a.life.premiumPaymentTerm} yrs · ${a.life.frequency}`],
            ['Tobacco', a.life.tobacco ? 'Yes' : 'No'], ['Medical history', a.life.medicalHistory.hasConditions ? a.life.medicalHistory.details : 'None declared'],
            ['Existing insurance', a.life.existingInsurance.has ? `${a.life.existingInsurance.details} (${money(a.life.existingInsurance.totalSumAssured)})` : 'None'],
            ['Nominees', a.life.nominees.map((n) => `${n.name} (${n.relationship}) ${n.sharePct}%${n.isMinor ? ` — guardian ${n.guardian?.name}` : ''}`).join('; ')],
          ]} />
        )}
      </Card>

      <Card title="Underwriting requirements">
        <Table rows={a.underwriting.requirements} empty="No requirements raised." columns={[
          { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'description', label: 'Description' },
          { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
          { key: 'sched', label: 'Schedule', render: (r) => (r.scheduledAt ? `${date(r.scheduledAt)} ${r.center || ''}` : '—') },
          { key: 'act', label: '', render: (r) => isUW && ['requested', 'scheduled'].includes(r.status) && (
            <div className="row">
              <button className="btn sm" onClick={() => run(() => post(`/underwriting/requirements/${r.id}`, { action: 'received' }))}>Mark received</button>
              <button className="btn sm secondary" onClick={() => { const n = window.prompt('Reason to waive'); if (n) run(() => post(`/underwriting/requirements/${r.id}`, { action: 'waive', note: n })); }}>Waive</button>
            </div>
          ) },
        ]} />
        {isUW && a.status === 'Underwriting' && (
          <>
            <hr />
            <div className="form-grid">
              <Field label="Requirement type">
                <select value={reqForm.type} onChange={(e) => setReqForm({ ...reqForm, type: e.target.value })}>
                  <option value="medical_test">Medical test</option><option value="exam">Medical examination</option><option value="document">Additional document</option><option value="information">Information from customer (pauses application)</option>
                </select>
              </Field>
              <Field label="Description"><input value={reqForm.description} onChange={(e) => setReqForm({ ...reqForm, description: e.target.value })} /></Field>
              {['medical_test', 'exam'].includes(reqForm.type) && (
                <>
                  <Field label="Scheduled date (optional)"><input type="date" value={reqForm.scheduledAt} onChange={(e) => setReqForm({ ...reqForm, scheduledAt: e.target.value })} /></Field>
                  <Field label="Centre (optional)"><input value={reqForm.center} onChange={(e) => setReqForm({ ...reqForm, center: e.target.value })} /></Field>
                </>
              )}
            </div>
            <button className="btn secondary" style={{ marginTop: '.6rem' }} disabled={act.busy || !reqForm.description.trim()} onClick={() => run(() => post('/underwriting/requirements', { ...reqForm, scheduledAt: reqForm.scheduledAt || undefined }), 'Requirement added')}>Add requirement</button>
          </>
        )}
      </Card>

      {isUW && a.status === 'Underwriting' && (
        <Card title="Underwriting decision">
          <div className="form-grid">
            <Field label="Decision">
              <select value={dec.decision} onChange={(e) => setDec({ ...dec, decision: e.target.value })}>
                <option value="approve">Approve at standard terms</option><option value="revise">Propose revised terms</option><option value="reject">Reject</option>
                {a.product === 'life' && <option value="postpone">Postpone</option>}
              </select>
            </Field>
            {dec.decision === 'revise' && (a.product === 'health' ? (
              <>
                <Field label="Premium loading (%)"><input type="number" step="0.01" value={dec.loadingPct} onChange={(e) => setDec({ ...dec, loadingPct: e.target.value })} /></Field>
                <Field label="Revised coverage (optional)">
                  <select value={dec.revisedCoverage} onChange={(e) => setDec({ ...dec, revisedCoverage: e.target.value })}>
                    <option value="">No change ({money(a.health.coverage)})</option>
                    {(a.quote?.planCoverageOptions || [50000000, 100000000]).map((v) => <option key={v} value={v}>{money(v)}</option>)}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Underwriting class"><select value={dec.uwClass} onChange={(e) => setDec({ ...dec, uwClass: e.target.value })}><option value="standard">Standard</option><option value="substandard">Substandard</option><option value="preferred">Preferred (not configured — will be refused)</option></select></Field>
                <Field label="Extra loading (%)"><input type="number" step="0.01" value={dec.loadingPct} onChange={(e) => setDec({ ...dec, loadingPct: e.target.value })} /></Field>
                <Field label="Revised sum assured (₹, optional)"><input value={dec.revisedSumAssured} onChange={(e) => setDec({ ...dec, revisedSumAssured: e.target.value })} /></Field>
              </>
            ))}
            {dec.decision === 'revise' && <Field label="Special conditions / exclusions (optional)" className="full"><input value={dec.specialConditions} onChange={(e) => setDec({ ...dec, specialConditions: e.target.value })} /></Field>}
            {dec.decision !== 'approve' && <Field label="Reason (required, shown to customer)" className="full"><textarea value={dec.reason} onChange={(e) => setDec({ ...dec, reason: e.target.value })} /></Field>}
            <Field label="Internal notes" className="full"><textarea value={dec.notes} onChange={(e) => setDec({ ...dec, notes: e.target.value })} /></Field>
          </div>
          <button className={`btn ${dec.decision === 'reject' ? 'danger' : ''}`} style={{ marginTop: '.75rem' }} disabled={act.busy} onClick={decide}>Record decision</button>
        </Card>
      )}
      {!isUW && a.status === 'Underwriting' && <Alert kind="info">This application is with underwriting. Agents cannot make underwriting decisions.</Alert>}

      {a.offer && (
        <Card title={a.offer.revised ? 'Revised offer' : 'Offer'}>
          <KV items={[['Annual premium', `${money(a.offer.original?.annualPremium)} → ${money(a.offer.annualPremium)}`], ['Cover', money(a.offer.coverage ?? a.offer.sumAssured)], ['Reason', a.offer.reason], ['Accepted', a.offer.acceptedAt ? dateTime(a.offer.acceptedAt) : 'Not yet']]} />
        </Card>
      )}

      <DocumentPanel entityType="application" entityId={a.id} title="Documents & medical reports" categories={['medical_report', 'exam_report', 'identity', 'income', 'other']} />

      <div className="grid grid-2">
        <Card title="Notes">
          {[...(a.review.notes || []), ...(a.underwriting.notes || [])].sort((x, y) => x.at.localeCompare(y.at)).map((n, i) => <div key={i} style={{ marginBottom: '.5rem' }}><small className="muted">{dateTime(n.at)} · {n.by} ({n.role})</small><div>{n.note}</div></div>)}
          {a.underwriting.decisions.map((d, i) => <div key={`d${i}`}><small className="muted">{dateTime(d.at)} · {d.by}</small><div><Badge>{d.decision}</Badge> {d.reason} {d.notes && `— ${d.notes}`}</div></div>)}
          <NoteBox onSave={(n) => run(() => post('/notes', { note: n }))} />
        </Card>
        <Card title="Timeline"><Timeline items={a.timeline} /></Card>
      </div>
    </>
  );
}

export function NoteBox({ onSave }) {
  const [n, setN] = useState('');
  return (
    <div className="row" style={{ marginTop: '.5rem' }}>
      <input value={n} onChange={(e) => setN(e.target.value)} placeholder="Add an internal note" style={{ flex: 1 }} />
      <button className="btn sm secondary" disabled={!n.trim()} onClick={() => { onSave(n); setN(''); }}>Add</button>
    </div>
  );
}

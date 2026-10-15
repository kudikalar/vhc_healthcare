// TPA portal (/tpa) for tpa_admin / tpa_agent: claims on policies of insurers the TPA administers,
// notes, document recommendations and a TPA recommendation — never a final decision.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, toPaise, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { list } from './common.jsx';

function ClaimModal({ base, claimId, onClose, onChanged }) {
  const res = useLoad(() => api.get(`${base}/claims/${claimId}`), [claimId]);
  const act = useAction();
  const [note, setNote] = useState('');
  const [docs, setDocs] = useState('');
  const [rec, setRec] = useState({ recommendation: 'recommend_approve', amount: '', reason: '' });
  const run = (path, body, msg, reset) => act.run(async () => { const r = await api.post(`${base}/claims/${claimId}/${path}`, body); res.setData(r); reset?.(); onChanged?.(); }, msg);
  if (res.loading) return <Modal open title="Claim" onClose={onClose}><Loading /></Modal>;
  if (res.error) return <Modal open title="Claim" onClose={onClose}><ErrorBox error={res.error} /></Modal>;
  const c = res.data;
  const needsAmount = ['recommend_approve', 'recommend_partial'].includes(rec.recommendation);
  return (
    <Modal open large title={`${c.claimNumber} · ${titleCase(c.type)}`} onClose={onClose}>
      <Alert kind="info">{c.recommendationNote}</Alert>
      <div className="nw-split">
        <div>
          <KV items={[
            ['Status', <Badge key="s">{c.status}</Badge>], ['Insurer', c.insurerName], ['Policy', `${c.policyNumber} · ${c.planName}`], ['Member', c.memberName],
            ['Hospital', `${c.hospitalName}${c.networkHospital ? ' (network)' : ''}`], ['Admission', `${date(c.admissionDate)} – ${date(c.dischargeDate)}`],
            ['Diagnosis', c.diagnosis], ['Treatment', c.treatment], ['Requested', money(c.requestedAmount)],
            ['Pre-auth', c.preauth ? `${titleCase(c.preauth.status)}${c.preauth.amount != null ? ` · ${money(c.preauth.amount)}` : ''} (${dateTime(c.preauth.at)})` : '—'],
            ['Final bill', c.finalBill ? money(c.finalBill.amount) : '—'], ['Approved', c.approvedAmount != null ? money(c.approvedAmount) : '—'],
            ['Documents', c.documents.length ? c.documents.map((d) => d.category).join(', ') : 'None uploaded'],
          ]} />
          <h4>Claim timeline</h4>
          <Timeline items={c.timeline} />
        </div>
        <div className="stack">
          <ErrorBox error={act.error} /><Alert kind="ok">{act.message}</Alert>
          <Card title="TPA recommendation">
            <Field label="Recommendation">
              <select value={rec.recommendation} onChange={(e) => setRec({ ...rec, recommendation: e.target.value })}>
                <option value="recommend_approve">Recommend approval</option><option value="recommend_partial">Recommend partial approval</option>
                <option value="recommend_reject">Recommend rejection</option><option value="query">Query — more information needed</option>
              </select>
            </Field>
            {needsAmount && <Field label="Recommended amount (₹)"><input inputMode="decimal" value={rec.amount} onChange={(e) => setRec({ ...rec, amount: e.target.value })} /></Field>}
            <Field label="Reasoning"><textarea value={rec.reason} onChange={(e) => setRec({ ...rec, reason: e.target.value })} /></Field>
            <button className="btn" disabled={act.busy || !rec.reason.trim() || (needsAmount && toPaise(rec.amount) == null)}
              onClick={() => run('recommendation', { recommendation: rec.recommendation, reason: rec.reason, amount: needsAmount ? toPaise(rec.amount) : undefined }, 'Recommendation recorded (not a decision)', () => setRec({ ...rec, reason: '' }))}>Record recommendation</button>
          </Card>
          <Card title="Recommend documents">
            <Field label="Documents" hint="Comma-separated, forwarded to the claims officer"><input value={docs} onChange={(e) => setDocs(e.target.value)} /></Field>
            <button className="btn secondary" disabled={act.busy || !docs.trim()} onClick={() => run('document-requests', { documents: list(docs) }, 'Document recommendation recorded', () => setDocs(''))}>Recommend</button>
          </Card>
          <Card title="TPA notes">
            <Field label="Note"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <button className="btn secondary" disabled={act.busy || !note.trim()} onClick={() => run('notes', { note }, 'Note added', () => setNote(''))}>Add note</button>
          </Card>
          <Card title="TPA history">
            <Table rows={[
              ...c.review.recommendations.map((x, i) => ({ id: `r${i}`, at: x.at, by: x.by, what: `${x.label}${x.amount != null ? ` · ${money(x.amount)}` : ''}: ${x.reason}` })),
              ...c.review.documentRecommendations.map((x, i) => ({ id: `d${i}`, at: x.at, by: x.by, what: `Documents: ${x.documents.join(', ')}` })),
              ...c.review.notes.map((x, i) => ({ id: `n${i}`, at: x.at, by: x.by, what: x.note })),
            ].sort((a, b) => b.at.localeCompare(a.at))} empty="Nothing recorded yet." columns={[{ key: 'at', label: 'When', render: (x) => dateTime(x.at) }, { key: 'by', label: 'By' }, { key: 'what', label: 'Entry' }]} />
          </Card>
        </div>
      </div>
    </Modal>
  );
}

export function TpaPortal() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'claims';
  const base = `/network/tpa-portal/${user.orgId}`;
  const home = useLoad(() => api.get(base), [base]);
  const [status, setStatus] = useState('');
  const claims = useLoad(() => api.get(`${base}/claims${status ? `?status=${encodeURIComponent(status)}` : ''}`), [status]);
  const [open, setOpen] = useState(null);
  const act = useAction();
  const [esc, setEsc] = useState({ subject: '', claimNumber: '', level: 1 });
  if (home.loading) return <Loading />;
  if (home.error) return <ErrorBox error={home.error} />;
  const { tpa, report } = home.data;
  return (
    <>
      <PageHeader title={tpa.name} subtitle={`TPA portal · administers ${tpa.administeredInsurers.map((i) => i.name).join(', ') || 'no insurers'}`} />
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <Stat label="Claims administered" value={report.totalClaims} />
        <Stat label="Open claims" value={report.open} />
        <Stat label="Avg pre-auth decision" value={report.preauthDecisionHoursAvg == null ? '—' : `${report.preauthDecisionHoursAvg} h`} />
        <Stat label="Avg claim closure" value={report.closureDaysAvg == null ? '—' : `${report.closureDaysAvg} d`} />
      </div>
      <Tabs tabs={[{ value: 'claims', label: 'Claims' }, { value: 'report', label: 'Turnaround report' }, { value: 'org', label: 'Relationships & escalations' }]} value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'claims' && (
        <Card title="Health claims" actions={
          <label className="field" style={{ margin: 0 }}><span className="sr-only">Filter by status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {['Submitted', 'Under Review', 'Documents Requested', 'Preauth Requested', 'Preauth Approved', 'Final Bill Submitted', 'Approved', 'Settled', 'Rejected', 'Preauth Rejected'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>}>
          {claims.loading ? <Loading /> : claims.error ? <ErrorBox error={claims.error} /> : (
            <>
              <p className="nw-note">{claims.data.note}</p>
              <Table rows={claims.data.claims} onRowClick={(c) => setOpen(c.id)} empty="No claims for the insurers you administer." columns={[
                { key: 'claimNumber', label: 'Claim', render: (c) => <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setOpen(c.id); }}>{c.claimNumber}</button> },
                { key: 'type', label: 'Type', render: (c) => titleCase(c.type) },
                { key: 'memberName', label: 'Member' }, { key: 'hospitalName', label: 'Hospital' }, { key: 'insurerName', label: 'Insurer' },
                { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
                { key: 'requestedAmount', label: 'Requested', num: true, render: (c) => money(c.requestedAmount) },
                { key: 'rec', label: 'TPA recommendation', render: (c) => c.latestRecommendation?.label || '—' },
              ]} />
            </>
          )}
        </Card>
      )}
      {tab === 'report' && (
        <Card title="Claims turnaround">
          <KV items={[
            ['As of', dateTime(report.asOf)], ['Claims', report.totalClaims], ['Open', report.open],
            ['Pre-auth decisions', `${report.preauthDecisions} (avg ${report.preauthDecisionHoursAvg ?? '—'} h)`],
            ['Closed (settled/rejected)', `${report.closedClaims} (avg ${report.closureDaysAvg ?? '—'} days)`],
            ['TPA recommendations', `${report.recommended} (avg ${report.recommendationHoursAvg ?? '—'} h from intimation)`],
          ]} />
          <Table rows={Object.entries(report.byStatus).map(([k, v]) => ({ id: k, k, v }))} columns={[{ key: 'k', label: 'Status', render: (r) => <Badge>{r.k}</Badge> }, { key: 'v', label: 'Claims', num: true }]} />
        </Card>
      )}
      {tab === 'org' && (
        <div className="grid grid-2">
          <Card title="Insurer relationships">
            <Table rows={tpa.relationships || []} empty="No relationships recorded." columns={[{ key: 'insurerName', label: 'Insurer' }, { key: 'from', label: 'From', render: (r) => date(r.from) }, { key: 'to', label: 'To', render: (r) => (r.to ? date(r.to) : 'Open') }, { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> }, { key: 'scope', label: 'Scope' }]} />
            <h4>Servicing contacts</h4>
            <Table rows={tpa.servicingContacts || []} rowKey="email" empty="None." columns={[{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }]} />
          </Card>
          <Card title="Escalations">
            <Table rows={tpa.escalations || []} empty="No escalations." columns={[{ key: 'at', label: 'Raised', render: (e) => date(e.at) }, { key: 'level', label: 'Level' }, { key: 'subject', label: 'Subject' }, { key: 'status', label: 'Status', render: (e) => <Badge>{e.status}</Badge> }, { key: 'resolution', label: 'Resolution' }]} />
            <form className="stack" style={{ marginTop: '1rem' }} onSubmit={(e) => { e.preventDefault(); act.run(() => api.post(`${base}/escalations`, esc), 'Escalation raised').then(() => { setEsc({ subject: '', claimNumber: '', level: 1 }); home.reload(); }); }}>
              <Field label="Subject"><input required value={esc.subject} onChange={(e) => setEsc({ ...esc, subject: e.target.value })} /></Field>
              <div className="form-grid">
                <Field label="Claim number (optional)"><input value={esc.claimNumber} onChange={(e) => setEsc({ ...esc, claimNumber: e.target.value })} /></Field>
                <Field label="Level"><select value={esc.level} onChange={(e) => setEsc({ ...esc, level: Number(e.target.value) })}><option value={1}>1</option><option value={2}>2</option></select></Field>
              </div>
              <ErrorBox error={act.error} /><Alert kind="ok">{act.message}</Alert>
              <button className="btn" disabled={act.busy}>Raise escalation with VHC</button>
            </form>
          </Card>
        </div>
      )}
      {open && <ClaimModal base={base} claimId={open} onClose={() => setOpen(null)} onChanged={() => claims.reload()} />}
    </>
  );
}

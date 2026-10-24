// Fraud & anomaly review queue (/ops/fraud-review): explainable rule flags for human review.
// A flag never denies or blocks a claim; reviewers clear it or escalate it to the insurer's SIU.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { dateTime } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, Loading, PageHeader, Stat, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { Evidence } from './components.jsx';

const SEV = { high: 'error', medium: 'warn', low: 'info' };

function Review({ flag, onDone }) {
  const [note, setNote] = useState('');
  const act = useAction();
  const go = (action) => act.run(async () => onDone(await api.post(`/claims-ops/fraud-flags/${flag.id}/review`, { action, note })));
  const final = ['Cleared', 'Escalated to insurer SIU'].includes(flag.status);
  return (
    <Card title={`${flag.ruleId} · ${flag.ruleName}`} actions={<Badge kind={SEV[flag.severity]}>{flag.severity}</Badge>}>
      <p>{flag.explanation}</p>
      <Evidence evidence={flag.evidence} />
      <p className="muted" style={{ fontSize: '.85rem' }}>Claim <Link to={`/ops/health-claims/${flag.claimId}`}>{flag.claimNumber}</Link> ({flag.claimStatus}) · policy {flag.policyNumber} · raised {dateTime(flag.createdAt)} on {flag.trigger?.replace('_', ' ')}</p>
      <ErrorBox error={act.error} />
      {!final ? (
        <>
          <Field label="Review note (required to clear or escalate)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked and why you decided this" /></Field>
          <div className="row" style={{ marginTop: '.5rem' }}>
            {flag.status === 'Open' && <button className="btn secondary sm" disabled={act.busy} onClick={() => go('start_review')}>Start review</button>}
            <button className="btn sm" disabled={act.busy || !note.trim()} onClick={() => go('clear')}>Clear flag</button>
            <button className="btn danger sm" disabled={act.busy || !note.trim()} onClick={() => go('escalate')}>Escalate to insurer SIU</button>
          </div>
        </>
      ) : <Alert kind={flag.status === 'Cleared' ? 'ok' : 'warn'}>{flag.status} by {flag.decision?.by}: {flag.decision?.note}</Alert>}
      <details style={{ marginTop: '.6rem' }}><summary>History</summary><Timeline items={flag.history.map((h) => ({ ...h, status: h.action }))} /></details>
    </Card>
  );
}

export function FraudReview() {
  const [params] = useSearchParams();
  const claimId = params.get('claimId') || '';
  const [status, setStatus] = useState(claimId ? '' : 'Open');
  const qs = new URLSearchParams(Object.entries({ status, claimId }).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/claims-ops/fraud-flags${qs ? `?${qs}` : ''}`), [qs]);
  const [sel, setSel] = useState(null);
  const d = res.data;
  const selected = sel && d?.flags.find((f) => f.id === sel);
  return (
    <>
      <PageHeader title="Fraud & anomaly review" subtitle={claimId ? 'Flags for one claim' : 'Rule-based signals queued for human review'} actions={claimId && <Link className="btn secondary sm" to="/ops/fraud-review">All flags</Link>} />
      {d && <Alert kind="warn">{d.disclaimer} Escalations go to the insurer’s Special Investigation Unit; the insurer decides.</Alert>}
      <ErrorBox error={res.error} />
      {d && (
        <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
          {Object.entries(d.counts).map(([k, v]) => <Stat key={k} label={k} value={v} />)}
        </div>
      )}
      <div className="grid grid-2">
        <Card title="Queue">
          <Tabs value={status} onChange={(v) => { setStatus(v); setSel(null); }} tabs={[{ value: 'Open', label: 'Open' }, { value: 'In Review', label: 'In review' }, { value: 'Escalated to insurer SIU', label: 'Escalated' }, { value: 'Cleared', label: 'Cleared' }, { value: '', label: 'All' }]} />
          {res.loading && !d ? <Loading /> : d && (
            <Table rows={d.flags} empty="Nothing in this queue." onRowClick={(f) => setSel(f.id)} columns={[
              { key: 'claimNumber', label: 'Claim' },
              { key: 'rule', label: 'Rule', render: (f) => <>{f.ruleId} {f.ruleName}</> },
              { key: 'severity', label: 'Severity', render: (f) => <Badge kind={SEV[f.severity]}>{f.severity}</Badge> },
              { key: 'status', label: 'Status', render: (f) => <Badge>{f.status}</Badge> },
            ]} />
          )}
        </Card>
        <div>
          {selected ? <Review key={selected.id} flag={selected} onDone={() => res.reload()} /> : (
            <Card title="Rules">
              {d && <ul>{Object.entries(d.rules).map(([id, r]) => <li key={id}><strong>{id}</strong> {r.name} <Badge kind={SEV[r.severity]}>{r.severity}</Badge></li>)}</ul>}
              <p className="muted">Select a flag to see its evidence and record a review decision.</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

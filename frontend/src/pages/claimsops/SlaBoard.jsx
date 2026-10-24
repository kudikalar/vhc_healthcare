// Regulatory TAT board (/ops/claims-sla): live SLA clocks for every claim, at-risk/breached counts,
// turnaround statistics and the versioned SLA policy (admins publish new versions; oversight read-only).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, Loading, Modal, PageHeader, Stat, Table, useAction, useLoad } from '../../components/ui.jsx';
import { duration, SlaChip, slaStateLabel, UnifiedBadge } from './components.jsx';

const STATES = ['breached', 'at_risk', 'paused', 'running', 'met', 'breached_closed'];
const CLOCKS = { preauth: 'Pre-authorisation', final_auth: 'Final authorisation', settlement: 'Settlement' };
const UNIFIED = ['Pending', 'Awaiting Documents', 'Under Review', 'Authorized', 'Partially Authorized', 'Rejected', 'Discharged', 'Settlement Pending', 'Settled', 'Closed'];

function PolicyEditor({ current, onSaved, onClose }) {
  const [rules, setRules] = useState({ ...current.rules });
  const [changeNote, setChangeNote] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const act = useAction();
  const num = (k) => <input inputMode="numeric" value={rules[k]} onChange={(e) => setRules({ ...rules, [k]: e.target.value === '' ? '' : Number(e.target.value) })} />;
  const save = () => act.run(async () => {
    await api.post('/claims-ops/sla/policies', { rules, changeNote, effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined });
    onSaved();
  });
  return (
    <>
      <Alert kind="info">A new version applies to claims and grievances that start after it takes effect. Existing ones keep the version they started under. The change is audited.</Alert>
      <div className="form-grid">
        <Field label="Cashless pre-authorisation (minutes)">{num('preauthMinutes')}</Field>
        <Field label="Final authorisation after discharge request (minutes)">{num('finalAuthMinutes')}</Field>
        <Field label="Settlement from last necessary document (days)">{num('settlementDays')}</Field>
        <Field label="Grievance resolution (days)">{num('grievanceDays')}</Field>
        <Field label="At-risk threshold (% of time remaining)">{num('atRiskPct')}</Field>
        <label className="check"><input type="checkbox" checked={rules.pauseOnCustomerDocuments} onChange={(e) => setRules({ ...rules, pauseOnCustomerDocuments: e.target.checked })} /> Pause clocks while awaiting customer documents</label>
        <Field label="Effective from (optional)" hint="Defaults to now"><input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
        <Field label="Reason for change (required)" className="full"><textarea value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="e.g. Updated per compliance review of the latest IRDAI circular" /></Field>
      </div>
      <ErrorBox error={act.error} />
      <div className="row end" style={{ marginTop: '.8rem' }}>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={act.busy || !changeNote.trim()} onClick={save}>Publish new version</button>
      </div>
    </>
  );
}

function PolicyCard({ isAdmin }) {
  const res = useLoad(() => api.get('/claims-ops/sla/policies'));
  const [editing, setEditing] = useState(false);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const versions = res.data.versions;
  const current = versions.find((v) => v.id === res.data.current) || versions[0];
  return (
    <Card title="SLA policy" actions={isAdmin && current && <button className="btn sm" onClick={() => setEditing(true)}>New version</button>}>
      <p className="co-disclaimer" style={{ marginTop: 0 }}>{res.data.source}</p>
      <Table rows={versions} columns={[
        { key: 'version', label: 'Version', render: (v) => <>v{v.version} {v.id === res.data.current && <Badge kind="ok">Current</Badge>}</> },
        { key: 'effectiveFrom', label: 'Effective from', render: (v) => dateTime(v.effectiveFrom) },
        { key: 'rules', label: 'Targets', render: (v) => `Pre-auth ${v.rules.preauthMinutes} min · Final ${v.rules.finalAuthMinutes} min · Settlement ${v.rules.settlementDays} d · Grievance ${v.rules.grievanceDays} d${v.rules.pauseOnCustomerDocuments ? ' · pauses on customer documents' : ''}` },
        { key: 'changeNote', label: 'Change note', render: (v) => <>{v.changeNote}<div className="muted" style={{ fontSize: '.78rem' }}>{v.createdBy}</div></> },
      ]} />
      <Modal open={editing} title="Publish a new SLA policy version" large onClose={() => setEditing(false)}>
        {current && <PolicyEditor current={current} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); res.reload(); }} />}
      </Modal>
    </Card>
  );
}

const fmtStat = (t, days) => (t.avgMs == null ? '—' : days ? `${(t.avgMs / 86400000).toFixed(1)} d` : duration(t.avgMs));

export function SlaBoard() {
  const { user } = useAuth();
  const [f, setF] = useState({ state: '', clock: '', type: '', unified: '', q: '', scope: 'open' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/claims-ops/sla?${qs}`), [qs]);
  const nav = useNavigate();
  const act = useAction();
  const team = ['claims_officer', 'admin'].includes(user.role);
  const d = res.data;
  return (
    <>
      <PageHeader title="Claims SLA board" subtitle="Regulatory turnaround tracking for cashless authorisations, settlements and grievances."
        actions={team && <button className="btn secondary sm" disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post('/claims-ops/sla/check'); res.reload(); return r; }, (r) => `Check complete: ${r.newBreaches} new breach(es) recorded`)}>Run breach check</button>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error || res.error} />
      {d?.readOnly && <Alert kind="info">Read-only oversight view.</Alert>}
      {d && (
        <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
          <Stat label="Open claims" value={d.counts.openClaims} />
          <Stat label="Clocks at risk" value={d.counts.atRisk} />
          <Stat label="Clocks breached (running)" value={d.counts.breached} />
          <Stat label="Paused (awaiting documents)" value={d.counts.paused} />
        </div>
      )}
      {d && (
        <Card title="Turnaround">
          <div className="table-wrap"><table>
            <thead><tr><th>Clock</th><th className="num">Target</th><th className="num">Completed</th><th className="num">Average</th><th className="num">Median</th><th className="num">Within target</th><th className="num">Running</th></tr></thead>
            <tbody>
              {[['preauth', `${d.policy?.rules.preauthMinutes} min`], ['final_auth', `${d.policy?.rules.finalAuthMinutes} min`], ['settlement', `${d.policy?.rules.settlementDays} d`, true], ['grievance', `${d.policy?.rules.grievanceDays} d`, true]].map(([k, target, days]) => {
                const t = d.turnaround[k];
                return (
                  <tr key={k}><td>{CLOCKS[k] || 'Grievance resolution'}</td><td className="num">{target}</td><td className="num">{t.completed}</td><td className="num">{fmtStat(t, days)}</td>
                    <td className="num">{t.medianMs == null ? '—' : days ? `${(t.medianMs / 86400000).toFixed(1)} d` : duration(t.medianMs)}</td>
                    <td className="num">{t.withinSlaPct == null ? '—' : `${t.withinSlaPct}%`}</td><td className="num">{t.running}</td></tr>
                );
              })}
            </tbody>
          </table></div>
          <small className="muted">Breaches recorded: {d.counts.breachesRecorded} claim clock(s); open grievances past deadline: {d.counts.grievancesOpenBreached}. <Link to="/ops/grievances">Grievances</Link></small>
        </Card>
      )}
      <Card title="Claims">
        <div className="co-filters">
          <Field label="SLA state"><select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}><option value="">Any</option>{STATES.map((s) => <option key={s} value={s}>{slaStateLabel(s)}</option>)}</select></Field>
          <Field label="Clock"><select value={f.clock} onChange={(e) => setF({ ...f, clock: e.target.value })}><option value="">Any</option>{Object.entries(CLOCKS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Claim type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">Any</option><option value="cashless">Cashless</option><option value="reimbursement">Reimbursement</option></select></Field>
          <Field label="Status"><select value={f.unified} onChange={(e) => setF({ ...f, unified: e.target.value })}><option value="">Any</option>{UNIFIED.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Show"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="open">Open claims</option><option value="all">All claims</option></select></Field>
          <Field label="Search"><input placeholder="Claim, policy, hospital, insurer ref" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        </div>
        {res.loading && !d ? <Loading /> : d && (
          <Table rows={d.rows} empty="No claims match these filters." onRowClick={team ? (r) => nav(`/ops/health-claims/${r.id}`) : undefined} columns={[
            { key: 'claimNumber', label: 'Claim', render: (r) => <>{r.claimNumber}<div className="muted" style={{ fontSize: '.78rem' }}>{r.insurerClaimRef}</div></> },
            { key: 'type', label: 'Type', render: (r) => titleCase(r.type) },
            { key: 'hospitalName', label: 'Hospital' },
            { key: 'unifiedStatus', label: 'Status', render: (r) => <><UnifiedBadge status={r.unifiedStatus} /><div className="muted" style={{ fontSize: '.78rem' }}>With {r.responsible}</div></> },
            { key: 'sla', label: 'Current clock', render: (r) => <SlaChip sla={r.sla} /> },
            { key: 'due', label: 'Due', render: (r) => (r.sla?.dueAt ? dateTime(r.sla.dueAt) : '—') },
            { key: 'flags', label: '', render: (r) => <>{r.breachRecorded && <Badge kind="error">Breach logged</Badge>} {team && r.openFlags > 0 && <Badge kind="warn">{r.openFlags} flag{r.openFlags > 1 ? 's' : ''}</Badge>} <span className="muted" style={{ fontSize: '.75rem' }}>v{r.policyVersion}</span></> },
          ]} />
        )}
      </Card>
      <PolicyCard isAdmin={user.role === 'admin'} />
    </>
  );
}

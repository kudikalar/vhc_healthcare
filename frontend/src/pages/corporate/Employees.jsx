// Employee roster (/corporate/employees) and employee detail (/corporate/employees/:id):
// CSV import, single add (joiners), exits (leavers), dependents, enrolment and certificates.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money } from '../../format.js';
import { Alert, Badge, Card, DevHint, ErrorBox, Field, KV, Loading, Modal, PageHeader, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { BackLink, downloadPdf, empType, EmployerPicker, useCorpRole, useEmployerScope, useMeta } from './shared.jsx';

const blankEmployee = { employeeId: '', name: '', email: '', dob: '', gender: 'female', grade: '', joiningDate: '', employmentType: 'full_time', location: '' };

export function Employees() {
  const scope = useEmployerScope();
  const role = useCorpRole();
  const nav = useNavigate();
  const [filters, setFilters] = useState({ status: 'Active', q: '' });
  const res = useLoad(() => (scope.ready ? api.get(`/corporate/members${scope.qs(filters)}`) : null), [scope.employerId, scope.ready, filters.status, filters.q]);
  const [modal, setModal] = useState(null);
  const canWrite = role.rosterWrite && !role.readOnly;
  return (
    <>
      <PageHeader title="Employees" subtitle="The roster used for eligibility and enrolment. Synthetic data only in this environment." actions={canWrite && (
        <div className="corp-actions">
          <button className="btn secondary" onClick={() => setModal('import')}>Import CSV</button>
          <button className="btn" onClick={() => setModal('add')}>Add employee</button>
        </div>
      )} />
      <div className="corp-toolbar">
        <div className="filters" role="group" aria-label="Filter employees">
          <label>Search<input type="search" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Name, ID, email, grade" /></label>
          <label>Status
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="Active">Active</option><option value="Left">Left</option><option value="">All</option>
            </select>
          </label>
        </div>
        <EmployerPicker scope={scope} />
      </div>
      <Card>
        {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data || []} empty="No employees match. Import a CSV or add an employee." onRowClick={(m) => nav(`/corporate/employees/${m.id}${scope.suffix}`)} columns={[
            { key: 'employeeId', label: 'ID' },
            { key: 'name', label: 'Name', render: (m) => <><Link to={`/corporate/employees/${m.id}${scope.suffix}`} onClick={(e) => e.stopPropagation()}>{m.name}</Link><div className="muted">{m.email}</div></> },
            { key: 'grade', label: 'Grade' },
            { key: 'employmentType', label: 'Type', render: (m) => <span style={{ textTransform: 'capitalize' }}>{empType(m.employmentType)}</span> },
            { key: 'joiningDate', label: 'Joined', render: (m) => date(m.joiningDate) },
            { key: 'enrolmentStatus', label: 'Enrolment', render: (m) => <><Badge>{m.enrolmentStatus}</Badge>{m.eligible === false && m.enrolmentStatus === 'Not Enrolled' && <div className="muted">Not eligible</div>}</> },
            { key: 'dependents', label: 'Dependents', num: true },
            { key: 'linked', label: 'VHC account', render: (m) => (m.linked ? <Badge kind="ok">Linked</Badge> : <span className="muted">Not yet</span>) },
            { key: 'status', label: 'Status', render: (m) => <Badge kind={m.status === 'Active' ? 'ok' : ''}>{m.status}</Badge> },
          ]} />
        )}
      </Card>
      <AddEmployee open={modal === 'add'} onClose={() => setModal(null)} scope={scope} onDone={(m) => { setModal(null); nav(`/corporate/employees/${m.id}${scope.suffix}`); }} />
      <ImportCsv open={modal === 'import'} onClose={() => setModal(null)} scope={scope} onDone={() => res.reload()} />
    </>
  );
}

function EmployeeFields({ f, setF, fe, edit = false }) {
  const meta = useMeta();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="form-grid">
      {!edit && <Field label="Employee ID" error={fe.employeeId}><input value={f.employeeId} onChange={set('employeeId')} maxLength={30} /></Field>}
      <Field label="Full name" error={fe.name}><input value={f.name} onChange={set('name')} autoComplete="off" /></Field>
      <Field label="Work email" hint="Used to link the employee's VHC account" error={fe.email} className="full"><input type="email" value={f.email} onChange={set('email')} /></Field>
      {!edit && <Field label="Date of birth" error={fe.dob}><input type="date" value={f.dob} onChange={set('dob')} /></Field>}
      {!edit && (
        <Field label="Gender" error={fe.gender}>
          <select value={f.gender} onChange={set('gender')}><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
        </Field>
      )}
      <Field label="Grade" error={fe.grade}><input value={f.grade} onChange={set('grade')} maxLength={20} /></Field>
      {!edit && <Field label="Joining date" error={fe.joiningDate}><input type="date" value={f.joiningDate} onChange={set('joiningDate')} /></Field>}
      <Field label="Employment type" error={fe.employmentType}>
        <select value={f.employmentType} onChange={set('employmentType')}>
          {(meta.data?.employmentTypes || ['full_time']).map((t) => <option key={t} value={t}>{empType(t)}</option>)}
        </select>
      </Field>
      <Field label="Location (optional)"><input value={f.location} onChange={set('location')} maxLength={60} /></Field>
    </div>
  );
}

function AddEmployee({ open, onClose, scope, onDone }) {
  const [f, setF] = useState(blankEmployee);
  const act = useAction();
  return (
    <Modal open={open} title="Add an employee (joiner)" onClose={onClose}>
      <ErrorBox error={act.error} />
      <EmployeeFields f={f} setF={setF} fe={act.error?.fields || {}} />
      <p className="muted" style={{ fontSize: '.85rem' }}>If an active group policy exists, the employee becomes eligible from their joining date plus any minimum service period. Enrolment after the start of the policy is billed as a pro-rata endorsement.</p>
      <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const m = await api.post(`/corporate/members${scope.qs()}`, f); setF(blankEmployee); onDone(m); })}>Add employee</button></div>
    </Modal>
  );
}

function ImportCsv({ open, onClose, scope, onDone }) {
  const meta = useMeta();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const act = useAction();
  const cols = meta.data?.csvColumns || { required: ['employeeId', 'name', 'email', 'dob', 'gender', 'grade', 'joiningDate'], optional: [] };
  const template = () => {
    const body = `${[...cols.required, ...cols.optional].join(',')}\nNW-2001,Sample Employee,sample.employee@example.test,1990-01-31,female,E1,2026-01-15,full_time,Chennai\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'roster-template.csv' }).click();
    URL.revokeObjectURL(url);
  };
  const readFile = (file) => {
    if (!file) return;
    if (file.size > 1024 * 1024) { act.setError(new Error('The file is larger than 1 MB. Split it into smaller files.')); return; }
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result || '')); setResult(null); };
    reader.readAsText(file);
  };
  const send = (opts) => act.run(async () => {
    try {
      const r = await api.post(`/corporate/members/import${scope.qs()}`, { csv, ...opts });
      setResult(r);
      if (!opts.dryRun) onDone();
      return r;
    } catch (e) {
      if (e.details?.rowErrors) setResult({ ...e.details, failed: true });
      throw e;
    }
  }, (r) => (opts.dryRun ? `${r.validRows} of ${r.totalRows} rows are valid` : `${r.imported} employee(s) imported`));
  const errors = result?.rowErrors || [];
  return (
    <Modal open={open} title="Import employees from CSV" onClose={() => { onClose(); setResult(null); }} large>
      <p className="muted" style={{ marginTop: 0 }}>Required columns: <code>{cols.required.join(', ')}</code>. Optional: <code>{cols.optional.join(', ')}</code>. Dates as YYYY-MM-DD. Use synthetic data only in this environment.</p>
      <div className="row" style={{ marginBottom: '.6rem' }}>
        <label className="btn secondary sm">Choose file<input type="file" accept=".csv,text/csv" hidden onChange={(e) => readFile(e.target.files?.[0])} /></label>
        <button className="btn ghost sm" onClick={template}>Download template</button>
      </div>
      <Field label="CSV content" className="corp-csv"><textarea value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); }} spellCheck={false} /></Field>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {errors.length > 0 && (
        <div className="corp-errors">
          <Table rows={errors.map((e, i) => ({ ...e, id: i }))} columns={[{ key: 'row', label: 'Row', num: true }, { key: 'employeeId', label: 'Employee ID' }, { key: 'field', label: 'Column' }, { key: 'message', label: 'Problem' }]} />
        </div>
      )}
      <div className="row end" style={{ marginTop: '.75rem' }}>
        <button className="btn secondary" disabled={!csv.trim() || act.busy} onClick={() => send({ dryRun: true })}>Validate</button>
        {errors.length > 0 && result?.validRows > 0 && <button className="btn secondary" disabled={act.busy} onClick={() => send({ skipInvalid: true })}>Import {result.validRows} valid row(s) only</button>}
        <button className="btn" disabled={!csv.trim() || act.busy} onClick={() => send({})}>Import</button>
      </div>
    </Modal>
  );
}

export function EmployeeDetail() {
  const { id } = useParams();
  const scope = useEmployerScope();
  const role = useCorpRole();
  const res = useLoad(() => api.get(`/corporate/members/${id}`), [id]);
  const act = useAction();
  const [modal, setModal] = useState(null);
  const [invite, setInvite] = useState(null);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <><BackLink to={`/corporate/employees${scope.suffix}`}>Employees</BackLink><ErrorBox error={res.error} /></>;
  const m = res.data;
  const canWrite = role.rosterWrite && !role.readOnly && m.status === 'Active';
  const current = m.enrolments.find((e) => ['Enrolled', 'Pending Insurer'].includes(e.status));
  const run = (fn, msg) => act.run(async () => { const r = await fn(); res.reload(); return r; }, msg);
  return (
    <>
      <BackLink to={`/corporate/employees${scope.suffix}`}>Employees</BackLink>
      <PageHeader title={m.name} subtitle={`${m.employeeId} · ${m.grade} · ${empType(m.employmentType)}`} actions={canWrite && (
        <div className="corp-actions">
          {!current && m.rules?.policy && <button className="btn" disabled={act.busy} onClick={() => run(() => api.post(`/corporate/members/${m.id}/enrol`, {}), (r) => (r.skipped ? `Not submitted: ${r.skipped}` : r.enrolment.status === 'Enrolled' ? 'Enrolled — confirmed by the sandbox insurer' : r.enrolment.status === 'Pending Insurer' ? 'Submitted — awaiting insurer confirmation' : `Insurer decision: ${r.enrolment.status}`))}>Submit enrolment</button>}
          <button className="btn secondary" disabled={act.busy} onClick={() => run(async () => { const r = await api.post(`/corporate/members/${m.id}/invite`); setInvite(r); return r; }, 'Invitation sent')}>Invite to benefits</button>
          <button className="btn secondary" onClick={() => setModal('edit')}>Edit</button>
          <button className="btn danger" onClick={() => setModal('leave')}>Record exit</button>
        </div>
      )} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {invite && <DevHint>{invite.linked ? 'The employee already has a verified VHC account and was notified in-app (email simulated).' : `No VHC account yet: a simulated email asks them to register with ${m.email} at ${invite.registerPath}; their membership appears under ${invite.benefitsPath} after sign-in.`}</DevHint>}
      <div className="grid grid-2 corp-grid">
        <Card title="Employee">
          <KV items={[
            ['Email', m.email], ['Date of birth', date(m.dob)], ['Gender', m.gender], ['Joining date', date(m.joiningDate)], ['Location', m.location || '—'],
            ['Status', <Badge key="s">{m.status}</Badge>], m.leavingDate && ['Leaving date', date(m.leavingDate)],
            ['VHC account', m.linked ? <Badge key="l" kind="ok">Linked</Badge> : 'Not linked yet (links automatically when they sign in with this verified email)'],
          ]} />
        </Card>
        <Card title="Dependents" actions={canWrite && <button className="btn sm secondary" onClick={() => setModal('dependent')}>Add dependent</button>}>
          <Table rows={m.dependents} empty="No dependents registered." columns={[
            { key: 'name', label: 'Name' }, { key: 'relationship', label: 'Relationship', render: (d) => <span style={{ textTransform: 'capitalize' }}>{d.relationship}</span> },
            { key: 'dob', label: 'DOB', render: (d) => date(d.dob) },
            { key: 'coverStatus', label: 'Cover', render: (d) => (d.status === 'Removed' ? <Badge>Removed</Badge> : <small>{d.coverStatus}</small>) },
            { key: 'x', label: '', render: (d) => canWrite && d.status === 'Active' && <button className="btn sm ghost" onClick={() => setModal({ remove: d })}>Remove</button> },
          ]} />
          {m.rules && <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>Eligible relationships: {m.rules.relationships.join(', ') || 'none'} · up to {m.rules.rules.maxChildren} children (≤ {m.rules.rules.childMaxAge} yrs){m.rules.rules.parents ? ` · parents ≤ ${m.rules.rules.parentMaxAge} yrs` : ''}.</p>}
        </Card>
      </div>
      <Card title="Enrolments & certificates">
        <Table rows={m.enrolments} empty="Not enrolled in a group policy yet." columns={[
          { key: 'policyNumber', label: 'Policy', render: (e) => <Link to={`/corporate/policies/${e.groupPolicyId}${scope.suffix}`}>{e.policyNumber}</Link> },
          { key: 'status', label: 'Status', render: (e) => <><Badge>{e.status}</Badge>{e.rejectReason && <div className="muted">{e.rejectReason}</div>}</> },
          { key: 'coverFrom', label: 'Cover', render: (e) => `${date(e.coverFrom)} – ${date(e.coverTo)}` },
          { key: 'lives', label: 'Lives', render: (e) => e.lives.map((l) => `${l.name} (${l.relationship}${l.status !== 'Covered' ? `, ${l.status.toLowerCase()}` : ''})`).join(', ') },
          { key: 'annualPremium', label: 'Annual premium', num: true, render: (e) => money(e.annualPremium) },
          { key: 'cert', label: 'Certificate', render: (e) => (e.certificateNumber ? <button className="btn sm secondary" onClick={() => act.run(() => downloadPdf(`/corporate/enrolments/${e.id}/certificate`, e.certificateNumber))}>Download</button> : '—') },
        ]} />
      </Card>
      <Card title="History"><Timeline items={(m.history || []).map((h) => ({ at: h.at, by: h.by, status: h.event, note: h.note }))} /></Card>

      <EditEmployee open={modal === 'edit'} m={m} onClose={() => setModal(null)} onDone={() => { setModal(null); res.reload(); }} />
      <LeaveEmployee open={modal === 'leave'} m={m} onClose={() => setModal(null)} onDone={() => { setModal(null); res.reload(); }} />
      <AddDependent open={modal === 'dependent'} m={m} enrolled={current?.status === 'Enrolled'} path={`/corporate/members/${m.id}/dependents`} onClose={() => setModal(null)} onDone={() => { setModal(null); res.reload(); }} />
      <RemoveDependent dep={modal?.remove} covered={current?.status === 'Enrolled'} path={(d) => `/corporate/dependents/${d.id}/remove`} onClose={() => setModal(null)} onDone={() => { setModal(null); res.reload(); }} />
    </>
  );
}

function EditEmployee({ open, m, onClose, onDone }) {
  const [f, setF] = useState({ name: m.name, email: m.email, grade: m.grade, employmentType: m.employmentType, location: m.location || '' });
  const act = useAction();
  return (
    <Modal open={open} title="Edit employee" onClose={onClose}>
      <ErrorBox error={act.error} />
      <EmployeeFields f={f} setF={setF} fe={act.error?.fields || {}} edit />
      <p className="muted" style={{ fontSize: '.85rem' }}>Changing the email unlinks the current VHC account until the employee signs in with the new verified address.</p>
      <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.patch(`/corporate/members/${m.id}`, f); onDone(); })}>Save</button></div>
    </Modal>
  );
}

function LeaveEmployee({ open, m, onClose, onDone }) {
  const [leavingDate, setLeavingDate] = useState('');
  const act = useAction();
  return (
    <Modal open={open} title={`Record exit — ${m.name}`} onClose={onClose}>
      <ErrorBox error={act.error} />
      <Field label="Last working day (cover ends on this date)" error={act.error?.fields?.leavingDate}><input type="date" value={leavingDate} onChange={(e) => setLeavingDate(e.target.value)} /></Field>
      <p className="muted" style={{ fontSize: '.85rem' }}>A deletion endorsement is sent to the insurer for the employee and covered dependents. The unused premium is credited pro-rata (sandbox rule: daily pro-rata).</p>
      <div className="row end"><button className="btn danger" disabled={act.busy || !leavingDate} onClick={() => act.run(async () => { await api.post(`/corporate/members/${m.id}/leave`, { leavingDate }); onDone(); })}>Record exit</button></div>
    </Modal>
  );
}

export function AddDependent({ open, m, enrolled, path, onClose, onDone, relationships }) {
  const rels = relationships || m.rules?.relationships || ['spouse', 'child', 'parent'];
  const [f, setF] = useState({ name: '', relationship: rels[0] || 'spouse', dob: '', gender: 'female', effectiveDate: '' });
  const act = useAction();
  const fe = act.error?.fields || {};
  return (
    <Modal open={open} title="Add a dependent" onClose={onClose}>
      <ErrorBox error={act.error} />
      <div className="form-grid">
        <Field label="Full name" error={fe.name}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Relationship" error={fe.relationship}>
          <select value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })}>{rels.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select>
        </Field>
        <Field label="Date of birth" error={fe.dob}><input type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></Field>
        <Field label="Gender" error={fe.gender}><select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></Field>
        {enrolled && <Field label="Cover from" hint="e.g. date of marriage or birth; defaults to today" error={fe.effectiveDate}><input type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>}
      </div>
      {enrolled && <p className="muted" style={{ fontSize: '.85rem' }}>Cover is already in force, so this is a mid-term addition: an endorsement goes to the insurer and the pro-rata premium is billed to the employer.</p>}
      <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const body = { ...f }; if (!body.effectiveDate) delete body.effectiveDate; await api.post(path, body); onDone(); })}>Add dependent</button></div>
    </Modal>
  );
}

export function RemoveDependent({ dep, covered, path, onClose, onDone }) {
  const [effectiveDate, setEffectiveDate] = useState('');
  const act = useAction();
  if (!dep) return null;
  return (
    <Modal open title={`Remove ${dep.name}`} onClose={onClose}>
      <ErrorBox error={act.error} />
      {covered && <Field label="Cover ends on" hint="Defaults to today" error={act.error?.fields?.effectiveDate}><input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /></Field>}
      <p className="muted" style={{ fontSize: '.85rem' }}>{covered ? 'If this person is covered, a deletion endorsement is sent to the insurer.' : 'This removes the dependent before enrolment.'}</p>
      <div className="row end"><button className="btn danger" disabled={act.busy} onClick={() => act.run(async () => { await api.post(path(dep), effectiveDate ? { effectiveDate } : {}); onDone(); })}>Remove</button></div>
    </Modal>
  );
}

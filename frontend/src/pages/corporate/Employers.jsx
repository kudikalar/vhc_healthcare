// Corporate partner registry (/corporate/employers, /corporate/employers/:id): onboarding pipeline,
// legal & billing details, authorised users (invitations), contracts, quotations and analytics.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { date, dateTime, money, ROLE_LABEL, titleCase, toPaise } from '../../format.js';
import { Alert, Badge, Card, DevHint, ErrorBox, Field, KV, Loading, Modal, PageHeader, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { BackLink, lakh, pctBp, Priv, SandboxNote, useCorpRole, useMeta } from './shared.jsx';
import { QuoteView } from './GroupPolicies.jsx';

const PIPELINE = ['Prospect', 'Proposal', 'Contracted', 'Active'];

export function Employers() {
  const role = useCorpRole();
  const nav = useNavigate();
  const [f, setF] = useState({ status: '', q: '' });
  const res = useLoad(() => api.get(`/corporate/employers?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`), [f.status, f.q]);
  const analytics = useLoad(() => api.get('/corporate/analytics'), []);
  const [create, setCreate] = useState(false);
  const meta = useMeta();
  return (
    <>
      <PageHeader title="Employers" subtitle={role.readOnly ? 'Corporate partner registry (read-only).' : 'Corporate partner registry and onboarding pipeline.'} actions={role.manage && <button className="btn" onClick={() => setCreate(true)}>New employer</button>} />
      <div className="corp-toolbar">
        <div className="filters" role="group" aria-label="Filter employers">
          <label>Search<input type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Name, GSTIN, industry" /></label>
          <label>Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{(meta.data?.employerStatuses || []).map((s) => <option key={s}>{s}</option>)}</select></label>
        </div>
      </div>
      <Card>
        {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No employers match." onRowClick={(e) => nav(`/corporate/employers/${e.id}`)} columns={[
            { key: 'name', label: 'Employer', render: (e) => <><strong>{e.name}</strong>{e.sandbox && <> <Badge kind="warn">Synthetic</Badge></>}<div className="muted">{e.industry || '—'}</div></> },
            { key: 'gstin', label: 'GSTIN', render: (e) => e.gstin || '—' },
            { key: 'employeeCount', label: 'Population', num: true, render: (e) => <>{e.employeeCount ?? '—'}<div className="muted">{e.rosterCount} on roster</div></> },
            { key: 'accountOwner', label: 'Account owner', render: (e) => e.accountOwner?.name || '—' },
            { key: 'status', label: 'Status', render: (e) => <Badge>{e.status}</Badge> },
          ]} />
        )}
      </Card>
      {analytics.data && (
        <Card title="Employer analytics" actions={<small className="muted">Utilisation shown only for cohorts of {analytics.data.minCohort}+ claimants</small>}>
          <AnalyticsTable rows={analytics.data.rows} />
        </Card>
      )}
      {create && <EmployerForm onClose={() => setCreate(false)} onDone={(e) => { setCreate(false); nav(`/corporate/employers/${e.id}`); }} />}
    </>
  );
}

export function AnalyticsTable({ rows }) {
  return (
    <Table rows={rows.map((r) => ({ ...r, id: r.employerId }))} empty="No employers." columns={[
      { key: 'employerName', label: 'Employer' },
      { key: 'enrolment', label: 'Enrolment', render: (r) => `${r.enrolment.enrolled}/${r.enrolment.eligible} (${pctBp(r.enrolment.completionBp)})` },
      { key: 'renewal', label: 'Renewal', render: (r) => <>{r.renewal.status}{r.renewal.nextRenewal && <div className="muted">{date(r.renewal.nextRenewal.endDate)}</div>}</> },
      { key: 'adoption', label: 'Benefits adoption', render: (r) => <>{pctBp(r.adoption.linkedBp)} linked accounts<div className="muted">{r.adoption.coveredDependents} dependents · wellness <Priv cell={r.adoption.wellnessParticipants} /></div></> },
      { key: 'utilisation', label: 'Utilisation (aggregate)', render: (r) => (r.utilisation.suppressed ? <span className="corp-suppressed">{r.utilisation.claimsReported === 0 ? 'No claims' : 'Suppressed for privacy'}</span> : <>{r.utilisation.claimsReported} claims<div className="muted">{r.utilisation.claimedAmountBand}</div></>) },
      { key: 'support', label: 'Support', render: (r) => `${r.support.open} open / ${r.support.total}` },
    ]} />
  );
}

function EmployerForm({ initial, onClose, onDone }) {
  const meta = useMeta();
  const e0 = initial || {};
  const [f, setF] = useState({
    name: e0.name || '', legalName: e0.legalName || '', entityType: e0.entityType || 'Private Limited', cin: e0.cin || '', llpin: e0.llpin || '', gstin: e0.gstin || '', industry: e0.industry || '',
    employeeCount: e0.employeeCount ?? '', locations: (e0.locations || []).join(', '),
    hrContact: { name: '', email: '', phone: '', ...(e0.hrContact || {}) },
    billing: { contactName: '', email: '', address: '', city: '', state: '', postalCode: '', poNumber: '', ...(e0.billing || {}) },
    insuranceRequirements: e0.insuranceRequirements || '',
    existingArrangement: { hasExisting: false, provider: '', renewalDate: '', notes: '', ...(e0.existingArrangement || {}) },
    desiredCoverage: { sumInsured: '', familyDefinition: '', notes: '', ...(e0.desiredCoverage || {}) },
    contractValidity: { from: '', to: '', ...(e0.contractValidity || {}) },
    billingArrangement: e0.billingArrangement || 'employer_paid', billingFrequency: e0.billingFrequency || 'annual', accountOwnerId: e0.accountOwnerId || '',
  });
  const act = useAction();
  const fe = act.error?.fields || {};
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setIn = (g, k) => (e) => setF({ ...f, [g]: { ...f[g], [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } });
  const save = () => act.run(async () => {
    const body = { ...f, employeeCount: f.employeeCount === '' ? 0 : Number(f.employeeCount), desiredCoverage: { ...f.desiredCoverage, sumInsured: f.desiredCoverage.sumInsured ? Number(f.desiredCoverage.sumInsured) : null } };
    const out = initial ? await api.put(`/corporate/employers/${initial.id}`, body) : await api.post('/corporate/employers', body);
    onDone(out);
  });
  const m = meta.data;
  if (!m) return null;
  return (
    <Modal open title={initial ? `Edit ${initial.name}` : 'New employer (prospect)'} onClose={onClose} large>
      <ErrorBox error={act.error} />
      <h4 className="corp-form-h">Legal entity</h4>
      <div className="form-grid">
        <Field label="Registered name" error={fe.name}><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Legal name"><input value={f.legalName} onChange={set('legalName')} /></Field>
        <Field label="Entity type" error={fe.entityType}><select value={f.entityType} onChange={set('entityType')}>{m.entityTypes.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="CIN (optional)" error={fe.cin}><input value={f.cin} onChange={set('cin')} maxLength={21} /></Field>
        <Field label="LLPIN (optional)" error={fe.llpin}><input value={f.llpin} onChange={set('llpin')} maxLength={8} /></Field>
        <Field label="GSTIN" hint="15 characters; required before contracting" error={fe.gstin}><input value={f.gstin} onChange={set('gstin')} maxLength={15} style={{ textTransform: 'uppercase' }} /></Field>
        <Field label="Industry"><input value={f.industry} onChange={set('industry')} /></Field>
        <Field label="Employee population" error={fe.employeeCount}><input type="number" min="0" value={f.employeeCount} onChange={set('employeeCount')} /></Field>
        <Field label="Locations" hint="Comma-separated" className="full"><input value={f.locations} onChange={set('locations')} /></Field>
      </div>
      <h4 className="corp-form-h">Authorised HR contact</h4>
      <div className="form-grid">
        <Field label="Name"><input value={f.hrContact.name} onChange={setIn('hrContact', 'name')} /></Field>
        <Field label="Email" error={fe['hrContact.email']}><input type="email" value={f.hrContact.email} onChange={setIn('hrContact', 'email')} /></Field>
        <Field label="Mobile" error={fe['hrContact.phone']}><input value={f.hrContact.phone} onChange={setIn('hrContact', 'phone')} /></Field>
      </div>
      <h4 className="corp-form-h">Billing</h4>
      <div className="form-grid">
        <Field label="Billing contact"><input value={f.billing.contactName} onChange={setIn('billing', 'contactName')} /></Field>
        <Field label="Billing email" error={fe['billing.email']}><input type="email" value={f.billing.email} onChange={setIn('billing', 'email')} /></Field>
        <Field label="Address" className="full"><input value={f.billing.address} onChange={setIn('billing', 'address')} /></Field>
        <Field label="City"><input value={f.billing.city} onChange={setIn('billing', 'city')} /></Field>
        <Field label="State" error={fe['billing.state']}><select value={f.billing.state} onChange={setIn('billing', 'state')}><option value="">—</option>{m.states.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="PIN code" error={fe['billing.postalCode']}><input inputMode="numeric" maxLength={6} value={f.billing.postalCode} onChange={setIn('billing', 'postalCode')} /></Field>
        <Field label="PO number"><input value={f.billing.poNumber} onChange={setIn('billing', 'poNumber')} /></Field>
        <Field label="Billing arrangement" error={fe.billingArrangement}><select value={f.billingArrangement} onChange={set('billingArrangement')}>{m.billingArrangements.map((b) => <option key={b} value={b}>{titleCase(b)}</option>)}</select></Field>
        <Field label="Billing frequency"><select value={f.billingFrequency} onChange={set('billingFrequency')}>{m.billingFrequencies.map((b) => <option key={b} value={b}>{titleCase(b)}</option>)}</select></Field>
      </div>
      <h4 className="corp-form-h">Insurance needs</h4>
      <div className="form-grid">
        <Field label="Insurance requirements" className="full"><textarea value={f.insuranceRequirements} onChange={set('insuranceRequirements')} /></Field>
        <label className="corp-check full"><input type="checkbox" checked={!!f.existingArrangement.hasExisting} onChange={setIn('existingArrangement', 'hasExisting')} /> Has an existing group arrangement</label>
        {f.existingArrangement.hasExisting && <>
          <Field label="Existing provider"><input value={f.existingArrangement.provider} onChange={setIn('existingArrangement', 'provider')} /></Field>
          <Field label="Existing renewal date" error={fe['existingArrangement.renewalDate']}><input type="date" value={f.existingArrangement.renewalDate} onChange={setIn('existingArrangement', 'renewalDate')} /></Field>
        </>}
        <Field label="Desired sum insured"><select value={f.desiredCoverage.sumInsured || ''} onChange={setIn('desiredCoverage', 'sumInsured')}><option value="">—</option>{m.products[0].sumInsuredOptions.map((o) => <option key={o} value={o}>{lakh(o)}</option>)}</select></Field>
        <Field label="Desired family definition" error={fe['desiredCoverage.familyDefinition']}><select value={f.desiredCoverage.familyDefinition} onChange={setIn('desiredCoverage', 'familyDefinition')}><option value="">—</option>{Object.entries(m.familyDefinitions).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
      </div>
      <h4 className="corp-form-h">Contract & ownership</h4>
      <div className="form-grid">
        <Field label="Contract valid from" error={fe['contractValidity.from']}><input type="date" value={f.contractValidity.from} onChange={setIn('contractValidity', 'from')} /></Field>
        <Field label="Contract valid to" error={fe['contractValidity.to']}><input type="date" value={f.contractValidity.to} onChange={setIn('contractValidity', 'to')} /></Field>
        <Field label="Internal account owner" error={fe.accountOwnerId}><select value={f.accountOwnerId || ''} onChange={set('accountOwnerId')}><option value="">—</option>{m.salesUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_LABEL[u.role]})</option>)}</select></Field>
      </div>
      <div className="row end" style={{ marginTop: '1rem' }}><button className="btn" disabled={act.busy} onClick={save}>{initial ? 'Save changes' : 'Create employer'}</button></div>
    </Modal>
  );
}

export function EmployerDetail() {
  const { id } = useParams();
  const role = useCorpRole();
  const res = useLoad(() => api.get(`/corporate/employers/${id}`), [id]);
  const [tab, setTab] = useState('profile');
  const [edit, setEdit] = useState(false);
  const [statusTo, setStatusTo] = useState(null);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <><BackLink to="/corporate/employers">Employers</BackLink><ErrorBox error={res.error} /></>;
  const e = res.data;
  const q = `?employer=${e.id}`;
  const idx = PIPELINE.indexOf(e.status);
  return (
    <>
      <BackLink to="/corporate/employers">Employers</BackLink>
      <PageHeader title={e.name} subtitle={`${e.legalName || ''}${e.gstin ? ` · GSTIN ${e.gstin}` : ''}`} actions={role.manage && (
        <div className="corp-actions">
          {e.allowedTransitions.map((s) => <button key={s} className={`btn sm ${['Suspended', 'Ended'].includes(s) ? 'danger' : ''}`} onClick={() => setStatusTo(s)}>Move to {s}</button>)}
          <button className="btn sm secondary" onClick={() => setEdit(true)}>Edit</button>
        </div>
      )} />
      {e.sandbox && <SandboxNote>Synthetic employer for testing.</SandboxNote>}
      <ol className="corp-pipeline" aria-label="Onboarding pipeline">
        {[...PIPELINE, ...(['Suspended', 'Ended'].includes(e.status) ? [e.status] : [])].map((s, i) => <li key={s} className={s === e.status ? 'current' : i < idx ? 'done' : ''}>{s}</li>)}
      </ol>
      <nav className="corp-actions" aria-label="Employer workspace" style={{ marginBottom: '1rem' }}>
        <Link className="btn sm secondary" to={`/corporate${q}`}>HR dashboard</Link>
        <Link className="btn sm secondary" to={`/corporate/employees${q}`}>Employees</Link>
        <Link className="btn sm secondary" to={`/corporate/policies${q}`}>Group policies</Link>
        <Link className="btn sm secondary" to={`/corporate/endorsements${q}`}>Endorsements</Link>
        <Link className="btn sm secondary" to={`/corporate/invoices${q}`}>Invoices</Link>
        <Link className="btn sm secondary" to={`/corporate/wellness${q}`}>Wellness</Link>
      </nav>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'profile', label: 'Profile' }, { value: 'users', label: 'Users' }, { value: 'contracts', label: 'Contracts & quotes' }, { value: 'analytics', label: 'Analytics' }]} />
      {tab === 'profile' && (
        <div className="grid grid-2 corp-grid">
          <Card title="Organisation">
            <KV items={[
              ['Entity type', e.entityType], ['CIN', e.cin || '—'], ['LLPIN', e.llpin || '—'], ['GSTIN', e.gstin || '—'], ['Industry', e.industry],
              ['Employee population', e.employeeCount], ['On roster', e.rosterCount], ['Locations', (e.locations || []).join(', ') || '—'],
              ['HR contact', e.hrContact ? `${e.hrContact.name || ''} · ${e.hrContact.email || ''}` : '—'], ['Account owner', e.accountOwner?.name || '—'],
            ]} />
          </Card>
          <Card title="Billing & contract">
            <KV items={[
              ['Billing contact', e.billing ? `${e.billing.contactName || ''} · ${e.billing.email || ''}` : '—'],
              ['Billing address', e.billing ? [e.billing.address, e.billing.city, e.billing.state, e.billing.postalCode].filter(Boolean).join(', ') : '—'],
              ['Arrangement', titleCase(e.billingArrangement)], ['Frequency', titleCase(e.billingFrequency)],
              ['Contract validity', e.contractValidity?.from ? `${date(e.contractValidity.from)} – ${date(e.contractValidity.to)}` : '—'],
            ]} />
          </Card>
          <Card title="Insurance needs">
            <KV items={[
              ['Requirements', e.insuranceRequirements || '—'],
              ['Existing arrangement', e.existingArrangement?.hasExisting ? `${e.existingArrangement.provider || 'Yes'}${e.existingArrangement.renewalDate ? `, renews ${date(e.existingArrangement.renewalDate)}` : ''}` : 'None'],
              ['Desired cover', e.desiredCoverage?.sumInsured ? `${lakh(e.desiredCoverage.sumInsured)} · ${e.desiredCoverage.familyDefinition || ''}` : '—'],
            ]} />
          </Card>
          <Card title="Status history"><Timeline items={(e.statusHistory || []).map((h) => ({ ...h, status: h.status }))} /></Card>
        </div>
      )}
      {tab === 'users' && <EmployerUsers employer={e} canInvite={role.manage} />}
      {tab === 'contracts' && <Contracts employer={e} reload={res.reload} />}
      {tab === 'analytics' && <EmployerAnalytics employerId={e.id} />}
      {edit && <EmployerForm initial={e} onClose={() => setEdit(false)} onDone={() => { setEdit(false); res.reload(); }} />}
      {statusTo && <StatusModal employer={e} to={statusTo} onClose={() => setStatusTo(null)} onDone={() => { setStatusTo(null); res.reload(); }} />}
    </>
  );
}

function StatusModal({ employer, to, onClose, onDone }) {
  const [note, setNote] = useState('');
  const act = useAction();
  return (
    <Modal open title={`Move ${employer.name} to ${to}`} onClose={onClose}>
      <ErrorBox error={act.error} />
      <Field label={['Suspended', 'Ended'].includes(to) ? 'Reason (required)' : 'Note (optional)'} error={act.error?.fields?.note}><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="muted" style={{ fontSize: '.85rem' }}>Status changes are audited. Contracted and Active require a valid GSTIN, billing email, HR contact and contract dates; Active also needs an active contract.</p>
      <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/corporate/employers/${employer.id}/status`, { status: to, note }); onDone(); })}>Confirm</button></div>
    </Modal>
  );
}

/** Corporate users of an employer; admins/ops invite either role, corporate admins invite HR. */
export function EmployerUsers({ employer, canInvite }) {
  const role = useCorpRole();
  const res = useLoad(() => api.get(`/corporate/employers/${employer.id}/users`), [employer.id]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', role: 'corporate_hr' });
  const [token, setToken] = useState(null);
  const act = useAction();
  const fe = act.error?.fields || {};
  const roles = role.corpAdmin ? ['corporate_hr'] : ['corporate_admin', 'corporate_hr'];
  return (
    <Card title="Employer users" actions={canInvite && <button className="btn sm" onClick={() => { setOpen(true); setToken(null); }}>Invite user</button>}>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      {token && <DevHint>invitation emails are simulated. Invite link: <a href={`/accept-invite?token=${token}`}>/accept-invite?token=…</a></DevHint>}
      <ErrorBox error={act.error} />
      {res.loading && !res.data ? <Loading /> : (
        <Table rows={res.data || []} empty="No users yet." columns={[
          { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role', render: (u) => ROLE_LABEL[u.role] },
          { key: 'status', label: 'Status', render: (u) => <Badge>{u.status}</Badge> }, { key: 'lastLoginAt', label: 'Last sign-in', render: (u) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : '—') },
          { key: 'x', label: '', render: (u) => canInvite && u.id !== role.user?.id && (role.manage || u.role === 'corporate_hr') && (
            <button className="btn sm secondary" disabled={act.busy} onClick={() => act.run(async () => { await api.patch(`/corporate/employers/${employer.id}/users/${u.id}`, { active: !u.active }); res.reload(); }, u.active ? 'User disabled and signed out' : 'User re-enabled')}>{u.active ? 'Disable' : 'Enable'}</button>
          ) },
        ]} />
      )}
      <Modal open={open} title={`Invite a user to ${employer.name}`} onClose={() => setOpen(false)}>
        <div className="form-grid">
          <Field label="First name" error={fe.firstName}><input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
          <Field label="Last name" error={fe.lastName}><input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
          <Field label="Work email" error={fe.email} className="full"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role" error={fe.role}><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
        </div>
        <p className="muted" style={{ fontSize: '.85rem' }}>The invitee receives a 72-hour link to set their password. Corporate users only ever see this employer's data.</p>
        <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post(`/corporate/employers/${employer.id}/users`, f); setToken(r.devInviteToken || null); setOpen(false); setF({ firstName: '', lastName: '', email: '', role: roles[roles.length - 1] }); res.reload(); }, 'Invitation sent')}>Send invitation</button></div>
      </Modal>
    </Card>
  );
}

function Contracts({ employer, reload }) {
  const role = useCorpRole();
  const meta = useMeta();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ startDate: '', endDate: '', services: ['group_health'], fee: '', paymentTermsDays: '30', signed: true, notes: '' });
  const act = useAction();
  const fe = act.error?.fields || {};
  const toggle = (s) => setF({ ...f, services: f.services.includes(s) ? f.services.filter((x) => x !== s) : [...f.services, s] });
  return (
    <>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Card title="Corporate contracts" actions={role.manage && <button className="btn sm" onClick={() => setOpen(true)}>New contract</button>}>
        <Table rows={employer.contracts} empty="No contracts yet." columns={[
          { key: 'contractNumber', label: 'Contract' }, { key: 'period', label: 'Period', render: (c) => `${date(c.startDate)} – ${date(c.endDate)}` },
          { key: 'services', label: 'Services', render: (c) => c.services.map(titleCase).join(', ') },
          { key: 'fee', label: 'Service fee', render: (c) => (c.serviceFeePerMemberMonth ? `${money(c.serviceFeePerMemberMonth)} / member / month` : 'None') },
          { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
          { key: 'x', label: '', render: (c) => role.manage && c.status !== 'Ended' && (
            <div className="corp-actions">
              {c.status === 'Draft' && <button className="btn sm" onClick={() => act.run(async () => { await api.post(`/corporate/contracts/${c.id}/status`, { status: 'Active' }); reload(); }, 'Contract signed')}>Mark signed</button>}
              <button className="btn sm ghost" onClick={() => window.confirm('End this contract?') && act.run(async () => { await api.post(`/corporate/contracts/${c.id}/status`, { status: 'Ended' }); reload(); }, 'Contract ended')}>End</button>
            </div>
          ) },
        ]} />
      </Card>
      <Card title="Quotations">
        {employer.quotes.length === 0 ? <p className="muted">No quotations yet. Create one from Group policies → New quotation.</p> : employer.quotes.map((q) => <QuoteView key={q.id} q={q} />)}
      </Card>
      <Modal open={open} title="New corporate contract" onClose={() => setOpen(false)}>
        <div className="form-grid">
          <Field label="Start" error={fe.startDate}><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
          <Field label="End" error={fe.endDate}><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          <fieldset className="full" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: '.9rem' }}>Contracted services</legend>
            <div className="row">{(meta.data?.contractServices || []).map((s) => <label key={s} className="corp-check"><input type="checkbox" checked={f.services.includes(s)} onChange={() => toggle(s)} /> {titleCase(s)}</label>)}</div>
            {fe.services && <span className="field-error">{fe.services}</span>}
          </fieldset>
          <Field label="Service fee per member per month (₹)" hint="VHC income; leave blank for none" error={fe.serviceFeePerMemberMonth}><input inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></Field>
          <Field label="Payment terms (days)" error={fe.paymentTermsDays}><input type="number" min="0" max="120" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></Field>
          <label className="corp-check full"><input type="checkbox" checked={f.signed} onChange={(e) => setF({ ...f, signed: e.target.checked })} /> Signed by both parties (contract becomes Active)</label>
        </div>
        <div className="row end" style={{ marginTop: '.75rem' }}>
          <button className="btn" disabled={act.busy} onClick={() => act.run(async () => {
            const fee = f.fee ? toPaise(f.fee) : 0;
            await api.post(`/corporate/employers/${employer.id}/contracts`, { ...f, serviceFeePerMemberMonth: fee ?? -1, paymentTermsDays: Number(f.paymentTermsDays) });
            setOpen(false); reload();
          }, 'Contract created')}>Create contract</button>
        </div>
      </Modal>
    </>
  );
}

function EmployerAnalytics({ employerId }) {
  const res = useLoad(() => api.get(`/corporate/analytics?employerId=${employerId}`), [employerId]);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return <Card title="Employer analytics"><AnalyticsTable rows={res.data.rows} /></Card>;
}

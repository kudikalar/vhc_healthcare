import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { date, dateTime, ROLE_LABEL, titleCase } from '../../format.js';
import { Alert, Badge, Card, DevHint, ErrorBox, Field, Loading, Modal, PageHeader, Table, useAction, useLoad } from '../../components/ui.jsx';
import { Reconciliation } from '../staff/StaffOps.jsx';

export function PlanConfig() {
  const res = useLoad(() => api.get('/admin/plans'));
  const [sel, setSel] = useState(null);
  const [json, setJson] = useState('');
  const [meta, setMeta] = useState({ name: '', description: '', changeNote: '' });
  const [creating, setCreating] = useState(false);
  const act = useAction();
  const plan = res.data?.find((p) => p.id === sel);
  useEffect(() => {
    if (plan) { setJson(JSON.stringify(plan.config, null, 2)); setMeta({ name: plan.name, description: plan.description, changeNote: '' }); }
  }, [plan?.id, plan?.version]); // eslint-disable-line
  if (res.loading) return <Loading />;
  const parse = () => { try { return JSON.parse(json); } catch (e) { throw new Error(`Configuration is not valid JSON: ${e.message}`); } };
  const run = (fn, msg) => act.run(async () => { await fn(); await res.reload(); }, msg);
  return (
    <>
      <PageHeader title="Plan & rate configuration" subtitle="Saving creates a new version. Issued policies keep the terms they were bought with." actions={<button className="btn" onClick={() => { setCreating(true); setSel(null); setJson(JSON.stringify(res.data[0].config, null, 2)); setMeta({ name: '', description: '', code: '', product: res.data[0].product, type: res.data[0].type }); }}>New plan</button>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Card>
        <Table rows={res.data} onRowClick={(p) => { setSel(p.id); setCreating(false); }} columns={[
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'product', label: 'Product', render: (p) => titleCase(p.product) },
          { key: 'type', label: 'Type', render: (p) => titleCase(p.type) }, { key: 'version', label: 'Version', num: true },
          { key: 'active', label: 'Status', render: (p) => <Badge kind={p.active ? 'ok' : 'error'}>{p.active ? 'Active' : 'Inactive'}</Badge> },
          { key: 'x', label: '', render: (p) => <button className="btn sm secondary" onClick={(e) => { e.stopPropagation(); run(() => api.patch(`/admin/plans/${p.id}/status`, { active: !p.active }), p.active ? 'Plan deactivated' : 'Plan activated'); }}>{p.active ? 'Deactivate' : 'Activate'}</button> },
        ]} />
      </Card>
      {(plan || creating) && (
        <Card title={creating ? 'New plan' : `${plan.name} — editing creates version ${plan.version + 1}`}>
          <div className="form-grid">
            {creating && (
              <>
                <Field label="Code"><input value={meta.code} onChange={(e) => setMeta({ ...meta, code: e.target.value })} /></Field>
                <Field label="Product"><select value={meta.product} onChange={(e) => setMeta({ ...meta, product: e.target.value })}><option value="health">Health</option><option value="life">Life</option></select></Field>
                <Field label="Type"><select value={meta.type} onChange={(e) => setMeta({ ...meta, type: e.target.value })}><option value="individual">Individual</option><option value="floater">Family floater</option><option value="senior">Senior</option><option value="term">Term life</option></select></Field>
              </>
            )}
            <Field label="Name"><input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></Field>
            <Field label="Description" className="full"><input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field>
            {!creating && <Field label="Change note"><input value={meta.changeNote} onChange={(e) => setMeta({ ...meta, changeNote: e.target.value })} /></Field>}
            <Field label="Configuration (JSON) — amounts in paise, percentages in basis points" className="full">
              <textarea style={{ minHeight: 380, fontFamily: 'Consolas, monospace', fontSize: '.82rem' }} value={json} onChange={(e) => setJson(e.target.value)} />
            </Field>
          </div>
          <div className="row" style={{ marginTop: '.75rem' }}>
            <button className="btn" disabled={act.busy} onClick={() => run(async () => {
              const config = parse();
              if (creating) { const p = await api.post('/admin/plans', { ...meta, config }); setCreating(false); setSel(p.id); }
              else await api.put(`/admin/plans/${plan.id}`, { name: meta.name, description: meta.description, changeNote: meta.changeNote, config });
            }, creating ? 'Plan created' : 'New version saved')}>{creating ? 'Create plan' : 'Save as new version'}</button>
          </div>
          {plan && (
            <>
              <hr />
              <h4>Version history</h4>
              <Table rows={plan.history} rowKey="version" columns={[{ key: 'version', label: 'Version' }, { key: 'createdAt', label: 'Created', render: (v) => dateTime(v.createdAt) }, { key: 'createdBy', label: 'By' }, { key: 'changeNote', label: 'Note' }]} />
            </>
          )}
        </Card>
      )}
    </>
  );
}

const blankHospital = { name: '', address: '', city: '', state: '', postalCode: '', phone: '', email: '', specialties: '', network: true, active: true };

export function HospitalAdmin() {
  const res = useLoad(() => api.get('/hospitals?includeInactive=true'));
  const [edit, setEdit] = useState(null);
  const act = useAction();
  const save = () => act.run(async () => {
    const body = { ...edit, specialties: typeof edit.specialties === 'string' ? edit.specialties : edit.specialties.join(', ') };
    if (edit.id) await api.put(`/hospitals/${edit.id}`, body); else await api.post('/hospitals', body);
    setEdit(null);
    res.reload();
  }, 'Saved');
  return (
    <>
      <PageHeader title="Hospital management" actions={<button className="btn" onClick={() => setEdit({ ...blankHospital })}>Add hospital</button>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data.hospitals} onRowClick={(h) => setEdit({ ...h, specialties: h.specialties.join(', ') })} columns={[
            { key: 'name', label: 'Hospital' }, { key: 'city', label: 'City' }, { key: 'postalCode', label: 'Postal code' },
            { key: 'specialties', label: 'Specialties', render: (h) => h.specialties.join(', ') },
            { key: 'network', label: 'Network', render: (h) => <Badge kind={h.network ? 'ok' : ''}>{h.network ? 'Network' : 'Non-network'}</Badge> },
            { key: 'active', label: 'Status', render: (h) => <Badge kind={h.active ? 'ok' : 'error'}>{h.active ? 'Active' : 'Deactivated'}</Badge> },
          ]} />
        )}
      </Card>
      <Modal open={!!edit} title={edit?.id ? 'Edit hospital' : 'Add hospital'} onClose={() => setEdit(null)}>
        {edit && (
          <div className="form-grid">
            {['name', 'address', 'city', 'state', 'postalCode', 'phone', 'email'].map((k) => <Field key={k} label={titleCase(k.replace('postalCode', 'postal_code'))}><input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}
            <Field label="Specialties (comma separated)" className="full"><input value={edit.specialties} onChange={(e) => setEdit({ ...edit, specialties: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={edit.network} onChange={(e) => setEdit({ ...edit, network: e.target.checked })} /> Network hospital (cashless)</label>
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
          </div>
        )}
        <ErrorBox error={act.error} />
        <div className="row end" style={{ marginTop: '1rem' }}><button className="btn" disabled={act.busy} onClick={save}>Save</button></div>
      </Modal>
    </>
  );
}

export function UserAdmin() {
  const res = useLoad(() => api.get('/admin/users'));
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', role: 'agent' });
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState(null);
  const act = useAction();
  const run = (fn, msg) => act.run(async () => { await fn(); res.reload(); }, msg);
  const fe = act.error?.fields || {};
  return (
    <>
      <PageHeader title="Users & roles" subtitle="Staff join by invitation only; customers register themselves." actions={<button className="btn" onClick={() => { setOpen(true); setInvite(null); }}>Invite staff user</button>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      {invite && <DevHint>invitation emails are simulated. Invite link: <a href={`/accept-invite?token=${invite}`}>/accept-invite?token=…</a></DevHint>}
      <ErrorBox error={act.error} />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} columns={[
            { key: 'name', label: 'Name', render: (u) => <>{u.name}{u.customerId && <div className="muted">{u.customerId}</div>}</> }, { key: 'email', label: 'Email' },
            { key: 'role', label: 'Role', render: (u) => (u.role === 'customer' ? ROLE_LABEL.customer : (
              <select value={u.role} onChange={(e) => run(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }), 'Role updated — the user must sign in again')} style={{ maxWidth: 180 }}>
                {['agent', 'underwriter', 'claims_officer', 'admin'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            )) },
            { key: 'status', label: 'Status', render: (u) => <Badge>{u.status}</Badge> },
            { key: 'verified', label: 'Contacts', render: (u) => <small>{u.emailVerified ? '✉ ✓' : '✉ –'} {u.mobileVerified ? '📱 ✓' : '📱 –'}</small> },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (u) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : '—') },
            { key: 'x', label: '', render: (u) => <button className="btn sm secondary" onClick={() => run(() => api.patch(`/admin/users/${u.id}`, { active: !u.active }), u.active ? 'User disabled and signed out' : 'User re-enabled')}>{u.active ? 'Disable' : 'Enable'}</button> },
          ]} />
        )}
      </Card>
      <Modal open={open} title="Invite a staff user" onClose={() => setOpen(false)}>
        <div className="form-grid">
          <Field label="First name" error={fe.firstName}><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Last name" error={fe.lastName}><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
          <Field label="Work email" error={fe.email} className="full"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role" error={fe.role}><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['agent', 'underwriter', 'claims_officer', 'admin'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
        </div>
        <p className="muted" style={{ fontSize: '.85rem' }}>The invitee receives a 72-hour link to set their own password. Staff sessions never stay signed in beyond 12 hours.</p>
        <div className="row end"><button className="btn" onClick={() => run(async () => { const r = await api.post('/admin/users', form); setInvite(r.devInviteToken); setOpen(false); }, 'Invitation sent')}>Send invitation</button></div>
      </Modal>
    </>
  );
}

export function NotificationAdmin() {
  const res = useLoad(() => api.get('/admin/notifications'));
  const [f, setF] = useState({ role: 'customer', title: '', message: '' });
  const act = useAction();
  return (
    <>
      <PageHeader title="Notification management" subtitle="In-app notifications; email delivery is simulated." />
      <Card title="Broadcast">
        <div className="form-grid">
          <Field label="Audience"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="customer">All customers</option><option value="agent">Agents</option><option value="underwriter">Underwriters</option><option value="claims_officer">Claims officers</option><option value="all">Everyone</option></select></Field>
          <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message" className="full"><textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        </div>
        <ErrorBox error={act.error} />
        {act.message && <Alert kind="ok">{act.message}</Alert>}
        <button className="btn" style={{ marginTop: '.6rem' }} disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post('/admin/notifications/broadcast', f); res.reload(); return r; }, (r) => `Sent to ${r.sent} recipient(s)`)}>Send</button>
      </Card>
      <Card title="Outbox (latest 300)">
        {res.loading ? <Loading /> : <Table rows={res.data} columns={[{ key: 'createdAt', label: 'When', render: (n) => dateTime(n.createdAt) }, { key: 'recipient', label: 'Recipient' }, { key: 'title', label: 'Title' }, { key: 'message', label: 'Message' }, { key: 'read', label: 'Read', render: (n) => (n.read ? '✓' : '') }]} />}
      </Card>
    </>
  );
}

export function ReportsAudit() {
  const summary = useLoad(() => api.get('/reports/summary'));
  const [filters, setFilters] = useState({ action: '', entityType: '', actor: '' });
  const [q, setQ] = useState(filters);
  const logs = useLoad(() => api.get(`/admin/audit-logs?${new URLSearchParams(q)}`), [JSON.stringify(q)]);
  return (
    <>
      <PageHeader title="Reports & audit logs" />
      {summary.data && (
        <div className="grid grid-2">
          <Reconciliation rec={summary.data.reconciliation} />
          <Card title="Payments by status">
            <Table rows={Object.entries(summary.data.paymentsByStatus).map(([k, v]) => ({ id: k, k, v }))} columns={[{ key: 'k', label: 'Status', render: (x) => <Badge>{x.k}</Badge> }, { key: 'v', label: 'Count', num: true }]} />
          </Card>
        </div>
      )}
      <Card title="Audit log" actions={<small className="muted">Approvals, rejections, financial actions and sensitive document access</small>}>
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); setQ(filters); }}>
          <Field label="Action contains"><input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="e.g. APPROV, PAYMENT, DOCUMENT" /></Field>
          <Field label="Entity type"><select value={filters.entityType} onChange={(e) => setFilters({ ...filters, entityType: e.target.value })}><option value="">All</option>{['application', 'policy', 'payment', 'payout', 'healthClaim', 'lifeClaim', 'user', 'plan', 'hospital', 'exception'].map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Actor"><input value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} /></Field>
          <div className="row" style={{ alignItems: 'flex-end' }}><button className="btn">Filter</button></div>
        </form>
        <div style={{ marginTop: '.75rem' }}>
          {logs.loading ? <Loading /> : <Table rows={logs.data} columns={[
            { key: 'at', label: 'When', render: (l) => dateTime(l.at) }, { key: 'actor', label: 'Actor', render: (l) => <>{l.actorName}<div className="muted">{l.actorRole}</div></> },
            { key: 'action', label: 'Action', render: (l) => <code>{l.action}</code> }, { key: 'entity', label: 'Entity', render: (l) => `${l.entityType || ''} ${l.entityId || ''}` },
            { key: 'details', label: 'Details', render: (l) => <small>{JSON.stringify(l.details)}</small> },
          ]} />}
        </div>
      </Card>
    </>
  );
}

export function DevTools() {
  const clock = useLoad(() => api.get('/dev/clock'));
  const [days, setDays] = useState(30);
  const [setDate, setSetDate] = useState('');
  const act = useAction();
  const run = (fn, msg) => act.run(async () => { const r = await fn(); clock.reload(); window.dispatchEvent(new Event('vhc:clock')); return r; }, msg);
  return (
    <>
      <PageHeader title="Developer tools" subtitle="Development only — disabled when NODE_ENV=production." />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <div className="grid grid-2">
        <Card title="Test clock">
          {clock.data && <p>Application date: <strong>{date(clock.data.today)}</strong> ({clock.data.offsetDays >= 0 ? '+' : ''}{clock.data.offsetDays} days from real time)</p>}
          <div className="row">
            <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 100 }} />
            <button className="btn" onClick={() => run(() => api.post('/dev/clock', { advanceDays: days }), (r) => `Clock moved; jobs: ${JSON.stringify(r.jobs)}`)}>Advance days</button>
          </div>
          <div className="row" style={{ marginTop: '.5rem' }}>
            <input type="date" value={setDate} onChange={(e) => setSetDate(e.target.value)} style={{ maxWidth: 180 }} />
            <button className="btn secondary" disabled={!setDate} onClick={() => run(() => api.post('/dev/clock', { setDate }), 'Clock set')}>Set date</button>
            <button className="btn secondary" onClick={() => run(() => api.post('/dev/clock', { reset: true }), 'Clock reset to real time')}>Reset to real time</button>
          </div>
          <small className="muted">Moving the clock runs scheduled jobs (renewal and premium reminders, grace/lapse notices, auto-pay).</small>
        </Card>
        <Card title="Simulations">
          <p>Auto-pay outcome: <Badge>{clock.data?.autoPayOutcome}</Badge></p>
          <div className="row">
            <button className="btn secondary" onClick={() => run(() => api.post('/dev/autopay-outcome', { outcome: 'success' }), 'Auto-pay will succeed')}>Auto-pay succeeds</button>
            <button className="btn secondary" onClick={() => run(() => api.post('/dev/autopay-outcome', { outcome: 'failure' }), 'Auto-pay will fail')}>Auto-pay fails</button>
            <button className="btn secondary" onClick={() => run(() => api.post('/dev/run-jobs'), (r) => `Jobs ran: ${JSON.stringify(r)}`)}>Run scheduled jobs now</button>
          </div>
        </Card>
        <Card title="Reset database">
          <Alert kind="warn">Deletes all data and uploaded files, then reloads the fictional seed data.</Alert>
          <button className="btn danger" onClick={() => window.confirm('Reset all data?') && run(() => api.post('/dev/reset'), 'Database reset and seeded')}>Reset & reseed</button>
        </Card>
      </div>
    </>
  );
}

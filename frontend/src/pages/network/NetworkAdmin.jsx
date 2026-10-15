// Internal network administration: provider registry & onboarding, contracts, insurer cashless networks,
// TPAs, bookings and provider analytics. admin / operations_admin can change records (contract approval is
// admin-only); compliance_officer and auditor get read-only views.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, pct, titleCase, toPaise } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { BOOKING_STATUS, ContractBadge, NETWORK_STATUS_KIND, PAYER_LABEL, PROVIDER_TYPE_LABEL, StagePipeline, Verified, list } from './common.jsx';

const useRoles = () => {
  const { user } = useAuth();
  return { canWrite: ['admin', 'operations_admin'].includes(user.role), isAdmin: user.role === 'admin', readOnly: ['auditor', 'compliance_officer'].includes(user.role) };
};
const ReadOnlyNote = () => <Alert kind="info">Read-only oversight view. Changes are made by administrators and operations.</Alert>;
const NETWORK_SERVICES = ['inpatient', 'daycare', 'maternity', 'opd', 'diagnostics', 'health_check'];

// ---------------------------------------------------------------------------------------------- providers
export function ProvidersAdmin() {
  const { canWrite, readOnly } = useRoles();
  const nav = useNavigate();
  const [f, setF] = useState({ q: '', stage: '', providerType: '', candidate: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/network/registry?${qs}`), [qs]);
  const [adding, setAdding] = useState(false);
  const [n, setN] = useState({ name: '', providerType: 'hospital', city: '', postalCode: '' });
  const act = useAction();
  const add = () => act.run(async () => { const h = await api.post('/network/registry', n); nav(`/network/providers/${h.id}`); });
  return (
    <>
      <PageHeader title="Provider registry" subtitle="Hospitals, clinics, diagnostic & imaging centres and telehealth providers — onboarding, credentials and verification."
        actions={canWrite && <button className="btn" onClick={() => setAdding(true)}>Add provider</button>} />
      {readOnly && <ReadOnlyNote />}
      <Card>
        <div className="nw-filters">
          <Field label="Search"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
          <Field label="Stage"><select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}><option value="">All</option>{['Prospect', 'Credential Verification', 'Contracting', 'Active', 'Suspended', 'Terminated'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Type"><select value={f.providerType} onChange={(e) => setF({ ...f, providerType: e.target.value })}><option value="">All</option>{Object.entries(PROVIDER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Candidates"><select value={f.candidate} onChange={(e) => setF({ ...f, candidate: e.target.value })}><option value="">Include</option><option value="false">Exclude</option><option value="true">Only candidates</option></select></Field>
        </div>
      </Card>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Card>
          <Table rows={res.data.providers} onRowClick={(h) => nav(`/network/providers/${h.id}`)} columns={[
            { key: 'name', label: 'Provider', render: (h) => <><Link to={`/network/providers/${h.id}`} onClick={(e) => e.stopPropagation()}>{h.name}</Link>{h.candidate && <div className="nw-candidate">{h.candidateLabel}</div>}</> },
            { key: 'providerType', label: 'Type', render: (h) => PROVIDER_TYPE_LABEL[h.providerType] },
            { key: 'city', label: 'City', render: (h) => h.city || '—' },
            { key: 'stage', label: 'Stage', render: (h) => <Badge kind={h.stage === 'Active' ? 'ok' : ['Suspended', 'Terminated'].includes(h.stage) ? 'error' : 'warn'}>{h.stage}</Badge> },
            { key: 'verificationStatus', label: 'Verification', render: (h) => <>{titleCase(h.verificationStatus)}{h.pendingVerification.length > 0 && <div className="nw-meta">Pending: {h.pendingVerification.join(', ')}</div>}</> },
            { key: 'nabh', label: 'NABH', render: (h) => (h.nabh === 'verified' ? <Badge kind="ok">Verified</Badge> : h.nabh === 'claimed' ? <Badge kind="warn">Claimed only</Badge> : '—') },
            { key: 'network', label: 'Sandbox in-patient cashless', render: (h) => (h.network ? 'Yes' : 'No') },
          ]} />
        </Card>
      )}
      <Modal open={adding} title="Add provider (Prospect)" onClose={() => setAdding(false)}>
        <div className="stack">
          <Field label="Name"><input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
          <Field label="Type"><select value={n.providerType} onChange={(e) => setN({ ...n, providerType: e.target.value })}>{Object.entries(PROVIDER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="City"><input value={n.city} onChange={(e) => setN({ ...n, city: e.target.value })} /></Field>
          <Field label="PIN code"><input inputMode="numeric" maxLength={6} value={n.postalCode} onChange={(e) => setN({ ...n, postalCode: e.target.value })} /></Field>
          <p className="nw-note">Use synthetic names in sandbox. Real organisations may only be recorded as candidates with no agreement implied.</p>
          <ErrorBox error={act.error} />
          <div className="row end"><button className="btn" disabled={act.busy || !n.name} onClick={add}>Create</button></div>
        </div>
      </Modal>
    </>
  );
}

function CoreEditor({ h, onClose, onSaved }) {
  const [f, setF] = useState({
    legalName: h.legalName || '', address: h.address || '', city: h.city || '', state: h.state || '', postalCode: h.postalCode || '', lat: h.lat ?? '', lng: h.lng ?? '',
    phone: h.phone || '', email: h.email || '', specialties: (h.specialties || []).join(', '),
    regNumber: h.registration?.number || '', regAuthority: h.registration?.authority || '', regValidTo: h.registration?.validTo || '',
    licences: (h.licences || []).map((l) => ({ ...l })), contactName: h.contacts?.[0]?.name || '', contactEmail: h.contacts?.[0]?.email || '', contactPhone: h.contacts?.[0]?.phone || '',
    integration: h.integration?.status || 'Not started',
  });
  const act = useAction();
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const save = () => act.run(async () => {
    const body = {
      legalName: f.legalName, address: f.address, city: f.city, state: f.state, phone: f.phone, email: f.email, specialties: list(f.specialties),
      registration: { number: f.regNumber, authority: f.regAuthority, validTo: f.regValidTo || null, validFrom: h.registration?.validFrom || null },
      licences: f.licences, contacts: f.contactName ? [{ name: f.contactName, role: 'Primary contact', email: f.contactEmail, phone: f.contactPhone }, ...(h.contacts || []).slice(1)] : h.contacts || [],
      integration: { ...(h.integration || {}), status: f.integration },
    };
    if (f.postalCode) body.postalCode = f.postalCode;
    if (f.lat !== '' && f.lng !== '') Object.assign(body, { lat: Number(f.lat), lng: Number(f.lng) });
    const r = await api.put(`/network/registry/${h.id}`, body);
    onSaved(r.resetToPending);
  });
  const setLic = (i, p) => set({ licences: f.licences.map((l, k) => (k === i ? { ...l, ...p } : l)) });
  return (
    <Modal open large title={`Edit ${h.name}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Legal name" className="full"><input value={f.legalName} onChange={(e) => set({ legalName: e.target.value })} /></Field>
        <Field label="Address" className="full"><input value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="City"><input value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="State"><input value={f.state} onChange={(e) => set({ state: e.target.value })} /></Field>
        <Field label="PIN code"><input value={f.postalCode} onChange={(e) => set({ postalCode: e.target.value })} /></Field>
        <Field label="Latitude"><input value={f.lat} onChange={(e) => set({ lat: e.target.value })} /></Field>
        <Field label="Longitude"><input value={f.lng} onChange={(e) => set({ lng: e.target.value })} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email"><input value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Specialties" className="full"><input value={f.specialties} onChange={(e) => set({ specialties: e.target.value })} /></Field>
        <Field label="Registration no."><input value={f.regNumber} onChange={(e) => set({ regNumber: e.target.value })} /></Field>
        <Field label="Registration authority"><input value={f.regAuthority} onChange={(e) => set({ regAuthority: e.target.value })} /></Field>
        <Field label="Registration valid to"><input type="date" value={f.regValidTo} onChange={(e) => set({ regValidTo: e.target.value })} /></Field>
        <Field label="Primary contact"><input value={f.contactName} onChange={(e) => set({ contactName: e.target.value })} /></Field>
        <Field label="Contact email"><input value={f.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} /></Field>
        <Field label="Contact phone"><input value={f.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} /></Field>
        <Field label="API integration"><select value={f.integration} onChange={(e) => set({ integration: e.target.value })}>{['Not started', 'In progress', 'Testing', 'Live (sandbox)', 'Not applicable'].map((x) => <option key={x}>{x}</option>)}</select></Field>
      </div>
      <h4>Licences</h4>
      {f.licences.map((l, i) => (
        <div key={i} className="nw-row-wrap">
          <Field label="Type"><input value={l.type} onChange={(e) => setLic(i, { type: e.target.value })} /></Field>
          <Field label="Number"><input value={l.number} onChange={(e) => setLic(i, { number: e.target.value })} /></Field>
          <Field label="Authority"><input value={l.authority} onChange={(e) => setLic(i, { authority: e.target.value })} /></Field>
          <Field label="Valid to"><input type="date" value={l.validTo || ''} onChange={(e) => setLic(i, { validTo: e.target.value })} /></Field>
          <button type="button" className="btn sm ghost" onClick={() => set({ licences: f.licences.filter((_, k) => k !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn sm secondary" onClick={() => set({ licences: [...f.licences, { type: '', number: '', authority: '', validTo: '' }] })}>Add licence</button>
      <p className="nw-note">Changing a verified credential resets it to "not verified".</p>
      <ErrorBox error={act.error} />
      <div className="row end"><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={act.busy} onClick={save}>Save</button></div>
    </Modal>
  );
}

export function ProviderAdminDetail() {
  const { id } = useParams();
  const { canWrite, readOnly } = useRoles();
  const res = useLoad(() => api.get(`/network/registry/${id}`), [id]);
  const contracts = useLoad(() => api.get(`/network/contracts?hospitalId=${id}`), [id]);
  const act = useAction();
  const [edit, setEdit] = useState(false);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const h = res.data;
  const verify = (target) => {
    const source = window.prompt('Verification source (e.g. registry lookup reference, inspection report):');
    if (!source) return;
    act.run(() => api.post(`/network/registry/${h.id}/verify`, { target, source }), 'Marked verified').then(() => res.reload());
  };
  const stage = (to) => {
    const note = window.prompt(`Move to ${to}. Note${['Suspended', 'Terminated'].includes(to) ? ' (reason required)' : ' (optional)'}:`);
    if (note === null) return;
    act.run(() => api.post(`/network/registry/${h.id}/stage`, { stage: to, note }), `Moved to ${to}`).then(() => res.reload());
  };
  const V = ({ ok, target, at }) => <><Verified ok={ok} at={at} />{canWrite && !ok && <button className="btn sm ghost" onClick={() => verify(target)}>Verify</button>}</>;
  return (
    <>
      <PageHeader title={h.name} subtitle={`${PROVIDER_TYPE_LABEL[h.providerType] || 'Provider'} · ${h.city || 'location not recorded'}`}
        actions={<>{canWrite && <button className="btn secondary" onClick={() => setEdit(true)}>Edit details</button>}<Link className="btn secondary" to="/network/providers">Back</Link></>} />
      {h.candidate && <Alert kind="warn"><strong>{h.candidateNote || h.candidateLabel}</strong></Alert>}
      {readOnly && <ReadOnlyNote />}
      <Alert kind="ok">{act.message}</Alert><ErrorBox error={act.error} />
      <Card title="Onboarding">
        <StagePipeline stage={h.stage} />
        {Object.entries(h.gaps).map(([to, gaps]) => (
          <div key={to} style={{ marginTop: '.6rem' }}>
            <strong>{to}:</strong> {gaps.length ? <ul className="nw-gaps">{gaps.map((g) => <li key={g}>{g}</li>)}</ul> : <Badge kind="ok">All gates met</Badge>}
          </div>
        ))}
        {canWrite && <div className="row" style={{ marginTop: '.75rem' }}>{h.nextStages.map((s) => <button key={s} className={`btn sm ${['Suspended', 'Terminated'].includes(s) ? 'danger' : ''}`} disabled={act.busy} onClick={() => stage(s)}>Move to {s}</button>)}</div>}
        <h4>History</h4>
        <Timeline items={(h.onboarding?.history || []).map((x) => ({ ...x, by: x.by }))} />
      </Card>
      <div className="grid grid-2">
        <Card title="Credentials">
          <KV items={[
            ['Legal name', h.legalName || '—'],
            ['Registration', <>{h.registration?.number || '—'} {h.registration?.authority && `(${h.registration.authority})`} <V ok={h.registration?.verified} at={h.registration?.verifiedAt} target="registration" /></>],
            ...(h.licences || []).map((l, i) => [`Licence ${i + 1}`, <>{l.type} {l.number}, to {date(l.validTo)} <V ok={l.verified} at={l.verifiedAt} target={`licence:${i}`} /></>]),
            ...(h.accreditations || []).map((a, i) => [a.body, <>{a.certificateNo || 'claimed'} to {date(a.validTo)} <V ok={a.verified} at={a.verifiedAt} target={`accreditation:${i}`} /></>]),
            ['Beds', h.bedCapacity ? <>{h.bedCapacity.total} <V ok={h.bedCapacity.verified} target="bedCapacity" /></> : '—'],
            ['ICU', h.icu?.available ? <>{h.icu.beds} beds <V ok={h.icu.verified} target="icu" /></> : 'No'],
            ['Emergency', h.emergency?.available ? <>{h.emergency.hours} <V ok={h.emergency.verified} target="emergency" /></> : 'No'],
          ]} />
          {h.pendingVerification?.length > 0 && <Alert kind="warn">Pending re-verification: {h.pendingVerification.join(', ')}</Alert>}
        </Card>
        <Card title="Profile">
          <KV items={[
            ['Address', [h.address, h.city, h.state, h.postalCode].filter(Boolean).join(', ') || '—'], ['Location', h.lat != null ? `${h.lat}, ${h.lng}` : '—'],
            ['Contacts', (h.contacts || []).map((c) => `${c.name} (${c.role}) ${c.email}`).join('; ') || '—'],
            ['Insurance desk', h.insuranceDesk ? `${h.insuranceDesk.phone} · ${h.insuranceDesk.email}` : '—'],
            ['Specialties', (h.specialties || []).join(', ') || '—'], ['Services', (h.supportedServices || []).join(', ') || '—'],
            ['Branches', (h.branches || []).map((b) => b.name).join(', ') || '—'], ['Quality records', (h.qualityRecords || []).map((q) => `${q.type}: ${q.outcome}`).join('; ') || '—'],
            ['API integration', h.integration?.status], ['Directions', <a key="d" href={h.directionsUrl} target="_blank" rel="noopener noreferrer">Google Maps</a>],
          ]} />
        </Card>
        <Card title="Insurer cashless network records" actions={<Link className="btn sm secondary" to={`/network/cashless?hospitalId=${h.id}`}>Manage</Link>}>
          <Table rows={h.networkRecords} empty="No insurer network records — this provider is not cashless with any insurer." columns={[
            { key: 'insurerName', label: 'Insurer' }, { key: 'scope', label: 'Products', render: (n) => (n.scope === 'all_products' ? 'All' : n.planNames.join(', ')) },
            { key: 'status', label: 'Status', render: (n) => <Badge kind={n.expired ? 'error' : NETWORK_STATUS_KIND[n.status]}>{n.expired ? 'Expired' : n.status}</Badge> },
            { key: 'dates', label: 'Effective', render: (n) => `${date(n.effectiveFrom)} – ${n.effectiveTo ? date(n.effectiveTo) : 'open'}` },
          ]} />
        </Card>
        <Card title="Contracts" actions={canWrite && <Link className="btn sm secondary" to={`/network/contracts?new=${h.id}`}>New contract</Link>}>
          {contracts.loading ? <Loading /> : contracts.error ? <ErrorBox error={contracts.error} /> : (
            <Table rows={contracts.data} empty="No contracts." columns={[
              { key: 'reference', label: 'Reference', render: (c) => <Link to={`/network/contracts/${c.id}`}>{c.reference}</Link> },
              { key: 'status', label: 'Status', render: (c) => <ContractBadge status={c.status} /> },
              { key: 'dates', label: 'Term', render: (c) => `${date(c.effectiveFrom)} – ${date(c.effectiveTo)}` },
            ]} />
          )}
        </Card>
      </div>
      {edit && <CoreEditor h={h} onClose={() => setEdit(false)} onSaved={(p) => { setEdit(false); act.setMessage(p?.length ? `Saved; reset to pending: ${p.join(', ')}` : 'Saved'); res.reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- contracts
function ContractForm({ initial, providers, onClose, onSaved, amend }) {
  const [f, setF] = useState({
    hospitalId: initial?.hospitalId || '', title: initial?.title || '', effectiveFrom: initial?.effectiveFrom || '', effectiveTo: initial?.effectiveTo || '',
    serviceScope: (initial?.serviceScope || []).join(', '), referralRestrictions: initial?.referralRestrictions || '', qualityObligations: (initial?.qualityObligations || []).join(', '),
    creditDays: initial?.paymentObligations?.creditDays ?? 30, billingCycle: initial?.paymentObligations?.billingCycle || 'monthly', summary: initial?.terms?.summary || '',
    rates: (initial?.packageRates || []).map((r) => ({ ...r, rupees: String(r.amount / 100) })), note: '',
  });
  const act = useAction();
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const save = () => act.run(async () => {
    const packageRates = f.rates.filter((r) => r.name).map((r) => {
      const amount = toPaise(r.rupees);
      if (amount == null) throw new Error(`Enter a valid rate for ${r.name}`);
      return { code: r.code, name: r.name, amount, inclusions: r.inclusions };
    });
    const body = {
      title: f.title || undefined, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo, serviceScope: list(f.serviceScope), referralRestrictions: f.referralRestrictions,
      qualityObligations: list(f.qualityObligations), paymentObligations: { creditDays: Number(f.creditDays), billingCycle: f.billingCycle }, terms: { ...(initial?.terms || {}), summary: f.summary }, packageRates,
    };
    let r;
    if (amend) r = await api.post(`/network/contracts/${initial.id}/amendments`, { changes: body, note: f.note });
    else if (initial?.id) r = await api.put(`/network/contracts/${initial.id}`, body);
    else r = await api.post('/network/contracts', { ...body, hospitalId: f.hospitalId });
    onSaved(r);
  });
  const setRate = (i, p) => set({ rates: f.rates.map((r, k) => (k === i ? { ...r, ...p } : r)) });
  return (
    <Modal open large title={amend ? `Propose amendment to ${initial.reference}` : initial?.id ? `Edit draft ${initial.reference}` : 'New provider contract'} onClose={onClose}>
      <Alert kind="info">A VHC provider contract never creates cashless eligibility with an insurer. Package rates are synthetic sandbox values.</Alert>
      <div className="form-grid">
        {!initial?.id && (
          <Field label="Provider" className="full">
            <select value={f.hospitalId} onChange={(e) => set({ hospitalId: e.target.value })}>
              <option value="">— select —</option>
              {providers?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.candidate ? ` — ${p.candidateLabel}` : ''}</option>)}
            </select>
          </Field>
        )}
        <Field label="Title" className="full"><input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Defaults to '<provider> — provider services agreement'" /></Field>
        <Field label="Effective from"><input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} /></Field>
        <Field label="Expires on"><input type="date" value={f.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })} /></Field>
        <Field label="Credit days"><input type="number" min="0" value={f.creditDays} onChange={(e) => set({ creditDays: e.target.value })} /></Field>
        <Field label="Billing cycle"><select value={f.billingCycle} onChange={(e) => set({ billingCycle: e.target.value })}><option>monthly</option><option>fortnightly</option><option>per claim</option></select></Field>
        <Field label="Service scope" hint="Comma-separated" className="full"><input value={f.serviceScope} onChange={(e) => set({ serviceScope: e.target.value })} /></Field>
        <Field label="Quality obligations" hint="Comma-separated" className="full"><input value={f.qualityObligations} onChange={(e) => set({ qualityObligations: e.target.value })} /></Field>
        <Field label="Referral restrictions" className="full"><input value={f.referralRestrictions} onChange={(e) => set({ referralRestrictions: e.target.value })} /></Field>
        <Field label="Terms summary" className="full"><textarea value={f.summary} onChange={(e) => set({ summary: e.target.value })} /></Field>
      </div>
      <h4>Package rates</h4>
      {f.rates.map((r, i) => (
        <div key={i} className="nw-row-wrap">
          <Field label="Code"><input value={r.code || ''} onChange={(e) => setRate(i, { code: e.target.value })} /></Field>
          <Field label="Package"><input value={r.name} onChange={(e) => setRate(i, { name: e.target.value })} /></Field>
          <Field label="Rate (₹)"><input inputMode="decimal" value={r.rupees} onChange={(e) => setRate(i, { rupees: e.target.value })} /></Field>
          <button type="button" className="btn sm ghost" onClick={() => set({ rates: f.rates.filter((_, k) => k !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn sm secondary" onClick={() => set({ rates: [...f.rates, { code: '', name: '', rupees: '' }] })}>Add package rate</button>
      {amend && <Field label="Reason for amendment"><input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>}
      <ErrorBox error={act.error} />
      <div className="row end" style={{ marginTop: '1rem' }}><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={act.busy} onClick={save}>{amend ? 'Propose amendment' : 'Save draft'}</button></div>
    </Modal>
  );
}

export function ContractsAdmin() {
  const { canWrite, readOnly } = useRoles();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const res = useLoad(() => api.get(`/network/contracts${status ? `?status=${status}` : ''}`), [status]);
  const expiring = useLoad(() => api.get('/network/contracts/expiring?days=60'));
  const providers = useLoad(() => (canWrite ? api.get('/network/registry') : Promise.resolve({ providers: [] })));
  const newFor = params.get('new');
  return (
    <>
      <PageHeader title="Provider contracts" subtitle="Drafted by operations, approved by an administrator (maker–checker). Versioned amendments, renewals and terminations."
        actions={canWrite && <button className="btn" onClick={() => setParams({ new: '1' })}>New contract</button>} />
      {readOnly && <ReadOnlyNote />}
      {expiring.data?.length > 0 && (
        <Alert kind="warn"><strong>Expiring within 60 days:</strong> {expiring.data.map((c) => <span key={c.id}> <Link to={`/network/contracts/${c.id}`}>{c.reference}</Link> ({c.hospitalName}, {c.daysToExpiry} days)</span>)}</Alert>
      )}
      <Card actions={<label className="field" style={{ margin: 0 }}><span className="sr-only">Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['draft', 'pending_approval', 'approved', 'active', 'expired', 'terminated', 'rejected'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select></label>} title="Contracts">
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} onRowClick={(c) => nav(`/network/contracts/${c.id}`)} empty="No contracts." columns={[
            { key: 'reference', label: 'Reference', render: (c) => <Link to={`/network/contracts/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.reference}</Link> },
            { key: 'hospitalName', label: 'Provider' }, { key: 'status', label: 'Status', render: (c) => <ContractBadge status={c.status} /> },
            { key: 'term', label: 'Term', render: (c) => `${date(c.effectiveFrom)} – ${date(c.effectiveTo)}` }, { key: 'version', label: 'Ver.', num: true },
            { key: 'pending', label: 'Pending', render: (c) => (c.status === 'pending_approval' ? 'Approval' : c.pendingAmendment ? `Amendment v${c.pendingAmendment.version}` : '—') },
          ]} />
        )}
      </Card>
      {newFor && canWrite && (
        <ContractForm initial={newFor !== '1' ? { hospitalId: newFor } : null} providers={providers.data?.providers} onClose={() => setParams({})} onSaved={(c) => nav(`/network/contracts/${c.id}`)} />
      )}
    </>
  );
}

export function ContractAdminDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { canWrite, isAdmin, readOnly } = useRoles();
  const res = useLoad(() => api.get(`/network/contracts/${id}`), [id]);
  const act = useAction();
  const [form, setForm] = useState(null);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const c = res.data;
  const post = (path, body, msg) => act.run(async () => { const r = await api.post(`/network/contracts/${c.id}/${path}`, body); if (r?.id && r.id !== c.id) nav(`/network/contracts/${r.id}`); else res.setData(r); }, msg);
  const ask = (q, path, key, msg, extra = {}) => { const v = window.prompt(q); if (v) post(path, { [key]: v, ...extra }, msg); };
  const pa = c.pendingAmendment;
  return (
    <>
      <PageHeader title={`${c.reference} — ${c.hospitalName}`} subtitle={c.title} actions={<><ContractBadge status={c.status} /><Link className="btn secondary" to="/network/contracts">Back</Link></>} />
      {readOnly && <ReadOnlyNote />}
      {c.candidateNote && <Alert kind="warn">{c.candidateNote}</Alert>}
      <Alert kind="ok">{act.message}</Alert><ErrorBox error={act.error} />
      <div className="row" style={{ marginBottom: '1rem' }}>
        {canWrite && ['draft', 'rejected'].includes(c.status) && <button className="btn secondary" onClick={() => setForm('edit')}>Edit draft</button>}
        {canWrite && c.status === 'draft' && <button className="btn" disabled={act.busy} onClick={() => post('submit', {}, 'Submitted for approval')}>Submit for approval</button>}
        {isAdmin && c.status === 'pending_approval' && <button className="btn" disabled={act.busy} onClick={() => post('approve', {}, 'Approved')}>Approve</button>}
        {isAdmin && c.status === 'pending_approval' && <button className="btn danger" disabled={act.busy} onClick={() => ask('Reason for rejection:', 'reject', 'reason', 'Rejected')}>Reject</button>}
        {canWrite && ['approved', 'active'].includes(c.status) && !pa && <button className="btn secondary" onClick={() => setForm('amend')}>Propose amendment</button>}
        {canWrite && ['approved', 'active', 'expired'].includes(c.status) && !c.renewedToId && <button className="btn secondary" disabled={act.busy} onClick={() => post('renew', {}, 'Renewal draft created')}>Draft renewal</button>}
        {isAdmin && !['terminated', 'expired', 'rejected'].includes(c.status) && <button className="btn danger" disabled={act.busy} onClick={() => ask('Termination reason (takes effect today unless a later date is set on the contract):', 'terminate', 'reason', 'Terminated')}>Terminate</button>}
        {canWrite && <button className="btn sm ghost" onClick={() => ask('Complaint summary:', 'complaints', 'summary', 'Complaint recorded')}>Log complaint</button>}
      </div>
      {c.status === 'pending_approval' && !isAdmin && <Alert kind="info">Awaiting approval by an administrator other than the submitter.</Alert>}
      {pa && (
        <Alert kind="warn">
          <strong>Amendment v{pa.version} pending</strong> — {pa.note} (proposed by {pa.proposedBy}). Changes: {Object.keys(pa.changes).join(', ')}.
          {isAdmin && <div className="row" style={{ marginTop: '.5rem' }}><button className="btn sm" onClick={() => post(`amendments/${pa.version}/decision`, { decision: 'approve' }, 'Amendment approved')}>Approve amendment</button><button className="btn sm secondary" onClick={() => ask('Reason:', `amendments/${pa.version}/decision`, 'reason', 'Amendment rejected', { decision: 'reject' })}>Reject</button></div>}
        </Alert>
      )}
      <div className="grid grid-2">
        <Card title="Terms">
          <KV items={[
            ['Effective', `${date(c.effectiveFrom)} – ${date(c.effectiveTo)}${c.daysToExpiry != null ? ` (${c.daysToExpiry} days left)` : ''}`], ['Version', c.version],
            ['Facilities', c.facilities.join(', ')], ['Service scope', c.serviceScope.join('; ')],
            ['Payment', `${c.paymentObligations?.creditDays} days credit · ${c.paymentObligations?.billingCycle}${c.paymentObligations?.note ? ` · ${c.paymentObligations.note}` : ''}`],
            ['Referral rules', c.referralRestrictions || '—'], ['Quality obligations', c.qualityObligations.join('; ') || '—'],
            ['Escalation', c.escalation.map((e) => `L${e.level} ${e.name} ${e.email}`).join(' · ') || '—'], ['Summary', c.terms?.summary || '—'],
            ['Drafted by', c.draftedBy?.name], ['Approved by', c.approvedBy ? `${c.approvedBy.name}, ${dateTime(c.approvedBy.at)}` : '—'],
            ['Renewal', c.renewedFromId ? <Link key="f" to={`/network/contracts/${c.renewedFromId}`}>renews earlier contract</Link> : c.renewedToId ? <Link key="t" to={`/network/contracts/${c.renewedToId}`}>renewed by newer contract</Link> : '—'],
            ['Termination', c.termination ? `${date(c.termination.effectiveDate)}: ${c.termination.reason}` : '—'],
          ]} />
        </Card>
        <Card title="Package rates (synthetic)">
          <Table rows={c.packageRates} rowKey="code" empty="No package rates." columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Package' }, { key: 'amount', label: 'Rate', num: true, render: (p) => money(p.amount) }]} />
          <h4>Complaints</h4>
          <Table rows={c.complaints} empty="None." columns={[
            { key: 'at', label: 'Raised', render: (x) => date(x.at) }, { key: 'raisedBy', label: 'By' }, { key: 'summary', label: 'Summary' },
            { key: 'status', label: 'Status', render: (x) => (x.status === 'open' && canWrite ? <button className="btn sm secondary" onClick={() => ask('Resolution:', `complaints/${x.id}/resolve`, 'resolution', 'Complaint resolved')}>Resolve</button> : <Badge>{x.status}</Badge>) },
          ]} />
        </Card>
        <Card title="Approvals & versions">
          <Table rows={c.approvals.map((a, i) => ({ ...a, id: i }))} columns={[{ key: 'step', label: 'Step', render: (a) => titleCase(a.step) }, { key: 'by', label: 'By', render: (a) => `${a.by} (${titleCase(a.role)})` }, { key: 'at', label: 'When', render: (a) => dateTime(a.at) }, { key: 'note', label: 'Note' }]} />
          <Table rows={c.versions.map((v) => ({ ...v, id: v.version }))} empty="No approved versions yet." columns={[{ key: 'version', label: 'Version' }, { key: 'at', label: 'Approved', render: (v) => dateTime(v.at) }, { key: 'note', label: 'Note' }]} />
        </Card>
        <Card title="History"><Timeline items={c.history.map((x) => ({ ...x, status: titleCase(x.status) }))} /></Card>
      </div>
      {form && <ContractForm initial={c} amend={form === 'amend'} onClose={() => setForm(null)} onSaved={(r) => { setForm(null); res.setData(r); act.setMessage(form === 'amend' ? 'Amendment proposed' : 'Draft saved'); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- networks
function NetworkForm({ record, meta, providers, hospitalId, onClose, onSaved }) {
  const [f, setF] = useState(record ? { ...record, planIds: record.planIds || [], services: record.services || [], effectiveTo: record.effectiveTo || '', note: '' } : { insurerId: meta?.insurers[0]?.id || '', hospitalId: hospitalId || '', scope: 'all_products', planIds: [], services: [], status: 'active', effectiveFrom: '', effectiveTo: '', verificationSource: '', publicNote: '', internalNote: '' });
  const act = useAction();
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const insurer = meta?.insurers.find((i) => i.id === f.insurerId);
  const toggle = (key, v) => set({ [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] });
  const save = () => act.run(async () => {
    const body = { insurerId: f.insurerId, hospitalId: f.hospitalId, scope: f.scope, planIds: f.planIds, services: f.services, status: f.status, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null, verificationSource: f.verificationSource, publicNote: f.publicNote, internalNote: f.internalNote, note: f.note };
    onSaved(record ? await api.put(`/network/networks/${record.id}`, body) : await api.post('/network/networks', body));
  });
  return (
    <Modal open large title={record ? `Edit network record — ${record.hospitalName}` : 'New insurer network record'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Insurer"><select value={f.insurerId} disabled={!!record} onChange={(e) => set({ insurerId: e.target.value, planIds: [] })}>{meta?.insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field label="Provider"><select value={f.hospitalId} disabled={!!record} onChange={(e) => set({ hospitalId: e.target.value })}><option value="">— select —</option>{providers?.filter((p) => !p.candidate).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Products"><select value={f.scope} onChange={(e) => set({ scope: e.target.value })}><option value="all_products">All products of this insurer</option><option value="plans">Selected plans only</option></select></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="active">Active (cashless)</option><option value="restricted">Restricted (no cashless)</option><option value="excluded">Excluded by insurer</option></select></Field>
        <Field label="Effective from"><input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} /></Field>
        <Field label="Effective to" hint="Blank = open-ended"><input type="date" value={f.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })} /></Field>
        {f.scope === 'plans' && (
          <fieldset className="full" style={{ border: 0, padding: 0 }}><legend>Plans</legend>
            {insurer?.plans.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={f.planIds.includes(p.id)} onChange={() => toggle('planIds', p.id)} /> {p.name}</label>)}
          </fieldset>
        )}
        <fieldset className="full" style={{ border: 0, padding: 0 }}><legend>Service lines (none ticked = all)</legend>
          <div className="nw-tags">{NETWORK_SERVICES.map((s) => <label key={s} className="check" style={{ marginRight: '.8rem' }}><input type="checkbox" checked={f.services.includes(s)} onChange={() => toggle('services', s)} /> {titleCase(s)}</label>)}</div>
        </fieldset>
        <Field label="Verification source" hint="Sets last-verified when given"><input value={f.verificationSource || ''} onChange={(e) => set({ verificationSource: e.target.value })} /></Field>
        <Field label="Public note"><input value={f.publicNote || ''} onChange={(e) => set({ publicNote: e.target.value })} /></Field>
        <Field label="Internal note" className="full"><input value={f.internalNote || ''} onChange={(e) => set({ internalNote: e.target.value })} /></Field>
        {record && <Field label="Change note" className="full"><input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>}
      </div>
      <ErrorBox error={act.error} />
      <div className="row end"><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={act.busy} onClick={save}>Save</button></div>
    </Modal>
  );
}

export function NetworksAdmin() {
  const { canWrite, readOnly } = useRoles();
  const [params] = useSearchParams();
  const [f, setF] = useState({ hospitalId: params.get('hospitalId') || '', insurerId: '', status: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/network/networks?${qs}`), [qs]);
  const meta = useLoad(() => api.get('/network/directory/meta'));
  const providers = useLoad(() => api.get('/network/registry?candidate=false'));
  const expiring = useLoad(() => api.get('/network/networks/expiring?days=60'));
  const [edit, setEdit] = useState(null);
  const act = useAction();
  const verify = (n) => { const source = window.prompt('Verification source (insurer network file / confirmation reference):'); if (source) act.run(() => api.post(`/network/networks/${n.id}/verify`, { source }), 'Verified').then(() => res.reload()); };
  return (
    <>
      <PageHeader title="Insurer cashless networks" subtitle="Cashless eligibility per insurer × provider × product × service × dates. A VHC contract never implies cashless."
        actions={canWrite && <button className="btn" onClick={() => setEdit({})}>New record</button>} />
      {readOnly && <ReadOnlyNote />}
      <Alert kind="ok">{act.message}</Alert><ErrorBox error={act.error} />
      {expiring.data?.length > 0 && <Alert kind="warn">Expiring within 60 days: {expiring.data.map((n) => `${n.hospitalName} / ${n.insurerName} (${date(n.effectiveTo)})`).join('; ')}</Alert>}
      <Card>
        <div className="nw-filters">
          <Field label="Provider"><select value={f.hospitalId} onChange={(e) => setF({ ...f, hospitalId: e.target.value })}><option value="">All</option>{providers.data?.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Insurer"><select value={f.insurerId} onChange={(e) => setF({ ...f, insurerId: e.target.value })}><option value="">All</option>{meta.data?.insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
          <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option><option>active</option><option>restricted</option><option>excluded</option></select></Field>
        </div>
      </Card>
      <Card>
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No network records." columns={[
            { key: 'hospitalName', label: 'Provider' }, { key: 'insurerName', label: 'Insurer' },
            { key: 'scope', label: 'Products', render: (n) => (n.scope === 'all_products' ? 'All products' : n.planNames.join(', ')) },
            { key: 'services', label: 'Services', render: (n) => (n.services.length ? n.services.map(titleCase).join(', ') : 'All') },
            { key: 'status', label: 'Status', render: (n) => <Badge kind={n.expired ? 'error' : NETWORK_STATUS_KIND[n.status]}>{n.expired ? `${n.status} · expired` : n.inEffect ? n.status : `${n.status} · not yet effective`}</Badge> },
            { key: 'dates', label: 'Effective', render: (n) => `${date(n.effectiveFrom)} – ${n.effectiveTo ? date(n.effectiveTo) : 'open'}` },
            { key: 'verifiedAt', label: 'Last verified', render: (n) => (n.verifiedAt ? <>{date(n.verifiedAt)}<div className="nw-meta">{n.verificationSource}</div></> : 'Never') },
            { key: 'act', label: '', render: (n) => canWrite && <div className="row"><button className="btn sm secondary" onClick={() => setEdit(n)}>Edit</button><button className="btn sm ghost" onClick={() => verify(n)}>Re-verify</button></div> },
          ]} />
        )}
      </Card>
      {edit && <NetworkForm record={edit.id ? edit : null} hospitalId={f.hospitalId} meta={meta.data} providers={providers.data?.providers} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); act.setMessage('Network record saved'); res.reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- TPAs
export function TpasAdmin() {
  const { canWrite, readOnly } = useRoles();
  const res = useLoad(() => api.get('/network/tpas'));
  const meta = useLoad(() => api.get('/network/directory/meta'));
  const act = useAction();
  const [rel, setRel] = useState({ insurerId: '', from: '', to: '', agreementRef: '' });
  const run = (path, body, msg) => act.run(() => api.post(path, body), msg).then(() => res.reload());
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <>
      <PageHeader title="Third-party administrators" subtitle="TPA registry, insurer relationships, servicing contacts and escalations. TPAs recommend; insurers decide." />
      {readOnly && <ReadOnlyNote />}
      <Alert kind="ok">{act.message}</Alert><ErrorBox error={act.error} />
      {res.data.map((t) => (
        <Card key={t.id} title={t.name} actions={<Badge kind={t.status === 'Active' ? 'ok' : 'warn'}>{t.status}</Badge>}>
          <KV items={[
            ['Legal name', t.legalName], ['Registration', `${t.irdai?.registrationNo || '—'}${t.irdai?.verified ? ' (verified)' : ' (synthetic / not verified)'}`],
            ['Administers', t.administeredInsurers.map((i) => i.name).join(', ') || 'None'],
            ['Servicing contacts', (t.servicingContacts || []).map((c) => `${c.name} ${c.email}`).join('; ') || '—'],
            ['Authorised network records', `${t.networkRefs.length} (${t.networkRefs.slice(0, 4).map((n) => n.hospitalName).join(', ')}${t.networkRefs.length > 4 ? '…' : ''})`],
            ['Open escalations', t.openEscalations],
          ]} />
          <h4>Insurer relationships</h4>
          <Table rows={t.relationships || []} empty="None." columns={[
            { key: 'insurerName', label: 'Insurer' }, { key: 'from', label: 'From', render: (r) => date(r.from) }, { key: 'to', label: 'To', render: (r) => (r.to ? date(r.to) : 'Open') },
            { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> }, { key: 'agreementRef', label: 'Agreement' },
            { key: 'act', label: '', render: (r) => canWrite && r.status !== 'ended' && <button className="btn sm ghost" onClick={() => { const reason = window.prompt('Reason for ending this relationship:'); if (reason) run(`/network/tpas/${t.id}/relationships/${r.id}/end`, { reason }, 'Relationship ended'); }}>End</button> },
          ]} />
          {canWrite && (
            <div className="nw-row-wrap" style={{ marginTop: '.5rem' }}>
              <Field label="Insurer"><select value={rel.insurerId} onChange={(e) => setRel({ ...rel, insurerId: e.target.value })}><option value="">— select —</option>{meta.data?.insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
              <Field label="From"><input type="date" value={rel.from} onChange={(e) => setRel({ ...rel, from: e.target.value })} /></Field>
              <Field label="To"><input type="date" value={rel.to} onChange={(e) => setRel({ ...rel, to: e.target.value })} /></Field>
              <Field label="Agreement ref."><input value={rel.agreementRef} onChange={(e) => setRel({ ...rel, agreementRef: e.target.value })} /></Field>
              <button className="btn sm" disabled={act.busy || !rel.insurerId || !rel.from} onClick={() => run(`/network/tpas/${t.id}/relationships`, { ...rel, to: rel.to || null }, 'Relationship added')}>Add relationship</button>
            </div>
          )}
          <h4>Escalation history</h4>
          <Table rows={t.escalations || []} empty="No escalations." columns={[
            { key: 'at', label: 'Raised', render: (e) => date(e.at) }, { key: 'level', label: 'Level' }, { key: 'subject', label: 'Subject' }, { key: 'raisedBy', label: 'By' },
            { key: 'status', label: 'Status', render: (e) => (e.status === 'open' && canWrite ? <button className="btn sm secondary" onClick={() => { const resolution = window.prompt('Resolution:'); if (resolution) run(`/network/tpas/${t.id}/escalations/${e.id}/resolve`, { resolution }, 'Escalation resolved'); }}>Resolve</button> : <Badge>{e.status}</Badge>) },
            { key: 'resolution', label: 'Resolution' },
          ]} />
        </Card>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- bookings & analytics
export function BookingsAdmin() {
  const [status, setStatus] = useState('');
  const res = useLoad(() => api.get(`/network/bookings${status ? `?status=${status}` : ''}`), [status]);
  return (
    <>
      <PageHeader title="Health-service bookings" subtitle="All bookings across providers. Booking fees are synthetic sandbox amounts posted to the healthcare booking fee ledger." />
      <Card actions={<label className="field" style={{ margin: 0 }}><span className="sr-only">Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(BOOKING_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>} title="Bookings">
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No bookings." columns={[
            { key: 'reference', label: 'Reference' }, { key: 'when', label: 'When', render: (b) => `${date(b.date)} ${b.slot}` },
            { key: 'hospitalName', label: 'Provider' }, { key: 'serviceName', label: 'Service' }, { key: 'userName', label: 'Customer' },
            { key: 'payerType', label: 'Payer', render: (b) => PAYER_LABEL[b.payerType] },
            { key: 'fee', label: 'Fee', num: true, render: (b) => `${money(b.bookingFee)} · ${b.payment?.status}` },
            { key: 'status', label: 'Status', render: (b) => <Badge>{BOOKING_STATUS[b.status]}</Badge> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function NetworkAnalytics() {
  const res = useLoad(() => api.get('/network/analytics'));
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const t = res.data.totals;
  return (
    <>
      <PageHeader title="Network analytics" subtitle={`Providers, contracts, services, appointments, pre-auth turnaround and documentation quality · as of ${dateTime(res.data.asOf)}`} />
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <Stat label="Public providers" value={`${t.publicProviders} / ${t.providers}`} />
        <Stat label="Active contracts" value={t.contractsByStatus.active || 0} />
        <Stat label="Appointment completion" value={t.appointments.completionRateBp == null ? '—' : pct(t.appointments.completionRateBp)} />
        <Stat label="Avg pre-auth turnaround" value={t.preauth.avgHours == null ? '—' : `${t.preauth.avgHours} h`} />
      </div>
      <Card title="By provider">
        {res.data.providers.length === 0 ? <Empty>No providers.</Empty> : (
          <Table rows={res.data.providers} columns={[
            { key: 'name', label: 'Provider', render: (p) => <><Link to={`/network/providers/${p.id}`}>{p.name}</Link><div className="nw-meta">{PROVIDER_TYPE_LABEL[p.providerType]} · {p.stage}</div></> },
            { key: 'contract', label: 'Contract', render: (p) => <><ContractBadge status={p.contract.status} />{p.contract.daysToExpiry != null && <div className="nw-meta">{p.contract.daysToExpiry} days left</div>}</> },
            { key: 'services', label: 'Services provided', render: (p) => Object.entries(p.appointments.servicesProvided).map(([k, v]) => `${titleCase(k)}: ${v}`).join(', ') || '—' },
            { key: 'appts', label: 'Appointments (done / total)', num: true, render: (p) => `${p.appointments.completed} / ${p.appointments.total}` },
            { key: 'completion', label: 'Completion', num: true, render: (p) => (p.appointments.completionRateBp == null ? '—' : pct(p.appointments.completionRateBp)) },
            { key: 'preauth', label: 'Pre-auth avg', num: true, render: (p) => (p.preauth.avgHours == null ? '—' : `${p.preauth.avgHours} h (${p.preauth.decided})`) },
            { key: 'docs', label: 'Docs complete first time', num: true, render: (p) => (p.documentation.completeFirstTimeBp == null ? '—' : pct(p.documentation.completeFirstTimeBp)) },
          ]} />
        )}
      </Card>
      <p className="nw-note">Metrics are computed from sandbox bookings and claims. Candidate prospects are excluded.</p>
    </>
  );
}

// Hospital partner portal (/hospital) for hospital_admin and hospital_staff — own hospital only.
// Hospital staff can view and operate appointments; only the hospital administrator edits the profile,
// packages and staff. Changes to verified attributes go back to "pending verification".
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, pct, titleCase, toPaise, toRupeesInput } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { BOOKING_STATUS, ContractBadge, NETWORK_STATUS_KIND, PAYER_LABEL, PROVIDER_TYPE_LABEL, StagePipeline, Verified, list } from './common.jsx';

const TABS = [
  { value: 'overview', label: 'Overview' }, { value: 'appointments', label: 'Appointments' }, { value: 'desk', label: 'Insurance desk' },
  { value: 'packages', label: 'Packages & services' }, { value: 'profile', label: 'Profile & facilities' }, { value: 'contracts', label: 'Contracts' },
  { value: 'staff', label: 'Staff' },
];

function Overview({ base }) {
  const rep = useLoad(() => api.get(`${base}/reports`));
  const nets = useLoad(() => api.get(`${base}/networks`));
  if (rep.loading) return <Loading />;
  if (rep.error) return <ErrorBox error={rep.error} />;
  const a = rep.data.appointments, p = rep.data.preauth, d = rep.data.documentation;
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <Stat label="Upcoming appointments" value={a.upcoming} />
        <Stat label="Appointments completed" value={a.completed} />
        <Stat label="Completion rate" value={a.completionRateBp == null ? '—' : pct(a.completionRateBp)} />
        <Stat label="Pre-auth avg turnaround" value={p.avgHours == null ? '—' : `${p.avgHours} h`} />
      </div>
      <div className="grid grid-2">
        <Card title="Pre-authorisations">
          <KV items={[['Decided', p.decided], ['Awaiting decision', p.pending], ['Approved', p.approved], ['Refused', p.rejected], ['Longest turnaround', p.maxHours == null ? '—' : `${p.maxHours} h`]]} />
        </Card>
        <Card title="Documentation quality">
          <KV items={[['Claims at this hospital', d.claims], ['Needing extra documents', d.claimsWithDocumentRequests], ['Complete first time', d.completeFirstTimeBp == null ? '—' : pct(d.completeFirstTimeBp)], ['Avg documents per claim', d.avgDocumentsPerClaim ?? '—']]} />
        </Card>
        <Card title="Insurer cashless networks">
          {nets.loading ? <Loading /> : nets.error ? <ErrorBox error={nets.error} /> : (
            <Table rows={nets.data} empty="No insurer network records." columns={[
              { key: 'insurerName', label: 'Insurer' },
              { key: 'scope', label: 'Products', render: (n) => (n.scope === 'all_products' ? 'All products' : n.planNames.join(', ')) },
              { key: 'status', label: 'Status', render: (n) => <Badge kind={n.expired ? 'error' : NETWORK_STATUS_KIND[n.status]}>{n.expired ? 'Expired' : titleCase(n.status)}</Badge> },
              { key: 'effectiveTo', label: 'Valid to', render: (n) => (n.effectiveTo ? date(n.effectiveTo) : 'Open') },
              { key: 'verifiedAt', label: 'Last verified', render: (n) => (n.verifiedAt ? date(n.verifiedAt) : '—') },
            ]} />
          )}
          <p className="nw-note">Network status is maintained from each insurer's network file. Contact VHC provider relations to report a discrepancy.</p>
        </Card>
        <Card title="Services provided (completed)">
          <Table rows={Object.entries(a.servicesProvided).map(([k, v]) => ({ id: k, k, v }))} empty="No completed appointments yet." columns={[{ key: 'k', label: 'Service', render: (r) => titleCase(r.k) }, { key: 'v', label: 'Completed', num: true }]} />
        </Card>
      </div>
    </>
  );
}

function AppointmentsTab({ base }) {
  const [status, setStatus] = useState('confirmed');
  const res = useLoad(() => api.get(`${base}/bookings${status ? `?status=${status}` : ''}`), [status]);
  const act = useAction();
  const complete = (b, outcome) => act.run(() => api.post(`${base}/bookings/${b.id}/complete`, { outcome }), outcome === 'completed' ? 'Marked completed' : 'Marked no-show').then(() => res.reload());
  const cancel = (b) => {
    const reason = window.prompt('Reason for cancelling this appointment (the patient is notified and the booking fee refunded):');
    if (!reason) return;
    act.run(() => api.post(`${base}/bookings/${b.id}/cancel`, { reason }), 'Appointment cancelled').then(() => res.reload());
  };
  return (
    <Card title="Appointments" actions={
      <label className="field" style={{ margin: 0 }}><span className="sr-only">Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(BOOKING_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>}>
      <Alert kind="ok">{act.message}</Alert><ErrorBox error={act.error} />
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Table rows={res.data} empty="No appointments." columns={[
          { key: 'when', label: 'When', render: (b) => <>{date(b.date)} {b.slot}<div className="nw-meta">{b.reference}</div></> },
          { key: 'serviceName', label: 'Service' },
          { key: 'patientName', label: 'Patient' },
          { key: 'payer', label: 'Payer', render: (b) => <>{PAYER_LABEL[b.payerType]}{b.payerType === 'insured_cashless' && <div className="nw-meta">{b.policyNumber} — insurer authorisation required</div>}</> },
          { key: 'status', label: 'Status', render: (b) => <Badge>{BOOKING_STATUS[b.status]}</Badge> },
          { key: 'actions', label: '', render: (b) => b.status === 'confirmed' && (
            <div className="row">
              <button className="btn sm" disabled={act.busy} onClick={() => complete(b, 'completed')}>Complete</button>
              <button className="btn sm secondary" disabled={act.busy} onClick={() => complete(b, 'no_show')}>No-show</button>
              <button className="btn sm ghost" disabled={act.busy} onClick={() => cancel(b)}>Cancel</button>
            </div>
          ) },
        ]} />
      )}
    </Card>
  );
}

function DeskTab({ base }) {
  const res = useLoad(() => api.get(`${base}/claims`));
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <Card title="Insurance desk — claims at this hospital">
      <Alert kind="info">{res.data.note}</Alert>
      <Table rows={res.data.claims} empty="No claims at this hospital yet." columns={[
        { key: 'claimNumber', label: 'Claim no.', render: (c) => <>{c.claimNumber}<div className="nw-meta">{titleCase(c.type)}</div></> },
        { key: 'memberFirstName', label: 'Member' },
        { key: 'admissionDate', label: 'Admission', render: (c) => date(c.admissionDate) },
        { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
        { key: 'preauth', label: 'Pre-auth', render: (c) => (c.preauth ? <>{titleCase(c.preauth.decision)}{c.preauth.amount != null && ` · ${money(c.preauth.amount)}`}{c.preauth.provisional && <div className="nw-meta">Provisional</div>}</> : c.type === 'cashless' ? 'Awaiting' : '—') },
        { key: 'times', label: 'Requested / updated', render: (c) => <span className="nw-meta">{dateTime(c.createdAt)}<br />{dateTime(c.updatedAt)}</span> },
      ]} />
    </Card>
  );
}

const CATEGORY_OPTIONS = ['doctor_consultation', 'specialist_consultation', 'preventive_health_check', 'diagnostic_lab', 'imaging', 'teleconsultation', 'home_sample_collection', 'vaccination', 'follow_up'];

function ServiceEditor({ base, svc, onClose, onSaved }) {
  const [f, setF] = useState(svc ? { ...svc, price: toRupeesInput(svc.price), discountedPrice: toRupeesInput(svc.discountedPrice), inclusions: (svc.inclusions || []).join(', '), ...svc.schedule } : { category: 'preventive_health_check', name: '', description: '', price: '', discountedPrice: '', inclusions: '', start: '09:00', end: '13:00', intervalMin: 30, capacity: 2, active: true });
  const act = useAction();
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const save = () => act.run(async () => {
    const price = toPaise(f.price);
    const disc = f.discountedPrice === '' ? null : toPaise(f.discountedPrice);
    if (price == null || (f.discountedPrice !== '' && disc == null)) throw new Error('Enter prices in rupees, e.g. 1499 or 1499.50');
    const body = { category: f.category, name: f.name, description: f.description, price, discountedPrice: disc, inclusions: list(f.inclusions), active: f.active, schedule: { start: f.start, end: f.end, intervalMin: Number(f.intervalMin), capacity: Number(f.capacity), days: svc?.schedule?.days || [1, 2, 3, 4, 5, 6] } };
    if (svc) await api.put(`${base}/services/${svc.id}`, body); else await api.post(`${base}/services`, body);
    onSaved();
  });
  return (
    <Modal open title={svc ? `Edit ${svc.name}` : 'New service / package'} onClose={onClose} large>
      <div className="form-grid">
        <Field label="Type"><select value={f.category} onChange={(e) => set({ category: e.target.value })}>{CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</select></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Price (₹, synthetic)"><input inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} /></Field>
        <Field label="Discounted price (₹)" hint="Optional VHC discounted rate"><input inputMode="decimal" value={f.discountedPrice} onChange={(e) => set({ discountedPrice: e.target.value })} /></Field>
        <Field label="Inclusions" hint="Comma-separated" className="full"><input value={f.inclusions} onChange={(e) => set({ inclusions: e.target.value })} /></Field>
        <Field label="Description" className="full"><textarea value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="Slots from"><input type="time" value={f.start} onChange={(e) => set({ start: e.target.value })} /></Field>
        <Field label="Slots until"><input type="time" value={f.end} onChange={(e) => set({ end: e.target.value })} /></Field>
        <Field label="Slot length (min)"><input type="number" min="10" max="240" value={f.intervalMin} onChange={(e) => set({ intervalMin: e.target.value })} /></Field>
        <Field label="Patients per slot"><input type="number" min="1" max="50" value={f.capacity} onChange={(e) => set({ capacity: e.target.value })} /></Field>
        <label className="check full"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> Bookable (active)</label>
      </div>
      <ErrorBox error={act.error} />
      <div className="row end"><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={act.busy} onClick={save}>Save</button></div>
    </Modal>
  );
}

function PackagesTab({ base, isAdmin }) {
  const res = useLoad(() => api.get(`${base}/services`));
  const [edit, setEdit] = useState(null);
  return (
    <Card title="Packages & bookable services" actions={isAdmin && <button className="btn sm" onClick={() => setEdit({})}>Add service</button>}>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Table rows={res.data} empty="No services listed yet." columns={[
          { key: 'name', label: 'Service', render: (x) => <>{x.name}<div className="nw-meta">{x.categoryLabel}{x.inclusions?.length ? ` · ${x.inclusions.join(', ')}` : ''}</div></> },
          { key: 'price', label: 'Price', num: true, render: (x) => <>{money(x.price)}{x.discountedPrice != null && <div className="nw-meta">Disc. {money(x.discountedPrice)}</div>}</> },
          { key: 'schedule', label: 'Slots', render: (x) => `${x.schedule.start}–${x.schedule.end}, ${x.schedule.intervalMin} min × ${x.schedule.capacity}` },
          { key: 'active', label: 'Status', render: (x) => <Badge kind={x.active ? 'ok' : ''}>{x.active ? 'Active' : 'Inactive'}</Badge> },
          { key: 'edit', label: '', render: (x) => isAdmin && <button className="btn sm secondary" onClick={() => setEdit(x)}>Edit</button> },
        ]} />
      )}
      {!isAdmin && <p className="nw-note">Only the hospital administrator can change packages and prices.</p>}
      {edit && <ServiceEditor base={base} svc={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload(); }} />}
    </Card>
  );
}

function ProfileEditor({ base, h, onClose, onSaved }) {
  const nabh = (h.accreditations || []).find((a) => a.body === 'NABH');
  const [f, setF] = useState({
    phone: h.phone || '', email: h.email || '', specialties: (h.specialties || []).join(', '), diagnostics: (h.diagnostics || []).join(', '), supportedServices: (h.supportedServices || []).join(', '),
    deskName: h.insuranceDesk?.name || '', deskPhone: h.insuranceDesk?.phone || '', deskEmail: h.insuranceDesk?.email || '', deskHours: h.insuranceDesk?.hours || '',
    emergency: !!h.emergency?.available, emergencyHours: h.emergency?.hours || '', icu: !!h.icu?.available, icuBeds: h.icu?.beds ?? 0, beds: h.bedCapacity?.total ?? '',
    nabhClaim: !!nabh, nabhCert: nabh?.certificateNo || '', nabhValidTo: nabh?.validTo || '',
    branches: (h.branches || []).map((b) => ({ ...b, facilities: (b.facilities || []).join(', ') })),
  });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const act = useAction();
  const save = () => act.run(async () => {
    const others = (h.accreditations || []).filter((a) => a.body !== 'NABH');
    const body = {
      phone: f.phone, email: f.email, specialties: list(f.specialties), diagnostics: list(f.diagnostics), supportedServices: list(f.supportedServices),
      insuranceDesk: { name: f.deskName, phone: f.deskPhone, email: f.deskEmail, hours: f.deskHours },
      emergency: { available: f.emergency, hours: f.emergencyHours }, icu: { available: f.icu, beds: Number(f.icuBeds) || 0 },
      accreditations: [...others, ...(f.nabhClaim ? [{ body: 'NABH', level: nabh?.level, certificateNo: f.nabhCert, validTo: f.nabhValidTo || null }] : [])],
      branches: f.branches.map((b) => ({ ...b, facilities: list(b.facilities) })),
    };
    if (f.beds !== '' && Number(f.beds) !== h.bedCapacity?.total) body.bedCapacity = { total: Number(f.beds) };
    const r = await api.put(`${base}/profile`, body);
    onSaved(r.resetToPending);
  });
  const setBranch = (i, p) => set({ branches: f.branches.map((b, k) => (k === i ? { ...b, ...p } : b)) });
  return (
    <Modal open title="Edit hospital profile" onClose={onClose} large>
      <Alert kind="warn">Changing registration, licences, accreditation, beds, ICU or emergency details sends them back to VHC for verification. Unverified details are not shown to the public as verified.</Alert>
      <div className="form-grid">
        <Field label="Main phone"><input value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Main email"><input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Specialties" hint="Comma-separated" className="full"><input value={f.specialties} onChange={(e) => set({ specialties: e.target.value })} /></Field>
        <Field label="Diagnostics" hint="Comma-separated"><input value={f.diagnostics} onChange={(e) => set({ diagnostics: e.target.value })} /></Field>
        <Field label="Supported services" hint="Comma-separated"><input value={f.supportedServices} onChange={(e) => set({ supportedServices: e.target.value })} /></Field>
        <Field label="Insurance desk name"><input value={f.deskName} onChange={(e) => set({ deskName: e.target.value })} /></Field>
        <Field label="Insurance desk phone"><input value={f.deskPhone} onChange={(e) => set({ deskPhone: e.target.value })} /></Field>
        <Field label="Insurance desk email"><input type="email" value={f.deskEmail} onChange={(e) => set({ deskEmail: e.target.value })} /></Field>
        <Field label="Insurance desk hours"><input value={f.deskHours} onChange={(e) => set({ deskHours: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.emergency} onChange={(e) => set({ emergency: e.target.checked })} /> Emergency services</label>
        <Field label="Emergency hours"><input value={f.emergencyHours} onChange={(e) => set({ emergencyHours: e.target.value })} disabled={!f.emergency} /></Field>
        <label className="check"><input type="checkbox" checked={f.icu} onChange={(e) => set({ icu: e.target.checked })} /> ICU available</label>
        <Field label="ICU beds"><input type="number" min="0" value={f.icuBeds} onChange={(e) => set({ icuBeds: e.target.value })} disabled={!f.icu} /></Field>
        <Field label="Total beds"><input type="number" min="0" value={f.beds} onChange={(e) => set({ beds: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.nabhClaim} onChange={(e) => set({ nabhClaim: e.target.checked })} /> We hold NABH accreditation (VHC verifies before display)</label>
        <Field label="NABH certificate no."><input value={f.nabhCert} onChange={(e) => set({ nabhCert: e.target.value })} disabled={!f.nabhClaim} /></Field>
        <Field label="NABH valid to"><input type="date" value={f.nabhValidTo} onChange={(e) => set({ nabhValidTo: e.target.value })} disabled={!f.nabhClaim} /></Field>
      </div>
      <h4>Branches & facilities</h4>
      {f.branches.map((b, i) => (
        <div key={b.id || i} className="nw-row-wrap" style={{ marginBottom: '.5rem' }}>
          <Field label="Branch name"><input value={b.name} onChange={(e) => setBranch(i, { name: e.target.value })} /></Field>
          <Field label="Address"><input value={b.address} onChange={(e) => setBranch(i, { address: e.target.value })} /></Field>
          <Field label="City"><input value={b.city} onChange={(e) => setBranch(i, { city: e.target.value })} /></Field>
          <Field label="PIN"><input value={b.postalCode} onChange={(e) => setBranch(i, { postalCode: e.target.value })} /></Field>
          <Field label="Facilities"><input value={b.facilities} onChange={(e) => setBranch(i, { facilities: e.target.value })} /></Field>
          <button type="button" className="btn sm ghost" onClick={() => set({ branches: f.branches.filter((_, k) => k !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn sm secondary" onClick={() => set({ branches: [...f.branches, { name: '', address: '', city: '', postalCode: '', facilities: '' }] })}>Add branch</button>
      <ErrorBox error={act.error} />
      <div className="row end" style={{ marginTop: '1rem' }}><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={act.busy} onClick={save}>Save changes</button></div>
    </Modal>
  );
}

function ProfileTab({ base, h, isAdmin, reload }) {
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState(null);
  return (
    <>
      <Alert kind="ok">{msg}</Alert>
      {h.pendingVerification?.length > 0 && <Alert kind="warn">Pending VHC verification: {h.pendingVerification.map(titleCase).join(', ')}.</Alert>}
      <div className="grid grid-2">
        <Card title="Organisation" actions={isAdmin && <button className="btn sm" onClick={() => setEdit(true)}>Edit profile</button>}>
          <StagePipeline stage={h.stage} />
          <KV items={[
            ['Legal name', h.legalName], ['Type', PROVIDER_TYPE_LABEL[h.providerType]], ['Address', `${h.address}, ${h.city}, ${h.state} ${h.postalCode}`],
            ['Phone / email', `${h.phone || '—'} · ${h.email || '—'}`], ['Specialties', (h.specialties || []).join(', ')],
            ['Diagnostics', (h.diagnostics || []).join(', ') || '—'], ['Services', (h.supportedServices || []).join(', ') || '—'],
            ['Insurance desk', h.insuranceDesk ? `${h.insuranceDesk.name} · ${h.insuranceDesk.phone} · ${h.insuranceDesk.email} (${h.insuranceDesk.hours})` : '—'],
            ['Integration', h.integration?.status],
          ]} />
          {!isAdmin && <p className="nw-note">Read-only for hospital staff.</p>}
        </Card>
        <Card title="Credentials & facilities">
          <KV items={[
            ['Registration', <>{h.registration?.number || '—'} <Verified ok={h.registration?.verified} at={h.registration?.verifiedAt} /></>],
            ...(h.licences || []).map((l, i) => [`Licence ${i + 1}`, <>{l.type}: {l.number} (to {date(l.validTo)}) <Verified ok={l.verified} at={l.verifiedAt} /></>]),
            ...(h.accreditations || []).map((a) => [a.body, <>{a.certificateNo || 'Claimed'} <Verified ok={a.verified} at={a.verifiedAt} /></>]),
            ['Beds', h.bedCapacity ? <>{h.bedCapacity.total} <Verified ok={h.bedCapacity.verified} at={h.bedCapacity.verifiedAt} /></> : '—'],
            ['ICU', h.icu?.available ? <>{h.icu.beds} beds <Verified ok={h.icu.verified} /></> : 'No'],
            ['Emergency', h.emergency?.available ? <>{h.emergency.hours} <Verified ok={h.emergency.verified} /></> : 'No'],
          ]} />
        </Card>
        <Card title="Branches & facilities">
          <Table rows={h.branches || []} empty="No branches recorded." columns={[{ key: 'name', label: 'Branch' }, { key: 'city', label: 'City' }, { key: 'facilities', label: 'Facilities', render: (b) => (b.facilities || []).join(', ') }]} />
        </Card>
      </div>
      {edit && <ProfileEditor base={base} h={h} onClose={() => setEdit(false)} onSaved={(pending) => { setEdit(false); setMsg(pending?.length ? `Saved. Sent for re-verification: ${pending.map(titleCase).join(', ')}.` : 'Profile saved.'); reload(); }} />}
    </>
  );
}

function ContractsTab({ base, isAdmin }) {
  const res = useLoad(() => api.get(`${base}/contracts`));
  const act = useAction();
  const complain = (c) => {
    const summary = window.prompt(`Raise a complaint under ${c.reference}:`);
    if (!summary) return;
    act.run(() => api.post(`${base}/contracts/${c.id}/complaints`, { summary }), 'Complaint recorded').then(() => res.reload());
  };
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <>
      <Alert kind="info">{res.data.note}</Alert>
      <Alert kind="ok">{act.message}</Alert><ErrorBox error={act.error} />
      {res.data.contracts.length === 0 && <Empty>No contracts yet.</Empty>}
      {res.data.contracts.map((c) => (
        <Card key={c.id} title={`${c.reference} — ${c.title}`} actions={<><ContractBadge status={c.status} />{isAdmin && <button className="btn sm secondary" onClick={() => complain(c)}>Raise complaint</button>}</>}>
          <KV items={[
            ['Effective', `${date(c.effectiveFrom)} – ${date(c.effectiveTo)}${c.daysToExpiry != null ? ` (${c.daysToExpiry} days left)` : ''}`], ['Version', c.version],
            ['Service scope', c.serviceScope.join('; ')], ['Payment terms', `${c.paymentObligations?.creditDays} days credit, ${c.paymentObligations?.billingCycle} billing`],
            ['Referral rules', c.referralRestrictions], ['Quality obligations', c.qualityObligations.join('; ')],
            ['Escalation', c.escalation.map((e) => `L${e.level}: ${e.name} ${e.email}`).join(' · ')],
          ]} />
          <h4>Agreed package rates (synthetic)</h4>
          <Table rows={c.packageRates} rowKey="code" empty="No package rates." columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Package' }, { key: 'amount', label: 'Rate', num: true, render: (p) => money(p.amount) }]} />
          {c.complaints.length > 0 && <><h4>Complaints</h4><Table rows={c.complaints} columns={[{ key: 'at', label: 'Raised', render: (x) => date(x.at) }, { key: 'summary', label: 'Summary' }, { key: 'status', label: 'Status', render: (x) => <Badge>{x.status}</Badge> }, { key: 'resolution', label: 'Resolution' }]} /></>}
        </Card>
      ))}
    </>
  );
}

function StaffTab({ base, isAdmin }) {
  const res = useLoad(() => api.get(`${base}/staff`));
  const [f, setF] = useState({ firstName: '', lastName: '', email: '' });
  const act = useAction();
  const [invite, setInvite] = useState(null);
  const send = (e) => {
    e.preventDefault();
    act.run(async () => { const r = await api.post(`${base}/staff`, f); setInvite(r.devInviteToken || null); setF({ firstName: '', lastName: '', email: '' }); res.reload(); }, 'Invitation sent');
  };
  return (
    <div className="grid grid-2">
      <Card title="Authorised staff">
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role', render: (u) => titleCase(u.role) }, { key: 'status', label: 'Status', render: (u) => <Badge>{u.status}</Badge> }]} />
        )}
      </Card>
      {isAdmin && (
        <Card title="Invite hospital staff">
          <form onSubmit={send} className="stack">
            <Field label="First name"><input required value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
            <Field label="Last name"><input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
            <Field label="Work email"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <p className="nw-note">Invitees join as Hospital Staff for this hospital only. They can manage appointments but cannot edit the profile, packages or contracts.</p>
            <ErrorBox error={act.error} /><Alert kind="ok">{act.message}</Alert>
            {invite && <div className="devbox">🔧 <strong>Development mode:</strong> invitation link <code>/accept-invite?token={invite}</code></div>}
            <button className="btn" disabled={act.busy}>Send invitation</button>
          </form>
        </Card>
      )}
    </div>
  );
}

export function HospitalPortal() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const base = `/network/hospital-portal/${user.orgId}`;
  const res = useLoad(() => api.get(base), [base]);
  const isAdmin = user.role === 'hospital_admin';
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const h = res.data;
  return (
    <>
      <PageHeader title={h.name} subtitle={`Hospital partner portal · ${isAdmin ? 'Hospital administrator' : 'Hospital staff'}`} actions={<Badge kind={h.stage === 'Active' ? 'ok' : 'warn'}>{h.stage}</Badge>} />
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'overview' && <Overview base={base} />}
      {tab === 'appointments' && <AppointmentsTab base={base} />}
      {tab === 'desk' && <DeskTab base={base} />}
      {tab === 'packages' && <PackagesTab base={base} isAdmin={isAdmin} />}
      {tab === 'profile' && <ProfileTab base={base} h={h} isAdmin={isAdmin} reload={res.reload} />}
      {tab === 'contracts' && <ContractsTab base={base} isAdmin={isAdmin} />}
      {tab === 'staff' && <StaffTab base={base} isAdmin={isAdmin} />}
    </>
  );
}

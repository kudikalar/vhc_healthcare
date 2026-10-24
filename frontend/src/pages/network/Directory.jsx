// Public provider directory (/hospitals) and provider detail (/hospitals/:id).
// Cashless status is shown per insurer and plan, as last verified, with restricted/excluded flags.
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money, titleCase } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, PageHeader, Table, useLoad } from '../../components/ui.jsx';
import { CashlessLine, NETWORK_STATUS_KIND, PROVIDER_TYPE_LABEL } from './common.jsx';

const FILTER_KEYS = ['q', 'city', 'state', 'pin', 'insurerId', 'planId', 'specialty', 'service', 'providerType', 'cashless', 'emergency', 'accredited', 'date'];

function DeskContact({ desk }) {
  if (!desk) return <span className="nw-meta">Insurance desk: contact the provider directly.</span>;
  return (
    <span className="nw-meta">
      Insurance desk{desk.hours ? ` (${desk.hours})` : ''}: {desk.phone && <a href={`tel:${desk.phone.replace(/[^\d+]/g, '')}`}>{desk.phone}</a>}
      {desk.email && <> · <a href={`mailto:${desk.email}`}>{desk.email}</a></>}
    </span>
  );
}

function ProviderCard({ p }) {
  return (
    <article className="card nw-provider">
      <div className="row between">
        <h3><Link to={`/hospitals/${p.id}`}>{p.name}</Link></h3>
        <Badge>{PROVIDER_TYPE_LABEL[p.providerType] || 'Provider'}</Badge>
      </div>
      <div className="nw-meta">{p.address}, {p.city}, {p.state} {p.postalCode}</div>
      <div className="nw-tags">
        {p.emergency.available && <Badge kind={p.emergency.verified ? 'ok' : ''}>Emergency {p.emergency.hours || ''}{p.emergency.verified ? ' · verified' : ''}</Badge>}
        {p.accreditations.map((a) => <Badge key={a.body} kind="ok">{a.body} accredited · verified</Badge>)}
        {p.specialties.slice(0, 4).map((x) => <span key={x} className="badge">{x}</span>)}
      </div>
      {p.cashless ? <CashlessLine c={p.cashless} /> : (
        <div className="nw-meta">
          {p.networks.length ? `Cashless network records with ${p.networks.map((n) => n.insurerName).join(', ')} — choose your insurer and plan above to check.` : 'No insurer cashless network recorded — reimbursement may still be possible under your policy.'}
        </div>
      )}
      <DeskContact desk={p.insuranceDesk} />
      <div className="nw-actions">
        <a className="btn sm secondary" href={p.directionsUrl} target="_blank" rel="noopener noreferrer">Directions<span className="sr-only"> to {p.name} (opens Google Maps)</span></a>
        <Link className="btn sm secondary" to={`/services?hospitalId=${p.id}`}>Book a service</Link>
        <Link className="btn sm" to={`/hospitals/${p.id}`}>Details</Link>
      </div>
    </article>
  );
}

export function ProviderDirectory() {
  const [params, setParams] = useSearchParams();
  const applied = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || '']));
  const [f, setF] = useState(applied);
  const meta = useLoad(() => api.get('/network/directory/meta'));
  const query = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/network/directory?${query}`), [query]);
  const insurer = meta.data?.insurers.find((i) => i.id === f.insurerId);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = (e) => {
    e.preventDefault();
    setParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
  };
  const reset = () => { const empty = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])); setF(empty); setParams({}); };
  const opt = (arr) => arr?.map((x) => <option key={x} value={x}>{x}</option>);

  return (
    <>
      <PageHeader title="Find hospitals & providers" subtitle="Search sandbox network hospitals, clinics, diagnostic centres and telehealth providers. Choose your insurer and plan to see cashless status." />
      <Card>
        <form className="nw-filters" onSubmit={submit} aria-label="Directory filters">
          <Field label="Name"><input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="e.g. Sunrise" /></Field>
          <Field label="City"><input list="nw-cities" value={f.city} onChange={(e) => set({ city: e.target.value })} /><datalist id="nw-cities">{meta.data?.cities.map((c) => <option key={c} value={c} />)}</datalist></Field>
          <Field label="State"><select value={f.state} onChange={(e) => set({ state: e.target.value })}><option value="">Any</option>{opt(meta.data?.states)}</select></Field>
          <Field label="PIN code"><input inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set({ pin: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Insurer">
            <select value={f.insurerId} onChange={(e) => set({ insurerId: e.target.value, planId: '', cashless: e.target.value ? f.cashless : '' })}>
              <option value="">Any insurer</option>
              {meta.data?.insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>
          <Field label="Plan / product">
            <select value={f.planId} onChange={(e) => set({ planId: e.target.value })} disabled={!insurer}>
              <option value="">{insurer ? 'All products of this insurer' : 'Choose an insurer first'}</option>
              {insurer?.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Specialty"><select value={f.specialty} onChange={(e) => set({ specialty: e.target.value })}><option value="">Any</option>{opt(meta.data?.specialties)}</select></Field>
          <Field label="Service"><select value={f.service} onChange={(e) => set({ service: e.target.value })}><option value="">Any</option>{opt(meta.data?.services)}</select></Field>
          <Field label="Provider type">
            <select value={f.providerType} onChange={(e) => set({ providerType: e.target.value })}>
              <option value="">Any</option>
              {Object.entries(PROVIDER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Treatment date" hint="Cashless is checked on this date"><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
          <div className="nw-checks">
            <label className="check"><input type="checkbox" checked={f.cashless === 'true'} disabled={!f.insurerId} onChange={(e) => set({ cashless: e.target.checked ? 'true' : '' })} /> Cashless-eligible only{!f.insurerId ? ' (choose an insurer)' : ''}</label>
            <label className="check"><input type="checkbox" checked={f.emergency === 'true'} onChange={(e) => set({ emergency: e.target.checked ? 'true' : '' })} /> Emergency services</label>
            <label className="check"><input type="checkbox" checked={f.accredited === 'true'} onChange={(e) => set({ accredited: e.target.checked ? 'true' : '' })} /> Verified accreditation (e.g. NABH)</label>
          </div>
          <div className="row"><button className="btn">Search</button><button type="button" className="btn secondary" onClick={reset}>Clear</button></div>
        </form>
      </Card>
      <Alert kind="warn">{res.data?.disclaimer || meta.data?.disclaimer || 'Listing does not guarantee cashless approval.'}</Alert>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <>
          <p className="muted" aria-live="polite">{res.data.providers.length} provider{res.data.providers.length === 1 ? '' : 's'} found{res.data.insurerId ? ` · cashless checked for ${date(res.data.date)}` : ''}</p>
          {res.data.providers.length === 0 ? <Empty>No providers match your search. Try removing a filter.</Empty> : (
            <div className="nw-list">{res.data.providers.map((p) => <ProviderCard key={p.id} p={p} />)}</div>
          )}
        </>
      )}
    </>
  );
}

export function ProviderDetail() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/network/providers/${id}`), [id]);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const p = res.data;
  const rows = p.networks.flatMap((n) => [
    ...(n.allProducts ? [{ id: `${n.insurerId}-all`, insurer: n.insurerName, scope: 'All products', status: n.allProducts.status, services: n.allProducts.services, verified: n.allProducts.lastVerifiedAt, note: null }] : []),
    ...n.plans.map((pl, i) => ({ id: `${n.insurerId}-${i}`, insurer: n.insurerName, scope: pl.planNames.join(', '), status: pl.status, services: pl.services, verified: pl.lastVerifiedAt, note: pl.note })),
  ]);
  return (
    <>
      <PageHeader title={p.name} subtitle={`${PROVIDER_TYPE_LABEL[p.providerType] || 'Provider'} · ${p.city}, ${p.state}`}
        actions={<><a className="btn secondary" href={p.directionsUrl} target="_blank" rel="noopener noreferrer">Directions</a><Link className="btn" to={`/services?hospitalId=${p.id}`}>Book a service</Link></>} />
      <Alert kind="warn">{p.disclaimer}</Alert>
      <div className="nw-split">
        <div>
          <Card title="Insurer cashless networks">
            <Table rows={rows} empty="No insurer has a cashless network record for this provider. Reimbursement may still be possible under your policy terms." columns={[
              { key: 'insurer', label: 'Insurer' }, { key: 'scope', label: 'Products' },
              { key: 'status', label: 'Status', render: (r) => <Badge kind={NETWORK_STATUS_KIND[r.status]}>{r.status === 'active' ? 'Cashless' : titleCase(r.status)}</Badge> },
              { key: 'services', label: 'Service lines', render: (r) => (r.services?.length ? r.services.map(titleCase).join(', ') : 'All') },
              { key: 'verified', label: 'Last verified', render: (r) => (r.verified ? date(r.verified) : 'Not verified') },
            ]} />
            <p className="nw-note">Restricted: cashless not offered for that product/service (reimbursement may still apply). Excluded: the insurer has excluded this provider — check your policy wording.</p>
          </Card>
          <Card title="Bookable services">
            <Table rows={p.services} empty="No services are bookable online here yet." columns={[
              { key: 'name', label: 'Service', render: (x) => <>{x.name}<div className="nw-meta">{x.categoryLabel}</div></> },
              { key: 'price', label: 'Price (synthetic)', num: true, render: (x) => <>{money(x.price)}{x.discountedPrice != null && <div className="nw-meta">Discounted {money(x.discountedPrice)}</div>}</> },
              { key: 'book', label: '', render: (x) => <Link className="btn sm" to={`/services?serviceId=${x.id}`}>Book</Link> },
            ]} />
          </Card>
        </div>
        <div>
          <Card title="About">
            <KV items={[
              ['Address', `${p.address}, ${p.city}, ${p.state} ${p.postalCode}`],
              ['Phone', p.phone], ['Email', p.email],
              ['Emergency', p.emergency.available ? `${p.emergency.hours || 'Available'}${p.emergency.verified ? ' (verified)' : ' (not verified)'}` : 'Not available'],
              ['ICU', p.icu.available ? (p.icu.verified ? 'Available (verified)' : 'Reported (not verified)') : 'Not reported'],
              ['Beds', p.bedCapacity ? `${p.bedCapacity.total} (verified ${date(p.bedCapacity.verifiedAt)})` : 'Not verified'],
              ['Accreditation', p.accreditations.length ? p.accreditations.map((a) => `${a.body} — verified ${date(a.verifiedAt)}${a.validTo ? `, valid to ${date(a.validTo)}` : ''}`).join('; ') : 'No verified accreditation'],
              ['Specialties', p.specialties.join(', ')], ['Diagnostics', p.diagnostics.join(', ') || '—'], ['Services', p.supportedServices.join(', ') || '—'],
            ]} />
          </Card>
          <Card title="Insurance desk"><DeskContact desk={p.insuranceDesk} /></Card>
          {p.branches.length > 0 && <Card title="Branches">{p.branches.map((b) => <div key={b.id} className="nw-meta"><strong>{b.name}</strong> — {b.address}, {b.city} {b.postalCode}</div>)}</Card>}
          <p className="nw-note">Sandbox listing: provider details are synthetic. Unverified attributes are labelled as such.</p>
        </div>
      </div>
    </>
  );
}

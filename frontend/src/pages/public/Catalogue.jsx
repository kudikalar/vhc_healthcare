import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { money, pct, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Loading, PageHeader, Tabs, useAction, useLoad } from '../../components/ui.jsx';

export function startingPrice(p) {
  if (p.product === 'health') return Math.min(...p.config.ageBands.map((b) => b.premium));
  return null;
}

export function Home() {
  const plans = useLoad(() => api.get('/plans'));
  const { user } = useAuth();
  return (
    <>
      <section className="hero">
        <h1>Health and life cover, clearly explained.</h1>
        <p>Compare plans, get an instant quote with a full price breakdown, apply online, and manage policies and claims in one place.</p>
        <div className="row">
          <Link className="btn secondary" to="/quote">Get a quote</Link>
          <Link className="btn secondary" to="/plans">Compare plans</Link>
          {!user && <Link className="btn secondary" to="/register">Create an account</Link>}
        </div>
      </section>
      <div className="grid grid-3">
        <Card title="🏥 Network hospitals"><p>Search hospitals by city, postal code and specialty for cashless treatment.</p><Link to="/hospitals">Find a hospital →</Link></Card>
        <Card title="📄 Claims made simple"><p>Cashless pre-authorisation or reimbursement — track every step and amount.</p><Link to={user ? '/claims' : '/login'}>Go to claims →</Link></Card>
        <Card title="🕊️ Report a life claim"><p>Family members can report a death claim securely, without the policyholder's login.</p><Link to="/life-claim">Start a life claim →</Link></Card>
      </div>
      <h2 style={{ marginTop: '1rem' }}>Our plans</h2>
      {plans.loading ? <Loading /> : <PlanGrid plans={plans.data} />}
    </>
  );
}

function PlanGrid({ plans, selected, onToggle }) {
  return (
    <div className="grid grid-3">
      {plans.map((p) => (
        <Card key={p.id} className="plan-card" title={<div><h3 style={{ margin: 0 }}>{p.name}</h3><small>{p.code} · {titleCase(p.product)} · {titleCase(p.type)}</small></div>}>
          <p className="muted" style={{ marginTop: 0 }}>{p.description}</p>
          <div className="grow">
            {p.product === 'health' ? (
              <ul>
                <li>Entry age {p.config.minEntryAge}–{p.config.maxEntryAge}, up to {p.config.maxMembers} member(s)</li>
                <li>Cover {p.config.coverageOptions.map((c) => money(c.amount)).join(' / ')}</li>
                <li>Deductible {money(p.config.deductiblePerClaim)}, co-pay {pct(p.config.copayBp)}</li>
              </ul>
            ) : (
              <ul>
                <li>Entry age {p.config.minEntryAge}–{p.config.maxEntryAge}, cover to age {p.config.maxMaturityAge}</li>
                <li>Sum assured {money(p.config.minSumAssured)} – {money(p.config.maxSumAssured)}</li>
                <li>Terms {p.config.policyTerms.join(', ')} yrs · monthly or annual</li>
              </ul>
            )}
            {p.product === 'health' && <div className="price">from {money(startingPrice(p))}<small>/member/yr</small></div>}
          </div>
          <div className="row" style={{ marginTop: '.75rem' }}>
            <Link className="btn sm" to={`/quote?plan=${p.id}`}>Get quote</Link>
            {onToggle && <label className="check"><input type="checkbox" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} /> Compare</label>}
          </div>
        </Card>
      ))}
    </div>
  );
}

const ROWS_HEALTH = [
  ['Plan type', (p) => titleCase(p.type)],
  ['Entry age', (p) => `${p.config.minEntryAge}–${p.config.maxEntryAge}`],
  ['Members', (p) => `${p.config.maxMembers} (${p.config.eligibleRelationships.join(', ')})`],
  ['Coverage options', (p) => p.config.coverageOptions.map((c) => `${money(c.amount)} ×${c.multiplierBp / 10000}`).join(', ')],
  ['Premium table (per member)', (p) => p.config.ageBands.map((b) => `${b.minAge}–${b.maxAge}: ${money(b.premium)}`).join('; ')],
  ['Floater discount', (p) => (p.config.floaterDiscountBp ? pct(p.config.floaterDiscountBp) : '—')],
  ['Policy duration', (p) => `${p.config.durationMonths} months`],
  ['Initial waiting period', (p) => `${p.config.initialWaitingDays} days`],
  ['Condition waiting periods', (p) => p.config.conditionWaitingPeriods.map((w) => `${w.condition}: ${w.days}d`).join(', ')],
  ['Deductible / co-pay', (p) => `${money(p.config.deductiblePerClaim)} / ${pct(p.config.copayBp)}`],
  ['Room rent limit', (p) => `${money(p.config.roomRentLimitPerDay)} per day`],
  ['Benefits', (p) => p.config.benefits.join('; ')],
  ['Optional benefits', (p) => p.config.optionalBenefits.map((o) => `${o.name} (${money(o.charge)})`).join('; ')],
  ['Exclusions', (p) => p.config.exclusions.map((e) => e.label).join('; ')],
];
const ROWS_LIFE = [
  ['Entry age', (p) => `${p.config.minEntryAge}–${p.config.maxEntryAge}`],
  ['Maximum age at policy end', (p) => p.config.maxMaturityAge],
  ['Sum assured', (p) => `${money(p.config.minSumAssured)} – ${money(p.config.maxSumAssured)}`],
  ['Policy terms', (p) => `${p.config.policyTerms.join(', ')} years`],
  ['Premium payment terms', (p) => `Regular, or limited ${p.config.premiumPaymentTerms.join('/')} years`],
  ['Frequencies', (p) => Object.entries(p.config.frequencies).map(([k, f]) => `${k} (grace ${f.graceDays}d)`).join(', ')],
  ['Riders', (p) => p.config.riders.map((r) => `${r.name} (${money(r.annualCharge)}/yr)`).join('; ')],
  ['Medical exam', (p) => `Above age ${p.config.medicalRules.ageAbove} or sum assured over ${money(p.config.medicalRules.sumAssuredAbove)}`],
  ['Maturity benefit', () => 'None — term cover only'],
  ['Exclusions', (p) => p.config.exclusions.join('; ')],
];

export function Plans() {
  const [params] = useSearchParams();
  const [product, setProduct] = useState(params.get('product') || 'health');
  const [selected, setSelected] = useState([]);
  const plans = useLoad(() => api.get(`/plans?product=${product}`), [product]);
  const { user } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-3)));
  const compared = (plans.data || []).filter((p) => selected.includes(p.id));
  const rows = product === 'health' ? ROWS_HEALTH : ROWS_LIFE;
  const apply = (p) => act.run(async () => {
    const app = await api.post('/applications', { planId: p.id });
    nav(`/applications/${app.id}`);
  });

  return (
    <>
      <PageHeader title="Plan catalogue" subtitle="Select up to three plans to compare side by side." />
      <Tabs value={product} onChange={(v) => { setProduct(v); setSelected([]); }} tabs={[{ value: 'health', label: 'Health insurance' }, { value: 'life', label: 'Life insurance' }]} />
      {plans.loading ? <Loading /> : <PlanGrid plans={plans.data} selected={selected} onToggle={toggle} />}
      <ErrorBox error={act.error} />
      {compared.length > 0 && (
        <Card title={`Comparing ${compared.length} plan(s)`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Feature</th>{compared.map((p) => <th key={p.id}>{p.name}</th>)}</tr></thead>
              <tbody>
                {rows.map(([label, f]) => <tr key={label}><td><strong>{label}</strong></td>{compared.map((p) => <td key={p.id}>{f(p)}</td>)}</tr>)}
                <tr><td /> {compared.map((p) => (
                  <td key={p.id}>
                    {user?.role === 'customer' ? <button className="btn sm" disabled={act.busy} onClick={() => apply(p)}>Apply</button> : <Link to={`/quote?plan=${p.id}`}>Get quote</Link>}
                  </td>
                ))}</tr>
              </tbody>
            </table>
          </div>
          <Alert kind="info">All prices and terms are illustrative mock values for a fictional product.</Alert>
        </Card>
      )}
    </>
  );
}

export function Hospitals() {
  const [f, setF] = useState({ q: '', city: '', postalCode: '', specialty: '', network: '' });
  const [query, setQuery] = useState(f);
  const res = useLoad(() => api.get(`/hospitals?${new URLSearchParams(query)}`), [JSON.stringify(query)]);
  return (
    <>
      <PageHeader title="Network hospital search" subtitle="Find hospitals for cashless treatment or reimbursement claims." />
      <Card>
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); setQuery(f); }}>
          <label className="field">Name<input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
          <label className="field">City<input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></label>
          <label className="field">Postal code<input value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></label>
          <label className="field">Specialty<input value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} /></label>
          <label className="field">Network status
            <select value={f.network} onChange={(e) => setF({ ...f, network: e.target.value })}><option value="">All</option><option value="network">Network (cashless)</option><option value="non-network">Non-network</option></select>
          </label>
          <div className="row" style={{ alignItems: 'flex-end' }}><button className="btn">Search</button></div>
        </form>
      </Card>
      {res.data && <Alert kind="warn">{res.data.disclaimer}</Alert>}
      {res.loading ? <Loading /> : (
        <div className="grid grid-2">
          {res.data.hospitals.map((h) => (
            <Card key={h.id} title={h.name} actions={<Badge kind={h.network ? 'ok' : ''}>{h.network ? 'Network' : 'Non-network'}</Badge>}>
              <div>{h.address}, {h.city}, {h.state} {h.postalCode}</div>
              <div className="muted">☎ {h.phone} · ✉ {h.email}</div>
              <div className="row" style={{ marginTop: '.5rem' }}>{h.specialties.map((s) => <span key={s} className="badge">{s}</span>)}</div>
            </Card>
          ))}
          {res.data.hospitals.length === 0 && <div className="empty">No hospitals match your search.</div>}
        </div>
      )}
    </>
  );
}

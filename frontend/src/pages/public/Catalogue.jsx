import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { money, pct, titleCase } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Loading, PageHeader, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { DocLinks, LeadForm, ProductMeta } from '../partners/common.jsx';

export function startingPrice(p) {
  if (p.product === 'health') return Math.min(...p.config.ageBands.map((b) => b.premium));
  return null;
}

export function PlanGrid({ plans, selected = [], onToggle, showDocs = false }) {
  return (
    <div className="grid grid-3">
      {plans.map((p) => (
        <Card key={p.id} className="plan-card" title={<div><h3 style={{ margin: 0 }}>{p.name}</h3><small>{p.code} · {titleCase(p.product)} · {titleCase(p.type)}</small></div>}>
          <ProductMeta insurer={p.insurer} uin={p.uin} version={p.version} sandbox={p.sandbox} />
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
            {p.product === 'health' && <div className="price">from {money(startingPrice(p))}<small>/member/yr incl. GST</small></div>}
          </div>
          {showDocs && p.spec && <div style={{ marginTop: '.5rem' }}><DocLinks cisUrl={p.spec.cisUrl} wordingUrl={p.spec.wordingUrl} name={`${p.code}-v${p.version}`} /></div>}
          <div className="row" style={{ marginTop: '.75rem' }}>
            <Link className="btn sm" to={`/quote?plan=${p.id}`}>Get quote</Link>
            {onToggle && <label className="check"><input type="checkbox" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} /> Compare</label>}
          </div>
        </Card>
      ))}
    </div>
  );
}

const NA = <span className="pt-na">n/a</span>;
const na = (v, f = (x) => x) => (v == null || v === 'n/a' ? NA : f(v));
const days = (d) => (d == null ? NA : `${d} days`);
const addOn = (v) => (v === 'n/a' || v == null ? NA : `Optional add-on (+${money(v.charge)}/yr)`);

// Comparison engine rows (spec §6). Values come from the server's product summary; the insurer's CIS and
// policy wording override anything shown here.
const ROWS_HEALTH = [
  ['Insurer', (p) => <>{p.spec.insurer?.name}{p.spec.insurer?.sandbox && <> <span className="pt-tag sandbox">Sandbox</span></>}</>],
  ['Product / UIN / version', (p) => <>{p.name}<div className="pt-mono">{p.uin} · v{p.version}</div></>],
  ['Individual / floater', (p) => p.spec.coverType],
  ['Sum insured options', (p) => p.spec.sumInsuredOptions.map(money).join(', ')],
  ['Premium (from)', (p) => <>{money(p.spec.premium.from)} <small className="muted">{p.spec.premium.basis}</small><div className="pt-muted-sm">= {money(p.spec.premium.gst.netPremium)} premium + {money(p.spec.premium.gst.gst)} GST ({pct(p.spec.premium.gst.gstBp)})</div></>],
  ['Policy term', (p) => p.spec.term],
  ['Age eligibility', (p) => `${p.spec.ageEligibility.min}–${p.spec.ageEligibility.max} years · up to ${p.spec.maxMembers} member(s)`],
  ['Co-payment', (p) => pct(p.spec.copayBp)],
  ['Deductible', (p) => `${money(p.spec.deductiblePerClaim)} per claim`],
  ['Room rent limit', (p) => `${money(p.spec.roomRentLimitPerDay)} per day`],
  ['ICU limit', (p) => na(p.spec.icuLimit)],
  ['Initial waiting period', (p) => `${p.spec.waitingPeriods.initialDays} days`],
  ['Condition waiting periods', (p) => p.spec.waitingPeriods.conditions.map((w) => `${w.condition}: ${w.days}d`).join(', ') || NA],
  ['Pre-existing conditions', (p) => p.spec.pedConditions],
  ['Sub-limits', (p) => p.spec.sublimits.join('; ')],
  ['Restoration', (p) => na(p.spec.restoration)],
  ['No-claim bonus', (p) => na(p.spec.ncb)],
  ['Day-care procedures', (p) => (p.spec.dayCare ? 'Covered' : NA)],
  ['Pre / post hospitalisation', (p) => <>{days(p.spec.preHospitalisationDays)} / {days(p.spec.postHospitalisationDays)}</>],
  ['Ambulance', (p) => na(p.spec.ambulance)],
  ['Maternity', (p) => addOn(p.spec.maternity)],
  ['OPD', (p) => addOn(p.spec.opd)],
  ['Network hospitals', (p) => <Link to="/hospitals">{p.spec.networkHospitals} (synthetic network)</Link>],
  ['Key exclusions', (p) => p.spec.exclusions.join('; ')],
  ['Portability', (p) => p.spec.portability],
  ['CIS & policy wording', (p) => <DocLinks cisUrl={p.spec.cisUrl} wordingUrl={p.spec.wordingUrl} name={`${p.code}-v${p.version}`} />],
];
const ROWS_LIFE = [
  ['Insurer', (p) => <>{p.spec.insurer?.name}{p.spec.insurer?.sandbox && <> <span className="pt-tag sandbox">Sandbox</span></>}</>],
  ['Product / UIN / version', (p) => <>{p.name}<div className="pt-mono">{p.uin} · v{p.version}</div></>],
  ['Entry age', (p) => `${p.config.minEntryAge}–${p.config.maxEntryAge}`],
  ['Maximum age at policy end', (p) => p.config.maxMaturityAge],
  ['Sum assured', (p) => `${money(p.config.minSumAssured)} – ${money(p.config.maxSumAssured)}`],
  ['Policy terms', (p) => `${p.config.policyTerms.join(', ')} years`],
  ['Premium payment terms', (p) => `Regular, or limited ${p.config.premiumPaymentTerms.join('/')} years`],
  ['Premium', () => 'Depends on age, term, sum assured and tobacco use — includes 18% GST; get a quote'],
  ['Frequencies', (p) => Object.entries(p.config.frequencies).map(([k, f]) => `${k} (grace ${f.graceDays}d)`).join(', ')],
  ['Riders', (p) => p.config.riders.map((r) => `${r.name} (${money(r.annualCharge)}/yr)`).join('; ')],
  ['Medical exam', (p) => `Above age ${p.config.medicalRules.ageAbove} or sum assured over ${money(p.config.medicalRules.sumAssuredAbove)}`],
  ['Maturity benefit', () => 'None — term cover only'],
  ['Exclusions', (p) => p.config.exclusions.join('; ')],
  ['CIS & policy wording', (p) => <DocLinks cisUrl={p.spec.cisUrl} wordingUrl={p.spec.wordingUrl} name={`${p.code}-v${p.version}`} />],
];

const SORTS = [['', 'Default order'], ['premium', 'Lowest starting premium'], ['cover', 'Highest sum insured'], ['name', 'Name (A–Z)']];

export function Plans() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const [product, setProduct] = useState(category ? 'health' : params.get('product') || 'health');
  const [sort, setSort] = useState(params.get('sort') || '');
  const [selected, setSelected] = useState([]);
  const cats = useLoad(() => api.get('/partners/public/categories'));
  const insurer = params.get('insurer') || '';
  const qs = new URLSearchParams({ product, ...(product === 'health' && category && { category }), ...(sort && { sort }), ...(insurer && { insurer }) });
  const plans = useLoad(() => api.get(`/plans?${qs}`), [qs.toString()]);
  const { user } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-3)));
  const compared = (plans.data || []).filter((p) => selected.includes(p.id));
  const rows = product === 'health' ? ROWS_HEALTH : ROWS_LIFE;
  const cat = (cats.data || []).find((c) => c.key === category);
  const setCategory = (key) => { setSelected([]); const next = new URLSearchParams(params); if (key) next.set('category', key); else next.delete('category'); next.delete('product'); setParams(next, { replace: true }); };
  const apply = (p) => act.run(async () => {
    const app = await api.post('/applications', { planId: p.id });
    nav(`/applications/${app.id}`);
  });

  return (
    <>
      <PageHeader title="Compare insurance" subtitle="Choose a category, then select up to three products to compare side by side." />
      <Alert kind="info">Vision Health Care is a technology platform. Each product is underwritten and issued by the insurer named on it. Products marked <span className="pt-tag sandbox">Sandbox</span> are synthetic test products — no real cover is sold.</Alert>
      <Tabs value={product} onChange={(v) => { setProduct(v); setSelected([]); if (v === 'life') setCategory(''); }} tabs={[{ value: 'health', label: 'Health insurance' }, { value: 'life', label: 'Life insurance' }]} />
      {product === 'health' && cats.data && (
        <div className="pt-cats" role="group" aria-label="Product categories">
          <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>All health</button>
          {cats.data.map((c) => <button type="button" key={c.key} aria-pressed={category === c.key} onClick={() => setCategory(c.key)} title={c.description}>{c.label} <span className="n">{c.productCount}</span></button>)}
        </div>
      )}
      <div className="filter-bar">
        <label>Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <small className="muted" style={{ alignSelf: 'flex-end' }}>Rankings are never boosted by commission — only your filters decide the order.</small>
      </div>
      {cat && <p className="muted" style={{ marginTop: 0 }}><strong>{cat.label}:</strong> {cat.description}</p>}
      {plans.loading ? <Loading /> : plans.error ? <ErrorBox error={plans.error} /> : plans.data.length === 0 ? (
        <div className="grid grid-2">
          <Card><Empty>{category ? 'No authorised products in this category yet.' : 'No products are available right now.'}</Empty><p className="muted">We only list products that an insurer has authorised us to distribute. Leave your details and an adviser will call you when one is available.</p></Card>
          <Card><LeadForm interest={category ? `category:${category}` : product} title="Request a callback" /></Card>
        </div>
      ) : <PlanGrid plans={plans.data} selected={selected} onToggle={toggle} showDocs />}
      <ErrorBox error={act.error} />
      {compared.length > 0 && (
        <Card title={`Comparing ${compared.length} product(s)`}>
          <Alert kind="warn">This comparison summarises each product. The insurer&apos;s Customer Information Sheet and policy wording are the governing documents and override anything shown here.</Alert>
          <div className="table-wrap">
            <table className="pt-compare">
              <thead><tr><th scope="col">Feature</th>{compared.map((p) => <th key={p.id} scope="col">{p.name}</th>)}</tr></thead>
              <tbody>
                {rows.map(([label, f]) => <tr key={label}><th scope="row" style={{ textAlign: 'left' }}>{label}</th>{compared.map((p) => <td key={p.id}>{f(p)}</td>)}</tr>)}
                <tr><td />{compared.map((p) => (
                  <td key={p.id}>
                    {user?.role === 'customer'
                      ? (p.distribution?.allowed ? <button className="btn sm" disabled={act.busy} onClick={() => apply(p)}>Apply</button> : <Badge kind="warn">{p.distribution?.reason}</Badge>)
                      : <Link to={`/quote?plan=${p.id}`}>Get quote</Link>}
                  </td>
                ))}</tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: '.85rem' }}>n/a means the item is not defined in the product terms. All premiums include 18% GST. Sandbox values are illustrative and synthetic.</p>
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

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { money, titleCase, toPaise } from '../../format.js';
import { Card, ErrorBox, Field, Loading, PageHeader, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import QuoteBreakdown from '../../components/QuoteBreakdown.jsx';

const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

export default function QuoteCalculator() {
  const [params] = useSearchParams();
  const plans = useLoad(() => api.get('/plans'));
  const [product, setProduct] = useState('health');
  const [planId, setPlanId] = useState(params.get('plan') || '');
  const { user } = useAuth();
  const nav = useNavigate();

  const [h, setH] = useState({ coverage: '', optionalBenefits: [], startDate: tomorrow(), members: [{ fullName: '', dob: '', relationship: 'self' }] });
  const [l, setL] = useState({ dob: '', startDate: tomorrow(), sumAssured: '5000000', policyTerm: 20, premiumPaymentTerm: 20, frequency: 'annual', tobacco: false, riders: [], annualIncome: '1200000' });
  const [quote, setQuote] = useState(null);
  const act = useAction();
  const applyAct = useAction();

  const list = plans.data || [];
  const plan = list.find((p) => p.id === planId);
  useEffect(() => {
    if (!plans.data) return;
    const p = list.find((x) => x.id === planId);
    if (p) setProduct(p.product);
    else setPlanId(list.find((x) => x.product === product)?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans.data]);
  useEffect(() => { if (plan?.product === 'health' && !h.coverage) setH((x) => ({ ...x, coverage: plan.config.coverageOptions[0].amount })); }, [plan]); // eslint-disable-line
  useEffect(() => setQuote(null), [planId, h, l]);
  if (plans.loading) return <Loading />;

  const calc = () => act.run(async () => {
    const q = product === 'health'
      ? await api.post('/quotes/health', { planId, ...h })
      : await api.post('/quotes/life', { planId, ...l, sumAssured: toPaise(l.sumAssured), annualIncome: toPaise(l.annualIncome), policyTerm: Number(l.policyTerm), premiumPaymentTerm: Number(l.premiumPaymentTerm) });
    setQuote(q);
  });

  const apply = () => applyAct.run(async () => {
    const app = await api.post('/applications', { planId });
    if (product === 'health') {
      await api.put(`/applications/${app.id}`, { startDate: h.startDate, coverage: h.coverage, optionalBenefits: h.optionalBenefits, members: h.members.map((m) => ({ ...m, gender: '', heightCm: '', weightKg: '', hasConditions: null, tobacco: null })) });
    } else {
      await api.put(`/applications/${app.id}`, { startDate: l.startDate, life: { sumAssured: toPaise(l.sumAssured), policyTerm: Number(l.policyTerm), premiumPaymentTerm: Number(l.premiumPaymentTerm), frequency: l.frequency, riders: l.riders, tobacco: l.tobacco, lifeAssured: { fullName: user.name, dob: l.dob, annualIncome: toPaise(l.annualIncome) } } });
    }
    nav(`/applications/${app.id}`);
  });

  const setMember = (i, patch) => setH({ ...h, members: h.members.map((m, k) => (k === i ? { ...m, ...patch } : m)) });
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <>
      <PageHeader title="Quote calculator" subtitle="Prices are calculated on the server using the plan's configured (mock) rate tables." />
      <Tabs value={product} onChange={(v) => { setProduct(v); setPlanId(list.find((x) => x.product === v)?.id || ''); }} tabs={[{ value: 'health', label: 'Health' }, { value: 'life', label: 'Term life' }]} />
      <div className="grid grid-2">
        <Card title="Your details">
          <div className="form-grid">
            <Field label="Plan" className="full">
              <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                {list.filter((p) => p.product === product).map((p) => <option key={p.id} value={p.id}>{p.name} ({titleCase(p.type)})</option>)}
              </select>
            </Field>
            {product === 'health' && plan && (
              <>
                <Field label="Coverage start date"><input type="date" value={h.startDate} onChange={(e) => setH({ ...h, startDate: e.target.value })} /></Field>
                <Field label="Coverage amount">
                  <select value={h.coverage} onChange={(e) => setH({ ...h, coverage: Number(e.target.value) })}>
                    {plan.config.coverageOptions.map((c) => <option key={c.amount} value={c.amount}>{money(c.amount)}</option>)}
                  </select>
                </Field>
                <div className="full">
                  <strong>Insured members</strong> <small>(max {plan.config.maxMembers})</small>
                  {h.members.map((m, i) => (
                    <div key={i} className="form-grid" style={{ marginTop: '.4rem' }}>
                      <Field label="Name"><input value={m.fullName} onChange={(e) => setMember(i, { fullName: e.target.value })} /></Field>
                      <Field label="Date of birth"><input type="date" value={m.dob} onChange={(e) => setMember(i, { dob: e.target.value })} /></Field>
                      <Field label="Relationship">
                        <select value={m.relationship} onChange={(e) => setMember(i, { relationship: e.target.value })}>
                          {plan.config.eligibleRelationships.map((r) => <option key={r}>{r}</option>)}
                        </select>
                      </Field>
                      {h.members.length > 1 && <div className="row" style={{ alignItems: 'flex-end' }}><button className="btn ghost sm" onClick={() => setH({ ...h, members: h.members.filter((_, k) => k !== i) })}>Remove</button></div>}
                    </div>
                  ))}
                  <button className="btn secondary sm" style={{ marginTop: '.5rem' }} disabled={h.members.length >= plan.config.maxMembers} onClick={() => setH({ ...h, members: [...h.members, { fullName: '', dob: '', relationship: plan.config.eligibleRelationships[1] || 'self' }] })}>+ Add member</button>
                </div>
                <div className="full">
                  <strong>Optional benefits</strong>
                  {plan.config.optionalBenefits.map((o) => (
                    <label key={o.code} className="check"><input type="checkbox" checked={h.optionalBenefits.includes(o.code)} onChange={() => setH({ ...h, optionalBenefits: toggle(h.optionalBenefits, o.code) })} /> {o.name} (+{money(o.charge)})</label>
                  ))}
                </div>
              </>
            )}
            {product === 'life' && plan && (
              <>
                <Field label="Date of birth"><input type="date" value={l.dob} onChange={(e) => setL({ ...l, dob: e.target.value })} /></Field>
                <Field label="Coverage start date"><input type="date" value={l.startDate} onChange={(e) => setL({ ...l, startDate: e.target.value })} /></Field>
                <Field label="Sum assured (₹)" hint={`${money(plan.config.minSumAssured)} – ${money(plan.config.maxSumAssured)}`}><input inputMode="decimal" value={l.sumAssured} onChange={(e) => setL({ ...l, sumAssured: e.target.value })} /></Field>
                <Field label="Annual income (₹)"><input inputMode="decimal" value={l.annualIncome} onChange={(e) => setL({ ...l, annualIncome: e.target.value })} /></Field>
                <Field label="Policy term (years)">
                  <select value={l.policyTerm} onChange={(e) => setL({ ...l, policyTerm: Number(e.target.value), premiumPaymentTerm: Number(e.target.value) })}>{plan.config.policyTerms.map((t) => <option key={t}>{t}</option>)}</select>
                </Field>
                <Field label="Premium payment term">
                  <select value={l.premiumPaymentTerm} onChange={(e) => setL({ ...l, premiumPaymentTerm: Number(e.target.value) })}>
                    <option value={l.policyTerm}>Regular ({l.policyTerm} yrs)</option>
                    {plan.config.premiumPaymentTerms.map((t) => <option key={t} value={t}>Limited {t} yrs</option>)}
                  </select>
                </Field>
                <Field label="Payment frequency">
                  <select value={l.frequency} onChange={(e) => setL({ ...l, frequency: e.target.value })}>{Object.keys(plan.config.frequencies).map((f) => <option key={f}>{f}</option>)}</select>
                </Field>
                <Field label="Tobacco use?">
                  <select value={String(l.tobacco)} onChange={(e) => setL({ ...l, tobacco: e.target.value === 'true' })}><option value="false">No</option><option value="true">Yes</option></select>
                </Field>
                <div className="full">
                  <strong>Riders</strong>
                  {plan.config.riders.map((r) => <label key={r.code} className="check"><input type="checkbox" checked={l.riders.includes(r.code)} onChange={() => setL({ ...l, riders: toggle(l.riders, r.code) })} /> {r.name} (+{money(r.annualCharge)}/yr)</label>)}
                </div>
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: '1rem' }}><button className="btn" disabled={act.busy || !plan} onClick={calc}>{act.busy ? 'Calculating…' : 'Calculate premium'}</button></div>
          <div style={{ marginTop: '.75rem' }}><ErrorBox error={act.error} /></div>
        </Card>
        <Card title="Price breakdown">
          {quote ? (
            <>
              <QuoteBreakdown q={quote} />
              <hr />
              {user?.role === 'customer' ? (
                <button className="btn" disabled={applyAct.busy} onClick={apply}>Apply with these details</button>
              ) : !user ? <p><Link to="/login">Log in</Link> or <Link to="/register">register</Link> to apply.</p> : null}
              <ErrorBox error={applyAct.error} />
            </>
          ) : <div className="empty">Enter your details and calculate to see the full breakdown.</div>}
        </Card>
      </div>
    </>
  );
}

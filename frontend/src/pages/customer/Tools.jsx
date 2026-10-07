import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money, pct } from '../../format.js';
import { Alert, Card, Empty, ErrorBox, Loading, PageHeader, useLoad } from '../../components/ui.jsx';
import { AssistantChat } from '../../components/AIAssistant.jsx';
import Icon from '../../components/Icon.jsx';

// ---------------------------------------------------------------- Vision AI (full page)
export function AssistantPage() {
  return (
    <>
      <PageHeader title="Vision AI" subtitle="Plain-language answers about your own policies, with the source behind every statement." />
      <div className="assistant-layout">
        <Card className="assistant-card"><AssistantChat /></Card>
        <aside className="stack">
          <Card title="What Vision AI can do">
            <ul className="checklist">
              {['Explain benefits, exclusions and waiting periods', 'Estimate a payout using your deductible and co-pay', 'Show your balance, premiums and nominees', 'Point you to the right claim journey'].map((t) => <li key={t}><span className="ok-tick">✓</span>{t}</li>)}
            </ul>
          </Card>
          <Card title="What it will never do">
            <ul className="checklist">
              {['Approve, reject or promise a claim', 'Change premiums or move money', 'Diagnose or recommend treatment', 'Read anyone else\'s records'].map((t) => <li key={t}><span className="no-tick">✕</span>{t}</li>)}
            </ul>
          </Card>
          <Card title="Prefer a person?"><p style={{ margin: 0 }}>Human help is always available without the assistant. <Link to="/support">Go to Support</Link>.</p></Card>
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Coverage needs planner (VHC-M31)
const num = (v) => (v === '' || v == null ? null : Math.max(0, Number(String(v).replace(/[^0-9.]/g, '')) || 0));
const L = 100000; // ₹1 lakh in rupees
const rupee = (r) => money(Math.round(r * 100));
const DEFAULT = { expenses: '600000', years: '15', debts: '2500000', education: '2000000', marriage: '', other: '', assets: '1000000', existing: '0', income: '1800000' };

export function NeedsPlanner() {
  const [f, setF] = useState(DEFAULT);
  const [saved, setSaved] = useState([]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const v = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, num(x)]));
  const missing = ['expenses', 'years', 'debts', 'assets', 'existing'].filter((k) => v[k] == null);
  const goals = (v.education || 0) + (v.marriage || 0) + (v.other || 0);
  const living = (v.expenses || 0) * (v.years || 0);
  const gross = (v.debts || 0) + goals + living;
  const offsets = (v.assets || 0) + (v.existing || 0);
  const need = Math.max(0, gross - offsets);
  const suggested = Math.ceil(need / (25 * L)) * 25 * L;
  const multiple = v.income ? need / v.income : null;

  const rows = [
    ['Outstanding debts', v.debts], ['Children\'s education goals', v.education], ['Marriage goals', v.marriage], ['Other goals', v.other],
    [`Essential expenses × ${v.years ?? '?'} years`, living],
  ];

  return (
    <>
      <PageHeader title="Coverage needs planner" subtitle="Work out how much life cover your family might need — a transparent scenario, not financial advice." />
      <div className="planner">
        <Card title="Your family's numbers">
          <div className="form-grid">
            <Field2 label="Essential yearly household expenses" hint="Rent, food, school fees, bills" v={f.expenses} on={set('expenses')} />
            <Field2 label="Years of support you want to provide" hint="e.g. until children finish college" v={f.years} on={set('years')} unit="years" />
            <Field2 label="Outstanding loans" hint="Home, car, personal" v={f.debts} on={set('debts')} />
            <Field2 label="Children's education" v={f.education} on={set('education')} optional />
            <Field2 label="Marriage expenses" v={f.marriage} on={set('marriage')} optional />
            <Field2 label="Other goals" v={f.other} on={set('other')} optional />
            <Field2 label="Savings your family could use" hint="FDs, mutual funds — exclude your home" v={f.assets} on={set('assets')} />
            <Field2 label="Existing life cover" hint="Including employer group cover" v={f.existing} on={set('existing')} />
            <Field2 label="Your annual income" v={f.income} on={set('income')} optional />
          </div>
          <label className="field" style={{ marginTop: '1rem' }}>Years of support: {v.years ?? '—'}
            <input type="range" min="1" max="40" value={v.years || 1} onChange={set('years')} aria-label="Years of support slider" />
          </label>
        </Card>
        <div className="planner-result">
          <Card className="result-card">
            <span className="eyebrow">Illustrative cover need</span>
            {missing.length ? (
              <>
                <div className="result-big muted">Incomplete</div>
                <Alert kind="warn">Fill in {missing.length} more field{missing.length > 1 ? 's' : ''} for a figure. Enter 0 if something doesn't apply — we won't guess.</Alert>
              </>
            ) : (
              <>
                <div className="result-big">{rupee(need)}</div>
                {multiple != null && <small>about {multiple.toFixed(1)}× your annual income</small>}
                <table className="calc">
                  <tbody>
                    {rows.map(([l, x]) => <tr key={l}><td>{l}</td><td className="num">{x == null ? '—' : rupee(x)}</td></tr>)}
                    <tr className="sub"><td>Total needs</td><td className="num">{rupee(gross)}</td></tr>
                    <tr><td>Less savings available</td><td className="num">− {rupee(v.assets || 0)}</td></tr>
                    <tr><td>Less existing life cover</td><td className="num">− {rupee(v.existing || 0)}</td></tr>
                    <tr className="total"><td>Cover gap</td><td className="num">{rupee(need)}</td></tr>
                  </tbody>
                </table>
                <div className="row" style={{ marginTop: '.8rem' }}>
                  {need > 0 && <Link className="btn" to={`/quote?product=life&sumAssured=${suggested}`}>Quote {rupee(suggested)} term cover</Link>}
                  <button className="btn secondary" onClick={() => setSaved((s) => [{ at: new Date(), f: { ...f }, need }, ...s].slice(0, 4))}>Save scenario</button>
                </div>
              </>
            )}
            <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>Assumptions not modelled: inflation, investment returns, taxes and overlap between goals. Health costs are separate — they belong in health insurance. Being quoted doesn't guarantee acceptance; term life has no maturity value.</p>
          </Card>
          {saved.length > 0 && (
            <Card title="Compare scenarios">
              <table className="calc">
                <thead><tr><th>Saved</th><th className="num">Years</th><th className="num">Gap</th><th /></tr></thead>
                <tbody>
                  {saved.map((s, i) => (
                    <tr key={i}><td>{s.at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td><td className="num">{s.f.years}</td><td className="num">{rupee(s.need)}</td>
                      <td className="num"><button className="btn ghost sm" onClick={() => setF(s.f)}>Restore</button></td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Field2({ label, hint, v, on, unit = '₹', optional }) {
  return (
    <label className="field">{label}{optional && <span className="hint">Optional</span>}{hint && <span className="hint">{hint}</span>}
      <span className="input-affix"><span>{unit}</span><input inputMode="numeric" value={v} onChange={on} placeholder={optional ? '0' : 'Required'} /></span>
    </label>
  );
}

// ---------------------------------------------------------------- Claim payout estimator
const daysBetween = (a, b) => Math.floor((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

export function ClaimEstimator() {
  const res = useLoad(() => api.get('/policies?product=health'));
  const [pid, setPid] = useState('');
  const [f, setF] = useState({ member: '', bill: '100000', nonPayable: '0', treatment: '', date: new Date().toISOString().slice(0, 10), accident: false });
  const pols = (res.data || []).filter((p) => p.product === 'health' && ['Active', 'Upcoming'].includes(p.status));
  useEffect(() => { if (!pid && pols[0]) setPid(pols[0].id); }, [pols, pid]);
  const p = pols.find((x) => x.id === pid);
  const s = p?.termsSnapshot || {};
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const est = useMemo(() => {
    if (!p) return null;
    const bill = Math.round((num(f.bill) || 0) * 100);
    const np = Math.min(bill, Math.round((num(f.nonPayable) || 0) * 100));
    const text = f.treatment.toLowerCase();
    const excl = (s.exclusions || []).filter((e) => (e.keywords || []).some((k) => text.includes(k)));
    const since = daysBetween(p.continuityStartDate || p.startDate, f.date);
    const waits = [];
    if (!f.accident && since < (s.initialWaitingDays || 0)) waits.push(`Initial waiting period: treatment is ${since} days into cover; ${s.initialWaitingDays} days apply to non-accident claims.`);
    for (const w of s.conditionWaitingPeriods || []) if (text.includes(w.condition) && since < w.days) waits.push(`${w.condition[0].toUpperCase() + w.condition.slice(1)} has a ${w.days}-day waiting period; you are ${since} days into cover.`);
    const eligible = excl.length ? 0 : bill - np;
    const afterDed = Math.max(0, eligible - (s.deductiblePerClaim || 0));
    const copay = Math.round((afterDed * (s.copayBp || 0)) / 10000);
    const afterCopay = afterDed - copay;
    const available = p.balance?.available ?? p.coverage;
    const payable = waits.length ? 0 : Math.min(afterCopay, available);
    return { bill, np, eligible, ded: Math.min(eligible, s.deductiblePerClaim || 0), copay, afterCopay, available, payable, excl, waits, capped: afterCopay > available };
  }, [p, f, s]);

  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;

  return (
    <>
      <PageHeader title="Claim payout estimator" subtitle="See roughly what your health policy would pay for a bill — using your own deductible, co-pay and balance." />
      {!p ? (
        <Card><Empty><p style={{ marginTop: 0 }}>You need an active health policy to estimate a claim.</p><Link className="btn" to="/plans">Explore health plans</Link></Empty></Card>
      ) : (
        <div className="planner">
          <Card title="Treatment details">
            <div className="form-grid">
              {pols.length > 1 && (
                <label className="field full">Policy<select value={pid} onChange={(e) => setPid(e.target.value)}>{pols.map((x) => <option key={x.id} value={x.id}>{x.planName} · {x.policyNumber}</option>)}</select></label>
              )}
              <label className="field">Insured member
                <select value={f.member} onChange={set('member')}><option value="">Select</option>{(p.members || []).map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}</select>
              </label>
              <label className="field">Treatment date<input type="date" value={f.date} onChange={set('date')} /></label>
              <label className="field full">What is the treatment for?<span className="hint">Used to flag exclusions and waiting periods — e.g. "cataract surgery", "dental implant"</span>
                <input value={f.treatment} onChange={set('treatment')} placeholder="Describe the treatment" />
              </label>
              <label className="field">Total hospital bill<span className="input-affix"><span>₹</span><input inputMode="decimal" value={f.bill} onChange={set('bill')} /></span></label>
              <label className="field">Non-medical items<span className="hint">Toiletries, attendant food, registration</span><span className="input-affix"><span>₹</span><input inputMode="decimal" value={f.nonPayable} onChange={set('nonPayable')} /></span></label>
              <label className="check full"><input type="checkbox" checked={f.accident} onChange={set('accident')} /> This treatment is due to an accident</label>
            </div>
          </Card>
          <div className="planner-result">
            <Card className="result-card">
              <span className="eyebrow">Estimated payout</span>
              <div className="result-big">{money(est.payable)}</div>
              <small>of a {money(est.bill)} bill · you'd pay about {money(est.bill - est.payable)}</small>
              {est.excl.length > 0 && <Alert kind="error">Likely excluded: {est.excl.map((e) => e.label).join(', ')}.</Alert>}
              {est.waits.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
              <table className="calc">
                <tbody>
                  <tr><td>Hospital bill</td><td className="num">{money(est.bill)}</td></tr>
                  <tr><td>Less non-medical items</td><td className="num">− {money(est.np)}</td></tr>
                  {est.excl.length > 0 && <tr><td>Less excluded treatment</td><td className="num">− {money(est.bill - est.np)}</td></tr>}
                  <tr className="sub"><td>Eligible amount</td><td className="num">{money(est.eligible)}</td></tr>
                  <tr><td>Less deductible</td><td className="num">− {money(est.ded)}</td></tr>
                  <tr><td>Less co-pay ({pct(s.copayBp || 0)})</td><td className="num">− {money(est.copay)}</td></tr>
                  {est.capped && <tr><td>Capped at available balance</td><td className="num">{money(est.available)}</td></tr>}
                  {est.waits.length > 0 && <tr><td>Waiting period applies</td><td className="num">{money(0)}</td></tr>}
                  <tr className="total"><td>Estimated payout</td><td className="num">{money(est.payable)}</td></tr>
                </tbody>
              </table>
              <div className="row" style={{ marginTop: '.8rem' }}>
                <Link className="btn" to={`/claims/new?policy=${p.id}`}>Start a claim</Link>
                <Link className="btn secondary" to="/assistant">Ask Vision AI</Link>
              </div>
              <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>An estimate from your purchased terms ({p.planName} v{p.planVersion}, balance as of {date(new Date().toISOString())}). The actual amount is decided when the claim is assessed with your bills and reports.</p>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

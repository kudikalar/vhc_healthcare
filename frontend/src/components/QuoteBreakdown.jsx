import { money, pct, dateTime } from '../format.js';
import { Alert } from './ui.jsx';

export function HealthBreakdown({ q }) {
  return (
    <>
      <div className="table-wrap">
        <table className="breakdown">
          <thead><tr><th>Insured member</th><th>Age at start</th><th>Age band</th><th className="num">Base premium</th></tr></thead>
          <tbody>
            {q.members.map((m) => (
              <tr key={m.index}><td>{m.fullName} <span className="muted">({m.relationship})</span></td><td>{m.age}</td><td>{m.band}</td><td className="num">{money(m.premium)}</td></tr>
            ))}
            <tr><td colSpan={3}>Base premium (sum of members)</td><td className="num">{money(q.basePremium)}</td></tr>
            <tr><td colSpan={3}>Coverage {money(q.coverage)} — multiplier ×{(q.coverageMultiplierBp / 10000).toFixed(2)}</td><td className="num">{money(q.multipliedPremium)}</td></tr>
            {q.floaterDiscount > 0 && <tr><td colSpan={3}>Family floater discount ({pct(q.floaterDiscountBp)})</td><td className="num">− {money(q.floaterDiscount)}</td></tr>}
            {q.optionalBenefits.map((o) => <tr key={o.code}><td colSpan={3}>Optional: {o.name}</td><td className="num">+ {money(o.charge)}</td></tr>)}
            {q.loading > 0 && <tr><td colSpan={3}>Underwriting loading ({pct(q.loadingBp)})</td><td className="num">+ {money(q.loading)}</td></tr>}
            <tr className="total"><td colSpan={3}>Total annual premium</td><td className="num">{money(q.totalAnnualPremium + (q.loading || 0))}</td></tr>
          </tbody>
        </table>
      </div>
      <QuoteFooter q={q} />
    </>
  );
}

export function LifeBreakdown({ q }) {
  return (
    <>
      <div className="table-wrap">
        <table className="breakdown">
          <tbody>
            <tr><td>Age at entry / at policy end</td><td className="num">{q.age} / {q.maturityAge}</td></tr>
            <tr><td>Sum assured</td><td className="num">{money(q.sumAssured)}</td></tr>
            <tr><td>Rate ({q.uwClass} class) per ₹1,000</td><td className="num">{money(q.ratePer1000)}</td></tr>
            <tr><td>Base premium ({q.units.toLocaleString('en-IN')} × rate)</td><td className="num">{money(q.basePremium)}</td></tr>
            {q.loading > 0 && <tr><td>Underwriting loading ({pct(q.extraLoadingBp)})</td><td className="num">+ {money(q.loading)}</td></tr>}
            {q.riders.map((r) => <tr key={r.code}><td>Rider: {r.name}</td><td className="num">+ {money(r.charge)}</td></tr>)}
            <tr className="total"><td>Annual premium</td><td className="num">{money(q.annualPremium)}</td></tr>
            <tr><td>Payment frequency</td><td className="num">{q.frequency} (factor {pct(q.frequencyFactorBp)} of annual)</td></tr>
            <tr className="total"><td>Premium per installment</td><td className="num">{money(q.installmentPremium)}</td></tr>
            <tr><td>Policy term / premium payment term</td><td className="num">{q.policyTerm} yrs / {q.premiumPaymentTerm} yrs ({q.totalInstallments} installments)</td></tr>
          </tbody>
        </table>
      </div>
      <QuoteFooter q={q} />
    </>
  );
}

function QuoteFooter({ q }) {
  return (
    <div style={{ marginTop: '.75rem' }}>
      {q.underwritingRequired && (
        <Alert kind="warn">
          Your declarations will be reviewed by underwriting (this is not a rejection):
          <ul>{q.underwritingTriggers.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Alert>
      )}
      {q.expiresAt && <small>Quote valid until {dateTime(q.expiresAt)}. Underwriting may produce a revised offer that you must accept.</small>}
    </div>
  );
}

export default function QuoteBreakdown({ q }) {
  if (!q) return null;
  return q.product === 'health' ? <HealthBreakdown q={q} /> : <LifeBreakdown q={q} />;
}

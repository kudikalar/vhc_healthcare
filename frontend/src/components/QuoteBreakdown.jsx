import { money, pct, dateTime } from '../format.js';
import { Alert } from './ui.jsx';

/** Premiums are quoted GST-inclusive (18% on health and term-life premium); GST is shown as its own component. */
const GST_BP = 1800;
export function gstSplit(total, bp = GST_BP) {
  const netPremium = Math.round((total * 10000) / (10000 + bp));
  return { netPremium, gst: total - netPremium, gstBp: bp };
}

function GstRows({ total, cols = 1 }) {
  const t = gstSplit(total);
  return (
    <>
      <tr className="muted"><td colSpan={cols}>&nbsp;&nbsp;of which premium (excl. GST)</td><td className="num">{money(t.netPremium)}</td></tr>
      <tr className="muted"><td colSpan={cols}>&nbsp;&nbsp;of which GST ({pct(t.gstBp)})</td><td className="num">{money(t.gst)}</td></tr>
    </>
  );
}

export function HealthBreakdown({ q }) {
  const total = q.totalAnnualPremium + (q.loading || 0);
  return (
    <>
      <QuoteHeader q={q} />
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
            <tr className="total"><td colSpan={3}>Total annual premium (incl. GST)</td><td className="num">{money(total)}</td></tr>
            <GstRows total={total} cols={3} />
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
      <QuoteHeader q={q} />
      <div className="table-wrap">
        <table className="breakdown">
          <tbody>
            <tr><td>Age at entry / at policy end</td><td className="num">{q.age} / {q.maturityAge}</td></tr>
            <tr><td>Sum assured</td><td className="num">{money(q.sumAssured)}</td></tr>
            <tr><td>Rate ({q.uwClass} class) per ₹1,000</td><td className="num">{money(q.ratePer1000)}</td></tr>
            <tr><td>Base premium ({q.units.toLocaleString('en-IN')} × rate)</td><td className="num">{money(q.basePremium)}</td></tr>
            {q.loading > 0 && <tr><td>Underwriting loading ({pct(q.extraLoadingBp)})</td><td className="num">+ {money(q.loading)}</td></tr>}
            {q.riders.map((r) => <tr key={r.code}><td>Rider: {r.name}</td><td className="num">+ {money(r.charge)}</td></tr>)}
            <tr className="total"><td>Annual premium (incl. GST)</td><td className="num">{money(q.annualPremium)}</td></tr>
            <GstRows total={q.annualPremium} />
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

/** Quote reference, product version and rating source (present on quotes issued by the server). */
function QuoteHeader({ q }) {
  if (!q.reference && !q.productInfo) return null;
  const pi = q.productInfo || {};
  return (
    <dl className="kv" style={{ marginBottom: '.75rem' }}>
      {q.reference && <><dt>Quote reference</dt><dd><code>{q.reference}</code></dd></>}
      {pi.name && <><dt>Product</dt><dd>{pi.name} · UIN <code>{pi.uin || 'n/a'}</code> · version {pi.version}{pi.sandbox && <> · <span className="badge warn">Sandbox · synthetic</span></>}</dd></>}
      {pi.insurerName && <><dt>Insurer</dt><dd>{pi.insurerName}</dd></>}
      {q.source && <><dt>Rated by</dt><dd>{q.source}</dd></>}
    </dl>
  );
}

function QuoteFooter({ q }) {
  return (
    <div style={{ marginTop: '.75rem' }}>
      {q.underwritingRequired ? (
        <Alert kind="warn">
          {q.underwritingExplanation || 'Your declarations will be reviewed by underwriting (this is not a rejection):'}
          <ul>{q.underwritingTriggers.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Alert>
      ) : q.underwritingExplanation ? <small className="muted" style={{ display: 'block', marginBottom: '.4rem' }}>{q.underwritingExplanation}</small> : null}
      {q.distribution && !q.distribution.allowed && <Alert kind="error">This product cannot be purchased right now: {q.distribution.reason}</Alert>}
      {q.expiresAt && <small>Quote valid {q.validityDays ? `for ${q.validityDays} days, ` : ''}until {dateTime(q.expiresAt)}. Underwriting may produce a revised offer that you must accept.</small>}
      {q.documentsNote && <small className="muted" style={{ display: 'block', marginTop: '.3rem' }}>{q.documentsNote}</small>}
    </div>
  );
}

export default function QuoteBreakdown({ q }) {
  if (!q) return null;
  return q.product === 'health' ? <HealthBreakdown q={q} /> : <LifeBreakdown q={q} />;
}

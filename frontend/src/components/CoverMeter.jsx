import { money } from '../format.js';

// The cover meter: a sum insured drawn as a ruler, marked in lakhs, split into what has been paid out,
// what is held for open claims and what is still available. It is the platform's signature element —
// used wherever a customer needs to see how much cover is left, especially on shared family floaters.

const LAKH = 100000 * 100; // paise
const whole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
/** Rupees without paise when the amount is whole — large figures read cleaner. */
const amount = (p) => (p % 100 === 0 ? whole.format(p / 100) : money(p));
/** Indian short form for ruler labels: ₹50K, ₹5L, ₹1.5Cr. */
export function shortInr(paise) {
  const r = paise / 100;
  if (r >= 1e7) return `₹${+(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `₹${+(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `₹${Math.round(r / 1e3)}K`;
  return `₹${Math.round(r)}`;
}

/** Tick spacing so a ruler shows between 4 and ~12 marks. */
function tickStep(total) {
  const steps = [LAKH / 4, LAKH / 2, LAKH, 2 * LAKH, 5 * LAKH, 10 * LAKH, 25 * LAKH, 50 * LAKH, 100 * LAKH];
  return steps.find((s) => total / s <= 12) || total / 10;
}

export default function CoverMeter({ total, paid = 0, reserved = 0, sharedBy, size = 'md', animate = false, caption }) {
  const available = Math.max(0, total - paid - reserved);
  const pct = (v) => (total ? (v / total) * 100 : 0);
  const step = tickStep(total);
  const ticks = [];
  for (let v = 0; v <= total + 1; v += step) ticks.push(v);
  const labelEvery = Math.ceil(ticks.length / 5);
  // Label 0, the total and evenly spaced majors that are not crowding the total's label.
  const labelled = (v, i) => i === ticks.length - 1 || (i % labelEvery === 0 && (total - v) / total > 0.14);
  const label = `${money(available)} available of ${money(total)}. ${money(paid)} paid out, ${money(reserved)} held for open claims.`;

  return (
    <figure className={`cover-meter cm-${size} ${animate ? 'cm-animate' : ''}`}>
      <div className="cm-figure">
        <span className="cm-available">{amount(available)}</span>
        <span className="cm-of">available of {amount(total)}{sharedBy > 1 ? <>, shared by {sharedBy} people</> : null}</span>
      </div>
      <div className="cm-ruler" role="img" aria-label={label}>
        <div className="cm-track">
          <span className="cm-paid" style={{ width: `${pct(paid)}%` }} />
          <span className="cm-held" style={{ width: `${pct(reserved)}%` }} />
          <span className="cm-avail" style={{ width: `${pct(available)}%` }} />
        </div>
        <div className="cm-ticks" aria-hidden="true">
          {ticks.map((v, i) => (
            <span key={v} className={labelled(v, i) ? 'major' : ''} style={{ left: `${pct(v)}%` }}>
              {labelled(v, i) && <em>{shortInr(v)}</em>}
            </span>
          ))}
        </div>
      </div>
      <dl className="cm-legend">
        <div><dt><i className="k-avail" />Available</dt><dd>{amount(available)}</dd></div>
        <div><dt><i className="k-held" />Held for open claims</dt><dd>{amount(reserved)}</dd></div>
        <div><dt><i className="k-paid" />Paid out</dt><dd>{amount(paid)}</dd></div>
      </dl>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

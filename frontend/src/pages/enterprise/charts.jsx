// Inline-SVG executive charts (no chart library). Each chart has an accessible title/description,
// a hover read-out, a legend for 2+ series and a data-table fallback. Colours come from CSS variables
// in enterprise.css (validated categorical slots 1–2; separate dark-mode steps).
import { useId, useState } from 'react';
import { money } from '../../format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym) => (/^\d{4}-\d{2}$/.test(ym) ? `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(2, 4)}` : ym);

/** Compact axis labels: counts as 1.2K, money (paise) as ₹ K / L / Cr. */
export function compact(v, unit) {
  if (unit === 'money') {
    const r = v / 100;
    if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
    if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
    if (Math.abs(r) >= 1e3) return `₹${Math.round(r / 1e3)}K`;
    return `₹${Math.round(r)}`;
  }
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
}
const full = (v, unit) => (unit === 'money' ? money(v) : String(v));

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function DataTable({ chart }) {
  return (
    <details>
      <summary>View data table</summary>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{chart.title}</caption>
          <thead><tr><th scope="col">{chart.kind === 'line' || chart.kind === 'bar' ? 'Month' : 'Category'}</th>{chart.series.map((s) => <th key={s.name} scope="col" className="num">{s.name}</th>)}</tr></thead>
          <tbody>
            {chart.labels.map((l, i) => (
              <tr key={l}><th scope="row" style={{ fontWeight: 500 }}>{monthLabel(l)}</th>{chart.series.map((s) => <td key={s.name} className="num">{full(s.values[i], chart.unit)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const W = 520;
const PAD = { l: 48, r: 12, t: 12, b: 26 };

function Columns({ chart, setTip, line }) {
  const H = 210;
  const n = chart.labels.length;
  const max = niceMax(Math.max(0, ...chart.series.flatMap((s) => s.values)));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const band = iw / n;
  const y = (v) => PAD.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const ns = chart.series.length;
  const bw = Math.min(24, (band - 6) / ns - 2);
  const x0 = (i) => PAD.l + band * i + band / 2;
  const say = (i) => setTip(`${monthLabel(chart.labels[i])}: ${chart.series.map((s) => `${s.name} ${full(s.values[i], chart.unit)}`).join(' · ')}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" onMouseLeave={() => setTip('')}>
      <g className="grid">{ticks.map((t) => <line key={t} x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />)}</g>
      {ticks.map((t) => <text key={t} className="tick" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{compact(t, chart.unit)}</text>)}
      {chart.labels.map((l, i) => (n <= 12 && (n <= 6 || i % 2 === 0)) && <text key={l} className="tick" x={x0(i)} y={H - 8} textAnchor="middle">{monthLabel(l)}</text>)}
      {line ? chart.series.map((s, si) => {
        const pts = s.values.map((v, i) => [x0(i), y(v)]);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
        const last = pts[pts.length - 1];
        return (
          <g key={s.name}>
            {ns === 1 && <path className={`area s${si}`} d={`${d}L${last[0]},${y(0)}L${pts[0][0]},${y(0)}Z`} />}
            <path className={`line s${si}`} d={d} />
            <circle className={`dot s${si}`} cx={last[0]} cy={last[1]} r="4.5" />
          </g>
        );
      }) : chart.series.map((s, si) => s.values.map((v, i) => {
        const h = Math.max(0, y(0) - y(v));
        const x = x0(i) - (ns * (bw + 2)) / 2 + si * (bw + 2);
        const r = Math.min(4, h / 2, bw / 2);
        if (h <= 0) return null;
        return <path key={`${si}-${i}`} className={`mark s${si}`} d={`M${x},${y(0)}V${y(v) + r}Q${x},${y(v)} ${x + r},${y(v)}H${x + bw - r}Q${x + bw},${y(v)} ${x + bw},${y(v) + r}V${y(0)}Z`} />;
      }))}
      {line && chart.series.length === 1 && (() => {
        const s = chart.series[0];
        const i = s.values.length - 1;
        return <text className="val" x={x0(i) - 6} y={y(s.values[i]) - 9} textAnchor="end">{compact(s.values[i], chart.unit)}</text>;
      })()}
      {chart.labels.map((l, i) => (
        <g className="col" key={`h${l}`}>
          {line && <line className="guide" x1={x0(i)} x2={x0(i)} y1={PAD.t} y2={y(0)} />}
          <rect className="hit" x={PAD.l + band * i} y={PAD.t} width={band} height={ih} onMouseEnter={() => say(i)} />
        </g>
      ))}
    </svg>
  );
}

function HBars({ chart, setTip }) {
  const s = chart.series[0];
  const rows = chart.labels.map((l, i) => ({ l, v: s.values[i] }));
  const rowH = 30;
  const labelW = 170;
  const H = Math.max(rowH * rows.length + 8, 40);
  const max = Math.max(1, ...rows.map((r) => r.v));
  const iw = W - labelW - 56;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" onMouseLeave={() => setTip('')}>
      {rows.map((r, i) => {
        const w = Math.max(r.v > 0 ? 4 : 0, (r.v / max) * iw);
        const yy = 4 + i * rowH;
        const bh = Math.min(20, rowH - 8);
        const rr = Math.min(4, w / 2);
        const label = r.l.length > 28 ? `${r.l.slice(0, 27)}…` : r.l;
        return (
          <g key={r.l}>
            <text className="tick" x={labelW - 8} y={yy + bh / 2 + 4} textAnchor="end">{label}</text>
            {w > 0 && <path className="mark s0" d={`M${labelW},${yy}H${labelW + w - rr}Q${labelW + w},${yy} ${labelW + w},${yy + rr}V${yy + bh - rr}Q${labelW + w},${yy + bh} ${labelW + w - rr},${yy + bh}H${labelW}Z`} />}
            <text className="val" x={labelW + w + 6} y={yy + bh / 2 + 4}>{compact(r.v, chart.unit)}{chart.kind === 'funnel' && i > 0 && rows[0].v ? ` · ${Math.round((r.v / rows[0].v) * 100)}%` : ''}</text>
            <rect className="hit" x={0} y={yy - 3} width={W} height={rowH} onMouseEnter={() => setTip(`${r.l}: ${full(r.v, chart.unit)}`)} />
          </g>
        );
      })}
    </svg>
  );
}

/** chart = { id, title, desc, kind: line|bar|hbar|funnel, unit: count|money, labels, series: [{ name, values }] } */
export function SvgChart({ chart }) {
  const id = useId();
  const [tip, setTip] = useState('');
  const empty = !chart.labels.length || chart.series.every((s) => s.values.every((v) => !v));
  return (
    <figure className="card ent-chart" style={{ margin: 0 }} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
      <h3 id={`${id}-t`} style={{ marginBottom: '.15rem' }}>{chart.title}</h3>
      <p id={`${id}-d`} className="muted" style={{ fontSize: '.82rem', margin: '0 0 .5rem' }}>{chart.desc}</p>
      {chart.series.length > 1 && (
        <ul className="legend">{chart.series.map((s, i) => <li key={s.name}><i className={`s${i}`} aria-hidden="true" />{s.name}</li>)}</ul>
      )}
      {empty ? <div className="empty-chart">No data yet for this period.</div> : (
        <div role="img" aria-label={`${chart.title}. ${chart.desc}. Use “View data table” for exact values.`}>
          {chart.kind === 'hbar' || chart.kind === 'funnel' ? <HBars chart={chart} setTip={setTip} /> : <Columns chart={chart} setTip={setTip} line={chart.kind === 'line'} />}
        </div>
      )}
      <div className="ent-chart-tip" aria-live="polite">{tip}</div>
      {!empty && <DataTable chart={chart} />}
    </figure>
  );
}

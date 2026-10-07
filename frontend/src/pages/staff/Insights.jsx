import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, money } from '../../format.js';
import { Alert, Card, ErrorBox, Loading, PageHeader, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

// VHC-M42 operations intelligence: business aggregates only, no identifiable medical data.
// Gross premiums are labelled as premium volume, never as platform revenue (VHC-M27).

const total = (o = {}) => Object.values(o).reduce((a, b) => a + b, 0);

function Bars({ data, tone = 'brand' }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (!entries.length) return <p className="muted" style={{ margin: 0 }}>No records yet.</p>;
  return (
    <ul className="bars">
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className="bl">{k}</span>
          <span className="bt"><span className={`bf ${tone}`} style={{ width: `${(v / max) * 100}%` }} /></span>
          <span className="bv">{v}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Insights() {
  const { user } = useAuth();
  const res = useLoad(() => api.get('/reports/summary'));
  if (res.loading) return <Loading />;
  if (res.error) return <><PageHeader title="Insights" /><ErrorBox error={res.error} /></>;
  const d = res.data;
  const q = d.queues;
  const rec = d.reconciliation;
  const volume = d.premiumByProduct.health + d.premiumByProduct.life;
  const apps = total(d.applicationsByStatus);
  const issued = d.applicationsByStatus.Issued || 0;
  const work = q.initialReview + q.underwriting + q.healthClaimsOpen + q.lifeClaimsOpen + q.payoutsPending + q.reinstatements + q.exceptionsOpen;

  return (
    <>
      <PageHeader title="Insights" subtitle={`Business aggregates as of ${date(d.asOf)} · no individual medical records are shown`}
        actions={<button className="btn secondary" onClick={res.reload}><Icon name="refresh" size={16} /> Refresh</button>} />

      <div className="kpis">
        <div className="kpi static"><div className="label"><span>Premium volume collected</span></div><div className="value">{money(volume)}</div><div className="sub">Gross premiums — not platform revenue</div></div>
        <div className="kpi static"><div className="label"><span>Claims paid</span></div><div className="value">{money(rec.claimAmountsPaid)}</div><div className="sub">{money(rec.payoutsCompleted)} in completed payouts</div></div>
        <div className="kpi static"><div className="label"><span>Issued conversion</span></div><div className="value">{apps ? `${Math.round((issued / apps) * 100)}%` : '—'}</div><div className="sub">{issued} issued of {apps} applications (all time)</div></div>
        <div className="kpi static"><div className="label"><span>Open work items</span></div><div className="value">{work}</div><div className="sub">across queues below</div></div>
      </div>

      {rec.balanced ? (
        <Alert kind="ok">Ledgers reconcile: every successful payment is applied exactly once and payouts match claim settlements.</Alert>
      ) : (
        <Alert kind="error">Reconciliation needs attention: {rec.paymentMismatches.length} payment mismatch(es){rec.payoutsCompleted !== rec.claimAmountsPaid ? '; payouts and claim settlements differ' : ''}. {user.role === 'admin' || user.role === 'claims_officer' ? <Link to="/ops/exceptions">Open exception queue</Link> : null}</Alert>
      )}

      <div className="section-title"><Icon name="work" /><h2>Operational queues</h2></div>
      <div className="queue-grid">
        {[
          ['Initial review', q.initialReview, '/ops/applications'], ['Underwriting', q.underwriting, '/ops/applications'], ['Awaiting customer', q.awaitingCustomer, '/ops/applications'],
          ['Health claims open', q.healthClaimsOpen, '/ops/health-claims'], ['Life claims open', q.lifeClaimsOpen, '/ops/life-claims'], ['Payouts pending', q.payoutsPending, '/ops/payouts'],
          ['Reinstatements', q.reinstatements, '/ops/reinstatements'], ['Financial exceptions', q.exceptionsOpen, '/ops/exceptions'],
        ].map(([l, v, to]) => (
          <Link key={l} to={to} className={`queue ${v > 0 ? 'has' : ''}`}><span className="qv">{v}</span><span className="ql">{l}</span></Link>
        ))}
      </div>

      <div className="grid grid-2" style={{ marginTop: '1rem' }}>
        <Card title="Acquisition funnel — applications by status"><Bars data={d.applicationsByStatus} /></Card>
        <Card title="Policies by product and status"><Bars data={d.policiesByStatus} tone="navy" /></Card>
        <Card title="Health claims by status"><Bars data={d.healthClaimsByStatus} tone="amber" /></Card>
        <Card title="Life claims by status"><Bars data={d.lifeClaimsByStatus} tone="amber" /></Card>
        <Card title="Payments by status"><Bars data={d.paymentsByStatus} tone="navy" /></Card>
        <Card title="Premium volume by product">
          <div className="split-bar" role="img" aria-label={`Health ${money(d.premiumByProduct.health)}, life ${money(d.premiumByProduct.life)}`}>
            <span style={{ flex: d.premiumByProduct.health || 0.0001 }} className="h" />
            <span style={{ flex: d.premiumByProduct.life || 0.0001 }} className="l" />
          </div>
          <div className="legend"><span><i style={{ background: 'var(--brand)' }} />Health {money(d.premiumByProduct.health)}</span><span><i style={{ background: '#5b4bb7' }} />Life {money(d.premiumByProduct.life)}</span></div>
          <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>Premium volume belongs to the insurer. Platform revenue (commission and fees) needs partner agreements and isn't modelled in this demo.</p>
        </Card>
      </div>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money } from '../../format.js';
import { Alert, Badge, Card, Empty } from '../../components/ui.jsx';

const ICON = { application: '✎', claim: '✚', payment: '₹', policy: '🛡' };

export default function Dashboard() {
  const { user } = useAuth();
  const [filters, setFilters] = useState({ product: 'all', from: '', to: '' });
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [dateError, setDateError] = useState(null);

  const load = async (f = filters) => {
    if (f.from && f.to && f.to < f.from) { setDateError('End date must be on or after start.'); return; }
    setDateError(null);
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const q = new URLSearchParams({ product: f.product, ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}) });
      const data = await api.get(`/dashboard?${q}`);
      setState({ loading: false, data, error: null });
      if (!f.from) setFilters((x) => ({ ...x, from: data.filters.from, to: data.filters.to }));
    } catch (error) {
      setState({ loading: false, data: null, error });
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (patch) => { const f = { ...filters, ...patch }; setFilters(f); load(f); };

  const d = state.data;
  const first = (user.legalName || user.name || '').split(' ')[0];
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="greeting">
        <div>
          <h1>{hello}, {first}</h1>
          <p className="muted" style={{ margin: '.2rem 0 0' }}>Here's what's happening with your cover{d ? ` as of ${date(d.asOf)}` : ''}.</p>
        </div>
        <div className="filters" role="group" aria-label="Dashboard filters">
          <label>Product
            <select value={filters.product} onChange={(e) => change({ product: e.target.value })}>
              <option value="all">All</option><option value="health">Health</option><option value="life">Life</option>
            </select>
          </label>
          <label>Activity from<input type="date" value={filters.from} onChange={(e) => change({ from: e.target.value })} aria-invalid={!!dateError} /></label>
          <label>to<input type="date" value={filters.to} onChange={(e) => change({ to: e.target.value })} aria-invalid={!!dateError} /></label>
        </div>
      </div>
      {dateError && <Alert kind="error">{dateError}</Alert>}

      {state.error ? (
        <Card>
          <Alert kind="error">We couldn't load your dashboard. {state.error.message}</Alert>
          <button className="btn" onClick={() => load()}>Try again</button>
        </Card>
      ) : !d ? <DashboardSkeleton /> : (
        <>
          {d.partialErrors.length > 0 && (
            <Alert kind="warn">Some sections couldn't be loaded ({d.partialErrors.join(', ')}). <button className="btn ghost sm" onClick={() => load()}>Retry</button></Alert>
          )}
          {d.kpis && (
            <div className="kpis" style={{ opacity: state.loading ? 0.6 : 1 }}>
              <Kpi label="Active policies" k={d.kpis.activePolicies} />
              <Kpi label="Pending applications" k={d.kpis.pendingApplications} />
              <Kpi label="Open claims" k={d.kpis.openClaims} />
              <Kpi label="Premiums due (30 days)" k={d.kpis.premiumsDue} sub={d.kpis.premiumsDue.count ? money(d.kpis.premiumsDue.amount) : 'Nothing due'} />
            </div>
          )}
          <div className="dash-grid">
            <div>
              <Card title="Your policies" actions={<Link to="/policies">View all</Link>}>
                {d.policies.length === 0 ? (
                  <Empty>
                    <p style={{ marginTop: 0 }}>You don't have any {filters.product === 'all' ? '' : `${filters.product} `}policies yet.</p>
                    <Link className="btn" to="/quote">Get a quote</Link>
                  </Empty>
                ) : (
                  <div className="policy-cards">{d.policies.map((p) => <PolicyCard key={p.id} p={p} />)}</div>
                )}
              </Card>
              <Card title="Recent activity" actions={<small className="muted">{date(d.filters.from)} – {date(d.filters.to)}</small>}>
                {d.activity.length === 0 ? <Empty>No activity in this period.</Empty> : (
                  <ul className="activity-list">
                    {d.activity.map((a, i) => (
                      <li key={i}>
                        <span className="ico" aria-hidden="true">{ICON[a.type] || '•'}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Link to={a.link}><strong>{a.title}</strong></Link>{a.amount != null && <span className="muted"> · {money(a.amount)}</span>}
                          {a.detail && <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.detail}</div>}
                          <div className="when">{dateTime(a.at)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title="Things to do">
              {d.actions.length === 0 ? <Empty>You're all caught up.</Empty> : (
                <ul className="action-list">
                  {d.actions.map((a, i) => (
                    <li key={i}>
                      <Link to={a.link}>
                        <span className={`action-dot p${a.priority}`} aria-hidden="true" />
                        <span style={{ flex: 1 }}>
                          <span className="t">{a.title}</span>{a.amount != null && <span className="muted"> · {money(a.amount)}</span>}
                          <div className="d">{a.detail}</div>
                        </span>
                        <span aria-hidden="true" className="muted">›</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function Kpi({ label, k, sub }) {
  return (
    <Link className="kpi" to={k.link}>
      <div className="label"><span>{label}</span><span aria-hidden="true">›</span></div>
      <div className="value">{k.count}</div>
      {sub && <div className="sub">{sub}</div>}
    </Link>
  );
}

function PolicyCard({ p }) {
  return (
    <Link className="policy-card" to={`/policies/${p.id}`}>
      <div className="top"><span className={`prod ${p.product}`}>{p.product}</span><Badge>{p.status}</Badge></div>
      <strong>{p.planName}</strong>
      <small className="muted">{p.policyNumber} · until {date(p.endDate)}</small>
      {p.product === 'health' ? (
        <>
          <div style={{ marginTop: '.4rem' }}><span className="big">{money(p.availableCoverage)}</span> <small className="muted">available of {money(p.coverage)}{p.shared ? ` · shared by ${p.members}` : ''}</small></div>
          <div className="meter"><span style={{ width: `${Math.max(2, (p.availableCoverage / p.coverage) * 100)}%` }} /></div>
        </>
      ) : (
        <>
          <div style={{ marginTop: '.4rem' }}><span className="big">{money(p.sumAssured)}</span> <small className="muted">sum assured</small></div>
          <small>{p.nextDue ? <>Next premium {money(p.nextDue.amount)} due {date(p.nextDue.dueDate)}</> : 'All premiums paid'}</small>
        </>
      )}
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div>
      <div className="dash-grid"><div className="skeleton" style={{ height: 320 }} /><div className="skeleton" style={{ height: 320 }} /></div>
    </div>
  );
}


import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime, money, pct, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Loading, PageHeader, Tabs, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { SvgChart } from './charts.jsx';
import { useT } from './i18n.jsx';
import './enterprise.css';

const GROUPS = [
  ['business', 'Business', 'chart'],
  ['partners', 'Partners', 'building'],
  ['claims', 'Claims', 'claim'],
  ['sales', 'Sales', 'briefcase'],
  ['experience', 'Customer experience', 'help'],
];

const fmt = (k) => (k.value == null ? '—' : k.unit === 'money' ? money(k.value) : k.unit === 'bp' ? pct(k.value) : k.unit === 'days' ? `${k.value} days` : k.value.toLocaleString('en-IN'));

export function KpiGroup({ title, icon, items }) {
  return (
    <section className="ent-kpi-group" aria-label={title}>
      <h2><Icon name={icon} size={18} />{title}</h2>
      <div className="ent-kpis">
        {items.map((k) => (
          <div key={k.key} className={`ent-kpi ${k.unit === 'money' ? 'money' : ''}`}>
            <div className="label">{k.label}</div>
            <div className="value">{fmt(k)}</div>
            {k.note && <div className="note">{k.note}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function CommandCentre() {
  const { user } = useAuth();
  const t = useT();
  const [mode, setMode] = useState('test');
  const [tab, setTab] = useState('overview');
  const res = useLoad(() => api.get(`/enterprise/command?mode=${mode}`), [mode]);
  const readOnly = user.role !== 'admin';
  return (
    <>
      <PageHeader title={t('Command centre')} subtitle="Platform-wide operations computed live from the system of record."
        actions={(
          <label className="field" style={{ minWidth: 150 }}>Payment mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}><option value="test">Test (sandbox)</option><option value="live">Live</option></select>
          </label>
        )} />
      {readOnly && <Alert kind="info">Read-only view for your role. Actions are taken in the owning workspaces.</Alert>}
      {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <>
          <div className="ent-callout" role="note"><strong>Premiums facilitated are held for insurers and are not VHC revenue.</strong> VHC earned revenue counts only commission and service/booking fees. Figures are {mode === 'test' ? 'sandbox (test mode)' : 'live mode'} as of {dateTime(res.data.asOf)}.</div>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'KPIs' }, { value: 'charts', label: 'Executive charts (12)' }, { value: 'retention', label: 'Retention intelligence' }]} />
          {tab === 'overview' && (
            <>
              {GROUPS.map(([k, title, icon]) => <KpiGroup key={k} title={title} icon={icon} items={res.data.kpis[k]} />)}
              <Card title="Payment reconciliation" actions={<Badge kind={res.data.reconciliation.balanced ? 'ok' : 'warn'}>{res.data.reconciliation.exceptions} open exception(s)</Badge>}>
                {Object.keys(res.data.reconciliation.byType).length === 0 ? <p className="muted" style={{ margin: 0 }}>No reconciliation exceptions.</p> : (
                  <ul className="ent-list">{Object.entries(res.data.reconciliation.byType).map(([k, v]) => <li key={k}><strong>{titleCase(k)}</strong> — {v}</li>)}</ul>
                )}
                {['admin', 'finance_manager', 'auditor', 'compliance_officer'].includes(user.role) && <Link to="/finance/reconciliation">Open reconciliation →</Link>}
              </Card>
            </>
          )}
          {tab === 'charts' && <div className="ent-chart-grid">{res.data.charts.map((c) => <SvgChart key={c.id} chart={c} />)}</div>}
          {tab === 'retention' && <Retention data={res.data.retention} />}
        </>
      )}
    </>
  );
}

function Retention({ data }) {
  return (
    <>
      <div className="ent-callout" role="note"><Icon name="scale" size={16} /> {data.principle}</div>
      <div className="grid grid-2">
        {data.groups.map((g) => (
          <Card key={g.key} title={`${g.title} (${g.items.length})`}>
            {g.items.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing on this list right now.</p> : (
              <ul className="ent-list">
                {g.items.slice(0, 25).map((it, i) => (
                  <li key={`${it.ref}-${i}`}>
                    <div className="row between"><strong>{it.customer}</strong><span className="ent-pill ent-mono">{it.link ? <Link to={it.link}>{it.ref}</Link> : it.ref}</span></div>
                    <div className="why">Why listed: {it.reason}</div>
                    <div className="act">Suggested service action: {it.action}</div>
                  </li>
                ))}
              </ul>
            )}
            {g.items.length > 25 && <small className="muted">Showing 25 of {g.items.length}.</small>}
          </Card>
        ))}
      </div>
    </>
  );
}

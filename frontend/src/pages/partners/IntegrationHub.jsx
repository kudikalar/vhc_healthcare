// Integration Hub administration (admin + operations admin): adapters, sandbox insurer mode, event log,
// deliveries, dead-letter replay and integration exceptions.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, KV, Loading, Modal, PageHeader, Stat, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { SandboxTag } from './common.jsx';

const MODE_HELP = {
  auto: 'Issues immediately after payment is captured.',
  manual: 'Waits in "Issuance Pending" until the insurer decides (portal or admin acting for the sandbox).',
  decline: 'Declines after payment; a full refund is created automatically.',
};

export default function IntegrationHub() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  return (
    <>
      <PageHeader title="Integration hub" subtitle="Insurer adapters, the domain event log and integration exceptions. Only the synthetic sandbox simulator is deployed." />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'overview', label: 'Adapters & sandbox' }, { value: 'events', label: 'Events' }, { value: 'exceptions', label: 'Exceptions' }]} />
      {tab === 'overview' && <Overview />}
      {tab === 'events' && <Events />}
      {tab === 'exceptions' && <Exceptions />}
    </>
  );
}

function Overview() {
  const res = useLoad(() => api.get('/partners/hub'));
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const h = res.data;
  const setMode = (m) => act.run(async () => { const r = await api.post('/partners/hub/sandbox', { issuanceMode: m }); res.setData({ ...h, sandbox: r }); }, `Sandbox insurer mode set to ${m}`);
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <Stat label="Events recorded" value={h.stats.total} />
        <Stat label="Processed" value={h.stats.byStatus.processed || 0} />
        <Stat label="Retrying" value={h.stats.byStatus.retrying || 0} />
        <Stat label="Dead letter" value={h.stats.byStatus.dead_letter || 0} />
      </div>
      <Card title={<h3 style={{ margin: 0 }}>Sandbox insurer issuance mode <SandboxTag /></h3>}>
        {act.message && <Alert kind="ok">{act.message}</Alert>}
        <ErrorBox error={act.error} />
        <div className="seg" role="group" aria-label="Issuance mode">
          {h.sandbox.modes.map((m) => <button key={m} type="button" className={h.sandbox.issuanceMode === m ? 'on' : ''} aria-pressed={h.sandbox.issuanceMode === m} disabled={act.busy} onClick={() => setMode(m)}>{m}</button>)}
        </div>
        <p className="pt-muted-sm">{MODE_HELP[h.sandbox.issuanceMode]}</p>
      </Card>
      {h.adapters.map((a) => (
        <Card key={a.key} title={<div><h3 style={{ margin: 0 }}>{a.name}</h3><small className="pt-mono">{a.key} · {a.protocol}</small></div>} actions={a.sandboxOnly && <SandboxTag>Sandbox only</SandboxTag>}>
          <p className="pt-muted-sm" style={{ marginTop: 0 }}>Used by: {a.insurers.length ? a.insurers.map((i, k) => <span key={i.id}>{k > 0 && ', '}<Link to={`/partners/insurers/${i.id}`}>{i.name} ({i.status})</Link></span>) : 'no insurer'}</p>
          <div className="pt-ops">
            {a.operations.map((o) => (
              <div key={o.key} className={o.supported ? 'yes' : ''}>
                <span aria-label={o.supported ? 'supported' : 'not supported'}>{o.supported ? '✓' : '—'}</span>
                <span><strong>{o.label}</strong><small>{o.note}</small></span>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {h.unconfigured.length > 0 && (
        <Card title="Insurers with undeployed adapters">
          <Table rows={h.unconfigured} columns={[{ key: 'name', label: 'Insurer', render: (i) => <Link to={`/partners/insurers/${i.id}`}>{i.name}</Link> }, { key: 'adapter', label: 'Adapter' }, { key: 'note', label: 'Note' }]} />
        </Card>
      )}
    </>
  );
}

const EVENT_STATUSES = ['processed', 'retrying', 'dead_letter', 'pending'];

function Events() {
  const [f, setF] = useState({ type: '', status: '', correlationId: '' });
  const [q, setQ] = useState(f);
  const [open, setOpen] = useState(null);
  const hub = useLoad(() => api.get('/partners/hub'));
  const res = useLoad(() => api.get(`/partners/hub/events?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`), [JSON.stringify(q)]);
  const act = useAction();
  const retryAll = () => act.run(async () => { const r = await api.post('/partners/hub/events/retry', {}); res.reload(); return r; }, (r) => `${r.retried} delivery attempt(s) retried`);
  return (
    <>
      <Card>
        <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); setQ(f); }}>
          <label>Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">All</option>{Object.keys(hub.data?.stats.byType || {}).sort().map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Status<select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{EVENT_STATUSES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Correlation id<input value={f.correlationId} onChange={(e) => setF({ ...f, correlationId: e.target.value.trim() })} placeholder="cor_…" /></label>
          <button className="btn">Filter</button>
          <button type="button" className="btn secondary" disabled={act.busy} onClick={retryAll}>Retry due deliveries</button>
        </form>
        {act.message && <Alert kind="ok">{act.message}</Alert>}
        <ErrorBox error={act.error} />
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No events match." onRowClick={(e) => setOpen(e.id)} columns={[
            { key: 'occurredAt', label: 'When', render: (e) => dateTime(e.occurredAt) },
            { key: 'type', label: 'Type', render: (e) => <code>{e.type}</code> },
            { key: 'status', label: 'Status', render: (e) => <Badge kind={e.status === 'processed' ? 'ok' : e.status === 'dead_letter' ? 'error' : 'warn'}>{e.status}</Badge> },
            { key: 'subject', label: 'Subject', render: (e) => (e.subject ? `${e.subject.type} ${e.subject.id}` : '—') },
            { key: 'deliveries', label: 'Deliveries', num: true, render: (e) => `${e.deliveries}${e.failedDeliveries ? ` (${e.failedDeliveries} failing)` : ''}` },
            { key: 'correlationId', label: 'Correlation', render: (e) => <button type="button" className="btn ghost sm pt-mono" onClick={(ev) => { ev.stopPropagation(); setF({ ...f, correlationId: e.correlationId }); setQ({ ...q, correlationId: e.correlationId }); }}>{e.correlationId}</button> },
          ]} />
        )}
      </Card>
      {open && <EventDetail id={open} onClose={() => { setOpen(null); res.reload(); }} onOpen={setOpen} />}
    </>
  );
}

function EventDetail({ id, onClose, onOpen }) {
  const res = useLoad(() => api.get(`/partners/hub/events/${id}`), [id]);
  const act = useAction();
  const e = res.data;
  const failing = e?.deliveries.some((d) => ['dead_letter', 'retrying'].includes(d.status));
  return (
    <Modal open large title={e ? e.type : 'Event'} onClose={onClose}>
      {res.loading && !e ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <>
          <KV items={[['Event id', <span key="i" className="pt-mono">{e.id}</span>], ['Status', <Badge key="s">{e.status}</Badge>], ['Occurred', dateTime(e.occurredAt)], ['Correlation id', <span key="c" className="pt-mono">{e.correlationId}</span>],
            ['Actor', e.actor ? `${e.actor.name} (${e.actor.role})` : '—'], ['Idempotency key', e.idempotencyKey || '—']]} />
          <h4>Payload</h4>
          <pre className="pt-mono" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: '.6rem', borderRadius: 8 }}>{JSON.stringify(e.payload, null, 2)}</pre>
          <h4>Deliveries</h4>
          <Table rows={e.deliveries.map((d) => ({ ...d, id: d.handler }))} empty="No handlers registered for this event type." columns={[
            { key: 'handler', label: 'Handler', render: (d) => <code>{d.handler}</code> }, { key: 'status', label: 'Status', render: (d) => <Badge>{d.status}</Badge> },
            { key: 'attempts', label: 'Attempts', num: true }, { key: 'lastError', label: 'Last error', render: (d) => d.lastError || '—' }, { key: 'nextAttemptAt', label: 'Next attempt', render: (d) => dateTime(d.nextAttemptAt) },
          ]} />
          {act.message && <Alert kind="ok">{act.message}</Alert>}
          <ErrorBox error={act.error} />
          {failing && <button className="btn" style={{ marginTop: '.75rem' }} disabled={act.busy} onClick={() => act.run(async () => { const r = await api.post('/partners/hub/events/retry', { eventId: e.id }); res.setData(r.event); return r; }, 'Replayed')}>Retry / replay failed deliveries</button>}
          {e.related.length > 0 && (
            <>
              <h4>Same correlation id</h4>
              <Table rows={e.related} onRowClick={(x) => onOpen(x.id)} columns={[{ key: 'occurredAt', label: 'When', render: (x) => dateTime(x.occurredAt) }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status', render: (x) => <Badge>{x.status}</Badge> }]} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function Exceptions() {
  const { user } = useAuth();
  const res = useLoad(() => api.get('/partners/hub/exceptions'));
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const x = res.data;
  const done = (fn, msg) => act.run(async () => { const r = await fn(); res.reload(); return r; }, msg);
  const decide = (a, decision) => {
    const reason = decision === 'declined' ? window.prompt('Reason for declining (recorded as the sandbox insurer decision)') : '';
    if (decision === 'declined' && !reason) return;
    done(() => api.post(`/partners/hub/issuance/${a.id}/decision`, { decision, reason }), decision === 'issued' ? 'Policy issued (sandbox insurer)' : 'Declined — refund initiated');
  };
  return (
    <>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Card title={`Proposals awaiting insurer issuance (${x.issuancePending.length})`}>
        <Table rows={x.issuancePending} empty="Nothing is waiting for an insurer." columns={[
          { key: 'reference', label: 'Proposal' }, { key: 'insurerName', label: 'Insurer' },
          { key: 'hours', label: 'Waiting', render: (a) => <>{a.hours} h {a.overdue && <Badge kind="error">Overdue</Badge>}</> },
          { key: 'attempts', label: 'Requests', num: true },
          { key: 'act', label: 'Actions', render: (a) => (
            <div className="row">
              <button className="btn sm secondary" disabled={act.busy} onClick={() => done(() => api.post(`/partners/hub/issuance/${a.id}/retry`), 'Issuance requested again')}>Re-request issuance</button>
              {user.role === 'admin' && a.insurerId === 'ins_sandbox' && (
                <>
                  <button className="btn sm" disabled={act.busy} onClick={() => decide(a, 'issued')}>Issue (sandbox)</button>
                  <button className="btn sm ghost" disabled={act.busy} onClick={() => decide(a, 'declined')}>Decline (sandbox)</button>
                </>
              )}
            </div>
          ) },
        ]} />
        <p className="pt-muted-sm">Real insurers decide in their partner portal or via their API. VHC admins can act only for the synthetic sandbox insurer.</p>
      </Card>
      <Card title={`Failed event deliveries (${x.events.length})`}>
        {x.events.length === 0 ? <Empty>No failing deliveries.</Empty> : (
          <Table rows={x.events} columns={[
            { key: 'occurredAt', label: 'When', render: (e) => dateTime(e.occurredAt) }, { key: 'type', label: 'Type', render: (e) => <code>{e.type}</code> },
            { key: 'kind', label: 'State', render: (e) => <Badge kind={e.kind === 'dead_letter' ? 'error' : 'warn'}>{e.kind}</Badge> },
            { key: 'errors', label: 'Errors', render: (e) => e.errors.map((d) => `${d.handler}: ${d.lastError} (${d.attempts})`).join('; ') },
            { key: 'replay', label: '', render: (e) => <button className="btn sm" disabled={act.busy} onClick={() => done(() => api.post('/partners/hub/events/retry', { eventId: e.id }), 'Replayed')}>Replay</button> },
          ]} />
        )}
      </Card>
    </>
  );
}

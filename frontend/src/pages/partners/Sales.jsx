// Sales leads & pipeline (sales_manager, agent): pipeline board, assignment, follow-ups, explainable lead
// score and the conversion funnel.
import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, Modal, PageHeader, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { bp } from './common.jsx';

const interestLabel = (i) => (i?.startsWith('category:') ? titleCase(i.slice(9)) : i);

export default function Sales() {
  const { user } = useAuth();
  const manager = ['sales_manager', 'admin'].includes(user.role);
  const [view, setView] = useState('pipeline');
  const [assignee, setAssignee] = useState(manager ? '' : 'me');
  const [due, setDue] = useState(false);
  const [q, setQ] = useState('');
  const res = useLoad(() => api.get(`/partners/sales/leads?${new URLSearchParams({ ...(assignee && { assignee }), ...(due && { due: '1' }), ...(q && { q }) })}`), [assignee, due, q]);
  const team = useLoad(() => api.get('/partners/sales/team'));
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const leads = res.data?.leads || [];
  const dueCount = leads.filter((l) => l.followUpDue).length;
  return (
    <>
      <PageHeader title="Leads & pipeline" subtitle="Enquiries from the website and phone, ordered by an explainable score." actions={<button className="btn" onClick={() => setAdding(true)}>Add phone enquiry</button>} />
      <Alert kind="info"><strong>Mis-selling guard:</strong> lead scores and product rankings are never boosted by insurer commission or remuneration. Recommend on the customer's need only and always share the insurer's CIS and policy wording.</Alert>
      {dueCount > 0 && <Alert kind="warn">{dueCount} follow-up(s) due today or overdue.</Alert>}
      <Tabs value={view} onChange={setView} tabs={[{ value: 'pipeline', label: 'Pipeline' }, { value: 'funnel', label: 'Conversion funnel' }]} />
      {view === 'pipeline' ? (
        <>
          <div className="filter-bar">
            <label>Assigned to
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                {manager && <option value="">Everyone</option>}
                <option value="me">Me</option>
                <option value="unassigned">Unassigned</option>
                {manager && (team.data || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label>Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, reference, city" /></label>
            <label className="check" style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={due} onChange={(e) => setDue(e.target.checked)} /> Follow-up due</label>
          </div>
          {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
            <div className="pt-pipeline" role="list" aria-label="Lead pipeline">
              {res.data.statuses.map((s) => {
                const col = leads.filter((l) => l.status === s);
                return (
                  <section key={s} className="pt-col" role="listitem" aria-label={`${s}: ${col.length}`}>
                    <h4><span>{s}</span><span className="badge">{col.length}</span></h4>
                    {col.map((l) => (
                      <button type="button" key={l.id} className="pt-lead" onClick={() => setOpen(l.id)}>
                        <span className="score" title="Lead score">{l.score.total}</span>
                        <strong>{l.name}</strong>
                        <small>{interestLabel(l.interest)}{l.city ? ` · ${l.city}` : ''}</small>
                        <small>{l.assignee ? l.assignee.name : 'Unassigned'}{l.followUpAt ? ` · follow up ${date(l.followUpAt)}` : ''}</small>
                        {l.followUpDue && <Badge kind="warn">Due</Badge>} {l.duplicateOf && <Badge>Possible duplicate</Badge>}
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </>
      ) : <Funnel />}
      {open && <LeadDetail id={open} team={team.data || []} manager={manager} me={user} onClose={() => { setOpen(null); res.reload(); }} />}
      <NewLead open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); res.reload(); }} />
    </>
  );
}

function Funnel() {
  const [range, setRange] = useState({ from: '', to: '' });
  const res = useLoad(() => api.get(`/partners/sales/funnel?${new URLSearchParams(Object.entries(range).filter(([, v]) => v))}`), [range.from, range.to]);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const f = res.data;
  const max = Math.max(1, ...f.stages.map((s) => s.count));
  return (
    <div className="grid grid-2">
      <Card title="Leads → quotes → proposals → issued">
        <div className="filter-bar">
          <label>From<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label>To<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        </div>
        <div className="pt-funnel">
          {f.stages.map((s) => (
            <div key={s.key} className="bar">
              <span>{s.label}</span>
              <span className="track" aria-hidden="true"><span className="fill" style={{ display: 'block', width: `${(s.count / max) * 100}%` }} /></span>
              <strong>{s.count}</strong>
            </div>
          ))}
        </div>
        <p className="pt-muted-sm">{f.note}</p>
      </Card>
      <Card title="Pipeline">
        <KV items={[...Object.entries(f.pipeline).map(([k, v]) => [k, v]), ['Won rate', bp(f.wonRateBp)], ['Proposals awaiting insurer issuance', f.awaitingIssuance]]} />
      </Card>
    </div>
  );
}

function LeadDetail({ id, team, manager, me, onClose }) {
  const res = useLoad(() => api.get(`/partners/sales/leads/${id}`), [id]);
  const act = useAction();
  const [note, setNote] = useState('');
  const l = res.data;
  const patch = (body, msg) => act.run(async () => { const r = await api.patch(`/partners/sales/leads/${id}`, body); res.setData(r); setNote(''); return r; }, msg);
  return (
    <Modal open large title={l ? `${l.name} · ${l.reference}` : 'Lead'} onClose={onClose}>
      {!l ? <Loading /> : (
        <>
          {act.message && <Alert kind="ok">{act.message}</Alert>}
          <ErrorBox error={act.error} />
          <div className="grid grid-2">
            <div>
              <KV items={[['Status', <Badge key="s">{l.status}</Badge>], ['Mobile', <a key="m" href={`tel:${l.mobile}`}>{l.mobile}</a>], ['Email', l.email || '—'], ['City', l.city || '—'],
                ['Interest', interestLabel(l.interest)], ['Source', l.source], ['Created', dateTime(l.createdAt)], ['Consent', l.consent?.given ? `Given ${dateTime(l.consent.at)}` : 'Missing'],
                ['Assigned', l.assignee?.name || 'Unassigned'], ['Follow-up', l.followUpAt ? date(l.followUpAt) : '—']]} />
            </div>
            <div>
              <h4 style={{ marginTop: 0 }}>Lead score: {l.score.total}/100</h4>
              <ul className="pt-factors">{l.score.factors.map((x) => <li key={x.factor} className={x.points < 0 ? 'neg' : ''}><span>{x.factor}</span><span>{x.points > 0 ? `+${x.points}` : x.points}</span></li>)}</ul>
              <p className="pt-muted-sm">{l.score.note}</p>
            </div>
          </div>
          <div className="form-grid" style={{ marginTop: '1rem' }}>
            <Field label="Move to stage">
              <select value={l.status} disabled={act.busy} onChange={(e) => {
                const status = e.target.value;
                const why = status === 'Lost' ? window.prompt('Why was this lead lost?') : note;
                if (status === 'Lost' && !why) return;
                patch({ status, note: why || undefined }, `Moved to ${status}`);
              }}>{['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'].map((s) => <option key={s}>{s}</option>)}</select>
            </Field>
            <Field label="Assign to">
              <select value={l.assignedTo || ''} disabled={act.busy} onChange={(e) => patch({ assignedTo: e.target.value || null }, 'Assignment updated')}>
                <option value="">Unassigned</option>
                {(manager ? team : team.filter((t) => t.id === me.id)).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.role === 'agent' ? 'Sales executive' : 'Sales manager'})</option>)}
              </select>
            </Field>
            <Field label="Follow-up reminder"><input type="date" value={l.followUpAt || ''} onChange={(e) => patch({ followUpAt: e.target.value || null }, 'Reminder set')} /></Field>
            <Field label="Add note" className="full"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="row" style={{ marginTop: '.5rem' }}><button className="btn sm" disabled={act.busy || !note.trim()} onClick={() => patch({ note }, 'Note added')}>Save note</button></div>
          {l.notes.length > 0 && <><h4>Notes</h4><ul>{l.notes.map((n, k) => <li key={k}><small className="muted">{dateTime(n.at)} · {n.by}</small> — {n.note}</li>)}</ul></>}
          <h4>History</h4>
          <Timeline items={l.history} />
        </>
      )}
    </Modal>
  );
}

function NewLead({ open, onClose, onDone }) {
  const [f, setF] = useState({ name: '', mobile: '', email: '', city: '', interest: '', consent: false });
  const act = useAction();
  const errs = act.error?.details?.fields || {};
  return (
    <Modal open={open} title="Add phone enquiry" onClose={onClose}>
      <div className="form-grid">
        <Field label="Name" error={errs.name}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Mobile" error={errs.mobile}><input inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></Field>
        <Field label="Email" error={errs.email}><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="City"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label="Interest" error={errs.interest} className="full"><input value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} placeholder="e.g. family floater for 4" /></Field>
        <label className="check full"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> The caller agreed to be contacted about health insurance (consent read out and recorded)</label>
        {errs.consent && <span className="err">{errs.consent}</span>}
      </div>
      {act.error && !Object.keys(errs).length && <ErrorBox error={act.error} />}
      <div className="row end" style={{ marginTop: '1rem' }}><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.post('/partners/sales/leads', { ...f, email: f.email || undefined, source: 'phone' }); setF({ name: '', mobile: '', email: '', city: '', interest: '', consent: false }); onDone(); })}>Save lead</button></div>
    </Modal>
  );
}

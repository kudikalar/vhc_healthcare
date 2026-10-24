// Support desk (§44): customer tickets, staff helpdesk and the public knowledge base.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Table, useAction, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { useT } from './i18n.jsx';
import './enterprise.css';

const STAFF_WRITE = ['support_manager', 'support_agent', 'admin'];
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', awaiting_customer: 'Awaiting customer', escalated: 'Escalated', resolved: 'Resolved', closed: 'Closed' };

/** Plain-language explanation of the three different routes. Shown wherever tickets are raised. */
export function RoutesExplainer() {
  const t = useT();
  return (
    <section aria-labelledby="routes-h" style={{ marginBottom: '1rem' }}>
      <h2 id="routes-h" style={{ fontSize: '1.05rem' }}>{t('Which route is right for you?')}</h2>
      <div className="ent-routes">
        <div className="ent-route">
          <h3><Icon name="ticket" size={16} /> {t('Support ticket')}</h3>
          <p>Help from the VHC help desk — payments, documents, using the app, understanding your policy. Answered in the app.</p>
        </div>
        <div className="ent-route">
          <h3><Icon name="flag" size={16} /> {t('Formal grievance')}</h3>
          <p>A formal complaint about VHC's service, with acknowledgement and resolution timelines. A support ticket is <strong>not</strong> a grievance.</p>
          <Link to="/grievances">Raise a grievance →</Link>
        </div>
        <div className="ent-route">
          <h3><Icon name="scale" size={16} /> {t('Complaint to the insurer or IRDAI')}</h3>
          <p>Decisions on cover and claims are the insurer's. Complain to the insurer's grievance officer first; if unresolved, escalate via IRDAI's Bima Bharosa portal or the Insurance Ombudsman.</p>
        </div>
      </div>
    </section>
  );
}

const SlaBadges = ({ sla }) => (
  <>
    {sla.firstResponseBreached && <Badge kind="error">First response SLA breached</Badge>}
    {sla.resolutionBreached && <Badge kind="error">Resolution SLA breached</Badge>}
  </>
);

function NewTicketForm({ meta, onCreated }) {
  const t = useT();
  const [f, setF] = useState({ category: 'policy', subject: '', message: '', relatedRef: '' });
  const act = useAction();
  const fe = act.error instanceof ApiError ? act.error.fields : {};
  return (
    <form onSubmit={(e) => { e.preventDefault(); act.run(async () => { const tk = await api.post('/enterprise/support/tickets', f); onCreated(tk); }); }}>
      <div className="form-grid">
        <Field label={t('Category')} error={fe.category}>
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(meta?.categories || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Related reference (optional)" hint="Policy, claim or payment number"><input value={f.relatedRef} maxLength={60} onChange={(e) => setF({ ...f, relatedRef: e.target.value })} /></Field>
        <Field label={t('Subject')} error={fe.subject} className="full"><input required maxLength={140} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label={t('Describe the issue')} error={fe.message} className="full" hint="Never share card numbers, CVV, OTPs or passwords."><textarea required maxLength={5000} rows={5} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
      </div>
      {act.error && !Object.keys(fe).length && <ErrorBox error={act.error} />}
      {meta?.sla && <p className="muted" style={{ fontSize: '.85rem' }}>We aim to respond within {meta.sla.firstResponseHours} hours and resolve within {meta.sla.resolutionHours} hours.</p>}
      <button className="btn" disabled={act.busy}>{t('Raise a support ticket')}</button>
    </form>
  );
}

/** Customer's own tickets (used on /support and /support/tickets). */
export function MyTickets({ compact = false }) {
  const t = useT();
  const nav = useNavigate();
  const res = useLoad(() => api.get('/enterprise/support/tickets'));
  const meta = useLoad(() => api.get('/enterprise/support/meta'));
  const [open, setOpen] = useState(false);
  return (
    <Card title={t('My tickets')} actions={<button className="btn sm" onClick={() => setOpen(true)}>{t('New ticket')}</button>}>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <Table rows={compact ? res.data.slice(0, 5) : res.data} empty="You have no support tickets." onRowClick={(tk) => nav(`/support/tickets/${tk.id}`)} columns={[
          { key: 'reference', label: 'Ticket', render: (tk) => <code>{tk.reference}</code> },
          { key: 'subject', label: t('Subject') },
          { key: 'category', label: t('Category'), render: (tk) => tk.categoryLabel },
          { key: 'status', label: t('Status'), render: (tk) => <Badge>{STATUS_LABEL[tk.status] || tk.status}</Badge> },
          { key: 'updatedAt', label: 'Updated', render: (tk) => dateTime(tk.updatedAt) },
        ]} />
      )}
      {compact && res.data?.length > 5 && <Link to="/support/tickets">All tickets →</Link>}
      <Modal open={open} title={t('Raise a support ticket')} onClose={() => setOpen(false)} large>
        <Alert kind="info">A support ticket is not a formal grievance or a complaint to your insurer/IRDAI. See “Which route is right for you?” on the Support page.</Alert>
        <NewTicketForm meta={meta.data} onCreated={(tk) => { setOpen(false); nav(`/support/tickets/${tk.id}`); }} />
      </Modal>
    </Card>
  );
}

export function CustomerTicketsPage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t('Support tickets')} subtitle="Questions and service requests to the VHC help desk." />
      <RoutesExplainer />
      <MyTickets />
    </>
  );
}

function Thread({ ticket }) {
  return (
    <div className="ent-thread" aria-live="polite">
      {ticket.messages.map((m) => (
        <div key={m.id} className={`ent-msg ${m.internal ? 'internal' : m.authorRole !== 'customer' ? 'staff' : ''}`}>
          <div className="meta">{m.authorName} · {m.authorRole === 'customer' ? 'Customer' : titleCase(m.authorRole)} · {dateTime(m.createdAt)}{m.internal && ' · internal note (not visible to the customer)'}{m.channel === 'email' && ' · via email'}</div>
          <p>{m.body}</p>
        </div>
      ))}
    </div>
  );
}

function Reply({ ticket, onDone, staff }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const act = useAction();
  if (ticket.status === 'closed') return <p className="muted">This ticket is closed.</p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); act.run(async () => { const r = await api.post(`/enterprise/support/tickets/${ticket.id}/messages`, { body, internal }); setBody(''); onDone(r); }); }} style={{ marginTop: '1rem' }}>
      <Field label={staff ? 'Reply' : 'Add a message'}><textarea rows={3} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} required /></Field>
      {staff && <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (hidden from the customer)</label>}
      <ErrorBox error={act.error} />
      <button className="btn" disabled={act.busy || !body.trim()} style={{ marginTop: '.5rem' }}>Send</button>
    </form>
  );
}

export function CustomerTicketPage() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/enterprise/support/tickets/${id}`), [id]);
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const tk = res.data;
  return (
    <>
      <PageHeader title={`${tk.reference}: ${tk.subject}`} subtitle={`${tk.categoryLabel} · raised ${dateTime(tk.createdAt)}`}
        actions={!['closed'].includes(tk.status) && <button className="btn secondary" disabled={act.busy} onClick={() => act.run(async () => res.setData(await api.post(`/enterprise/support/tickets/${tk.id}/close`)))}>Close ticket</button>} />
      <div className="row" style={{ marginBottom: '1rem' }}><Badge>{STATUS_LABEL[tk.status]}</Badge>{tk.escalation && <Badge kind="info">With {tk.escalation.label}</Badge>}</div>
      <Alert kind="info">Not satisfied with the answer? You can raise a <Link to="/grievances">formal grievance</Link>. Decisions about cover or claims can be taken up with your insurer and, if unresolved, IRDAI's Bima Bharosa or the Insurance Ombudsman.</Alert>
      <Card title="Conversation">
        <Thread ticket={tk} />
        <Reply ticket={tk} onDone={(r) => res.setData(r)} />
      </Card>
      <Link to="/support/tickets">← All my tickets</Link>
    </>
  );
}

// ---------------------------------------------------------------- staff helpdesk
export function Helpdesk() {
  const t = useT();
  const { user } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ status: '', category: '', assignee: '', q: '', breached: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/enterprise/support/tickets?${qs}`), [qs]);
  const meta = useLoad(() => api.get('/enterprise/support/meta'));
  const [email, setEmail] = useState(null);
  const [sla, setSla] = useState(null);
  const act = useAction();
  const canWrite = STAFF_WRITE.includes(user.role);
  const rows = res.data || [];
  const count = (fn) => rows.filter(fn).length;
  return (
    <>
      <PageHeader title={t('Helpdesk')} subtitle="Customer support tickets with SLA tracking. Formal grievances are handled separately in the grievance process."
        actions={canWrite && (
          <>
            <button className="btn secondary" onClick={() => setEmail({ from: 'customer@vhc.test', subject: '', body: '' })}>Simulate inbound email</button>
            {['admin', 'support_manager'].includes(user.role) && <button className="btn secondary" onClick={() => setSla({ ...meta.data?.sla })}>SLA settings</button>}
            <Link className="btn secondary" to="/support/kb">{t('Knowledge base')}</Link>
          </>
        )} />
      {!canWrite && <Alert kind="info">Read-only view.</Alert>}
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <div className="ent-kpis" style={{ marginBottom: '1rem' }}>
        {[['Open', count((x) => !['resolved', 'closed'].includes(x.status))], ['Unassigned', count((x) => !x.assigneeId && !['resolved', 'closed'].includes(x.status))], ['Escalated', count((x) => x.status === 'escalated')], ['SLA breached', count((x) => x.sla.firstResponseBreached || x.sla.resolutionBreached)]].map(([l, v]) => (
          <div key={l} className="ent-kpi"><div className="label">{l} (in view)</div><div className="value">{v}</div></div>
        ))}
      </div>
      <form className="ent-filters" onSubmit={(e) => e.preventDefault()}>
        <Field label="Search"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Reference, subject, customer" /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{Object.entries(meta.data?.categories || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Assignee"><select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option></select></Field>
        <label className="check"><input type="checkbox" checked={f.breached === '1'} onChange={(e) => setF({ ...f, breached: e.target.checked ? '1' : '' })} /> SLA breached only</label>
      </form>
      <Card>
        {res.loading && !res.data ? <Loading /> : (
          <Table rows={rows} empty="No tickets match." onRowClick={(tk) => nav(`/helpdesk/tickets/${tk.id}`)} columns={[
            { key: 'reference', label: 'Ticket', render: (tk) => <><code>{tk.reference}</code>{tk.channel !== 'web' && <div className="muted">{titleCase(tk.channel)}</div>}</> },
            { key: 'subject', label: 'Subject', render: (tk) => <><strong>{tk.subject}</strong><div className="muted">{tk.customerName}</div></> },
            { key: 'category', label: 'Category', render: (tk) => tk.categoryLabel },
            { key: 'priority', label: 'Priority', render: (tk) => <Badge kind={tk.priority === 'urgent' ? 'error' : tk.priority === 'high' ? 'warn' : ''}>{tk.priority}</Badge> },
            { key: 'status', label: 'Status', render: (tk) => <><Badge>{STATUS_LABEL[tk.status]}</Badge> <SlaBadges sla={tk.sla} /></> },
            { key: 'assigneeName', label: 'Assignee', render: (tk) => tk.assigneeName || <span className="muted">Unassigned</span> },
            { key: 'due', label: 'Due', render: (tk) => <small>Reply by {dateTime(tk.sla.firstResponseDueAt)}<br />Resolve by {dateTime(tk.sla.resolutionDueAt)}</small> },
          ]} />
        )}
      </Card>
      <Modal open={!!email} title="Simulate inbound email (email-to-ticket)" onClose={() => setEmail(null)}>
        {email && (
          <form onSubmit={(e) => { e.preventDefault(); act.run(async () => { const r = await api.post('/enterprise/support/email-inbound', email); setEmail(null); res.reload(); return r; }, (r) => (r.threaded ? `Added to ${r.ticket.reference}` : `Created ${r.ticket.reference}`)); }}>
            <p className="muted" style={{ fontSize: '.88rem' }}>Emails from a registered customer address create a ticket; a subject containing an existing reference (e.g. “Re: [TKT-000001]”) is added to that thread.</p>
            <div className="form-grid">
              <Field label="From" className="full"><input type="email" value={email.from} onChange={(e) => setEmail({ ...email, from: e.target.value })} required /></Field>
              <Field label="Subject" className="full"><input value={email.subject} onChange={(e) => setEmail({ ...email, subject: e.target.value })} required /></Field>
              <Field label="Body" className="full"><textarea rows={4} value={email.body} onChange={(e) => setEmail({ ...email, body: e.target.value })} required /></Field>
            </div>
            <ErrorBox error={act.error} />
            <div className="row end" style={{ marginTop: '.8rem' }}><button className="btn" disabled={act.busy}>Deliver email</button></div>
          </form>
        )}
      </Modal>
      <Modal open={!!sla} title="Support SLA" onClose={() => setSla(null)}>
        {sla && (
          <form onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.put('/enterprise/support/sla', { firstResponseHours: Number(sla.firstResponseHours), resolutionHours: Number(sla.resolutionHours) }); setSla(null); meta.reload(); }, 'SLA updated for new tickets'); }}>
            <div className="form-grid">
              <Field label="First response (hours)"><input type="number" min="1" max="72" value={sla.firstResponseHours} onChange={(e) => setSla({ ...sla, firstResponseHours: e.target.value })} /></Field>
              <Field label="Resolution (hours)"><input type="number" min="1" max="720" value={sla.resolutionHours} onChange={(e) => setSla({ ...sla, resolutionHours: e.target.value })} /></Field>
            </div>
            <ErrorBox error={act.error} />
            <div className="row end" style={{ marginTop: '.8rem' }}><button className="btn" disabled={act.busy}>Save</button></div>
          </form>
        )}
      </Modal>
    </>
  );
}

export function HelpdeskTicket() {
  const { id } = useParams();
  const { user } = useAuth();
  const res = useLoad(() => api.get(`/enterprise/support/tickets/${id}`), [id]);
  const meta = useLoad(() => api.get('/enterprise/support/meta'));
  const canWrite = STAFF_WRITE.includes(user.role);
  const agents = useLoad(() => (canWrite ? api.get('/enterprise/support/agents') : Promise.resolve([])));
  const [esc, setEsc] = useState(null);
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const tk = res.data;
  const post = (path, body, msg) => act.run(async () => res.setData(await api.post(`/enterprise/support/tickets/${tk.id}/${path}`, body)), msg);
  return (
    <>
      <PageHeader title={`${tk.reference}: ${tk.subject}`} subtitle={`${tk.customerName} · ${tk.categoryLabel} · via ${titleCase(tk.channel)} · ${dateTime(tk.createdAt)}`} actions={<Link className="btn secondary" to="/helpdesk">← Queue</Link>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <div className="ent-split">
        <Card title="Conversation">
          <Thread ticket={tk} />
          {canWrite && <Reply ticket={tk} staff onDone={(r) => res.setData(r)} />}
        </Card>
        <div className="stack">
          <Card title="Ticket">
            <dl className="kv">
              <dt>Status</dt><dd><Badge>{STATUS_LABEL[tk.status]}</Badge></dd>
              <dt>Priority</dt><dd>{tk.priority}</dd>
              <dt>Assignee</dt><dd>{tk.assigneeName || 'Unassigned'}</dd>
              <dt>Related</dt><dd>{tk.relatedRef || '—'}</dd>
              <dt>First response due</dt><dd>{dateTime(tk.sla.firstResponseDueAt)} {tk.sla.firstRespondedAt ? <Badge kind={tk.sla.firstResponseBreached ? 'error' : 'ok'}>{tk.sla.firstResponseBreached ? 'late' : 'met'}</Badge> : tk.sla.firstResponseBreached && <Badge kind="error">breached</Badge>}</dd>
              <dt>Resolution due</dt><dd>{dateTime(tk.sla.resolutionDueAt)} {tk.sla.resolutionBreached && <Badge kind="error">breached</Badge>}</dd>
              {tk.escalation && <><dt>Escalated to</dt><dd>{tk.escalation.label}: {tk.escalation.note}</dd></>}
            </dl>
          </Card>
          {canWrite && (
            <Card title="Actions">
              <div className="stack">
                <Field label="Status"><select value={tk.status} onChange={(e) => post('status', { status: e.target.value }, 'Status updated')}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Priority"><select value={tk.priority} onChange={(e) => post('priority', { priority: e.target.value }, 'Priority updated')}>{(meta.data?.priorities || []).map((p) => <option key={p}>{p}</option>)}</select></Field>
                <Field label="Assign to">
                  <select value={tk.assigneeId || ''} onChange={(e) => post('assign', { assigneeId: e.target.value || null }, 'Assignment updated')}>
                    <option value="">Unassigned</option>
                    {(agents.data || []).filter((a) => user.role !== 'support_agent' || a.id === user.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
                <button className="btn secondary" onClick={() => setEsc({ type: 'insurance_specialist', note: '' })}>Escalate…</button>
              </div>
            </Card>
          )}
          <Card title="History">
            <ul className="ent-list">{[...tk.history].reverse().map((h, i) => <li key={i}><small className="muted">{dateTime(h.at)} · {h.by}</small><div>{STATUS_LABEL[h.status] || h.status}{h.note ? ` — ${h.note}` : ''}</div></li>)}</ul>
          </Card>
        </div>
      </div>
      <Modal open={!!esc} title="Escalate ticket" onClose={() => setEsc(null)}>
        {esc && (
          <form onSubmit={(e) => { e.preventDefault(); post('escalate', esc, 'Escalated').then(() => setEsc(null)); }}>
            <div className="form-grid">
              <Field label="Escalate to"><select value={esc.type} onChange={(e) => setEsc({ ...esc, type: e.target.value })}>{Object.entries(meta.data?.escalations || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Note for the team" className="full"><textarea rows={3} value={esc.note} onChange={(e) => setEsc({ ...esc, note: e.target.value })} required /></Field>
            </div>
            <div className="row end" style={{ marginTop: '.8rem' }}><button className="btn" disabled={act.busy}>Escalate</button></div>
          </form>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- knowledge base (public)
export function KnowledgeBase() {
  const t = useT();
  const res = useLoad(() => api.get('/enterprise/support/kb'));
  return (
    <>
      <PageHeader title={t('Knowledge base')} subtitle="Plain-language guides about payments, claims, your data and getting help." />
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
        <div className="lpx-articles">
          {res.data.map((a) => (
            <Link key={a.slug} className="lpx-cat" to={`/support/kb/${a.slug}`}>
              <span className="ent-pill">{a.category}</span>
              <h3>{a.title}</h3>
              <p>{a.summary}</p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function KbArticle() {
  const { slug } = useParams();
  const res = useLoad(() => api.get(`/enterprise/support/kb/${slug}`), [slug]);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <>
      <PageHeader title={res.data.title} subtitle={res.data.category} />
      <Card>{res.data.body.map((p, i) => <p key={i}>{p}</p>)}</Card>
      {!res.data.body.length && <Empty>Nothing here yet.</Empty>}
      <Link to="/support/kb">← All articles</Link>
    </>
  );
}

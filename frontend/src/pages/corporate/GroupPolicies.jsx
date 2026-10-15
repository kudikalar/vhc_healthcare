// Group policies (/corporate/policies, /corporate/policies/:id): quotations, policy set-up with the
// sandbox insurer, enrolment windows, bulk enrolment, certificates, renewals and the insurer
// confirmation queue.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { date, dateTime, money } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, useAction, useLoad } from '../../components/ui.jsx';
import { BackLink, downloadPdf, empType, EmployerPicker, lakh, pctBp, Progress, SandboxNote, useCorpRole, useEmployerScope, useMeta } from './shared.jsx';

const addDaysIso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function GroupPolicies() {
  const scope = useEmployerScope({ allowAll: true });
  const role = useCorpRole();
  const nav = useNavigate();
  const res = useLoad(() => api.get(`/corporate/group-policies${scope.qs()}`), [scope.employerId]);
  const [modal, setModal] = useState(null);
  return (
    <>
      <PageHeader title="Group policies" subtitle="Employer group health cover placed with the sandbox insurer." actions={role.manage && (
        <div className="corp-actions">
          <button className="btn secondary" onClick={() => setModal('quote')}>New quotation</button>
          <button className="btn" onClick={() => setModal('policy')}>New group policy</button>
        </div>
      )} />
      <SandboxNote>Only the synthetic “Group Medical (Sandbox)” product of the VHC Sandbox Insurer (Synthetic) is available. Rates are illustrative.</SandboxNote>
      <div className="corp-toolbar"><span /><EmployerPicker scope={scope} allowAll /></div>
      <Card>
        {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No group policies yet." onRowClick={(p) => nav(`/corporate/policies/${p.id}${scope.corp ? '' : `?employer=${p.employerId}`}`)} columns={[
            { key: 'policyNumber', label: 'Policy', render: (p) => <><strong>{p.policyNumber}</strong>{!scope.corp && <div className="muted">{p.employerName}</div>}</> },
            { key: 'productName', label: 'Product', render: (p) => <>{p.productName}<div className="muted">{p.insurerName}</div></> },
            { key: 'si', label: 'Cover', render: (p) => <>{lakh(p.terms.sumInsured)}<div className="muted">{p.terms.familyLabel}</div></> },
            { key: 'period', label: 'Period', render: (p) => `${date(p.startDate)} – ${date(p.endDate)}` },
            { key: 'status', label: 'Status', render: (p) => <Badge>{p.status}</Badge> },
            { key: 'enrolled', label: 'Enrolled', render: (p) => <div style={{ minWidth: 110 }}>{p.stats.enrolled}/{p.stats.eligible} · {pctBp(p.stats.completionBp)}<Progress bp={p.stats.completionBp} label="Enrolment completion" /></div> },
          ]} />
        )}
      </Card>
      {(role.manage || role.readOnly || role.user?.role === 'insurer_admin') && <ConfirmationQueue canDecide={role.manage} />}
      {modal === 'quote' && <QuoteModal scope={scope} onClose={() => setModal(null)} />}
      {modal === 'policy' && <PolicyModal scope={scope} onClose={() => setModal(null)} onDone={(p) => { setModal(null); nav(`/corporate/policies/${p.id}?employer=${p.employerId}`); }} />}
    </>
  );
}

export function ConfirmationQueue({ canDecide }) {
  const res = useLoad(() => api.get('/corporate/confirmations?status=pending'), []);
  const act = useAction();
  const decide = (c, decision) => {
    const reason = decision === 'rejected' ? window.prompt('Reason for rejecting (shown to the employer)') : '';
    if (decision === 'rejected' && !reason) return;
    act.run(async () => { await api.post(`/corporate/confirmations/${c.id}/decision`, { decision, reason }); res.reload(); }, decision === 'confirmed' ? 'Confirmed on behalf of the sandbox insurer' : 'Rejected');
  };
  return (
    <Card title="Awaiting sandbox insurer confirmation" actions={<small className="muted">Issuance mode “manual” keeps requests here until decided</small>}>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {res.loading && !res.data ? <Loading /> : (
        <Table rows={res.data || []} empty="Nothing is waiting for the insurer." columns={[
          { key: 'reference', label: 'Request' }, { key: 'kind', label: 'Type', render: (c) => c.kind.replace('_', ' ') },
          { key: 'refNumber', label: 'Reference', render: (c) => c.refNumber || '—' }, { key: 'employerName', label: 'Employer' },
          { key: 'requestedAt', label: 'Requested', render: (c) => dateTime(c.requestedAt) },
          { key: 'x', label: '', render: (c) => canDecide && <div className="corp-actions"><button className="btn sm" disabled={act.busy} onClick={() => decide(c, 'confirmed')}>Confirm</button><button className="btn sm danger" disabled={act.busy} onClick={() => decide(c, 'rejected')}>Reject</button></div> },
        ]} />
      )}
    </Card>
  );
}

function QuoteModal({ scope, onClose }) {
  const meta = useMeta();
  const product = meta.data?.products?.[0];
  const [f, setF] = useState({ employerId: scope.employerId || 'emp_demo', sumInsured: '', familyDefinition: 'ESC', startDate: addDaysIso(30), fromRoster: true, census: {} });
  const act = useAction();
  const [quote, setQuote] = useState(null);
  if (!product) return null;
  const si = f.sumInsured || product.sumInsuredOptions[1];
  const submit = () => act.run(async () => {
    const body = { employerId: f.employerId, productId: product.id, sumInsured: Number(si), familyDefinition: f.familyDefinition, startDate: f.startDate, fromRoster: f.fromRoster };
    if (!f.fromRoster) body.census = product.ageBands.map((b) => ({ band: b.band, lives: Number(f.census[b.band] || 0) }));
    setQuote(await api.post('/corporate/quotes', body));
  });
  return (
    <Modal open title="Group quotation (census-based)" onClose={onClose} large>
      <ErrorBox error={act.error} />
      <div className="form-grid">
        <Field label="Employer"><select value={f.employerId} onChange={(e) => setF({ ...f, employerId: e.target.value })}>{(meta.data.employers || []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Sum insured"><select value={si} onChange={(e) => setF({ ...f, sumInsured: e.target.value })}>{product.sumInsuredOptions.map((o) => <option key={o} value={o}>{lakh(o)}</option>)}</select></Field>
        <Field label="Family definition"><select value={f.familyDefinition} onChange={(e) => setF({ ...f, familyDefinition: e.target.value })}>{Object.entries(meta.data.familyDefinitions).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Policy start"><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <label className="corp-check full"><input type="checkbox" checked={f.fromRoster} onChange={(e) => setF({ ...f, fromRoster: e.target.checked })} /> Use the employer's current roster (employees + eligible dependents) as the census</label>
        {!f.fromRoster && product.ageBands.map((b) => (
          <Field key={b.band} label={`Lives aged ${b.band}`}><input type="number" min="0" value={f.census[b.band] || ''} onChange={(e) => setF({ ...f, census: { ...f.census, [b.band]: e.target.value } })} /></Field>
        ))}
      </div>
      <div className="row end" style={{ marginTop: '.75rem' }}><button className="btn" disabled={act.busy} onClick={submit}>Calculate quotation</button></div>
      {quote && <QuoteView q={quote} />}
    </Modal>
  );
}

export function QuoteView({ q }) {
  return (
    <div style={{ marginTop: '1rem' }}>
      <h4 style={{ margin: '0 0 .4rem' }}>{q.quoteNumber} · valid until {date(q.validUntil)}</h4>
      <table className="calc">
        <thead><tr><th>Age band</th><th className="num">Lives</th><th className="num">Per life</th><th className="num">Premium</th></tr></thead>
        <tbody>
          {q.lines.map((l) => <tr key={l.band}><td>{l.band}</td><td className="num">{l.lives}</td><td className="num">{money(l.perLife)}</td><td className="num">{money(l.premium)}</td></tr>)}
          <tr className="sub"><td>Net premium</td><td className="num">{q.lives}</td><td /><td className="num">{money(q.netPremium)}</td></tr>
          <tr><td>GST @ 18%</td><td /><td /><td className="num">{money(q.gst)}</td></tr>
          <tr className="total"><td>Total annual premium</td><td /><td /><td className="num">{money(q.total)}</td></tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: '.82rem' }}>{q.label}</p>
    </div>
  );
}

function PolicyModal({ scope, onClose, onDone }) {
  const meta = useMeta();
  const product = meta.data?.products?.[0];
  const [f, setF] = useState({
    employerId: scope.employerId || 'emp_demo', quoteId: '', sumInsured: '', familyDefinition: 'ESC', startDate: addDaysIso(15),
    employmentTypes: ['full_time', 'contract'], minServiceDays: '0', grades: '', maxChildren: '2', childMaxAge: '25', parentMaxAge: '80', opensOn: addDaysIso(0), closesOn: addDaysIso(45),
  });
  const quotes = useLoad(() => (f.employerId ? api.get(`/corporate/quotes?employerId=${f.employerId}`) : []), [f.employerId]);
  const act = useAction();
  if (!product) return null;
  const fe = act.error?.fields || {};
  const toggle = (t) => setF({ ...f, employmentTypes: f.employmentTypes.includes(t) ? f.employmentTypes.filter((x) => x !== t) : [...f.employmentTypes, t] });
  const submit = () => act.run(async () => {
    const q = quotes.data?.find((x) => x.id === f.quoteId);
    const p = await api.post('/corporate/group-policies', {
      employerId: f.employerId, productId: product.id, quoteId: f.quoteId || undefined, sumInsured: Number(f.sumInsured || q?.sumInsured || product.sumInsuredOptions[1]),
      familyDefinition: f.familyDefinition, startDate: f.startDate,
      eligibility: { employmentTypes: f.employmentTypes, minServiceDays: Number(f.minServiceDays), grades: f.grades },
      dependentRules: { maxChildren: Number(f.maxChildren), childMaxAge: Number(f.childMaxAge), parentMaxAge: Number(f.parentMaxAge) },
      enrolmentWindow: { opensOn: f.opensOn, closesOn: f.closesOn },
    });
    onDone(p);
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open title="New group policy (sandbox insurer)" onClose={onClose} large>
      <ErrorBox error={act.error} />
      <div className="form-grid">
        <Field label="Employer" error={fe.employerId}><select value={f.employerId} onChange={set('employerId')}>{(meta.data.employers || []).map((e) => <option key={e.id} value={e.id}>{e.name} ({e.status})</option>)}</select></Field>
        <Field label="From quotation (optional)" error={fe.quoteId}>
          <select value={f.quoteId} onChange={(e) => { const q = quotes.data?.find((x) => x.id === e.target.value); setF({ ...f, quoteId: e.target.value, ...(q ? { sumInsured: String(q.sumInsured), familyDefinition: q.familyDefinition, startDate: q.startDate } : {}) }); }}>
            <option value="">—</option>{(quotes.data || []).map((q) => <option key={q.id} value={q.id}>{q.quoteNumber} · {money(q.total)}</option>)}
          </select>
        </Field>
        <Field label="Sum insured" error={fe.sumInsured}><select value={f.sumInsured || product.sumInsuredOptions[1]} onChange={set('sumInsured')}>{product.sumInsuredOptions.map((o) => <option key={o} value={o}>{lakh(o)}</option>)}</select></Field>
        <Field label="Family definition" error={fe.familyDefinition}><select value={f.familyDefinition} onChange={set('familyDefinition')}>{Object.entries(meta.data.familyDefinitions).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Policy start (1-year term)" error={fe.startDate}><input type="date" value={f.startDate} onChange={set('startDate')} /></Field>
        <Field label="Minimum service (days)" error={fe['eligibility.minServiceDays']}><input type="number" min="0" max="365" value={f.minServiceDays} onChange={set('minServiceDays')} /></Field>
        <Field label="Eligible grades" hint="Comma-separated; blank = all grades"><input value={f.grades} onChange={set('grades')} /></Field>
        <fieldset className="full" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: '.9rem' }}>Eligible employment types</legend>
          <div className="row">{meta.data.employmentTypes.map((t) => <label key={t} className="corp-check"><input type="checkbox" checked={f.employmentTypes.includes(t)} onChange={() => toggle(t)} /> {empType(t)}</label>)}</div>
        </fieldset>
        <Field label="Max children" error={fe['dependentRules.maxChildren']}><input type="number" min="0" max="6" value={f.maxChildren} onChange={set('maxChildren')} /></Field>
        <Field label="Child max age" error={fe['dependentRules.childMaxAge']}><input type="number" min="0" max="26" value={f.childMaxAge} onChange={set('childMaxAge')} /></Field>
        <Field label="Parent max age" error={fe['dependentRules.parentMaxAge']}><input type="number" min="0" max="80" value={f.parentMaxAge} onChange={set('parentMaxAge')} /></Field>
        <Field label="Enrolment opens" error={fe.enrolmentWindow}><input type="date" value={f.opensOn} onChange={set('opensOn')} /></Field>
        <Field label="Enrolment closes"><input type="date" value={f.closesOn} onChange={set('closesOn')} /></Field>
      </div>
      <p className="muted" style={{ fontSize: '.85rem' }}>The policy is sent to the sandbox insurer for confirmation. Group waivers (30-day, pre-existing disease, specific illness and maternity waiting periods) are part of the synthetic product. Requires a Contracted/Active employer with an active contract covering group health.</p>
      <div className="row end"><button className="btn" disabled={act.busy} onClick={submit}>Create & send to insurer</button></div>
    </Modal>
  );
}

export function GroupPolicyDetail() {
  const { id } = useParams();
  const scope = useEmployerScope();
  const role = useCorpRole();
  const res = useLoad(() => api.get(`/corporate/group-policies/${id}`), [id]);
  const rows = useLoad(() => api.get(`/corporate/group-policies/${id}/enrolments`), [id]);
  const act = useAction();
  const [win, setWin] = useState(null);
  const [quote, setQuote] = useState(null);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <><BackLink to={`/corporate/policies${scope.suffix}`}>Group policies</BackLink><ErrorBox error={res.error} /></>;
  const p = res.data;
  const reload = () => { res.reload(); rows.reload(); };
  const run = (fn, msg) => act.run(async () => { const r = await fn(); reload(); return r; }, msg);
  const canEnrol = role.rosterWrite && !role.readOnly && p.status === 'Active';
  const notEnrolled = (rows.data || []).filter((r) => r.eligible && ['Not Enrolled', 'Rejected by Insurer'].includes(r.status));
  return (
    <>
      <BackLink to={`/corporate/policies${scope.suffix}`}>Group policies</BackLink>
      <PageHeader title={p.policyNumber} subtitle={`${p.productName} · ${p.employerName}`} actions={
        <div className="corp-actions">
          {canEnrol && <button className="btn" disabled={act.busy || !notEnrolled.length} onClick={() => run(() => api.post(`/corporate/group-policies/${p.id}/enrol`, {}), (r) => `${r.submitted.length} submitted to the insurer, ${r.skipped.length} skipped`)}>Submit all eligible ({notEnrolled.length})</button>}
          {canEnrol && <button className="btn secondary" onClick={() => setWin({ opensOn: p.enrolmentWindow?.opensOn || '', closesOn: p.enrolmentWindow?.closesOn || '' })}>Enrolment window</button>}
          {(role.manage || role.corpAdmin) && ['Active', 'Expired'].includes(p.status) && <button className="btn secondary" disabled={act.busy} onClick={() => run(async () => { const q = await api.post(`/corporate/group-policies/${p.id}/renewal-quote`); setQuote(q); return q; }, 'Renewal quotation prepared')}>Renewal quote</button>}
          {role.manage && ['Active', 'Expired'].includes(p.status) && !p.renewedBy && p.daysToEnd <= 90 && <button className="btn secondary" disabled={act.busy} onClick={() => window.confirm('Create the renewal policy for the next term and send it to the insurer?') && run(() => api.post(`/corporate/group-policies/${p.id}/renew`, {}), 'Renewal policy created')}>Renew</button>}
          {role.finance && !role.readOnly && ['Active', 'Expired'].includes(p.status) && <button className="btn secondary" disabled={act.busy} onClick={() => run(() => api.post(`/corporate/group-policies/${p.id}/invoices`), (r) => `Issued ${r.map((i) => i.invoiceNumber).join(', ')}`)}>Generate invoices</button>}
        </div>
      } />
      <SandboxNote>{p.label}</SandboxNote>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {p.status === 'Pending Insurer' && <Alert kind="warn">Waiting for the sandbox insurer to confirm this policy{p.confirmation ? ` (${p.confirmation.reference})` : ''}. Enrolment opens after confirmation.</Alert>}
      {p.status === 'Declined by Insurer' && <Alert kind="error">The insurer declined this policy: {p.declineReason}</Alert>}
      <div className="corp-kpis">
        <Stat label="Status" value={<Badge>{p.status}</Badge>} />
        <Stat label="Eligible" value={p.stats.eligible} />
        <Stat label="Enrolled" value={`${p.stats.enrolled} (${pctBp(p.stats.completionBp)})`} />
        <Stat label="Awaiting insurer" value={p.stats.pending} />
        <Stat label="Covered lives" value={p.stats.coveredLives} />
        <Stat label="Annual premium (covered)" value={money(p.stats.annualPremium)} />
      </div>
      <div className="grid grid-2 corp-grid">
        <Card title="Policy terms">
          <KV items={[
            ['Insurer', p.insurerName], ['Insurer reference', p.insurerReference || '—'], ['Sum insured', `${lakh(p.terms.sumInsured)} per employee family`],
            ['Family definition', p.terms.familyLabel], ['Policy period', `${date(p.startDate)} – ${date(p.endDate)}`],
            ['Enrolment window', <span key="w">{date(p.enrolmentWindow?.opensOn)} – {date(p.enrolmentWindow?.closesOn)} {p.windowOpen ? <Badge kind="ok">Open</Badge> : <Badge>Closed</Badge>}</span>],
            ['Eligibility', `${p.eligibility.employmentTypes.map(empType).join(', ')}; ${p.eligibility.minServiceDays} days' service${p.eligibility.grades.length ? `; grades ${p.eligibility.grades.join(', ')}` : '; all grades'}`],
            ['Dependents', `${[p.dependentRules.spouse && 'spouse', p.dependentRules.children && `up to ${p.dependentRules.maxChildren} children ≤ ${p.dependentRules.childMaxAge}`, p.dependentRules.parents && `parents ≤ ${p.dependentRules.parentMaxAge}`].filter(Boolean).join(', ') || 'employee only'}`],
            ['Premium basis', p.terms.premiumBasis],
            p.renewedBy && ['Renewed by', <Link key="r" to={`/corporate/policies/${p.renewedBy}${scope.suffix}`}>next term</Link>],
          ]} />
        </Card>
        <Card title="Group waivers & contacts">
          <ul style={{ margin: '0 0 .75rem', paddingLeft: '1.1rem' }}>{p.terms.waivers.map((w) => <li key={w.code}>{w.label}</li>)}</ul>
          <KV items={[['Insurer group desk', `${p.contacts.insurer.phone} · ${p.contacts.insurer.email}`], ['Claims helpdesk', `${p.contacts.claims.phone} · ${p.contacts.claims.email}`]]} />
          <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>Network hospitals: <Link to="/hospitals">find a hospital</Link>.</p>
        </Card>
      </div>
      <Card title="Enrolment" actions={<small className="muted">One row per employee on the roster</small>}>
        {rows.loading && !rows.data ? <Loading /> : (
          <Table rows={(rows.data || []).map((r) => ({ ...r, id: r.memberId }))} empty="No employees on the roster." columns={[
            { key: 'name', label: 'Employee', render: (r) => <><Link to={`/corporate/employees/${r.memberId}${scope.suffix}`}>{r.name}</Link><div className="muted">{r.employeeId} · {r.grade}</div></> },
            { key: 'eligible', label: 'Eligibility', render: (r) => (r.eligible ? <small>From {date(r.eligibleFrom)}</small> : <small className="muted">{r.reasons.join('; ')}</small>) },
            { key: 'status', label: 'Status', render: (r) => <><Badge>{r.status}</Badge>{r.rejectReason && <div className="muted">{r.rejectReason}</div>}</> },
            { key: 'cover', label: 'Cover', render: (r) => (r.coverFrom ? `${date(r.coverFrom)} – ${date(r.coverTo)}` : '—') },
            { key: 'lives', label: 'Lives', num: true },
            { key: 'annualPremium', label: 'Premium', num: true, render: (r) => (r.annualPremium ? money(r.annualPremium) : '—') },
            { key: 'x', label: '', render: (r) => (
              <div className="corp-actions">
                {r.certificateNumber && <button className="btn sm secondary" onClick={() => act.run(() => downloadPdf(`/corporate/enrolments/${r.enrolmentId}/certificate`, r.certificateNumber))}>Certificate</button>}
                {canEnrol && r.eligible && ['Not Enrolled', 'Rejected by Insurer'].includes(r.status) && <button className="btn sm" disabled={act.busy} onClick={() => run(() => api.post(`/corporate/group-policies/${p.id}/enrol`, { memberIds: [r.memberId] }), (x) => (x.errors.length ? x.errors[0].error : `${r.name}: submitted`))}>Submit</button>}
              </div>
            ) },
          ]} />
        )}
      </Card>
      {(quote || p.quotes?.length > 0) && (
        <Card title="Renewal quotations">
          {quote && <QuoteView q={quote} />}
          {!quote && p.quotes.map((q) => <QuoteView key={q.id} q={q} />)}
        </Card>
      )}
      <Modal open={!!win} title="Enrolment window" onClose={() => setWin(null)}>
        {win && (
          <>
            <div className="form-grid">
              <Field label="Opens"><input type="date" value={win.opensOn} onChange={(e) => setWin({ ...win, opensOn: e.target.value })} /></Field>
              <Field label="Closes"><input type="date" value={win.closesOn} onChange={(e) => setWin({ ...win, closesOn: e.target.value })} /></Field>
            </div>
            <p className="muted" style={{ fontSize: '.85rem' }}>Enrolments submitted while the window is open start from the policy start (or the employee's eligibility date). Later enrolments start on the submission date and are billed pro-rata.</p>
            <div className="row end"><button className="btn" disabled={act.busy} onClick={() => run(async () => { await api.post(`/corporate/group-policies/${p.id}/enrolment-window`, win); setWin(null); }, 'Enrolment window updated')}>Save</button></div>
          </>
        )}
      </Modal>
      {p.status === 'Active' && p.stats.eligible === 0 && <Empty>No eligible employees yet — add employees to the roster first.</Empty>}
    </>
  );
}

// Insurer registry & onboarding (admin edits; operations, compliance and auditors read only).
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, Tabs, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { BlockedTag, CandidateTag, SandboxTag, bp, minutes } from './common.jsx';

const yes = (v) => (v ? 'Yes' : 'No');
const lines = (arr, f) => (arr || []).map(f).join('\n');
const parseLines = (text, keys) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const parts = l.split('|').map((x) => x.trim());
  return Object.fromEntries(keys.map((k, i) => [k, parts[i] || '']));
});

function InsurerTags({ i }) {
  return (
    <>
      {i.candidate && <CandidateTag />}
      {i.sandbox && <SandboxTag>Synthetic sandbox</SandboxTag>}
      {i.liveSales?.regulatory && !i.candidate && <BlockedTag>{i.liveSales.label}</BlockedTag>}
    </>
  );
}

export function InsurerList() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const res = useLoad(() => api.get(`/partners/insurers${status ? `?status=${encodeURIComponent(status)}` : ''}`), [status]);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const admin = user.role === 'admin';
  return (
    <>
      <PageHeader title="Insurer partners" subtitle="Registry and onboarding pipeline. Only the synthetic sandbox insurer is active; real-name entries are candidates with no agreement."
        actions={admin && <button className="btn" onClick={() => setAdding(true)}>Add insurer</button>} />
      {!admin && <Alert kind="info">Read-only view for {user.role.replace('_', ' ')}. Changes are made by a VHC administrator and are audited.</Alert>}
      <Card>
        <div className="filter-bar">
          <label>Status
            <select value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
              <option value="">All</option>
              {(res.data?.statuses || []).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
        {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data.insurers} onRowClick={(i) => nav(`/partners/insurers/${i.id}`)} empty="No insurers match." columns={[
            { key: 'name', label: 'Insurer', render: (i) => <div><Link to={`/partners/insurers/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.name}</Link><div className="row" style={{ marginTop: '.2rem' }}><InsurerTags i={i} /></div></div> },
            { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
            { key: 'irdai', label: 'IRDAI verified', render: (i) => (i.sandbox ? <span className="pt-muted-sm">n/a (synthetic)</span> : yes(i.irdaiVerified)) },
            { key: 'agreement', label: 'Agreement', render: (i) => (i.agreementValid ? `Valid to ${date(i.agreementValidTo)}` : <span className="pt-muted-sm">None</span>) },
            { key: 'products', label: 'Products', num: true },
            { key: 'integrationStatus', label: 'Integration' },
            { key: 'tasks', label: 'Checklist', render: (i) => `${i.tasksDone}/${i.tasksTotal}` },
          ]} />
        )}
      </Card>
      <AddInsurer open={adding} onClose={() => setAdding(false)} onDone={(i) => nav(`/partners/insurers/${i.id}`)} />
    </>
  );
}

function AddInsurer({ open, onClose, onDone }) {
  const [f, setF] = useState({ name: '', legalName: '', type: 'Health', sandbox: false });
  const act = useAction();
  return (
    <Modal open={open} title="Add insurer (starts as Prospect)" onClose={onClose}>
      <Alert kind="warn">Never record a real company as a partner without a signed agreement. New insurers start as <strong>Prospect</strong> and cannot be published until Active.</Alert>
      <div className="form-grid">
        <Field label="Display name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Legal name"><input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
        <Field label="Type"><input value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} /></Field>
        <label className="check full"><input type="checkbox" checked={f.sandbox} onChange={(e) => setF({ ...f, sandbox: e.target.checked })} /> Synthetic sandbox insurer (test only; can never sell live)</label>
      </div>
      <ErrorBox error={act.error} />
      <div className="row end" style={{ marginTop: '1rem' }}><button className="btn" disabled={act.busy} onClick={() => act.run(async () => onDone(await api.post('/partners/insurers', f)))}>Create</button></div>
    </Modal>
  );
}

export function InsurerDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const res = useLoad(() => api.get(`/partners/insurers/${id}`), [id]);
  const [tab, setTab] = useState('onboarding');
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const i = res.data;
  const admin = user.role === 'admin' && !i.readOnly;
  const run = (fn, msg) => act.run(async () => { const r = await fn(); res.setData(r.insurer || r); return r; }, msg);
  const stageIdx = i.stages.indexOf(i.status);
  return (
    <>
      <PageHeader title={i.name} subtitle={<>{i.legalName} · {i.type || '—'}</>} actions={<><InsurerTags i={i} /><Badge>{i.status}</Badge></>} />
      {i.candidate && <Alert kind="error">Candidate for partnership exploration only. No commercial relationship or agreement exists. Never displayed publicly.</Alert>}
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {act.error?.details?.gates && (
        <Alert kind="warn"><strong>Gates</strong><ul className="pt-gates">{act.error.details.gates.map((g) => <li key={g.key}><span className={g.ok ? 'ok' : 'no'}>{g.ok ? '✓' : '✕'}</span> {g.label}{g.detail && ` — ${g.detail}`}</li>)}</ul></Alert>
      )}
      <ol className="pt-track" aria-label="Onboarding stages">
        {i.stages.map((s, k) => <li key={s} className={s === i.status ? 'now' : stageIdx > k ? 'done' : ''}>{s}</li>)}
        {['Suspended', 'Expired'].includes(i.status) && <li className="now">{i.status}</li>}
      </ol>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'onboarding', label: 'Onboarding' }, { value: 'profile', label: 'Profile & agreement' }, { value: 'products', label: `Products (${i.products.length})` },
        { value: 'integration', label: 'Integration' }, { value: 'compliance', label: 'Compliance' }, { value: 'performance', label: 'Performance' }, { value: 'audit', label: 'Audit' },
      ]} />
      {tab === 'onboarding' && <Onboarding i={i} admin={admin} run={run} busy={act.busy} />}
      {tab === 'profile' && <Profile i={i} admin={admin} run={run} busy={act.busy} />}
      {tab === 'products' && <Products i={i} admin={admin} run={run} busy={act.busy} />}
      {tab === 'integration' && <Integration i={i} admin={admin} canTest={['admin', 'operations_admin'].includes(user.role)} run={run} busy={act.busy} />}
      {tab === 'compliance' && <Compliance i={i} admin={admin} run={run} busy={act.busy} />}
      {tab === 'performance' && <Performance id={i.id} />}
      {tab === 'audit' && <AuditTrail id={i.id} />}
    </>
  );
}

function Gates({ gates }) {
  return <ul className="pt-gates">{gates.map((g) => <li key={g.key}><span className={g.ok ? 'ok' : 'no'} aria-label={g.ok ? 'met' : 'not met'}>{g.ok ? '✓' : '✕'}</span><span>{g.label}{!g.ok && g.detail && <span className="pt-muted-sm"> — {g.detail}</span>}</span></li>)}</ul>;
}

function Onboarding({ i, admin, run, busy }) {
  const [note, setNote] = useState('');
  const stageTasks = i.onboardingTasks.filter((t) => t.stage === i.status);
  const otherOpen = i.onboardingTasks.filter((t) => t.stage !== i.status && !t.done);
  return (
    <div className="grid grid-2">
      <Card title={`Checklist — ${i.status}`}>
        {stageTasks.length ? (
          <ul className="pt-tasks">
            {stageTasks.map((t) => (
              <li key={t.id}><label><input type="checkbox" checked={t.done} disabled={!admin || busy} onChange={(e) => run(() => api.post(`/partners/insurers/${i.id}/tasks/${t.id}`, { done: e.target.checked }))} />
                <span>{t.title}{t.done && <span className="pt-muted-sm"> · {t.doneBy}, {date(t.doneAt)}</span>}</span></label></li>
            ))}
          </ul>
        ) : <Empty>No checklist for this status.</Empty>}
        {otherOpen.length > 0 && <p className="pt-muted-sm">{otherOpen.length} task(s) open in later stages.</p>}
      </Card>
      <Card title="Move to next status">
        {i.nextStatuses.length === 0 && <Empty>No further transitions.</Empty>}
        {i.nextStatuses.map((n) => (
          <div key={n.status} style={{ marginBottom: '.9rem' }}>
            <div className="row between"><strong>{n.status}</strong>{admin && <button className="btn sm" disabled={busy} onClick={() => run(() => api.post(`/partners/insurers/${i.id}/status`, { status: n.status, note }), `Moved to ${n.status}`)}>Move</button>}</div>
            {n.gates.length ? <Gates gates={n.gates} /> : <span className="pt-muted-sm">No gates</span>}
          </div>
        ))}
        {admin && i.nextStatuses.length > 0 && <Field label="Note (required to suspend)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
      </Card>
      <Card title="Activation readiness" className="full">
        <p className="pt-muted-sm" style={{ marginTop: 0 }}>Live sales: <strong>{i.liveSales.label}</strong></p>
        <Gates gates={i.activationGates} />
      </Card>
      <Card title="History"><Timeline items={i.onboardingHistory || []} /></Card>
    </div>
  );
}

function SectionModal({ title, open, onClose, onSave, busy, children }) {
  return (
    <Modal open={open} title={title} onClose={onClose} large>
      {children}
      <div className="row end" style={{ marginTop: '1rem' }}><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={onSave}>Save</button></div>
    </Modal>
  );
}

function Profile({ i, admin, run, busy }) {
  const [edit, setEdit] = useState(null);
  const [f, setF] = useState({});
  const open = (section) => {
    setF({
      name: i.name, legalName: i.legalName || '', type: i.type || '', regNo: i.irdai?.registrationNo || '', verified: !!i.irdai?.verified, irdaiNote: i.irdai?.note || '',
      contacts: lines(i.contacts, (c) => [c.name, c.role, c.email, c.phone].join(' | ')), escalation: lines(i.escalation, (c) => [c.name || c.contact, c.role || `Level ${c.level || 1}`, c.email || c.contact, c.phone].join(' | ')),
      claimsPhone: i.claimsContact?.phone || '', claimsEmail: i.claimsContact?.email || '', claimsHours: i.claimsContact?.hours || '', geographies: (i.geographies || []).join(', '),
      ref: i.agreement?.reference || '', signedAt: i.agreement?.signedAt || '', validFrom: i.agreement?.validFrom || '', validTo: i.agreement?.validTo || '',
      commissionBp: i.agreement?.commissionBp ?? '', premiumCollection: i.agreement?.premiumCollection || '', remuneration: i.agreement?.remuneration || '',
    });
    setEdit(section);
  };
  const save = () => {
    const body = edit === 'profile' ? {
      name: f.name, legalName: f.legalName, type: f.type, irdai: { registrationNo: f.regNo, verified: f.verified, note: f.irdaiNote },
      contacts: parseLines(f.contacts, ['name', 'role', 'email', 'phone']), escalation: parseLines(f.escalation, ['name', 'role', 'email', 'phone']).map((c, k) => ({ ...c, level: k + 1 })),
      claimsContact: { phone: f.claimsPhone, email: f.claimsEmail, hours: f.claimsHours }, geographies: f.geographies.split(',').map((x) => x.trim()).filter(Boolean),
    } : { agreement: { reference: f.ref, signedAt: f.signedAt, validFrom: f.validFrom, validTo: f.validTo, commissionBp: f.commissionBp === '' ? null : Number(f.commissionBp), premiumCollection: f.premiumCollection, remuneration: f.remuneration } };
    run(() => api.put(`/partners/insurers/${i.id}`, body), 'Saved').then((r) => r && setEdit(null));
  };
  const a = i.agreement;
  return (
    <div className="grid grid-2">
      <Card title="Profile" actions={admin && <button className="btn sm secondary" onClick={() => open('profile')}>Edit</button>}>
        <KV items={[
          ['Legal name', i.legalName], ['IRDAI registration', i.irdai?.registrationNo || '—'], ['IRDAI verified', i.sandbox ? 'n/a — synthetic entity' : yes(i.irdai?.verified)],
          i.irdai?.note && ['IRDAI note', i.irdai.note], ['Geographies', (i.geographies || []).join(', ') || '—'],
          ['Contacts', (i.contacts || []).map((c) => `${c.name}${c.role ? ` (${c.role})` : ''} ${c.email || ''}`).join('; ') || '—'],
          ['Escalation', (i.escalation || []).map((c) => `L${c.level || 1}: ${c.name || c.contact || c.email}`).join('; ') || '—'],
          ['Claims contact', i.claimsContact ? `${i.claimsContact.phone} · ${i.claimsContact.email}` : '—'],
          ['Publishable', yes(i.publishable)],
        ]} />
        {admin && !i.candidate && i.status === 'Active' && (
          <button className="btn sm secondary" style={{ marginTop: '.75rem' }} disabled={busy} onClick={() => run(() => api.put(`/partners/insurers/${i.id}`, { publishable: !i.publishable }))}>{i.publishable ? 'Unpublish' : 'Publish on marketplace'}</button>
        )}
      </Card>
      <Card title="Agreement" actions={admin && !i.candidate && <button className="btn sm secondary" onClick={() => open('agreement')}>Edit</button>}>
        {a ? (
          <KV items={[['Reference', a.reference], ['Signed', date(a.signedAt)], ['Valid', `${date(a.validFrom)} – ${date(a.validTo)}`], ['Valid today', yes(i.agreementValid)],
            ['Commission', a.commissionBp != null ? bp(a.commissionBp) : '—'], ['Premium arrangement', a.premiumCollection || '—'], ['Remuneration', a.remuneration || '—']]} />
        ) : <Empty>No agreement{i.candidate ? ' — candidate only' : ''}.</Empty>}
      </Card>
      <SectionModal title={edit === 'profile' ? 'Edit profile' : 'Edit agreement'} open={!!edit} onClose={() => setEdit(null)} onSave={save} busy={busy}>
        {edit === 'profile' ? (
          <div className="form-grid">
            <Field label="Display name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Legal name"><input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
            <Field label="Type"><input value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} /></Field>
            <Field label="IRDAI registration no."><input value={f.regNo} onChange={(e) => setF({ ...f, regNo: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked })} /> Verified against the official IRDAI registry</label>
            <Field label="IRDAI note"><input value={f.irdaiNote} onChange={(e) => setF({ ...f, irdaiNote: e.target.value })} /></Field>
            <Field label="Contacts" hint="One per line: name | role | email | phone" className="full"><textarea rows={3} value={f.contacts} onChange={(e) => setF({ ...f, contacts: e.target.value })} /></Field>
            <Field label="Escalation contacts" hint="In order: name | role | email | phone" className="full"><textarea rows={3} value={f.escalation} onChange={(e) => setF({ ...f, escalation: e.target.value })} /></Field>
            <Field label="Claims phone"><input value={f.claimsPhone} onChange={(e) => setF({ ...f, claimsPhone: e.target.value })} /></Field>
            <Field label="Claims email"><input value={f.claimsEmail} onChange={(e) => setF({ ...f, claimsEmail: e.target.value })} /></Field>
            <Field label="Claims hours"><input value={f.claimsHours} onChange={(e) => setF({ ...f, claimsHours: e.target.value })} /></Field>
            <Field label="Geographies (comma separated)" className="full"><input value={f.geographies} onChange={(e) => setF({ ...f, geographies: e.target.value })} /></Field>
          </div>
        ) : (
          <div className="form-grid">
            <Field label="Agreement reference"><input value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
            <Field label="Signed on"><input type="date" value={f.signedAt} onChange={(e) => setF({ ...f, signedAt: e.target.value })} /></Field>
            <Field label="Valid from"><input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></Field>
            <Field label="Valid to"><input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></Field>
            <Field label="Commission (basis points)" hint="1500 = 15%"><input inputMode="numeric" value={f.commissionBp} onChange={(e) => setF({ ...f, commissionBp: e.target.value })} /></Field>
            <Field label="Premium arrangement" className="full"><input value={f.premiumCollection} onChange={(e) => setF({ ...f, premiumCollection: e.target.value })} /></Field>
            <Field label="Remuneration terms" className="full"><input value={f.remuneration} onChange={(e) => setF({ ...f, remuneration: e.target.value })} /></Field>
          </div>
        )}
      </SectionModal>
    </div>
  );
}

function Products({ i, admin, run, busy }) {
  const plans = useLoad(() => (admin ? api.get('/plans?includeInactive=true') : Promise.resolve([])), [admin]);
  const [f, setF] = useState({ planId: '', uin: '' });
  return (
    <>
      <Card title="Authorised products">
        <Table rows={i.products} empty="No authorised products." columns={[
          { key: 'name', label: 'Product' }, { key: 'uin', label: 'UIN', render: (p) => <span className="pt-mono">{p.uin}</span> }, { key: 'version', label: 'Version' },
          { key: 'dist', label: 'Distribution', render: (p) => (p.distribution.allowed ? <Badge kind="ok">Sellable{p.distribution.sandbox ? ' (sandbox)' : ''}</Badge> : <span className="pt-muted-sm">{p.distribution.reason}</span>) },
          admin && { key: 'x', label: '', render: (p) => <button className="btn sm ghost" disabled={busy} onClick={() => window.confirm(`Revoke ${p.name}?`) && run(() => api.post(`/partners/insurers/${i.id}/products/${p.id}/revoke`))}>Revoke</button> },
        ].filter(Boolean)} />
      </Card>
      {admin && !i.candidate && (
        <Card title="Authorise a product">
          <p className="pt-muted-sm" style={{ marginTop: 0 }}>Links the product to this insurer and records its UIN. Products already sold under another insurer cannot be moved.</p>
          <div className="form-grid">
            <Field label="Product"><select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}><option value="">— select —</option>{(plans.data || []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code}){p.insurer ? ` — ${p.insurer.name}` : ''}</option>)}</select></Field>
            <Field label="UIN"><input value={f.uin} onChange={(e) => setF({ ...f, uin: e.target.value })} /></Field>
            <div className="row" style={{ alignItems: 'flex-end' }}><button className="btn" disabled={busy || !f.planId} onClick={() => run(() => api.post(`/partners/insurers/${i.id}/products`, f), 'Product authorised')}>Authorise</button></div>
          </div>
        </Card>
      )}
    </>
  );
}

function Integration({ i, admin, canTest, run, busy }) {
  const it = i.integration || {};
  const [f, setF] = useState({ type: it.type || '', adapter: it.adapter || '', protocol: it.protocol || '', credentialsRef: it.credentialsRef || '', endpointRef: it.endpointRef || '' });
  const [evidence, setEvidence] = useState('');
  return (
    <div className="grid grid-2">
      <Card title="Integration">
        <KV items={[['Type', it.type || '—'], ['Adapter', it.adapter || '—'], ['Protocol', it.protocol || '—'], ['Credentials', it.credentialsRef ? <span className="pt-mono">{it.credentialsRef}</span> : '—'],
          ['Status', <Badge key="s">{it.status || 'Not started'}</Badge>], ['Last test', it.lastTest ? `${it.lastTest.ok ? 'Passed' : 'Failed'} · ${it.lastTest.method} · ${dateTime(it.lastTest.at)}${it.lastTest.note ? ` — ${it.lastTest.note}` : ''}${it.lastTest.reason ? ` — ${it.lastTest.reason}` : ''}` : '—']]} />
        <Alert kind="info">Secrets are never stored in VHC records — only a reference to where the credentials are held (for example a vault path).</Alert>
        {canTest && it.adapter && <button className="btn sm" disabled={busy} onClick={() => run(() => api.post(`/partners/insurers/${i.id}/integration/test`), (r) => (r.result.ok ? 'Certification test passed' : `Test failed: ${r.result.reason || r.result.note}`))}>Run certification test</button>}
      </Card>
      {admin && (
        <Card title="Configure">
          <div className="form-grid">
            <Field label="Integration type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">—</option>{['in-process', 'rest-api', 'soap-api', 'sftp-batch', 'insurer-portal', 'manual'].map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Adapter key" hint={i.sandbox ? 'mock-sandbox for synthetic insurers' : 'Real adapters are deployed per signed agreement'}><input value={f.adapter} onChange={(e) => setF({ ...f, adapter: e.target.value })} /></Field>
            <Field label="Protocol"><input value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value })} /></Field>
            <Field label="Credentials reference" hint="e.g. vault://partners/insurer-x — never the secret itself"><input value={f.credentialsRef} onChange={(e) => setF({ ...f, credentialsRef: e.target.value })} /></Field>
            <Field label="Endpoint reference"><input value={f.endpointRef} onChange={(e) => setF({ ...f, endpointRef: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ marginTop: '.75rem' }}><button className="btn" disabled={busy} onClick={() => run(() => api.put(`/partners/insurers/${i.id}`, { integration: f }), 'Integration saved')}>Save</button></div>
          {!i.sandbox && (
            <div style={{ marginTop: '1rem' }}>
              <Field label="Manual certification evidence (UAT report reference)"><input value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field>
              <button className="btn sm secondary" style={{ marginTop: '.5rem' }} disabled={busy || !evidence} onClick={() => run(() => api.post(`/partners/insurers/${i.id}/integration/certify`, { evidenceRef: evidence }), 'Evidence recorded')}>Record certification evidence</button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Compliance({ i, admin, run, busy }) {
  const [docs, setDocs] = useState(lines(i.complianceDocuments, (d) => [d.name, d.reference, d.status, d.validTo || ''].join(' | ')));
  const [reg, setReg] = useState({ liveSalesApproved: !!i.regulatoryApproval?.liveSalesApproved, reference: i.regulatoryApproval?.reference || '', note: i.regulatoryApproval?.note || '' });
  return (
    <div className="grid grid-2">
      <Card title="Compliance documents">
        <Table rows={(i.complianceDocuments || []).map((d, k) => ({ ...d, id: k }))} empty="No compliance documents recorded." columns={[
          { key: 'name', label: 'Document' }, { key: 'reference', label: 'Reference' }, { key: 'status', label: 'Status', render: (d) => <Badge>{d.status}</Badge> }, { key: 'validTo', label: 'Valid to', render: (d) => date(d.validTo) },
        ]} />
        {admin && (
          <>
            <Field label="Edit list" hint="One per line: name | reference | Pending/Received/Verified/Expired | valid-to (YYYY-MM-DD)"><textarea rows={4} value={docs} onChange={(e) => setDocs(e.target.value)} /></Field>
            <button className="btn sm" style={{ marginTop: '.5rem' }} disabled={busy} onClick={() => run(() => api.put(`/partners/insurers/${i.id}`, { complianceDocuments: parseLines(docs, ['name', 'reference', 'status', 'validTo']).map((d) => ({ ...d, status: d.status || 'Pending', validTo: d.validTo || null })) }), 'Saved')}>Save documents</button>
          </>
        )}
      </Card>
      <Card title="Regulatory approval for live sales">
        <p style={{ marginTop: 0 }}>{i.liveSales.regulatory ? <BlockedTag>{i.liveSales.label}</BlockedTag> : <strong>{i.liveSales.label}</strong>}</p>
        <KV items={[['Approved', yes(i.regulatoryApproval?.liveSalesApproved)], ['Reference', i.regulatoryApproval?.reference || '—'], ['Note', i.regulatoryApproval?.note || '—']]} />
        {admin && !i.sandbox && !i.candidate && (
          <div className="stack" style={{ marginTop: '.75rem' }}>
            <label className="check"><input type="checkbox" checked={reg.liveSalesApproved} onChange={(e) => setReg({ ...reg, liveSalesApproved: e.target.checked })} /> Regulatory approval for live sales has been granted and verified by compliance</label>
            <Field label="Approval reference"><input value={reg.reference} onChange={(e) => setReg({ ...reg, reference: e.target.value })} /></Field>
            <Field label="Note"><input value={reg.note} onChange={(e) => setReg({ ...reg, note: e.target.value })} /></Field>
            <button className="btn sm" disabled={busy} onClick={() => run(() => api.put(`/partners/insurers/${i.id}`, { regulatoryApproval: reg }), 'Saved')}>Save</button>
          </div>
        )}
        {i.sandbox && <p className="pt-muted-sm">Synthetic sandbox insurers can never be approved for live sales.</p>}
      </Card>
    </div>
  );
}

export function PerformanceView({ a }) {
  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: '1rem' }}>
        <Stat label="Authorised products" value={a.products} />
        <Stat label="Awaiting issuance" value={a.proposalsAwaitingIssuance} />
        <Stat label="Issued policies" value={a.issuedPolicies} />
        <Stat label="Quote → issue conversion" value={bp(a.quoteToIssueConversionBp)} />
        <Stat label="Proposal success rate" value={bp(a.proposalSuccessRateBp)} />
        <Stat label="Median issuance turnaround" value={minutes(a.medianIssuanceTurnaroundMinutes)} />
        <Stat label="Renewal retention" value={bp(a.renewals.retentionBp)} />
        <Stat label="Renewals due now" value={a.renewals.dueNow} />
      </div>
      <Card title="Notes">
        <KV items={[['Quote response time', a.quoteResponseTime.note], ['Insurer declines', a.declinedByInsurer], ['Issuance decisions measured', a.issuanceDecisions], ['Oldest pending (days)', a.oldestPendingDays ?? '—']]} />
        <ul className="pt-muted-sm">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </Card>
    </>
  );
}

function Performance({ id }) {
  const res = useLoad(() => api.get(`/partners/insurers/${id}/analytics`), [id]);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return <PerformanceView a={res.data} />;
}

function AuditTrail({ id }) {
  const res = useLoad(() => api.get(`/partners/insurers/${id}/audit`), [id]);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <Card title="Audit trail">
      <Table rows={res.data} empty="No audit entries." columns={[
        { key: 'at', label: 'When', render: (a) => dateTime(a.at) }, { key: 'actorName', label: 'By', render: (a) => `${a.actorName} (${a.actorRole})` },
        { key: 'action', label: 'Action', render: (a) => <code>{a.action}</code> }, { key: 'details', label: 'Details', render: (a) => <span className="pt-mono">{JSON.stringify(a.details)}</span> },
      ]} />
    </Card>
  );
}

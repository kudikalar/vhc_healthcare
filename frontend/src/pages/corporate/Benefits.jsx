// Employee self-service (/benefits): an employee's own group cover, enrolment, dependents,
// certificate, claims contacts, wellness opt-ins and support. Only the signed-in employee's data.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, KV, Loading, Modal, PageHeader, Table, useAction, useLoad } from '../../components/ui.jsx';
import { downloadPdf, lakh, SandboxNote } from './shared.jsx';
import { AddDependent, RemoveDependent } from './Employees.jsx';

export default function Benefits() {
  const res = useLoad(() => api.get('/corporate/benefits/me'), []);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const d = res.data;
  return (
    <>
      <PageHeader title="Employee benefits" subtitle="Group health cover arranged by your employer through VHC." />
      {!d.emailVerified && <Alert kind="warn">Verify your email address to see benefits your employer has set up for you.</Alert>}
      {d.memberships.length === 0 ? (
        <Card>
          <Empty>
            <p style={{ marginTop: 0 }}>No employer benefits are linked to <strong>{d.email}</strong> yet.</p>
            <p className="muted" style={{ marginBottom: 0 }}>If your employer offers group health cover through VHC, ask your HR team to add you to the roster with this email address. It will appear here automatically.</p>
          </Empty>
        </Card>
      ) : d.memberships.map((ms) => <Membership key={ms.member.id} ms={ms} meta={d} reload={res.reload} />)}
    </>
  );
}

function Membership({ ms, meta, reload }) {
  const act = useAction();
  const [modal, setModal] = useState(null);
  const enrolledPolicy = ms.policies.find((p) => p.enrolment.status === 'Enrolled');
  const pendingPolicy = ms.policies.find((p) => p.enrolment.status === 'Pending Insurer');
  const active = ms.member.status === 'Active';
  return (
    <section aria-labelledby={`emp-${ms.member.id}`}>
      <h2 id={`emp-${ms.member.id}`} style={{ fontSize: '1.15rem' }}>{ms.employer.name}</h2>
      {ms.employer.sandbox && <SandboxNote>{meta.label}</SandboxNote>}
      {!active && <Alert kind="info">Your employment ended on {date(ms.member.leavingDate)}. Group cover ends on that date.</Alert>}
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <div className="corp-two">
        <div>
          {ms.policies.length === 0 && <Card><Empty>Your employer has no active group policy yet.</Empty></Card>}
          {ms.policies.map((p) => (
            <Card key={p.id} title={p.productName} actions={<Badge>{p.enrolment.status}</Badge>}>
              <KV items={[
                ['Insurer', p.insurerName], ['Group policy', p.policyNumber], ['Sum insured', `${lakh(p.sumInsured)} (shared by your covered family)`], ['Who can be covered', p.familyLabel],
                ['Policy period', `${date(p.startDate)} – ${date(p.endDate)}`],
                p.enrolment.coverFrom && ['Your cover', `${date(p.enrolment.coverFrom)} – ${date(p.enrolment.coverTo)}`],
                p.enrolment.certificateNumber && ['Certificate', p.enrolment.certificateNumber],
                p.enrolmentWindow && ['Enrolment window', <span key="w">{date(p.enrolmentWindow.opensOn)} – {date(p.enrolmentWindow.closesOn)} {p.windowOpen ? <Badge kind="ok">Open</Badge> : <Badge>Closed</Badge>}</span>],
              ]} />
              {p.enrolment.lives?.length > 0 && (
                <div className="corp-lives">
                  {p.enrolment.lives.map((l, i) => <div key={i} className="corp-life"><strong>{l.name}</strong><span className="muted" style={{ textTransform: 'capitalize' }}>{l.relationship} · {l.status}</span></div>)}
                </div>
              )}
              {p.enrolment.excludedLives?.length > 0 && <Alert kind="info">Not covered: {p.enrolment.excludedLives.map((x) => `${x.name} (${x.reason})`).join('; ')}</Alert>}
              {p.enrolment.status === 'Pending Insurer' && <Alert kind="info">Your enrolment has been sent to the insurer. We'll notify you when it is confirmed.</Alert>}
              {p.enrolment.status === 'Rejected by Insurer' && <Alert kind="error">The insurer did not confirm your enrolment: {p.enrolment.rejectReason}. Your HR team has been informed.</Alert>}
              {!p.eligibility.eligible && p.enrolment.status === 'Not Enrolled' && <Alert kind="warn">You are not eligible for this policy: {p.eligibility.reasons.join('; ')}.</Alert>}
              <details style={{ margin: '.5rem 0' }}>
                <summary>Group benefits & waivers</summary>
                <ul>{p.waivers.map((w) => <li key={w.code}>{w.label}</li>)}</ul>
              </details>
              <div className="corp-actions">
                {p.canSubmit && active && <button className="btn" onClick={() => setModal({ enrol: p })}>Complete enrolment</button>}
                {p.enrolment.certificateNumber && <button className="btn secondary" onClick={() => act.run(() => downloadPdf(`/corporate/benefits/enrolments/${p.enrolment.id}/certificate`, p.enrolment.certificateNumber))}>Download certificate</button>}
                <Link className="btn secondary" to="/hospitals">Find a hospital</Link>
              </div>
              <div className="corp-privacy">
                <strong>Claims help:</strong> {p.contacts.claims.name} — {p.contacts.claims.phone}, {p.contacts.claims.email} ({p.contacts.claims.hours}).<br />
                <strong>Insurer:</strong> {p.contacts.insurer.name} — {p.contacts.insurer.phone}.
              </div>
            </Card>
          ))}
          <Card title="Your claims under group cover">
            <Table rows={ms.claims} empty="No group claims reported." columns={[
              { key: 'claimRef', label: 'Claim' }, { key: 'relationship', label: 'For', render: (c) => <span style={{ textTransform: 'capitalize' }}>{c.relationship}</span> },
              { key: 'admissionDate', label: 'Admitted', render: (c) => date(c.admissionDate) }, { key: 'claimedAmount', label: 'Claimed', num: true, render: (c) => money(c.claimedAmount) },
              { key: 'settledAmount', label: 'Settled', num: true, render: (c) => (c.settledAmount ? money(c.settledAmount) : '—') }, { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
            ]} />
            <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>Your claim details are shared only with you, the insurer and its TPA — never with your employer.</p>
          </Card>
        </div>
        <div>
          <Card title="Your family" actions={active && !pendingPolicy && ms.dependentRules.relationships.length > 0 && <button className="btn sm secondary" onClick={() => setModal('dep')}>Add dependent</button>}>
            <Table rows={ms.dependents} empty="No dependents added." columns={[
              { key: 'name', label: 'Name' }, { key: 'relationship', label: 'Relationship', render: (x) => <span style={{ textTransform: 'capitalize' }}>{x.relationship}</span> },
              { key: 'dob', label: 'DOB', render: (x) => date(x.dob) }, { key: 'coverStatus', label: 'Cover', render: (x) => <small>{x.coverStatus}</small> },
              { key: 'r', label: '', render: (x) => active && !pendingPolicy && <button className="btn sm ghost" onClick={() => setModal({ remove: x })}>Remove</button> },
            ]} />
            <p className="muted" style={{ fontSize: '.84rem', marginBottom: 0 }}>You can add: {ms.dependentRules.relationships.join(', ') || 'no dependents under this plan'}. Children up to age {ms.dependentRules.rules.childMaxAge}.</p>
          </Card>
          <Wellness ms={ms} consentText={meta.consentText} reload={reload} />
          <Support ms={ms} categories={meta.categories} reload={reload} />
        </div>
      </div>
      {modal?.enrol && <EnrolModal p={modal.enrol} ms={ms} onClose={() => setModal(null)} onDone={(msg) => { setModal(null); act.setMessage(msg); reload(); }} />}
      <AddDependent open={modal === 'dep'} m={{}} relationships={ms.dependentRules.relationships} enrolled={!!enrolledPolicy} path={`/corporate/benefits/members/${ms.member.id}/dependents`} onClose={() => setModal(null)} onDone={() => { setModal(null); act.setMessage(enrolledPolicy ? 'Dependent added — the insurer is confirming the addition' : 'Dependent added'); reload(); }} />
      <RemoveDependent dep={modal?.remove} covered={!!enrolledPolicy} path={(x) => `/corporate/benefits/dependents/${x.id}/remove`} onClose={() => setModal(null)} onDone={() => { setModal(null); act.setMessage('Dependent removed'); reload(); }} />
    </section>
  );
}

function EnrolModal({ p, ms, onClose, onDone }) {
  const [declaration, setDeclaration] = useState(false);
  const act = useAction();
  const lives = [{ name: ms.member.name, relationship: 'self' }, ...ms.dependents.filter((x) => ms.dependentRules.relationships.includes(x.relationship))];
  return (
    <Modal open title="Complete your enrolment" onClose={onClose}>
      <ErrorBox error={act.error} />
      <p style={{ marginTop: 0 }}>These people will be submitted to <strong>{p.insurerName}</strong> under {p.policyNumber}:</p>
      <div className="corp-lives">{lives.map((l, i) => <div key={i} className="corp-life"><strong>{l.name}</strong><span className="muted" style={{ textTransform: 'capitalize' }}>{l.relationship}</span></div>)}</div>
      <p className="muted" style={{ fontSize: '.85rem' }}>Add any missing family members before submitting. After the insurer confirms, further additions are mid-term endorsements.</p>
      <label className="corp-check"><input type="checkbox" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} /> I confirm the details above are correct and consent to them being shared with the insurer for my group health cover.</label>
      <div className="row end" style={{ marginTop: '1rem' }}>
        <button className="btn" disabled={!declaration || act.busy} onClick={() => act.run(async () => {
          const r = await api.post('/corporate/benefits/enrolments/submit', { memberId: ms.member.id, groupPolicyId: p.id, declaration });
          onDone(r.status === 'Enrolled' ? 'You are enrolled. Your certificate is ready to download.' : r.status === 'Pending Insurer' ? 'Submitted — waiting for the insurer to confirm.' : `Enrolment ${r.status.toLowerCase()}`);
        })}>Submit enrolment</button>
      </div>
    </Modal>
  );
}

function Wellness({ ms, consentText, reload }) {
  const [join, setJoin] = useState(null);
  const [consent, setConsent] = useState(false);
  const act = useAction();
  if (!ms.wellness.length) return null;
  return (
    <Card title="Wellness programmes">
      <p className="muted" style={{ marginTop: 0, fontSize: '.85rem' }}>Voluntary and separate from your insurance. Your employer only sees total participation.</p>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <ul className="corp-list">
        {ms.wellness.map((w) => (
          <li key={w.id}>
            <span><strong>{w.name}</strong><div className="meta">{w.typeLabel} · {date(w.startDate)} – {date(w.endDate)} · {w.location}</div></span>
            {w.myStatus === 'Opted in'
              ? <button className="btn sm secondary" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/corporate/benefits/wellness/${w.id}/opt-out`, { memberId: ms.member.id }); reload(); }, 'You have withdrawn')}>Withdraw</button>
              : w.full ? <Badge>Full</Badge> : <button className="btn sm" onClick={() => { setJoin(w); setConsent(false); }}>Join</button>}
          </li>
        ))}
      </ul>
      <Modal open={!!join} title={join ? `Join: ${join.name}` : ''} onClose={() => setJoin(null)}>
        {join?.description && <p>{join.description}</p>}
        <label className="corp-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {consentText}</label>
        <div className="row end" style={{ marginTop: '1rem' }}>
          <button className="btn" disabled={!consent || act.busy} onClick={() => act.run(async () => { await api.post(`/corporate/benefits/wellness/${join.id}/opt-in`, { memberId: ms.member.id, consent }); setJoin(null); reload(); }, 'You are registered')}>Join programme</button>
        </div>
      </Modal>
    </Card>
  );
}

function Support({ ms, categories, reload }) {
  const [f, setF] = useState({ category: 'enrolment', subject: '', message: '' });
  const act = useAction();
  const fe = act.error?.fields || {};
  return (
    <Card title="Need help with your benefits?">
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <div className="form-grid">
        <Field label="Topic" error={fe.category}><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Subject" error={fe.subject}><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={120} /></Field>
        <Field label="Message" error={fe.message} className="full"><textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={2000} /></Field>
      </div>
      <p className="muted" style={{ fontSize: '.84rem' }}>Handled by VHC support. Your employer sees only the number of requests, not their content.</p>
      <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.post('/corporate/benefits/support', { ...f, memberId: ms.member.id }); setF({ category: 'enrolment', subject: '', message: '' }); reload(); }, 'Request sent')}>Send</button></div>
      {ms.support.length > 0 && (
        <ul className="corp-list" style={{ marginTop: '.75rem' }}>
          {ms.support.map((x) => <li key={x.id}><span>{x.subject}<div className="meta">{x.reference}{x.responses?.length ? ` · ${x.responses[x.responses.length - 1].message}` : ''}</div></span><Badge>{x.status}</Badge></li>)}
        </ul>
      )}
    </Card>
  );
}

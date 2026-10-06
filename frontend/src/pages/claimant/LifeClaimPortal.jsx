import { useState } from 'react';
import { api, idempotencyKey } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, money } from '../../format.js';
import { Alert, Badge, Card, DevHint, ErrorBox, Field, KV, Loading, PageHeader, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';
import { OtpCard } from '../../components/AuthBits.jsx';

export default function LifeClaimPortal() {
  const { user } = useAuth();
  return user?.role === 'claimant' ? <ClaimantHome /> : <Verify signedInAs={user} />;
}

function Verify({ signedInAs }) {
  const { adoptSession } = useAuth();
  const [f, setF] = useState({ policyNumber: '', lifeAssuredName: '', lifeAssuredDob: '', claimant: { name: '', relationship: '', email: '', phone: '', idType: 'Passport', idNumber: '' } });
  const [step, setStep] = useState(null);
  const act = useAction();
  const verify = useAction();
  const c = (k, v) => setF({ ...f, claimant: { ...f.claimant, [k]: v } });
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <PageHeader title="Report a life insurance claim" subtitle="For family members and nominees. You do not need the policyholder's login." />
      {signedInAs && <Alert kind="warn">You are signed in as {signedInAs.name}. Completing verification here starts a separate, restricted claimant session.</Alert>}
      {!step ? (
        <Card title="Step 1 — Verify the policy and your identity">
          <p className="muted" style={{ marginTop: 0 }}>We only show policy information after these details are verified.</p>
          <div className="form-grid">
            <Field label="Policy number" hint="e.g. VHC-L-000002"><input value={f.policyNumber} onChange={(e) => setF({ ...f, policyNumber: e.target.value.toUpperCase() })} /></Field>
            <Field label="Life assured — full name"><input value={f.lifeAssuredName} onChange={(e) => setF({ ...f, lifeAssuredName: e.target.value })} /></Field>
            <Field label="Life assured — date of birth"><input type="date" value={f.lifeAssuredDob} onChange={(e) => setF({ ...f, lifeAssuredDob: e.target.value })} /></Field>
          </div>
          <h3 style={{ marginTop: '1rem' }}>About you (claimant)</h3>
          <div className="form-grid">
            <Field label="Your full name"><input value={f.claimant.name} onChange={(e) => c('name', e.target.value)} /></Field>
            <Field label="Relationship to the life assured"><input value={f.claimant.relationship} onChange={(e) => c('relationship', e.target.value)} /></Field>
            <Field label="Email"><input type="email" value={f.claimant.email} onChange={(e) => c('email', e.target.value)} /></Field>
            <Field label="Mobile (10 digits)"><input value={f.claimant.phone} onChange={(e) => c('phone', e.target.value)} /></Field>
            <Field label="Identity document"><select value={f.claimant.idType} onChange={(e) => c('idType', e.target.value)}><option>Passport</option><option>Voter ID</option><option>Driving licence</option></select></Field>
            <Field label="Document number (sample)"><input value={f.claimant.idNumber} onChange={(e) => c('idNumber', e.target.value)} /></Field>
          </div>
          <ErrorBox error={act.error} />
          <button className="btn" style={{ marginTop: '1rem' }} disabled={act.busy} onClick={() => act.run(async () => setStep(await api.post('/life-claims/portal/start', f)))}>Send verification code</button>
          <DevHint>try policy of the seeded customer: life assured <code>Asha Verma</code>, DOB <code>1988-04-12</code> (policy number is on the customer's policy page).</DevHint>
        </Card>
      ) : (
        <div className="card" style={{ maxWidth: 440, margin: '0 auto' }}>
          <OtpCard title="Step 2 — Enter the one-time code" destination={step.destination} expiresAt={step.expiresAt} devCode={step.devOtp}
            busy={verify.busy} error={verify.error?.message}
            onVerify={(otp) => verify.run(async () => { const r = await api.post('/life-claims/portal/verify', { accountId: step.accountId, challengeId: step.challengeId, otp }); adoptSession(r.user); })}
            onResend={async () => { try { setStep(await api.post('/life-claims/portal/start', f)); return true; } catch (e) { verify.setError(e); return false; } }} />
          <button className="btn ghost sm" style={{ marginTop: '.5rem' }} onClick={() => setStep(null)}>Start again</button>
        </div>
      )}
    </div>
  );
}

function ClaimantHome() {
  const me = useLoad(() => api.get('/life-claims/portal/me'));
  const [selected, setSelected] = useState(null);
  const [key] = useState(idempotencyKey);
  const [f, setF] = useState({ dateOfDeath: '', causeOfDeath: '', causeType: 'natural', placeOfDeath: '', payoutDetails: { accountName: '', accountNumber: '', ifsc: '' } });
  const act = useAction();
  if (me.loading) return <Loading />;
  if (me.error) return <ErrorBox error={me.error} />;
  const { policy, claims, claimant } = me.data;
  const today = new Date().toISOString().slice(0, 10);
  if (selected) return <ClaimantClaim id={selected} onBack={() => { setSelected(null); me.reload(); }} />;
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <PageHeader title="Life claim portal" subtitle={`Signed in as ${claimant.name} (${claimant.relationship}) — restricted claimant access`} />
      <Card title="Verified policy">
        <KV items={[['Policy', policy.policyNumber], ['Plan', policy.planName], ['Life assured', policy.lifeAssuredName], ['Coverage period', `${date(policy.startDate)} – ${date(policy.endDate)}`]]} />
      </Card>
      <Card title="Your claims">
        <Table rows={claims} empty="No claims reported yet." onRowClick={(c) => setSelected(c.id)} columns={[
          { key: 'claimNumber', label: 'Claim' }, { key: 'dateOfDeath', label: 'Date of death', render: (c) => date(c.dateOfDeath) },
          { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> }, { key: 'approvedAmount', label: 'Approved benefit', num: true, render: (c) => money(c.approvedAmount) },
        ]} />
      </Card>
      <Card title="Report a death claim">
        <Alert kind="info">Submitting a claim does not by itself authorise payment. A claims officer will verify identity, entitlement and documents; payment needs two independent approvals.</Alert>
        <div className="form-grid">
          <Field label="Date of death"><input type="date" max={today} value={f.dateOfDeath} onChange={(e) => setF({ ...f, dateOfDeath: e.target.value })} /></Field>
          <Field label="Cause type"><select value={f.causeType} onChange={(e) => setF({ ...f, causeType: e.target.value })}><option value="natural">Natural / illness</option><option value="accident">Accident</option><option value="other">Other</option></select></Field>
          <Field label="Cause of death"><input value={f.causeOfDeath} onChange={(e) => setF({ ...f, causeOfDeath: e.target.value })} /></Field>
          <Field label="Place of death"><input value={f.placeOfDeath} onChange={(e) => setF({ ...f, placeOfDeath: e.target.value })} /></Field>
          <Field label="Your bank: account holder"><input value={f.payoutDetails.accountName} onChange={(e) => setF({ ...f, payoutDetails: { ...f.payoutDetails, accountName: e.target.value } })} /></Field>
          <Field label="Account number"><input value={f.payoutDetails.accountNumber} onChange={(e) => setF({ ...f, payoutDetails: { ...f.payoutDetails, accountNumber: e.target.value } })} /></Field>
          <Field label="IFSC"><input value={f.payoutDetails.ifsc} onChange={(e) => setF({ ...f, payoutDetails: { ...f.payoutDetails, ifsc: e.target.value.toUpperCase() } })} /></Field>
        </div>
        <ErrorBox error={act.error} />
        <button className="btn" style={{ marginTop: '1rem' }} disabled={act.busy} onClick={() => act.run(async () => {
          const body = { ...f, idempotencyKey: key };
          if (!f.payoutDetails.accountNumber) delete body.payoutDetails;
          const c = await api.post('/life-claims', body);
          setSelected(c.id);
        })}>Submit claim</button>
      </Card>
    </div>
  );
}

function ClaimantClaim({ id, onBack }) {
  const res = useLoad(() => api.get(`/life-claims/${id}`), [id]);
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  const c = res.data;
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <PageHeader title={`Claim ${c.claimNumber}`} subtitle={`Life assured: ${c.lifeAssuredName}`} actions={<><Badge>{c.status}</Badge><button className="btn secondary" onClick={onBack}>Back</button></>} />
      <ErrorBox error={act.error} />
      {c.status === 'Documents Requested' && (
        <Card title="Documents requested">
          <ul>{c.documentRequests.filter((d) => !d.resolved).map((d, i) => <li key={i}>{d.note}</li>)}</ul>
          <button className="btn" disabled={act.busy} onClick={() => act.run(async () => res.setData(await api.post(`/life-claims/${c.id}/respond`, {})))}>I have uploaded the documents</button>
        </Card>
      )}
      {c.rejection && <Alert kind="error">Claim rejected: {c.rejection.reason}</Alert>}
      <Card title="Summary">
        <KV items={[['Date of death', date(c.dateOfDeath)], ['Cause', c.causeOfDeath], ['Approved benefit', money(c.approvedAmount)],
          ['Payout allocation', c.beneficiaries.length ? c.beneficiaries.map((b) => `${b.name}: ${money(b.allocation)}${b.paid ? ' (paid)' : ''}`).join('; ') : '—']]} />
      </Card>
      <DocumentPanel entityType="lifeClaim" entityId={c.id} canUpload={!['Settled', 'Rejected'].includes(c.status)} categories={['death_certificate', 'claimant_id', 'entitlement_proof', 'bank_proof', 'medical_report', 'other']} />
      <Card title="Timeline"><Timeline items={c.timeline} /></Card>
    </div>
  );
}

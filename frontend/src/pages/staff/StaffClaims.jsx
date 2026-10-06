import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, titleCase, toPaise, toRupeesInput } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, PageHeader, Table, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';
import { AssessmentTable } from '../customer/Claims.jsx';
import { NoteBox } from './StaffApplications.jsx';

// ---------------- health ----------------
export function HealthClaimsQueue() {
  const res = useLoad(() => api.get('/health-claims'));
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Health claims workspace" />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No claims." onRowClick={(c) => nav(`/ops/health-claims/${c.id}`)} columns={[
            { key: 'claimNumber', label: 'Claim' }, { key: 'type', label: 'Type', render: (c) => titleCase(c.type) },
            { key: 'policyNumber', label: 'Policy' }, { key: 'memberName', label: 'Patient' }, { key: 'hospitalName', label: 'Hospital' },
            { key: 'requestedAmount', label: 'Requested', num: true, render: (c) => money(c.requestedAmount) },
            { key: 'approvedAmount', label: 'Approved', num: true, render: (c) => money(c.approvedAmount) },
            { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
            { key: 'updatedAt', label: 'Updated', render: (c) => dateTime(c.updatedAt) },
          ]} />
        )}
      </Card>
    </>
  );
}

const CATS = ['room', 'medical', 'surgery', 'pharmacy', 'diagnostics', 'non_medical'];

export function HealthClaimReview() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/health-claims/${id}`), [id]);
  const act = useAction();
  const [items, setItems] = useState([]);
  const [preauthAmt, setPreauthAmt] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    const c = res.data;
    if (!c) return;
    setItems((c.billItems || [{ description: 'Hospital bill', category: 'medical', amount: c.requestedAmount, admissible: true }]).map((i) => ({ ...i, amount: toRupeesInput(i.amount) })));
    setPreauthAmt(toRupeesInput(c.requestedAmount));
  }, [res.data?.id, res.data?.requestedAmount]); // eslint-disable-line
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const c = res.data;
  const run = (fn, msg) => act.run(async () => res.setData(await fn()), msg);
  const post = (p, b) => api.post(`/health-claims/${id}${p}`, b);
  const setItem = (i, patch) => setItems(items.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const billTotal = items.reduce((t, i) => t + (toPaise(i.amount) || 0), 0);
  const assessable = ['Submitted', 'Under Review', 'Final Bill Submitted'].includes(c.status);
  const final = ['Settled', 'Rejected', 'Preauth Rejected'].includes(c.status);

  return (
    <>
      <PageHeader title={`Claim ${c.claimNumber}`} subtitle={`${titleCase(c.type)} · ${c.policy.policyNumber} (${c.policy.planName})`} actions={<Badge>{c.status}</Badge>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <div className="grid grid-2">
        <Card title="Claim">
          <KV items={[
            ['Patient', `${c.member.fullName} (${c.member.relationship}, DOB ${date(c.member.dob)})`],
            ['Member on policy', '✅ verified'],
            ['Hospital', `${c.hospitalName} ${c.networkHospital ? '(network)' : '(non-network)'}`],
            ['Admission – discharge', `${date(c.admissionDate)} – ${date(c.dischargeDate)}`],
            ['Diagnosis', c.diagnosis], ['Treatment', c.treatment], ['Accident', c.isAccident ? 'Yes' : 'No'],
            ['Requested', money(c.requestedAmount)],
            c.preauth && ['Pre-authorisation', `${c.preauth.status}${c.preauth.amount ? ` · ${money(c.preauth.amount)} (provisional)` : ''}`],
            c.type === 'reimbursement' && ['Payout account', c.payoutDetails ? `${c.payoutDetails.accountName} · XXXX${c.payoutDetails.accountNumber.slice(-4)} · ${c.payoutDetails.ifsc} ${c.payoutVerified ? '✅ verified' : '⚠️ unverified'}` : '—'],
          ]} />
        </Card>
        <Card title="Policy coverage">
          <KV items={[['Coverage period', `${date(c.policy.startDate)} – ${date(c.policy.endDate)}`], ['Sum insured', `${money(c.policy.coverage)}${c.policy.planType === 'floater' ? ' (shared floater)' : ''}`], ['Reserved', money(c.policy.reserved)], ['Paid', money(c.policy.paid)], ['Available now', <strong key="a">{money(c.policy.available)}</strong>]]} />
        </Card>
      </div>

      {c.status === 'Preauth Requested' && (
        <Card title="Cashless pre-authorisation">
          <Alert kind="info">Pre-authorisation is provisional; final settlement follows final bill review. Approval reserves the amount against the policy balance.</Alert>
          <div className="row">
            <Field label="Provisional amount (₹)"><input value={preauthAmt} onChange={(e) => setPreauthAmt(e.target.value)} /></Field>
            <button className="btn" disabled={act.busy} onClick={() => run(() => post('/preauth', { decision: 'approve', amount: toPaise(preauthAmt) }), 'Pre-authorisation approved')}>Approve pre-auth</button>
            <button className="btn danger" disabled={act.busy || !text.trim()} onClick={() => run(() => post('/preauth', { decision: 'reject', reason: text }))}>Refuse (reason below)</button>
          </div>
        </Card>
      )}
      {c.status === 'Preauth Approved' && (
        <Card title="Awaiting final bill">
          <p className="muted">Enter the final hospital bill (on behalf of the network hospital) to move to final review.</p>
          <div className="row"><input style={{ maxWidth: 200 }} value={preauthAmt} onChange={(e) => setPreauthAmt(e.target.value)} /><button className="btn" disabled={act.busy} onClick={() => run(() => post('/final-bill', { finalAmount: toPaise(preauthAmt) }))}>Record final bill</button></div>
        </Card>
      )}

      {assessable && (
        <Card title="Bill review & assessment">
          <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th>Category</th><th className="num">Amount (₹)</th><th>Admissible</th><th /></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td><input value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} /></td>
                  <td><select value={it.category} onChange={(e) => setItem(i, { category: e.target.value })}>{CATS.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</select></td>
                  <td><input value={it.amount} onChange={(e) => setItem(i, { amount: e.target.value })} /></td>
                  <td><input type="checkbox" checked={it.admissible !== false} onChange={(e) => setItem(i, { admissible: e.target.checked })} /></td>
                  <td><button className="btn ghost sm" onClick={() => setItems(items.filter((_, k) => k !== i))}>✕</button></td>
                </tr>
              ))}
              <tr className="total"><td colSpan={2}>Billed total</td><td className="num">{money(billTotal)}</td><td colSpan={2} /></tr>
            </tbody>
          </table></div>
          <div className="row" style={{ marginTop: '.6rem' }}>
            <button className="btn secondary sm" onClick={() => setItems([...items, { description: '', category: 'medical', amount: '', admissible: true }])}>+ Add line</button>
            <span className="spacer" />
            <button className="btn" disabled={act.busy} onClick={() => run(() => post('/assess', { billItems: items.map((i) => ({ ...i, amount: toPaise(i.amount) ?? 0 })) }), 'Assessment calculated')}>Run assessment</button>
          </div>
        </Card>
      )}

      {c.assessment && (
        <Card title="Assessment — requested, eligible, deducted and approved amounts" actions={c.assessment.by && <small className="muted">by {c.assessment.by} · {dateTime(c.assessment.evaluatedAt)}</small>}>
          <AssessmentTable a={c.assessment} />
          <details style={{ marginTop: '.5rem' }}><summary>Stored calculation inputs</summary><pre style={{ fontSize: '.8rem' }}>{JSON.stringify(c.assessment.inputs, null, 2)}</pre></details>
          {assessable && (
            <div className="row" style={{ marginTop: '.75rem' }}>
              <button className="btn" disabled={act.busy || !c.assessment.eligible} onClick={() => run(() => post('/approve'), 'Claim approved; funds reserved')}>Approve {money(c.assessment.approvedAmount)}</button>
            </div>
          )}
        </Card>
      )}

      {!final && (
        <Card title="Officer actions">
          <Field label="Note / reason"><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Document request, rejection reason, or note" /></Field>
          <div className="row" style={{ marginTop: '.6rem' }}>
            {c.status !== 'Approved' && <button className="btn secondary" disabled={act.busy || !text.trim()} onClick={() => run(() => post('/request-documents', { note: text }), 'Documents requested')}>Request documents</button>}
            <button className="btn danger" disabled={act.busy || !text.trim()} onClick={() => window.confirm('Reject this claim?') && run(() => post('/reject', { reason: text }), 'Claim rejected')}>Reject claim</button>
            {c.type === 'reimbursement' && !c.payoutVerified && <button className="btn secondary" disabled={act.busy} onClick={() => run(() => post('/verify-payout'), 'Payout details verified')}>Mark payout details verified</button>}
            {c.status === 'Approved' && <Link className="btn" to="/ops/payouts">Go to payout review</Link>}
          </div>
        </Card>
      )}

      <DocumentPanel entityType="healthClaim" entityId={c.id} title="Claim documents (bills, reports, discharge)" categories={['bill', 'prescription', 'medical_report', 'discharge_summary', 'other']} />
      <div className="grid grid-2">
        <Card title="Internal notes">
          {c.internalNotes.map((n, i) => <div key={i}><small className="muted">{dateTime(n.at)} · {n.by}</small><div>{n.note}</div></div>)}
          <NoteBox onSave={(n) => run(() => post('/notes', { note: n }))} />
        </Card>
        <Card title="Timeline"><Timeline items={c.timeline} /></Card>
      </div>
    </>
  );
}

// ---------------- life ----------------
export function LifeClaimsQueue() {
  const res = useLoad(() => api.get('/life-claims'));
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Life claims workspace" subtitle="Death claims require claimant verification and two independent approvals." />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No life claims." onRowClick={(c) => nav(`/ops/life-claims/${c.id}`)} columns={[
            { key: 'claimNumber', label: 'Claim' }, { key: 'policyNumber', label: 'Policy' }, { key: 'lifeAssuredName', label: 'Life assured' },
            { key: 'claimantName', label: 'Claimant' }, { key: 'dateOfDeath', label: 'Date of death', render: (c) => date(c.dateOfDeath) },
            { key: 'status', label: 'Status', render: (c) => <>{c.status && <Badge>{c.status}</Badge>} {c.flagged && <Badge kind="error">Possible duplicate</Badge>}</> },
            { key: 'approvedAmount', label: 'Approved', num: true, render: (c) => money(c.approvedAmount) },
          ]} />
        )}
      </Card>
    </>
  );
}

export function LifeClaimReview() {
  const { id } = useParams();
  const { user } = useAuth();
  const res = useLoad(() => api.get(`/life-claims/${id}`), [id]);
  const act = useAction();
  const [text, setText] = useState('');
  const [bens, setBens] = useState([]);
  const [alloc, setAlloc] = useState({});
  const [total, setTotal] = useState('');
  const c = res.data;
  useEffect(() => {
    if (!c) return;
    const src = c.beneficiaries.length ? c.beneficiaries : (c.analysis.nomineesAtDeath?.nominees || []).map((n) => ({ name: n.isMinor ? `${n.name} (guardian: ${n.guardian?.name})` : n.name, relationship: n.relationship, entitlement: 'nominee', verified: false, payoutDetails: null, sharePct: n.sharePct }));
    setBens(src.map((b) => ({ ...b, payoutDetails: b.payoutDetails || { accountName: '', accountNumber: '', ifsc: '' } })));
    setTotal(toRupeesInput(c.approvedAmount ?? c.analysis.suggestedBenefit));
    const nominees = c.analysis.nomineesAtDeath?.nominees || [];
    setAlloc(Object.fromEntries(c.beneficiaries.map((b, i) => [b.id, toRupeesInput(b.allocation || Math.round(((nominees[i]?.shareBp || 0) * c.analysis.suggestedBenefit) / 10000))])));
  }, [c?.id, c?.beneficiaries?.length, c?.status]); // eslint-disable-line
  if (res.loading && !c) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const an = c.analysis;
  const run = (fn, msg) => act.run(async () => res.setData(await fn()), msg);
  const post = (p, b) => api.post(`/life-claims/${id}${p}`, b);
  const setBen = (i, patch) => setBens(bens.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  const allocTotal = Object.values(alloc).reduce((t, v) => t + (toPaise(v) || 0), 0);
  const flagged = c.flags.duplicateOf.length > 0 && !c.flags.cleared;

  return (
    <>
      <PageHeader title={`Life claim ${c.claimNumber}`} subtitle={`${c.policyNumber} · life assured ${c.lifeAssuredName}`} actions={<Badge>{c.status}</Badge>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      {flagged && (
        <Alert kind="error">
          Flagged for review — possible duplicate of {c.flags.duplicateOf.join(', ')}. It will not be paid until reviewed.
          <div className="row" style={{ marginTop: '.4rem' }}><button className="btn sm secondary" disabled={!text.trim()} onClick={() => run(() => post('/clear-flag', { note: text }))}>Clear flag with note below</button></div>
        </Alert>
      )}
      {an.deathBenefitAlreadySettled && <Alert kind="error">The death benefit for this policy has already been settled. Another payout is not possible.</Alert>}

      <div className="grid grid-2">
        <Card title="Reported claim">
          <KV items={[
            ['Date of death', date(c.dateOfDeath)], ['Cause', `${c.causeOfDeath} (${c.causeType})`], ['Place', c.placeOfDeath],
            ['Claimant', `${c.claimant.name} (${c.claimant.relationship})`], ['Contact', `${c.claimant.email} · ${c.claimant.phone}`],
            ['Claimant ID', `${c.claimant.idType} ${c.claimant.idNumber}`], ['Identity verified', c.claimantVerified ? `✅ by ${c.claimantVerifiedBy}` : '⚠️ not yet'],
          ]} />
          {!c.claimantVerified && <button className="btn sm" style={{ marginTop: '.6rem' }} onClick={() => run(() => post('/verify-claimant'), 'Claimant verified')}>Mark claimant identity verified</button>}
        </Card>
        <Card title="Policy review at date of death">
          <KV items={[
            ['Status at date of death', <Badge key="s">{an.policyStatusAtDeath}</Badge>], ['Current status', an.currentPolicyStatus], ['Coverage', an.coveragePeriod],
            ['Sum assured', money(an.sumAssured)], ['Riders', an.riders.join(', ') || 'None'], an.accidentalBenefit > 0 && ['Accidental benefit', money(an.accidentalBenefit)],
            ['Suggested benefit', <strong key="b">{money(an.suggestedBenefit)}</strong>],
            ['Nominees at death', an.nomineesAtDeath ? an.nomineesAtDeath.nominees.map((n) => `${n.name} ${n.sharePct}%`).join(', ') + ` (v${an.nomineesAtDeath.version})` : 'None on record'],
            ['Other claims on policy', an.otherClaims.map((o) => `${o.claimNumber} (${o.status})`).join(', ') || 'None'],
          ]} />
          <details><summary>Nominee history</summary>
            {an.nomineeHistory.map((v) => <div key={v.version}><small>v{v.version} <Badge>{v.status}</Badge> {v.effectiveFrom && `${date(v.effectiveFrom)} – ${v.effectiveTo ? date(v.effectiveTo) : 'present'}`}: {v.nominees.map((n) => `${n.name} ${n.sharePct}%`).join(', ')}</small></div>)}
          </details>
        </Card>
      </div>

      {c.status === 'Reported' && <Card><button className="btn" onClick={() => run(() => post('/start-review'))}>Start review</button></Card>}

      {c.status === 'Under Review' && (
        <Card title="Beneficiaries & payout details">
          <p className="muted" style={{ marginTop: 0 }}>Pre-filled from the nominee record effective on the date of death. Verify each beneficiary's identity and bank details.</p>
          {bens.map((b, i) => (
            <div key={i} className="member-card">
              <div className="form-grid">
                <Field label="Name"><input value={b.name} onChange={(e) => setBen(i, { name: e.target.value })} /></Field>
                <Field label="Relationship"><input value={b.relationship} onChange={(e) => setBen(i, { relationship: e.target.value })} /></Field>
                <Field label="Entitlement basis"><select value={b.entitlement} onChange={(e) => setBen(i, { entitlement: e.target.value })}><option value="nominee">Nominee</option><option value="legal_heir">Legal heir (evidence)</option><option value="guardian_for_minor">Guardian for minor</option></select></Field>
                <Field label="Account holder"><input value={b.payoutDetails.accountName} onChange={(e) => setBen(i, { payoutDetails: { ...b.payoutDetails, accountName: e.target.value } })} /></Field>
                <Field label="Account number"><input value={b.payoutDetails.accountNumber} onChange={(e) => setBen(i, { payoutDetails: { ...b.payoutDetails, accountNumber: e.target.value } })} /></Field>
                <Field label="IFSC"><input value={b.payoutDetails.ifsc} onChange={(e) => setBen(i, { payoutDetails: { ...b.payoutDetails, ifsc: e.target.value.toUpperCase() } })} /></Field>
                <label className="check"><input type="checkbox" checked={b.verified} onChange={(e) => setBen(i, { verified: e.target.checked })} /> Identity & bank details verified</label>
              </div>
            </div>
          ))}
          <div className="row">
            <button className="btn secondary sm" onClick={() => setBens([...bens, { name: '', relationship: '', entitlement: 'legal_heir', verified: false, payoutDetails: { accountName: '', accountNumber: '', ifsc: '' } }])}>+ Add beneficiary</button>
            <button className="btn" disabled={act.busy} onClick={() => run(() => api.put(`/life-claims/${id}/beneficiaries`, { beneficiaries: bens.map((b) => ({ ...b, payoutDetails: b.payoutDetails.accountNumber ? b.payoutDetails : null })) }), 'Beneficiaries saved')}>Save beneficiaries</button>
          </div>
        </Card>
      )}

      {c.status === 'Under Review' && c.beneficiaries.length > 0 && (
        <Card title="Assessment & first approval">
          <Field label="Approved benefit (₹)"><input value={total} onChange={(e) => setTotal(e.target.value)} style={{ maxWidth: 240 }} /></Field>
          <div className="table-wrap" style={{ marginTop: '.6rem' }}><table>
            <thead><tr><th>Beneficiary</th><th>Verified</th><th className="num">Allocation (₹)</th></tr></thead>
            <tbody>
              {c.beneficiaries.map((b) => <tr key={b.id}><td>{b.name}</td><td>{b.verified ? '✅' : '⚠️'}</td><td><input value={alloc[b.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [b.id]: e.target.value })} /></td></tr>)}
              <tr className="total"><td colSpan={2}>Allocated</td><td className="num">{money(allocTotal)} {allocTotal === toPaise(total) ? '✓' : `(must equal ${money(toPaise(total))})`}</td></tr>
            </tbody>
          </table></div>
          <button className="btn" style={{ marginTop: '.6rem' }} disabled={act.busy} onClick={() => run(() => post('/assess', { approvedAmount: toPaise(total), allocations: c.beneficiaries.map((b) => ({ beneficiaryId: b.id, amount: toPaise(alloc[b.id] || '0') ?? 0 })), note: text }), 'First approval recorded')}>Record first approval</button>
        </Card>
      )}

      {c.status === 'Pending Second Approval' && (
        <Card title="Independent second approval">
          <KV items={[['Approved benefit', money(c.approvedAmount)], ['First approval', `${c.firstApproval.by} · ${dateTime(c.firstApproval.at)}`], ['Allocation', c.beneficiaries.map((b) => `${b.name}: ${money(b.allocation)}`).join('; ')]]} />
          {c.firstApproval.byId === user.id ? <Alert kind="warn">You gave the first approval; a different officer must approve.</Alert> : (
            <div className="row" style={{ marginTop: '.6rem' }}>
              <button className="btn" disabled={act.busy} onClick={() => run(() => post('/second-approval', { note: text }), 'Claim approved')}>Give second approval</button>
              <button className="btn secondary" disabled={act.busy || !text.trim()} onClick={() => run(() => post('/send-back', { reason: text }))}>Send back (reason below)</button>
            </div>
          )}
        </Card>
      )}

      {['Approved', 'Partially Paid', 'Settled'].includes(c.status) && (
        <Card title="Payouts">
          <Table rows={c.beneficiaries} columns={[
            { key: 'name', label: 'Beneficiary' }, { key: 'allocation', label: 'Amount', num: true, render: (b) => money(b.allocation) },
            { key: 'paid', label: 'Status', render: (b) => (b.paid ? <Badge kind="ok">Paid {b.paidRef}</Badge> : <Badge kind="warn">Unpaid</Badge>) },
          ]} />
          <p><Link to="/ops/payouts">Initiate and confirm payouts in Payment & payout review →</Link></p>
        </Card>
      )}

      {!['Settled', 'Rejected', 'Partially Paid'].includes(c.status) && (
        <Card title="Officer actions">
          <Field label="Note / reason"><textarea value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <div className="row" style={{ marginTop: '.6rem' }}>
            {['Reported', 'Under Review'].includes(c.status) && <button className="btn secondary" disabled={!text.trim()} onClick={() => run(() => post('/request-documents', { note: text }), 'Documents requested')}>Request documents</button>}
            <button className="btn danger" disabled={!text.trim()} onClick={() => window.confirm('Reject this claim?') && run(() => post('/reject', { reason: text }))}>Reject with explanation</button>
          </div>
        </Card>
      )}
      {c.rejection && <Alert kind="error">Rejected by {c.rejection.by}: {c.rejection.reason}</Alert>}

      <DocumentPanel entityType="lifeClaim" entityId={c.id} title="Claim evidence" categories={['death_certificate', 'claimant_id', 'entitlement_proof', 'bank_proof', 'medical_report', 'other']} />
      <div className="grid grid-2">
        <Card title="Internal notes">
          {c.internalNotes.map((n, i) => <div key={i}><small className="muted">{dateTime(n.at)} · {n.by}</small><div>{n.note}</div></div>)}
          <NoteBox onSave={(n) => run(() => post('/notes', { note: n }))} />
        </Card>
        <Card title="Timeline"><Timeline items={c.timeline} /></Card>
      </div>
    </>
  );
}

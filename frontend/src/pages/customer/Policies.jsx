import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BucketFilterNote } from './CustomerPages.jsx';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money, pct, titleCase } from '../../format.js';
import { Alert, Badge, Card, DevHint, ErrorBox, Field, KV, Loading, Modal, PageHeader, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { NomineeEditor, blankNominee } from '../../components/Editors.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';
import PayButton from '../../components/PayButton.jsx';

export function Policies() {
  const [params] = useSearchParams();
  const bucket = params.get('bucket') || '';
  const res = useLoad(() => api.get(`/policies${bucket ? `?bucket=${bucket}` : ''}`), [bucket]);
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Policies & documents" subtitle="Previous policies are kept with their claim history after renewal." />
      <BucketFilterNote bucket={bucket} path="/policies" />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No policies yet." onRowClick={(p) => nav(`/policies/${p.id}`)}
            columns={[
              { key: 'policyNumber', label: 'Policy' },
              { key: 'planName', label: 'Plan' },
              { key: 'holderName', label: 'Holder' },
              { key: 'period', label: 'Coverage period', render: (p) => `${date(p.startDate)} – ${date(p.endDate)}` },
              { key: 'cover', label: 'Cover', num: true, render: (p) => money(p.coverage ?? p.sumAssured) },
              { key: 'status', label: 'Status', render: (p) => <Badge>{p.status}</Badge> },
            ]} />
        )}
      </Card>
    </>
  );
}

export function PolicyDetail() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/policies/${id}`), [id]);
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const setTab = (t) => setParams({ tab: t }, { replace: true });
  const act = useAction();
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const p = res.data;
  const isOwner = user.role === 'customer';
  const tabs = [{ value: 'overview', label: 'Overview' }, { value: 'terms', label: 'Terms (frozen copy)' }, { value: 'documents', label: 'Documents & payments' }];
  if (p.product === 'life') tabs.splice(1, 0, { value: 'schedule', label: 'Premium schedule' }, { value: 'nominees', label: 'Nominees' });
  if (p.product === 'health') tabs.splice(1, 0, { value: 'claims', label: 'Claims' });

  return (
    <>
      <PageHeader title={p.policyNumber} subtitle={`${p.planName} · ${titleCase(p.product)} · terms version ${p.planVersion}`}
        actions={<><Badge>{p.status}</Badge><button className="btn secondary" onClick={() => act.run(() => api.download(`/policies/${p.id}/pdf`, `${p.policyNumber}.pdf`))}>Download policy PDF</button></>} />
      <ErrorBox error={act.error} />
      {p.status === 'Grace Period' && <Alert kind="warn">Premium overdue. Pay {money(p.outstandingAmount)} by {date(p.nextDue?.graceEnds)} to avoid lapse.</Alert>}
      {p.status === 'Lapsed' && <Alert kind="error">This policy has lapsed due to unpaid premiums. Request reinstatement from the Premium schedule tab.</Alert>}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid grid-2">
          <Card title="Summary">
            <KV items={[
              ['Policyholder', p.holderName],
              ['Coverage period', `${date(p.startDate)} – ${date(p.endDate)}`],
              p.product === 'health' && ['Sum insured', `${money(p.coverage)}${p.planType === 'floater' ? ' (shared)' : ''}`],
              p.product === 'health' && ['Continuity since', date(p.continuityStartDate)],
              p.product === 'life' && ['Life assured', `${p.lifeAssured.fullName} (DOB ${date(p.lifeAssured.dob)})`],
              p.product === 'life' && ['Sum assured', money(p.sumAssured)],
              p.product === 'life' && ['Premium', `${money(p.installmentPremium)} ${p.frequency}`],
              p.product === 'life' && ['Terms', `${p.policyTerm} yrs cover, ${p.premiumPaymentTerm} yrs payment`],
              ['Annual premium', money(p.annualPremium)],
              ['Issued', dateTime(p.issuedAt)],
              p.renewalOf && ['Renewal of', <Link key="r" to={`/policies/${p.renewalOf}`}>previous policy</Link>],
              p.renewedBy && ['Renewed by', <Link key="n" to={`/policies/${p.renewedBy}`}>next policy</Link>],
              p.terminatedOn && ['Terminated', `${date(p.terminatedOn)} — ${p.terminationReason}`],
            ]} />
          </Card>
          {p.product === 'health' ? (
            <>
              <Card title="Benefit balance">
                <KV items={[['Total cover', money(p.balance.total)], ['Reserved for approved claims', money(p.balance.reserved)], ['Paid out', money(p.balance.paid)], ['Available', <strong key="a">{money(p.balance.available)}</strong>]]} />
                {isOwner && <div className="row" style={{ marginTop: '.8rem' }}><Link className="btn" to={`/claims/new?policy=${p.id}`}>File a claim</Link></div>}
              </Card>
              <Card title="Insured members">
                <Table rows={p.members} columns={[{ key: 'fullName', label: 'Name' }, { key: 'relationship', label: 'Relationship' }, { key: 'dob', label: 'DOB', render: (m) => date(m.dob) }]} />
              </Card>
              {isOwner && <RenewalCard p={p} />}
            </>
          ) : (
            <Card title="Premiums">
              <KV items={[['Next due', p.nextDue ? `${money(p.nextDue.amount)} on ${date(p.nextDue.dueDate)}` : 'Fully paid'], ['Grace period', `${p.graceDays} days`], ['Overdue', money(p.outstandingAmount)], ['Installments paid', `${p.paidCount} of ${p.schedule.length}`], ['Auto-pay', p.autoPay ? 'On' : 'Off']]} />
            </Card>
          )}
        </div>
      )}

      {tab === 'schedule' && <Schedule p={p} isOwner={isOwner} reload={res.reload} />}
      {tab === 'nominees' && <Nominees p={p} isOwner={isOwner} reload={res.reload} />}
      {tab === 'claims' && (
        <Card title="Claims on this policy" actions={isOwner && <Link className="btn sm" to={`/claims/new?policy=${p.id}`}>File a claim</Link>}>
          <Table rows={p.claims} empty="No claims." columns={[
            { key: 'claimNumber', label: 'Claim', render: (c) => <Link to={`/claims/${c.id}`}>{c.claimNumber}</Link> },
            { key: 'type', label: 'Type', render: (c) => titleCase(c.type) },
            { key: 'status', label: 'Status', render: (c) => <Badge>{c.status}</Badge> },
            { key: 'requestedAmount', label: 'Requested', num: true, render: (c) => money(c.requestedAmount) },
            { key: 'approvedAmount', label: 'Approved', num: true, render: (c) => money(c.approvedAmount) },
          ]} />
        </Card>
      )}
      {tab === 'terms' && <TermsSnapshot p={p} />}
      {tab === 'documents' && (
        <>
          <DocumentPanel entityType="policy" entityId={p.id} canUpload={isOwner} categories={['identity', 'bank_proof', 'other']} />
          <Card title="Payments">
            <Table rows={p.payments} empty="No payments." columns={[
              { key: 'reference', label: 'Reference', render: (x) => <code>{x.reference}</code> }, { key: 'description', label: 'For' },
              { key: 'amount', label: 'Amount', num: true, render: (x) => money(x.amount) }, { key: 'status', label: 'Status', render: (x) => <Badge>{x.status}</Badge> },
              { key: 'completedAt', label: 'Date', render: (x) => dateTime(x.completedAt || x.createdAt) },
            ]} />
          </Card>
        </>
      )}
    </>
  );
}

function RenewalCard({ p }) {
  const nav = useNavigate();
  const act = useAction();
  const r = p.renewal;
  return (
    <Card title="Renewal">
      <KV items={[['Renewal window', `${date(r.opensOn)} – ${date(r.closesOn)}`], ['Terms version', `${r.previousPlanVersion} → ${r.currentPlanVersion ?? '—'}`]]} />
      {r.eligible || r.inProgressApplicationId ? (
        <>
          <p className="muted">Review members and declarations; the premium is recalculated with current renewal rules. Continuity is preserved when you renew within the window.</p>
          <button className="btn" disabled={act.busy} onClick={() => act.run(async () => { const x = await api.post(`/policies/${p.id}/renew`); nav(`/applications/${x.applicationId}`); })}>
            {r.inProgressApplicationId ? 'Continue renewal' : 'Renew policy'}
          </button>
        </>
      ) : <Alert kind="info">{r.reason}</Alert>}
      <ErrorBox error={act.error} />
    </Card>
  );
}

function Schedule({ p, isOwner, reload }) {
  const [showAll, setShowAll] = useState(false);
  const [goodHealth, setGoodHealth] = useState(true);
  const [changes, setChanges] = useState('');
  const act = useAction();
  const approved = p.reinstatements.find((r) => r.status === 'Approved');
  const open = p.reinstatements.find((r) => r.status === 'Requested');
  const rows = showAll ? p.schedule : p.schedule.filter((i) => i.status !== 'paid').slice(0, 6).concat(p.schedule.filter((i) => i.status === 'paid').slice(-3)).sort((a, b) => a.no - b.no);
  return (
    <>
      <Card title="Premium schedule" actions={isOwner && (
        <label className="check"><input type="checkbox" checked={p.autoPay} onChange={(e) => act.run(async () => { await api.post(`/policies/${p.id}/autopay`, { enabled: e.target.checked }); reload(); })} /> Auto-pay (simulated debit on due date)</label>
      )}>
        <ErrorBox error={act.error} />
        {isOwner && p.nextDue && ['Active', 'Grace Period'].includes(p.status) && (
          <div className="row" style={{ marginBottom: '1rem' }}>
            <PayButton key={p.nextDue.no} target={{ purpose: 'installment', policyId: p.id, installmentNo: p.nextDue.no }} amount={p.nextDue.amount} label={`Pay installment ${p.nextDue.no}`} onDone={reload} />
            <small className="muted">Due {date(p.nextDue.dueDate)} · grace until {date(p.nextDue.graceEnds)}</small>
          </div>
        )}
        <Table rows={rows} rowKey="no" columns={[
          { key: 'no', label: '#' }, { key: 'dueDate', label: 'Due date', render: (i) => date(i.dueDate) },
          { key: 'amount', label: 'Amount', num: true, render: (i) => money(i.amount) },
          { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
          { key: 'paidAt', label: 'Paid', render: (i) => (i.paidAt ? <>{date(i.paidAt)} <code>{i.paymentRef}</code></> : '') },
        ]} />
        <button className="btn ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show summary' : `Show all ${p.schedule.length} installments`}</button>
      </Card>
      {(p.status === 'Lapsed' || p.reinstatements.length > 0) && (
        <Card title="Reinstatement">
          {p.reinstatements.map((r) => <div key={r.id}><Badge>{r.status}</Badge> requested {dateTime(r.createdAt)} · arrears {money(r.arrears)}{r.reason && ` · ${r.reason}`}{r.payBy && ` · pay by ${date(r.payBy)}`}</div>)}
          {isOwner && p.status === 'Lapsed' && !open && !approved && (
            <div className="stack" style={{ marginTop: '.75rem' }}>
              <label className="check"><input type="checkbox" checked={goodHealth} onChange={(e) => setGoodHealth(e.target.checked)} /> I declare that the life assured is in good health.</label>
              <Field label="Health changes since issue (if any)"><textarea value={changes} onChange={(e) => setChanges(e.target.value)} /></Field>
              <button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/policies/${p.id}/reinstatement`, { goodHealthDeclaration: goodHealth, healthChanges: changes }); reload(); })}>Request reinstatement</button>
            </div>
          )}
          {isOwner && approved && (
            <div className="row" style={{ marginTop: '.75rem' }}>
              <PayButton target={{ purpose: 'reinstatement', policyId: p.id }} amount={p.outstandingAmount} label="Pay arrears & reinstate" onDone={reload} />
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function Nominees({ p, isOwner, reload }) {
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState(() => (p.currentNominees?.nominees || [blankNominee()]).map((n) => ({ ...n, guardian: n.guardian || { name: '', relationship: '', phone: '' } })));
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState(null);
  const act = useAction();
  const pending = p.pendingNominees;
  return (
    <>
      <Card title="Current nominees" actions={isOwner && !editing && !['Terminated', 'Expired'].includes(p.status) && <button className="btn sm" onClick={() => setEditing(true)}>Change nominees</button>}>
        <Table rows={p.currentNominees?.nominees || []} rowKey="name" columns={[
          { key: 'name', label: 'Name' }, { key: 'relationship', label: 'Relationship' }, { key: 'dob', label: 'DOB', render: (n) => date(n.dob) },
          { key: 'sharePct', label: 'Share', num: true, render: (n) => `${n.sharePct}%` },
          { key: 'guardian', label: 'Guardian', render: (n) => (n.isMinor ? `${n.guardian?.name} (${n.guardian?.relationship})` : '—') },
        ]} />
        <small className="muted">Effective from {date(p.currentNominees?.effectiveFrom)}. A nominee designation does not by itself authorise payment.</small>
      </Card>
      {pending && (
        <Card title="Pending change — verification required">
          <Alert kind="warn">The change below is not effective until you verify it. Your current nominees remain in force.</Alert>
          <p>{pending.nominees.map((n) => `${n.name} ${n.sharePct}%`).join(', ')}</p>
          <DevHint>{devOtp && <>verification code is <code>{devOtp}</code></>}</DevHint>
          <div className="row">
            <input style={{ maxWidth: 180 }} placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value)} />
            <button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/policies/${p.id}/nominees/verify`, { otp }); setDevOtp(null); setOtp(''); reload(); })}>Verify & apply</button>
          </div>
        </Card>
      )}
      <ErrorBox error={act.error} />
      <Modal open={editing} large title="Change nominees" onClose={() => setEditing(false)}>
        <NomineeEditor nominees={list} onChange={setList} />
        <ErrorBox error={act.error} />
        <div className="row end" style={{ marginTop: '1rem' }}>
          <button className="btn" disabled={act.busy} onClick={() => act.run(async () => {
            const r = await api.post(`/policies/${p.id}/nominees`, { nominees: list.map((n) => ({ ...n, sharePct: Number(n.sharePct) })) });
            setDevOtp(r.devOtp);
            setEditing(false);
            reload();
          })}>Request change</button>
        </div>
      </Modal>
      <Card title="Nominee history">
        <Table rows={p.nomineeVersions} rowKey="version" columns={[
          { key: 'version', label: 'Version' }, { key: 'status', label: 'Status', render: (v) => <Badge>{v.status}</Badge> },
          { key: 'nominees', label: 'Nominees', render: (v) => v.nominees.map((n) => `${n.name} (${n.sharePct}%)`).join(', ') },
          { key: 'eff', label: 'Effective', render: (v) => (v.effectiveFrom ? `${date(v.effectiveFrom)} – ${v.effectiveTo ? date(v.effectiveTo) : 'present'}` : '—') },
        ]} />
      </Card>
    </>
  );
}

function TermsSnapshot({ p }) {
  const c = p.termsSnapshot;
  return (
    <Card title={`Terms purchased (version ${p.planVersion})`}>
      <Alert kind="info">This is a frozen copy of the plan terms at purchase. Later plan changes do not affect this policy.</Alert>
      {p.product === 'health' ? (
        <KV items={[
          ['Initial waiting period', `${c.initialWaitingDays} days`], ['Condition waiting periods', c.conditionWaitingPeriods.map((w) => `${w.condition}: ${w.days} days`).join(', ')],
          ['Deductible per claim', money(c.deductiblePerClaim)], ['Co-payment', pct(c.copayBp)], ['Room rent limit', `${money(c.roomRentLimitPerDay)} / day`],
          ['Benefits', c.benefits.join('; ')], ['Exclusions', c.exclusions.map((e) => e.label).join('; ')],
        ]} />
      ) : (
        <KV items={[
          ['Grace period', `${p.graceDays} days`], ['Reinstatement window', `${c.reinstatementWindowDays} days`], ['Riders', p.riders.join(', ') || 'None'],
          ['Maturity benefit', 'None (term plan)'], ['Exclusions', c.exclusions.join('; ')],
        ]} />
      )}
    </Card>
  );
}

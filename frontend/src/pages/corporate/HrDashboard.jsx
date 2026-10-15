// Employer HR dashboard (/corporate). Aggregates only: claims and wellness figures are k-anonymous.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Stat, Table, useAction, useLoad } from '../../components/ui.jsx';
import { EmployerPicker, lakh, pctBp, Priv, Progress, SandboxNote, useCorpRole, useEmployerScope, useMeta } from './shared.jsx';

export default function HrDashboard() {
  const scope = useEmployerScope();
  const role = useCorpRole();
  const res = useLoad(() => (scope.ready ? api.get(`/corporate/dashboard${scope.qs()}`) : null), [scope.employerId, scope.ready]);
  const d = res.data;
  return (
    <>
      <PageHeader title="Employer dashboard" subtitle={d ? `${d.employer.name} · as of ${date(d.asOf)}` : 'Group benefits at a glance'} actions={<EmployerPicker scope={scope} />} />
      {res.loading && !d ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : !d ? null : (
        <>
          {d.label && <SandboxNote />}
          {['Suspended', 'Ended'].includes(d.employer.status) && <Alert kind="warn">This employer account is {d.employer.status}. Changes are disabled; contact your VHC account manager.</Alert>}
          <div className="corp-kpis">
            <Stat label="Employees on roster" value={d.totals.employeesOnRoster} to={`/corporate/employees${scope.suffix}`} />
            <Stat label="Eligible employees" value={d.totals.eligibleEmployees} />
            <div className="stat">
              <div className="label">Enrolled employees</div>
              <div className="value">{d.totals.enrolledEmployees}</div>
              <Progress bp={d.totals.enrolmentCompletionBp} label="Enrolment completion" />
              <div className="sub">{pctBp(d.totals.enrolmentCompletionBp)} enrolment completion</div>
            </div>
            <Stat label="Covered dependents" value={d.totals.coveredDependents} />
            <Stat label="Active group policies" value={d.totals.activeGroupPolicies} to={`/corporate/policies${scope.suffix}`} />
            <Stat label="Awaiting insurer" value={d.totals.pendingConfirmation} />
          </div>
          <div className="corp-two">
            <div>
              <Card title="Group policies" actions={<Link to={`/corporate/policies${scope.suffix}`}>View all</Link>}>
                {d.policies.length === 0 ? <Empty>No active group policy yet. Your VHC account manager sets this up once the contract is signed.</Empty> : (
                  <ul className="corp-list">
                    {d.policies.map((p) => (
                      <li key={p.id}>
                        <div>
                          <Link to={`/corporate/policies/${p.id}${scope.suffix}`}><strong>{p.policyNumber}</strong></Link> · {p.productName}
                          <div className="meta">{p.insurerName} · {lakh(p.sumInsured)} · {p.familyLabel} · {date(p.startDate)} – {date(p.endDate)}</div>
                          <div className="meta">Enrolment window {date(p.enrolmentWindow?.opensOn)} – {date(p.enrolmentWindow?.closesOn)}</div>
                        </div>
                        <div style={{ minWidth: 150 }}>
                          <small className="muted">{p.stats.enrolled}/{p.stats.eligible} enrolled · {p.stats.coveredLives} lives</small>
                          <Progress bp={p.stats.completionBp} label={`${p.policyNumber} enrolment completion`} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Pending endorsements" actions={<Link to={`/corporate/endorsements${scope.suffix}`}>All endorsements</Link>}>
                <Table rows={d.pendingEndorsements.items} empty="No endorsements are waiting for the insurer." columns={[
                  { key: 'endorsementNumber', label: 'Endorsement' },
                  { key: 'type', label: 'Type', render: (e) => <span style={{ textTransform: 'capitalize' }}>{e.type} · {e.reason.replace(/_/g, ' ')}</span> },
                  { key: 'effectiveDate', label: 'Effective', render: (e) => date(e.effectiveDate) },
                  { key: 'total', label: 'Amount', num: true, render: (e) => (e.direction === 'credit' ? `− ${money(e.total)}` : money(e.total)) },
                  { key: 'status', label: 'Status', render: (e) => <Badge>{e.status}</Badge> },
                ]} />
              </Card>
              <Card title="Premium invoices" actions={<Link to={`/corporate/invoices${scope.suffix}`}>Billing</Link>}>
                <div className="grid grid-3" style={{ marginBottom: '.75rem' }}>
                  <div><div className="muted">Outstanding</div><strong>{money(d.invoices.outstandingAmount)}</strong> <small className="muted">({d.invoices.outstandingCount})</small></div>
                  <div><div className="muted">Overdue</div><strong>{d.invoices.overdueCount}</strong></div>
                  <div><div className="muted">Paid</div><strong>{money(d.invoices.paidAmount)}</strong> <small className="muted">({d.invoices.paidCount})</small></div>
                </div>
                <Table rows={d.invoices.recent} empty="No invoices yet." columns={[
                  { key: 'invoiceNumber', label: 'Invoice' }, { key: 'typeLabel', label: 'Type' },
                  { key: 'total', label: 'Amount', num: true, render: (i) => (i.direction === 'credit' ? `− ${money(i.total)}` : money(i.total)) },
                  { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
                ]} />
              </Card>
              <Card title="Upcoming renewals">
                {d.upcomingRenewals.length === 0 ? <Empty>No renewals due in the next 90 days.</Empty> : (
                  <ul className="corp-list">
                    {d.upcomingRenewals.map((r) => (
                      <li key={r.id}><span><strong>{r.policyNumber}</strong> ends {date(r.endDate)}</span><Badge kind={r.daysLeft < 30 ? 'warn' : 'info'}>{r.daysLeft >= 0 ? `${r.daysLeft} days` : r.status}</Badge></li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <div>
              <Card title="Claims (aggregate)">
                {d.claims.suppressed ? (
                  <Alert kind="info">{d.claims.note}</Alert>
                ) : (
                  <>
                    <dl className="kv">
                      <dt>Claims reported</dt><dd>{d.claims.claimsReported}</dd>
                      <dt>Claimed (band)</dt><dd>{d.claims.claimedAmountBand}</dd>
                      <dt>Settled (band)</dt><dd>{d.claims.settledAmountBand}</dd>
                      {Object.entries(d.claims.byStatus).map(([k, v]) => [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`}><Priv cell={v} /></dd>])}
                    </dl>
                  </>
                )}
                <p className="corp-privacy">{d.privacy}</p>
              </Card>
              <Card title="Wellness participation" actions={<Link to={`/corporate/wellness${scope.suffix}`}>Programmes</Link>}>
                {d.wellness.programmes.length === 0 ? <Empty>No wellness programmes contracted.</Empty> : (
                  <ul className="corp-list">
                    {d.wellness.programmes.map((p) => <li key={p.id}><span>{p.name}<div className="meta">{p.typeLabel} · <Badge>{p.status}</Badge></div></span><strong><Priv cell={p.participation} format={(v) => `${v} opted in`} /></strong></li>)}
                  </ul>
                )}
              </Card>
              <Card title="Benefits adoption">
                <dl className="kv">
                  <dt>Employees with a linked VHC account</dt><dd>{d.totals.linkedEmployeeAccounts} of {d.totals.employeesOnRoster}</dd>
                  <dt>Covered lives</dt><dd>{d.totals.coveredLives}</dd>
                </dl>
              </Card>
              <SupportCard d={d} canRaise={role.corp && !['Suspended', 'Ended'].includes(d.employer.status)} reload={res.reload} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function SupportCard({ d, canRaise, reload }) {
  const meta = useMeta();
  const list = useLoad(() => (canRaise ? api.get('/corporate/support') : null), [canRaise]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ category: 'enrolment', subject: '', message: '' });
  const act = useAction();
  const fe = act.error?.fields || {};
  const mine = canRaise ? list.data?.requests || [] : [];
  return (
    <Card title="Support requests" actions={canRaise && <button className="btn sm secondary" onClick={() => setOpen(true)}>Raise a request</button>}>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <dl className="kv">
        <dt>Your open requests</dt><dd>{d.support.employerOpen} of {d.support.employerTotal}</dd>
        <dt>Employee requests</dt><dd>{d.support.employee.total} ({d.support.employee.open} open)</dd>
      </dl>
      {mine.length > 0 && (
        <ul className="corp-list" style={{ marginTop: '.5rem' }}>
          {mine.slice(0, 5).map((x) => <li key={x.id}><span>{x.subject}<div className="meta">{x.reference} · {meta.data?.supportCategories?.[x.category] || x.category}{x.responses?.length ? ` · ${x.responses[x.responses.length - 1].message}` : ''}</div></span><Badge>{x.status}</Badge></li>)}
        </ul>
      )}
      <p className="corp-privacy">{d.support.employee.note}</p>
      <Modal open={open} title="Raise a support request" onClose={() => setOpen(false)}>
        <ErrorBox error={act.error} />
        <div className="form-grid">
          <Field label="Category" error={fe.category}>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {Object.entries(meta.data?.supportCategories || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Subject" error={fe.subject}><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={120} /></Field>
          <Field label="Details" error={fe.message} className="full"><textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={2000} /></Field>
        </div>
        <p className="muted" style={{ fontSize: '.85rem' }}>Please don't include employees' medical details. VHC support will reply here.</p>
        <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.post('/corporate/support', f); setOpen(false); setF({ category: 'enrolment', subject: '', message: '' }); list.reload(); reload(); }, 'Request sent to VHC support')}>Send</button></div>
      </Modal>
    </Card>
  );
}

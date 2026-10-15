// Mid-term endorsements (/corporate/endorsements) and the insurer confirmation page for sandbox insurer users.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money } from '../../format.js';
import { Badge, Card, ErrorBox, Loading, PageHeader, Table, useLoad } from '../../components/ui.jsx';
import { EmployerPicker, useEmployerScope, useMeta } from './shared.jsx';
import { ConfirmationQueue } from './GroupPolicies.jsx';

export function Endorsements() {
  const scope = useEmployerScope({ allowAll: true });
  const meta = useMeta();
  const [status, setStatus] = useState('');
  const res = useLoad(() => api.get(`/corporate/endorsements${scope.qs({ status })}`), [scope.employerId, status]);
  return (
    <>
      <PageHeader title="Endorsements" subtitle="Mid-term additions (joiners, new dependents) and deletions (leavers, removed dependents), confirmed by the insurer." />
      <div className="corp-toolbar">
        <div className="filters" role="group" aria-label="Filter endorsements">
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option><option>Pending Insurer</option><option>Confirmed</option><option>Rejected</option>
            </select>
          </label>
        </div>
        <EmployerPicker scope={scope} allowAll />
      </div>
      <Card>
        {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No endorsements yet." columns={[
            { key: 'endorsementNumber', label: 'Endorsement', render: (e) => <><strong>{e.endorsementNumber}</strong><div className="muted">{e.policyNumber}</div></> },
            { key: 'employee', label: 'Employee', render: (e) => (e.memberId ? <Link to={`/corporate/employees/${e.memberId}${scope.corp ? '' : `?employer=${e.employerId}`}`}>{e.employeeName}</Link> : '—') },
            { key: 'type', label: 'Change', render: (e) => <span style={{ textTransform: 'capitalize' }}>{e.type} · {e.reason.replace(/_/g, ' ')}<div className="muted">{e.lives.length} li{e.lives.length === 1 ? 'fe' : 'ves'}</div></span> },
            { key: 'effectiveDate', label: 'Effective', render: (e) => date(e.effectiveDate) },
            { key: 'calc', label: 'Pro-rata', render: (e) => <small>{e.days}/{e.policyDays} days of {money(e.annualPremium)}</small> },
            { key: 'total', label: 'Amount (incl. GST)', num: true, render: (e) => (e.direction === 'credit' ? `− ${money(e.total)}` : money(e.total)) },
            { key: 'status', label: 'Status', render: (e) => <><Badge>{e.status}</Badge>{e.invoiceId && <div className="muted">Invoiced</div>}</> },
          ]} />
        )}
        <p className="corp-privacy">{meta.data?.proRataNote || 'Daily pro-rata (sandbox assumption).'}</p>
      </Card>
    </>
  );
}

/** Sandbox insurer users decide pending group confirmations here. */
export function InsurerConfirmations() {
  return (
    <>
      <PageHeader title="Group confirmations" subtitle="Group policies, member enrolments and endorsements awaiting the VHC Sandbox Insurer (Synthetic)." />
      <ConfirmationQueue canDecide />
    </>
  );
}

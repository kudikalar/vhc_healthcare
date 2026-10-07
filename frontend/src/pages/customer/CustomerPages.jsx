import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { dateTime, money, titleCase } from '../../format.js';
import { Badge, Card, ErrorBox, Loading, PageHeader, Table, useAction, useLoad } from '../../components/ui.jsx';

export function Notifications() {
  const res = useLoad(() => api.get('/notifications'));
  const nav = useNavigate();
  if (res.loading) return <Loading />;
  const open = async (n) => {
    if (!n.read) await api.post(`/notifications/${n.id}/read`);
    if (n.link) nav(n.link); else res.reload();
  };
  return (
    <>
      <PageHeader title="Notifications" subtitle={`${res.data.unread} unread · email delivery is simulated`} actions={<button className="btn secondary" onClick={async () => { await api.post('/notifications/read-all'); res.reload(); }}>Mark all read</button>} />
      <Card>
        <Table rows={res.data.notifications} empty="No notifications." onRowClick={open}
          columns={[
            { key: 'read', label: '', render: (n) => (n.read ? '' : <Badge kind="info">New</Badge>) },
            { key: 'title', label: 'Title', render: (n) => <strong>{n.title}</strong> },
            { key: 'message', label: 'Message' },
            { key: 'createdAt', label: 'When', render: (n) => dateTime(n.createdAt) },
          ]} />
      </Card>
    </>
  );
}

const BUCKET_LABEL = { pending: 'In progress', action: 'Needs your action', active: 'Active', due: 'Premium due within 30 days', open: 'Open' };

export function BucketFilterNote({ bucket, path }) {
  if (!bucket) return null;
  return <div className="alert info">Showing: <strong>{BUCKET_LABEL[bucket] || bucket}</strong> · <Link to={path}>Show all</Link></div>;
}

export function Applications() {
  const [params] = useSearchParams();
  const bucket = params.get('bucket') || '';
  const res = useLoad(() => api.get(`/applications${bucket ? `?bucket=${bucket}` : ''}`), [bucket]);
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="My applications" subtitle="Quotes are valid for 7 days." actions={<Link className="btn" to="/plans">New application</Link>} />
      <BucketFilterNote bucket={bucket} path="/applications" />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No applications yet — choose a plan to start." onRowClick={(a) => nav(`/applications/${a.id}`)}
            columns={[
              { key: 'applicationNumber', label: 'Application' },
              { key: 'planName', label: 'Plan', render: (a) => <>{a.planName}{a.renewalOf && <Badge kind="info">Renewal</Badge>}</> },
              { key: 'product', label: 'Product', render: (a) => titleCase(a.product) },
              { key: 'status', label: 'Status', render: (a) => <Badge>{a.status}</Badge> },
              { key: 'premium', label: 'Annual premium', num: true, render: (a) => money(a.premium) },
              { key: 'updatedAt', label: 'Updated', render: (a) => dateTime(a.updatedAt) },
            ]} />
        )}
      </Card>
    </>
  );
}

export function Payments() {
  const res = useLoad(() => api.get('/payments'));
  const [receipt, setReceipt] = useState(null);
  const act = useAction();
  return (
    <>
      <PageHeader title="Payments & receipts" />
      <ErrorBox error={act.error} />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No payments yet."
            columns={[
              { key: 'reference', label: 'Reference', render: (p) => <code>{p.reference}</code> },
              { key: 'description', label: 'For' },
              { key: 'amount', label: 'Amount', num: true, render: (p) => money(p.amount) },
              { key: 'method', label: 'Paid with', render: (p) => (p.card ? <span>{p.card.brand} •••• {p.card.last4}</span> : <span className="muted">{p.autoPay ? 'Auto-debit' : 'Test gateway'}</span>) },
              { key: 'status', label: 'Status', render: (p) => <><Badge>{p.status}</Badge>{p.autoPay && <small className="muted"> auto-debit</small>}</> },
              { key: 'createdAt', label: 'Date', render: (p) => dateTime(p.completedAt || p.createdAt) },
              { key: 'x', label: '', render: (p) => (
                <div className="row">
                  {p.status === 'success' && <button className="btn sm secondary" onClick={() => setReceipt(p)}>Receipt</button>}
                  {p.status === 'pending' && <button className="btn sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/payments/${p.reference}/simulate`, { outcome: 'success' }); res.reload(); })}>Bank confirms (test)</button>}
                </div>
              ) },
            ]} />
        )}
      </Card>
      {receipt && (
        <Card title="Payment receipt" actions={<><button className="btn sm secondary" onClick={() => window.print()}>Print</button><button className="btn sm ghost" onClick={() => setReceipt(null)}>Close</button></>}>
          <dl className="kv">
            <dt>Receipt for</dt><dd>{receipt.description}</dd>
            <dt>Reference</dt><dd><code>{receipt.reference}</code></dd>
            <dt>Amount received</dt><dd>{money(receipt.amount)}</dd>
            <dt>Paid on</dt><dd>{dateTime(receipt.completedAt)}</dd>
            <dt>Method</dt><dd>{receipt.card ? `${receipt.card.brand} card •••• ${receipt.card.last4} (test mode)` : receipt.method}{receipt.autoPay ? ' (auto-debit)' : ''}</dd>
          </dl>
        </Card>
      )}
    </>
  );
}

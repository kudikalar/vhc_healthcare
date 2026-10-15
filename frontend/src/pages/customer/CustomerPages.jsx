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

const paidWith = (p) => (p.card ? <span>{p.card.brand} •••• {p.card.last4}</span>
  : p.upi ? <span>{p.upi.qr ? 'UPI QR' : `UPI · ${p.upi.vpa}`}</span>
    : p.netbanking ? <span>Netbanking · {p.netbanking.bankName}</span>
      : <span className="muted">{p.autoPay ? 'Auto-debit' : 'Test gateway'}</span>);
const REFUND_LABEL = { pending: 'Refund initiated', partially_refunded: 'Partially refunded', refunded: 'Refunded', refund_failed: 'Refund failed — we will retry' };

export function Payments() {
  const res = useLoad(() => api.get('/payments'));
  const links = useLoad(() => api.get('/payments/links').catch(() => []));
  const [receipt, setReceipt] = useState(null);
  const act = useAction();
  const download = (p, kind) => act.run(() => api.download(`/payments/${p.reference}/${kind}.pdf`, `${kind === 'invoice' ? 'INV' : 'RCPT'}-${p.reference}.pdf`));
  const refunds = (res.data || []).flatMap((p) => (p.refunds || []).map((r) => ({ ...r, paymentReference: p.reference, description: p.description })));
  return (
    <>
      <PageHeader title="Payments & receipts" subtitle="Sandbox payments — no real money moves. Receipts and invoices are sandbox specimens." />
      <ErrorBox error={act.error} />
      <Card>
        {res.loading ? <Loading /> : (
          <Table rows={res.data} empty="No payments yet."
            columns={[
              { key: 'reference', label: 'Reference', render: (p) => <code>{p.reference}</code> },
              { key: 'description', label: 'For' },
              { key: 'amount', label: 'Amount', num: true, render: (p) => money(p.amount) },
              { key: 'method', label: 'Paid with', render: paidWith },
              { key: 'status', label: 'Status', render: (p) => (
                <>
                  <Badge>{p.status}</Badge>{p.autoPay && <small className="muted"> auto-debit</small>}
                  {p.refundStatus && <div><Badge kind={p.refundStatus === 'refund_failed' ? 'error' : 'info'}>{REFUND_LABEL[p.refundStatus] || p.refundStatus}</Badge></div>}
                  {['failed', 'expired'].includes(p.status) && p.failureReason && <div className="muted" style={{ fontSize: '.8rem' }}>{p.failureReason}</div>}
                </>
              ) },
              { key: 'createdAt', label: 'Date', render: (p) => dateTime(p.completedAt || p.createdAt) },
              { key: 'x', label: '', render: (p) => (
                <div className="row">
                  {['success', 'refund_due', 'refunded'].includes(p.status) && (
                    <>
                      <button className="btn sm secondary" onClick={() => setReceipt(p)}>Receipt</button>
                      <button className="btn sm ghost" disabled={act.busy} onClick={() => download(p, 'receipt')}>PDF</button>
                      <button className="btn sm ghost" disabled={act.busy} onClick={() => download(p, 'invoice')}>Invoice</button>
                    </>
                  )}
                  {p.status === 'pending' && <button className="btn sm" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/payments/${p.reference}/simulate`, { outcome: 'success' }); res.reload(); })}>Bank confirms (test)</button>}
                </div>
              ) },
            ]} />
        )}
      </Card>
      {refunds.length > 0 && (
        <Card title="Refunds">
          <Table rows={refunds} columns={[
            { key: 'reference', label: 'Refund', render: (r) => <code>{r.reference}</code> },
            { key: 'paymentReference', label: 'Of payment', render: (r) => <><code>{r.paymentReference}</code><div className="muted">{r.description}</div></> },
            { key: 'amount', label: 'Amount', num: true, render: (r) => <>{money(r.amount)}{r.partial && <div className="muted">partial</div>}</> },
            { key: 'reason', label: 'Reason' },
            { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
            { key: 'createdAt', label: 'Initiated', render: (r) => dateTime(r.createdAt) },
          ]} />
          <p className="muted" style={{ fontSize: '.85rem', marginBottom: 0 }}>Refunds go back to the original payment method. In the sandbox they complete instantly once finance approves them.</p>
        </Card>
      )}
      {links.data?.length > 0 && (
        <Card title="Payment links">
          <Table rows={links.data} columns={[
            { key: 'code', label: 'Link', render: (l) => (l.status === 'active' ? <Link to={l.path}>{l.code}</Link> : <code>{l.code}</code>) },
            { key: 'description', label: 'For' }, { key: 'amount', label: 'Amount', num: true, render: (l) => money(l.amount) },
            { key: 'status', label: 'Status', render: (l) => <Badge>{l.status}</Badge> }, { key: 'expiresAt', label: 'Expires', render: (l) => dateTime(l.expiresAt) },
          ]} />
        </Card>
      )}
      {receipt && (
        <Card title="Payment receipt" actions={<><button className="btn sm secondary" onClick={() => download(receipt, 'receipt')}>Download PDF</button><button className="btn sm secondary" onClick={() => window.print()}>Print</button><button className="btn sm ghost" onClick={() => setReceipt(null)}>Close</button></>}>
          <dl className="kv">
            <dt>Receipt for</dt><dd>{receipt.description}</dd>
            <dt>Reference</dt><dd><code>{receipt.reference}</code></dd>
            <dt>Amount received</dt><dd>{money(receipt.amount)}</dd>
            <dt>Paid on</dt><dd>{dateTime(receipt.completedAt)}</dd>
            <dt>Method</dt><dd>{paidWith(receipt)} ({receipt.mode || 'test'} mode){receipt.autoPay ? ' (auto-debit)' : ''}</dd>
            {receipt.refundedAmount ? <><dt>Refunded</dt><dd>{money(receipt.refundedAmount)}</dd></> : null}
          </dl>
          <p className="muted" style={{ fontSize: '.85rem' }}>Premium is collected on behalf of the insurer named on your policy and is passed on to them.</p>
        </Card>
      )}
    </>
  );
}

// Corporate billing (/corporate/invoices): invoices and credit notes, simulated test-mode payment,
// reconciliation against the ledgers and the renewal forecast.
import { useState } from 'react';
import { api } from '../../api.js';
import { date, money } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, Modal, PageHeader, Stat, Table, Tabs, useAction, useLoad } from '../../components/ui.jsx';
import { downloadPdf, EmployerPicker, pctBp, SandboxNote, signed, useCorpRole, useEmployerScope, useMeta } from './shared.jsx';

export default function Invoices() {
  const scope = useEmployerScope({ allowAll: true });
  const role = useCorpRole();
  const canRecon = !role.corp || role.corpAdmin;
  const [tab, setTab] = useState('invoices');
  return (
    <>
      <PageHeader title="Invoices & billing" subtitle="Group premium is collected for the insurer; only the corporate service fee is VHC income." actions={<EmployerPicker scope={scope} allowAll />} />
      <SandboxNote>Payments here are simulated in test mode — no money moves and no card details are accepted.</SandboxNote>
      {canRecon && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'invoices', label: 'Invoices' }, { value: 'recon', label: 'Reconciliation' }, { value: 'forecast', label: 'Renewal forecast' }]} />}
      {tab === 'invoices' && <InvoiceList scope={scope} role={role} />}
      {tab === 'recon' && canRecon && <Reconciliation scope={scope} role={role} />}
      {tab === 'forecast' && canRecon && <Forecast scope={scope} />}
    </>
  );
}

function InvoiceList({ scope, role }) {
  const res = useLoad(() => api.get(`/corporate/invoices${scope.qs()}`), [scope.employerId]);
  const [open, setOpen] = useState(null);
  const [fee, setFee] = useState(false);
  const act = useAction();
  return (
    <>
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <Card actions={role.finance && !role.readOnly && scope.employerId && <button className="btn sm secondary" onClick={() => setFee(true)}>Service-fee invoice</button>}>
        {res.loading && !res.data ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : (
          <Table rows={res.data} empty="No invoices yet." onRowClick={(i) => setOpen(i.id)} columns={[
            { key: 'invoiceNumber', label: 'Number', render: (i) => <><strong>{i.invoiceNumber}</strong>{!scope.corp && <div className="muted">{i.employerName}</div>}</> },
            { key: 'typeLabel', label: 'Type', render: (i) => <>{i.typeLabel}<div className="muted">{i.policyNumber || i.period}</div></> },
            { key: 'issueDate', label: 'Issued', render: (i) => date(i.issueDate) },
            { key: 'dueDate', label: 'Due', render: (i) => (i.dueDate ? date(i.dueDate) : '—') },
            { key: 'total', label: 'Amount', num: true, render: signed },
            { key: 'status', label: 'Status', render: (i) => <Badge>{i.status}</Badge> },
          ]} />
        )}
      </Card>
      {open && <InvoiceModal id={open} role={role} onClose={() => setOpen(null)} onChanged={(msg) => { res.reload(); act.setMessage(msg); }} />}
      {fee && <ServiceFeeModal employerId={scope.employerId} onClose={() => setFee(false)} onDone={(inv) => { setFee(false); res.reload(); act.setMessage(`${inv.invoiceNumber} issued`); }} />}
    </>
  );
}

function InvoiceModal({ id, role, onClose, onChanged }) {
  const meta = useMeta();
  const res = useLoad(() => api.get(`/corporate/invoices/${id}`), [id]);
  const [method, setMethod] = useState('test_netbanking');
  const act = useAction();
  const inv = res.data;
  const canPay = inv && inv.direction === 'debit' && inv.status === 'Issued' && !role.readOnly && (role.finance || role.corpAdmin);
  const canCredit = inv && inv.direction === 'credit' && inv.status === 'Issued' && role.finance && !role.readOnly;
  const doIt = (fn, msg) => act.run(async () => { await fn(); res.reload(); onChanged(msg); });
  return (
    <Modal open title={inv ? `${inv.invoiceNumber}` : 'Invoice'} onClose={onClose} large>
      {!inv ? <Loading /> : (
        <>
          <ErrorBox error={act.error} />
          <KV items={[
            ['Type', inv.typeLabel], ['Employer', `${inv.employerName}${inv.gstin ? ` · GSTIN ${inv.gstin}` : ''}`], inv.policyNumber && ['Group policy', `${inv.policyNumber} · statement ${inv.insurerStatementRef}`],
            ['Period', inv.period], ['Issued', date(inv.issueDate)], inv.dueDate && ['Due', date(inv.dueDate)], ['Status', <Badge key="s">{inv.status}</Badge>],
            inv.payment && ['Payment', `${inv.payment.reference} · ${inv.payment.method.replace('test_', '')} (test mode) · ${date(inv.payment.paidAt)}`],
          ]} />
          <table className="calc">
            <tbody>
              {inv.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{money(l.amount)}</td></tr>)}
              <tr className="total"><td>Total {inv.direction === 'credit' ? 'credit' : 'payable'}</td><td className="num">{money(inv.total)}</td></tr>
            </tbody>
          </table>
          {inv.ledgerEntries && (
            <>
              <h4 style={{ margin: '1rem 0 .4rem' }}>Ledger postings</h4>
              <Table rows={inv.ledgerEntries} empty="Not posted yet (posted when the invoice is settled)." columns={[
                { key: 'ledger', label: 'Ledger' }, { key: 'direction', label: 'Dr/Cr' }, { key: 'amount', label: 'Amount', num: true, render: (e) => money(e.amount) }, { key: 'mode', label: 'Mode' },
              ]} />
            </>
          )}
          <div className="row end" style={{ marginTop: '1rem' }}>
            <button className="btn secondary" onClick={() => act.run(() => downloadPdf(`/corporate/invoices/${inv.id}/pdf`, inv.invoiceNumber))}>Download PDF</button>
            {canPay && (
              <>
                <Field label="Test payment method" className="corp-inline">
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>{(meta.data?.testPaymentMethods || ['test_netbanking']).map((m) => <option key={m} value={m}>{m.replace('test_', '').toUpperCase()} (test)</option>)}</select>
                </Field>
                <button className="btn" disabled={act.busy} onClick={() => doIt(() => api.post(`/corporate/invoices/${inv.id}/pay`, { method }), `${inv.invoiceNumber} marked paid (simulated)`)}>Pay (simulated)</button>
              </>
            )}
            {canCredit && <button className="btn" disabled={act.busy} onClick={() => doIt(() => api.post(`/corporate/invoices/${inv.id}/apply-credit`), 'Credit note applied')}>Apply credit</button>}
            {role.finance && !role.readOnly && ['Paid', 'Credit Applied'].includes(inv.status) && <button className="btn secondary" disabled={act.busy} onClick={() => doIt(() => api.post(`/corporate/invoices/${inv.id}/post-ledger`), 'Ledger posting re-run (idempotent)')}>Re-run ledger posting</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

function ServiceFeeModal({ employerId, onClose, onDone }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const act = useAction();
  return (
    <Modal open title="Corporate service-fee invoice" onClose={onClose}>
      <ErrorBox error={act.error} />
      <Field label="Month" hint="Fee = covered employees in the month × contracted per-member fee, plus 18% GST" error={act.error?.fields?.month}><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
      <div className="row end" style={{ marginTop: '.75rem' }}><button className="btn" disabled={act.busy} onClick={() => act.run(async () => onDone(await api.post(`/corporate/employers/${employerId}/service-fee-invoice`, { month })))}>Issue invoice</button></div>
    </Modal>
  );
}

function Reconciliation({ scope }) {
  const res = useLoad(() => api.get(`/corporate/reconciliation${scope.qs()}`), [scope.employerId]);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const r = res.data;
  return (
    <>
      <div className="corp-kpis">
        <Stat label="Billed" value={money(r.totals.billed)} />
        <Stat label="Paid" value={money(r.totals.paid)} />
        <Stat label="Outstanding" value={money(r.totals.outstanding)} />
        <Stat label="Overdue" value={money(r.totals.overdue)} />
        <Stat label="Credit notes" value={money(r.totals.credits)} />
        <Stat label="Premium facilitated (net)" value={money(r.totals.premiumFacilitatedNet)} />
        <Stat label="Service-fee revenue" value={money(r.totals.serviceFeeRevenue)} />
      </div>
      {r.mismatches.length > 0 ? <Alert kind="error">{r.mismatches.length} invoice(s) do not match their ledger postings: {r.mismatches.map((m) => m.invoiceNumber).join(', ')}</Alert> : <Alert kind="ok">All invoices reconcile with the ledgers.</Alert>}
      {(r.unbilled.enrolments > 0 || r.unbilled.endorsements > 0) && <Alert kind="info">Not yet invoiced: {r.unbilled.enrolments} confirmed enrolment(s) ({money(r.unbilled.enrolmentPremium)} net) and {r.unbilled.endorsements} endorsement(s) ({money(r.unbilled.endorsementNet)}).</Alert>}
      <Card>
        <Table rows={r.rows} empty="No invoices." columns={[
          { key: 'invoiceNumber', label: 'Invoice', render: (x) => <><strong>{x.invoiceNumber}</strong>{!scope.corp && <div className="muted">{x.employerName}</div>}</> },
          { key: 'typeLabel', label: 'Type' }, { key: 'status', label: 'Status', render: (x) => <><Badge>{x.status}</Badge>{x.overdue && <Badge kind="error">Overdue</Badge>}</> },
          { key: 'total', label: 'Invoice', num: true, render: (x) => money(x.total) },
          { key: 'expectedLedger', label: 'Expected ledger', num: true, render: (x) => money(x.expectedLedger) },
          { key: 'ledgerPosted', label: 'Posted', num: true, render: (x) => money(x.ledgerPosted) },
          { key: 'reconciled', label: '', render: (x) => <Badge kind={x.reconciled ? 'ok' : 'error'}>{x.reconciled ? 'Matched' : 'Mismatch'}</Badge> },
        ]} />
        <p className="corp-privacy">{r.note}</p>
      </Card>
    </>
  );
}

function Forecast({ scope }) {
  const res = useLoad(() => api.get(`/corporate/forecast${scope.qs()}`), [scope.employerId]);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  return (
    <Card title="Contract & renewal forecast">
      <Table rows={res.data.rows.map((x) => ({ ...x, id: x.groupPolicyId }))} empty="No active group policies." columns={[
        { key: 'policyNumber', label: 'Policy', render: (x) => <><strong>{x.policyNumber}</strong>{!scope.corp && <div className="muted">{x.employerName}</div>}</> },
        { key: 'renewalDate', label: 'Renews', render: (x) => <>{date(x.renewalDate)}<div className="muted">{x.daysToRenewal} days</div></> },
        { key: 'currentAnnualPremium', label: 'Current (net)', num: true, render: (x) => <>{money(x.currentAnnualPremium)}<div className="muted">{x.currentLives} lives</div></> },
        { key: 'projectedNetPremium', label: 'Projected (net)', num: true, render: (x) => <>{money(x.projectedNetPremium)}<div className="muted">{x.changeBp >= 0 ? '+' : ''}{pctBp(x.changeBp)}</div></> },
        { key: 'projectedTotal', label: 'Projected incl. GST', num: true, render: (x) => money(x.projectedTotal) },
        { key: 'serviceFeeRunRateAnnual', label: 'Service fee / yr', num: true, render: (x) => money(x.serviceFeeRunRateAnnual) },
        { key: 'contract', label: 'Contract', render: (x) => <>{x.contractNumber || '—'}{x.contractRenewalNeeded && <div><Badge kind="warn">Contract ends before renewal</Badge></div>}</> },
      ]} />
      <p className="corp-privacy">{res.data.assumption}</p>
    </Card>
  );
}

// Corporate admin: HR users and billing details for their own employer (/corporate/team).
import { useState } from 'react';
import { api } from '../../api.js';
import { Alert, Card, ErrorBox, Field, Loading, PageHeader, useAction, useLoad } from '../../components/ui.jsx';
import { useMeta } from './shared.jsx';
import { EmployerUsers } from './Employers.jsx';

export default function Team() {
  const res = useLoad(() => api.get('/corporate/employer'), []);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  const e = res.data;
  const locked = ['Suspended', 'Ended'].includes(e.status);
  return (
    <>
      <PageHeader title="Team & billing" subtitle={e.name} />
      {locked && <Alert kind="warn">This employer account is {e.status}; changes are disabled.</Alert>}
      <EmployerUsers employer={e} canInvite={!locked} />
      <BillingForm employer={e} disabled={locked} onSaved={res.reload} />
    </>
  );
}

function BillingForm({ employer, disabled, onSaved }) {
  const meta = useMeta();
  const [b, setB] = useState({ contactName: '', email: '', address: '', city: '', state: '', postalCode: '', poNumber: '', ...(employer.billing || {}) });
  const [h, setH] = useState({ name: '', email: '', phone: '', ...(employer.hrContact || {}) });
  const act = useAction();
  const fe = act.error?.fields || {};
  const sb = (k) => (ev) => setB({ ...b, [k]: ev.target.value });
  const sh = (k) => (ev) => setH({ ...h, [k]: ev.target.value });
  return (
    <Card title="Billing details & HR contact">
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />
      <fieldset disabled={disabled} style={{ border: 'none', padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field label="Billing contact"><input value={b.contactName} onChange={sb('contactName')} /></Field>
          <Field label="Billing email" error={fe['billing.email']}><input type="email" value={b.email} onChange={sb('email')} /></Field>
          <Field label="Address" className="full"><input value={b.address} onChange={sb('address')} /></Field>
          <Field label="City"><input value={b.city} onChange={sb('city')} /></Field>
          <Field label="State" error={fe['billing.state']}><select value={b.state} onChange={sb('state')}><option value="">—</option>{(meta.data?.states || []).map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="PIN code" error={fe['billing.postalCode']}><input inputMode="numeric" maxLength={6} value={b.postalCode} onChange={sb('postalCode')} /></Field>
          <Field label="PO number"><input value={b.poNumber} onChange={sb('poNumber')} /></Field>
          <Field label="HR contact name"><input value={h.name} onChange={sh('name')} /></Field>
          <Field label="HR contact email" error={fe['hrContact.email']}><input type="email" value={h.email} onChange={sh('email')} /></Field>
          <Field label="HR contact mobile" error={fe['hrContact.phone']}><input value={h.phone} onChange={sh('phone')} /></Field>
        </div>
        <p className="muted" style={{ fontSize: '.85rem' }}>GSTIN and legal details are maintained by your VHC account manager.</p>
        <div className="row end"><button className="btn" disabled={act.busy} onClick={() => act.run(async () => { await api.patch(`/corporate/employers/${employer.id}/billing`, { billing: b, hrContact: h }); onSaved(); }, 'Billing details saved')}>Save</button></div>
      </fieldset>
    </Card>
  );
}

import { useState } from 'react';
import { api, idempotencyKey } from '../api.js';
import { money } from '../format.js';
import { Alert, ErrorBox, Modal, useAction } from './ui.jsx';

/**
 * Simulated payment gateway. `target` = { purpose, applicationId? , policyId?, installmentNo? },
 * `amount` in paise (the server re-validates it). One idempotency key is kept per checkout so a
 * retry after a network failure never creates a duplicate payment.
 */
export default function PayButton({ target, amount, label = 'Pay now', onDone, className = 'btn' }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(idempotencyKey);
  const [payment, setPayment] = useState(null);
  const act = useAction();

  const pay = (outcome) => act.run(async () => {
    let p = payment;
    if (!p || p.status !== 'pending') {
      const r = await api.post('/payments/initiate', { ...target, amount, idempotencyKey: key });
      p = r.payment;
    }
    const out = await api.post(`/payments/${p.reference}/simulate`, { outcome });
    setPayment(out.payment);
    if (out.payment.status === 'failed') setKey(idempotencyKey()); // next attempt is a new payment
    if (out.payment.status === 'success') onDone?.(out.payment);
    return out.payment;
  });

  const close = () => {
    if (payment?.status === 'success') setKey(idempotencyKey()); // a new checkout must never replay the old payment
    setOpen(false);
    setPayment(null);
    act.setError(null);
  };

  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>{label} · {money(amount)}</button>
      <Modal open={open} title="Simulated payment gateway" onClose={close}>
        <p>Amount due: <strong>{money(amount)}</strong></p>
        <Alert kind="info">This is a test gateway. Choose the outcome to simulate. No real money moves.</Alert>
        {payment && (
          <Alert kind={payment.status === 'success' ? 'ok' : payment.status === 'pending' ? 'warn' : 'error'}>
            Payment <code>{payment.reference}</code>: <strong>{payment.status}</strong>
            {payment.status === 'pending' && ' — awaiting gateway confirmation. You can confirm it below or from Payments.'}
            {payment.status === 'failed' && ` — ${payment.failureReason || 'declined'}. You can try again.`}
          </Alert>
        )}
        <ErrorBox error={act.error} />
        {payment?.status === 'success' ? (
          <div className="row end"><button className="btn" onClick={close}>Done</button></div>
        ) : (
          <div className="row end">
            <button className="btn secondary" disabled={act.busy} onClick={() => pay('failed')}>Simulate failure</button>
            <button className="btn secondary" disabled={act.busy} onClick={() => pay('pending')}>Simulate pending</button>
            <button className="btn" disabled={act.busy} onClick={() => pay('success')}>{act.busy ? 'Processing…' : 'Pay successfully'}</button>
          </div>
        )}
      </Modal>
    </>
  );
}

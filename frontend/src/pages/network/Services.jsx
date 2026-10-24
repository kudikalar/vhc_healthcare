// Health services catalogue (/services, public) with booking, and the customer's appointments (/appointments).
// Every service and booking shows who pays (payer type) and that a booking is not automatically insured.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { date, dateTime, money } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { BOOKING_STATUS, PAYER_LABEL } from './common.jsx';

const todayIso = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const plusDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function SlotPicker({ serviceId, dateValue, onDate, slot, onSlot }) {
  const slots = useLoad(() => (dateValue ? api.get(`/network/services/${serviceId}/slots?date=${dateValue}`) : Promise.resolve({ slots: [] })), [serviceId, dateValue]);
  return (
    <>
      <Field label="Date"><input type="date" min={todayIso()} max={plusDays(todayIso(), 60)} value={dateValue} onChange={(e) => { onDate(e.target.value); onSlot(''); }} /></Field>
      <fieldset style={{ border: 0, padding: 0, margin: '.6rem 0' }}>
        <legend className="nw-meta" style={{ marginBottom: '.35rem' }}>Time (India time)</legend>
        {slots.loading ? <Loading text="Loading slots…" /> : slots.error ? <ErrorBox error={slots.error} /> : slots.data.slots.length === 0 ? <Empty>No slots on this day. Try another date.</Empty> : (
          <div className="nw-slots">
            {slots.data.slots.map((x) => (
              <button type="button" key={x.time} className="nw-slot" disabled={!x.available} aria-pressed={slot === x.time} onClick={() => onSlot(x.time)}
                aria-label={`${x.time}${x.available ? `, ${x.remaining} left` : ', unavailable'}`}>{x.time}</button>
            ))}
          </div>
        )}
      </fieldset>
    </>
  );
}

function BookingModal({ service, onClose }) {
  const nav = useNavigate();
  const [d, setD] = useState(plusDays(todayIso(), 1));
  const [slot, setSlot] = useState('');
  const [payerType, setPayerType] = useState('self_pay');
  const [policyId, setPolicyId] = useState('');
  const [patientName, setPatientName] = useState('');
  const [booking, setBooking] = useState(null);
  const act = useAction();
  const elig = useLoad(() => (payerType === 'insured_cashless' ? api.get(`/network/bookings/eligibility?serviceId=${service.id}&date=${d}`) : Promise.resolve(null)), [payerType, d]);
  const chosen = service.payerOptions.find((o) => o.type === payerType);
  const policyOk = payerType !== 'insured_cashless' || elig.data?.policies.find((p) => p.policyId === policyId)?.eligible;

  const create = () => act.run(async () => {
    const b = await api.post('/network/bookings', { serviceId: service.id, date: d, slot, payerType, policyId: policyId || undefined, patientName: patientName || undefined, idempotencyKey: `bk-${service.id}-${d}-${slot}-${payerType}` });
    setBooking(b);
  });
  const pay = () => act.run(async () => {
    await api.post(`/network/bookings/${booking.id}/pay`);
    nav('/appointments', { state: { booked: booking.reference } });
  });

  return (
    <Modal open title={`Book: ${service.name}`} onClose={onClose} large>
      <p className="nw-meta">{service.hospitalName}, {service.city} · {service.categoryLabel} · {service.durationMin} min{service.mode === 'video' ? ' · video' : service.mode === 'home' ? ' · at home' : ''}</p>
      {!booking ? (
        <>
          <SlotPicker serviceId={service.id} dateValue={d} onDate={setD} slot={slot} onSlot={setSlot} />
          <fieldset style={{ border: 0, padding: 0, margin: '.4rem 0 .8rem' }}>
            <legend style={{ fontWeight: 600, marginBottom: '.4rem' }}>Who pays for this service?</legend>
            <div className="nw-payers">
              {service.payerOptions.map((o) => (
                <label key={o.type} className="nw-payer">
                  <input type="radio" name="payer" value={o.type} checked={payerType === o.type} onChange={() => setPayerType(o.type)} />
                  <span><strong>{PAYER_LABEL[o.type]}</strong>{o.amount != null && <> — {o.amount ? money(o.amount) : 'no charge to you'}</>}<small>{o.disclosure}</small>{o.eligibility && <small>{o.eligibility}</small>}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {payerType === 'insured_cashless' && (
            elig.loading ? <Loading text="Checking your policies…" /> : elig.error ? <ErrorBox error={elig.error} /> : elig.data.policies.length === 0 ? <Alert kind="warn">You have no health policy on VHC. Choose self-pay instead.</Alert> : (
              <Field label="Policy">
                <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                  <option value="">— select —</option>
                  {elig.data.policies.map((p) => <option key={p.policyId} value={p.policyId} disabled={!p.eligible}>{p.policyNumber} · {p.planName} — {p.eligible ? 'cashless network' : 'not cashless here'}</option>)}
                </select>
                {policyId && <span className="hint">{elig.data.policies.find((p) => p.policyId === policyId)?.label || elig.data.policies.find((p) => p.policyId === policyId)?.text}</span>}
              </Field>
            )
          )}
          <Field label="Patient name" hint="Leave blank if the appointment is for you"><input value={patientName} onChange={(e) => setPatientName(e.target.value)} /></Field>
          <Alert kind="info">{service.coverageNote}</Alert>
          <p className="nw-note">A synthetic booking fee of {money(service.bookingFee)} is charged by VHC in sandbox (simulated — no real money). {chosen?.disclosure}</p>
          <ErrorBox error={act.error} />
          <div className="row end"><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!slot || !policyOk || act.busy} onClick={create}>Continue</button></div>
        </>
      ) : (
        <>
          <Alert kind="ok">Slot held: {date(booking.date)} at {booking.slot}. Reference {booking.reference}.</Alert>
          <dl className="kv">
            <dt>Payer type</dt><dd>{PAYER_LABEL[booking.payerType]}</dd>
            <dt>Disclosure</dt><dd>{booking.payerDisclosure}</dd>
            <dt>Payable at provider</dt><dd>{booking.amountPayableAtProvider == null ? 'Decided by your insurer\'s authorisation' : money(booking.amountPayableAtProvider)}</dd>
            <dt>Booking fee (sandbox)</dt><dd>{money(booking.bookingFee)}</dd>
          </dl>
          <Alert kind="info">{booking.coverageNote}</Alert>
          <ErrorBox error={act.error} />
          <div className="row end"><button className="btn" disabled={act.busy} onClick={pay}>Pay {money(booking.bookingFee)} (simulated) & confirm</button></div>
        </>
      )}
    </Modal>
  );
}

export function HealthServices() {
  const { user } = useAuth();
  const loc = useLocation();
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState({ q: params.get('q') || '', category: params.get('category') || '', city: params.get('city') || '' });
  const hospitalId = params.get('hospitalId') || '';
  const query = new URLSearchParams(Object.entries({ q: params.get('q'), category: params.get('category'), city: params.get('city'), hospitalId }).filter(([, v]) => v)).toString();
  const res = useLoad(() => api.get(`/network/services?${query}`), [query]);
  const [booking, setBooking] = useState(null);
  const serviceId = params.get('serviceId');
  useEffect(() => {
    if (serviceId && res.data && user?.role === 'customer') {
      const svc = res.data.services.find((x) => x.id === serviceId);
      if (svc) setBooking(svc);
    }
  }, [serviceId, res.data, user]);
  const submit = (e) => { e.preventDefault(); setParams(Object.fromEntries(Object.entries({ ...f, hospitalId }).filter(([, v]) => v))); };

  return (
    <>
      <PageHeader title="Health services" subtitle="Book consultations, health checks, diagnostics, imaging, teleconsultations, home sample collection and vaccinations at sandbox providers." />
      <Card>
        <form className="nw-filters" onSubmit={submit} aria-label="Service filters">
          <Field label="Search"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="e.g. health check" /></Field>
          <Field label="Type of service">
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">All</option>
              {res.data && Object.entries(res.data.categories).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
          <Field label="City"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <div className="row"><button className="btn">Search</button>{hospitalId && <button type="button" className="btn secondary" onClick={() => setParams({})}>All providers</button>}</div>
        </form>
      </Card>
      <Alert kind="info">{res.data?.coverageNote || 'A booking is not automatically covered by insurance.'}</Alert>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : res.data.services.length === 0 ? <Empty>No services match. Try another search.</Empty> : (
        <div className="nw-list">
          {res.data.services.map((x) => (
            <article key={x.id} className="card nw-provider">
              <div className="row between"><h3>{x.name}</h3><Badge>{x.categoryLabel}</Badge></div>
              <div className="nw-meta"><Link to={`/hospitals/${x.hospitalId}`}>{x.hospitalName}</Link> · {x.city}</div>
              <div><strong>{money(x.price)}</strong>{x.discountedPrice != null && <> · discounted {money(x.discountedPrice)}</>} <span className="nw-meta">(synthetic sandbox price)</span></div>
              <div className="nw-tags">{x.payerOptions.map((o) => <span key={o.type} className="badge" title={o.disclosure}>{PAYER_LABEL[o.type]}</span>)}</div>
              <div className="nw-actions">
                {user?.role === 'customer' ? <button className="btn sm" onClick={() => setBooking(x)}>Book</button>
                  : !user ? <Link className="btn sm" to="/login" state={{ from: `${loc.pathname}?serviceId=${x.id}` }}>Sign in to book</Link>
                    : <span className="nw-note">Booking is available to customer accounts.</span>}
              </div>
            </article>
          ))}
        </div>
      )}
      {booking && <BookingModal service={booking} onClose={() => { setBooking(null); if (serviceId) setParams(Object.fromEntries([...params].filter(([k]) => k !== 'serviceId'))); }} />}
    </>
  );
}

function RescheduleModal({ booking, onClose, onDone }) {
  const [d, setD] = useState(booking.date);
  const [slot, setSlot] = useState('');
  const act = useAction();
  const save = () => act.run(async () => { await api.post(`/network/bookings/${booking.id}/reschedule`, { date: d, slot }); onDone('Appointment rescheduled'); });
  return (
    <Modal open title={`Reschedule ${booking.reference}`} onClose={onClose}>
      <SlotPicker serviceId={booking.serviceId} dateValue={d} onDate={setD} slot={slot} onSlot={setSlot} />
      <ErrorBox error={act.error} />
      <div className="row end"><button className="btn secondary" onClick={onClose}>Back</button><button className="btn" disabled={!slot || act.busy} onClick={save}>Reschedule</button></div>
    </Modal>
  );
}

export function Appointments() {
  const loc = useLocation();
  const res = useLoad(() => api.get('/network/bookings/mine'));
  const [resched, setResched] = useState(null);
  const [detail, setDetail] = useState(null);
  const act = useAction();
  const done = (msg) => { setResched(null); act.setMessage(msg); res.reload(); };
  const cancel = (b) => {
    const reason = window.prompt('Reason for cancelling (optional). Booking fees are refunded when you cancel at least 4 hours ahead.');
    if (reason === null) return;
    act.run(() => api.post(`/network/bookings/${b.id}/cancel`, { reason }), 'Appointment cancelled').then(() => res.reload());
  };
  const pay = (b) => act.run(() => api.post(`/network/bookings/${b.id}/pay`), 'Booking confirmed').then(() => res.reload());
  return (
    <>
      <PageHeader title="My appointments" subtitle="Bookings for consultations, health checks and tests." actions={<Link className="btn" to="/services">Book a service</Link>} />
      {loc.state?.booked && !act.message && <Alert kind="ok">Booking {loc.state.booked} confirmed.</Alert>}
      <Alert kind="ok">{act.message}</Alert>
      <ErrorBox error={act.error} />
      {res.data && <Alert kind="info">{res.data.coverageNote}</Alert>}
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} /> : res.data.bookings.length === 0 ? <Empty>No appointments yet. <Link to="/services">Browse health services</Link>.</Empty> : (
        <div className="nw-list">
          {res.data.bookings.map((b) => (
            <article key={b.id} className="card nw-provider">
              <div className="row between"><h3>{b.serviceName}</h3><Badge>{BOOKING_STATUS[b.status]}</Badge></div>
              <div className="nw-meta">{b.hospitalName} · {date(b.date)} at {b.slot} · {b.reference}</div>
              <div><Badge kind={b.payerType === 'insured_cashless' ? 'info' : ''}>{PAYER_LABEL[b.payerType]}</Badge> <span className="nw-note">{b.payerDisclosure}</span></div>
              {b.network?.label && <div className="nw-cashless ok">{b.network.label}</div>}
              <div className="nw-meta">Payable at provider: {b.amountPayableAtProvider == null ? 'per insurer authorisation' : money(b.amountPayableAtProvider)} · Booking fee {money(b.bookingFee)} ({b.payment?.status === 'paid' ? 'paid, sandbox' : b.payment?.status || 'pending'})</div>
              <div className="nw-actions">
                {b.status === 'pending_payment' && <button className="btn sm" disabled={act.busy} onClick={() => pay(b)}>Pay fee & confirm</button>}
                {b.canReschedule && <button className="btn sm secondary" onClick={() => setResched(b)}>Reschedule</button>}
                {b.canCancel && <button className="btn sm secondary" disabled={act.busy} onClick={() => cancel(b)}>Cancel</button>}
                <button className="btn sm ghost" onClick={() => setDetail(b)}>History</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {resched && <RescheduleModal booking={resched} onClose={() => setResched(null)} onDone={done} />}
      <Modal open={!!detail} title={detail ? `${detail.reference} history` : ''} onClose={() => setDetail(null)}>
        {detail && <><p className="nw-meta">Created {dateTime(detail.createdAt)}</p><Timeline items={detail.history.map((h) => ({ ...h, status: BOOKING_STATUS[h.status] || h.status }))} /></>}
      </Modal>
    </>
  );
}

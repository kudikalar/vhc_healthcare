import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { date, dateTime, money, titleCase, toPaise, toRupeesInput } from '../../format.js';
import { Alert, Badge, Card, ErrorBox, Field, KV, Loading, PageHeader, Timeline, useAction, useLoad } from '../../components/ui.jsx';
import { MemberEditor, NomineeEditor, blankMember, blankNominee } from '../../components/Editors.jsx';
import QuoteBreakdown from '../../components/QuoteBreakdown.jsx';
import DocumentPanel from '../../components/DocumentPanel.jsx';
import PayButton from '../../components/PayButton.jsx';

const ynSelect = (value, onChange) => (
  <select value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
    <option value="">— select —</option><option value="no">No</option><option value="yes">Yes</option>
  </select>
);

function draftFrom(app) {
  if (app.product === 'health') return { startDate: app.startDate, coverage: app.health.coverage, optionalBenefits: app.health.optionalBenefits, members: app.health.members.length ? app.health.members : [blankMember()] };
  const l = app.life;
  return {
    startDate: app.startDate,
    life: {
      ...l, sumAssured: toRupeesInput(l.sumAssured),
      lifeAssured: { ...l.lifeAssured, annualIncome: toRupeesInput(l.lifeAssured.annualIncome) },
      existingInsurance: { ...l.existingInsurance, totalSumAssured: toRupeesInput(l.existingInsurance.totalSumAssured) },
    },
    nominees: l.nominees.length ? l.nominees.map((n) => ({ ...n, guardian: n.guardian || { name: '', relationship: '', phone: '' } })) : [blankNominee()],
  };
}

function payload(app, d) {
  if (app.product === 'health') return { startDate: d.startDate, coverage: d.coverage, optionalBenefits: d.optionalBenefits, members: d.members };
  const l = d.life;
  return {
    startDate: d.startDate,
    life: {
      sumAssured: toPaise(l.sumAssured), policyTerm: Number(l.policyTerm) || null, premiumPaymentTerm: Number(l.premiumPaymentTerm) || null,
      frequency: l.frequency, riders: l.riders, tobacco: l.tobacco,
      lifeAssured: { ...l.lifeAssured, annualIncome: toPaise(l.lifeAssured.annualIncome) },
      medicalHistory: l.medicalHistory,
      existingInsurance: { ...l.existingInsurance, totalSumAssured: toPaise(l.existingInsurance.totalSumAssured || '0') },
    },
    nominees: d.nominees.map((n) => ({ ...n, sharePct: Number(n.sharePct) })),
  };
}

export default function ApplicationDetail() {
  const { id } = useParams();
  const res = useLoad(() => api.get(`/applications/${id}`), [id]);
  const app = res.data;
  const plan = useLoad(() => (app ? api.get(`/plans/${app.planId}`) : null), [app?.planId]);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const act = useAction();
  useEffect(() => { if (app) { setDraft(draftFrom(app)); setDirty(false); } }, [app]);

  if (res.loading && !app) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} />;
  if (!draft || !plan.data) return <Loading />;
  const cfg = plan.data.config;
  const update = (patch) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const updLife = (patch) => update({ life: { ...draft.life, ...patch } });
  const save = async () => { const a = await api.put(`/applications/${id}`, payload(app, draft)); res.setData(a); return a; };
  const memberErrors = act.error?.details?.memberErrors || {};

  const run = (fn, msg) => act.run(async () => { const a = await fn(); if (a) res.setData(a); return a; }, msg);

  return (
    <>
      <PageHeader
        title={`${app.planName}`}
        subtitle={<>Application {app.applicationNumber} · {app.renewalOf ? 'Renewal · ' : ''}created {date(app.createdAt)}</>}
        actions={<Badge>{app.status}</Badge>}
      />
      {act.message && <Alert kind="ok">{act.message}</Alert>}
      <ErrorBox error={act.error} />

      {app.status === 'More Information Required' && (
        <Alert kind="warn">
          Action needed: {app.underwriting.requirements.filter((r) => r.type === 'information' && r.status === 'requested').map((r) => r.description).join('; ') || 'please review and update your application'}.
          Update the details or upload documents, then resubmit.
        </Alert>
      )}

      {app.editable ? (
        <>
          <Card title="Cover details">
            <div className="form-grid">
              <Field label="Coverage start date"><input type="date" value={draft.startDate} onChange={(e) => update({ startDate: e.target.value })} /></Field>
              {app.product === 'health' ? (
                <>
                  <Field label="Coverage amount">
                    <select value={draft.coverage || ''} onChange={(e) => update({ coverage: Number(e.target.value) })}>
                      <option value="">— select —</option>
                      {cfg.coverageOptions.map((c) => <option key={c.amount} value={c.amount}>{money(c.amount)}</option>)}
                    </select>
                  </Field>
                  <div className="full">
                    {cfg.optionalBenefits.map((o) => (
                      <label key={o.code} className="check"><input type="checkbox" checked={draft.optionalBenefits.includes(o.code)} onChange={() => update({ optionalBenefits: draft.optionalBenefits.includes(o.code) ? draft.optionalBenefits.filter((x) => x !== o.code) : [...draft.optionalBenefits, o.code] })} /> {o.name} (+{money(o.charge)})</label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <Field label="Sum assured (₹)"><input inputMode="decimal" value={draft.life.sumAssured} onChange={(e) => updLife({ sumAssured: e.target.value })} /></Field>
                  <Field label="Policy term (years)">
                    <select value={draft.life.policyTerm || ''} onChange={(e) => updLife({ policyTerm: Number(e.target.value), premiumPaymentTerm: Number(e.target.value) })}><option value="">—</option>{cfg.policyTerms.map((t) => <option key={t}>{t}</option>)}</select>
                  </Field>
                  <Field label="Premium payment term">
                    <select value={draft.life.premiumPaymentTerm || ''} onChange={(e) => updLife({ premiumPaymentTerm: Number(e.target.value) })}>
                      <option value="">—</option>
                      {draft.life.policyTerm && <option value={draft.life.policyTerm}>Regular ({draft.life.policyTerm} yrs)</option>}
                      {cfg.premiumPaymentTerms.map((t) => <option key={t} value={t}>Limited {t} yrs</option>)}
                    </select>
                  </Field>
                  <Field label="Payment frequency"><select value={draft.life.frequency} onChange={(e) => updLife({ frequency: e.target.value })}>{Object.keys(cfg.frequencies).map((f) => <option key={f}>{f}</option>)}</select></Field>
                  <div className="full">{cfg.riders.map((r) => <label key={r.code} className="check"><input type="checkbox" checked={draft.life.riders.includes(r.code)} onChange={() => updLife({ riders: draft.life.riders.includes(r.code) ? draft.life.riders.filter((x) => x !== r.code) : [...draft.life.riders, r.code] })} /> {r.name} (+{money(r.annualCharge)}/yr)</label>)}</div>
                </>
              )}
            </div>
          </Card>

          {app.product === 'health' ? (
            <Card title="Insured members & health declarations">
              <MemberEditor members={draft.members} onChange={(members) => update({ members })} relationships={cfg.eligibleRelationships} maxMembers={cfg.maxMembers} memberErrors={memberErrors} startDate={draft.startDate} />
            </Card>
          ) : (
            <>
              <Card title="Life assured (self) & declarations">
                <p className="muted" style={{ marginTop: 0 }}>The policyholder and life assured are recorded separately; this version supports self-purchase.</p>
                <div className="form-grid">
                  <Field label="Full name"><input value={draft.life.lifeAssured.fullName || ''} onChange={(e) => updLife({ lifeAssured: { ...draft.life.lifeAssured, fullName: e.target.value } })} /></Field>
                  <Field label="Date of birth"><input type="date" value={draft.life.lifeAssured.dob || ''} onChange={(e) => updLife({ lifeAssured: { ...draft.life.lifeAssured, dob: e.target.value } })} /></Field>
                  <Field label="Gender"><select value={draft.life.lifeAssured.gender || ''} onChange={(e) => updLife({ lifeAssured: { ...draft.life.lifeAssured, gender: e.target.value } })}><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></Field>
                  <Field label="Occupation"><input value={draft.life.lifeAssured.occupation || ''} onChange={(e) => updLife({ lifeAssured: { ...draft.life.lifeAssured, occupation: e.target.value } })} /></Field>
                  <Field label="Annual income (₹)"><input inputMode="decimal" value={draft.life.lifeAssured.annualIncome || ''} onChange={(e) => updLife({ lifeAssured: { ...draft.life.lifeAssured, annualIncome: e.target.value } })} /></Field>
                  <Field label="Tobacco / smoking?">{ynSelect(draft.life.tobacco, (v) => updLife({ tobacco: v }))}</Field>
                  <Field label="Any medical history to declare?">{ynSelect(draft.life.medicalHistory.hasConditions, (v) => updLife({ medicalHistory: { ...draft.life.medicalHistory, hasConditions: v } }))}</Field>
                  {draft.life.medicalHistory.hasConditions && <Field label="Medical history details" className="full"><textarea value={draft.life.medicalHistory.details} onChange={(e) => updLife({ medicalHistory: { ...draft.life.medicalHistory, details: e.target.value } })} /></Field>}
                  <Field label="Existing life insurance?">{ynSelect(draft.life.existingInsurance.has, (v) => updLife({ existingInsurance: { ...draft.life.existingInsurance, has: v } }))}</Field>
                  {draft.life.existingInsurance.has && (
                    <>
                      <Field label="Existing cover details"><input value={draft.life.existingInsurance.details} onChange={(e) => updLife({ existingInsurance: { ...draft.life.existingInsurance, details: e.target.value } })} /></Field>
                      <Field label="Total existing sum assured (₹)"><input value={draft.life.existingInsurance.totalSumAssured} onChange={(e) => updLife({ existingInsurance: { ...draft.life.existingInsurance, totalSumAssured: e.target.value } })} /></Field>
                    </>
                  )}
                </div>
              </Card>
              <Card title="Nominees">
                <Alert kind="info">A nominee designation does not by itself authorise a payout; all claims are verified.</Alert>
                <NomineeEditor nominees={draft.nominees} onChange={(nominees) => update({ nominees })} />
              </Card>
            </>
          )}

          <Card title="Quote">
            {app.quoteInvalidatedReason && !app.quote && <Alert kind="warn">{app.quoteInvalidatedReason}</Alert>}
            {app.quote && !app.quoteValid && <Alert kind="warn">This quote is no longer valid (expired or details changed). Recalculate before submitting.</Alert>}
            {app.quote ? <QuoteBreakdown q={app.quote} /> : <div className="empty">No quote yet — save your details and calculate.</div>}
            <div className="row" style={{ marginTop: '.75rem' }}>
              <button className="btn secondary" disabled={act.busy || !dirty} onClick={() => run(save, 'Saved')}>Save draft</button>
              <button className="btn" disabled={act.busy} onClick={() => run(async () => { await save(); return api.post(`/applications/${id}/quote`); }, 'Quote calculated')}>Save & calculate quote</button>
            </div>
          </Card>

          <Card title="Declaration & submission">
            <label className="check">
              <input type="checkbox" checked={!!app.consent?.given} disabled={dirty} onChange={(e) => run(() => api.put(`/applications/${id}`, { consent: e.target.checked }))} />
              I confirm that all declarations, including health information for every insured person, are true and complete, and I consent to their use for underwriting and claims.
            </label>
            {dirty && <small className="muted">Save your changes before giving consent.</small>}
            <div className="row" style={{ marginTop: '.75rem' }}>
              <button className="btn" disabled={act.busy || dirty} onClick={() => run(() => api.post(`/applications/${id}/submit`), 'Application submitted')}>
                {app.status === 'More Information Required' ? 'Resubmit application' : 'Submit application'}
              </button>
            </div>
          </Card>
        </>
      ) : (
        <ReadOnlySummary app={app} />
      )}

      <OfferPanel app={app} run={run} busy={act.busy} reload={res.reload} />

      {app.underwriting.requirements.length > 0 && (
        <Card title="Underwriting requirements">
          <ul className="checklist">
            {app.underwriting.requirements.map((r) => (
              <li key={r.id}><Badge>{r.status}</Badge> {titleCase(r.type)} — {r.description}{r.scheduledAt && ` · scheduled ${date(r.scheduledAt)}${r.center ? ` at ${r.center}` : ''}`}</li>
            ))}
          </ul>
          <small className="muted">Upload requested reports in the Documents section below.</small>
        </Card>
      )}

      <DocumentPanel entityType="application" entityId={app.id} canUpload={!['Issued', 'Rejected', 'Offer Declined'].includes(app.status)} categories={['identity', 'income', 'medical_report', 'exam_report', 'other']} />
      <Card title="Activity timeline"><Timeline items={app.timeline} /></Card>
    </>
  );
}

function ReadOnlySummary({ app }) {
  if (app.product === 'health') {
    return (
      <Card title="Application summary">
        <KV items={[['Start date', date(app.startDate)], ['Coverage', money(app.health.coverage)], ['Optional benefits', app.health.optionalBenefits.join(', ') || 'None'], ['Submitted', dateTime(app.submittedAt)]]} />
        <hr />
        <div className="table-wrap"><table>
          <thead><tr><th>Member</th><th>DOB</th><th>Relationship</th><th>Declarations</th></tr></thead>
          <tbody>{app.health.members.map((m) => <tr key={m.id}><td>{m.fullName}</td><td>{date(m.dob)}</td><td>{m.relationship}</td><td>{m.hasConditions ? `Conditions: ${m.conditions}` : 'No conditions'}; tobacco: {m.tobacco ? 'yes' : 'no'}</td></tr>)}</tbody>
        </table></div>
      </Card>
    );
  }
  const l = app.life;
  return (
    <Card title="Application summary">
      <KV items={[['Life assured', `${l.lifeAssured.fullName} (DOB ${date(l.lifeAssured.dob)})`], ['Sum assured', money(l.sumAssured)], ['Policy / payment term', `${l.policyTerm} / ${l.premiumPaymentTerm} years`], ['Frequency', l.frequency], ['Riders', l.riders.join(', ') || 'None'], ['Nominees', l.nominees.map((n) => `${n.name} ${n.sharePct}%`).join(', ')]]} />
    </Card>
  );
}

function OfferPanel({ app, run, busy, reload }) {
  const o = app.offer;
  if (!o) return null;
  const isHealth = app.product === 'health';
  const cov = isHealth ? o.coverage : o.sumAssured;
  const origCov = isHealth ? o.original?.coverage : o.original?.sumAssured;
  const diff = (oldV, newV) => (oldV != null && oldV !== newV ? <><span className="diff-old">{money(oldV)}</span><span className="diff-new">{money(newV)}</span></> : money(newV));
  return (
    <Card title={o.revised ? 'Revised offer from underwriting' : o.renewal ? 'Renewal offer' : 'Your offer'} actions={<Badge>{app.status}</Badge>}>
      {o.revised && <Alert kind="warn">Underwriting has proposed revised terms: <strong>{o.reason}</strong>{o.specialConditions && <> · Conditions: {o.specialConditions}</>}. You must accept them before paying.</Alert>}
      {o.renewal && o.previous && (
        <Alert kind="info">Changes from your current policy {o.previous.policyNumber}: premium {diff(o.previous.annualPremium, o.annualPremium)} · coverage {diff(o.previous.coverage, o.coverage)} · terms version {o.previous.planVersion} → {o.planVersion}</Alert>
      )}
      <KV items={[
        [isHealth ? 'Sum insured' : 'Sum assured', diff(origCov, cov)],
        ['Annual premium', diff(isHealth ? o.original?.annualPremium : o.original?.annualPremium, o.annualPremium)],
        !isHealth && ['Installment premium', `${diff(o.original?.installmentPremium, o.installmentPremium)} (${o.frequency})`],
        !isHealth && ['Underwriting class', o.uwClass],
        ['First payment due', money(o.firstPayment)],
        ['Offer valid until', date(o.expiresAt)],
        o.acceptedAt && ['Accepted', dateTime(o.acceptedAt)],
      ]} />
      <div className="row" style={{ marginTop: '1rem' }}>
        {app.status === 'Approved' && (
          <>
            <button className="btn" disabled={busy} onClick={() => run(() => api.post(`/applications/${app.id}/accept-offer`), 'Offer accepted — you can now pay')}>Accept {o.revised ? 'revised terms' : 'offer'}</button>
            <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post(`/applications/${app.id}/decline-offer`))}>Decline</button>
          </>
        )}
        {app.status === 'Offer Accepted' && (
          <PayButton target={{ purpose: 'application', applicationId: app.id }} amount={o.firstPayment} label="Pay first premium" onDone={() => reload()} />
        )}
        {['Approved', 'Offer Accepted'].includes(app.status) && (
          <button className="btn ghost" disabled={busy} onClick={() => window.confirm('Reopening returns the application to underwriting and withdraws this offer. Continue?') && run(() => api.post(`/applications/${app.id}/reopen`))}>Change declarations (reopen review)</button>
        )}
        {app.status === 'Issued' && <Link className="btn" to={`/policies/${app.policyId}`}>View policy</Link>}
      </div>
    </Card>
  );
}

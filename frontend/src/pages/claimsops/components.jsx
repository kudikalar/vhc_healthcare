// Shared building blocks for claims operations: unified status stepper, responsibility card, SLA chip
// and timer, settlement breakdown, insurer communications, document checklist and the fraud banner.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dateTime, money, titleCase } from '../../format.js';
import { Alert, Badge, Card, Empty } from '../../components/ui.jsx';
import './claimsops.css';

/** "2 h 05 m", "3 d 4 h", "12 m" from milliseconds (absolute value). */
export function duration(ms) {
  if (ms == null) return '—';
  const a = Math.abs(ms);
  const m = Math.floor(a / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${String(mm).padStart(2, '0')} m`;
  return `${mm} m`;
}

const UNIFIED_KIND = {
  Pending: 'warn', 'Awaiting Documents': 'warn', 'Under Review': 'info', Authorized: 'ok', 'Partially Authorized': 'warn',
  Rejected: 'error', Discharged: 'info', 'Settlement Pending': 'info', Settled: 'ok', Closed: '',
};
/** Badge for the customer-facing unified claim status (falls back to keyword colouring). */
export const UnifiedBadge = ({ status }) => <Badge kind={UNIFIED_KIND[status]}>{status}</Badge>;

const SLA_TEXT = { running: 'On track', at_risk: 'At risk', paused: 'Paused', breached: 'Breached', met: 'Met', breached_closed: 'Closed late', not_started: 'Not started' };
export const slaStateLabel = (s) => SLA_TEXT[s] || titleCase(s);

/** Ticks every 30s so running clocks count down without reloading. */
function useNow(active) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setT(Date.now()), 30000);
    return () => clearInterval(id);
  }, [active]);
  return t;
}

/** Remaining time adjusted for time passed since the server computed it. */
function liveRemaining(clock, loadedAt, nowMs) {
  if (!clock?.running || clock.paused) return clock?.remainingMs;
  return clock.remainingMs - (nowMs - loadedAt);
}

export function SlaChip({ sla, compact = false }) {
  if (!sla) return <span className="muted">—</span>;
  const rem = sla.remainingMs;
  const text = sla.state === 'breached' ? `Overdue ${duration(rem)}` : ['met', 'breached_closed'].includes(sla.state) ? slaStateLabel(sla.state) : sla.state === 'paused' ? 'Paused' : `${duration(rem)} left`;
  return (
    <span className={`co-sla ${sla.state}`} title={`${sla.label || 'SLA'} · due ${dateTime(sla.dueAt)}`}>
      {!compact && sla.label ? `${sla.label.split(' (')[0]}: ` : ''}{text}
    </span>
  );
}

/** Large countdown for a single clock (e.g. cashless pre-authorisation). */
export function SlaTimer({ clock, loadedAt, title }) {
  const nowMs = useNow(clock?.running);
  if (!clock) return null;
  const rem = liveRemaining(clock, loadedAt || nowMs, nowMs);
  const state = clock.running && !clock.paused && rem < 0 ? 'breached' : clock.state;
  const pct = clock.durationMs ? Math.min(100, Math.max(0, ((clock.durationMs - rem) / clock.durationMs) * 100)) : 0;
  return (
    <div>
      {title && <div className="muted" style={{ fontSize: '.85rem' }}>{title}</div>}
      <div className={`co-timer ${state}`}>
        <span className="big" aria-live="polite">{clock.running ? (rem >= 0 ? duration(rem) : `−${duration(rem)}`) : duration(clock.elapsedMs)}</span>
        <span className="muted">{clock.running ? (rem >= 0 ? 'remaining' : 'overdue') : 'taken'} · target {duration(clock.durationMs)} · due {dateTime(clock.dueAt)}</span>
        <span className={`co-sla ${state}`}>{slaStateLabel(state)}</span>
      </div>
      <div className={`co-bar ${state}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${clock.label} time used`}><span style={{ width: `${pct}%` }} /></div>
      {clock.paused && <small className="muted">Paused while documents are awaited from you or the hospital.</small>}
    </div>
  );
}

export function StatusStepper({ steps }) {
  if (!steps?.length) return null;
  return (
    <ol className="co-stepper" aria-label="Claim progress">
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className={s.state} aria-current={['current', 'waiting'].includes(s.state) ? 'step' : undefined}>
          <span className="dot" aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'stopped' ? '✕' : i + 1}</span>
          {s.label}{s.state === 'waiting' ? ' — awaiting documents' : ''}
        </li>
      ))}
    </ol>
  );
}

export function ResponsibilityCard({ ops }) {
  if (!ops) return null;
  const u = ops.unified;
  return (
    <>
      <StatusStepper steps={u.steps} />
      <div className="co-next">
        <div><div className="who">Status</div><UnifiedBadge status={u.status} /></div>
        <div><div className="who">With</div><div className="org">{u.responsible}{u.responsible === 'TPA' && ops.tpa ? ` · ${ops.tpa.name}` : u.responsible === 'Insurer' && ops.insurer?.name ? ` · ${ops.insurer.name}` : ''}</div></div>
        <div className="action"><div className="who">Next action</div>{u.nextAction}</div>
      </div>
      <p className="co-disclaimer">{ops.disclaimer}</p>
    </>
  );
}

export function SettlementBreakdown({ s }) {
  if (!s) return null;
  if (!s.assessed) {
    return (
      <div className="table-wrap"><table className="breakdown co-settle"><tbody>
        <tr><td>Bill / estimate</td><td className="num">{money(s.billedAmount)}</td></tr>
        {s.authorizedAmount != null && <tr><td>Authorised so far (provisional)</td><td className="num">{money(s.authorizedAmount)}</td></tr>}
        <tr><td colSpan={2} className="muted">The approved amount and what you pay are confirmed after the insurer assesses the final bill.</td></tr>
      </tbody></table></div>
    );
  }
  return (
    <>
      <div className="table-wrap"><table className="breakdown co-settle"><tbody>
        <tr><td>Hospital bill</td><td className="num">{money(s.billedAmount)}</td></tr>
        {s.deductions.map((d) => [
          <tr key={d.key}><td>− {d.label}</td><td className="num">{money(d.amount)}</td></tr>,
          ...(d.items || []).map((i, k) => <tr key={`${d.key}-${k}`} className="sub"><td>{i.description}{i.note ? ` — ${i.note}` : ''}</td><td className="num">{money(i.amount)}</td></tr>),
        ])}
        <tr className="total"><td>{s.provisional ? 'Assessed amount (not yet approved)' : 'Approved by insurer'}</td><td className="num">{money(s.approvedAmount)}</td></tr>
        <tr className="payable"><td>{s.customerPayableLabel || 'Payable by you'}</td><td className="num">{money(s.customerPayable)}</td></tr>
        {s.paidAmount > 0 && <tr><td>Paid {s.payee ? `to ${s.payee}` : ''}{s.settledAt ? ` on ${dateTime(s.settledAt)}` : ''}</td><td className="num">{money(s.paidAmount)}</td></tr>}
      </tbody></table></div>
      {s.payouts?.length > 0 && <small className="muted">Payments: {s.payouts.map((p) => `${p.reference} (${p.status})`).join(', ')}</small>}
    </>
  );
}

export function InsurerComms({ items, empty = 'No insurer communication recorded yet.' }) {
  if (!items?.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="co-comms">
      {[...items].reverse().map((m, i) => (
        <li key={i} className={m.direction}>
          <div className="meta">{dateTime(m.at)} · {m.direction === 'inbound' ? 'From insurer/TPA' : 'To insurer/TPA'} · {m.channel}{m.insurerRef ? ` · ref ${m.insurerRef}` : ''}{m.visibleToCustomer === false ? ' · internal' : ''}</div>
          <strong>{m.subject}</strong>
          {m.message && <div>{m.message}</div>}
        </li>
      ))}
    </ul>
  );
}

const MARK = { received: '✓', missing: '!', requested: '!', optional: '–', not_yet_needed: '…' };
const LABEL = { received: 'Received', missing: 'Missing', requested: 'Requested', optional: 'Optional', not_yet_needed: 'Later' };
/** Checklist + suggestions. `onPick(categories)` lets the user jump to an upload with the right type. */
export function DocumentChecklist({ intel, onPick, audience = 'customer' }) {
  if (!intel) return null;
  const items = [...(intel.outstandingRequests || []).map((r) => ({ ...r, hint: `Requested by ${r.requestedBy} on ${dateTime(r.requestedAt)}` })), ...intel.checklist];
  return (
    <>
      <ul className="co-checklist">
        {items.map((i) => (
          <li key={i.key} className={i.status}>
            <span className="mark" aria-hidden="true">{MARK[i.status]}</span>
            <span>{i.label}{i.status !== 'received' && i.hint && <span className="hint">{i.hint}</span>}</span>
            <span className="row">
              <Badge kind={i.status === 'received' ? 'ok' : ['missing', 'requested'].includes(i.status) ? 'warn' : ''}>{LABEL[i.status]}</Badge>
              {onPick && ['missing', 'requested', 'optional'].includes(i.status) && <button type="button" className="btn sm secondary" onClick={() => onPick(i.categories)}>Upload</button>}
            </span>
          </li>
        ))}
      </ul>
      {intel.duplicates?.length > 0 && <Alert kind="info">Duplicate upload: {intel.duplicates.map((d) => `${d.filename} (×${d.count})`).join(', ')}. {intel.duplicates[0].note}</Alert>}
      {intel.quality?.length > 0 && <Alert kind="warn">File checks:<ul>{intel.quality.map((q) => <li key={q.documentId}>{q.filename}: {q.issues.join(' ')}</li>)}</ul></Alert>}
      {audience === 'staff' && intel.crossClaimMatches?.length > 0 && <Alert kind="warn">Identical file found on other claim(s): {intel.crossClaimMatches.map((m) => `${m.filename} → ${m.otherClaimNumber}`).join('; ')}</Alert>}
      <p className="co-disclaimer">{intel.disclaimer} Checklist: {intel.checklistSource}.</p>
    </>
  );
}

export function FraudBanner({ fraud, claimId }) {
  const open = fraud?.flags?.filter((f) => ['Open', 'In Review'].includes(f.status)) || [];
  if (!open.length) return null;
  return (
    <div className="co-flag-banner" role="status">
      <strong>{open.length} anomaly flag{open.length > 1 ? 's' : ''} for review.</strong> {fraud.disclaimer} You can still approve or reject this claim on its merits.
      <ul>{open.map((f) => <li key={f.id}><strong>{f.ruleId}</strong> {f.ruleName} ({f.severity}): {f.explanation}</li>)}</ul>
      <Link to={`/ops/fraud-review?claimId=${claimId}`}>Open in fraud review</Link>
    </div>
  );
}

export function Evidence({ evidence }) {
  const entries = Object.entries(evidence || {});
  if (!entries.length) return null;
  return (
    <dl className="co-evidence">
      {entries.map(([k, v]) => [<dt key={`${k}-k`}>{titleCase(k.replace(/([A-Z])/g, ' $1'))}</dt>, <dd key={`${k}-v`}>{Array.isArray(v) ? v.join(', ') : /amount|sumInsured/i.test(k) && typeof v === 'number' ? money(v) : String(v)}</dd>])}
    </dl>
  );
}

export function TimelineSummary({ summary }) {
  if (!summary) return null;
  return (
    <Card title="Claim summary">
      <p className="co-summary">{summary.text}</p>
      <p className="co-disclaimer">{summary.disclaimer}</p>
    </Card>
  );
}

/** IRDAI / insurer grievance guidance — VHC is neither insurer nor regulator. */
export function GrievanceGuidance({ guidance, compact = false }) {
  if (!guidance) return null;
  return (
    <section className="co-guidance" aria-labelledby="grv-guidance">
      <h3 id="grv-guidance">About VHC grievances</h3>
      <p style={{ margin: 0 }}>{guidance.nature}</p>
      {!compact && <p style={{ margin: '.5rem 0 0' }}>{guidance.insurer}</p>}
      <ol>
        {guidance.escalation.map((e) => <li key={e.name}><a href={e.url} target="_blank" rel="noopener noreferrer">{e.name}</a> — {e.text}</li>)}
      </ol>
    </section>
  );
}

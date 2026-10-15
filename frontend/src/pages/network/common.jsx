// Shared bits for the network module pages.
import { date, titleCase } from '../../format.js';
import { Badge } from '../../components/ui.jsx';
import './network.css';

export const PROVIDER_TYPE_LABEL = {
  hospital: 'Hospital', clinic: 'Clinic', diagnostic_centre: 'Diagnostic centre', imaging_centre: 'Imaging centre', telehealth: 'Telehealth',
};
export const PAYER_LABEL = {
  self_pay: 'Self-pay', discounted: 'Discounted self-pay', employer_sponsored: 'Employer-sponsored', insured_cashless: 'Insured — cashless request',
};
export const BOOKING_STATUS = {
  pending_payment: 'Pending payment', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
export const NETWORK_STATUS_KIND = { active: 'ok', restricted: 'warn', excluded: 'error', not_in_network: '' };
export const STAGES = ['Prospect', 'Credential Verification', 'Contracting', 'Active'];

/** Customer-facing cashless line for one insurer/plan. */
export function CashlessLine({ c }) {
  if (!c) return null;
  const cls = c.eligible ? 'ok' : c.status;
  return (
    <div className={`nw-cashless ${cls}`} role="note">
      <strong>{c.eligible ? c.label : `${c.insurerName}${c.planName ? ` · ${c.planName}` : ''}: ${titleCase(c.status)}`}</strong>
      {!c.eligible && <span>{c.text}</span>}
      {c.eligible && c.services?.length > 0 && <span>Service lines: {c.services.map(titleCase).join(', ')}</span>}
      {c.note && <span> {c.note}</span>}
      {c.planSpecific?.length > 0 && <span> Plan-specific: {c.planSpecific.map((x) => `${x.planNames.join(', ')} — ${x.status === 'active' ? 'cashless' : x.status}`).join('; ')}. Choose your plan to check.</span>}
    </div>
  );
}

export function ContractBadge({ status }) {
  const kind = { active: 'ok', approved: 'info', pending_approval: 'warn', draft: '', expired: 'error', terminated: 'error', rejected: 'error' }[status] ?? '';
  return <Badge kind={kind}>{titleCase(status)}</Badge>;
}

export function StagePipeline({ stage }) {
  const idx = STAGES.indexOf(stage);
  return (
    <div className="nw-pipeline" aria-label={`Onboarding stage: ${stage}`}>
      {STAGES.map((s, i) => <span key={s} className={s === stage ? 'on' : idx > i ? 'done' : ''}>{s}</span>)}
      {['Suspended', 'Terminated'].includes(stage) && <span className="on" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>{stage}</span>}
    </div>
  );
}

export const Verified = ({ ok, at }) => (ok ? <Badge kind="ok">Verified{at ? ` ${date(at)}` : ''}</Badge> : <Badge kind="warn">Not verified</Badge>);

export const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

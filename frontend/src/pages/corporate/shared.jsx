// Shared building blocks for the corporate module pages.
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { money } from '../../format.js';
import { Badge, useLoad } from '../../components/ui.jsx';
import './corporate.css';

export const CORP = ['corporate_admin', 'corporate_hr'];
export const MANAGE = ['admin', 'operations_admin'];
export const FINANCE = ['admin', 'operations_admin', 'finance_manager'];
export const VIEW_ALL = ['admin', 'operations_admin', 'sales_manager', 'finance_manager', 'compliance_officer', 'auditor'];
export const READ_ONLY = ['compliance_officer', 'auditor'];

export const isCorp = (u) => CORP.includes(u?.role);

/** Permissions derived from the signed-in role (the API enforces the same rules). */
export function useCorpRole() {
  const { user } = useAuth();
  return useMemo(() => ({
    user,
    corp: isCorp(user),
    manage: MANAGE.includes(user?.role),
    finance: FINANCE.includes(user?.role),
    readOnly: READ_ONLY.includes(user?.role),
    rosterWrite: MANAGE.includes(user?.role) || isCorp(user),
    corpAdmin: user?.role === 'corporate_admin',
  }), [user]);
}

/** Reference data for forms (products, enumerations, employers for staff). Cached per session. */
let metaPromise = null;
export function useMeta() {
  return useLoad(() => (metaPromise ||= api.get('/corporate/meta').catch((e) => { metaPromise = null; throw e; })));
}

/**
 * Employer scope. Corporate users are always pinned to their own employer (the API ignores the
 * parameter); VHC staff pick an employer via ?employer= (or "all" where a page allows it).
 */
export function useEmployerScope({ allowAll = false } = {}) {
  const { corp } = useCorpRole();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const raw = params.get('employer');
  const fallback = meta.data?.employers?.find((e) => e.id === 'emp_demo')?.id || meta.data?.employers?.[0]?.id || '';
  const employerId = corp ? '' : allowAll ? raw ?? '' : raw || fallback;
  const ready = corp || allowAll || !!employerId;
  const set = (id) => setParams((p) => { const n = new URLSearchParams(p); n.set('employer', id || ''); return n; }, { replace: true });
  const qs = (extra = {}) => {
    const p = new URLSearchParams(Object.entries(extra).filter(([, v]) => v !== '' && v != null));
    if (employerId) p.set('employerId', employerId);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const suffix = !corp && employerId ? `?employer=${employerId}` : '';
  return { employerId, setEmployerId: set, qs, corp, suffix, ready };
}

export function EmployerPicker({ scope, allowAll = false }) {
  const meta = useMeta();
  if (scope.corp) return null;
  const list = meta.data?.employers || [];
  return (
    <label className="corp-picker">
      <span>Employer</span>
      <select value={scope.employerId} onChange={(e) => scope.setEmployerId(e.target.value)} aria-label="Employer">
        {allowAll && <option value="">All employers</option>}
        {list.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.status})</option>)}
      </select>
    </label>
  );
}

export function SandboxNote({ children }) {
  return <p className="corp-sandbox" role="note"><Badge kind="warn">Sandbox</Badge> {children || 'Synthetic data and a synthetic insurer for testing. Not a real insurance contract.'}</p>;
}

/** Renders a k-anonymous cell from the API ({ value, suppressed }). */
export function Priv({ cell, format = (v) => v }) {
  if (cell == null) return '—';
  if (cell.suppressed) return <span className="corp-suppressed" title="Fewer than 5 people — hidden to protect privacy">Suppressed</span>;
  return format(cell.value);
}

export const pctBp = (bp) => `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`;
export const lakh = (paise) => `₹${(paise / 10000000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} lakh`;
export const empType = (t) => String(t || '').replace('_', ' ');
export const signed = (inv) => (inv.direction === 'credit' ? `− ${money(inv.total)}` : money(inv.total));

export function Progress({ bp, label }) {
  const v = Math.max(0, Math.min(10000, bp || 0));
  return (
    <div className="corp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v / 100)} aria-label={label}>
      <span style={{ width: `${v / 100}%` }} />
    </div>
  );
}

export function BackLink({ to, children }) {
  return <Link className="corp-back" to={to}>← {children}</Link>;
}

/** Downloads a PDF via the authenticated API. */
export const downloadPdf = (path, name) => api.download(path, `${name}.pdf`);

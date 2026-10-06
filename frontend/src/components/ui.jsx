import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api.js';
import { dateTime } from '../format.js';

/** Loads data with an async function; re-runs when deps change. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Runs a mutating action with busy/error/success state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const run = async (fn, successMessage) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      if (successMessage) setMessage(typeof successMessage === 'function' ? successMessage(r) : successMessage);
      return r;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, message, setError, setMessage };
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

const STATUS_KIND = [
  [/(settled|issued|active|approved|success|paid|verified|completed|resolved|effective)/i, 'ok'],
  [/(reject|lapsed|failed|declined|terminated|error|refund)/i, 'error'],
  [/(grace|more information|documents requested|pending|postponed|flag|requested|due|initiated|open|upcoming)/i, 'warn'],
  [/(review|underwriting|submitted|preauth|final bill|draft|accepted)/i, 'info'],
];
export function Badge({ children, kind }) {
  const k = kind || STATUS_KIND.find(([re]) => re.test(String(children)))?.[1] || '';
  return <span className={`badge ${k}`}>{children}</span>;
}

export function Alert({ kind = 'info', children }) {
  if (!children) return null;
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  const msgs = error instanceof ApiError ? error.messages : [];
  return (
    <Alert kind="error">
      <strong>{error.message}</strong>
      {msgs.length > 0 && <ul>{msgs.map((m, i) => <li key={i}>{m}</li>)}</ul>}
    </Alert>
  );
}

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      {label}
      {hint && <span className="hint">{hint}</span>}
      {children}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export function Loading({ text = 'Loading…' }) {
  return <div className="loading"><span className="spinner" /> {text}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/** columns: [{ key, label, render?(row), num? }] */
export function Table({ columns, rows, empty = 'Nothing to show.', onRowClick, rowKey = 'id' }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ open, title, onClose, children, large }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${large ? 'lg' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: '.75rem' }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Timeline({ items }) {
  if (!items?.length) return <Empty>No activity yet.</Empty>;
  return (
    <ul className="timeline">
      {[...items].reverse().map((t, i) => (
        <li key={i}>
          <div className="when">{dateTime(t.at)} · {t.by}{t.role && t.role !== 'system' ? ` (${t.role.replace('_', ' ')})` : ''}</div>
          <div><Badge>{t.status}</Badge> {t.note}</div>
        </li>
      ))}
    </ul>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? 'active' : ''} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`}>{v ?? '—'}</dd>])}
    </dl>
  );
}

export function Stat({ label, value, to }) {
  const body = <><div className="label">{label}</div><div className="value">{value}</div></>;
  return <div className="stat">{to ? <Link to={to}>{body}</Link> : body}</div>;
}

export function DevHint({ children }) {
  if (!children) return null;
  return <div className="devbox">🔧 <strong>Development mode:</strong> {children}</div>;
}

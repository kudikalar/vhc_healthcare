import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, dateTime, titleCase } from '../../format.js';
import { Alert, Badge, Card, Empty, ErrorBox, Loading, PageHeader, Table, useAction } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

// Document centre (VHC-M10 vault view): one place for policy PDFs and every file attached to the
// customer's applications, policies and claims. Uploads stay on each record so they are always
// attached to the right application or claim.

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function Documents() {
  const [state, setState] = useState({ loading: true, error: null, policies: [], docs: [], failed: 0 });
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [record, setRecord] = useState('');
  const act = useAction();

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [policies, applications, claims] = await Promise.all([api.get('/policies'), api.get('/applications'), api.get('/health-claims')]);
      const sources = [
        ...policies.map((p) => ({ type: 'policy', id: p.id, label: `Policy ${p.policyNumber}`, link: `/policies/${p.id}` })),
        ...applications.map((a) => ({ type: 'application', id: a.id, label: `Application ${a.applicationNumber}`, link: `/applications/${a.id}` })),
        ...claims.map((c) => ({ type: 'healthClaim', id: c.id, label: `Claim ${c.claimNumber}`, link: `/claims/${c.id}` })),
      ];
      const results = await Promise.allSettled(sources.map((s) => api.get(`/documents?entityType=${s.type}&entityId=${s.id}`).then((ds) => ds.map((d) => ({ ...d, source: s })))));
      const docs = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setState({ loading: false, error: null, policies, docs, failed: results.filter((r) => r.status === 'rejected').length });
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
    }
  };
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => [...new Set(state.docs.map((d) => d.category))].sort(), [state.docs]);
  const records = useMemo(() => [...new Map(state.docs.map((d) => [d.source.id, d.source])).values()], [state.docs]);
  const rows = state.docs.filter((d) => (!category || d.category === category) && (!record || d.source.id === record)
    && (!q || `${d.filename} ${d.description} ${d.source.label}`.toLowerCase().includes(q.toLowerCase())));

  if (state.loading) return <><PageHeader title="Documents" /><Loading /></>;
  if (state.error) return <><PageHeader title="Documents" /><ErrorBox error={state.error} /><button className="btn" onClick={load}>Try again</button></>;

  return (
    <>
      <PageHeader title="Documents" subtitle="Your policy documents and every file you've shared with us. Files are private and every download is logged." />
      <ErrorBox error={act.error} />
      {state.failed > 0 && <Alert kind="warn">Some records' documents couldn't be loaded. <button className="btn ghost sm" onClick={load}>Retry</button></Alert>}

      <div className="section-title"><Icon name="shield" /><h2>Policy documents</h2></div>
      {state.policies.length === 0 ? <Card><Empty>Policy documents appear here once a policy is issued.</Empty></Card> : (
        <div className="help-grid">
          {state.policies.map((p) => (
            <div key={p.id} className="help-card">
              <div className="row between"><span className="ic"><Icon name="file" /></span><Badge>{p.status}</Badge></div>
              <h3>{p.planName}</h3>
              <p>{p.policyNumber} · {titleCase(p.product)} · issued {date(p.issuedAt)}</p>
              <div className="row" style={{ marginTop: 'auto' }}>
                <button className="btn sm" disabled={act.busy} onClick={() => act.run(() => api.download(`/policies/${p.id}/pdf`, `${p.policyNumber}.pdf`))}>Download PDF</button>
                <Link className="btn sm secondary" to={`/policies/${p.id}`}>Open policy</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title"><Icon name="file" /><h2>Uploaded files</h2></div>
      <Card>
        <div className="filter-bar" role="search">
          <label>Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="File name or description" /></label>
          <label>Type
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All types</option>
              {categories.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
            </select>
          </label>
          <label>Record
            <select value={record} onChange={(e) => setRecord(e.target.value)}>
              <option value="">All records</option>
              {records.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          {(q || category || record) && <button className="btn ghost" onClick={() => { setQ(''); setCategory(''); setRecord(''); }}>Clear filters</button>}
        </div>
        <Table rows={rows} empty={state.docs.length ? 'No files match these filters.' : 'No files uploaded yet. You can add documents from an application or claim.'}
          columns={[
            { key: 'filename', label: 'File', render: (d) => <><strong>{d.filename}</strong>{d.description && <div className="muted" style={{ fontSize: '.85rem' }}>{d.description}</div>}</> },
            { key: 'category', label: 'Type', render: (d) => titleCase(d.category) },
            { key: 'source', label: 'Attached to', render: (d) => <Link to={d.source.link}>{d.source.label}</Link> },
            { key: 'size', label: 'Size', num: true, render: (d) => kb(d.size) },
            { key: 'createdAt', label: 'Uploaded', render: (d) => <>{dateTime(d.createdAt)}<div className="muted" style={{ fontSize: '.8rem' }}>by {d.uploadedByName}</div></> },
            { key: 'dl', label: '', render: (d) => <button className="btn sm secondary" disabled={act.busy} onClick={() => act.run(() => api.download(`/documents/${d.id}/download`, d.filename))}>Download</button> },
          ]} />
        <p className="muted" style={{ marginBottom: 0, fontSize: '.875rem' }}>To add a file, open the application or claim it belongs to. Only PDF, JPG and PNG files up to 5 MB are accepted.</p>
      </Card>
    </>
  );
}

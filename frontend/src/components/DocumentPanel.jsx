import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { dateTime, titleCase } from '../format.js';
import { Badge, Card, ErrorBox, Field, Table, useAction, useLoad } from './ui.jsx';

const ALL = ['identity', 'income', 'medical_report', 'exam_report', 'bill', 'prescription', 'discharge_summary', 'death_certificate', 'claimant_id', 'entitlement_proof', 'bank_proof', 'other'];

/**
 * Upload/list/download documents attached to an application, policy, claim or grievance.
 * Optional: `preset` ({ categories, n }) pre-selects a document type and focuses the file input (e.g. from a
 * "missing documents" checklist); `hints` maps document id → quality notes; `onUploaded` runs after upload.
 */
export default function DocumentPanel({ entityType, entityId, categories = ALL, canUpload = true, title = 'Documents', preset, hints, onUploaded }) {
  const docs = useLoad(() => api.get(`/documents?entityType=${entityType}&entityId=${entityId}`), [entityType, entityId]);
  const [category, setCategory] = useState(categories[0]);
  const [description, setDescription] = useState('');
  const fileRef = useRef();
  const act = useAction();

  useEffect(() => {
    if (!preset?.n) return;
    const match = (preset.categories || []).find((c) => categories.includes(c));
    if (match) setCategory(match);
    fileRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    fileRef.current?.focus();
  }, [preset?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = () => act.run(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) throw new Error('Choose a file first');
    if (file.size > 5 * 1024 * 1024) throw new Error('File is too large (maximum 5 MB)');
    const form = new FormData();
    form.append('entityType', entityType);
    form.append('entityId', entityId);
    form.append('category', category);
    form.append('description', description);
    form.append('file', file);
    await api.upload('/documents', form);
    fileRef.current.value = '';
    setDescription('');
    docs.reload();
    onUploaded?.();
  }, 'Document uploaded');

  return (
    <Card title={title}>
      <Table
        rows={docs.data}
        empty="No documents uploaded yet."
        columns={[
          { key: 'category', label: 'Type', render: (d) => titleCase(d.category) },
          { key: 'filename', label: 'File', render: (d) => <>{d.filename}{d.description && <div className="muted">{d.description}</div>}{hints?.[d.id]?.map((h, i) => <div key={i}><small style={{ color: 'var(--warn)' }}>⚠ {h}</small></div>)}</> },
          { key: 'by', label: 'Uploaded', render: (d) => <>{d.uploadedByName}<div className="muted">{dateTime(d.createdAt)}</div></> },
          { key: 'dl', label: '', render: (d) => d.restricted ? <Badge kind="warn">Restricted</Badge> : <button className="btn sm secondary" onClick={() => act.run(() => api.download(`/documents/${d.id}/download`, d.filename))}>Download</button> },
        ]}
      />
      {canUpload && (
        <>
          <hr />
          <div className="form-grid">
            <Field label="Document type">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
              </select>
            </Field>
            <Field label="Description (optional)"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label="File" hint="PDF, PNG or JPEG · max 5 MB"><input type="file" ref={fileRef} accept=".pdf,.png,.jpg,.jpeg" /></Field>
          </div>
          <div className="row" style={{ marginTop: '.6rem' }}>
            <button className="btn" disabled={act.busy} onClick={upload}>{act.busy ? 'Uploading…' : 'Upload'}</button>
            {act.message && <span className="badge ok">{act.message}</span>}
          </div>
        </>
      )}
      <div style={{ marginTop: '.6rem' }}><ErrorBox error={act.error} /></div>
    </Card>
  );
}

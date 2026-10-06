import { Field } from './ui.jsx';
import { titleCase } from '../format.js';

const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const fromYn = (v) => (v === 'yes' ? true : v === 'no' ? false : null);

export function ageFrom(dob, on = new Date().toISOString().slice(0, 10)) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  let a = oy - y;
  if (om < m || (om === m && od < d)) a--;
  return a;
}

export const blankMember = (relationship = 'self') => ({
  fullName: '', dob: '', relationship, gender: '', heightCm: '', weightKg: '', hasConditions: null, conditions: '',
  medications: '', surgeries: '', tobacco: null, idType: '', idNumber: '',
});

/** Insured member editor with per-member eligibility errors from the server. */
export function MemberEditor({ members, onChange, relationships, maxMembers, memberErrors = {}, startDate, disabled }) {
  const set = (i, patch) => onChange(members.map((m, k) => (k === i ? { ...m, ...patch } : m)));
  const num = (v) => (v === '' ? '' : Number(v));
  return (
    <div>
      {members.map((m, i) => (
        <div key={m.id || i} className="member-card">
          <div className="row between">
            <strong>{m.fullName || `Member ${i + 1}`} {m.dob && startDate && <span className="muted">· age {ageFrom(m.dob, startDate)} at start</span>}</strong>
            {!disabled && <button className="btn ghost sm" onClick={() => onChange(members.filter((_, k) => k !== i))}>Remove</button>}
          </div>
          {memberErrors[i] && <div className="alert error" style={{ marginTop: '.5rem' }}><ul>{memberErrors[i].map((e, k) => <li key={k}>{e}</li>)}</ul></div>}
          <fieldset disabled={disabled} style={{ border: 'none', padding: 0, margin: '.5rem 0 0' }}>
            <div className="form-grid">
              <Field label="Full name"><input value={m.fullName} onChange={(e) => set(i, { fullName: e.target.value })} /></Field>
              <Field label="Date of birth"><input type="date" value={m.dob} onChange={(e) => set(i, { dob: e.target.value })} /></Field>
              <Field label="Relationship to policyholder">
                <select value={m.relationship} onChange={(e) => set(i, { relationship: e.target.value })}>
                  {['self', 'spouse', 'child', 'parent'].map((r) => <option key={r} value={r} disabled={!relationships.includes(r)}>{titleCase(r)}{!relationships.includes(r) ? ' (not on this plan)' : ''}</option>)}
                </select>
              </Field>
              <Field label="Gender">
                <select value={m.gender} onChange={(e) => set(i, { gender: e.target.value })}>
                  <option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
                </select>
              </Field>
              <Field label="Height (cm)"><input type="number" min="30" value={m.heightCm} onChange={(e) => set(i, { heightCm: num(e.target.value) })} /></Field>
              <Field label="Weight (kg)"><input type="number" min="2" value={m.weightKg} onChange={(e) => set(i, { weightKg: num(e.target.value) })} /></Field>
              <Field label="Tobacco / smoking in last 12 months?">
                <select value={yn(m.tobacco)} onChange={(e) => set(i, { tobacco: fromYn(e.target.value) })}><option value="">— select —</option><option value="no">No</option><option value="yes">Yes</option></select>
              </Field>
              <Field label="Any existing medical conditions?">
                <select value={yn(m.hasConditions)} onChange={(e) => set(i, { hasConditions: fromYn(e.target.value) })}><option value="">— select —</option><option value="no">No</option><option value="yes">Yes</option></select>
              </Field>
              {m.hasConditions && <Field label="Describe conditions" className="full"><input value={m.conditions} onChange={(e) => set(i, { conditions: e.target.value })} placeholder="e.g. Type 2 diabetes since 2021" /></Field>}
              <Field label="Current medications" hint='Enter "None" if none'><input value={m.medications ?? ''} onChange={(e) => set(i, { medications: e.target.value })} /></Field>
              <Field label="Previous surgeries / hospitalisations" hint='Enter "None" if none'><input value={m.surgeries ?? ''} onChange={(e) => set(i, { surgeries: e.target.value })} /></Field>
              <Field label="ID document (sample)">
                <select value={m.idType} onChange={(e) => set(i, { idType: e.target.value })}><option value="">—</option><option>Passport</option><option>Voter ID</option><option>Driving licence</option><option>Birth certificate</option></select>
              </Field>
              <Field label="ID number (sample)"><input value={m.idNumber} onChange={(e) => set(i, { idNumber: e.target.value })} /></Field>
            </div>
          </fieldset>
        </div>
      ))}
      {!disabled && (
        <button className="btn secondary" disabled={members.length >= maxMembers} onClick={() => onChange([...members, blankMember(members.length ? 'spouse' : 'self')])}>
          + Add member {members.length >= maxMembers && `(plan maximum ${maxMembers})`}
        </button>
      )}
    </div>
  );
}

export const blankNominee = () => ({ name: '', relationship: '', dob: '', phone: '', email: '', sharePct: '', guardian: { name: '', relationship: '', phone: '' } });

export function NomineeEditor({ nominees, onChange, disabled }) {
  const set = (i, patch) => onChange(nominees.map((n, k) => (k === i ? { ...n, ...patch } : n)));
  const total = nominees.reduce((t, n) => t + Math.round(Number(n.sharePct || 0) * 100), 0) / 100;
  return (
    <div>
      {nominees.map((n, i) => {
        const minor = n.dob && ageFrom(n.dob) < 18;
        return (
          <div key={i} className="member-card">
            <div className="row between">
              <strong>Nominee {i + 1}{minor && <span className="badge warn" style={{ marginLeft: 6 }}>Minor</span>}</strong>
              {!disabled && <button className="btn ghost sm" onClick={() => onChange(nominees.filter((_, k) => k !== i))}>Remove</button>}
            </div>
            <fieldset disabled={disabled} style={{ border: 'none', padding: 0, margin: '.5rem 0 0' }}>
              <div className="form-grid">
                <Field label="Name"><input value={n.name} onChange={(e) => set(i, { name: e.target.value })} /></Field>
                <Field label="Relationship"><input value={n.relationship} onChange={(e) => set(i, { relationship: e.target.value })} /></Field>
                <Field label="Date of birth"><input type="date" value={n.dob} onChange={(e) => set(i, { dob: e.target.value })} /></Field>
                <Field label="Phone"><input value={n.phone} onChange={(e) => set(i, { phone: e.target.value })} /></Field>
                <Field label="Email"><input value={n.email} onChange={(e) => set(i, { email: e.target.value })} /></Field>
                <Field label="Benefit share (%)"><input type="number" step="0.01" min="0" max="100" value={n.sharePct} onChange={(e) => set(i, { sharePct: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
                {minor && (
                  <>
                    <Field label="Guardian name"><input value={n.guardian?.name || ''} onChange={(e) => set(i, { guardian: { ...n.guardian, name: e.target.value } })} /></Field>
                    <Field label="Guardian relationship"><input value={n.guardian?.relationship || ''} onChange={(e) => set(i, { guardian: { ...n.guardian, relationship: e.target.value } })} /></Field>
                    <Field label="Guardian phone"><input value={n.guardian?.phone || ''} onChange={(e) => set(i, { guardian: { ...n.guardian, phone: e.target.value } })} /></Field>
                  </>
                )}
              </div>
            </fieldset>
          </div>
        );
      })}
      <div className="row between">
        {!disabled && <button className="btn secondary" onClick={() => onChange([...nominees, blankNominee()])}>+ Add nominee</button>}
        <span className={`badge ${total === 100 ? 'ok' : 'error'}`}>Total allocation: {total}% {total === 100 ? '✓' : '(must be exactly 100%)'}</span>
      </div>
    </div>
  );
}

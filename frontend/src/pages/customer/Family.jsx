import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money, titleCase } from '../../format.js';
import { Alert, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, useAction, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

// VHC-M29 (phase 1 scope): a self-owned family summary built from the customer's own policies.
// The family roster is stored on the server (/api/family). Inviting other adults / delegated access
// is a later phase and is not offered here.

const ageOn = (dob) => {
  if (!dob) return null;
  const b = new Date(`${dob}T00:00:00Z`);
  const n = new Date();
  let a = n.getUTCFullYear() - b.getUTCFullYear();
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a -= 1;
  return a;
};
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';
const keyOf = (name, dob) => `${String(name).trim().toLowerCase()}|${dob || ''}`;

/** Merge the family roster, insured members, lives assured and nominees into one card per person. */
export function buildFamily(policies, roster = [], profile = null) {
  const people = new Map();
  const person = (name, dob, relationship) => {
    const k = keyOf(name, dob);
    if (!people.has(k)) people.set(k, { key: k, name, dob, relationship, roles: [] });
    const p = people.get(k);
    if ((!p.relationship || p.relationship === 'Family member') && relationship) p.relationship = relationship;
    return p;
  };
  if (profile?.profile?.dob) Object.assign(person(profile.legalName || profile.name, profile.profile.dob, 'self'), { self: true });
  for (const m of roster) Object.assign(person(m.fullName, m.dob, m.relationship), { rosterId: m.id });
  for (const pol of policies) {
    if (pol.product === 'health') {
      for (const m of pol.members || []) {
        person(m.fullName, m.dob, m.relationship).roles.push({ kind: 'insured', policy: pol });
      }
    } else {
      if (pol.lifeAssured) person(pol.lifeAssured.fullName, pol.lifeAssured.dob, 'self').roles.push({ kind: 'lifeAssured', policy: pol });
      for (const n of pol.currentNominees?.nominees || []) {
        person(n.name, n.dob, n.relationship).roles.push({ kind: 'nominee', policy: pol, share: n.sharePct, minor: n.isMinor, guardian: n.guardian });
      }
    }
  }
  const order = { self: 0, spouse: 1, child: 2, daughter: 2, son: 2, parent: 3 };
  return [...people.values()].sort((a, b) => (order[String(a.relationship).toLowerCase()] ?? 5) - (order[String(b.relationship).toLowerCase()] ?? 5));
}

const RELATIONSHIPS = [['spouse', 'Spouse'], ['child', 'Child'], ['parent', 'Parent'], ['parent-in-law', 'Parent-in-law'], ['sibling', 'Sibling'], ['other', 'Other']];
const EMPTY = { fullName: '', dob: '', relationship: '', gender: '' };

export default function Family() {
  const res = useLoad(() => Promise.all([api.get('/policies'), api.get('/family'), api.get('/profile')]));
  const [editing, setEditing] = useState(null); // null | EMPTY | member
  const [removing, setRemoving] = useState(null);
  const act = useAction();
  if (res.loading) return <Loading />;
  if (res.error) return <><PageHeader title="My family" /><ErrorBox error={res.error} /><button className="btn" onClick={res.reload}>Try again</button></>;

  const [allPolicies, roster, profile] = res.data;
  const policies = allPolicies.filter((p) => !['Terminated'].includes(p.status));
  const family = buildFamily(policies, roster, profile);
  const shared = policies.filter((p) => p.product === 'health' && p.balance);
  const uncovered = family.filter((p) => p.rosterId && !p.roles.some((r) => r.kind === 'insured' || r.kind === 'lifeAssured'));

  const remove = () => act.run(async () => { await api.delete(`/family/${removing.rosterId}`); setRemoving(null); res.reload(); }, 'Removed from your family list');

  return (
    <>
      <PageHeader title="My family" subtitle="Add the people you care for, see who is covered, and get cover for anyone who isn't."
        actions={<><button className="btn" onClick={() => setEditing(EMPTY)}>+ Add family member</button>{uncovered.length > 0 && <Link className="btn secondary" to={`/quote?family=${uncovered.map((p) => p.rosterId).join(',')}`}>Cover {uncovered.length === 1 ? uncovered[0].name.split(' ')[0] : `${uncovered.length} people`}</Link>}</>} />
      {act.message && <Alert kind="ok">{act.message}</Alert>}

      <div className="family-stats">
        <div><b>{family.length}</b><span>people</span></div>
        <div><b>{family.filter((p) => p.roles.some((r) => r.kind === 'insured')).length}</b><span>health insured</span></div>
        <div><b>{family.filter((p) => p.roles.some((r) => r.kind === 'lifeAssured')).length}</b><span>life assured</span></div>
        <div className={uncovered.length ? 'warn' : ''}><b>{uncovered.length}</b><span>without cover</span></div>
      </div>

      {family.length === 0 ? (
        <Card>
          <Empty>
            <p style={{ marginTop: 0 }}>Add your spouse, children or parents to see their cover and get quotes for them.</p>
            <button className="btn" onClick={() => setEditing(EMPTY)}>Add a family member</button>
          </Empty>
        </Card>
      ) : (
        <div className="person-grid">
          {family.map((p) => <PersonCard key={p.key} p={p} onEdit={p.rosterId ? () => setEditing(roster.find((m) => m.id === p.rosterId)) : null} onRemove={p.rosterId ? () => setRemoving(p) : null} />)}
          <button type="button" className="person add-person" onClick={() => setEditing(EMPTY)}><span className="plus">+</span>Add family member</button>
        </div>
      )}

      {shared.length > 0 && (
        <>
          <div className="section-title"><Icon name="shield" /><h2>Shared health cover</h2></div>
          <p className="muted" style={{ marginTop: 0 }}>A family floater is one sum insured shared by everyone on it — it is shown once here, not once per person.</p>
          <div className="glance">
            {shared.map((pol) => <SharedCover key={pol.id} pol={pol} />)}
          </div>
        </>
      )}

      <Card title={<span className="row"><Icon name="family" /> Family access</span>}>
        <p style={{ marginTop: 0 }}>People in your family list can't sign in to see your policies. Adding someone, insuring them or naming them as a nominee never gives them access to your account.</p>
        <Alert kind="info">Inviting an adult family member to view or manage their own cover is planned for a later release.</Alert>
      </Card>

      <MemberModal member={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); res.reload(); }} />
      <Modal open={!!removing} title="Remove from family list?" onClose={() => setRemoving(null)}>
        <p>{removing?.name} will be removed from your family list. Any policy that already covers or names them stays exactly as it is.</p>
        <ErrorBox error={act.error} />
        <div className="row end"><button className="btn secondary" onClick={() => setRemoving(null)}>Cancel</button><button className="btn danger" disabled={act.busy} onClick={remove}>Remove</button></div>
      </Modal>
    </>
  );
}

function MemberModal({ member, onClose, onSaved }) {
  const [f, setF] = useState(EMPTY);
  const act = useAction();
  useEffect(() => { if (member) { setF({ ...EMPTY, ...member }); act.setError(null); } }, [member]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields = act.error?.fields || {};
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = (e) => {
    e.preventDefault();
    act.run(async () => {
      const body = { fullName: f.fullName, dob: f.dob, relationship: f.relationship, gender: f.gender };
      if (member.id) await api.put(`/family/${member.id}`, body); else await api.post('/family', body);
      onSaved();
    });
  };
  return (
    <Modal open={!!member} title={member?.id ? 'Edit family member' : 'Add a family member'} onClose={onClose}>
      <form onSubmit={save} noValidate>
        {act.error && !Object.keys(fields).length && <ErrorBox error={act.error} />}
        <div className="form-grid">
          <Field label="Full name" error={fields.fullName} className="full"><input autoFocus placeholder="e.g. Kamala Iyer" maxLength={120} value={f.fullName} onChange={set('fullName')} aria-invalid={!!fields.fullName} /></Field>
          <Field label="Relationship to you" error={fields.relationship}>
            <select value={f.relationship} onChange={set('relationship')} aria-invalid={!!fields.relationship}>
              <option value="">Select relationship</option>
              {RELATIONSHIPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Date of birth" error={fields.dob}><input type="date" max={new Date().toISOString().slice(0, 10)} value={f.dob} onChange={set('dob')} aria-invalid={!!fields.dob} /></Field>
          <Field label="Gender (optional)" error={fields.gender}>
            <select value={f.gender} onChange={set('gender')}><option value="">Prefer not to say</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
          </Field>
        </div>
        <p className="muted" style={{ fontSize: '.85rem' }}>We only need basic details here. Health questions are asked later, only if you apply for cover for this person.</p>
        <div className="row end">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={act.busy}>{act.busy ? 'Saving…' : member?.id ? 'Save changes' : 'Add to family'}</button>
        </div>
      </form>
    </Modal>
  );
}

const ROLE_TEXT = { insured: 'Health insured', lifeAssured: 'Life assured', nominee: 'Nominee' };

function PersonCard({ p, onEdit, onRemove }) {
  const age = ageOn(p.dob);
  const covered = p.roles.some((r) => r.kind === 'insured' || r.kind === 'lifeAssured');
  const hasHealth = p.roles.some((r) => r.kind === 'insured');
  return (
    <div className="person">
      <div className="head">
        <span className="avatar" aria-hidden="true">{initials(p.name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{p.name}{p.self && <span className="chip neutral" style={{ marginLeft: '.4rem' }}>You</span>}</div>
          <div className="rel">{titleCase(p.relationship || 'Family member')}{age != null ? ` · ${age} yrs` : ''}</div>
        </div>
        {(onEdit || onRemove) && (
          <span className="row" style={{ gap: '.1rem' }}>
            {onEdit && <button className="icon-btn" aria-label={`Edit ${p.name}`} title="Edit" onClick={onEdit}><Icon name="settings" size={17} /></button>}
            {onRemove && <button className="icon-btn" aria-label={`Remove ${p.name}`} title="Remove" onClick={onRemove}><Icon name="close" size={17} /></button>}
          </span>
        )}
      </div>
      {p.roles.length > 0 ? (
        <ul className="checklist">
          {p.roles.map((r, i) => (
            <li key={i}>
              <span className={`chip ${r.policy.product === 'life' ? 'life' : ''}`}>{ROLE_TEXT[r.kind]}</span>
              <span style={{ fontSize: '.9rem' }}>
                <Link to={`/policies/${r.policy.id}`}>{r.policy.planName}</Link>
                {r.kind === 'nominee' && <span className="muted"> · {r.share}% share{r.minor ? ' · minor' : ''}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : <div className="uncovered">No cover yet</div>}
      {p.roles.some((r) => r.kind === 'nominee' && r.minor && r.guardian) && <small>Guardian: {p.roles.find((r) => r.guardian).guardian.name}</small>}
      {!covered && p.rosterId && <Link className="btn sm" to={`/quote?family=${p.rosterId}`}>Get health cover</Link>}
      {covered && !hasHealth && p.rosterId && <Link className="btn sm secondary" to={`/quote?family=${p.rosterId}`}>Add health cover</Link>}
    </div>
  );
}

export function SharedCover({ pol }) {
  const b = pol.balance;
  const pct = (v) => `${b.total ? (v / b.total) * 100 : 0}%`;
  return (
    <Card title={<span>{pol.planName} <small className="muted">· {pol.policyNumber}</small></span>} actions={<Link to={`/policies/${pol.id}`}>Details</Link>}>
      <div className="row between">
        <div><span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{money(b.available)}</span> <small>available of {money(b.total)}</small></div>
        <span className="chip neutral">Shared by {pol.members?.length || 1}</span>
      </div>
      <div className="stacked-meter" role="img" aria-label={`${money(b.paid)} settled, ${money(b.reserved)} reserved, ${money(b.available)} available`}>
        <span className="paid" style={{ width: pct(b.paid) }} />
        <span className="reserved" style={{ width: pct(b.reserved) }} />
        <span className="avail" style={{ width: pct(b.available) }} />
      </div>
      <div className="legend"><span><i style={{ background: 'var(--brand)' }} />Available</span><span><i style={{ background: '#f5b83d' }} />Reserved for open claims</span><span><i style={{ background: 'var(--navy-2)' }} />Settled</span></div>
      <small style={{ display: 'block', marginTop: '.5rem' }}>Cover {date(pol.startDate)} – {date(pol.endDate)}</small>
    </Card>
  );
}

import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { date, money, titleCase } from '../../format.js';
import { Alert, Card, Empty, ErrorBox, Loading, PageHeader, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

// VHC-M29 (phase 1 scope): a self-owned family summary built from the customer's own policies.
// Inviting other adults / delegated access is a later phase and is not offered here.

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

/** Merge insured members, lives assured and nominees into one card per person. */
export function buildFamily(policies) {
  const people = new Map();
  const person = (name, dob, relationship) => {
    const k = keyOf(name, dob);
    if (!people.has(k)) people.set(k, { key: k, name, dob, relationship, roles: [] });
    const p = people.get(k);
    if (!p.relationship && relationship) p.relationship = relationship;
    return p;
  };
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
  const order = { self: 0, spouse: 1, child: 2, parent: 3 };
  return [...people.values()].sort((a, b) => (order[String(a.relationship).toLowerCase()] ?? 5) - (order[String(b.relationship).toLowerCase()] ?? 5));
}

export default function Family() {
  const res = useLoad(() => api.get('/policies'));
  if (res.loading) return <Loading />;
  if (res.error) return <><PageHeader title="My family" /><ErrorBox error={res.error} /><button className="btn" onClick={res.reload}>Try again</button></>;

  const policies = res.data.filter((p) => !['Terminated'].includes(p.status));
  const family = buildFamily(policies);
  const shared = policies.filter((p) => p.product === 'health' && p.balance);

  return (
    <>
      <PageHeader title="My family" subtitle="Everyone covered or named on your policies, in one place." actions={<Link className="btn secondary" to="/plans">Add cover for someone</Link>} />

      {family.length === 0 ? (
        <Card>
          <Empty>
            <p style={{ marginTop: 0 }}>No family members yet. People you insure or nominate on a policy will appear here.</p>
            <Link className="btn" to="/quote">Get a quote</Link>
          </Empty>
        </Card>
      ) : (
        <div className="person-grid">
          {family.map((p) => <PersonCard key={p.key} p={p} />)}
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

      <Card className="soft-card" title={<span className="row"><Icon name="family" /> Family access</span>}>
        <p style={{ marginTop: 0 }}>Family members listed here can't sign in to see your policies. Being insured or named as a nominee doesn't give anyone access to your account.</p>
        <Alert kind="info">Inviting an adult family member to view or manage their own cover is planned for a later release and isn't available in this demo.</Alert>
      </Card>
    </>
  );
}

const ROLE_TEXT = { insured: 'Insured', lifeAssured: 'Life assured', nominee: 'Nominee' };

function PersonCard({ p }) {
  const age = ageOn(p.dob);
  return (
    <div className="person">
      <div className="head">
        <span className="avatar" aria-hidden="true">{initials(p.name)}</span>
        <div>
          <div className="name">{p.name}</div>
          <div className="rel">{titleCase(p.relationship || 'Family member')}{age != null ? ` · ${age} yrs` : ''}</div>
        </div>
      </div>
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
      {p.roles.some((r) => r.kind === 'nominee' && r.minor && r.guardian) && (
        <small>Guardian: {p.roles.find((r) => r.guardian).guardian.name}</small>
      )}
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

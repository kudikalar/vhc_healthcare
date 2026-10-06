import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ROLE_LABEL, date } from '../format.js';

const NAV = {
  customer: [
    ['Overview', [['/dashboard', 'Dashboard', '◧'], ['/notifications', 'Notifications', '🔔'], ['/profile', 'Profile', '👤']]],
    ['Buy cover', [['/plans', 'Plans & comparison', '▤'], ['/quote', 'Get a quote', '₹'], ['/applications', 'Applications', '✎']]],
    ['My cover', [['/policies', 'Policies & documents', '🛡'], ['/claims', 'Health claims', '✚'], ['/payments', 'Payments & receipts', '⇄']]],
    ['Help', [['/hospitals', 'Network hospitals', '🏥']]],
  ],
  agent: [
    ['Operations', [['/ops', 'Dashboard', '◧'], ['/ops/applications', 'Application queue', '✎']]],
    ['Reference', [['/plans', 'Plan catalogue', '▤'], ['/hospitals', 'Hospitals', '🏥'], ['/profile', 'My profile', '👤']]],
  ],
  underwriter: [
    ['Operations', [['/ops', 'Dashboard', '◧'], ['/ops/applications', 'Application queue', '✎'], ['/ops/reinstatements', 'Reinstatements', '↺']]],
    ['Reference', [['/plans', 'Plan catalogue', '▤'], ['/profile', 'My profile', '👤']]],
  ],
  claims_officer: [
    ['Operations', [['/ops', 'Dashboard', '◧'], ['/ops/health-claims', 'Health claims', '✚'], ['/ops/life-claims', 'Life claims', '🕊'], ['/ops/payouts', 'Payments & payouts', '⇄'], ['/ops/exceptions', 'Exception queue', '⚠']]],
    ['Reference', [['/hospitals', 'Hospitals', '🏥'], ['/profile', 'My profile', '👤']]],
  ],
  admin: [
    ['Operations', [['/ops', 'Dashboard', '◧'], ['/ops/applications', 'Application queue', '✎'], ['/ops/reinstatements', 'Reinstatements', '↺'], ['/ops/health-claims', 'Health claims', '✚'], ['/ops/life-claims', 'Life claims', '🕊'], ['/ops/payouts', 'Payments & payouts', '⇄'], ['/ops/exceptions', 'Exception queue', '⚠']]],
    ['Administration', [['/admin/plans', 'Plans & rates', '▤'], ['/admin/hospitals', 'Hospitals', '🏥'], ['/admin/users', 'Users & roles', '👥'], ['/admin/notifications', 'Notifications', '🔔'], ['/admin/reports', 'Reports & audit', '📊'], ['/admin/dev', 'Dev tools', '⚙']]],
  ],
};
const BARE = ['/login', '/register'];

function useUnread(user) {
  const [n, setN] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    if (!user || user.role === 'claimant') return;
    api.get('/notifications', { quiet401: true }).then((r) => setN(r.unread)).catch(() => {});
  }, [user, loc.pathname]);
  return n;
}

function useClock() {
  const [c, setC] = useState(null);
  useEffect(() => {
    const load = () => api.get('/dev/clock', { quiet401: true }).then(setC).catch(() => setC(null));
    load();
    window.addEventListener('vhc:clock', load);
    return () => window.removeEventListener('vhc:clock', load);
  }, []);
  return c;
}

const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const unread = useUnread(user);
  const clock = useClock();
  const groups = user ? NAV[user.role] || [] : [];
  const bare = BARE.includes(loc.pathname);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-mark">+</span> Vision Health Care</Link>
        <nav className="topnav" aria-label="Public">
          <NavLink to="/plans">Plans</NavLink>
          <NavLink to="/quote">Get a quote</NavLink>
          <NavLink to="/hospitals">Hospitals</NavLink>
          <NavLink to="/life-claim">Report a life claim</NavLink>
        </nav>
        <div className="topbar-right">
          {clock && clock.offsetDays !== 0 && <span className="badge warn" title="The test clock is shifted">Test date {date(clock.today)}</span>}
          {user ? (
            <>
              {user.role !== 'claimant' && (
                <Link to="/notifications" className="bell" aria-label={`${unread} unread notifications`}>🔔{unread > 0 && <span className="dot">{unread}</span>}</Link>
              )}
              <div className="user-chip">
                <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
                <span className="who">{user.name}<small className="muted">{ROLE_LABEL[user.role]}</small></span>
              </div>
              <button className="btn sm secondary" onClick={async () => { await logout(); nav('/login', { replace: true }); }}>Sign out</button>
            </>
          ) : (
            <>
              <Link to="/login">Sign in</Link>
              <Link to="/register" className="btn sm">Create account</Link>
            </>
          )}
        </div>
      </header>
      {bare ? <Outlet /> : user && groups.length > 0 ? (
        <div className="shell">
          <aside className="sidebar" aria-label="Main navigation">
            {groups.map(([title, links]) => (
              <div key={title}>
                <h4>{title}</h4>
                {links.map(([to, label, ico]) => <NavLink key={to} to={to} end={to === '/ops' || to === '/dashboard'}><span className="ico" aria-hidden="true">{ico}</span>{label}</NavLink>)}
              </div>
            ))}
          </aside>
          <main className="main"><Outlet /></main>
        </div>
      ) : (
        <main className="main" style={{ margin: '0 auto' }}><Outlet /></main>
      )}
      {!bare && <footer className="footer">Vision Health Care — a demonstration system. All products, prices, people and hospitals are fictional.</footer>}
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ROLE_LABEL, date } from '../format.js';
import Icon from './Icon.jsx';

// Navigation follows the V2 spec: customer, staff (only authorised workspaces) and mobile tab bar.
const NAV = {
  customer: [
    [null, [['/dashboard', 'Home', 'home'], ['/plans', 'Explore cover', 'explore'], ['/family', 'My family', 'family'], ['/policies', 'My policies', 'shield'], ['/claims', 'Claims', 'claim'], ['/hospitals', 'Hospitals', 'hospital'], ['/payments', 'Payments', 'card'], ['/documents', 'Documents', 'file'], ['/support', 'Support', 'help']]],
    ['Buying cover', [['/quote', 'Get a quote', 'calc'], ['/applications', 'Applications', 'clipboard']]],
    ['Account', [['/notifications', 'Notifications', 'bell'], ['/profile', 'Profile & security', 'user']]],
  ],
  agent: [
    ['Workspace', [['/ops', 'My work', 'work'], ['/ops/applications', 'Applications', 'clipboard']]],
    ['Reference', [['/plans', 'Plan catalogue', 'layers'], ['/hospitals', 'Hospitals', 'hospital'], ['/profile', 'My profile', 'user']]],
  ],
  underwriter: [
    ['Workspace', [['/ops', 'My work', 'work'], ['/ops/applications', 'Underwriting', 'clipboard'], ['/ops/reinstatements', 'Servicing', 'refresh']]],
    ['Reference', [['/plans', 'Plan catalogue', 'layers'], ['/profile', 'My profile', 'user']]],
  ],
  claims_officer: [
    ['Workspace', [['/ops', 'My work', 'work'], ['/ops/health-claims', 'Health claims', 'claim'], ['/ops/life-claims', 'Life claims', 'dove'], ['/ops/payouts', 'Payments & payouts', 'payout'], ['/ops/exceptions', 'Financial exceptions', 'alert']]],
    ['Reference', [['/hospitals', 'Hospitals', 'hospital'], ['/profile', 'My profile', 'user']]],
  ],
  admin: [
    ['Workspace', [['/ops', 'My work', 'work'], ['/ops/applications', 'Applications & underwriting', 'clipboard'], ['/ops/reinstatements', 'Servicing', 'refresh'], ['/ops/health-claims', 'Health claims', 'claim'], ['/ops/life-claims', 'Life claims', 'dove'], ['/ops/payouts', 'Payments & payouts', 'payout'], ['/ops/exceptions', 'Financial exceptions', 'alert'], ['/admin/reports', 'Reports & audit', 'chart']]],
    ['Administration', [['/admin/plans', 'Plans & rates', 'layers'], ['/admin/hospitals', 'Hospitals', 'hospital'], ['/admin/users', 'Users & roles', 'family'], ['/admin/notifications', 'Notifications', 'bell'], ['/admin/dev', 'Dev tools', 'settings']]],
  ],
};
const MOBILE_TABS = [['/dashboard', 'Home', 'home'], ['/policies', 'Policies', 'shield'], ['/claims', 'Claims', 'claim'], ['/support', 'Help', 'help']];
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

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';
const exact = (to) => ['/ops', '/dashboard', '/claims'].includes(to);

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const unread = useUnread(user);
  const clock = useClock();
  const online = useOnline();
  const [drawer, setDrawer] = useState(false);
  const groups = user ? NAV[user.role] || [] : [];
  const bare = BARE.includes(loc.pathname);
  const isCustomer = user?.role === 'customer';
  const withShell = !bare && user && groups.length > 0;

  useEffect(() => { setDrawer(false); window.scrollTo?.(0, 0); }, [loc.pathname]);
  useEffect(() => {
    if (!drawer) return undefined;
    const esc = (e) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drawer]);

  const signOut = async () => { await logout(); nav('/login', { replace: true }); };

  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <div className="sim-bar" role="note">
        <span className="sim-pill">Simulation</span>
        <span className="sim-long">Fictional products, people and hospitals · simulated payments — no real money is charged.</span>
        <span className="sim-short">Demo data · no real money is charged</span>
      </div>
      {!online && (
        <div className="offline-bar" role="status"><Icon name="offline" size={16} /> You're offline. Changes can't be saved until your connection returns.</div>
      )}
      <header className="topbar">
        {withShell && (
          <button className="icon-btn menu-btn" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" /></button>
        )}
        <Link to="/" className="brand"><img src="/logo-mark.png" alt="" className="brand-logo" /><span className="brand-text">Vision <b>Health Care</b></span></Link>
        {!withShell && (
          <nav className="topnav" aria-label="Public">
            <NavLink to="/plans">Plans</NavLink>
            <NavLink to="/quote">Get a quote</NavLink>
            <NavLink to="/hospitals">Hospitals</NavLink>
            <NavLink to="/life-claim">Report a life claim</NavLink>
          </nav>
        )}
        <div className="spacer" />
        <div className="topbar-right">
          {clock && clock.offsetDays !== 0 && <span className="badge warn" title="The test clock is shifted">Test date {date(clock.today)}</span>}
          {user ? (
            <>
              {isCustomer && <Link to="/support#claim-help" className="btn sm claim-help"><Icon name="claim" size={16} /> <span className="hide-sm">Claim help</span></Link>}
              {user.role !== 'claimant' && (
                <Link to="/notifications" className="icon-btn bell" aria-label={`Notifications, ${unread} unread`}><Icon name="bell" />{unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}</Link>
              )}
              <Link to={user.role === 'claimant' ? '/life-claim' : '/profile'} className="user-chip">
                <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
                <span className="who hide-sm">{user.name}<small>{ROLE_LABEL[user.role]}</small></span>
              </Link>
              <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn sm secondary">Sign in</Link>
              <Link to="/register" className="btn sm hide-sm">Create account</Link>
            </>
          )}
        </div>
      </header>

      {bare ? <Outlet /> : withShell ? (
        <div className={`shell ${isCustomer ? 'has-tabs' : ''}`}>
          {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />}
          <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Main navigation">
            <div className="drawer-head">
              <span className="brand"><img src="/logo-mark.png" alt="" className="brand-logo" /> Menu</span>
              <button className="icon-btn" aria-label="Close navigation" onClick={() => setDrawer(false)}><Icon name="close" /></button>
            </div>
            {groups.map(([title, links], gi) => (
              <nav key={title || gi} aria-label={title || 'Primary'}>
                {title && <h4>{title}</h4>}
                {links.map(([to, label, ico]) => (
                  <NavLink key={to} to={to} end={exact(to)}><Icon name={ico} size={19} />{label}</NavLink>
                ))}
              </nav>
            ))}
            {isCustomer && (
              <div className="sidebar-help">
                <strong>Need help with a claim?</strong>
                <span>Start a claim, check documents or report a life claim.</span>
                <Link to="/support#claim-help">Get claim help →</Link>
              </div>
            )}
          </aside>
          <main className="main" id="main" tabIndex={-1}><Outlet /></main>
        </div>
      ) : (
        <main className="main main-public" id="main" tabIndex={-1}><Outlet /></main>
      )}

      {withShell && isCustomer && (
        <nav className="tabbar" aria-label="Quick navigation">
          {MOBILE_TABS.map(([to, label, ico]) => (
            <NavLink key={to} to={to} end={exact(to)}><Icon name={ico} size={22} /><span>{label}</span></NavLink>
          ))}
          <button type="button" onClick={() => setDrawer(true)} aria-expanded={drawer}><Icon name="menu" size={22} /><span>More</span></button>
        </nav>
      )}
      {!bare && (
        <footer className={`footer ${withShell ? 'with-shell' : ''}`}>
          <img src="/logo-mark.png" alt="" width="20" height="20" />
          <span>Vision Health Care — a demonstration system. All products, prices, people and hospitals are fictional; insurer decisions shown here are simulated.</span>
        </footer>
      )}
    </>
  );
}

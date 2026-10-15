// Platform modules (phases 2–6). Each module owns its pages and contributes routes + navigation here,
// so modules can evolve independently of the app shell.
import * as partners from './pages/partners/index.jsx';
import * as network from './pages/network/index.jsx';
import * as claimsops from './pages/claimsops/index.jsx';
import * as corporate from './pages/corporate/index.jsx';
import * as enterprise from './pages/enterprise/index.jsx';

export const MODULES = [partners, network, claimsops, corporate, enterprise];
export const moduleRoutes = MODULES.flatMap((m) => m.routes || []);
/** Navigation groups contributed by modules for a role. */
export const moduleNav = (role) => {
  // Groups with the same title from different modules are merged; duplicate links are dropped.
  const groups = new Map();
  for (const [title, links] of MODULES.flatMap((m) => m.nav?.[role] || [])) {
    const g = groups.get(title) || [];
    for (const l of links) if (!g.some((x) => x[0] === l[0])) g.push(l);
    groups.set(title, g);
  }
  return [...groups.entries()];
};
export const { AppProviders, TopbarExtras } = enterprise;

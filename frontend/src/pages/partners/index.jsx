// Module entry: routes and navigation this module contributes to the app shell (see src/modules.js).
//   routes: [{ path, roles: string[] | null (null = public), element }]
//   nav:    { [role]: [[groupTitle, [[to, label, iconName], ...]], ...] }  (merged after the built-in groups)
import { InsurerDetail, InsurerList } from './Insurers.jsx';
import IntegrationHub from './IntegrationHub.jsx';
import { InsurerAnalytics, InsurerHome, InsurerPolicies, InsurerPortability, InsurerProducts, InsurerProposal, InsurerProposals } from './InsurerPortal.jsx';
import { CustomerPortability, PortabilityOversight } from './Portability.jsx';
import Sales from './Sales.jsx';

const INSURER = ['insurer_admin', 'insurer_user'];
const REGISTRY = ['admin', 'operations_admin', 'compliance_officer', 'auditor'];
const HUB = ['admin', 'operations_admin'];
const SALES = ['sales_manager', 'agent', 'admin'];

export const routes = [
  { path: '/insurer', roles: INSURER, element: <InsurerHome /> },
  { path: '/insurer/proposals', roles: INSURER, element: <InsurerProposals /> },
  { path: '/insurer/proposals/:id', roles: INSURER, element: <InsurerProposal /> },
  { path: '/insurer/policies', roles: INSURER, element: <InsurerPolicies /> },
  { path: '/insurer/products', roles: INSURER, element: <InsurerProducts /> },
  { path: '/insurer/portability', roles: INSURER, element: <InsurerPortability /> },
  { path: '/insurer/analytics', roles: INSURER, element: <InsurerAnalytics /> },
  { path: '/partners/insurers', roles: REGISTRY, element: <InsurerList /> },
  { path: '/partners/insurers/:id', roles: REGISTRY, element: <InsurerDetail /> },
  { path: '/partners/hub', roles: HUB, element: <IntegrationHub /> },
  { path: '/partners/portability', roles: REGISTRY, element: <PortabilityOversight /> },
  { path: '/sales', roles: SALES, element: <Sales /> },
  { path: '/portability', roles: ['customer'], element: <CustomerPortability /> },
];

const insurerNav = [['Insurer portal', [
  ['/insurer', 'Home', 'home'], ['/insurer/proposals', 'Proposals', 'clipboard'], ['/insurer/policies', 'Issued policies', 'shield'],
  ['/insurer/products', 'Products', 'layers'], ['/insurer/portability', 'Portability', 'refresh'], ['/insurer/analytics', 'Performance', 'chart'],
]]];
const salesNav = [['Sales', [['/sales', 'Leads & pipeline', 'briefcase']]]];

export const nav = {
  insurer_admin: insurerNav,
  insurer_user: insurerNav,
  admin: [['Partners', [['/partners/insurers', 'Insurers', 'building'], ['/partners/hub', 'Integration hub', 'link'], ['/partners/portability', 'Portability', 'refresh'], ['/sales', 'Leads & pipeline', 'briefcase']]]],
  operations_admin: [['Partners', [['/partners/insurers', 'Insurers', 'building'], ['/partners/hub', 'Integration hub', 'link'], ['/partners/portability', 'Portability', 'refresh']]]],
  compliance_officer: [['Partners', [['/partners/insurers', 'Insurers (read-only)', 'building'], ['/partners/portability', 'Portability', 'refresh']]]],
  auditor: [['Partners', [['/partners/insurers', 'Insurers (read-only)', 'building'], ['/partners/portability', 'Portability', 'refresh']]]],
  sales_manager: salesNav,
  agent: salesNav,
  customer: [['Cover servicing', [['/portability', 'Portability & migration', 'refresh']]]],
};

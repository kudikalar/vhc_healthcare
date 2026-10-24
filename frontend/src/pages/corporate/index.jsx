// Module entry: routes and navigation this module contributes to the app shell (see src/modules.js).
//   routes: [{ path, roles: string[] | null (null = public), element }]
//   nav:    { [role]: [[groupTitle, [[to, label, iconName], ...]], ...] }  (merged after the built-in groups)
import HrDashboard from './HrDashboard.jsx';
import { EmployeeDetail, Employees } from './Employees.jsx';
import { GroupPolicies, GroupPolicyDetail } from './GroupPolicies.jsx';
import { Endorsements, InsurerConfirmations } from './Endorsements.jsx';
import Invoices from './Invoices.jsx';
import Wellness from './Wellness.jsx';
import { EmployerDetail, Employers } from './Employers.jsx';
import Team from './Team.jsx';
import Benefits from './Benefits.jsx';

const CORP = ['corporate_admin', 'corporate_hr'];
const VIEW_ALL = ['admin', 'operations_admin', 'sales_manager', 'finance_manager', 'compliance_officer', 'auditor'];
const PORTAL = [...CORP, ...VIEW_ALL];

export const routes = [
  { path: '/corporate', roles: PORTAL, element: <HrDashboard /> },
  { path: '/corporate/employees', roles: PORTAL, element: <Employees /> },
  { path: '/corporate/employees/:id', roles: PORTAL, element: <EmployeeDetail /> },
  { path: '/corporate/policies', roles: PORTAL, element: <GroupPolicies /> },
  { path: '/corporate/policies/:id', roles: PORTAL, element: <GroupPolicyDetail /> },
  { path: '/corporate/endorsements', roles: PORTAL, element: <Endorsements /> },
  { path: '/corporate/invoices', roles: PORTAL, element: <Invoices /> },
  { path: '/corporate/wellness', roles: PORTAL, element: <Wellness /> },
  { path: '/corporate/employers', roles: VIEW_ALL, element: <Employers /> },
  { path: '/corporate/employers/:id', roles: VIEW_ALL, element: <EmployerDetail /> },
  { path: '/corporate/team', roles: ['corporate_admin'], element: <Team /> },
  { path: '/corporate/confirmations', roles: ['admin', 'operations_admin', 'insurer_admin', 'insurer_user'], element: <InsurerConfirmations /> },
  { path: '/benefits', roles: ['customer'], element: <Benefits /> },
];

const portal = [
  ['/corporate', 'Dashboard', 'home'],
  ['/corporate/employees', 'Employees', 'family'],
  ['/corporate/policies', 'Group policies', 'shield'],
  ['/corporate/endorsements', 'Endorsements', 'clipboard'],
  ['/corporate/invoices', 'Invoices', 'ledger'],
  ['/corporate/wellness', 'Wellness', 'stethoscope'],
];
const staffCorporate = [['Corporate', [['/corporate/employers', 'Employers', 'building'], ['/corporate/policies', 'Group policies', 'shield']]]];

export const nav = {
  corporate_hr: [['Employer portal', portal], ['Reference', [['/hospitals', 'Hospitals', 'hospital']]]],
  corporate_admin: [['Employer portal', [...portal, ['/corporate/team', 'Team & billing', 'briefcase']]], ['Reference', [['/hospitals', 'Hospitals', 'hospital']]]],
  admin: staffCorporate,
  operations_admin: staffCorporate,
  sales_manager: [['Corporate', [['/corporate/employers', 'Employers', 'building']]]],
  compliance_officer: [['Corporate', [['/corporate/employers', 'Employers (read-only)', 'building']]]],
  auditor: [['Corporate', [['/corporate/employers', 'Employers (read-only)', 'building']]]],
  finance_manager: [['Corporate', [['/corporate/invoices', 'Corporate billing', 'ledger']]]],
  insurer_admin: [['Group business', [['/corporate/confirmations', 'Group confirmations', 'clipboard']]]],
  insurer_user: [['Group business', [['/corporate/confirmations', 'Group confirmations', 'clipboard']]]],
  customer: [['Employee benefits', [['/benefits', 'My benefits', 'briefcase']]]],
};

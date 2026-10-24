// Module entry: routes and navigation this module contributes to the app shell (see src/modules.js).
//   routes: [{ path, roles: string[] | null (null = public), element }]
//   nav:    { [role]: [[groupTitle, [[to, label, iconName], ...]], ...] }  (merged after the built-in groups)
//
// Claims operations: regulatory TAT board, fraud & anomaly review, VHC grievances & appeals, claim intimations.
import { FraudReview } from './FraudReview.jsx';
import { GrievanceDetail, GrievanceQueue, GrievancesPage, StaffGrievanceDetail } from './Grievances.jsx';
import { IntimateClaim, IntimationDetail, IntimationQueue } from './Intimations.jsx';
import { SlaBoard } from './SlaBoard.jsx';
import './claimsops.css';

const CUSTOMER = ['customer'];
const CLAIMS_TEAM = ['claims_officer', 'admin'];
const OVERSIGHT = ['compliance_officer', 'auditor'];
const GRIEVANCE_STAFF = ['claims_officer', 'admin', 'support_manager', 'support_agent'];

export const routes = [
  { path: '/grievances', roles: CUSTOMER, element: <GrievancesPage /> },
  { path: '/grievances/:id', roles: CUSTOMER, element: <GrievanceDetail /> },
  { path: '/claims/intimate', roles: CUSTOMER, element: <IntimateClaim /> },
  { path: '/claims/intimations/:id', roles: CUSTOMER, element: <IntimationDetail /> },
  { path: '/ops/claims-sla', roles: [...CLAIMS_TEAM, ...OVERSIGHT], element: <SlaBoard /> },
  { path: '/ops/fraud-review', roles: CLAIMS_TEAM, element: <FraudReview /> },
  { path: '/ops/intimations', roles: CLAIMS_TEAM, element: <IntimationQueue /> },
  { path: '/ops/grievances', roles: [...GRIEVANCE_STAFF, ...OVERSIGHT], element: <GrievanceQueue /> },
  { path: '/ops/grievances/:id', roles: [...GRIEVANCE_STAFF, ...OVERSIGHT], element: <StaffGrievanceDetail /> },
];

const claimsOps = ['Claims operations', [
  ['/ops/claims-sla', 'Claims SLA board', 'clock'],
  ['/ops/fraud-review', 'Fraud review', 'flag'],
  ['/ops/grievances', 'Grievances', 'scale'],
  ['/ops/intimations', 'Intimations', 'bell'],
]];
const grievancesOnly = ['Customer care', [['/ops/grievances', 'Grievances', 'scale']]];
const oversight = ['Claims oversight', [['/ops/claims-sla', 'Claims SLA board', 'clock'], ['/ops/grievances', 'Grievances', 'scale']]];

export const nav = {
  customer: [['Help', [['/grievances', 'Grievances', 'scale']]]],
  claims_officer: [claimsOps],
  admin: [claimsOps],
  support_manager: [grievancesOnly],
  support_agent: [grievancesOnly],
  compliance_officer: [oversight],
  auditor: [oversight],
};

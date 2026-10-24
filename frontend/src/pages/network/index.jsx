// Module entry: routes and navigation this module contributes to the app shell (see src/modules.js).
//   routes: [{ path, roles: string[] | null (null = public), element }]
//   nav:    { [role]: [[groupTitle, [[to, label, iconName], ...]], ...] }  (merged after the built-in groups)
import { ProviderDetail, ProviderDirectory } from './Directory.jsx';
import { Appointments, HealthServices } from './Services.jsx';
import { HospitalPortal } from './HospitalPortal.jsx';
import { TpaPortal } from './TpaPortal.jsx';
import {
  BookingsAdmin, ContractAdminDetail, ContractsAdmin, NetworkAnalytics, NetworksAdmin, ProviderAdminDetail, ProvidersAdmin, TpasAdmin,
} from './NetworkAdmin.jsx';

const MANAGE = ['admin', 'operations_admin'];
const OVERSIGHT = [...MANAGE, 'compliance_officer', 'auditor'];

export const routes = [
  { path: '/hospitals', roles: null, element: <ProviderDirectory /> },
  { path: '/hospitals/:id', roles: null, element: <ProviderDetail /> },
  { path: '/services', roles: null, element: <HealthServices /> },
  { path: '/appointments', roles: ['customer'], element: <Appointments /> },
  { path: '/hospital', roles: ['hospital_admin', 'hospital_staff'], element: <HospitalPortal /> },
  { path: '/tpa', roles: ['tpa_admin', 'tpa_agent'], element: <TpaPortal /> },
  { path: '/network/providers', roles: OVERSIGHT, element: <ProvidersAdmin /> },
  { path: '/network/providers/:id', roles: OVERSIGHT, element: <ProviderAdminDetail /> },
  { path: '/network/contracts', roles: OVERSIGHT, element: <ContractsAdmin /> },
  { path: '/network/contracts/:id', roles: OVERSIGHT, element: <ContractAdminDetail /> },
  { path: '/network/cashless', roles: OVERSIGHT, element: <NetworksAdmin /> },
  { path: '/network/tpas', roles: OVERSIGHT, element: <TpasAdmin /> },
  { path: '/network/bookings', roles: OVERSIGHT, element: <BookingsAdmin /> },
  { path: '/network/analytics', roles: OVERSIGHT, element: <NetworkAnalytics /> },
];

const NETWORK_GROUP = ['Network', [
  ['/network/providers', 'Providers', 'hospital'], ['/network/contracts', 'Contracts', 'file'], ['/network/cashless', 'Cashless networks', 'link'],
  ['/network/tpas', 'TPAs', 'briefcase'], ['/network/bookings', 'Bookings', 'calendar'], ['/network/analytics', 'Network analytics', 'chart'],
]];
const HOSPITAL_GROUP = ['Hospital', [['/hospital', 'Hospital portal', 'hospital'], ['/hospitals', 'Provider directory', 'explore']]];
const TPA_GROUP = ['TPA', [['/tpa', 'TPA portal', 'briefcase'], ['/hospitals', 'Provider directory', 'explore']]];
const OVERSIGHT_GROUP = ['Network', [['/network/providers', 'Providers', 'hospital']]];

export const nav = {
  admin: [NETWORK_GROUP],
  operations_admin: [NETWORK_GROUP],
  compliance_officer: [OVERSIGHT_GROUP],
  auditor: [OVERSIGHT_GROUP],
  hospital_admin: [HOSPITAL_GROUP],
  hospital_staff: [HOSPITAL_GROUP],
  tpa_admin: [TPA_GROUP],
  tpa_agent: [TPA_GROUP],
  customer: [['Health services', [['/services', 'Health services', 'stethoscope'], ['/appointments', 'Appointments', 'calendar']]]],
};

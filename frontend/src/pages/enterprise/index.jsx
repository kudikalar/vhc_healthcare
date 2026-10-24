// Module entry: routes and navigation this module contributes to the app shell (see src/modules.js).
//   routes: [{ path, roles: string[] | null (null = public), element }]
//   nav:    { [role]: [[groupTitle, [[to, label, iconName], ...]], ...] }  (merged after the built-in groups)
// This module also provides app-wide chrome: AppProviders (language + text size) and TopbarExtras
// (language selector and "A+" toggle in the top bar).
import { cloneElement, isValidElement } from 'react';
import Support from '../customer/Support.jsx';
import CommandCentre from './CommandCentre.jsx';
import { FinanceOverview, ReconciliationPage, RefundsPage } from './Finance.jsx';
import { CustomerTicketPage, CustomerTicketsPage, Helpdesk, HelpdeskTicket, KbArticle, KnowledgeBase } from './SupportDesk.jsx';
import CompliancePage from './Compliance.jsx';
import { PayLinkPage, PaymentScenarios } from './PaymentsExtras.jsx';
import { LanguageControls, LanguageProvider, translate, useLang } from './i18n.jsx';
import './enterprise.css';

export { useT } from './i18n.jsx';

const READ_ONLY = ['compliance_officer', 'auditor'];
const COMMAND = ['admin', 'operations_admin', 'sales_manager', 'finance_manager', ...READ_ONLY];
const FINANCE = ['admin', 'finance_manager', ...READ_ONLY];
const SUPPORT_STAFF = ['admin', 'support_manager', 'support_agent', ...READ_ONLY, 'operations_admin'];
const OVERSIGHT = ['admin', ...READ_ONLY];

export const routes = [
  { path: '/support', roles: null, element: <Support /> },
  { path: '/support/kb', roles: null, element: <KnowledgeBase /> },
  { path: '/support/kb/:slug', roles: null, element: <KbArticle /> },
  { path: '/support/tickets', roles: ['customer'], element: <CustomerTicketsPage /> },
  { path: '/support/tickets/:id', roles: ['customer'], element: <CustomerTicketPage /> },
  { path: '/command', roles: COMMAND, element: <CommandCentre /> },
  { path: '/finance', roles: FINANCE, element: <FinanceOverview /> },
  { path: '/finance/refunds', roles: FINANCE, element: <RefundsPage /> },
  { path: '/finance/reconciliation', roles: FINANCE, element: <ReconciliationPage /> },
  { path: '/helpdesk', roles: SUPPORT_STAFF, element: <Helpdesk /> },
  { path: '/helpdesk/tickets/:id', roles: SUPPORT_STAFF, element: <HelpdeskTicket /> },
  ...['/compliance', '/compliance/audit', '/compliance/access', '/compliance/data-requests', '/compliance/consents', '/compliance/ai', '/compliance/disclosures']
    .map((path) => ({ path, roles: OVERSIGHT, element: <CompliancePage /> })),
  { path: '/admin/payment-scenarios', roles: ['admin', 'finance_manager', ...READ_ONLY], element: <PaymentScenarios /> },
  { path: '/pay/:code', roles: ['customer'], element: <PayLinkPage /> },
];

const NAV = {
  admin: [['Enterprise', [['/command', 'Command centre', 'chart'], ['/finance', 'Finance', 'ledger'], ['/helpdesk', 'Helpdesk', 'ticket'], ['/compliance', 'Compliance', 'scale'], ['/admin/payment-scenarios', 'Payment scenarios', 'card']]]],
  finance_manager: [['Finance', [['/finance', 'Finance', 'ledger'], ['/finance/refunds', 'Refunds', 'refresh'], ['/finance/reconciliation', 'Reconciliation', 'scale'], ['/command', 'Command centre', 'chart'], ['/admin/payment-scenarios', 'Payment scenarios', 'card']]]],
  support_manager: [['Support', [['/helpdesk', 'Helpdesk', 'ticket'], ['/support/kb', 'Knowledge base', 'file']]]],
  support_agent: [['Support', [['/helpdesk', 'Helpdesk', 'ticket'], ['/support/kb', 'Knowledge base', 'file']]]],
  compliance_officer: [['Oversight', [['/command', 'Command centre', 'chart'], ['/compliance/audit', 'Audit log', 'clipboard'], ['/compliance/data-requests', 'Data requests', 'user'], ['/compliance/consents', 'Consent register', 'shield'], ['/finance', 'Finance (read-only)', 'ledger']]]],
  auditor: [['Oversight', [['/command', 'Command centre', 'chart'], ['/compliance/audit', 'Audit log', 'clipboard'], ['/compliance/data-requests', 'Data requests', 'user'], ['/compliance/consents', 'Consent register', 'shield'], ['/finance', 'Finance (read-only)', 'ledger']]]],
  operations_admin: [['Command', [['/command', 'Command centre', 'chart'], ['/helpdesk', 'Helpdesk', 'ticket']]]],
  sales_manager: [['Command', [['/command', 'Command centre', 'chart']]]],
  customer: [['Help', [['/support/tickets', 'Support tickets', 'ticket']]]],
};

// Labels are translated at read time, so the sidebar follows the selected language (AppProviders
// re-renders the app when the language changes).
export const nav = new Proxy(NAV, {
  get(target, role) {
    if (typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(target, role)) return undefined;
    const groups = target[role];
    return groups.map(([title, links]) => [translate(title), links.map(([to, label, icon]) => [to, translate(label), icon])]);
  },
});

function Rerender({ children }) {
  // Reading the context makes this re-render on language change; cloning the app element forces the
  // shell (which does not read the context itself) to re-render with translated labels.
  const { lang } = useLang();
  return isValidElement(children) ? cloneElement(children, { 'data-lang': lang }) : children;
}

export function AppProviders({ children }) {
  return <LanguageProvider><Rerender>{children}</Rerender></LanguageProvider>;
}

export function TopbarExtras() {
  return <LanguageControls />;
}

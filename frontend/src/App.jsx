import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import { AcceptInvite, ForgotPassword, Login, Register, ResetPassword, VerifyEmail } from './pages/public/Auth.jsx';
import { Home, Hospitals, Plans } from './pages/public/Catalogue.jsx';
import QuoteCalculator from './pages/public/QuoteCalculator.jsx';
import { Applications, Notifications, Payments } from './pages/customer/CustomerPages.jsx';
import Dashboard from './pages/customer/Dashboard.jsx';
import Profile from './pages/customer/Profile.jsx';
import ApplicationDetail from './pages/customer/ApplicationDetail.jsx';
import { Policies, PolicyDetail } from './pages/customer/Policies.jsx';
import { ClaimDetail, ClaimsList, NewClaim } from './pages/customer/Claims.jsx';
import LifeClaimPortal from './pages/claimant/LifeClaimPortal.jsx';
import { ApplicationQueue, UnderwritingWorkspace } from './pages/staff/StaffApplications.jsx';
import { HealthClaimReview, HealthClaimsQueue, LifeClaimReview, LifeClaimsQueue } from './pages/staff/StaffClaims.jsx';
import { ExceptionQueue, OpsDashboard, PayoutReview, Reinstatements } from './pages/staff/StaffOps.jsx';
import { DevTools, HospitalAdmin, NotificationAdmin, PlanConfig, ReportsAudit, UserAdmin } from './pages/admin/AdminPages.jsx';

/** Route guard: requires login and (optionally) one of the given roles. */
function Guard({ roles, children }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return children;
}

const C = ['customer'];
const STAFF_ALL = ['agent', 'underwriter', 'claims_officer', 'admin'];
const UW = ['agent', 'underwriter', 'admin'];
const CLAIMS = ['claims_officer', 'admin'];
const ADMIN = ['admin'];
const g = (roles, el) => <Guard roles={roles}>{el}</Guard>;

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={user && user.role !== 'claimant' ? <Navigate to={homeFor(user)} /> : <Home />} />
        <Route path="/home" element={<Home />} />
        <Route path="/login" element={user ? <Navigate to={homeFor(user)} /> : <Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/plans" element={<Plans />} />
        <Route path="/quote" element={<QuoteCalculator />} />
        <Route path="/hospitals" element={<Hospitals />} />
        <Route path="/life-claim" element={<LifeClaimPortal />} />

        <Route path="/dashboard" element={g(C, <Dashboard />)} />
        <Route path="/profile" element={g([...C, ...STAFF_ALL], <Profile />)} />
        <Route path="/notifications" element={g([...C, ...STAFF_ALL], <Notifications />)} />
        <Route path="/applications" element={g(C, <Applications />)} />
        <Route path="/applications/:id" element={g(C, <ApplicationDetail />)} />
        <Route path="/policies" element={g(C, <Policies />)} />
        <Route path="/policies/:id" element={g([...C, ...STAFF_ALL], <PolicyDetail />)} />
        <Route path="/claims" element={g(C, <ClaimsList />)} />
        <Route path="/claims/new" element={g(C, <NewClaim />)} />
        <Route path="/claims/:id" element={g(C, <ClaimDetail />)} />
        <Route path="/payments" element={g(C, <Payments />)} />

        <Route path="/ops" element={g(STAFF_ALL, <OpsDashboard />)} />
        <Route path="/ops/applications" element={g(UW, <ApplicationQueue />)} />
        <Route path="/ops/applications/:id" element={g(UW, <UnderwritingWorkspace />)} />
        <Route path="/ops/reinstatements" element={g(['underwriter', 'admin'], <Reinstatements />)} />
        <Route path="/ops/health-claims" element={g(CLAIMS, <HealthClaimsQueue />)} />
        <Route path="/ops/health-claims/:id" element={g(CLAIMS, <HealthClaimReview />)} />
        <Route path="/ops/life-claims" element={g(CLAIMS, <LifeClaimsQueue />)} />
        <Route path="/ops/life-claims/:id" element={g(CLAIMS, <LifeClaimReview />)} />
        <Route path="/ops/payouts" element={g(CLAIMS, <PayoutReview />)} />
        <Route path="/ops/exceptions" element={g(CLAIMS, <ExceptionQueue />)} />

        <Route path="/admin/plans" element={g(ADMIN, <PlanConfig />)} />
        <Route path="/admin/hospitals" element={g(ADMIN, <HospitalAdmin />)} />
        <Route path="/admin/users" element={g(ADMIN, <UserAdmin />)} />
        <Route path="/admin/notifications" element={g(ADMIN, <NotificationAdmin />)} />
        <Route path="/admin/reports" element={g(ADMIN, <ReportsAudit />)} />
        <Route path="/admin/dev" element={g(ADMIN, <DevTools />)} />
        <Route path="*" element={<div className="empty">Page not found.</div>} />
      </Route>
    </Routes>
  );
}

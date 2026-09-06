import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Navigation } from './components/Navigation/Navigation';
import { Home } from './pages/Home/Home';
import { Engines } from './pages/Engines/Engines';
import { RegisterEngine } from './pages/RegisterEngine/RegisterEngine';
import { Profiles } from './pages/Profiles/Profiles';
import { Examples } from './pages/Examples/Examples';
import {
  CasCallback,
  Login,
  PasswordResetCompletePage,
  PasswordResetRequestPage,
} from './pages/Auth/Login';
import { Register } from './pages/Auth/Register';
import { Account } from './pages/Account/Account';
import { Admin } from './pages/Admin/Admin';
import { SiteFooter } from './components/SiteFooter/SiteFooter';
import { PlatformShell } from './components/PlatformShell/PlatformShell';
import './styles/globals.css';
import './App.css';

// Keep the first educational step lean; the editor and schema tree load on demand.
const Playground = lazy(() => import('./pages/Playground/Playground').then((module) => ({ default: module.Playground })));
const Schemas = lazy(() => import('./pages/Schemas/Schemas').then((module) => ({ default: module.Schemas })));
const Pricing = lazy(() => import('./pages/Pricing/Pricing').then((module) => ({ default: module.Pricing })));
const PlatformDashboard = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.PlatformDashboard })));
const ProjectOverview = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.ProjectOverview })));
const OrganizationSettingsPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.OrganizationSettingsPage })));
const CasesPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.CasesPage })));
const ResourcesPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.ResourcesPage })));
const CollectionsPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.CollectionsPage })));
const StudiesPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.StudiesPage })));
const AnalyticsPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.AnalyticsPage })));
const ProjectRecordsPage = lazy(() => import('./pages/Platform/PlatformPages').then((module) => ({ default: module.ProjectRecordsPage })));
const PricingControlRoomPage = lazy(() => import('./pages/Platform/PricingControlRoom').then((module) => ({ default: module.PricingControlRoomPage })));
const ExplorePage = lazy(() => import('./pages/Public/PublicPages').then((module) => ({ default: module.ExplorePage })));
const TeamPage = lazy(() => import('./pages/Public/PublicPages').then((module) => ({ default: module.TeamPage })));
const ResearchPage = lazy(() => import('./pages/Public/PublicPages').then((module) => ({ default: module.ResearchPage })));
const FundingPage = lazy(() => import('./pages/Public/PublicPages').then((module) => ({ default: module.FundingPage })));
const ContributionsPage = lazy(() => import('./pages/Public/PublicPages').then((module) => ({ default: module.ContributionsPage })));
const ChangelogPage = lazy(() => import('./pages/Public/PublicPages').then((module) => ({ default: module.ChangelogPage })));

function AppSurface() {
  const location = useLocation();
  const isPlatform = location.pathname === '/app' || location.pathname.startsWith('/app/');

  return (
    <div className={`app-container${isPlatform ? ' is-platform' : ''}`}>
      {!isPlatform && <><a className="skip-link" href="#main-content">Skip to content</a><Navigation /></>}
      <main id="main-content" className="main-content" tabIndex={-1}>
        <Suspense fallback={<div className="route-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading interface…</div>}>
              <Routes>
                {/* Public learning surface; Engine discovery and execution require an account. */}
                <Route path="/" element={<Home />} />
                <Route path="/playground" element={<ProtectedRoute><Playground /></ProtectedRoute>} />
                <Route path="/profiles" element={<Profiles />} />
                <Route path="/examples" element={<Examples />} />
                <Route path="/explore" element={<ExplorePage />} />
                <Route path="/engines" element={<ProtectedRoute><Engines /></ProtectedRoute>} />
                {/* Registering needs an account: an engine belongs to somebody. */}
                <Route
                  path="/engines/new"
                  element={
                    <ProtectedRoute>
                      <RegisterEngine />
                    </ProtectedRoute>
                  }
                />
                <Route path="/schemas" element={<Schemas />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/research" element={<ResearchPage />} />
                <Route path="/funding" element={<FundingPage />} />
                <Route path="/contributions" element={<ContributionsPage />} />
                <Route path="/changelog" element={<ChangelogPage />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/auth/cas/callback" element={<CasCallback />} />
                <Route path="/password-reset" element={<PasswordResetRequestPage />} />
                <Route path="/password-reset/complete" element={<PasswordResetCompletePage />} />

                {/* The guard is a courtesy; the gateway guards these itself. */}
                <Route
                  path="/account"
                  element={
                    <ProtectedRoute>
                      <Account />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute requireAdmin>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
                <Route path="/app" element={<ProtectedRoute><PlatformShell /></ProtectedRoute>}>
                  <Route index element={<PlatformDashboard />} />
                  <Route path=":org" element={<ProjectOverview />} />
                  <Route path=":org/settings" element={<OrganizationSettingsPage />} />
                  <Route path=":org/:project" element={<ProjectOverview />} />
                  <Route path=":org/:project/cases" element={<CasesPage />} />
                  <Route path=":org/:project/resources" element={<ResourcesPage />} />
                  <Route path=":org/:project/collections" element={<CollectionsPage />} />
                  <Route path=":org/:project/workbench" element={<Playground />} />
                  <Route path=":org/:project/studies" element={<StudiesPage />} />
                  <Route path=":org/:project/analytics" element={<AnalyticsPage />} />
                  <Route path=":org/:project/reports" element={<ProjectRecordsPage kind="reports" />} />
                  <Route path=":org/:project/artifacts" element={<ProjectRecordsPage kind="artifacts" />} />
                  <Route path="admin/pricing" element={<ProtectedRoute requireAdmin><PricingControlRoomPage /></ProtectedRoute>} />
                </Route>
              </Routes>
        </Suspense>
      </main>
      {!isPlatform && <SiteFooter />}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppSurface />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;

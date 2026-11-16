// The route table follows SPHERE frontend/src/routes/router.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Pattern only: one `useRoutes` object table under SPHERE's banners. OpenBinding keeps its own screens and addresses until each
// domain is poured into SPHERE's pages, and lists them in `screens`, the table its screen budget and route tests read.

/* eslint-disable react-refresh/only-export-components -- the table exports `screens` for the budget and route tests */
import { lazy, type ComponentType, type ReactNode } from 'react';
import { useRoutes, type RouteObject } from 'react-router-dom';
import { AppLayout as WorkspaceLayout } from '../layouts/AppLayout';
import { PublicLayout } from '../layouts/PublicLayout';
import ProtectedRoute from '../modules/auth/components/protected-route';
import NotFoundPage from '../modules/core/pages/page-not-found';
import { CasCallback } from '../pages/Auth/CasCallback';
import { Login } from '../pages/Auth/Login';
import { PasswordResetPage } from '../pages/Auth/PasswordReset';
import { Register } from '../pages/Auth/Register';
import { Engines } from '../pages/Engines/Engines';
import { Home } from '../pages/Home/Home';
import AppLayout from './app-layout';

/**
 * Where a screen renders: `public` in the public layout, `session` in the layout of the session (the workspace chrome when
 * signed in, the public one otherwise), `app` in the workspace under /app, which needs an account.
 */
export type ScreenLayout = 'public' | 'session' | 'app';

/** One screen of the application and the address that serves it. */
export interface Screen {
  /** Screen id from the prototype index (for example `problem-detail`). */
  id: string;
  /** Route pattern. */
  path: string;
  layout: ScreenLayout;
  element: ReactNode;
  requireAdmin?: boolean;
}

const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then(module => ({ default: module[name] })));

const About = named(() => import('../pages/About/About'), 'About');
const WorkbenchPage = named(() => import('../pages/Public/PublicPages'), 'WorkbenchPage');
const Pricing = named(() => import('../pages/Pricing/Pricing'), 'Pricing');
const LanguagePage = named(() => import('../pages/Language/LanguagePage'), 'LanguagePage');
const AcceptInvitation = named(
  () => import('../pages/Invitations/AcceptInvitation'),
  'AcceptInvitation'
);
const EngineDetail = named(() => import('../pages/EngineDetail/EngineDetail'), 'EngineDetail');
const RegisterEngine = named(
  () => import('../pages/RegisterEngine/RegisterEngine'),
  'RegisterEngine'
);
const EngRegistrations = named(
  () => import('../pages/Engines/EngRegistrations'),
  'EngRegistrations'
);
const EngRegistrationDetail = named(
  () => import('../pages/Engines/EngRegistrationDetail'),
  'EngRegistrationDetail'
);
const AccountPage = named(() => import('../pages/Account/AccountPage'), 'AccountPage');
const AppHome = named(() => import('../pages/AppHome/AppHome'), 'AppHome');
const OrgOverview = named(() => import('../pages/Organization/OrgOverview'), 'OrgOverview');
const OrgSettings = named(() => import('../pages/Organization/OrgSettings'), 'OrgSettings');
const PublicCompositionList = named(
  () => import('../pages/PublicCompositions/PublicCompositionList'),
  'PublicCompositionList'
);
const Showcase = named(() => import('../pages/PublicCompositions/Showcase'), 'Showcase');
const CompositionList = named(
  () => import('../pages/Compositions/CompositionList'),
  'CompositionList'
);
const CompositionDetail = named(
  () => import('../pages/Compositions/CompositionDetail'),
  'CompositionDetail'
);
const ProblemList = named(() => import('../pages/Problems/ProblemList'), 'ProblemList');
const ProblemDetail = named(() => import('../pages/Problems/ProblemDetail'), 'ProblemDetail');
const ProblemEditorPage = named(
  () => import('../pages/Problems/ProblemEditorPage'),
  'ProblemEditorPage'
);
const RunLaunch = named(() => import('../pages/Runs/RunLaunch'), 'RunLaunch');
const RunList = named(() => import('../pages/Runs/RunList'), 'RunList');
const RunDetail = named(() => import('../pages/Runs/RunDetail'), 'RunDetail');
const StudyList = named(() => import('../pages/Studies/StudyList'), 'StudyList');
const StudyBuilder = named(() => import('../pages/Studies/StudyBuilder'), 'StudyBuilder');
const StudyDetail = named(() => import('../pages/Studies/StudyDetail'), 'StudyDetail');
const AdminOverview = named(() => import('../pages/Admin/AdminOverview'), 'AdminOverview');
const AdminUsers = named(() => import('../pages/Admin/AdminUsers'), 'AdminUsers');
const AdminUserDetail = named(() => import('../pages/Admin/AdminUserDetail'), 'AdminUserDetail');
const AdminModeration = named(() => import('../pages/Admin/AdminModeration'), 'AdminModeration');

/**
 * Every screen, one line each with a literal id and path: the end-to-end smoke test and the QA gallery read these lines as
 * text (e2e/helpers/galleryRoutes.ts), and the screen budget counts them (screenBudget.test.ts).
 */
// prettier-ignore
export const screens: Screen[] = [
  // ═══════════════════════════════════════════════════════════
  // PUBLIC ROUTES (the public layout; `/` becomes the landing or the dashboard in B5)
  // ═══════════════════════════════════════════════════════════
  { id: 'pub-home', path: '/', layout: 'public', element: <Home /> },
  { id: 'pub-workbench', path: '/workbench', layout: 'public', element: <WorkbenchPage /> },
  { id: 'pub-about', path: '/about', layout: 'public', element: <About /> },
  { id: 'pub-pricing', path: '/pricing', layout: 'public', element: <Pricing /> },
  { id: 'pub-language', path: '/language', layout: 'public', element: <LanguagePage /> },
  { id: 'auth-login', path: '/login', layout: 'public', element: <Login /> },
  { id: 'auth-register', path: '/register', layout: 'public', element: <Register /> },
  { id: 'auth-reset-request', path: '/password-reset', layout: 'public', element: <PasswordResetPage /> },
  { id: 'auth-cas-callback', path: '/auth/cas/callback', layout: 'public', element: <CasCallback /> },
  { id: 'eng-catalog', path: '/engines', layout: 'public', element: <Engines /> },
  { id: 'eng-detail', path: '/engines/:namespace/:name/:version', layout: 'public', element: <EngineDetail /> },

  // ═══════════════════════════════════════════════════════════
  // PUBLIC ROUTES (AppLayout: public or authenticated chrome, by session)
  // ═══════════════════════════════════════════════════════════
  { id: 'org-invite-accept', path: '/invitations/accept', layout: 'session', element: <AcceptInvitation /> },
  { id: 'pub-compositions', path: '/compositions', layout: 'session', element: <PublicCompositionList /> },
  { id: 'pub-showcase', path: '/c/:org/:composition', layout: 'session', element: <Showcase /> },

  // ═══════════════════════════════════════════════════════════
  // PROTECTED ROUTES (require auth + the workspace layout under /app)
  // ═══════════════════════════════════════════════════════════
  { id: 'eng-register', path: '/app/engines/new', layout: 'app', element: <RegisterEngine /> },
  { id: 'eng-registrations', path: '/app/engines/registrations', layout: 'app', element: <EngRegistrations /> },
  { id: 'eng-registration-detail', path: '/app/engines/registrations/:name', layout: 'app', element: <EngRegistrationDetail /> },
  { id: 'acct-profile', path: '/app/account/:section?', layout: 'app', element: <AccountPage /> },
  { id: 'app-home', path: '/app', layout: 'app', element: <AppHome /> },
  { id: 'org-overview', path: '/app/:org', layout: 'app', element: <OrgOverview /> },
  { id: 'org-settings', path: '/app/:org/settings/:section?', layout: 'app', element: <OrgSettings /> },
  { id: 'composition-list', path: '/app/:org/compositions', layout: 'app', element: <CompositionList /> },
  { id: 'composition-detail', path: '/app/:org/compositions/:composition/:tab?', layout: 'app', element: <CompositionDetail /> },
  { id: 'problem-list', path: '/app/:org/problems', layout: 'app', element: <ProblemList /> },
  { id: 'problem-detail', path: '/app/:org/problems/:case/:tab?', layout: 'app', element: <ProblemDetail /> },
  { id: 'problem-editor', path: '/app/:org/problem-editor', layout: 'app', element: <ProblemEditorPage /> },
  { id: 'run-launch', path: '/app/:org/runs/new', layout: 'app', element: <RunLaunch /> },
  { id: 'run-list', path: '/app/:org/runs', layout: 'app', element: <RunList /> },
  { id: 'run-detail', path: '/app/:org/runs/:job', layout: 'app', element: <RunDetail /> },
  { id: 'study-list', path: '/app/:org/studies', layout: 'app', element: <StudyList /> },
  { id: 'study-builder', path: '/app/:org/studies/new', layout: 'app', element: <StudyBuilder /> },
  { id: 'study-detail', path: '/app/:org/studies/:study/:tab?', layout: 'app', element: <StudyDetail /> },
  { id: 'admin-overview', path: '/app/admin', layout: 'app', element: <AdminOverview />, requireAdmin: true },
  { id: 'admin-users', path: '/app/admin/users', layout: 'app', element: <AdminUsers />, requireAdmin: true },
  { id: 'admin-user-detail', path: '/app/admin/users/:user', layout: 'app', element: <AdminUserDetail />, requireAdmin: true },
  { id: 'admin-moderation', path: '/app/admin/moderation', layout: 'app', element: <AdminModeration />, requireAdmin: true },

  // ═══════════════════════════════════════════════════════════
  // EDITORS (standalone layout): `/editor` (C7) and `/problem-editor` (D2)
  // ═══════════════════════════════════════════════════════════
];

/** The routes of one layout, an administrator's screens behind the guard. */
function routesOf(table: Screen[], layout: ScreenLayout): RouteObject[] {
  return table
    .filter(screen => screen.layout === layout)
    .map(screen => ({
      path: screen.path,
      element: screen.requireAdmin ? (
        <ProtectedRoute requireAdmin>{screen.element}</ProtectedRoute>
      ) : (
        screen.element
      ),
    }));
}

/** The application's routes. `table` is replaceable so a test can render stand-ins for the screens. */
export default function Router({ table = screens }: { table?: Screen[] }) {
  return useRoutes([
    // ═══════════════════════════════════════════════════════════
    // PUBLIC ROUTES
    // ═══════════════════════════════════════════════════════════
    { element: <PublicLayout />, children: routesOf(table, 'public') },

    // ═══════════════════════════════════════════════════════════
    // PUBLIC ROUTES (AppLayout: public or authenticated, by session)
    // ═══════════════════════════════════════════════════════════
    { element: <AppLayout />, children: routesOf(table, 'session') },

    // ═══════════════════════════════════════════════════════════
    // PROTECTED ROUTES (require auth + the workspace layout)
    // ═══════════════════════════════════════════════════════════
    {
      element: (
        <ProtectedRoute>
          <WorkspaceLayout />
        </ProtectedRoute>
      ),
      children: routesOf(table, 'app'),
    },

    // ═══════════════════════════════════════════════════════════
    // ERROR / CATCH-ALL: the in-place 404, never a redirect
    // ═══════════════════════════════════════════════════════════
    { element: <PublicLayout />, children: [{ path: '*', element: <NotFoundPage /> }] },
  ]);
}

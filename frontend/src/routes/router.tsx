// The route table follows SPHERE frontend/src/routes/router.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Pattern only: one `useRoutes` object table under SPHERE's banners. OpenBinding keeps its own screens and addresses until each
// domain is poured into SPHERE's pages, and lists them in `screens`, the table its screen budget and route tests read.

/* eslint-disable react-refresh/only-export-components -- the table exports `screens` for the budget and route tests */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Outlet, useRoutes, type RouteObject } from 'react-router-dom';
import { RouteFallback } from '../components/PlatformShell/RouteFallback';
import ProtectedRoute from '../modules/auth/components/protected-route';
import ErrorBoundary from '../modules/core/components/error-boundary';
import NotFoundPage from '../modules/core/pages/page-not-found';
import AuthenticatedLayout from '../modules/presentation/layouts/authenticated-layout';
import PublicLayout from '../modules/presentation/layouts/public-layout';
import { Engines } from '../pages/Engines/Engines';
import AppLayout from './app-layout';
import { LegacyOrgOutlet } from './LegacyOrgOutlet';

/**
 * Where a screen renders: `public` in the public layout, `session` in the layout of the session (the workspace chrome when
 * signed in, the public one otherwise), `protected` in SPHERE's authenticated layout (an account is needed), `app` in the old
 * workspace under /app, which needs an account too and goes as its screens are poured into SPHERE's pages, `standalone` with no
 * application chrome at all: the editors, which draw their own layout and are open to visitors.
 */
export type ScreenLayout = 'public' | 'session' | 'protected' | 'app' | 'standalone';

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

const RootPage = lazy(() => import('../modules/presentation/pages/root'));
const PublicOrganizationsPage = lazy(
  () => import('../modules/organization/pages/public-organizations-list')
);
const OrganizationsListPage = lazy(
  () => import('../modules/organization/pages/organizations-list')
);
const OrganizationDetailPage = lazy(
  () => import('../modules/organization/pages/organization-detail')
);
const OrganizationJoinPage = lazy(() => import('../modules/organization/pages/organization-join'));
const InboxPage = lazy(() => import('../modules/notification/pages/inbox'));
const SettingsPage = lazy(() => import('../modules/settings/pages/settings-page'));
const ApiKeysPage = lazy(() => import('../modules/api-keys/pages/api-keys-page'));
const AuthenticationPage = lazy(() => import('../modules/auth/pages/authentication-page'));
const ForgotPasswordPage = lazy(() => import('../modules/auth/pages/forgot-password'));
const ResetPasswordPage = lazy(() => import('../modules/auth/pages/reset-password'));
const SsoCallbackPage = lazy(() => import('../modules/auth/pages/sso-callback'));
const CreateOrganizationPage = lazy(
  () => import('../modules/organization/pages/create-organization')
);
const About = named(() => import('../pages/About/About'), 'About');
const Pricing = named(() => import('../pages/Pricing/Pricing'), 'Pricing');
const LanguagePage = named(() => import('../pages/Language/LanguagePage'), 'LanguagePage');
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
const CompositionListPage = lazy(() => import('../modules/composition/pages/list'));
const UserCompositionListPage = lazy(() => import('../modules/composition/pages/user-list'));
const CompositionCardPage = lazy(() => import('../modules/composition/pages/card'));
const CreateCompositionPage = lazy(() => import('../modules/composition/pages/create'));
const PermanentLinkPage = lazy(() => import('../modules/composition/pages/permalink'));
const EditorLayout = lazy(() => import('../modules/composition-editor/layouts/editor-layout'));
const CompositionEditorPage = lazy(
  () => import('../modules/composition-editor/pages/composition-editor')
);
const ProblemCardPage = lazy(() => import('../modules/problem/pages/card'));
const ProblemEditorLayout = lazy(() => import('../modules/problem-editor/layouts/editor-layout'));
const ProblemEditorPage = lazy(() => import('../modules/problem-editor/pages/problem-editor'));
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
  // PUBLIC ROUTES (the public layout)
  // ═══════════════════════════════════════════════════════════
  { id: 'pub-about', path: '/about', layout: 'public', element: <About /> },
  { id: 'pub-pricing', path: '/pricing', layout: 'public', element: <Pricing /> },
  { id: 'pub-language', path: '/language', layout: 'public', element: <LanguagePage /> },
  { id: 'auth', path: '/authentication', layout: 'public', element: <AuthenticationPage /> },
  { id: 'auth-forgot-password', path: '/forgot-password', layout: 'public', element: <ForgotPasswordPage /> },
  { id: 'auth-reset-password', path: '/reset-password', layout: 'public', element: <ResetPasswordPage /> },
  { id: 'auth-sso-callback', path: '/sso/callback', layout: 'public', element: <SsoCallbackPage /> },
  { id: 'eng-catalog', path: '/engines', layout: 'public', element: <Engines /> },
  { id: 'eng-detail', path: '/engines/:namespace/:name/:version', layout: 'public', element: <EngineDetail /> },

  // ═══════════════════════════════════════════════════════════
  // PUBLIC ROUTES (AppLayout: public or authenticated chrome, by session)
  // ═══════════════════════════════════════════════════════════
  { id: 'pub-home', path: '/', layout: 'session', element: <RootPage /> },
  { id: 'org-explore', path: '/organizations', layout: 'session', element: <PublicOrganizationsPage /> },
  { id: 'org-detail', path: '/orgs/:org/:tab?', layout: 'session', element: <OrganizationDetailPage /> },
  { id: 'pub-compositions', path: '/compositions', layout: 'session', element: <CompositionListPage /> },
  { id: 'composition-card', path: '/compositions/:org/:composition/:tab?', layout: 'session', element: <CompositionCardPage /> },
  { id: 'composition-permalink', path: '/p/:id', layout: 'session', element: <PermanentLinkPage /> },

  // ═══════════════════════════════════════════════════════════
  // PROTECTED ROUTES (require auth + AuthenticatedLayout)
  // ═══════════════════════════════════════════════════════════
  { id: 'org-list', path: '/me/orgs', layout: 'protected', element: <OrganizationsListPage /> },
  { id: 'org-new', path: '/orgs/new', layout: 'protected', element: <CreateOrganizationPage /> },
  { id: 'org-join', path: '/orgs/join/:code', layout: 'protected', element: <OrganizationJoinPage /> },
  { id: 'my-compositions', path: '/me/compositions', layout: 'protected', element: <UserCompositionListPage /> },
  { id: 'composition-new', path: '/compositions/new', layout: 'protected', element: <CreateCompositionPage /> },
  { id: 'notifications', path: '/notifications', layout: 'protected', element: <InboxPage /> },
  { id: 'acct-settings', path: '/me/settings', layout: 'protected', element: <SettingsPage /> },
  { id: 'acct-api-keys', path: '/me/api-keys', layout: 'protected', element: <ApiKeysPage /> },
  { id: 'problem-detail', path: '/problems/:org/:problem/:tab?', layout: 'protected', element: <ProblemCardPage /> },

  // ═══════════════════════════════════════════════════════════
  // PROTECTED ROUTES (the old workspace under /app, until its screens are poured into SPHERE's pages)
  // ═══════════════════════════════════════════════════════════
  { id: 'eng-register', path: '/app/engines/new', layout: 'app', element: <RegisterEngine /> },
  { id: 'eng-registrations', path: '/app/engines/registrations', layout: 'app', element: <EngRegistrations /> },
  { id: 'eng-registration-detail', path: '/app/engines/registrations/:name', layout: 'app', element: <EngRegistrationDetail /> },
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
  // EDITORS (standalone layout): `/editor` and `/problem-editor`
  // ═══════════════════════════════════════════════════════════
  { id: 'composition-editor', path: '/editor', layout: 'standalone', element: <EditorLayout><CompositionEditorPage /></EditorLayout> },
  { id: 'problem-editor', path: '/problem-editor', layout: 'standalone', element: <ProblemEditorLayout><ProblemEditorPage /></ProblemEditorLayout> },
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
    {
      element: (
        <PublicLayout>
          <LegacyOrgOutlet />
        </PublicLayout>
      ),
      children: routesOf(table, 'public'),
    },

    // ═══════════════════════════════════════════════════════════
    // PUBLIC ROUTES (AppLayout: public or authenticated, by session)
    // ═══════════════════════════════════════════════════════════
    {
      element: (
        <AppLayout>
          <LegacyOrgOutlet />
        </AppLayout>
      ),
      children: routesOf(table, 'session'),
    },

    // ═══════════════════════════════════════════════════════════
    // PROTECTED ROUTES (require auth + AuthenticatedLayout)
    // ═══════════════════════════════════════════════════════════
    {
      element: (
        <ProtectedRoute>
          <AuthenticatedLayout>
            <LegacyOrgOutlet />
          </AuthenticatedLayout>
        </ProtectedRoute>
      ),
      children: routesOf(table, 'protected'),
    },
    {
      element: (
        <ProtectedRoute>
          <AuthenticatedLayout>
            <LegacyOrgOutlet workspace />
          </AuthenticatedLayout>
        </ProtectedRoute>
      ),
      children: routesOf(table, 'app'),
    },

    // ═══════════════════════════════════════════════════════════
    // STANDALONE (the editors: their own layout, open to visitors)
    // ═══════════════════════════════════════════════════════════
    {
      element: (
        <ErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      ),
      children: routesOf(table, 'standalone'),
    },

    // ═══════════════════════════════════════════════════════════
    // ERROR / CATCH-ALL: the in-place 404 in the session's chrome, never a redirect
    // ═══════════════════════════════════════════════════════════
    {
      element: (
        <AppLayout>
          <LegacyOrgOutlet />
        </AppLayout>
      ),
      children: [{ path: '*', element: <NotFoundPage /> }],
    },
  ]);
}

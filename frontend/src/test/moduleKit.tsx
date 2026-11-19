import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi, type Mock } from 'vitest';
import type { UserProfile } from '../modules/core/api/account';
import { AuthContext } from '../modules/auth/hooks/useAuth';
import DialogHost from '../modules/core/components/dialog-host';
import { ToastProvider } from '../modules/core/contexts/toastContext';
import type { Organization } from '../modules/organization/api/organizationsApi';
import OrganizationContext, {
  type OrganizationContextInterface,
} from '../modules/organization/contexts/organizationContext';
import { Where } from './Where';

// Rendering the screens of SPHERE's modules (src/modules/*/pages) in a test: the session with a `fetchWithInterceptor` that
// answers from a table of routes, Helmet, the router, and the account's organizations.

export const ME: UserProfile = {
  id: '00000000-0000-4000-8000-000000000005',
  username: 'alex.rivera',
  email: 'alex.rivera@example.org',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-01-10T00:00:00Z',
  cas_verified: false,
  email_verified: false,
  institutional_email: false,
};

/** One answer of the fake gateway: a body (JSON) with a status, or a function of the request. */
export type Answer =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | ((request: { method: string; path: string; body: unknown }) => {
      status?: number;
      body?: unknown;
      headers?: Record<string, string>;
    });

/**
 * A `fetchWithInterceptor` that answers from `routes`, keyed `"METHOD /path"` (the query string included when the key has
 * one, ignored otherwise). An unknown request answers 404 `not_mocked`.
 */
export function fakeGateway(routes: Record<string, Answer>): Mock {
  return vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const [bare] = path.split('?');
    const answer = routes[`${method} ${path}`] ?? routes[`${method} ${bare}`];
    let body: unknown = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init.body) body = init.body;
    const reply =
      answer === undefined
        ? { status: 404, body: { code: 'not_mocked', detail: `${method} ${path}` } }
        : typeof answer === 'function'
          ? answer({ method, path, body })
          : answer;
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body ?? null), {
      status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
  });
}

/** An organization as the gateway's tree shows it. */
export function orgNode(slug: string, over: Partial<Organization> = {}): Organization {
  return {
    id: `org-${slug}`,
    slug,
    name: slug
      .split('-')
      .map(word => word[0].toUpperCase() + word.slice(1))
      .join(' '),
    parent_id: null,
    effective_role: 'OWNER',
    description: '',
    avatar: { url: null, kind: null, bg_color: null, fg_color: null },
    stats: { members: 2, sub_organizations: 0, compositions: 1, problems: 1, runs: 0, studies: 0 },
    role_source: null,
    children: [],
    created_at: '2026-03-03T00:00:00Z',
    ...over,
  };
}

export interface ModuleRenderOptions {
  /** The signed-in account; null for a visitor. */
  user?: UserProfile | null;
  /** The address the router starts at. */
  entry?: string;
  /** The route pattern the element answers, to read its parameters. */
  path?: string;
  /** Other routes, so a navigation lands somewhere a test can see. */
  routes?: Record<string, ReactNode>;
  gateway?: Mock;
  /** The account's organizations: a tree, flattened for `organizations`. */
  tree?: Organization[];
  organizations?: Partial<OrganizationContextInterface>;
}

const flatten = (orgs: Organization[]): Organization[] =>
  orgs.flatMap(org => [org, ...flatten(org.children ?? [])]);

/** Render a page of a module, signed in as {@link ME} unless `user` says otherwise. */
export function renderModule(element: ReactElement, options: ModuleRenderOptions = {}) {
  const user = options.user === undefined ? ME : options.user;
  const gateway = options.gateway ?? fakeGateway({});
  const tree = options.tree ?? [];
  const refresh = vi.fn(async () => {});
  const organizations: OrganizationContextInterface = {
    organizations: flatten(tree),
    tree,
    isLoading: false,
    error: null,
    page: 1,
    totalPages: 1,
    setPage: vi.fn(),
    refresh,
    ...options.organizations,
  };
  const auth = {
    user,
    loading: false,
    signIn: vi.fn(),
    register: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    resume: vi.fn(),
    isAdmin: user?.role === 'admin',
    fetchWithInterceptor: gateway as unknown as (
      path: string,
      init?: RequestInit
    ) => Promise<Response>,
  };
  const result = render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[options.entry ?? '/']}>
        <AuthContext.Provider value={auth}>
          <OrganizationContext.Provider value={organizations}>
            <ToastProvider>
              <Routes>
                <Route path={options.path ?? '*'} element={element} />
                {Object.entries(options.routes ?? {}).map(([path, routed]) => (
                  <Route key={path} path={path} element={routed} />
                ))}
              </Routes>
              <Where />
              <DialogHost />
            </ToastProvider>
          </OrganizationContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>
    </HelmetProvider>
  );
  return { ...result, gateway, auth, organizations };
}

/** The address the router is at (from the `Where` element). */
export function addressNow(): string {
  return document.querySelector('[data-testid="address"]')?.getAttribute('data-address') ?? '';
}

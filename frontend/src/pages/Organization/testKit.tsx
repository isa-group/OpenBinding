import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Outlet, parsePath, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UsageView, UserProfile } from '../../api/auth';
import type { Organization, OrganizationMember, Project } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { AuthContext } from '../../contexts/auth';
import { Where } from './Where';

/** Shared by the tests of the organization screens: accounts, organizations and a router with the workspace outlet. */
export const lucia: UserProfile = {
  id: 'user-lucia', username: 'lucia.vega', email: 'lucia@example.test', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-03-01T00:00:00Z',
};

export const iker: UserProfile = { ...lucia, id: 'user-iker', username: 'iker.mora', email: 'iker@example.test', role: 'admin', plan: 'LAB' };

export function org(slug: string, over: Partial<Organization> = {}): Organization {
  return {
    id: `org-${slug}`, slug, name: slug.toUpperCase(), parent_id: null, effective_role: 'OWNER', created_at: '2026-03-03T00:00:00Z',
    ...over,
  };
}

export function member(user: string, role: OrganizationMember['role'], over: Partial<OrganizationMember> = {}): OrganizationMember {
  return {
    id: `m-${user}`, organization_id: 'org-isa-demo', user_id: `user-${user}`, username: user, email: `${user}@example.test`, role, created_at: '2026-03-04T00:00:00Z',
    ...over,
  };
}

export function project(slug: string, over: Partial<Project> = {}): Project {
  return {
    id: `project-${slug}`, organization_id: 'org-isa-demo', slug, name: slug, description: '', visibility: 'private', created_by_id: lucia.id,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', ...over,
  };
}

/** The RESEARCH plan of pricing 0.2.0. */
export function researchUsage(): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: {
      maxProblems: null, maxRepositoryStorage: null, maxRunMinutes: 30, maxConcurrentRuns: 4, maxStudyCells: 5000,
      maxFederatedEngines: 3, maxApiKeys: 10,
    },
  };
}

export interface RenderOptions {
  /** The route pattern, as the registry has it. */
  path: string;
  /** The address to open. */
  url: string;
  organizations?: Organization[];
  user?: UserProfile;
  loading?: boolean;
  reload?: () => Promise<void>;
  state?: unknown;
}

/** The address the router is at (path and query), as `renderScreen` renders it. */
export const addressNow = (): string => document.querySelector('[data-testid="address"]')?.getAttribute('data-address') ?? '';

export function renderScreen(ui: ReactElement, options: RenderOptions) {
  const user = options.user ?? lucia;
  const organizations = options.organizations ?? [];
  const reload = options.reload ?? vi.fn().mockResolvedValue(undefined);
  const context: PlatformOutletContext = {
    organizations, projects: [], organization: organizations[0], project: undefined, loading: options.loading ?? false, reload,
  };
  const view = render(
    <MemoryRouter initialEntries={[{ ...parsePath(options.url), state: options.state }]}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path={options.path} element={ui} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Route>
        </Routes>
        <Where />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return { ...view, reload, context };
}

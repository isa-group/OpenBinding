import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UsageView, UserProfile } from '../../api/auth';
import type { Organization, OrganizationMember, Project } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { AuthContext } from '../../contexts/auth';

/** Shared by the tests of the organization screens: accounts, organizations and a router with the workspace outlet. */
export const lucia: UserProfile = {
  id: 'user-lucia', username: 'lucia.vega', email: 'lucia@example.test', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-03-01T00:00:00Z',
};

export const iker: UserProfile = { ...lucia, id: 'user-iker', username: 'iker.mora', email: 'iker@example.test', role: 'admin', plan: 'PRO' };

export function org(slug: string, over: Partial<Organization> = {}): Organization {
  return {
    id: `org-${slug}`, slug, name: slug.toUpperCase(), parent_id: null, billing_sponsor_user_id: lucia.id, effective_role: 'OWNER', created_at: '2026-03-03T00:00:00Z',
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

const tracked = (id: string, limit: number, used: number) => ({ limit_id: id, limit, used, remaining: Math.max(0, limit - used), unit: null, renews_at: null });

/** The RESEARCH plan of pricing 0.1.0 with some of the sponsor’s room used. */
export function researchUsage(): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: { organizations: 5, members: 15, projects: 50, privateProjects: 30, collections: 50, studies: 25, storageBytes: 5_368_709_120, studyRuns: 100, concurrentJobs: 3 },
    limits: {
      organizations: tracked('organizations', 5, 2),
      members: tracked('members', 15, 3),
      projects: tracked('projects', 50, 3),
      studyRuns: { ...tracked('studyRuns', 100, 18), renews_at: '2026-11-01T00:00:00Z' },
      concurrentJobs: tracked('concurrentJobs', 3, 1),
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

export function renderScreen(ui: ReactElement, options: RenderOptions) {
  const user = options.user ?? lucia;
  const organizations = options.organizations ?? [];
  const reload = options.reload ?? vi.fn().mockResolvedValue(undefined);
  const context: PlatformOutletContext = {
    organizations, projects: [], organization: organizations[0], project: undefined, loading: options.loading ?? false, reload,
  };
  const view = render(
    <MemoryRouter initialEntries={[{ pathname: options.url, state: options.state }]}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path={options.path} element={ui} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return { ...view, reload, context };
}

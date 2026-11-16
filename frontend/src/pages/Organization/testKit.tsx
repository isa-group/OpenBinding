import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Outlet, parsePath, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UsageView, UserProfile } from '../../api/auth';
import type { Organization, OrganizationMember } from '../../api/platform';
import type { PlatformOutletContext } from '../../routes/LegacyOrgOutlet';
import { AuthContext } from '../../modules/auth/hooks/useAuth';
import { lucia } from '../../features/workspace/testKit';
import { Where } from './Where';

/** Shared by the tests of the organization screens: members, the plan's usage and a router with the workspace outlet. */
export function member(
  user: string,
  role: OrganizationMember['role'],
  over: Partial<OrganizationMember> = {}
): OrganizationMember {
  return {
    id: `m-${user}`,
    organization_id: 'org-isa-demo',
    user_id: `user-${user}`,
    username: user,
    email: `${user}@example.test`,
    role,
    created_at: '2026-03-04T00:00:00Z',
    ...over,
  };
}

/** The RESEARCH plan of pricing 0.2.0. */
export function researchUsage(): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: {
      maxProblems: null,
      maxRepositoryStorage: null,
      maxRunMinutes: 30,
      maxConcurrentRuns: 4,
      maxStudyCells: 5000,
      maxFederatedEngines: 3,
      maxApiKeys: 10,
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
export const addressNow = (): string =>
  document.querySelector('[data-testid="address"]')?.getAttribute('data-address') ?? '';

export function renderScreen(ui: ReactElement, options: RenderOptions) {
  const user = options.user ?? lucia;
  const organizations = options.organizations ?? [];
  const reload = options.reload ?? vi.fn().mockResolvedValue(undefined);
  const context: PlatformOutletContext = {
    organizations,
    organization: organizations[0],
    loading: options.loading ?? false,
    reload,
  };
  const view = render(
    <MemoryRouter initialEntries={[{ ...parsePath(options.url), state: options.state }]}>
      <AuthContext.Provider
        value={{
          user,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          isAdmin: user.role === 'admin',
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path={options.path} element={ui} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Route>
        </Routes>
        <Where />
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { ...view, reload, context };
}

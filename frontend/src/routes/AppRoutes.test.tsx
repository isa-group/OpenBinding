import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { AuthContext } from '../contexts/auth';
import { AppRoutes } from './index';
import { routeDefinitions } from './registry';

vi.mock('../api/platform', async () => ({
  ...await vi.importActual<typeof import('../api/platform')>('../api/platform'),
  platformApi: {
    organizations: vi.fn().mockResolvedValue([]),
    projects: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../api/client', async () => ({
  ...await vi.importActual<typeof import('../api/client')>('../api/client'),
  apiClient: { listNotifications: vi.fn().mockResolvedValue([]) },
}));

// Screens that call the API on mount are replaced; these tests are about routing.
vi.mock('../pages/Account/Account', async () => {
  const { createElement } = await import('react');
  return { Account: () => createElement('h1', null, 'Account screen') };
});
vi.mock('../pages/Auth/Login', async () => {
  const { createElement } = await import('react');
  return {
    Login: () => createElement('h1', null, 'Sign in screen'),
    CasCallback: () => null,
    PasswordResetRequestPage: () => null,
    PasswordResetCompletePage: () => null,
  };
});

const person: UserProfile = {
  id: 'user-1', username: 'alice', email: 'alice@example.com', role: 'user', plan: 'FREE',
  is_active: true, created_at: '2026-01-01T00:00:00Z',
};

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderAt(path: string, user: UserProfile | null = person, loading = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user, loading, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user?.role === 'admin',
        }}
      >
        <AppRoutes />
        <Location />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const pendingHeading = () => screen.findByRole('heading', { name: 'This screen is being rebuilt' });

// Which screens are pending shrinks as the product is built, so the examples come from the registry.
// When no suitable pending screen is left, the matching test is skipped instead of failing.
const firstPending = (layout: 'public' | 'app', prefix = '') =>
  routeDefinitions.find((definition) => (
    definition.status === 'pending' && definition.layout === layout
    && !definition.path.includes(':') && definition.path.startsWith(prefix)
  ));
const pendingPublic = firstPending('public');
const pendingApp = routeDefinitions.find((definition) => (
  definition.status === 'pending' && definition.layout === 'app' && !definition.path.includes(':')
  && !definition.path.startsWith('/app/admin')
));
const pendingAdmin = firstPending('app', '/app/admin/');

describe('AppRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it.skipIf(!pendingPublic)('renders a pending public screen inside the public layout (skipped when none is pending)', async () => {
    const target = pendingPublic!;
    renderAt(target.path, null);

    expect(await pendingHeading()).toBeInTheDocument();
    expect(document.querySelector(`[data-screen-id="${target.id}"]`)).toHaveTextContent(target.path);
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Footer navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it.skipIf(!pendingApp)('renders a pending app screen inside the application layout with its id and route (skipped when none is pending)', async () => {
    const target = pendingApp!;
    renderAt(target.path);

    expect(await pendingHeading()).toBeInTheDocument();
    const screenInfo = document.querySelector(`[data-screen-id="${target.id}"]`);
    expect(screenInfo).toHaveTextContent(target.id);
    expect(screenInfo).toHaveTextContent(target.path);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Footer navigation' })).toBeInTheDocument();
  });

  it('renders a live screen from its new route', async () => {
    renderAt('/app/account');
    expect(await screen.findByRole('heading', { name: 'Account screen' })).toBeInTheDocument();
  });

  it('sends visitors without a session from any app route to sign in', async () => {
    renderAt('/app/isa-demo/atlas/jobs', null);

    expect(await screen.findByRole('heading', { name: 'Sign in screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('waits for the stored session before deciding', () => {
    renderAt('/app', null, true);

    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/app');
  });

  it('keeps administrators-only screens away from other accounts', async () => {
    renderAt('/app/admin/users');

    expect(await screen.findByRole('heading', { name: 'Account screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/app/account');
  });

  it.skipIf(!pendingAdmin)('lets administrators reach them (skipped when no admin screen is pending)', async () => {
    const target = pendingAdmin!;
    renderAt(target.path, { ...person, role: 'admin' });

    expect(await pendingHeading()).toBeInTheDocument();
    expect(document.querySelector(`[data-screen-id="${target.id}"]`)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(target.path);
  });

  it('shows a not-found page for addresses that no longer exist', async () => {
    renderAt('/playground', null);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });
});

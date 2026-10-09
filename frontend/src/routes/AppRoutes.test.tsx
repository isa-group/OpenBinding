import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { AuthContext } from '../contexts/auth';
import { AppRoutes } from './index';

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

describe('AppRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a pending public screen inside the public layout', async () => {
    renderAt('/status', null);

    expect(await pendingHeading()).toBeInTheDocument();
    expect(document.querySelector('[data-screen-id="pub-status"]')).toHaveTextContent('/status');
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Footer navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('renders a pending app screen inside the application layout with its id and route', async () => {
    renderAt('/app/account/usage');

    expect(await pendingHeading()).toBeInTheDocument();
    const screenInfo = document.querySelector('[data-screen-id="acct-usage"]');
    expect(screenInfo).toHaveTextContent('acct-usage');
    expect(screenInfo).toHaveTextContent('/app/account/usage');
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

  it('lets administrators reach them', async () => {
    renderAt('/app/admin/users', { ...person, role: 'admin' });

    expect(await pendingHeading()).toBeInTheDocument();
    expect(document.querySelector('[data-screen-id="admin-users"]')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/app/admin/users');
  });

  it('shows a not-found page for addresses that no longer exist', async () => {
    renderAt('/playground', null);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });
});

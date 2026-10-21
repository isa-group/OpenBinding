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
const screens = vi.hoisted(() => ({ accountThrows: false }));
vi.mock('../pages/Account/Account', async () => {
  const { createElement } = await import('react');
  return {
    Account: () => {
      if (screens.accountThrows) throw new Error('screen exploded');
      return createElement('h1', null, 'Account screen');
    },
  };
});
vi.mock('../pages/Auth/Login', async () => {
  const { createElement } = await import('react');
  return { Login: () => createElement('h1', null, 'Sign in screen') };
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

describe('AppRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    screens.accountThrows = false;
  });

  it('renders a live screen from its route, inside the application layout', async () => {
    renderAt('/app/account');
    expect(await screen.findByRole('heading', { name: 'Account screen' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Footer navigation' })).toBeInTheDocument();
  });

  it('keeps a screen that fails to render from blanking the layout around it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    screens.accountThrows = true;
    renderAt('/app/account');

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    consoleError.mockRestore();
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

  it('serves the invitation link inside the public layout when there is no session', async () => {
    renderAt('/invitations/accept?token=abc', null);

    expect(await screen.findByRole('heading', { name: 'Log in to accept' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('/invitations/accept');
  });

  it('serves the invitation link inside the application layout when signed in', async () => {
    renderAt('/invitations/accept');

    expect(await screen.findByRole('heading', { name: 'Paste your invitation' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).toBeNull();
  });

  it('shows the state gallery inside the application layout, and sends visitors to sign in', async () => {
    const view = renderAt('/app/system/states');
    expect(await screen.findByRole('heading', { level: 1, name: 'States and recoverable errors' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    view.unmount();

    renderAt('/app/system/states', null);
    expect(await screen.findByRole('heading', { name: 'Sign in screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('shows a not-found page for addresses that no longer exist', async () => {
    renderAt('/playground', null);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });
});

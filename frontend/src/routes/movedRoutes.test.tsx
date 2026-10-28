import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { AuthContext } from '../contexts/auth';
import { AppRoutes } from './index';
import { moved } from './moved';

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

// Only the location and the headings are asserted, so the screens are replaced.
vi.mock('../pages/Auth/Login', async () => {
  const { createElement } = await import('react');
  return { Login: () => createElement('h1', null, 'Sign in screen') };
});
vi.mock('../pages/About/About', async () => {
  const { createElement } = await import('react');
  return { About: () => createElement('h1', null, 'About screen') };
});
vi.mock('../pages/Organization/OrgOverview', async () => {
  const { createElement } = await import('react');
  return { OrgOverview: () => createElement('h1', null, 'Organization page screen') };
});

// A synthetic table: the registry's own is empty until a navigation change moves an address.
const TABLE = [
  moved('t-public', '/old-about', '/about'),
  moved('t-app', '/app/:org/:project/old-home', '/app/:org'),
  moved('t-dropped', '/app/:org/:project/old-bare', '/app/:org', { keepQuery: false }),
  moved('t-permanent', '/app/:org/:project/old-kept', '/app/:org', { permanent: true }),
];

const person: UserProfile = {
  id: 'user-1', username: 'alice', email: 'alice@example.com', role: 'user', plan: 'FREE',
  is_active: true, created_at: '2026-01-01T00:00:00Z',
};

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

function renderAt(entries: string[], user: UserProfile | null = person) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <AuthContext.Provider
        value={{
          user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false,
        }}
      >
        <AppRoutes moved={TABLE} />
        <Location />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('moved addresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('redirects a public address while signed out, inside the public layout, with the query', async () => {
    renderAt(['/old-about?ref=mail'], null);

    expect(await screen.findByRole('heading', { name: 'About screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/about?ref=mail');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('redirects an application address inside the application layout, carrying the params and the query', async () => {
    renderAt(['/app/acme/atlas/old-home?tab=files&x=1']);

    expect(await screen.findByRole('heading', { name: 'Organization page screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/app/acme?tab=files&x=1');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('drops the query when the entry says so', async () => {
    renderAt(['/app/acme/atlas/old-bare?tab=files']);

    expect(await screen.findByRole('heading', { name: 'Organization page screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/acme$/);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('redirects a permanent entry like any other: the flag is only for the link check', async () => {
    renderAt(['/app/acme/atlas/old-kept']);

    expect(await screen.findByRole('heading', { name: 'Organization page screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/acme$/);
    expect(TABLE[3].permanent).toBe(true);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('asks a visitor without a session to sign in before an application address moves', async () => {
    renderAt(['/app/acme/atlas/old-home'], null);

    expect(await screen.findByRole('heading', { name: 'Sign in screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  // [utest->req~frontend-nav-redirects~1]
  it('replaces the old address in the history, so Back does not return to it', async () => {
    renderAt(['/start', '/old-about']);

    expect(await screen.findByRole('heading', { name: 'About screen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/start');
  });

  // [utest->req~frontend-nav-redirects~1]
  it('serves the not-found page for the old address when the table is empty', async () => {
    render(
      <MemoryRouter initialEntries={['/old-about']}>
        <AuthContext.Provider
          value={{
            user: null, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false,
          }}
        >
          <AppRoutes moved={[]} />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

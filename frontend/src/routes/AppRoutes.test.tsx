import { render, screen, waitFor } from '@testing-library/react';
import { matchRoutes, MemoryRouter, useLocation } from 'react-router-dom';
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

// These tests are about routing: every screen of the registry is replaced by a stub that names itself, so no page file is needed.
// `explode` names the one that fails to render.
const screens = vi.hoisted(() => ({ explode: '' }));
vi.mock('./registry', async () => {
  const actual = await vi.importActual<typeof import('./registry')>('./registry');
  const { createElement } = await import('react');
  const Stub = ({ id }: { id: string }) => {
    if (screens.explode === id) throw new Error('screen exploded');
    return createElement('h1', { 'data-screen': id }, `Screen ${id}`);
  };
  return {
    ...actual,
    routeDefinitions: actual.routeDefinitions.map((definition) => ({ ...definition, element: createElement(Stub, { id: definition.id }) })),
  };
});

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
/** The screen an address resolves to, by the registry's own paths. */
const screenAt = (address: string) => matchRoutes(config, address)?.at(-1)?.route.id ?? null;
/** The screen on show, read from its stub. */
const shown = () => document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null;
const showing = (id: string | null | undefined) => waitFor(() => expect(shown()).toBe(id ?? null));

/** An address the path leads to: the example organization and project, an optional segment dropped, any other parameter filled. */
const exampleOf = (path: string) => path
  .replace(/\/:[A-Za-z]+\?/g, '')
  .replace(':org', 'isa-demo')
  .replace(':project', 'atlas')
  .replace(/:[A-Za-z]+/g, 'sample') || '/';

// Screens picked by their shape, so the tests name no screen of any area.
const fixedApp = routeDefinitions.find((definition) => definition.layout === 'app' && !definition.requireAdmin && definition.path !== '/app' && !definition.path.includes(':'));
const inProject = routeDefinitions.find((definition) => definition.layout === 'app' && definition.path.includes(':project'));
const adminOnly = routeDefinitions.find((definition) => definition.requireAdmin && !definition.path.includes(':'));
const invitation = routeDefinitions.find((definition) => definition.sessionHeader);
if (!fixedApp || !inProject || !adminOnly || !invitation) throw new Error('the registry lacks a screen of a shape these tests need');

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
    screens.explode = '';
  });

  it('renders a live screen from its route, inside the application layout', async () => {
    renderAt(exampleOf(fixedApp.path));
    await showing(fixedApp.id);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Footer navigation' })).toBeInTheDocument();
  });

  it('keeps a screen that fails to render from blanking the layout around it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    screens.explode = fixedApp.id;
    renderAt(exampleOf(fixedApp.path));

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it.each([
    ['without parameters', () => exampleOf(fixedApp.path)],
    ['in a project', () => exampleOf(inProject.path)],
  ])('sends visitors without a session from any app route (%s) to sign in', async (_name, address) => {
    renderAt(address(), null);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    await showing(screenAt('/login'));
  });

  it('waits for the stored session before deciding', () => {
    renderAt('/app', null, true);

    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/app');
  });

  it('keeps administrators-only screens away from other accounts', async () => {
    renderAt(exampleOf(adminOnly.path));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/app/account'));
    await showing(screenAt('/app/account'));
  });

  it('serves the invitation link inside the public layout when there is no session', async () => {
    renderAt(exampleOf(invitation.path), null);

    await showing(invitation.id);
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(exampleOf(invitation.path));
  });

  it('serves the invitation link inside the application layout when signed in', async () => {
    renderAt(exampleOf(invitation.path));

    await showing(invitation.id);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).toBeNull();
  });

  it('shows a not-found page for addresses that no longer exist', async () => {
    renderAt('/zz-no-such-page', null);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });
});

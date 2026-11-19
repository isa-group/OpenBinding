import { render, screen, waitFor } from '@testing-library/react';
import { matchRoutes, MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../modules/core/api/account';
import { AuthContext } from '../modules/auth/hooks/useAuth';
import { NotificationsProvider } from '../modules/notification/contexts/notificationsProvider';
import { createElement } from 'react';
import Router, { screens as routeDefinitions } from './router';

// These tests are about routing: every screen of the table is replaced by a stub that names itself, so no page file is needed.
// `explode` names the one that fails to render.
const screens = { explode: '' };
const Stub = ({ id }: { id: string }) => {
  if (screens.explode === id) throw new Error('screen exploded');
  return createElement('h1', { 'data-screen': id }, `Screen ${id}`);
};
const table = routeDefinitions.map(definition => ({
  ...definition,
  element: <Stub id={definition.id} />,
}));

const config = routeDefinitions.map(definition => ({ id: definition.id, path: definition.path }));
/** The screen an address resolves to, by the registry's own paths. */
const screenAt = (address: string) => matchRoutes(config, address)?.at(-1)?.route.id ?? null;
/** The screen on show, read from its stub. */
const shown = () => document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null;
const showing = (id: string | null | undefined) => waitFor(() => expect(shown()).toBe(id ?? null));

/** An address the path leads to: the example organization, an optional segment dropped, any other parameter filled. */
const exampleOf = (path: string) =>
  path
    .replace(/\/:[A-Za-z]+\?/g, '')
    .replace(':org', 'isa-demo')
    .replace(/:[A-Za-z]+/g, 'sample') || '/';

// Screens picked by their shape, so the tests name no screen of any area.
const fixedApp = routeDefinitions.find(
  definition =>
    definition.layout === 'protected' &&
    !definition.requireAdmin &&
    definition.path !== '/app' &&
    !definition.path.includes(':')
);
const inOrganization = routeDefinitions.find(
  definition => definition.layout === 'protected' && definition.path.includes(':org')
);
const adminOnly = routeDefinitions.find(definition => definition.requireAdmin);
const adminScreens = routeDefinitions.filter(definition => definition.requireAdmin);
const invitation = routeDefinitions.find(definition => definition.layout === 'session');
if (!fixedApp || !inOrganization || !adminOnly || !invitation)
  throw new Error('the registry lacks a screen of a shape these tests need');

const person: UserProfile = {
  id: 'user-1',
  username: 'alice',
  email: 'alice@example.com',
  role: 'user',
  plan: 'FREE',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  cas_verified: false,
  email_verified: false,
  institutional_email: false,
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
          user,
          loading,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          resume: vi.fn(),
          isAdmin: user?.role === 'admin',
          fetchWithInterceptor: vi.fn(async () => new Response('[]', { status: 200 })),
        }}
      >
        <NotificationsProvider>
          <Router table={table} />
          <Location />
        </NotificationsProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('Router', () => {
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

    expect(
      await screen.findByRole('heading', { name: 'Something went wrong' })
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it.each([
    ['without parameters', () => exampleOf(fixedApp.path)],
    ['in an organization', () => exampleOf(inOrganization.path)],
  ])(
    'sends visitors without a session from any app route (%s) to sign in',
    async (_name, address) => {
      renderAt(address(), null);

      await waitFor(() =>
        expect(screen.getByTestId('location')).toHaveTextContent('/authentication')
      );
      await showing(screenAt('/authentication'));
    }
  );

  it('waits for the stored session before deciding', () => {
    renderAt('/me/orgs', null, true);

    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/me/orgs');
  });

  it('shows other accounts the in-place 404 on administrators-only screens, without moving them', async () => {
    renderAt(exampleOf(adminOnly.path));

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(exampleOf(adminOnly.path));
  });

  it.each(adminScreens.map(definition => [definition.id, exampleOf(definition.path)]))(
    'reads administration (%s, %s) as a page that does not exist to an account that is not an administrator',
    async (_id, address) => {
      renderAt(address);
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
      expect(shown()).toBeNull();
    }
  );

  it('serves a public page of the session inside the public layout when there is no session', async () => {
    renderAt(exampleOf(invitation.path), null);

    await showing(invitation.id);
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(exampleOf(invitation.path));
  });

  it('serves a public page of the session inside the application layout when signed in', async () => {
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

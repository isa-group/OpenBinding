import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { matchRoutes, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { AuthContext } from '../contexts/auth';
import { AppRoutes } from './index';
import { moved } from './moved';
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
vi.mock('./registry', async () => {
  const actual = await vi.importActual<typeof import('./registry')>('./registry');
  const { createElement } = await import('react');
  return {
    ...actual,
    routeDefinitions: actual.routeDefinitions.map((definition) => ({
      ...definition,
      element: createElement('h1', { 'data-screen': definition.id }, `Screen ${definition.id}`),
    })),
  };
});

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
/** The screen an address resolves to, by the registry's own paths. */
const screenAt = (address: string) => matchRoutes(config, address.split(/[?#]/)[0])?.at(-1)?.route.id ?? null;
/** The screen on show, read from its stub. */
const shown = () => document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null;
const showing = (id: string | null | undefined) => waitFor(() => expect(shown()).toBe(id ?? null));

// Screens picked by their shape, so the tests name no screen of any area.
const publicScreen = routeDefinitions.find((definition) => definition.layout === 'public' && !definition.sessionHeader && definition.path !== '/' && !definition.path.includes(':'));
const appScreen = routeDefinitions.find((definition) => definition.layout === 'app' && !definition.requireAdmin && definition.path !== '/app' && !definition.path.includes(':'));
if (!publicScreen || !appScreen) throw new Error('the registry has no fixed public screen or no fixed application screen');
const PUBLIC = publicScreen.path;

// A synthetic table: the registry's own may be empty until a navigation change moves an address.
const TABLE = [
  moved('t-public', '/old-about', PUBLIC),
  moved('t-app', '/app/:org/:project/old-home', '/app/:org'),
  moved('t-dropped', '/app/:org/:project/old-bare', '/app/:org', { keepQuery: false }),
  moved('t-permanent', '/app/:org/:project/old-kept', '/app/:org', { permanent: true }),
  // An application address whose target is public, like the gateway's `/app/verifier?digest=…`.
  moved('t-to-public', '/app/old', '/public-target', { permanent: true }),
  moved('t-own-hash', '/old-hash', `${PUBLIC}#own`),
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
      <output data-testid="hash">{location.hash}</output>
      <output data-testid="from">{(location.state as { from?: string } | null)?.from ?? ''}</output>
      <button type="button" onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

function renderAt(entries: string[], user: UserProfile | null = person, table = TABLE) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <AuthContext.Provider
        value={{
          user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false,
        }}
      >
        <AppRoutes moved={table} />
        <Location />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('location').textContent;

describe('moved addresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('redirects a public address while signed out, inside the public layout, with the query', async () => {
    renderAt(['/old-about?ref=mail'], null);

    await waitFor(() => expect(where()).toBe(`${PUBLIC}?ref=mail`));
    await showing(publicScreen.id);
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('redirects an application address inside the application layout, carrying the params and the query', async () => {
    renderAt(['/app/acme/atlas/old-home?tab=files&x=1']);

    await waitFor(() => expect(where()).toBe('/app/acme?tab=files&x=1'));
    await showing(screenAt('/app/acme'));
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('drops the query when the entry says so', async () => {
    renderAt(['/app/acme/atlas/old-bare?tab=files']);

    await waitFor(() => expect(where()).toBe('/app/acme'));
    await showing(screenAt('/app/acme'));
  });

  // [utest->req~frontend-nav-redirects~1]
  it('redirects a permanent entry like any other: the flag is only for the link check', async () => {
    renderAt(['/app/acme/atlas/old-kept']);

    await waitFor(() => expect(where()).toBe('/app/acme'));
    await showing(screenAt('/app/acme'));
    expect(TABLE[3].permanent).toBe(true);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('asks a visitor without a session to sign in before an application address moves, remembering the target', async () => {
    renderAt(['/app/acme/atlas/old-home?x=1'], null);

    await waitFor(() => expect(where()).toBe('/login'));
    await showing(screenAt('/login'));
    expect(screen.getByTestId('from').textContent).toBe('/app/acme?x=1');
  });

  // [utest->req~frontend-nav-redirects~1]
  it('replaces the old address in the history, so Back does not return to it', async () => {
    renderAt(['/start', '/old-about']);

    await waitFor(() => expect(where()).toBe(PUBLIC));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(where()).toBe('/start');
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

describe('the hash of a moved address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [utest->req~frontend-nav-redirects~1]
  it.each([
    ['/old-about?ref=mail#top', null, `${PUBLIC}?ref=mail`, '#top'],
    ['/old-about#top', null, PUBLIC, '#top'],
    ['/old-about', null, PUBLIC, ''],
    ['/app/acme/atlas/old-home?x=1#latest', person, '/app/acme?x=1', '#latest'],
    // An entry that drops the query drops the hash with it (design.md section 3).
    ['/app/acme/atlas/old-bare?x=1#latest', person, '/app/acme', ''],
    ['/old-hash#top', null, PUBLIC, '#own'],
  ] as const)('carries it to the target: %s', async (old, user, expected, hash) => {
    renderAt([old], user);

    await waitFor(() => expect(where()).toBe(expected));
    expect(screen.getByTestId('hash').textContent).toBe(hash);
  });
});

describe('moved addresses without a session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [utest->req~frontend-nav-redirects~1]
  it.each([
    // [old address, where the visitor ends, the hash there, the state.from there]
    ['/app/old?digest=D#h', '/public-target?digest=D', '#h', ''],
    ['/old-about?ref=mail#top', `${PUBLIC}?ref=mail`, '#top', ''],
    ['/old-hash', PUBLIC, '#own', ''],
    ['/app/acme/atlas/old-home?x=1#top', '/login', '', '/app/acme?x=1'],
    ['/app/acme/atlas/old-kept', '/login', '', '/app/acme'],
  ])('sends %s to %s', async (old, expected, hash, from) => {
    renderAt([old], null);

    await waitFor(() => expect(where()).toBe(expected));
    expect(screen.getByTestId('hash').textContent).toBe(hash);
    expect(screen.getByTestId('from').textContent).toBe(from);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('sends an old application address whose target is public to the target, never to /login first', async () => {
    const seen: string[] = [];
    function Spy() {
      const here = useLocation();
      seen.push(`${here.pathname}${here.search}${here.hash}`);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/app/old?digest=D#h']}>
        <AuthContext.Provider
          value={{
            user: null, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false,
          }}
        >
          <AppRoutes moved={TABLE} />
          <Spy />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(seen.at(-1)).toBe('/public-target?digest=D#h'));
    expect(seen.some((entry) => entry.startsWith('/login'))).toBe(false);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('ends at /login when the target of the moved address is an application screen', async () => {
    renderAt(['/app/acme/atlas/old-home'], null);

    await waitFor(() => expect(where()).toBe('/login'));
    await showing(screenAt('/login'));
  });
});

describe('the rank of a moved address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [utest->req~frontend-nav-redirects~1]
  it('lets a screen win a tie of rank over a moved entry, in either layout', async () => {
    const table = [moved('t-tie-app', appScreen.path, PUBLIC), moved('t-tie-public', PUBLIC, appScreen.path)];

    const inApp = renderAt([appScreen.path], person, table);
    await showing(appScreen.id);
    expect(where()).toBe(appScreen.path);
    inApp.unmount();

    renderAt([PUBLIC], null, table);
    await showing(publicScreen.id);
    expect(where()).toBe(PUBLIC);
  });

  // [utest->req~frontend-nav-redirects~1]
  it('lets a static moved path beat a screen with :param segments', async () => {
    const address = '/app/zz-old-org/zz-old-thing';
    expect(screenAt(address)).not.toBeNull();

    renderAt([address], person, [moved('t-static', address, PUBLIC)]);

    await waitFor(() => expect(where()).toBe(PUBLIC));
    await showing(publicScreen.id);
  });
});

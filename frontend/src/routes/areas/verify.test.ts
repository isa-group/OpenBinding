import { render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { matchRoutes, MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { AuthContext } from '../../contexts/auth';
import { AppRoutes } from '../index';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: {
    organizations: vi.fn().mockResolvedValue([]),
    projects: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: { listNotifications: vi.fn().mockResolvedValue([]) },
}));

// The router tests below are about addresses: every screen is replaced by a stub that names itself.
vi.mock('../registry', async () => {
  const actual = await vi.importActual<typeof import('../registry')>('../registry');
  const { createElement } = await import('react');
  return {
    ...actual,
    routeDefinitions: actual.routeDefinitions.map((definition) => ({
      ...definition,
      element: createElement('h1', { 'data-screen': definition.id }, `Screen ${definition.id}`),
    })),
  };
});

// One pair per line: screenBudget.test.ts counts them.
const SCREENS: Array<[string, string]> = [
  ['verify', '/verify/:kind?/:digest?'],
];

/** `D` of the scenarios: `sha256-` followed by 64 times the digit 1. */
const D = `sha256-${'1'.repeat(64)}`;

const KINDS = [
  'case-revision', 'resource-revision', 'collection-revision', 'report', 'artifact',
  'engine', 'dialect', 'registered-resource', 'instance-snapshot', 'binding-ir',
];

const screens = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const moves = movedRoutes.map((route) => ({ id: route.id, path: route.path }));
const screenAt = (address: string) => matchRoutes(screens, address)?.at(-1)?.route.id ?? null;
const movedAt = (address: string) => matchRoutes(moves, address)?.at(-1)?.route.id ?? null;
const entry = (path: string) => movedRoutes.find((route) => route.path === path);

describe('area verify', () => {
  // [utest->req~frontend-nav-route-areas~1]
  // [utest->req~frontend-nav-verify-page~1]
  it('has one screen, verify, in the public layout and with no sign-in requirement', () => {
    expect(routesByArea.verify.map((definition) => [definition.id, definition.path])).toEqual(SCREENS);
    const [definition] = routesByArea.verify;
    expect(definition.layout).toBe('public');
    expect(definition.requireAuth).toBe(false);
    expect(definition.requireAdmin).toBe(false);
  });

  // [utest->req~frontend-nav-verify-page~1]
  it('declares neither pub-resolve nor verifier', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('pub-resolve');
    expect(ids).not.toContain('verifier');
    expect(ids.filter((id) => id === 'verify')).toHaveLength(1);
  });

  describe('address resolution', () => {
    // [utest->req~frontend-nav-verify-page~1]
    it.each([
      ['/verify', 'verify'],
      ['/verify/report', 'verify'],
      ['/verify/report/sha256-abc', 'verify'],
      ['/verify/case-revision/sha256-abc', 'verify'],
      ['/resolve/report/sha256-abc', null],
      ['/verify/report/sha256-abc/extra', null],
    ])('%s is served by the screen %s', (address, id) => {
      expect(screenAt(address)).toBe(id);
    });

    // [utest->req~frontend-nav-verify-permanent-links~1]
    it.each([
      ['/resolve/report/sha256-abc', 'verify-resolve'],
      ['/app/verifier', 'verify-verifier'],
    ])('%s is answered by the moved entry %s', (address, id) => {
      expect(movedAt(address)).toBe(id);
    });
  });
});

describe('the permanent links of the Verify page', () => {
  // [utest->req~frontend-nav-verify-permanent-links~1]
  it('keeps the entries /resolve/:kind/:digest and /app/verifier, both marked permanent', () => {
    const resolve = entry('/resolve/:kind/:digest');
    const verifier = entry('/app/verifier');
    expect(resolve, 'the /resolve/:kind/:digest entry is missing').toBeDefined();
    expect(verifier, 'the /app/verifier entry is missing').toBeDefined();
    expect(resolve?.permanent).toBe(true);
    expect(verifier?.permanent).toBe(true);
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it.each(KINDS)('moves /resolve/%s/D to /verify/%s/D, and the target is the verify screen', (kind) => {
    const target = entry('/resolve/:kind/:digest')?.target(new URLSearchParams(''), { kind, digest: D });
    expect(target).toBe(`/verify/${kind}/${D}`);
    expect(screenAt(target ?? '')).toBe('verify');
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it('keeps the query of the old address', () => {
    expect(entry('/resolve/:kind/:digest')?.target(new URLSearchParams('page=2'), { kind: 'report', digest: D })).toBe(`/verify/report/${D}?page=2`);
    expect(entry('/app/verifier')?.target(new URLSearchParams(`digest=${D}`), {})).toBe(`/verify?digest=${D}`);
    expect(entry('/app/verifier')?.target(new URLSearchParams(''), {})).toBe('/verify');
  });
});

const person: UserProfile = {
  id: 'user-1', username: 'alice', email: 'alice@example.com', role: 'user', plan: 'FREE',
  is_active: true, created_at: '2026-01-01T00:00:00Z',
};

const seen: string[] = [];

function Spy() {
  const here = useLocation();
  seen.push(`${here.pathname}${here.search}${here.hash}`);
  return null;
}

function open(address: string, user: UserProfile | null) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [address] },
      createElement(
        AuthContext.Provider,
        { value: { user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false } },
        createElement(AppRoutes),
        createElement(Spy),
      ),
    ),
  );
}

const shown = () => document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null;

describe('opening a permanent link', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it.each(KINDS)('lands on /verify/%s/D without a session, and never on /login', async (kind) => {
    open(`/resolve/${kind}/${D}`, null);

    await waitFor(() => expect(seen.at(-1)).toBe(`/verify/${kind}/${D}`));
    await waitFor(() => expect(shown()).toBe('verify'));
    expect(seen.some((entryOfHistory) => entryOfHistory.startsWith('/login'))).toBe(false);
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it.each(KINDS)('lands on /verify/%s/D signed in', async (kind) => {
    open(`/resolve/${kind}/${D}`, person);

    await waitFor(() => expect(seen.at(-1)).toBe(`/verify/${kind}/${D}`));
    await waitFor(() => expect(shown()).toBe('verify'));
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it('keeps the query and the hash', async () => {
    open(`/resolve/report/${D}?page=2#locations`, person);

    await waitFor(() => expect(seen.at(-1)).toBe(`/verify/report/${D}?page=2#locations`));
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it('sends the gateway citation link /app/verifier?digest=D to /verify?digest=D without a session, never through /login', async () => {
    open(`/app/verifier?digest=${D}`, null);

    await waitFor(() => expect(seen.at(-1)).toBe(`/verify?digest=${D}`));
    await waitFor(() => expect(shown()).toBe('verify'));
    expect(seen.some((entryOfHistory) => entryOfHistory.startsWith('/login'))).toBe(false);
    expect(screen.getByText('Screen verify')).toBeInTheDocument();
  });

  // [utest->req~frontend-nav-verify-permanent-links~1]
  it('sends /app/verifier?digest=D to /verify?digest=D signed in', async () => {
    open(`/app/verifier?digest=${D}#top`, person);

    await waitFor(() => expect(seen.at(-1)).toBe(`/verify?digest=${D}#top`));
  });
});

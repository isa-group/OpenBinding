import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { matchRoutes, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { AuthContext } from '../contexts/auth';
import { AppRoutes } from './index';
import { routeDefinitions } from './registry';
import { RETIRED_ROUTES, type RetiredRoute } from './retiredRoutes';

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
vi.mock('../pages/Account/Account', async () => {
  const { createElement } = await import('react');
  return { Account: () => createElement('h1', null, 'Account screen') };
});
vi.mock('../pages/Auth/Login', async () => {
  const { createElement } = await import('react');
  return { Login: () => createElement('h1', null, 'Sign in screen') };
});
vi.mock('../pages/Organization/OrgOverview', async () => {
  const { createElement } = await import('react');
  return { OrgOverview: () => createElement('h1', null, 'Organization page screen') };
});
vi.mock('../pages/Jobs/JobHistory', async () => {
  const { createElement } = await import('react');
  return { JobHistory: () => createElement('h1', null, 'Job history screen') };
});
vi.mock('../pages/Reports/ProjPublications', async () => {
  const { createElement } = await import('react');
  return { ProjPublications: () => createElement('h1', null, 'Publications screen') };
});

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
      <output data-testid="from">{(location.state as { from?: string } | null)?.from ?? ''}</output>
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
        <AppRoutes />
        <Location />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

type Params = Readonly<Partial<Record<string, string>>>;

/** Slice 2 gives `target` the route parameters as a second argument; this calls it either way, so the file compiles before and after. */
function targetOf(route: RetiredRoute, query: string, params: Params = {}): string {
  return (route.target as unknown as (query: URLSearchParams, params: Params) => string)(new URLSearchParams(query), params);
}

/** Realistic values of the parameters of `:org`, `:project` and `:report`, each needing the encoding of a path segment. */
const PARAMS: Params = { org: 'a b', project: 'p/q', report: 'r#1' };

describe('the table of retired addresses', () => {
  // [utest->req~frontend-retire-redirect-decision-space~1]
  it.each(RETIRED_ROUTES.filter((route) => route.slice === 1))('follows one rule for $path', (route) => {
    const to = (query: string) => targetOf(route, query);
    const study = 'org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds';

    expect(to(`${study}&run=run-1&cell=cell-3`)).toBe('/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds/runs/run-1');
    expect(to(study)).toBe('/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds');
    expect(to('org=isa-demo&project=qos-benchmarks&run=run-1')).toBe('/app/jobs');
    expect(to('job=job-done-1&job=job-done-3')).toBe('/app/jobs');
    expect(to('report=isa-demo%2Fqos-benchmarks%2Fdecision-choice')).toBe('/app/jobs');
    expect(to('')).toBe('/app/jobs');
    expect(to('org=isa-demo&project=qos-benchmarks&study=&run=run-1')).toBe('/app/jobs');
    expect(to('org=isa-demo&project=qos-benchmarks&study=seeds%2F2026&study=other')).toBe('/app/isa-demo/qos-benchmarks/studies/seeds%2F2026');
  });

  // [utest->req~frontend-retire-redirect-generic~1]
  it('leads every target to the routed screen it names and is not itself a route', () => {
    // The screen each query leads to for the decision-space entries (slice 1); the report entries (slice 2) always lead to the publications.
    const cases: Array<[string, string]> = [
      ['', 'job-history'],
      ['org=a&project=b&study=c', 'study-detail'],
      ['org=a&project=b&study=c&run=d', 'study-run'],
      ['org=a%20b&project=p%2Fq&study=s%23t&run=r%3Fx', 'study-run'],
      ['org=a%20b&project=p%2Fq&study=s%23t', 'study-detail'],
    ];
    const encodedQuery = 'org=a%20b&project=p%2Fq&study=s%23t&run=r%3Fx';
    for (const route of RETIRED_ROUTES) {
      for (const [query, slice1Screen] of cases) {
        const target = targetOf(route, query, PARAMS);
        const matches = matchRoutes(config, target);
        const screenId = route.slice === 2 ? 'proj-publications' : slice1Screen;
        expect(matches?.at(-1)?.route.id, `${route.id} ${query} -> ${target}`).toBe(screenId);
      }
      const encoded = targetOf(route, encodedQuery, PARAMS);
      expect(encoded).toBe(route.slice === 2 ? '/app/a%20b/p%2Fq/publications' : '/app/a%20b/p%2Fq/studies/s%23t/runs/r%3Fx');
      expect(routeDefinitions.map((definition) => definition.path)).not.toContain(route.path);
      expect(route.slice).toBeGreaterThanOrEqual(1);
    }
  });

  // [utest->req~frontend-retire-reports-redirect-reports~1]
  it('holds the report list and the report editor as the entries of slice 2', () => {
    const slice2 = RETIRED_ROUTES.filter((route) => route.slice === 2);
    expect(slice2.map((route) => [route.id, route.path])).toEqual([
      ['rep-list', '/app/:org/:project/reports'],
      ['rep-detail', '/app/:org/:project/reports/:report'],
    ]);
  });

  // [utest->req~frontend-retire-reports-redirect-reports~1]
  it.each(RETIRED_ROUTES.filter((route) => route.slice === 2))('sends $path to the publications of the project, whatever the query and the report', (route) => {
    const to = (query: string, params: Params) => targetOf(route, query, params);

    expect(to('', { org: 'acme', project: 'demo', report: 'engines' })).toBe('/app/acme/demo/publications');
    expect(to('', { org: 'acme', project: 'demo' })).toBe('/app/acme/demo/publications');
    expect(to('org=other&project=other&report=x&tab=blocks', { org: 'acme', project: 'demo', report: 'engines' })).toBe('/app/acme/demo/publications');
    expect(to('', { org: 'a/b', project: 'p q', report: 'r#1' })).toBe('/app/a%2Fb/p%20q/publications');
    expect(to('', { org: 'isa-demo', project: 'qos-benchmarks', report: 'engines-vs-seeds-informe' })).toBe('/app/isa-demo/qos-benchmarks/publications');
  });
});

describe('the redirect of a retired address', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-redirect-generic~1]
  it('replaces the history entry, so going back skips the retired address', async () => {
    renderAt(['/app/account', '/app/analysis/workspace?job=job-done-3']);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/jobs$/));
    expect(await screen.findByRole('heading', { name: 'Job history screen' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/account$/));
    expect(await screen.findByRole('heading', { name: 'Account screen' })).toBeInTheDocument();
  });

  // [utest->req~frontend-retire-redirect-generic~1]
  it('asks a visitor without a session to sign in first', async () => {
    const old = '/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds';
    const signedOut = renderAt([old], null);

    expect(await screen.findByRole('heading', { name: 'Sign in screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/login/);
    expect(screen.getByTestId('from').textContent).toBe(old);
    signedOut.unmount();

    renderAt([old]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(
      '/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds',
    ));
  });

  // [utest->req~frontend-retire-redirect-generic~1]
  it('renders no retired screen and no organization page', async () => {
    renderAt(['/app/analysis']);

    expect(await screen.findByRole('heading', { name: 'Job history screen' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^(Analysis|Decision space)$/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Organization page screen' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/jobs$/);
  });

  // [utest->req~frontend-retire-reports-redirect-reports~1]
  it.each([
    ['/app/acme/demo/reports', '/app/acme/demo/publications'],
    ['/app/acme/demo/reports/engines-vs-seeds-informe', '/app/acme/demo/publications'],
    ['/app/acme/demo/reports/x?tab=blocks&report=y#top', '/app/acme/demo/publications'],
    ['/app/acme/demo/reports?x=1', '/app/acme/demo/publications'],
    ['/app/a%2Fb/my%20proj/reports', '/app/a%2Fb/my%20proj/publications'],
    ['/app/a%2Fb/my%20proj/reports/r%2F1', '/app/a%2Fb/my%20proj/publications'],
  ])('sends the report address %s to %s, without a query', async (old, expected) => {
    renderAt([old]);

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(expected));
    expect(await screen.findByRole('heading', { name: 'Publications screen' })).toBeInTheDocument();
  });

  // [utest->req~frontend-retire-reports-redirect-reports~1]
  it('replaces the history entry, so going back skips the report address', async () => {
    renderAt(['/app/account', '/app/acme/demo/reports/x']);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/acme\/demo\/publications$/));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/account$/));
    expect(await screen.findByRole('heading', { name: 'Account screen' })).toBeInTheDocument();
  });

  // [utest->req~frontend-retire-reports-redirect-reports~1]
  it.each(['/app/acme/demo/reports', '/app/acme/demo/reports/x?tab=blocks'])('asks a visitor without a session to sign in before the redirect from %s', async (old) => {
    const signedOut = renderAt([old], null);

    expect(await screen.findByRole('heading', { name: 'Sign in screen' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/login/);
    expect(screen.getByTestId('from').textContent).toBe(old);
    expect(screen.queryByRole('heading', { name: 'Publications screen' })).toBeNull();
    signedOut.unmount();

    renderAt([old]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/app/acme/demo/publications'));
  });

  // [utest->req~frontend-retire-reports-redirect-reports~1]
  it('renders no report screen', async () => {
    renderAt(['/app/acme/demo/reports/x']);

    expect(await screen.findByRole('heading', { name: 'Publications screen' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /report/i })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/acme\/demo\/publications$/);
  });
});

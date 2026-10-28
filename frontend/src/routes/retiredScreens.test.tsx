import { render, waitFor } from '@testing-library/react';
import { matchRoutes, MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { mainLinks } from '../components/PlatformShell/appNavigation';
import { buildCommands } from '../components/PlatformShell/paletteCommands';
import { AuthContext } from '../contexts/auth';
import { RAW_RENDERING_ALLOW_LIST, UNLISTED_FINDINGS } from '../test/rawRenderingAllowList';
import { followMoved } from './followMoved';
import { AppRoutes } from './index';
import { movedRoutes, routeDefinitions } from './registry';

// M2.4 slice 1 (ADR-0020): the decision-space workspace is retired. Its addresses redirect to the jobs list or to the study run.
//
// The tests name the retired ids and files, and the addresses the redirects lead to. They name no screen of a live area: a screen is
// found by the address it ends on, and an address that a later change moves on is followed through the moved routes (followMoved).

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

// Only the location and the screen on show are asserted, so every screen of the registry is replaced by a stub that names itself.
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
/** Where an address ends once the moved addresses have redirected it. */
const settled = (address: string) => followMoved(address, routeDefinitions, movedRoutes);

const person: UserProfile = {
  id: 'user-1', username: 'alice', email: 'alice@example.com', role: 'user', plan: 'FREE',
  is_active: true, created_at: '2026-01-01T00:00:00Z',
};

function Location() {
  const location = useLocation();
  return (
    <>
      <output data-testid="pathname">{location.pathname}</output>
      <output data-testid="search">{location.search}</output>
    </>
  );
}

function renderAt(path: string, isAdmin = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user: isAdmin ? { ...person, role: 'admin' } : person, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin,
        }}
      >
        <AppRoutes />
        <Location />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/**
 * Where the visitor ends up, once the redirects have settled: `expected` is the address the retired route names, followed through the
 * moved routes. The screen on show is the one of that address.
 */
async function endsAt(path: string, expected: string, isAdmin = false) {
  const view = renderAt(path, isAdmin);
  const want = new URL(settled(expected), 'http://localhost');
  expect(screenAt(want.pathname), `${want.pathname} is a routed screen`).not.toBeNull();
  await waitFor(() => expect(view.getByTestId('pathname').textContent).toBe(want.pathname));
  expect(view.getByTestId('search').textContent).toBe(want.search);
  await waitFor(() => expect(shown()).toBe(screenAt(want.pathname)));
  view.unmount();
}

describe('the retired decision-space workspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('analysis-sources');
    expect(ids).not.toContain('analysis-workspace');
  });

  it('has no screen files left', () => {
    expect(Object.keys(import.meta.glob('../pages/Analysis/**'))).toEqual([]);
  });

  it('sends the old addresses to the jobs list', async () => {
    await endsAt('/app/analysis', '/app/jobs');
    await endsAt('/app/analysis/workspace?job=j1', '/app/jobs');
  });

  it('sends a workspace link that names a run to that run', async () => {
    await endsAt('/app/analysis/workspace?org=acme&project=atlas&study=s1&run=r1', '/app/acme/atlas/studies/s1/runs/r1');
  });

  it('sends a workspace link that names only a study to that study', async () => {
    await endsAt('/app/analysis/workspace?org=acme&project=atlas&study=s1', '/app/acme/atlas/studies/s1');
  });

  it('is no longer in the main navigation or the command palette', () => {
    expect(Object.keys(mainLinks)).not.toContain('analysis');
    const commands = buildCommands({ isAdmin: true });
    expect(commands.filter((command) => command.href.startsWith('/app/analysis'))).toEqual([]);
  });

  it('leaves the raw-rendering allow-list without its entries', () => {
    const inAnalysis = (entry: { file: string }) => entry.file.startsWith('pages/Analysis');
    expect(RAW_RENDERING_ALLOW_LIST.filter(inAnalysis)).toEqual([]);
    expect(UNLISTED_FINDINGS.filter(inAnalysis)).toEqual([]);
  });
});

// M2.4 slice 2: the report list and the report editor are retired. Their addresses redirect to the publications of the project.
describe('the retired report editor', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-reports-screens-not-routed~1]
  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('rep-list');
    expect(ids).not.toContain('rep-detail');
    expect(routeDefinitions.map((definition) => definition.path).filter((path) => /\/reports(\/|$)/.test(path))).toEqual([]);
  });

  // [utest->req~frontend-retire-reports-screens-not-routed~1]
  it('has no screen files left', () => {
    const files = Object.keys(import.meta.glob(['../pages/Reports/RepList.tsx', '../pages/Reports/RepDetail.tsx', '../pages/Reports/SavedDecision.tsx']));
    expect(files).toEqual([]);
  });

  // `req~frontend-retire-reports-publications-stay~1` (the publications and the verifier stay routed, and their files exist) is
  // superseded by m26-navigation (design.md section 7): the Verify page and the Published tab replace those screens. Its tests are
  // no longer here; each area test (areas/project.test.ts, areas/verify.test.ts) holds what its own screens need.

  // [utest->req~frontend-retire-reports-redirect~1]
  it('sends the report list and a report to the publications of their project', async () => {
    await endsAt('/app/acme/atlas/reports', '/app/acme/atlas/publications');
    await endsAt('/app/acme/atlas/reports/engines-vs-seeds-informe', '/app/acme/atlas/publications');
    await endsAt('/app/acme/atlas/reports/engines-vs-seeds-informe?x=1', '/app/acme/atlas/publications');
  });
});

// M2.4 slice 3: the library catalogue and the project resources are retired. Their addresses redirect to the organization overview
// or to the collections of the project.
describe('the retired library catalogue and project resources', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['lib-list', 'lib-artifact', 'lib-draft', 'lib-version', 'proj-library', 'proj-resources', 'proj-resource-detail']) {
      expect(ids, id).not.toContain(id);
    }
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('has no screen files left', () => {
    const files = Object.keys(import.meta.glob([
      '../pages/Library/LibList.tsx', '../pages/Library/LibArtifact.tsx', '../pages/Library/LibDraft.tsx', '../pages/Library/LibVersion.tsx',
      '../pages/Library/ProjLibrary.tsx', '../pages/Resources/ProjResources.tsx', '../pages/Resources/ProjResourceDetail.tsx',
    ]));
    expect(files).toEqual([]);
  });

  // [utest->req~frontend-retire-library-redirect~1]
  it('sends the library of an organization, an artifact, a draft and a version to the organization overview', async () => {
    await endsAt('/app/acme/library', '/app/acme');
    await endsAt('/app/acme/library/a1?tab=x#top', '/app/acme');
    await endsAt('/app/acme/library/a1/drafts/d1', '/app/acme');
    await endsAt('/app/acme/library/a1/versions/v1', '/app/acme');
    await endsAt('/app/a%2Fb/library/a1/versions/v%231', '/app/a%2Fb');
  });

  // [utest->req~frontend-retire-library-redirect~1]
  it('sends the project library and the project resources to the collections of the project', async () => {
    await endsAt('/app/acme/atlas/library', '/app/acme/atlas/collections');
    await endsAt('/app/acme/atlas/resources', '/app/acme/atlas/collections');
    await endsAt('/app/acme/atlas/resources/r1?x=1', '/app/acme/atlas/collections');
    await endsAt('/app/a%2Fb/my%20proj/resources/r%2F1', '/app/a%2Fb/my%20proj/collections');
  });

  // [utest->req~frontend-retire-library-redirect~1]
  it('sends /app/<org>/library/reports and /app/<org>/library/library to the organization overview, not to a project', async () => {
    await endsAt('/app/o/library/reports', '/app/o');
    await endsAt('/app/o/library/library', '/app/o');
    await endsAt('/app/o/library/resources', '/app/o');
  });

  // [utest->req~frontend-retire-library-redirect~1]
  it('leaves a project called library the screens of its sections, which win the tie with the retired library artifact', async () => {
    // Not `/app/acme`, where the retired library artifact would send it: the address stays (or moves on with its section).
    const address = '/app/acme/library/collections';
    const view = renderAt(address);
    const want = new URL(settled(address), 'http://localhost');

    await waitFor(() => expect(shown()).toBe(screenAt(want.pathname)));
    expect(view.getByTestId('pathname').textContent).toBe(want.pathname);
    expect(want.pathname).toMatch(/^\/app\/acme\/library\//);
    view.unmount();
  });
});

// M2.4 slice 4: the composer is retired. Its address redirects to the workbench of the project, with the case.
describe('the retired composer', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-composer-screen-not-routed~1]
  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('case-composer');
  });

  // [utest->req~frontend-retire-composer-screen-not-routed~1]
  it('has no screen file left', () => {
    expect(Object.keys(import.meta.glob('../pages/Cases/CaseComposer*'))).toEqual([]);
  });

  // [utest->req~frontend-retire-composer-redirect~1]
  it('sends the composer to the workbench of the project with the case', async () => {
    const view = renderAt('/app/acme/atlas/cases/flujo/compose?case=other#top');
    const want = new URL(settled('/app/acme/atlas/workbench?case=flujo'), 'http://localhost');

    await waitFor(() => expect(view.getByTestId('pathname').textContent).toBe(want.pathname));
    expect(view.getByTestId('search').textContent).toBe(want.search);
    await waitFor(() => expect(shown()).toBe(screenAt(want.pathname)));
    view.unmount();
  });
});

// M2.4 slice 5: the sponsorship screen is retired. Its address redirects to the administration overview.
describe('the retired sponsorship screen', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-sponsorship-screen-not-routed~1]
  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('admin-sponsor');
  });

  // [utest->req~frontend-retire-sponsorship-screen-not-routed~1]
  it('has no screen file left', () => {
    expect(Object.keys(import.meta.glob('../pages/Admin/AdminSponsor*'))).toEqual([]);
  });

  // [utest->req~frontend-retire-sponsorship-redirect~1]
  it('sends an administrator to the administration overview, whatever the organization, the query and the hash', async () => {
    await endsAt('/app/admin/organizations/isa-demo/sponsor?tab=requests#limits', '/app/admin', true);
    await endsAt('/app/admin/organizations/isa%20demo/sponsor', '/app/admin', true);
  });

  // [utest->req~frontend-retire-sponsorship-redirect~1]
  it('sends a person without the administrator role on to the account', async () => {
    await endsAt('/app/admin/organizations/isa-demo/sponsor', '/app/account');
  });
});

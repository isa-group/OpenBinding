import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../api/auth';
import { mainLinks } from '../components/PlatformShell/appNavigation';
import { buildCommands } from '../components/PlatformShell/paletteCommands';
import { AuthContext } from '../contexts/auth';
import { MAX_ALLOWED_OFFENDERS, RAW_RENDERING_ALLOW_LIST, UNLISTED_FINDINGS } from '../test/rawRenderingAllowList';
import { AppRoutes } from './index';
import { routeDefinitions } from './registry';

// M2.4 slice 1 (ADR-0020): the decision-space workspace is retired. Its addresses redirect to the jobs list or to the study run.

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

// Only the location is asserted, so the destination screens are replaced.
vi.mock('../pages/Jobs/JobHistory', async () => {
  const { createElement } = await import('react');
  return { JobHistory: () => createElement('h1', null, 'Job history screen') };
});
vi.mock('../pages/Reports/ProjPublications', async () => {
  const { createElement } = await import('react');
  return { ProjPublications: () => createElement('h1', null, 'Publications screen') };
});
vi.mock('../pages/Organization/OrgOverview', async () => {
  const { createElement } = await import('react');
  return { OrgOverview: () => createElement('h1', null, 'Organization page screen') };
});
vi.mock('../pages/Workbench/Workbench', async () => {
  const { createElement } = await import('react');
  return { Workbench: () => createElement('h1', null, 'Workbench screen') };
});
vi.mock('../pages/Resources/CollList', async () => {
  const { createElement } = await import('react');
  return { CollList: () => createElement('h1', null, 'Collections screen') };
});
vi.mock('../pages/Admin/AdminOverview', async () => {
  const { createElement } = await import('react');
  return { AdminOverview: () => createElement('h1', null, 'Administration screen') };
});
vi.mock('../pages/Account/Account', async () => {
  const { createElement } = await import('react');
  return { Account: () => createElement('h1', null, 'Account screen') };
});
vi.mock('../pages/Studies/StudyDetail', async () => {
  const { createElement } = await import('react');
  return { StudyDetail: () => createElement('h1', null, 'Study detail screen') };
});
vi.mock('../pages/Studies/StudyRun', async () => {
  const { createElement } = await import('react');
  return { StudyRun: () => createElement('h1', null, 'Study run screen') };
});

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

/** Where the visitor ends up, once the redirects have settled. */
async function endsAt(path: string, expected: string, isAdmin = false) {
  const view = renderAt(path, isAdmin);
  await waitFor(() => expect(view.getByTestId('pathname').textContent).toBe(expected));
  expect(view.getByTestId('search').textContent).toBe('');
  view.unmount();
}

describe('the retired decision-space workspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('analysis-sources');
    expect(ids).not.toContain('analysis-workspace');
    expect(routeDefinitions).toHaveLength(69);
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
    expect(MAX_ALLOWED_OFFENDERS).toBe(1);
  });
});

// M2.4 slice 2: the report list and the report editor are retired. Their addresses redirect to the publications of the project.
describe('the retired report editor', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-reports-screens-not-routed~1]
  it('is gone from the route registry, and the publications and the verifier stay', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('rep-list');
    expect(ids).not.toContain('rep-detail');
    expect(routeDefinitions.map((definition) => definition.path).filter((path) => /\/reports(\/|$)/.test(path))).toEqual([]);
    expect(ids).toContain('proj-publications');
    expect(ids).toContain('verifier');
  });

  // [utest->req~frontend-retire-reports-screens-not-routed~1]
  it('has no screen files left', () => {
    const files = Object.keys(import.meta.glob(['../pages/Reports/RepList.tsx', '../pages/Reports/RepDetail.tsx', '../pages/Reports/SavedDecision.tsx']));
    expect(files).toEqual([]);
  });

  // [utest->req~frontend-retire-reports-publications-stay~1]
  it('keeps the screens of the publications and of the verifier', () => {
    const files = Object.keys(import.meta.glob(['../pages/Reports/ProjPublications.tsx', '../pages/Reports/Verifier.tsx']));
    expect(files.sort()).toEqual(['../pages/Reports/ProjPublications.tsx', '../pages/Reports/Verifier.tsx']);
  });

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
  it('is gone from the route registry, and the files and the collections stay', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['lib-list', 'lib-artifact', 'lib-draft', 'lib-version', 'proj-library', 'proj-resources', 'proj-resource-detail']) {
      expect(ids, id).not.toContain(id);
    }
    for (const id of ['proj-files', 'coll-list', 'coll-detail']) expect(ids, id).toContain(id);
    expect(routeDefinitions).toHaveLength(69);
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
    const view = renderAt('/app/acme/library/collections');

    expect(await view.findByRole('heading', { name: 'Collections screen' })).toBeInTheDocument();
    expect(view.getByTestId('pathname').textContent).toBe('/app/acme/library/collections');
    view.unmount();
  });
});

// M2.4 slice 4: the composer is retired. Its address redirects to the workbench of the project, with the case.
describe('the retired composer', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-composer-screen-not-routed~1]
  // [utest->req~frontend-retire-composer-screen-count~1]
  it('is gone from the route registry, and the case screens and the workbench stay', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('case-composer');
    for (const id of ['case-list', 'case-detail', 'case-revision', 'case-compare', 'wb-workbench']) expect(ids, id).toContain(id);
    expect(routeDefinitions).toHaveLength(69);
  });

  // [utest->req~frontend-retire-composer-screen-not-routed~1]
  it('has no screen file left', () => {
    expect(Object.keys(import.meta.glob('../pages/Cases/CaseComposer*'))).toEqual([]);
  });

  // [utest->req~frontend-retire-composer-redirect~1]
  it('sends the composer to the workbench of the project with the case', async () => {
    const view = renderAt('/app/acme/atlas/cases/flujo/compose?case=other#top');

    expect(await view.findByRole('heading', { name: 'Workbench screen' })).toBeInTheDocument();
    expect(view.getByTestId('pathname').textContent).toBe('/app/acme/atlas/workbench');
    expect(view.getByTestId('search').textContent).toBe('?case=flujo');
    view.unmount();
  });
});

// M2.4 slice 5: the sponsorship screen is retired. Its address redirects to the administration overview.
describe('the retired sponsorship screen', () => {
  beforeEach(() => vi.clearAllMocks());

  // [utest->req~frontend-retire-sponsorship-screen-not-routed~1]
  // [utest->req~frontend-retire-sponsorship-screen-count~1]
  it('is gone from the route registry, and the other administration screens stay', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('admin-sponsor');
    for (const id of ['admin-overview', 'admin-users', 'admin-user-detail', 'admin-audit']) expect(ids, id).toContain(id);
    expect(routeDefinitions).toHaveLength(69);
    expect(MAX_ALLOWED_OFFENDERS).toBe(1);
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

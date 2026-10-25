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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user: person, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false,
        }}
      >
        <AppRoutes />
        <Location />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/** Where the visitor ends up, once the redirects have settled. */
async function endsAt(path: string, expected: string) {
  const view = renderAt(path);
  await waitFor(() => expect(view.getByTestId('pathname').textContent).toBe(expected));
  expect(view.getByTestId('search').textContent).toBe('');
  view.unmount();
}

const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true });

describe('the retired decision-space workspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is gone from the route registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('analysis-sources');
    expect(ids).not.toContain('analysis-workspace');
    expect(routeDefinitions).toHaveLength(80);
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

  it('is no longer linked from the code, apart from the table of retired addresses', () => {
    const literal = /(['"`])((?:(?!\1)[^\n])*\/app\/analysis(?:(?!\1)[^\n])*)\1/g;
    const found: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (file.endsWith('/retiredRoutes.tsx')) continue;
      const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
      for (const match of code.matchAll(literal)) found.push(`${file.replace('../', 'src/')}: ${match[2]}`);
    }
    expect(found).toEqual([]);
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
    expect(MAX_ALLOWED_OFFENDERS).toBe(14);
  });
});

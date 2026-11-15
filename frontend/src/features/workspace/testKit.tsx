import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UsageView, UserProfile } from '../../api/auth';
import type { Organization, Study, StudyRun } from '../../api/platform';
import type { Problem, ProblemRevision } from '../../api/problems';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { AuthContext } from '../../contexts/auth';
import { iker, lucia, org } from '../../pages/Organization/testKit';

export { iker, lucia, org };

/** Shared by the tests of the organization's screens: the organization kit plus a router, and the problems, studies and runs. */
export interface RenderOptions {
  path: string;
  url: string;
  organizations?: Organization[];
  user?: UserProfile;
  loading?: boolean;
  reload?: () => Promise<void>;
}

export function renderOrgScreen(ui: ReactElement, options: RenderOptions) {
  const user = options.user ?? lucia;
  const organizations = options.organizations ?? [];
  const reload = options.reload ?? vi.fn().mockResolvedValue(undefined);
  const context: PlatformOutletContext = {
    organizations, organization: organizations[0], loading: options.loading ?? false, reload,
  };
  const view = render(
    <MemoryRouter initialEntries={[options.url]}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: user.role === 'admin' }}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path={options.path} element={ui} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Route>
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return { ...view, reload, context };
}

/** The test environment may have no `crypto.subtle`; Node's own is what the browser's would be. */
export async function ensureSubtleCrypto(): Promise<void> {
  if (globalThis.crypto?.subtle) return;
  const specifier = 'node:crypto';
  const { webcrypto } = await import(/* @vite-ignore */ specifier) as { webcrypto: Crypto };
  vi.stubGlobal('crypto', webcrypto);
}

export function researchPlanUsage(): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: { maxProblems: null, maxRepositoryStorage: null, maxRunMinutes: 30, maxConcurrentRuns: 4 },
  };
}

export function caseOf(slug: string, name = slug, over: Partial<Problem> = {}): Problem {
  return {
    id: `case-${slug}`, organization_id: 'org-isa', slug, name, description: '', created_by_id: lucia.id,
    created_at: '2026-04-02T00:00:00Z', updated_at: '2026-04-02T00:00:00Z', ...over,
  };
}

export function revisionOf(caseItem: Problem, revision: number, over: Partial<ProblemRevision> = {}): ProblemRevision {
  return {
    id: `${caseItem.id}-r${revision}`, problem_id: caseItem.id, revision, package_digest: `sha256-${String(revision).repeat(64)}`.slice(0, 71),
    package_size: 2048, created_by_id: lucia.id, created_at: `2026-04-0${revision}T00:00:00Z`, ...over,
  };
}

export function studyOf(slug: string, over: Partial<Study> = {}): Study {
  return {
    archived: false, id: `study-${slug}`, organization_id: 'org-isa', slug, name: slug,
    description: '', definition: { revision_ids: ['a', 'b'], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] },
    definition_digest: `sha256-${'e'.repeat(64)}`, state: 'active', created_by_id: lucia.id,
    created_at: '2026-09-20T00:00:00Z', ...over,
  };
}

export function runOf(study: Study, runNumber: number, over: Partial<StudyRun> = {}): StudyRun {
  return {
    id: `run-${study.slug}-${runNumber}`, study_id: study.id, run_number: runNumber, state: 'partial',
    matrix_digest: `sha256-${'d'.repeat(64)}`, cells: 8, summary: {}, created_at: '2026-09-21T00:00:00Z', finished_at: null,
    definition: {
      apiVersion: 'openbinding/study-run/v1', problems: [], engines: study.definition.engines,
      parameterSets: study.definition.parameter_sets, seeds: study.definition.seeds,
    },
    definition_digest: `sha256-${'9'.repeat(64)}`, ...over,
  };
}

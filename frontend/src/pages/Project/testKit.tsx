import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { UsageView, UserProfile } from '../../api/auth';
import type { BindingCase, CaseRevision, Organization, Project, Report, Study, StudyRun } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { AuthContext } from '../../contexts/auth';
import { iker, lucia, org, project } from '../Organization/testKit';

export { iker, lucia, org, project };

/** Shared by the tests of the project screens: the organization kit plus a router that knows the project, and its contents. */
export interface RenderOptions {
  path: string;
  url: string;
  organizations?: Organization[];
  projects?: Project[];
  user?: UserProfile;
  loading?: boolean;
  reload?: () => Promise<void>;
}

export function renderProjectScreen(ui: ReactElement, options: RenderOptions) {
  const user = options.user ?? lucia;
  const organizations = options.organizations ?? [];
  const reload = options.reload ?? vi.fn().mockResolvedValue(undefined);
  const context: PlatformOutletContext = {
    organizations, projects: options.projects ?? [], organization: organizations[0], project: undefined, loading: options.loading ?? false, reload,
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

export function usageWithProjects(): UsageView {
  return {
    plan: 'RESEARCH',
    contract_pending: false,
    features: {},
    capabilities: { projects: 50, privateProjects: 30, maxPayloadBytes: 134_217_728 },
  };
}

export function caseOf(slug: string, name = slug, over: Partial<BindingCase> = {}): BindingCase {
  return { id: `case-${slug}`, project_id: 'project-qos', slug, name, description: '', created_by_id: lucia.id, created_at: '2026-04-02T00:00:00Z', ...over };
}

export function revisionOf(caseItem: BindingCase, revision: number, over: Partial<CaseRevision> = {}): CaseRevision {
  return {
    id: `${caseItem.id}-r${revision}`, binding_case_id: caseItem.id, revision, digest: `sha256-${String(revision).repeat(64)}`.slice(0, 71), document: {},
    source_snapshot_id: null, created_at: `2026-04-0${revision}T00:00:00Z`, ...over,
  };
}

export function reportOf(slug: string, state: Report['state'], over: Partial<Report> = {}): Report {
  return {
    artifact_id: `artifact-${slug}`, version_id: state === 'frozen' ? `version-${slug}` : null, draft_id: null, draft_revision: state === 'draft' ? 3 : null,
    id: `report-${slug}`, project_id: 'project-qos', study_run_id: null, slug, title: slug, document: {}, digest: `sha256-${'e'.repeat(64)}`, state,
    created_at: '2026-09-25T00:00:00Z', ...over,
  };
}

export function studyOf(slug: string, over: Partial<Study> = {}): Study {
  return {
    archived: false, id: `study-${slug}`, definition_version_id: `version-${slug}`, definition_artifact_id: `artifact-${slug}`, project_id: 'project-qos', slug, name: slug,
    description: '', definition: { case_revision_ids: ['a', 'b'], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] }, state: 'active', created_by_id: lucia.id,
    created_at: '2026-09-20T00:00:00Z', ...over,
  };
}

export function runOf(study: Study, runNumber: number, over: Partial<StudyRun> = {}): StudyRun {
  return {
    id: `run-${study.slug}-${runNumber}`, definition_version_id: study.definition_version_id, study_id: study.id, run_number: runNumber, state: 'partial',
    matrix_digest: `sha256-${'d'.repeat(64)}`, cells: 8, summary: {}, created_at: '2026-09-21T00:00:00Z', finished_at: null, ...over,
  };
}

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Project, StudyCell, StudyRun } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { ProjectOverview, ResourcesPage, StudiesPage } from './PlatformPages';

const api = vi.hoisted(() => ({
  cases: vi.fn(),
  studies: vi.fn(),
  reports: vi.fn(),
  updateProject: vi.fn(),
  resources: vi.fn(),
  resourceRevisions: vi.fn(),
  createResource: vi.fn(),
  createResourceRevision: vi.fn(),
  revisions: vi.fn(),
  studyRuns: vi.fn(),
  studyCells: vi.fn(),
  runStudy: vi.fn(),
  cancelStudyRun: vi.fn(),
  retryStudyCell: vi.fn(),
  createStudy: vi.fn(),
}));

const client = vi.hoisted(() => ({ getEngines: vi.fn() }));
const outlet = vi.hoisted(() => ({ value: null as PlatformOutletContext | null }));

vi.mock('../../api/platform', () => ({ platformApi: api }));
vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: client,
}));
vi.mock('react-router-dom', async () => ({
  ...await vi.importActual<typeof import('react-router-dom')>('react-router-dom'),
  useOutletContext: () => outlet.value,
}));

const organization: Organization = {
  id: 'organization-id', slug: 'openbinding', name: 'OpenBinding', parent_id: null,
  billing_sponsor_user_id: 'sponsor-id', effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z',
};
const project: Project = {
  id: 'project-id', organization_id: organization.id, slug: 'research', name: 'Binding research',
  description: 'Reproducible binding evidence.', visibility: 'private', created_by_id: 'user-id',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};
const reload = vi.fn();

describe('collaborative project pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outlet.value = { organizations: [organization], projects: [project], organization, project, loading: false, reload };
    api.cases.mockResolvedValue([]);
    api.studies.mockResolvedValue([]);
    api.reports.mockResolvedValue([]);
    api.resources.mockResolvedValue([]);
    api.resourceRevisions.mockResolvedValue([]);
    api.revisions.mockResolvedValue([]);
    api.studyRuns.mockResolvedValue([]);
    api.studyCells.mockResolvedValue([]);
    client.getEngines.mockResolvedValue([]);
  });

  it('publishes a private project through the project settings control', async () => {
    api.updateProject.mockResolvedValue({ ...project, visibility: 'public' });
    render(<MemoryRouter><ProjectOverview /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Publish project' }));

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('openbinding', 'research', { visibility: 'public' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('renders immutable resources and creates a new revision', async () => {
    const resource = {
      id: 'resource-id', project_id: project.id, slug: 'catalogue', name: 'Candidate catalogue',
      description: 'Candidates used by the study.', kind: 'CandidateCatalog', created_by_id: 'user-id',
      created_at: '2026-09-01T00:00:00Z',
    };
    api.resources.mockResolvedValue([resource]);
    api.resourceRevisions.mockResolvedValue([{ id: 'revision-id', project_resource_id: resource.id, revision: 1, digest: `sha256-${'a'.repeat(64)}`, document: {}, created_at: '2026-09-01T00:00:00Z' }]);
    api.createResourceRevision.mockResolvedValue({});
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Candidate catalogue' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resource document'), { target: { value: '{"kind":"CandidateCatalog"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable revision' }));

    await waitFor(() => expect(api.createResourceRevision).toHaveBeenCalledWith(
      'openbinding', 'research', 'catalogue', { kind: 'CandidateCatalog' },
    ));
  });

  it('cancels an active study run and retries only failed cells', async () => {
    const study = {
      id: 'study-id', project_id: project.id, slug: 'engines', name: 'Engine comparison', description: '',
      definition: { case_revision_ids: ['revision-id'], engines: [{}], parameter_sets: [{}], seeds: [0] },
      state: 'active', created_by_id: 'user-id', created_at: '2026-09-01T00:00:00Z',
    };
    const run: StudyRun = {
      id: 'run-id', study_id: study.id, run_number: 1, state: 'running', matrix_digest: `sha256-${'b'.repeat(64)}`,
      cells: 1, summary: {}, created_at: '2026-09-01T00:00:00Z', finished_at: null,
    };
    const failedCell: StudyCell = {
      id: 'cell-id', study_run_id: run.id, ordinal: 0, binding_case_revision_id: 'revision-id',
      engine_ref: {}, parameters: {}, seed: 0, fingerprint: 'fingerprint', job_id: 'job-id', state: 'failed', metrics: {},
    };
    api.studies.mockResolvedValue([study]);
    api.studyRuns.mockResolvedValue([run]);
    api.studyCells.mockResolvedValue([failedCell]);
    api.cancelStudyRun.mockResolvedValue({ ...run, state: 'cancelled' });
    api.retryStudyCell.mockResolvedValue({ id: failedCell.id, state: 'queued', fingerprint: failedCell.fingerprint });
    render(<MemoryRouter><StudiesPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(api.cancelStudyRun).toHaveBeenCalledWith('openbinding', 'research', 'engines', 'run-id'));

    fireEvent.click(screen.getByText('1 retryable cell'));
    fireEvent.click(screen.getByRole('button', { name: /Cell 1/ }));
    await waitFor(() => expect(api.retryStudyCell).toHaveBeenCalledWith('openbinding', 'research', 'engines', 'run-id', 'cell-id'));
  });
});

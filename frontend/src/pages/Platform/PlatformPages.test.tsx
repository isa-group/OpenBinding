import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Project, StudyCell, StudyRun } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { PlatformDashboard, ProjectOverview, ResourcesPage, StudiesPage } from './PlatformPages';

const api = vi.hoisted(() => ({
  cases: vi.fn(),
  studies: vi.fn(),
  reports: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  deleteOrganization: vi.fn(),
  createOrganization: vi.fn(),
  createProject: vi.fn(),
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

  it('deletes a project through the danger zone after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue('research');
    api.deleteProject.mockResolvedValue({});

    render(<MemoryRouter><ProjectOverview /></MemoryRouter>);

    const deleteBtn = await screen.findByRole('button', { name: 'Delete this project' });
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('openbinding', 'research'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('renders onboarding card when user has 0 organizations and submits first workspace', async () => {
    outlet.value = { organizations: [], projects: [], organization: undefined, project: undefined, loading: false, reload };
    api.createOrganization.mockResolvedValue({ id: 'new-org-id', slug: 'my-lab', name: 'My Lab' });
    api.createProject.mockResolvedValue({ id: 'new-proj-id', slug: 'first-proj', name: 'First Project' });

    render(<MemoryRouter><PlatformDashboard /></MemoryRouter>);

    expect(screen.getByText(/Welcome to OpenBinding! Let's set up your workspace/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Organization Name/i), { target: { value: 'My Lab' } });
    fireEvent.change(screen.getByLabelText(/Organization Slug/i), { target: { value: 'my-lab' } });
    fireEvent.change(screen.getByLabelText(/Initial Project Name/i), { target: { value: 'First Project' } });
    fireEvent.change(screen.getByLabelText(/Initial Project Slug/i), { target: { value: 'first-proj' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Organization & Get Started/i }));

    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith({
      name: 'My Lab',
      slug: 'my-lab',
      parent_id: null,
    }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('my-lab', {
      name: 'First Project',
      slug: 'first-proj',
      description: '',
      visibility: 'private',
    }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('auto-generates project slug from project name when slug is omitted during onboarding', async () => {
    outlet.value = { organizations: [], projects: [], organization: undefined, project: undefined, loading: false, reload };
    api.createOrganization.mockResolvedValue({ id: 'new-org-id', slug: 'my-lab', name: 'My Lab' });
    api.createProject.mockResolvedValue({ id: 'new-proj-id', slug: 'benchmark-studies', name: 'Benchmark Studies' });

    render(<MemoryRouter><PlatformDashboard /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText(/Organization Name/i), { target: { value: 'My Lab' } });
    fireEvent.change(screen.getByLabelText(/Organization Slug/i), { target: { value: 'my-lab' } });
    fireEvent.change(screen.getByLabelText(/Initial Project Name/i), { target: { value: 'Benchmark Studies' } });

    fireEvent.click(screen.getByRole('button', { name: /Create Organization & Get Started/i }));

    await waitFor(() => expect(api.createOrganization).toHaveBeenCalledWith({
      name: 'My Lab',
      slug: 'my-lab',
      parent_id: null,
    }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('my-lab', {
      name: 'Benchmark Studies',
      slug: 'benchmark-studies',
      description: '',
      visibility: 'private',
    }));
  });
});

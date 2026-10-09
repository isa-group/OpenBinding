import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Project, Report } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { ProjectRecordsPage } from './PlatformPages';

// The studies (study-*) are tested with their screens in pages/Studies; what stays here is the list of reports.
const api = vi.hoisted(() => ({
  studies: vi.fn(),
  reports: vi.fn(),
  publications: vi.fn(),
  studyRuns: vi.fn(),
}));

const outlet = vi.hoisted(() => ({ value: null as PlatformOutletContext | null }));

vi.mock('../../api/platform', () => ({ platformApi: api }));
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

const draft: Report = {
  artifact_id: 'artifact-1', version_id: null, draft_id: 'draft-1', draft_revision: 1, id: 'report-1', project_id: project.id, study_run_id: 'run-1',
  slug: 'engines-report', title: 'Engines report', document: {}, digest: '', state: 'draft', created_at: '2026-09-02T00:00:00Z',
};

describe('collaborative project pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outlet.value = { organizations: [organization], projects: [project], organization, project, loading: false, reload };
    api.studies.mockResolvedValue([]);
    api.reports.mockResolvedValue([]);
    api.publications.mockResolvedValue([]);
    api.studyRuns.mockResolvedValue([]);
  });

  it('lists the reports of the project with the way to open each one', async () => {
    api.reports.mockResolvedValue([draft]);
    render(<MemoryRouter><ProjectRecordsPage kind="reports" /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'Engines report' })).toHaveAttribute('href', '/app/openbinding/research/reports/engines-report');
    expect(screen.getByText('Unfrozen draft')).toBeInTheDocument();
    expect(api.reports).toHaveBeenCalledWith('openbinding', 'research');
  });

  it('sends a project page to the new-project screen when the workspace has no project', async () => {
    outlet.value = { organizations: [organization], projects: [], organization, project: undefined, loading: false, reload };

    render(<MemoryRouter><ProjectRecordsPage kind="reports" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Create a first project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/app/openbinding/new-project');
    expect(api.reports).not.toHaveBeenCalled();
  });
});

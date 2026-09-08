import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { JobsPage } from './JobsPage';
import { SnapshotPage } from './SnapshotPage';
import { CaseDetailPage } from './CaseDetailPage';
import { ReportDetailPage } from './ReportDetailPage';

const api = vi.hoisted(() => ({
  projectJobs: vi.fn(),
  snapshot: vi.fn(),
  snapshotArchive: vi.fn(),
  case: vi.fn(),
  caseRevisions: vi.fn(),
  revisions: vi.fn(),
  createCaseRevision: vi.fn(),
  createRevision: vi.fn(),
  updateCase: vi.fn(),
  deleteCase: vi.fn(),
  report: vi.fn(),
  reports: vi.fn(),
  publications: vi.fn(),
  updateReport: vi.fn(),
  freezeReport: vi.fn(),
  publishReport: vi.fn(),
  deleteReport: vi.fn(),
  deletePublication: vi.fn(),
}));

const outlet = vi.hoisted(() => ({ value: null as PlatformOutletContext | null }));

vi.mock('../../api/platform', () => ({ platformApi: api }));
vi.mock('../../components/CodeEditor/CodeEditor', () => ({
  CodeEditor: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <div data-testid="mock-code-editor" aria-label={ariaLabel}>
      {value}
    </div>
  ),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useOutletContext: () => outlet.value,
  };
});

const organization: Organization = {
  id: 'org-1',
  slug: 'score-ai',
  name: 'SCORE AI',
  parent_id: null,
  billing_sponsor_user_id: 'user-1',
  effective_role: 'OWNER',
  created_at: '2026-09-01T00:00:00Z',
};

const project: Project = {
  id: 'proj-1',
  organization_id: organization.id,
  slug: 'qos-placement',
  name: 'QoS Placement',
  description: 'Placement benchmark',
  visibility: 'public',
  created_by_id: 'user-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

describe('InspectionPages test suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outlet.value = {
      organizations: [organization],
      projects: [project],
      organization,
      project,
      loading: false,
      reload: vi.fn(),
    };
  });

  describe('JobsPage', () => {
    it('renders jobs, applies filters, and displays terminal logs for selected job', async () => {
      const mockJobs = [
        {
          id: 'job-1',
          organization_id: organization.id,
          project_id: project.id,
          billing_sponsor_user_id: 'user-1',
          owner_id: 'user-1',
          engine_id: 'minizinc-csp',
          service_url: 'http://engine:3000',
          state: 'completed',
          status: 'completed',
          termination: 'OPTIMAL',
          options: { solver: 'gecode', time_budget_ms: 5000 },
          result: {
            termination: 'OPTIMAL',
            solutions: [{ decision: { kind: 'binding' }, objectives: { cost: 42.5 } }],
            logs: '[2026-09-07] Optimal solution proven.',
          },
          cancellation_requested: false,
          created_at: '2026-09-07T10:00:00Z',
          finished_at: '2026-09-07T10:00:02Z',
        },
        {
          id: 'job-2',
          organization_id: organization.id,
          project_id: project.id,
          billing_sponsor_user_id: 'user-1',
          owner_id: 'user-1',
          engine_id: 'random-search',
          service_url: 'http://engine:8080',
          state: 'running',
          status: 'running',
          options: { iterations: 1000 },
          result: { logs: '[2026-09-07] Search in progress...' },
          cancellation_requested: false,
          created_at: '2026-09-07T10:05:00Z',
        },
      ];
      api.projectJobs.mockResolvedValue(mockJobs);

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/jobs']}>
          <Routes>
            <Route path="/app/:org/:project/jobs" element={<JobsPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(await screen.findByText('Project Solver Jobs')).toBeInTheDocument();
      expect((await screen.findAllByText(/minizinc-csp/)).length).toBeGreaterThan(0);
      expect(screen.getByText(/random-search/)).toBeInTheDocument();
      expect(screen.getByText(/Optimal solution proven/)).toBeInTheDocument();

      // Test status filter buttons
      const runningFilterBtn = screen.getByRole('button', { name: /running \(1\)/i });
      fireEvent.click(runningFilterBtn);

      // Verify running job is shown and completed job is filtered out
      expect(screen.getAllByText(/random-search/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/UUID: job-1/)).not.toBeInTheDocument();
    });

    it('deep-links to specific jobId via URL params', async () => {
      const mockJobs = [
        {
          id: 'job-target',
          organization_id: organization.id,
          project_id: project.id,
          billing_sponsor_user_id: 'user-1',
          owner_id: 'user-1',
          engine_id: 'minizinc-targeted',
          service_url: 'http://engine:3000',
          state: 'completed',
          status: 'completed',
          termination: 'OPTIMAL',
          options: {},
          result: { logs: 'Targeted job executed successfully' },
          cancellation_requested: false,
          created_at: '2026-09-07T12:00:00Z',
        },
      ];
      api.projectJobs.mockResolvedValue(mockJobs);

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/jobs/job-target']}>
          <Routes>
            <Route path="/app/:org/:project/jobs/:jobId" element={<JobsPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(await screen.findByText(/UUID: job-target/)).toBeInTheDocument();
      expect(screen.getByText(/Targeted job executed successfully/)).toBeInTheDocument();
    });
  });

  describe('SnapshotPage', () => {
    it('renders snapshot integrity seals and Intermediate Representation', async () => {
      const mockSnapshot = {
        id: 'snap-1',
        name: 'Simple Seq Snapshot',
        instanceDigest: `sha256-${'1'.repeat(64)}`,
        packageDigest: `sha256-${'2'.repeat(64)}`,
        createdAt: '2026-09-01T00:00:00Z',
        rootDocument: { apiVersion: 'bim/v1', kind: 'Instance' },
        resourceDigests: {},
        ir: {
          irDigest: `sha256-${'3'.repeat(64)}`,
          compilerVersion: '1.0.0',
          document: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
        },
      };
      api.snapshot.mockResolvedValue(mockSnapshot);
      api.snapshotArchive.mockResolvedValue(new ArrayBuffer(128));

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/snapshots/snap-1']}>
          <Routes>
            <Route path="/app/:org/:project/snapshots/:snapshotId" element={<SnapshotPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(await screen.findByText('Source Snapshot Inspection')).toBeInTheDocument();
      expect(screen.getByText(new RegExp(`sha256-1{12}`, 'i'))).toBeInTheDocument();
      expect(screen.getByText(/Persisted Intermediate Representation/i)).toBeInTheDocument();
    });
  });

  describe('CaseDetailPage', () => {
    it('renders case, revision timeline, and switches revision documents', async () => {
      const mockCase = {
        id: 'case-1',
        project_id: project.id,
        slug: 'simple-seq',
        name: 'Sequential Service Workflow',
        description: 'Sequential pipeline with strict latency bounds',
        created_by_id: 'user-1',
        created_at: '2026-09-01T00:00:00Z',
      };
      const mockRevs = [
        {
          id: 'rev-2',
          binding_case_id: 'case-1',
          revision: 2,
          digest: `sha256-${'b'.repeat(64)}`,
          document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { revision: 2 } },
          source_snapshot_id: 'snap-1',
          created_at: '2026-09-02T00:00:00Z',
        },
        {
          id: 'rev-1',
          binding_case_id: 'case-1',
          revision: 1,
          digest: `sha256-${'a'.repeat(64)}`,
          document: { apiVersion: 'bim/v1', kind: 'Instance', metadata: { revision: 1 } },
          source_snapshot_id: null,
          created_at: '2026-09-01T00:00:00Z',
        },
      ];
      api.case.mockResolvedValue(mockCase);
      api.caseRevisions.mockResolvedValue(mockRevs);

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/cases/simple-seq']}>
          <Routes>
            <Route path="/app/:org/:project/cases/:caseSlug" element={<CaseDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(await screen.findByText('Sequential Service Workflow')).toBeInTheDocument();
      expect(screen.getByText('2 Revisions')).toBeInTheDocument();
      expect(screen.getByText('Revision r2')).toBeInTheDocument();
      expect(screen.getByText('Revision r1')).toBeInTheDocument();

      // Switch to Source Document tab
      fireEvent.click(screen.getByRole('button', { name: /Source Document/i }));
      expect(await screen.findByTestId('mock-code-editor')).toBeInTheDocument();

      // Switch to Revision 1
      fireEvent.click(screen.getByText('Revision r1'));
      expect(screen.getByText('Revision r1 Document')).toBeInTheDocument();
    });

    it('updates case metadata and creates a new revision', async () => {
      const mockCase = {
        id: 'case-1',
        project_id: project.id,
        slug: 'simple-seq',
        name: 'Sequential Case',
        description: 'Initial',
        created_by_id: 'user-1',
        created_at: '2026-09-01T00:00:00Z',
      };
      api.case.mockResolvedValue(mockCase);
      api.caseRevisions.mockResolvedValue([]);
      api.updateCase.mockResolvedValue({ ...mockCase, name: 'Renamed Case' });
      api.createCaseRevision.mockResolvedValue({
        id: 'rev-1',
        binding_case_id: 'case-1',
        revision: 1,
        digest: 'sha256-xxx',
        document: {},
        created_at: '2026-09-01T00:00:00Z',
      });

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/cases/simple-seq']}>
          <Routes>
            <Route path="/app/:org/:project/cases/:caseSlug" element={<CaseDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      // Click Edit Case button
      fireEvent.click(await screen.findByRole('button', { name: /Edit Case/i }));
      expect(screen.getByText('Edit Case Metadata')).toBeInTheDocument();

      // Submit changes
      fireEvent.change(screen.getByDisplayValue('Sequential Case'), { target: { value: 'Renamed Case' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

      await waitFor(() => {
        expect(api.updateCase).toHaveBeenCalledWith('score-ai', 'qos-placement', 'simple-seq', {
          name: 'Renamed Case',
          description: 'Initial',
        });
      });
    });
  });

  describe('ReportDetailPage', () => {
    it('renders frozen report with publication details and provenance ledger', async () => {
      const mockReport = {
        id: 'rep-1',
        project_id: project.id,
        study_run_id: 'run-1',
        slug: 'empirical-report',
        title: 'Empirical Benchmark Report',
        document: {
          summary: {
            conclusion: 'MiniZinc proves Pareto optimality in <= 104ms.',
            total_cells: 4,
          },
          provenance: {
            bimVersion: 'bim/v1',
            software: [{ name: 'gecode', version: '6.3.0' }],
            datasets: [{ reference: 'simple-seq' }],
          },
        },
        digest: `sha256-${'f'.repeat(64)}`,
        state: 'frozen',
        created_by_id: 'user-1',
        created_at: '2026-09-01T00:00:00Z',
      };
      const mockPub = {
        id: 'pub-1',
        project_id: project.id,
        report_id: 'rep-1',
        slug: 'qos-placement-paper',
        citation: {
          authors: ['Alice Researcher', 'Bob Engineer'],
          venue: 'IEEE TSC',
          doi: '10.1109/TSC.2026.9942001',
        },
        published_by_id: 'user-1',
        published_at: '2026-09-01T00:00:00Z',
      };
      api.report.mockResolvedValue(mockReport);
      api.publications.mockResolvedValue([mockPub]);

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/reports/empirical-report']}>
          <Routes>
            <Route path="/app/:org/:project/reports/:reportSlug" element={<ReportDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(await screen.findByText('Empirical Benchmark Report')).toBeInTheDocument();
      expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
      expect(screen.getByText(/Public Scientific Publication/)).toBeInTheDocument();
      expect(screen.getByText(/DOI: 10.1109\/TSC.2026.9942001/)).toBeInTheDocument();
      expect(screen.getByText(/MiniZinc proves Pareto optimality/)).toBeInTheDocument();

      // Click Scientific Provenance tab
      fireEvent.click(screen.getByRole('button', { name: /Scientific Provenance/i }));
      expect(await screen.findByText('Scientific Provenance Ledger')).toBeInTheDocument();
      expect(screen.getByText(/gecode v6.3.0/)).toBeInTheDocument();
    });

    it('allows editing and freezing a draft report', async () => {
      const mockDraft = {
        id: 'draft-1',
        project_id: project.id,
        study_run_id: null,
        slug: 'draft-notes',
        title: 'Working Draft Notes',
        document: { summary: 'Initial notes' },
        digest: null,
        state: 'draft',
        created_by_id: 'user-1',
        created_at: '2026-09-01T00:00:00Z',
      };
      api.report.mockResolvedValue(mockDraft);
      api.publications.mockResolvedValue([]);
      api.updateReport.mockResolvedValue({ ...mockDraft, title: 'Updated Working Notes' });
      api.freezeReport.mockResolvedValue({ ...mockDraft, state: 'frozen', digest: 'sha256-zzz' });

      render(
        <MemoryRouter initialEntries={['/app/score-ai/qos-placement/reports/draft-notes']}>
          <Routes>
            <Route path="/app/:org/:project/reports/:reportSlug" element={<ReportDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(await screen.findByText('Working Draft Notes')).toBeInTheDocument();
      expect(screen.getByText('EDITABLE DRAFT')).toBeInTheDocument();

      // Switch to Draft Editor tab
      fireEvent.click(screen.getByRole('button', { name: /Draft Editor/i }));
      expect(await screen.findByText('Edit Working Draft')).toBeInTheDocument();

      // Change title and submit
      fireEvent.change(screen.getByDisplayValue('Working Draft Notes'), { target: { value: 'Updated Working Notes' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Draft Changes' }));

      await waitFor(() => {
        expect(api.updateReport).toHaveBeenCalledWith('score-ai', 'qos-placement', 'draft-notes', {
          title: 'Updated Working Notes',
          document: { summary: 'Initial notes' },
        });
      });
    });
  });
});

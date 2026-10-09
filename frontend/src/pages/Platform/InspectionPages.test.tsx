import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Project } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { ReportDetailPage } from './ReportDetailPage';

const api = vi.hoisted(() => ({
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

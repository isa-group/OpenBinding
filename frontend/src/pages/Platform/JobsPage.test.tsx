import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JobsPage } from './JobsPage';
import { platformApi, type Job } from '../../api/platform';

// Mock useOutletContext
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useOutletContext: () => ({
      project: { id: 'p1', name: 'Test Project', slug: 'test-project' },
      organization: { id: 'o1', name: 'Test Org', slug: 'test-org' },
    }),
  };
});

describe('JobsPage AutoRouter Integration', () => {
  const mockJobWithAutoRouter: Job = {
    id: 'job-autorouter-12345678',
    engine_id: 'auto',
    status: 'completed',
    cancellation_requested: false,
    retry_of_id: null,
    organization_id: 'org-1',
    project_id: 'proj-1',
    created_at: '2026-09-16T18:00:00Z',
    finished_at: '2026-09-16T18:00:05Z',
    termination: 'OPTIMAL',
    options: { solver: 'default', time_budget_ms: 15000 },
    provenance: {
      engineRouting: {
        selectedEngine: 'evolutionary-heuristics',
        selectedMode: 'elitist-genetic',
        adaptationReason: 'Selected evolutionary-heuristics with utility score 0.884',
        utilityScore: 0.884,
        creditsCost: 8,
        fallbackActivated: false,
      },
      engineRoutingAdmin: {
        adaptationLoopId: 'loop-xyz-99',
        workloadFeatures: { S: 12.3, D_constr: 1.5, N_tasks: 10 },
        candidateEvaluations: [
          {
            engine: 'evolutionary-heuristics',
            admissible: true,
            utility: 0.884,
          },
          {
            engine: 'minizinc-csp',
            admissible: false,
            utility: 0.45,
            rejectionReason: 'Exceeded phase transition limit',
          },
        ],
      },
    },
    result: {
      status: 'completed',
      logs: 'Optimization finished in 2.1s',
      solutions: [{ decision: { hello: 'service-a' }, objectives: { latency: 120 } }],
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(platformApi, 'projectJobs').mockResolvedValue([mockJobWithAutoRouter]);
  });

  it('renders AutoRouter badges and decision card with MAPE-K telemetry', async () => {
    render(
      <MemoryRouter initialEntries={['/app/test-org/test-project/jobs/job-autorouter-12345678']}>
        <Routes>
          <Route path="/app/:org/:project/jobs/:jobId?" element={<JobsPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getAllByText('AutoRouter').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('AutoRouter Autonomic Decision (MAPE-K):')).toBeInTheDocument();
    });

    expect(screen.getByText('evolutionary-heuristics · elitist-genetic')).toBeInTheDocument();
    expect(screen.getAllByText('0.884').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('8 CU')).toBeInTheDocument();

    // Verify admin telemetry details
    expect(screen.getByText('MAPE-K Autonomic Diagnostic Telemetry (Admin)')).toBeInTheDocument();
    expect(screen.getByText('loop-xyz-99')).toBeInTheDocument();
    expect(screen.getByText('Exceeded phase transition limit')).toBeInTheDocument();
  });
});

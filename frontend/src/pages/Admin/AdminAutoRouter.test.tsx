import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminAutoRouter } from './AdminAutoRouter';
import { apiClient } from '../../api/client';

describe('AdminAutoRouter', () => {
  const mockMetrics = {
    summary: {
      totalEngines: 3,
      healthyEngines: 2,
      degradedEngines: 1,
      activeJobs: 4,
    },
    engines: {
      'evolutionary-heuristics': {
        available: true,
        activeJobs: 2,
        healthStatus: 'HEALTHY' as const,
        confidence: 0.95,
        oneHourFailureRate: 0.02,
        avgLatency: 2.15,
        cusumSPlus: 0.12,
        cusumSMinus: 0.0,
        driftAlarm: false,
      },
      'minizinc-csp': {
        available: true,
        activeJobs: 2,
        healthStatus: 'HEALTHY' as const,
        confidence: 0.85,
        oneHourFailureRate: 0.05,
        avgLatency: 7.8,
        cusumSPlus: 1.85,
        cusumSMinus: 0.0,
        driftAlarm: true,
      },
      'degraded-engine': {
        available: false,
        activeJobs: 0,
        healthStatus: 'DEGRADED' as const,
        confidence: 0.2,
        oneHourFailureRate: 0.6,
        avgLatency: 12.0,
        cusumSPlus: 3.5,
        cusumSMinus: 0.0,
        driftAlarm: true,
      },
    },
  };

  const mockObservations = {
    total: 1,
    limit: 15,
    offset: 0,
    observations: [
      {
        id: 'obs-1',
        jobId: 'job-101',
        adaptationLoopId: 'loop-alpha',
        engineSelected: 'evolutionary-heuristics',
        workloadFeatures: {
          S: 12.5,
          D_constr: 1.8,
          N_tasks: 10,
        },
        candidateEvaluations: [
          {
            engine: 'evolutionary-heuristics',
            predicted: { latency: 2.2, quality: 0.94, failureRisk: 0.02, credits: 8 },
            admissible: true,
            utility: 0.884,
          },
          {
            engine: 'minizinc-csp',
            predicted: { latency: 8.5, quality: 1.0, failureRisk: 0.45, credits: 35 },
            admissible: false,
            utility: 0.65,
            rejectionReason: 'Failure risk exceeds phase transition threshold',
          },
        ],
        predictedMetrics: { latency: 2.2, quality: 0.94 },
        actualMetrics: { actualLatency: 2.15, actualQuality: 0.94 },
        residuals: { latency: -0.05, quality: 0.0 },
        outcome: 'success',
        createdAt: '2026-09-16T18:00:00Z',
      },
    ],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'adminGetEngineRoutingMetrics').mockResolvedValue(mockMetrics);
    vi.spyOn(apiClient, 'adminListEngineRoutingObservations').mockResolvedValue(mockObservations);
    vi.spyOn(apiClient, 'adminRecalibrateEngineRouting').mockResolvedValue({
      status: 'recalibrated',
      recalibratedAt: '2026-09-16T18:30:00Z',
      observationsProcessed: 42,
      calibratedEngines: ['evolutionary-heuristics', 'minizinc-csp'],
    });
  });

  it('renders summary cards and candidate engine health monitor', async () => {
    render(<AdminAutoRouter />);

    await waitFor(() => {
      expect(screen.getByText('AutoRouter · Autonomic MAPE-K Controller')).toBeInTheDocument();
    });

    expect(screen.getByText('Registered solver candidates')).toBeInTheDocument();
    expect(screen.getByText('Circuit breaker or timeout trips')).toBeInTheDocument();
    expect(screen.getAllByText('evolutionary-heuristics').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('minizinc-csp').length).toBeGreaterThanOrEqual(1);

    // Check for CUSUM drift alarm badge on minizinc-csp
    expect(screen.getAllByText('DRIFT ALARM').length).toBeGreaterThanOrEqual(1);
  });

  it('displays adaptation observations and expands evaluation details', async () => {
    render(<AdminAutoRouter />);

    await waitFor(() => {
      expect(screen.getByText('Historical Adaptation Observations')).toBeInTheDocument();
    });

    expect(screen.getByText('Inspect')).toBeInTheDocument();

    // Click inspect to expand details
    fireEvent.click(screen.getByText('Inspect'));

    await waitFor(() => {
      expect(screen.getByText('loop-alpha', { exact: false })).toBeInTheDocument();
      expect(screen.getByText('Candidate Solver Evaluations (Multi-Criteria):')).toBeInTheDocument();
      expect(screen.getByText('Failure risk exceeds phase transition threshold')).toBeInTheDocument();
      expect(screen.getByText('0.884')).toBeInTheDocument();
    });
  });

  it('triggers model recalibration and shows success notice', async () => {
    render(<AdminAutoRouter />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Recalibrate Models/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Recalibrate Models/i }));

    await waitFor(() => {
      expect(apiClient.adminRecalibrateEngineRouting).toHaveBeenCalled();
      expect(screen.getByText(/Recalibration complete: 42 observation\(s\) processed/i)).toBeInTheDocument();
    });
  });
});

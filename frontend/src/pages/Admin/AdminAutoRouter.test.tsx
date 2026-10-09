import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdaptationObservationItem, EngineRoutingMetricsResponse } from '../../api/client';
import { AdminRouting } from './AdminRouting';
import { LUCIA } from './adminFixtures';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminGetEngineRoutingMetrics: vi.fn(),
  adminListEngineRoutingObservations: vi.fn(),
  adminRecalibrateEngineRouting: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

const METRICS: EngineRoutingMetricsResponse = {
  summary: { totalEngines: 3, healthyEngines: 2, degradedEngines: 1, activeJobs: 4 },
  engines: {
    'evolutionary-heuristics': { available: true, activeJobs: 2, healthStatus: 'HEALTHY', confidence: 0.95, oneHourFailureRate: 0.02, avgLatency: 2.15, cusumSPlus: 0.12, cusumSMinus: 0, driftAlarm: false },
    'minizinc-csp': { available: true, activeJobs: 2, healthStatus: 'HEALTHY', confidence: 0.85, oneHourFailureRate: 0.05, avgLatency: 7.8, cusumSPlus: 1.85, cusumSMinus: 0, driftAlarm: true },
    'degraded-engine': { available: false, activeJobs: 0, healthStatus: 'DEGRADED', confidence: 0.2, oneHourFailureRate: 0.6, avgLatency: 12, cusumSPlus: 3.5, cusumSMinus: 0, driftAlarm: true },
  },
};

const OBSERVATIONS: AdaptationObservationItem[] = [
  {
    id: 'obs-1',
    jobId: 'job-101',
    adaptationLoopId: 'loop-alpha',
    engineSelected: 'evolutionary-heuristics',
    workloadFeatures: { S: 12.5, D_constr: 1.8, N_tasks: 10 },
    candidateEvaluations: [
      { engine: 'evolutionary-heuristics', predicted: { latency: 2.2, quality: 0.94, failureRisk: 0.02 }, admissible: true, utility: 0.884 },
      { engine: 'minizinc-csp', predicted: { latency: 8.5, quality: 1, failureRisk: 0.45 }, admissible: false, utility: 0.65, rejectionReason: 'Failure risk exceeds phase transition threshold' },
    ],
    predictedMetrics: { latency: 2.2 },
    actualMetrics: { actualLatency: 2.15, actualQuality: 0.94 },
    residuals: { latency: -0.05, quality: 0 },
    outcome: 'success',
    createdAt: '2026-09-16T18:00:00Z',
  },
  {
    id: 'obs-2',
    jobId: null,
    adaptationLoopId: 'loop-beta',
    engineSelected: 'minizinc-csp',
    workloadFeatures: { S: 30, D_constr: 2.5, N_tasks: 24 },
    candidateEvaluations: [],
    predictedMetrics: {},
    actualMetrics: { actualLatency: 8.2 },
    residuals: { latency: 1.2, quality: -0.1 },
    outcome: 'failure',
    createdAt: '2026-09-16T19:00:00Z',
  },
];

const page = (total = 2, items = OBSERVATIONS) => ({ total, limit: 15, offset: 0, observations: items });
const card = (id: string) => within(screen.getByRole('list', { name: 'Engines' })).getByRole('listitem', { name: id });

describe('admin-routing · how the AutoRouter is doing', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminGetEngineRoutingMetrics.mockResolvedValue(METRICS);
    api.adminListEngineRoutingObservations.mockResolvedValue(page());
    api.adminRecalibrateEngineRouting.mockResolvedValue({
      status: 'recalibrated', recalibratedAt: '2026-09-16T18:30:00Z', observationsProcessed: 42, calibratedEngines: ['evolutionary-heuristics', 'minizinc-csp'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the router’s health and each engine as the router monitors it', async () => {
    renderAdmin(<AdminRouting />);
    expect(screen.getByRole('heading', { level: 1, name: 'Engine routing' })).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Engines' });
    const health = screen.getByLabelText('Router health');
    expect(within(health).getByText('Monitored engines').nextSibling).toHaveTextContent('3');
    expect(within(health).getByText('Degraded').nextSibling).toHaveTextContent('1');
    expect(within(health).getByText('Running now').nextSibling).toHaveTextContent('4');

    expect(within(card('evolutionary-heuristics')).getByText('HEALTHY')).toBeInTheDocument();
    expect(within(card('evolutionary-heuristics')).getByText('95%')).toBeInTheDocument();
    expect(within(card('evolutionary-heuristics')).getByText('2.15 s')).toBeInTheDocument();
    expect(within(card('evolutionary-heuristics')).getByText(/Stable · S⁺ 0\.12/)).toBeInTheDocument();
    expect(within(card('minizinc-csp')).getByText('Drift alarm')).toBeInTheDocument();
    expect(within(card('degraded-engine')).getByText('DEGRADED')).toBeInTheDocument();
    expect(within(card('degraded-engine')).getByText('Offline')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Administration' }).querySelector('[aria-current="page"]')).toHaveTextContent('Engine routing');
  });

  it('plots the run times of the observations shown, and counts the ones that failed', async () => {
    renderAdmin(<AdminRouting />);
    await screen.findByRole('list', { name: 'Engines' });
    expect(within(card('evolutionary-heuristics')).getByText('evolutionary-heuristics: 1 run time in the observations shown, 0 failed.')).toBeInTheDocument();
    expect(within(card('minizinc-csp')).getByText('minizinc-csp: 1 run time in the observations shown, 1 failed.')).toBeInTheDocument();
    expect(within(card('degraded-engine')).getByText('degraded-engine: no run times in the observations shown.')).toBeInTheDocument();
    expect(card('minizinc-csp').querySelectorAll('.adm-dots > span.is-failed')).toHaveLength(1);
  });

  it('lists the observations with the workload and how far the prediction was off, and opens the candidates of one', async () => {
    renderAdmin(<AdminRouting />);
    const first = await screen.findByRole('row', { name: 'evolutionary-heuristics obs-1' });
    expect(within(first).getByText('success')).toBeInTheDocument();
    expect(within(first).getByText(/S 12\.5/)).toHaveTextContent('S 12.5 · Dc 1.80 · 10 tasks');
    expect(within(first).getByText('-0.05 s · 0.00')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: 'minizinc-csp obs-2' })).getByText('failure')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–2 of 2 observations')).toBeInTheDocument();

    fireEvent.click(within(first).getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('loop-alpha')).toBeInTheDocument();
    expect(screen.getByText('job-101')).toBeInTheDocument();
    const candidates = screen.getByRole('region', { name: 'Candidate solver evaluations' });
    expect(within(candidates).getByText('Failure risk exceeds phase transition threshold')).toBeInTheDocument();
    expect(within(candidates).getByText('0.884')).toBeInTheDocument();
    expect(within(candidates).getByText('Rejected')).toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('loop-alpha')).not.toBeInTheDocument();
  });

  it('narrows the observations to one engine and pages through them', async () => {
    api.adminListEngineRoutingObservations.mockResolvedValue(page(40, OBSERVATIONS.slice(0, 1)));
    renderAdmin(<AdminRouting />);
    await screen.findByRole('row', { name: 'evolutionary-heuristics obs-1' });
    expect(api.adminListEngineRoutingObservations).toHaveBeenLastCalledWith({ engine: undefined, limit: 15, offset: 0 });
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.adminListEngineRoutingObservations).toHaveBeenLastCalledWith({ engine: undefined, limit: 15, offset: 15 }));
    const filter = screen.getByRole('group', { name: 'Engine' });
    fireEvent.click(within(filter).getByRole('button', { name: 'minizinc-csp' }));
    await waitFor(() => expect(api.adminListEngineRoutingObservations).toHaveBeenLastCalledWith({ engine: 'minizinc-csp', limit: 15, offset: 0 }));
    expect(within(filter).getByRole('button', { name: 'minizinc-csp' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('recalibrates only after a confirmation, and shows what the gateway did', async () => {
    renderAdmin(<AdminRouting />);
    await screen.findByRole('list', { name: 'Engines' });
    fireEvent.click(screen.getByRole('button', { name: 'Recalibrate…' }));
    const dialog = screen.getByRole('dialog', { name: 'Recalibrate the router?' });
    expect(within(dialog).getByText(/It refits on all 2 observations/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.adminRecalibrateEngineRouting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Recalibrate…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recalibrate' }));
    await waitFor(() => expect(api.adminRecalibrateEngineRouting).toHaveBeenCalledOnce());
    const result = await screen.findByLabelText('Recalibration result');
    expect(within(result).getByText('recalibrated')).toBeInTheDocument();
    expect(within(result).getByText('42')).toBeInTheDocument();
    expect(within(result).getByText('evolutionary-heuristics, minizinc-csp')).toBeInTheDocument();
    await waitFor(() => expect(api.adminGetEngineRoutingMetrics).toHaveBeenCalledTimes(2));
  });

  it('says when a recalibration fails', async () => {
    api.adminRecalibrateEngineRouting.mockRejectedValue(refusal(503, 'router_unavailable', 'The router did not answer.'));
    renderAdmin(<AdminRouting />);
    await screen.findByRole('list', { name: 'Engines' });
    fireEvent.click(screen.getByRole('button', { name: 'Recalibrate…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recalibrate' }));
    expect(await screen.findByText('A service isn’t available right now (503 · router_unavailable)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Recalibration result')).not.toBeInTheDocument();
  });

  it('words a failure to read the metrics, and says suggestions keep working', async () => {
    api.adminGetEngineRoutingMetrics.mockRejectedValueOnce(refusal(500, 'router_error', 'boom'));
    renderAdmin(<AdminRouting />);
    expect(await screen.findByText('Routing metrics couldn’t be loaded')).toBeInTheDocument();
    expect(screen.getByText(/Engine suggestions keep working with the last calibration/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Engines' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Engines' })).toBeInTheDocument();
  });

  it('says when nothing has been observed yet', async () => {
    api.adminGetEngineRoutingMetrics.mockResolvedValue({ summary: { totalEngines: 0, healthyEngines: 0, degradedEngines: 0, activeJobs: 0 }, engines: {} });
    api.adminListEngineRoutingObservations.mockResolvedValue(page(0, []));
    renderAdmin(<AdminRouting />);
    expect(await screen.findByText('No observations yet')).toBeInTheDocument();
    expect(screen.getByText(/needs finished runs before it can calibrate/)).toBeInTheDocument();
  });

  it('tells a key without the permission so, with no retry', async () => {
    api.adminGetEngineRoutingMetrics.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    api.adminListEngineRoutingObservations.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminRouting />);
    expect((await screen.findAllByText('This key can’t use administration (403)')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminRouting />, { user: LUCIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(api.adminGetEngineRoutingMetrics).not.toHaveBeenCalled();
    expect(api.adminListEngineRoutingObservations).not.toHaveBeenCalled();
  });
});

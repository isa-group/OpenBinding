import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminUserView } from '../../api/auth';
import { AdminUsageDashboard } from './AdminUsageDashboard';
import type { AdminTelemetryState } from './types';

const mockUsers: AdminUserView[] = [
  {
    id: 'user-1',
    username: 'alice',
    email: 'alice@institution.edu',
    role: 'user',
    is_active: true,
    plan: 'PRO',
    created_at: '2026-01-01T00:00:00Z',
    contract_pending: false,
    api_key_count: 2,
    cas_verified: true,
  },
  {
    id: 'user-2',
    username: 'carol-research',
    email: 'carol@lab.org',
    role: 'user',
    is_active: true,
    plan: 'RESEARCH',
    created_at: '2026-02-01T00:00:00Z',
    contract_pending: false,
    api_key_count: 1,
    cas_verified: true,
  },
];

const mockTelemetry: AdminTelemetryState = {
  timeHorizon: 'week',
  isLive: true,
  lastUpdated: new Date('2026-09-06T12:00:00Z'),
  points: [
    {
      timestamp: '2026-09-01T00:00:00Z',
      label: 'Mon',
      builtinExecutionSeconds: 460,
      builtinJobs: 12,
      publicFederatedExecutionSeconds: 280,
      publicFederatedJobs: 6,
      privateExecutionSeconds: 310,
      privateRequests: 8,
      privateFlowRateReqPerMin: 22,
      privateThroughputKb: 512,
      totalExecutionSeconds: 1050,
      totalJobs: 18,
      studyJobs: 12,
      studyExecutionSeconds: 720,
      singleCaseJobs: 6,
      singleCaseExecutionSeconds: 330,
    },
    {
      timestamp: '2026-09-02T00:00:00Z',
      label: 'Tue',
      builtinExecutionSeconds: 520,
      builtinJobs: 15,
      publicFederatedExecutionSeconds: 310,
      publicFederatedJobs: 8,
      privateExecutionSeconds: 380,
      privateRequests: 10,
      privateFlowRateReqPerMin: 28,
      privateThroughputKb: 640,
      totalExecutionSeconds: 1210,
      totalJobs: 23,
      studyJobs: 14,
      studyExecutionSeconds: 840,
      singleCaseJobs: 9,
      singleCaseExecutionSeconds: 370,
    },
  ],
  builtinEngines: [
    {
      engineId: 'admin/builtin-exact',
      name: 'BIM Exact Solver (B&B)',
      version: '1.0.0',
      category: 'builtin',
      executionSeconds: 620,
      jobCount: 16,
      completedJobs: 15,
      failedJobs: 1,
      runningJobs: 1,
      avgDurationSeconds: 38.7,
      userCount: 2,
    },
    {
      engineId: 'admin/gecode',
      name: 'Gecode Constraint Engine',
      version: '6.2.0',
      category: 'builtin',
      executionSeconds: 360,
      jobCount: 11,
      completedJobs: 11,
      failedJobs: 0,
      runningJobs: 0,
      avgDurationSeconds: 32.7,
      userCount: 2,
    },
  ],
  publicFederatedEngines: [
    {
      engineId: 'alice/multi-heuristic@1.0.0',
      name: 'Federated Multi-Heuristic',
      version: '1.0.0',
      category: 'public_federated',
      executionSeconds: 410,
      jobCount: 9,
      completedJobs: 9,
      failedJobs: 0,
      runningJobs: 0,
      avgDurationSeconds: 45.5,
      userCount: 1,
      remoteLatencyMs: 145,
      successRatePercent: 100,
    },
  ],
  privateFederated: {
    totalRequests: 18,
    totalExecutionSeconds: 690,
    activeConcurrency: 2,
    peakFlowRateReqPerMin: 28,
    avgDurationSeconds: 38.3,
    successRatePercent: 99.2,
    bandwidthTransferredMb: 1.1,
    activeSolversCount: 4,
    recentFlowPoints: [
      { time: '11:58', flowRate: 24, activeSlots: 2, avgLatencyMs: 185 },
      { time: '12:00', flowRate: 28, activeSlots: 2, avgLatencyMs: 190 },
    ],
  },
  userSpends: [
    {
      userId: 'user-1',
      username: 'alice',
      email: 'alice@institution.edu',
      plan: 'PRO',
      builtinExecutionSeconds: 580,
      builtinJobs: 15,
      federatedExecutionSeconds: 300,
      federatedJobs: 7,
      totalExecutionSeconds: 880,
      totalJobs: 22,
      studyJobs: 16,
      studyExecutionSeconds: 620,
      singleCaseJobs: 6,
      singleCaseExecutionSeconds: 260,
      quotaUsedSeconds: 880,
      quotaLimitSeconds: 18000,
      quotaUsagePercent: 5,
      isHighSpender: false,
      lastActive: '2026-09-06T11:45:00Z',
    },
    {
      userId: 'user-2',
      username: 'carol-research',
      email: 'carol@lab.org',
      plan: 'RESEARCH',
      builtinExecutionSeconds: 14200,
      builtinJobs: 85,
      federatedExecutionSeconds: 9800,
      federatedJobs: 42,
      totalExecutionSeconds: 24000,
      totalJobs: 127,
      studyJobs: 92,
      studyExecutionSeconds: 17500,
      singleCaseJobs: 35,
      singleCaseExecutionSeconds: 6500,
      quotaUsedSeconds: 24000,
      quotaLimitSeconds: 28000,
      quotaUsagePercent: 86,
      isHighSpender: true,
      lastActive: '2026-09-06T11:55:00Z',
    },
  ],
  totals: {
    builtinExecutionSeconds: 980,
    builtinJobs: 27,
    publicFederatedExecutionSeconds: 590,
    publicFederatedJobs: 14,
    privateExecutionSeconds: 690,
    privateRequests: 18,
    overallExecutionSeconds: 2260,
    overallJobs: 41,
    activeRunningJobs: 1,
  },
  originBreakdown: {
    studyJobs: 26,
    studyExecutionSeconds: 1600,
    singleCaseJobs: 15,
    singleCaseExecutionSeconds: 660,
  },
  advancedMetrics: {
    budgetEfficiencyPercent: 82.4,
    totalRequestedBudgetSeconds: 2750,
    totalActualComputeSeconds: 2260,
    retryRatePercent: 2.8,
    totalRetriedJobs: 1,
    peakConcurrencySlots: 4,
    terminationBreakdown: {
      optimal: 28,
      feasible: 9,
      infeasible: 3,
      unknown: 1,
    },
    avgThroughputReqPerMin: 12,
    activePrivateSolvers: 4,
  },
};

describe('AdminUsageDashboard', { timeout: 30000 }, () => {
  const onTimeHorizonChange = vi.fn();
  const onToggleLive = vi.fn();
  const onInspectUser = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDashboard(props: Partial<React.ComponentProps<typeof AdminUsageDashboard>> = {}) {
    return render(
      <MemoryRouter>
        <AdminUsageDashboard
          telemetry={mockTelemetry}
          timeHorizon="week"
          onTimeHorizonChange={onTimeHorizonChange}
          isLive={true}
          onToggleLive={onToggleLive}
          users={mockUsers}
          onInspectUser={onInspectUser}
          {...props}
        />
      </MemoryRouter>
    );
  }

  it('renders executive KPI cards and defaults to Built-in engines dashboard', () => {
    renderDashboard();

    expect(screen.getByText('Resource Consumption & Spend Dashboards')).toBeInTheDocument();
    expect(screen.getByText('Built-in Solvers')).toBeInTheDocument();
    expect(screen.getByText('Public Federated')).toBeInTheDocument();
    expect(screen.getByText('Private Solver Flow')).toBeInTheDocument();
    expect(screen.getByText('Platform Spend Health')).toBeInTheDocument();

    // Default Built-in panel
    expect(screen.getByTestId('panel-builtin')).toBeInTheDocument();
    expect(screen.getByText('BIM Exact Solver (B&B)')).toBeInTheDocument();
    expect(screen.getByText('Gecode Constraint Engine')).toBeInTheDocument();
  });

  it('allows switching between time horizons', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Real-time' }));
    expect(onTimeHorizonChange).toHaveBeenCalledWith('realtime');

    fireEvent.click(screen.getByRole('button', { name: '30 Days' }));
    expect(onTimeHorizonChange).toHaveBeenCalledWith('month');

    fireEvent.click(screen.getByRole('button', { name: 'Historic' }));
    expect(onTimeHorizonChange).toHaveBeenCalledWith('historic');
  });

  it('switches to Public Federated Engines dashboard', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('tab', { name: /Public Federated Engines/i }));
    expect(screen.getByTestId('panel-public-federated')).toBeInTheDocument();
    expect(screen.getByText('Federated Multi-Heuristic')).toBeInTheDocument();
    expect(screen.getByText('alice/multi-heuristic@1.0.0')).toBeInTheDocument();
    expect(screen.getByText('145ms')).toBeInTheDocument();
  });

  it('switches to Private Solvers Telemetry and preserves confidentiality', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('tab', { name: /Private Solvers Telemetry/i }));
    expect(screen.getByTestId('panel-private-federated')).toBeInTheDocument();
    expect(screen.getByText('Confidential Solver Telemetry (Privacy Preserved)')).toBeInTheDocument();
    expect(screen.getByText(/As an administrator, you cannot inspect private federated engine configurations/i)).toBeInTheDocument();
    expect(screen.getAllByText('28 req/m').length).toBeGreaterThanOrEqual(1);
  });

  it('switches to Unified Comparative Analysis', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('tab', { name: /Unified Comparative Analysis/i }));
    expect(screen.getByTestId('panel-unified')).toBeInTheDocument();
    expect(screen.getByText('Platform-Wide Compute Allocation')).toBeInTheDocument();
    expect(screen.getByText('Execution Seconds by Engine Tier (week)')).toBeInTheDocument();
  });

  it('filters users by search and triggers contract inspection', () => {
    renderDashboard();

    const userTable = screen.getByTestId('user-spend-table');
    expect(within(userTable).getByText('alice')).toBeInTheDocument();
    expect(within(userTable).getByText('carol-research')).toBeInTheDocument();

    const searchInput = screen.getByLabelText('Filter user spend accounts');
    fireEvent.change(searchInput, { target: { value: 'carol' } });

    expect(within(userTable).queryByText('alice')).not.toBeInTheDocument();
    expect(within(userTable).getByText('carol-research')).toBeInTheDocument();

    const contractBtn = within(userTable).getByTitle('Manage contract and quotas for carol-research');
    fireEvent.click(contractBtn);
    expect(onInspectUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'carol-research', id: 'user-2' })
    );
  });

  it('supports exporting telemetry summary as JSON', () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURLMock = vi.fn();
    window.URL.createObjectURL = createObjectURLMock;
    window.URL.revokeObjectURL = revokeObjectURLMock;

    renderDashboard();

    const exportBtn = screen.getByRole('button', { name: /Export JSON/i });
    fireEvent.click(exportBtn);
    expect(createObjectURLMock).toHaveBeenCalledOnce();
    expect(revokeObjectURLMock).toHaveBeenCalledOnce();
  });

  it('renders executive origin breakdown and advanced telemetry strip', () => {
    renderDashboard();

    // Origin breakdown: Studies vs Direct Cases
    expect(screen.getByText('26 Studies')).toBeInTheDocument();
    expect(screen.getByText('15 Direct')).toBeInTheDocument();

    // Budget efficiency
    expect(screen.getByText('82.4%')).toBeInTheDocument();

    // Solve Quality breakdown
    expect(screen.getByText('28 Opt')).toBeInTheDocument();
    expect(screen.getByText('9 Feas')).toBeInTheDocument();
    expect(screen.getByText('3 Inf')).toBeInTheDocument();

    // Reliability & Concurrency
    expect(screen.getByText('2.8% Retries')).toBeInTheDocument();
    expect(screen.getByText('4 Slots Peak')).toBeInTheDocument();
  });

  it('allows toggling origin filter pills', () => {
    renderDashboard();

    const allPill = screen.getByRole('button', { name: 'All Invocations' });
    const studiesPill = screen.getByRole('button', { name: /Studies \(Matrix\)/i });
    const casesPill = screen.getByRole('button', { name: /Single Cases \(Direct\)/i });

    expect(allPill).toHaveClass('active');
    expect(studiesPill).not.toHaveClass('active');

    fireEvent.click(studiesPill);
    expect(studiesPill).toHaveClass('active');
    expect(allPill).not.toHaveClass('active');

    fireEvent.click(casesPill);
    expect(casesPill).toHaveClass('active');
    expect(studiesPill).not.toHaveClass('active');
  });
});

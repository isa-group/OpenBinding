import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminErrorDiagnostics } from './AdminErrorDiagnostics';
import type { AdminErrorOverview, AdminErrorListResponse, ApiErrorEventItem } from './types';
import { apiClient } from '../../api/client';

const mockOverview: AdminErrorOverview = {
  total_errors_24h: 42,
  by_category_24h: {
    pricing_quota: 15,
    concurrency: 8,
    solver_failure: 12,
    system_bug: 7,
  },
  by_status_code_24h: {
    '402': 15,
    '429': 8,
    '500': 7,
    '502': 12,
  },
  top_users_quota: [
    {
      userId: 'user-vip-1',
      email: 'lead.scientist@pharma.org',
      errorCount: 10,
    },
  ],
  top_solvers_failed: [],
  timeline: [
    {
      timestamp: '2026-09-07T12:00:00Z',
      quota: 3,
      concurrency: 1,
      solver: 2,
      system: 0,
      validation: 0,
    },
  ],
};

const mockEvents: ApiErrorEventItem[] = [
  {
    id: 'err-1',
    created_at: '2026-09-07T13:00:00Z',
    createdAt: '2026-09-07T13:00:00Z',
    status_code: 402,
    statusCode: 402,
    error_code: 'quota_exceeded',
    errorCode: 'quota_exceeded',
    category: 'pricing_quota',
    http_method: 'POST',
    httpMethod: 'POST',
    endpoint: '/v1/jobs',
    user_id: 'user-vip-1',
    userId: 'user-vip-1',
    user_email: 'lead.scientist@pharma.org',
    userEmail: 'lead.scientist@pharma.org',
    detail: {
      error: 'Monthly quota exhausted for limit taskStarts',
      quota: {
        limit_id: 'taskStarts',
        limit: 100,
        used: 100,
        unit: 'job',
        renews_at: '2026-10-01T00:00:00Z',
      },
    },
  },
  {
    id: 'err-2',
    created_at: '2026-09-07T13:05:00Z',
    createdAt: '2026-09-07T13:05:00Z',
    status_code: 429,
    statusCode: 429,
    error_code: 'concurrency_limit_exceeded',
    errorCode: 'concurrency_limit_exceeded',
    category: 'concurrency',
    http_method: 'POST',
    httpMethod: 'POST',
    endpoint: '/v1/jobs',
    user_id: 'user-dev-2',
    userId: 'user-dev-2',
    user_email: 'dev@startup.io',
    userEmail: 'dev@startup.io',
    detail: {
      error: 'Concurrency limit reached (2/2 active slots)',
      concurrency: {
        limit_id: 'concurrentJobs',
        limit: 2,
        used: 2,
      },
    },
  },
  {
    id: 'err-3',
    created_at: '2026-09-07T13:10:00Z',
    createdAt: '2026-09-07T13:10:00Z',
    status_code: 502,
    statusCode: 502,
    error_code: 'solver_crash',
    errorCode: 'solver_crash',
    category: 'solver_failure',
    http_method: 'POST',
    httpMethod: 'POST',
    endpoint: '/v1/jobs/job-999/execute',
    user_id: 'user-vip-1',
    userId: 'user-vip-1',
    user_email: 'lead.scientist@pharma.org',
    userEmail: 'lead.scientist@pharma.org',
    detail: {
      error: 'Solver container terminated with exit code 137 (OOM)',
      engine: 'openbinding/diffdock-v1',
    },
  },
];

const mockListResponse: AdminErrorListResponse = {
  items: mockEvents,
  total: 3,
  offset: 0,
  limit: 20,
};

describe('AdminErrorDiagnostics Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiClient, 'adminErrorOverview').mockResolvedValue(mockOverview);
    vi.spyOn(apiClient, 'adminListErrors').mockResolvedValue(mockListResponse);
  });

  it('renders executive KPI cards and status overview', async () => {
    render(<AdminErrorDiagnostics />);

    await waitFor(() => {
      expect(screen.getByText('Quota, Concurrency & Incident Diagnostics')).toBeInTheDocument();
    });

    // Check KPI counts
    expect(screen.getByText('15')).toBeInTheDocument(); // Quota
    expect(screen.getByText('8')).toBeInTheDocument();  // Concurrency
    expect(screen.getByText('12')).toBeInTheDocument(); // Solver
    expect(screen.getByText('7')).toBeInTheDocument();  // System

    // Check titles
    expect(screen.getByText('Commercial Quotas Spent')).toBeInTheDocument();
    expect(screen.getByText('Concurrency Slots Full')).toBeInTheDocument();
    expect(screen.getByText('Job Execution Failures')).toBeInTheDocument();
    expect(screen.getByText('Platform & Upstream Faults')).toBeInTheDocument();
  });

  it('renders top quota prospects and calls onInspectUser on click', async () => {
    const onInspectUser = vi.fn();
    render(<AdminErrorDiagnostics onInspectUser={onInspectUser} />);

    await waitFor(() => {
      expect(screen.getAllByText('lead.scientist@pharma.org').length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByText('10 refusals')).toBeInTheDocument();

    const novateBtn = screen.getByRole('button', { name: /Novate Plan/i });
    fireEvent.click(novateBtn);

    expect(onInspectUser).toHaveBeenCalledWith('user-vip-1');
  });

  it('allows switching between diagnostic tabs and filters table', async () => {
    const { container } = render(<AdminErrorDiagnostics />);

    await waitFor(() => {
      expect(screen.getAllByText('/v1/jobs').length).toBeGreaterThanOrEqual(1);
    });

    const tabsBar = container.querySelector('.diagnostics-tabs-bar');
    expect(tabsBar).not.toBeNull();

    // Switch to Solver tab
    const solverTab = within(tabsBar as HTMLElement).getByRole('button', { name: /Solver Crashes/i });
    fireEvent.click(solverTab);

    await waitFor(() => {
      expect(apiClient.adminListErrors).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'solver_failure' })
      );
    });

    // Switch to Pricing & Quotas tab
    const quotaTab = within(tabsBar as HTMLElement).getByRole('button', { name: /Pricing & Quotas/i });
    fireEvent.click(quotaTab);

    await waitFor(() => {
      expect(apiClient.adminListErrors).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'pricing_quota' })
      );
    });
  });

  it('opens Error Inspector drawer when clicking an error row and displays JSON', async () => {
    render(<AdminErrorDiagnostics />);

    await waitFor(() => {
      expect(screen.getByText('quota_exceeded')).toBeInTheDocument();
    });

    // Click on the row with quota_exceeded
    const row = screen.getByText('quota_exceeded').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    // Drawer should appear
    await waitFor(() => {
      expect(screen.getByText('INCIDENT INSPECTOR')).toBeInTheDocument();
    });

    expect(screen.getAllByText('user-vip-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('402').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Monthly quota exhausted for limit taskStarts/)).toBeInTheDocument();

    // Close button
    const closeBtn = screen.getByTitle('Close drawer');
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('INCIDENT INSPECTOR')).not.toBeInTheDocument();
    });
  });

  it('filters by search input', async () => {
    render(<AdminErrorDiagnostics />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Filter by endpoint/i)).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Filter by endpoint/i);
    fireEvent.change(searchInput, { target: { value: 'diffdock' } });

    await waitFor(() => {
      expect(apiClient.adminListErrors).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'diffdock' })
      );
    });
  });
});

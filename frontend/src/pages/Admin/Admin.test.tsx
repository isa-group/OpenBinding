import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineRegistrationRevision } from '../../api/client';
import { Admin } from './Admin';
import { LUCIA, queuesAt } from './adminFixtures';
import { renderAdmin } from './adminTestUtils';

// What the old administration console did that the overview still carries: the review of engine publication requests,
// and the way to the pricing control room. The overview’s own blocks are tested in AdminOverview.test.tsx.

const api = vi.hoisted(() => ({
  adminOverview: vi.fn(),
  adminQueues: vi.fn(),
  adminModeration: vi.fn(),
  adminErrorOverview: vi.fn(),
  getCurrentPricing: vi.fn(),
  adminListEngineRegistrations: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  adminApproveEngineRegistration: vi.fn(),
  adminRejectEngineRegistration: vi.fn(),
  adminMaintenancePreview: vi.fn(),
}));

const platform = vi.hoisted(() => ({ pricingControlRoom: vi.fn() }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

vi.mock('../../api/platform', async () => ({
  ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'),
  platformApi: platform,
}));

configure({ asyncUtilTimeout: 5000 });

function registration(namespace: string, name: string, status: EngineRegistrationRevision['status']): EngineRegistrationRevision {
  return { namespace, name, version: '1.0.0', digest: `sha256-${name.padEnd(64, 'a').slice(0, 64)}`, status, active: true };
}

const row = () => screen.getByRole('row', { name: 'alice/pending-foreign' });

describe('EngineRegistration administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminListEngineRegistrations.mockResolvedValue([registration('alice', 'pending-foreign', 'pending_review')]);
    api.getEngineRegistrationReport.mockResolvedValue({
      ...registration('alice', 'pending-foreign', 'pending_review'),
      openapiDigest: `sha256-${'b'.repeat(64)}`,
      openapi: { openapi: '3.1.0' },
      engine: { apiVersion: 'bim/v1', kind: 'Engine', metadata: { namespace: 'alice', name: 'solver', version: '1.0.0' }, spec: { modes: [] } },
      report: { status: 'verified' },
    });
    api.adminApproveEngineRegistration.mockResolvedValue(registration('alice', 'pending-foreign', 'published'));
    api.adminRejectEngineRegistration.mockResolvedValue(registration('alice', 'pending-foreign', 'rejected'));
    api.adminOverview.mockResolvedValue({ counts: {}, jobs: {}, contracts: {}, recentAudit: [] });
    api.adminQueues.mockImplementation(async () => queuesAt(Date.now()));
    api.adminModeration.mockResolvedValue({ engines: {}, dialects: {}, registrations: { pending_review: 1 } });
    api.adminErrorOverview.mockResolvedValue({ total_errors_24h: 0, by_category_24h: {}, by_status_code_24h: {}, top_users_quota: [], top_solvers_failed: [], timeline: [] });
    api.getCurrentPricing.mockResolvedValue({ version: '0.1.0', digest: 'sha256-x', url: 'https://sphere.example.test/0.1.0' });
    platform.pricingControlRoom.mockResolvedValue({ sphere: { enabled: true, reachable: true }, space: { enabled: true, reachable: true }, live: '0.1.0', releases: [] });
    api.adminMaintenancePreview.mockResolvedValue({ expiredArtifacts: 0, expiredApiKeys: 0, terminalJobs: 0, abandonedJobs: 0, terminalJobCutoff: '2026-01-01T00:00:00Z' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows only explicit publication requests and moderation actions', async () => {
    renderAdmin(<Admin />);

    await waitFor(() => expect(api.adminListEngineRegistrations).toHaveBeenCalled());
    expect(api.adminListEngineRegistrations).toHaveBeenCalledWith();
    expect(screen.queryByText('Show every registration')).not.toBeInTheDocument();
    expect(await screen.findByRole('row', { name: 'alice/pending-foreign' })).toBeInTheDocument();
    expect(within(row()).getByRole('button', { name: 'Review contract' })).toBeInTheDocument();
    expect(within(row()).getByRole('button', { name: 'Approve publication' })).toBeInTheDocument();
    expect(within(row()).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    fireEvent.click(within(row()).getByRole('button', { name: 'Review contract' }));
    expect(await screen.findByText('Verification report')).toBeInTheDocument();
    expect(api.getEngineRegistrationReport).toHaveBeenCalledOnce();
    expect(screen.getByText('Submitted OpenAPI')).toBeInTheDocument();
  }, 30000);

  it('approves a publication request only after a confirmation', async () => {
    renderAdmin(<Admin />);
    await screen.findByRole('row', { name: 'alice/pending-foreign' });
    fireEvent.click(within(row()).getByRole('button', { name: 'Approve publication' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish alice/pending-foreign?' });
    expect(api.adminApproveEngineRegistration).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve publication' }));
    await waitFor(() => expect(api.adminApproveEngineRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'alice', name: 'pending-foreign', status: 'pending_review' }),
    ));
    expect(await screen.findByText('alice/pending-foreign@1.0.0 is published.')).toBeInTheDocument();
  }, 30000);

  it('requires confirmation before rejecting a publication request', async () => {
    renderAdmin(<Admin />);
    await screen.findByRole('row', { name: 'alice/pending-foreign' });

    fireEvent.click(within(row()).getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject publication of alice/pending-foreign?' });
    expect(within(dialog).getByText(/The registration will become private to its owner again/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.adminRejectEngineRegistration).not.toHaveBeenCalled();

    fireEvent.click(within(row()).getByRole('button', { name: 'Reject' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.adminRejectEngineRegistration).toHaveBeenCalledOnce());
    expect(await screen.findByText('alice/pending-foreign@1.0.0 was rejected and is private again.')).toBeInTheDocument();
  }, 30000);

  it('keeps the way to the pricing control room', async () => {
    renderAdmin(<Admin />);
    const pricing = await screen.findByRole('region', { name: 'Pricing' });
    expect(await within(pricing).findByText('0.1.0')).toBeInTheDocument();
    expect(within(pricing).getByRole('link', { name: 'Control room' })).toHaveAttribute('href', '/app/admin/pricing');
  }, 30000);

  it('shows a person who is not an administrator nothing', async () => {
    renderAdmin(<Admin />, { user: LUCIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'alice/pending-foreign' })).not.toBeInTheDocument();
    expect(api.adminListEngineRegistrations).not.toHaveBeenCalled();
  });
});

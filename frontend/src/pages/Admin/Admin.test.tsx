import { configure, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOverview as Admin } from './AdminOverview';
import { MARIA, queuesAt } from '../../test/fixtures/admin';
import { renderAdmin } from './adminTestUtils';
import { config } from '../../config';

// The old administration console reviewed engine publications and maintained the platform. Those live on their own
// screens now (AdminModeration, AdminMaintenance); what the console name still leads to is the overview, which
// keeps a block that counts what waits and the way to each of them. The overview’s own blocks are tested in AdminOverview.test.tsx.

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

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

describe('the administration console, now the overview', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminOverview.mockResolvedValue({ counts: {}, jobs: {}, contracts: {}, recentAudit: [] });
    api.adminQueues.mockImplementation(async () => queuesAt(Date.now()));
    api.adminModeration.mockResolvedValue({ engines: {}, dialects: {}, registrations: { pending_review: 1 } });
    api.adminErrorOverview.mockResolvedValue({ total_errors_24h: 0, by_category_24h: {}, by_status_code_24h: {}, top_users_quota: [], top_solvers_failed: [], timeline: [] });
    api.getCurrentPricing.mockResolvedValue({ version: '0.1.0', digest: 'sha256-x', url: 'https://sphere.example.test/0.1.0' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts the publication requests that wait and leads to the screen that reviews them', async () => {
    renderAdmin(<Admin />);
    const moderation = await screen.findByRole('region', { name: 'Moderation' });
    const lines = await within(moderation).findByRole('list', { name: 'Waiting for review' });
    expect(within(within(lines).getByText('Engine publication requests').closest('li')!).getByText('1')).toBeInTheDocument();
    expect(within(moderation).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/admin/moderation');
    expect(screen.queryByRole('row', { name: /pending/ })).not.toBeInTheDocument();
    expect(api.adminListEngineRegistrations).not.toHaveBeenCalled();
    expect(api.getEngineRegistrationReport).not.toHaveBeenCalled();
    expect(api.adminApproveEngineRegistration).not.toHaveBeenCalled();
    expect(api.adminRejectEngineRegistration).not.toHaveBeenCalled();
  });

  it('keeps the way to the native pricing consoles', async () => {
    renderAdmin(<Admin />);
    const pricing = await screen.findByRole('region', { name: 'Pricing' });
    expect(await within(pricing).findByText('0.1.0')).toBeInTheDocument();
    expect(within(pricing).getByRole('link', { name: 'Open SPACE console' })).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(within(pricing).getByRole('link', { name: 'Open SPHERE console' })).toHaveAttribute('href', config.sphereUrl);
  });

  it('shows a person who is not an administrator nothing', async () => {
    renderAdmin(<Admin />, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(api.adminListEngineRegistrations).not.toHaveBeenCalled();
  });
});

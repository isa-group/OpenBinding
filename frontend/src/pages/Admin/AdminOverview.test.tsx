import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview as OverviewAnswer } from '../../api/auth';
import { AdminOverview } from './AdminOverview';
import { config } from '../../config';
import { ALEX, ERROR_OVERVIEW, MARIA, MODERATION, queuesAt } from '../../test/fixtures/admin';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminOverview: vi.fn(),
  adminQueues: vi.fn(),
  adminModeration: vi.fn(),
  adminErrorOverview: vi.fn(),
  getCurrentPricing: vi.fn(),
  adminListEngineRegistrations: vi.fn(),
  adminMaintenancePreview: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

const OVERVIEW: OverviewAnswer = {
  counts: { users: 7, apiKeys: 9, identities: 3, organizations: 3, projects: 5, cases: 4, studies: 2, studyRuns: 3, artifacts: 12 },
  jobs: { queued: 1, running: 1, completed: 2, failed: 1, cancelled: 1 },
  contracts: { BASIC: 3, ADVANCED: 1, RESEARCH: 1, PRO: 2 },
  recentAudit: [
    { id: 'a1', action: 'contract.subscription.changed', targetType: 'User', targetId: MARIA.id, actorId: ALEX.id, createdAt: '2026-09-01T09:00:00Z' },
  ],
};

const block = (name: string) => screen.getByRole('region', { name });

describe('admin-overview · how the platform is doing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminOverview.mockResolvedValue(OVERVIEW);
    api.adminQueues.mockImplementation(async () => queuesAt(Date.now()));
    api.adminModeration.mockResolvedValue(MODERATION);
    api.adminErrorOverview.mockResolvedValue(ERROR_OVERVIEW);
    api.getCurrentPricing.mockResolvedValue({ version: '0.1.0', digest: 'sha256-x', url: 'https://sphere.example.test/0.1.0' });
    api.adminListEngineRegistrations.mockResolvedValue([]);
    api.adminMaintenancePreview.mockResolvedValue({ expiredArtifacts: 0, expiredApiKeys: 0, terminalJobs: 0, abandonedJobs: 0, terminalJobCutoff: '2026-01-01T00:00:00Z' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows how many accounts there are and how they divide by plan', async () => {
    renderAdmin(<AdminOverview />);
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    const accounts = block('Accounts');
    expect(await within(accounts).findByText('7')).toBeInTheDocument();
    expect(within(accounts).getByText('3 BASIC')).toBeInTheDocument();
    expect(within(accounts).getByText('2 PRO')).toBeInTheDocument();
    expect(within(accounts).getByRole('img', { name: 'Accounts by plan: BASIC 3, ADVANCED 1, RESEARCH 1, PRO 2' })).toBeInTheDocument();
    expect(within(accounts).getByText('9 API keys · 3 linked identities')).toBeInTheDocument();
    expect(within(accounts).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/admin/users');
  });

  it('shows the queue by state and the oldest job waiting', async () => {
    renderAdmin(<AdminOverview />);
    const queue = block('Job queue');
    expect(await within(queue).findByRole('img', { name: 'Queued: 1, Running: 1, Done: 2, Failed: 1, Cancelled: 1' })).toBeInTheDocument();
    expect(within(queue).getByText(/Oldest waiting: minizinc job, running for about 1 day/)).toBeInTheDocument();
    expect(within(queue).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/admin/queues');
  });

  it('counts what waits for moderation, and flags the block when something does', async () => {
    renderAdmin(<AdminOverview />);
    const moderation = block('Moderation');
    expect(await within(moderation).findByText('Engine publication requests')).toBeInTheDocument();
    const lines = within(moderation).getByRole('list', { name: 'Waiting for review' });
    expect(within(within(lines).getByText('Engine publication requests').closest('li')!).getByText('1')).toBeInTheDocument();
    expect(within(within(lines).getByText('Dialects').closest('li')!).getByText('1')).toBeInTheDocument();
    expect(within(moderation).getByText('2')).toBeInTheDocument();
    expect(moderation).toHaveClass('is-attention');
  });

  it('summarises the errors of the last 24 hours and links to diagnose them', async () => {
    renderAdmin(<AdminOverview />);
    const errors = block('Errors, last 24 h');
    expect(await within(errors).findByText('9 events in total')).toBeInTheDocument();
    expect(within(errors).getByText('402')).toBeInTheDocument();
    expect(within(errors).getByText('5')).toBeInTheDocument();
    expect(within(errors).getByRole('link', { name: 'Diagnose errors' })).toHaveAttribute('href', '/app/admin/errors');
  });

  it('shows the LIVE pricing and links to the native SPACE and SPHERE consoles', async () => {
    renderAdmin(<AdminOverview />);
    const pricing = block('Pricing');
    expect(await within(pricing).findByText('0.1.0')).toBeInTheDocument();
    expect(within(pricing).getByText(/A 0\.x release is a development copy/)).toBeInTheDocument();
    expect(within(pricing).getByRole('link', { name: 'Open SPACE console' })).toHaveAttribute('href', config.spaceFrontendUrl);
    expect(within(pricing).getByRole('link', { name: 'Open SPHERE console' })).toHaveAttribute('href', config.sphereUrl);
    expect(within(pricing).getByRole('link', { name: 'Open SPACE console' })).toHaveAttribute('target', '_blank');
  });

  it('lets the pricing block fail on its own when the public pricing is not served', async () => {
    api.getCurrentPricing.mockRejectedValue(refusal(404, 'not_found'));
    renderAdmin(<AdminOverview />);
    expect(await within(block('Pricing')).findByText('This block couldn’t load')).toBeInTheDocument();
    expect(await within(block('Accounts')).findByText('7')).toBeInTheDocument();
  });

  it('lists the most recent changes of the audit log', async () => {
    renderAdmin(<AdminOverview />);
    const recent = block('Recent changes');
    expect(await within(recent).findByText('contract.subscription.changed')).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/app/admin/audit');
  });

  it('shows the platform in numbers', async () => {
    renderAdmin(<AdminOverview />);
    const numbers = await screen.findByRole('region', { name: 'The platform in numbers' });
    await waitFor(() => expect(within(numbers).getByText('12')).toBeInTheDocument());
    expect(within(numbers).getByText('Stored artifacts')).toBeInTheDocument();
    expect(within(numbers).getByText('Binding cases')).toBeInTheDocument();
  });

  it('opens every administration tool, with the ids and routes of the prototype', async () => {
    renderAdmin(<AdminOverview />);
    await screen.findByText('Tools');
    const tools = screen.getByRole('heading', { name: 'Tools' }).closest('section')!;
    expect(within(tools).getByRole('link', { name: /^Accounts/ })).toHaveAttribute('href', '/app/admin/users');
    expect(within(tools).getByRole('link', { name: /^Audit log/ })).toHaveAttribute('href', '/app/admin/audit');
    expect(within(tools).getByRole('link', { name: /^Errors/ })).toHaveAttribute('href', '/app/admin/errors');
    expect(within(tools).getByRole('link', { name: /^Queues/ })).toHaveAttribute('href', '/app/admin/queues');
    expect(within(tools).getByRole('link', { name: /^Moderation/ })).toHaveAttribute('href', '/app/admin/moderation');
    expect(within(tools).getByRole('link', { name: /^Maintenance/ })).toHaveAttribute('href', '/app/admin/maintenance');
    const sponsorship = within(tools).getByRole('button', { name: 'Open' });
    expect(sponsorship).toBeDisabled();
    fireEvent.change(within(tools).getByLabelText('Organization slug or id'), { target: { value: 'isa-demo' } });
    expect(sponsorship).toBeEnabled();
  });

  it('lets one block fail without taking the rest of the page with it, and retries just that block', async () => {
    api.adminQueues.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderAdmin(<AdminOverview />);
    const queue = block('Job queue');
    expect(await within(queue).findByText('This block couldn’t load')).toBeInTheDocument();
    expect(await within(block('Accounts')).findByText('7')).toBeInTheDocument();
    fireEvent.click(within(queue).getByRole('button', { name: 'Retry this block' }));
    expect(await within(queue).findByText(/Oldest waiting/)).toBeInTheDocument();
    expect(api.adminOverview).toHaveBeenCalledTimes(1);
  });

  it('says when the API key cannot use administration (403) instead of offering a retry', async () => {
    api.adminModeration.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminOverview />);
    const moderation = block('Moderation');
    expect(await within(moderation).findByText('This key can’t use administration (403)')).toBeInTheDocument();
    expect(within(moderation).queryByRole('button', { name: 'Retry this block' })).not.toBeInTheDocument();
  });

  it('refreshes every block', async () => {
    renderAdmin(<AdminOverview />);
    await within(block('Accounts')).findByText('7');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.adminOverview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.adminQueues).toHaveBeenCalledTimes(2));
  });

  it('no longer carries the publication review or maintenance: each has its own screen', async () => {
    renderAdmin(<AdminOverview />);
    await within(block('Moderation')).findByText('Engine publication requests');
    expect(screen.queryByRole('heading', { name: 'Engine publication requests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Maintenance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconcile abandoned jobs' })).not.toBeInTheDocument();
    expect(screen.queryByText('Still here until their own screens arrive')).not.toBeInTheDocument();
    expect(within(block('Moderation')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/admin/moderation');
    expect(api.adminListEngineRegistrations).not.toHaveBeenCalled();
    expect(api.adminMaintenancePreview).not.toHaveBeenCalled();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminOverview />, { user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Administration' })).not.toBeInTheDocument();
    expect(api.adminOverview).not.toHaveBeenCalled();
    expect(api.adminQueues).not.toHaveBeenCalled();
    expect(api.adminListEngineRegistrations).not.toHaveBeenCalled();
    expect(api.getCurrentPricing).not.toHaveBeenCalled();
  });
});

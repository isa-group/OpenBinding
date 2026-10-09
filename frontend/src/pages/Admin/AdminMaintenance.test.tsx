import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminMaintenance } from './AdminMaintenance';
import { LUCIA } from './adminFixtures';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminMaintenancePreview: vi.fn(),
  adminReconcileJobs: vi.fn(),
  adminPurgeExpired: vi.fn(),
  adminReconcileContracts: vi.fn(),
  getCurrentPricing: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

const PREVIEW = { expiredArtifacts: 2, expiredApiKeys: 1, terminalJobs: 14, abandonedJobs: 1, terminalJobCutoff: '2025-10-09T00:00:00Z' };
const NOTHING = { expiredArtifacts: 0, expiredApiKeys: 0, terminalJobs: 0, abandonedJobs: 0, terminalJobCutoff: '2025-10-09T00:00:00Z' };

const retention = () => screen.getByLabelText('Keep finished jobs for (days)');
const tile = async (label: string) => {
  const list = await screen.findByRole('list', { name: 'Maintenance preview' });
  return within(within(list).getByText(label).closest('[role="listitem"]') as HTMLElement);
};

describe('admin-maintenance · preview, purge and reconcile', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminMaintenancePreview.mockResolvedValue(PREVIEW);
    api.adminReconcileJobs.mockResolvedValue({ settled: 1 });
    api.adminPurgeExpired.mockResolvedValue({ artifacts: 2, apiKeys: 1, jobs: 14 });
    api.adminReconcileContracts.mockResolvedValue({ renewed: 2 });
    api.getCurrentPricing.mockResolvedValue({ version: '0.1.0', digest: 'sha256-x', url: 'https://sphere.example.test/0.1.0' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('previews what the default retention would touch, as counted by the server', async () => {
    renderAdmin(<AdminMaintenance />);
    expect(screen.getByRole('heading', { level: 1, name: 'Maintenance' })).toBeInTheDocument();
    expect((await tile('Expired artifacts')).getByText('2')).toBeInTheDocument();
    expect((await tile('Expired API keys')).getByText('1')).toBeInTheDocument();
    const jobs = await tile('Finished jobs to purge');
    expect(jobs.getByText('14')).toBeInTheDocument();
    expect(jobs.getByText('Finished before Oct 9, 2025, more than 365 days ago.')).toBeInTheDocument();
    expect((await tile('Abandoned jobs')).getByText('1')).toBeInTheDocument();
    expect(api.adminMaintenancePreview).toHaveBeenCalledWith(365);
    expect(retention()).toHaveValue('365');
  });

  it('previews another retention, and refuses one the API would refuse', async () => {
    renderAdmin(<AdminMaintenance />);
    await tile('Expired artifacts');
    fireEvent.change(retention(), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(api.adminMaintenancePreview).toHaveBeenCalledWith(30));

    fireEvent.change(retention(), { target: { value: '5' } });
    expect(screen.getByText(/Use a whole number from 7 to 3,650/)).toBeInTheDocument();
    expect(retention()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Try 7 days' }));
    await waitFor(() => expect(api.adminMaintenancePreview).toHaveBeenCalledWith(7));
    expect(retention()).toHaveValue('7');
  });

  it('says when there is nothing to purge', async () => {
    api.adminMaintenancePreview.mockResolvedValue(NOTHING);
    renderAdmin(<AdminMaintenance />);
    expect(await screen.findByText('Nothing to purge with these retention periods.')).toBeInTheDocument();
  });

  it('purges only after the exact phrase is typed, with the retention of jobs and of errors', async () => {
    renderAdmin(<AdminMaintenance />);
    await tile('Expired artifacts');
    const purge = screen.getByRole('button', { name: 'Purge…' });
    await waitFor(() => expect(purge).toBeEnabled());
    expect(screen.getByRole('list', { name: 'What a purge would remove' })).toHaveTextContent('14 finished jobs older than 365 days');
    fireEvent.click(purge);

    const dialog = screen.getByRole('dialog', { name: 'Purge expired data?' });
    const confirm = within(dialog).getByRole('button', { name: 'Purge permanently' });
    expect(confirm).toBeDisabled();
    const typed = within(dialog).getByLabelText(/Type PURGE EXPIRED to confirm/);
    fireEvent.change(typed, { target: { value: 'purge expired' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'PURGE EXPIRED' } });
    expect(confirm).toBeEnabled();
    expect(api.adminPurgeExpired).not.toHaveBeenCalled();
    fireEvent.click(confirm);

    await waitFor(() => expect(api.adminPurgeExpired).toHaveBeenCalledWith('PURGE EXPIRED', 365, 90));
    expect(await screen.findByText('Purged. Recorded in the audit log; the next preview shows what is left.')).toBeInTheDocument();
    const counters = screen.getByLabelText('What was purged');
    expect(within(counters).getByText('Api keys')).toBeInTheDocument();
    expect(within(counters).getByText('14')).toBeInTheDocument();
    await waitFor(() => expect(api.adminMaintenancePreview).toHaveBeenCalledTimes(2));
  });

  it('asks again before purging when the retention changed after the preview', async () => {
    renderAdmin(<AdminMaintenance />);
    await tile('Expired artifacts');
    fireEvent.change(retention(), { target: { value: '30' } });
    expect(screen.getByRole('button', { name: 'Purge…' })).toBeDisabled();
    expect(screen.getByText('Preview first.')).toBeInTheDocument();
    fireEvent.change(retention(), { target: { value: '365' } });
    fireEvent.change(screen.getByLabelText('Keep error events for (days)'), { target: { value: '0' } });
    expect(screen.getByText('Use a whole number from 1 to 3,650.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purge…' })).toBeDisabled();
  });

  it('says what a refused purge did, and that nothing was removed', async () => {
    api.adminPurgeExpired.mockRejectedValue(refusal(409, 'maintenance_running', 'Another run holds the lock.'));
    renderAdmin(<AdminMaintenance />);
    await tile('Expired artifacts');
    fireEvent.click(screen.getByRole('button', { name: 'Purge…' }));
    const dialog = screen.getByRole('dialog', { name: 'Purge expired data?' });
    fireEvent.change(within(dialog).getByLabelText(/Type PURGE EXPIRED to confirm/), { target: { value: 'PURGE EXPIRED' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Purge permanently' }));
    expect(await screen.findByText('Another maintenance run is in progress (409 · maintenance_running)')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was changed\. Run the preview again and check the audit log\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('settles abandoned jobs and says how many', async () => {
    renderAdmin(<AdminMaintenance />);
    await tile('Abandoned jobs');
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile jobs' }));
    expect(await screen.findByText('1 abandoned job settled. Recorded in the audit log.')).toBeInTheDocument();
    await waitFor(() => expect(api.adminMaintenancePreview).toHaveBeenCalledTimes(2));
  });

  it('says when job reconciliation fails', async () => {
    api.adminReconcileJobs.mockRejectedValue(refusal(503, 'space_unavailable', 'SPACE did not answer.'));
    renderAdmin(<AdminMaintenance />);
    await tile('Abandoned jobs');
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile jobs' }));
    expect(await screen.findByText('A dependency is down (503 · space_unavailable)')).toBeInTheDocument();
    expect(screen.getByText(/Inspect the worker and SPACE health before retrying/)).toBeInTheDocument();
  });

  it('renews expired contracts onto the LIVE pricing after a confirmation', async () => {
    renderAdmin(<AdminMaintenance />);
    await tile('Abandoned jobs');
    expect(await screen.findByText('0.1.0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile contracts' }));
    const dialog = screen.getByRole('dialog', { name: 'Move expired contracts to LIVE?' });
    expect(api.adminReconcileContracts).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reconcile contracts' }));
    await waitFor(() => expect(api.adminReconcileContracts).toHaveBeenCalledOnce());
    expect(await screen.findByText('Expired contracts were renewed onto the LIVE pricing. Recorded in the audit log.')).toBeInTheDocument();
    expect(within(screen.getByLabelText('What was moved')).getByText('Renewed')).toBeInTheDocument();
  });

  it('says when no contract had expired', async () => {
    api.adminReconcileContracts.mockResolvedValue({ renewed: 0 });
    renderAdmin(<AdminMaintenance />);
    await tile('Abandoned jobs');
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile contracts' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reconcile contracts' }));
    expect(await screen.findByText(/Nothing to move: no contract has expired yet/)).toBeInTheDocument();
  });

  it('words a preview that fails, apart from an empty one, and tries again', async () => {
    api.adminMaintenancePreview.mockRejectedValueOnce(refusal(503, 'database_unavailable', 'The database did not answer.'));
    renderAdmin(<AdminMaintenance />);
    expect(await screen.findByText('A dependency is down (503 · database_unavailable)')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Maintenance preview' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await tile('Expired artifacts')).getByText('2')).toBeInTheDocument();
  });

  it('tells a key without the permission so, with no retry', async () => {
    api.adminMaintenancePreview.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminMaintenance />);
    expect(await screen.findByText('This key can’t use administration (403)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminMaintenance />, { user: LUCIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(api.adminMaintenancePreview).not.toHaveBeenCalled();
    expect(api.getCurrentPricing).not.toHaveBeenCalled();
  });
});

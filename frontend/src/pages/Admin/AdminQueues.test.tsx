import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOverview } from './AdminOverview';
import { EMPTY_QUEUES, MARIA, SAM, queuesAt } from '../../test/fixtures/admin';
import { overviewSectionPath } from './adminModel';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({ adminQueues: vi.fn() }));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

/** The queues section of admin-overview, where /app/admin?section=queues leads. */
const renderQueues = (options: Parameters<typeof renderAdmin>[1] = {}) => renderAdmin(<AdminOverview />, { entry: overviewSectionPath('queues'), ...options });

describe('admin-overview, queues section · jobs waiting and running', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminQueues.mockImplementation(async () => queuesAt(Date.now()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts the jobs in each state', async () => {
    renderQueues();
    expect(screen.getByRole('heading', { level: 1, name: 'Queues' })).toBeInTheDocument();
    const states = await screen.findByRole('list', { name: 'Runs by state' });
    const items = within(states).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(within(items[0]).getByText('Queued')).toBeInTheDocument();
    expect(within(items[2]).getByText('Completed')).toBeInTheDocument();
    expect(within(items[2]).getByText('2')).toBeInTheDocument();
    expect(within(items[3]).getByText('Failed')).toBeInTheDocument();
  });

  it('lists the oldest jobs in flight with their owner, budget and age against it', async () => {
    renderQueues();
    const jobs = await screen.findByRole('list', { name: 'Runs in flight, oldest first' });
    const running = within(jobs).getByRole('listitem', { name: 'minizinc running' });
    expect(within(running).getByRole('link', { name: /account 00000000…/ })).toHaveAttribute('href', `/app/admin/users/${MARIA.id}`);
    expect(within(running).getByText(/budget 5 min/)).toBeInTheDocument();
    expect(within(running).getByText('Age about 1 day · past its budget')).toBeInTheDocument();
    const queued = within(jobs).getByRole('listitem', { name: 'random-search queued' });
    expect(within(queued).getByRole('link', { name: /account 00000000…/ })).toHaveAttribute('href', `/app/admin/users/${SAM.id}`);
    expect(within(queued).getByText(/^Age \d+ s$/)).toBeInTheDocument();
    expect(within(queued).queryByText(/past its budget/)).not.toBeInTheDocument();
  });

  it('flags a job that has run far past its budget and points at the way to settle it', async () => {
    renderQueues();
    expect(await screen.findByText('One run has gone far past its time budget')).toBeInTheDocument();
    expect(screen.getByText(/A minizinc run asked for 5 min and has been running for about 1 day/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconcile abandoned runs' })).toHaveAttribute('href', '/app/admin?section=maintenance');
    expect(screen.getByRole('link', { name: 'Go to maintenance' })).toHaveAttribute('href', '/app/admin?section=maintenance');
  });

  it('says what the gateway does not let an administrator do to a queue', async () => {
    renderQueues();
    expect(await screen.findByRole('heading', { name: 'What this screen can’t do' })).toBeInTheDocument();
    expect(screen.getByText(/pause, resume or priority control/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pause|resume|priority/i })).not.toBeInTheDocument();
  });

  it('says how many are in flight when only the oldest are listed', async () => {
    api.adminQueues.mockImplementation(async () => ({ ...queuesAt(Date.now()), counts: { queued: 25, running: 3, completed: 0, failed: 0, cancelled: 0 } }));
    renderQueues();
    expect(await screen.findByText('The 2 oldest of 28')).toBeInTheDocument();
  });

  it('has nothing to flag when jobs are waiting but within their budget', async () => {
    api.adminQueues.mockImplementation(async () => {
      const status = queuesAt(Date.now());
      return { ...status, oldestInFlight: status.oldestInFlight.slice(1) };
    });
    renderQueues();
    await screen.findByRole('list', { name: 'Runs in flight, oldest first' });
    expect(screen.queryByText(/far past their? time budget/)).not.toBeInTheDocument();
  });

  it('says so when nothing is in flight, and when the queues are empty altogether', async () => {
    api.adminQueues.mockResolvedValue({ counts: { queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 }, oldestInFlight: [] });
    renderQueues();
    expect(await screen.findByText('Nothing waiting or running.')).toBeInTheDocument();
  });

  it('shows an empty state when there are no jobs at all', async () => {
    api.adminQueues.mockResolvedValue(EMPTY_QUEUES);
    renderQueues();
    expect(await screen.findByText('Queues are empty')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Runs by state' })).not.toBeInTheDocument();
  });

  it('refreshes on request', async () => {
    renderQueues();
    await screen.findByRole('list', { name: 'Runs by state' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.adminQueues).toHaveBeenCalledTimes(2));
  });

  it('refreshes by itself only while asked to', async () => {
    const start = vi.spyOn(window, 'setInterval');
    const stop = vi.spyOn(window, 'clearInterval');
    renderQueues();
    await screen.findByRole('list', { name: 'Runs by state' });
    expect(start).not.toHaveBeenCalledWith(expect.any(Function), 10000);
    fireEvent.click(screen.getByLabelText('Refresh every 10 s'));
    expect(start).toHaveBeenCalledWith(expect.any(Function), 10000);
    fireEvent.click(screen.getByLabelText('Refresh every 10 s'));
    expect(stop).toHaveBeenCalled();
  });

  it('keeps a failure apart from an empty queue and retries', async () => {
    api.adminQueues.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderQueues();
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('Queues are empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Runs by state' })).toBeInTheDocument();
  });

  it('says when the API key cannot use administration (403)', async () => {
    api.adminQueues.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderQueues();
    expect(await screen.findByText('This key can’t use administration (403)')).toBeInTheDocument();
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderQueues({ user: MARIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(api.adminQueues).not.toHaveBeenCalled();
  });
});

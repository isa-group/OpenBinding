import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError, type JobSummary } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { jobOf } from './fixtures';
import { JobHistory } from './JobHistory';

const jobsApi = vi.hoisted(() => ({ history: vi.fn(), mine: vi.fn(), cancel: vi.fn(), retry: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));
const client = vi.hoisted(() => ({ getPricingCatalog: vi.fn() }));

vi.mock('../../api/jobs', () => ({ jobsApi }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';

const summary = (id: string, engine: string, status: string, termination: JobSummary['termination'], createdAt: string, finishedAt: string | null, solutions: number | null = null): JobSummary => ({
  id, engine_id: engine, status: status as JobSummary['status'], termination, solutions, created_at: createdAt, finished_at: finishedAt,
});

const history = [
  summary('job-done-1', 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z', 1),
  summary('job-run-2', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null),
  summary('job-failed-3', 'evolutionary', 'failed', 'UNKNOWN', '2026-10-07T15:00:00Z', '2026-10-07T15:00:20Z'),
  summary('job-cancelled-4', 'random-search', 'cancelled', null, '2026-10-06T12:00:00Z', '2026-10-06T12:00:03Z'),
  summary('job-loose-5', 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z', 0),
];

const plan = (days: number) => ({ usageLimits: { jobHistoryDays: { value: days } } });
const catalog = { plans: { BASIC: plan(7), ADVANCED: plan(90), RESEARCH: plan(180), PRO: plan(365) } };

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function renderHistory() {
  return renderProjectScreen(<JobHistory />, { path: '/app/jobs', url: '/app/jobs', organizations: [group] });
}

describe('My jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobsApi.history.mockResolvedValue({ jobs: history, total: 5, retention_days: 180 });
    // Every run but one belongs to a project; the loose one was started straight from a snapshot.
    jobsApi.mine.mockResolvedValue([
      ...history.slice(0, 4).map((row) => jobOf(row.id, row.engine_id, row.status, row.termination, row.created_at, row.finished_at ?? null)),
      jobOf('job-loose-5', 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z', { project_id: null }),
    ]);
    platform.organizations.mockResolvedValue([group]);
    platform.projects.mockResolvedValue([qos]);
    client.getPricingCatalog.mockResolvedValue(catalog);
  });

  it('lists everything the account ran, across projects, newest as the gateway orders them', async () => {
    renderHistory();

    expect(await screen.findByRole('heading', { level: 1, name: 'My jobs' })).toBeInTheDocument();
    expect(screen.getByText('Everything you’ve run, across projects.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Your jobs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const links = await within(list).findAllByRole('link', { name: 'random-search on QoS Benchmarks' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([`${ROOT}/jobs/job-done-1`, `${ROOT}/jobs/job-cancelled-4`]);
    expect(within(list).getByText('Sep 30, 2026, 09:00 UTC · 1 min 5 s · feasible · 1 solution')).toBeInTheDocument();
    expect(within(list).getByText(/Oct 7, 2026, 15:00 UTC · 20 s · no conclusion/)).toBeInTheDocument();
    expect(within(list).getByText(/Oct 8, 2026, 08:00 UTC · running · no result yet/)).toBeInTheDocument();
    expect(screen.getByText('5 in total')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('My jobs');
  });

  it('keeps a run that belongs to no project listed, without a link it cannot honour', async () => {
    renderHistory();

    const list = await screen.findByRole('list', { name: 'Your jobs' });
    await within(list).findAllByRole('link', { name: 'random-search on QoS Benchmarks' });
    const loose = within(list).getAllByRole('listitem')[4];
    expect(within(loose).getByText('minizinc')).toBeInTheDocument();
    expect(within(loose).queryByRole('link', { name: /minizinc/ })).not.toBeInTheDocument();
  });

  it('says how long finished runs are kept and compares it with the plans', async () => {
    renderHistory();

    const card = await screen.findByRole('region', { name: 'How long runs are kept' });
    expect(within(card).getByText('Finished jobs are kept 180 days on your RESEARCH plan')).toBeInTheDocument();
    expect(within(card).getByText('Longer retention comes with larger plans, arranged by agreement.')).toBeInTheDocument();
    expect(await within(card).findByText('PRO')).toBeInTheDocument();
    expect(within(card).getByText('BAS')).toBeInTheDocument();
  });

  it('still lists the runs when the retention cannot be confirmed', async () => {
    jobsApi.history.mockResolvedValue({ jobs: history, total: 5, retention_days: null });
    renderHistory();

    expect(await screen.findByText('Retention can’t be confirmed right now')).toBeInTheDocument();
    expect(screen.getByText('Your list still loads; only the retention figure is missing.')).toBeInTheDocument();
    expect(await screen.findAllByRole('listitem')).not.toHaveLength(0);
  });

  it('narrows by status and by engine', async () => {
    renderHistory();

    const list = await screen.findByRole('list', { name: 'Your jobs' });
    expect(screen.getByRole('button', { name: 'All (5)' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Completed (2)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'All (5)' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Engine' }), { target: { value: 'random-search' } });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Failed (1)' }));
    expect(screen.getByText('No runs match these filters')).toBeInTheDocument();
  });

  it('offers cancel, retry and analyze only where they apply', async () => {
    renderHistory();

    const list = await screen.findByRole('list', { name: 'Your jobs' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]).getByRole('link', { name: 'Analyze' })).toHaveAttribute('href', '/app/analysis/workspace?job=job-done-1');
    expect(within(rows[1]).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(rows[2]).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(rows[3]).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument();
  });

  it('cancels a running job', async () => {
    jobsApi.cancel.mockResolvedValue(jobOf('job-run-2', 'minizinc', 'cancelled', null, '2026-10-08T08:00:00Z', '2026-10-08T08:00:30Z'));
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancellation requested.')).toBeInTheDocument();
    expect(jobsApi.cancel).toHaveBeenCalledWith('job-run-2');
  });

  it('retries a failed job and follows the new one into its project', async () => {
    jobsApi.retry.mockResolvedValue(jobOf('job-new-9', 'evolutionary', 'queued', null, '2026-10-09T08:00:00Z', null));
    renderHistory();

    const list = await screen.findByRole('list', { name: 'Your jobs' });
    await within(list).findByRole('link', { name: 'evolutionary on QoS Benchmarks' });
    fireEvent.click(within(within(list).getAllByRole('listitem')[2]).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retry queued. It counts as a new solve.')).toBeInTheDocument();
    expect(jobsApi.retry).toHaveBeenCalledWith('job-failed-3');
    expect(screen.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-9`);
  });

  it('refuses a retry when the solves are used up and says so (402)', async () => {
    jobsApi.retry.mockRejectedValue(new QuotaError('quota_exceeded', 'Solve quota exhausted.', { limit_id: 'taskStarts', limit: 10, used: 10, renews_at: '2026-11-01T00:00:00Z' }));
    renderHistory();

    const list = await screen.findByRole('list', { name: 'Your jobs' });
    fireEvent.click(within(within(list).getAllByRole('listitem')[2]).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retry refused: Out of solves this month (402 · quota_exceeded)')).toBeInTheDocument();
    expect(screen.getByText(/They renew on Nov 1, 2026\./)).toBeInTheDocument();
  });

  it('starts a run from nothing when there is nothing within the retention window', async () => {
    jobsApi.history.mockResolvedValue({ jobs: [], total: 0, retention_days: 7 });
    renderHistory();

    expect(await screen.findByText('Nothing within your retention window')).toBeInTheDocument();
    expect(screen.getByText('No runs within your retention window.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a run' })).toBeInTheDocument();
  });

  it('asks for more when the account has more runs than the page', async () => {
    jobsApi.history.mockResolvedValue({ jobs: history, total: 120, retention_days: 180 });
    renderHistory();

    expect(await screen.findByText('Showing 5 of 120')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(jobsApi.history).toHaveBeenLastCalledWith({ limit: 55 }));
  });

  it('keeps the two ways the session can be refused apart', async () => {
    jobsApi.history.mockRejectedValue(refusal(401, 'unauthorized'));
    const view = renderHistory();
    expect(await screen.findByText(/Your session ended \(401/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your jobs' })).not.toBeInTheDocument();
    view.unmount();

    jobsApi.history.mockRejectedValue(refusal(403, 'api_key_forbidden'));
    renderHistory();
    expect(await screen.findByText(/This API key doesn’t include “read jobs” \(403/)).toBeInTheDocument();
  });

  it('keeps a failure to read the list apart from an empty one, and tries again', async () => {
    jobsApi.history.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderHistory();

    expect(await screen.findByText(/Your jobs can’t be loaded right now \(503/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing within your retention window')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Your jobs' })).toBeInTheDocument();
  });
});

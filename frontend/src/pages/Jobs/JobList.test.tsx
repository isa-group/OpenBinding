import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { iker, org, project, renderProjectScreen } from '../Project/testKit';
import { jobOf } from '../../test/fixtures/jobs';
import { JobList } from './JobList';

const jobsApi = vi.hoisted(() => ({ mine: vi.fn(), history: vi.fn(), retry: vi.fn() }));
const platform = vi.hoisted(() => ({ project: vi.fn(), projectJobs: vi.fn(), publicProjects: vi.fn() }));

vi.mock('../../api/jobs', () => ({ jobsApi }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';

const rows = [
  jobOf('job-running-1', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null),
  jobOf('job-theirs-2', 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z'),
  jobOf('job-done-3', 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z'),
  jobOf('job-failed-4', 'evolutionary', 'failed', 'UNKNOWN', '2026-10-07T15:00:00Z', '2026-10-07T15:00:20Z'),
];

function renderList(options: { organizations?: ReturnType<typeof org>[]; slug?: string; user?: Parameters<typeof renderProjectScreen>[1]['user'] } = {}) {
  return renderProjectScreen(<JobList />, {
    path: '/app/:org/:project/jobs', url: `/app/${options.slug ?? 'isa-demo'}/qos-benchmarks/jobs`, organizations: options.organizations ?? [group, viewing], user: options.user,
  });
}

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

describe('Jobs of a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.projectJobs.mockResolvedValue(rows);
    platform.publicProjects.mockResolvedValue([]);
    jobsApi.mine.mockResolvedValue([rows[0], rows[2], rows[3]]);
    jobsApi.history.mockResolvedValue({ jobs: [], total: 3, retention_days: 180 });
  });

  it('lists every run with its state, engine, outcome and time, and says how long they are kept', async () => {
    renderList();

    expect(await screen.findByRole('heading', { level: 1, name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByText(/Every run in QoS Benchmarks\. Anyone in the project sees the summary/)).toBeInTheDocument();
    const table = await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    const done = within(table).getByRole('row', { name: /random-search/ });
    expect(within(done).getByText('Completed')).toBeInTheDocument();
    expect(within(done).getByText('Feasible')).toBeInTheDocument();
    expect(within(done).getByText('1 min 5 s')).toBeInTheDocument();
    expect(within(done).getByText('You')).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /minizinc.*No feasible binding/ })).toBeInTheDocument();
    expect(screen.getByText('Kept for 180 days on your RESEARCH plan')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    expect(platform.projectJobs).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks');
  });

  it('is for members: a visitor of a public project gets the neutral gate and the jobs are never asked for', async () => {
    platform.project.mockResolvedValue({ ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
    renderList({ slug: 'open-lab' });

    expect(await screen.findByRole('heading', { name: 'Members only' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the project' })).toHaveAttribute('href', '/app/open-lab/qos-benchmarks');
    expect(platform.projectJobs).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Jobs of the project' })).not.toBeInTheDocument();
  });

  it('opens only the runs this account launched; the others are summaries', async () => {
    renderList();

    const table = await screen.findByRole('region', { name: 'Jobs of the project' });
    const opens = within(table).getAllByRole('link', { name: /^Open job/ });
    expect(opens.map((link) => link.getAttribute('href'))).toEqual([`${ROOT}/jobs/job-running-1`, `${ROOT}/jobs/job-done-3`, `${ROOT}/jobs/job-failed-4`]);
    expect(within(table).getByText('Owner only')).toHaveAttribute('title', 'Jobs open only for whoever launched them');
    expect(within(table).getByText('Another member')).toBeInTheDocument();
  });

  it('lets a platform administrator open every run', async () => {
    renderList({ user: iker });

    const table = await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(within(table).getAllByRole('link', { name: /^Open job/ })).toHaveLength(4);
    expect(within(table).queryByText('Owner only')).not.toBeInTheDocument();
  });

  it('narrows the list by status and by engine, with counts on the pills', async () => {
    renderList();

    const table = await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(screen.getByRole('button', { name: 'All (4)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Completed (2)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Running (1)' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Running (1)' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'All (4)' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Engine' }), { target: { value: 'evolutionary' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('evolutionary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelled (0)' }));
    expect(await screen.findByText('No runs match these filters')).toBeInTheDocument();
  });

  it('retries a failed run of its own and follows the new one', async () => {
    jobsApi.retry.mockResolvedValue(jobOf('job-new-5', 'evolutionary', 'queued', null, '2026-10-09T08:00:00Z', null, { retry_of_id: 'job-failed-4' }));
    renderList();

    const table = await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(within(table).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    fireEvent.click(within(table).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Retry queued.')).toBeInTheDocument();
    expect(jobsApi.retry).toHaveBeenCalledWith('job-failed-4');
    expect(screen.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-5`);
  });

  it('says why a retry was refused', async () => {
    jobsApi.retry.mockRejectedValue(refusal(429, 'concurrency_limit_exceeded'));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/All your job slots are busy \(429/)).toBeInTheDocument();
  });

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('offers no selection and no Analyze action', async () => {
    renderList();

    await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Analyze/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Analyze/ })).not.toBeInTheDocument();
  });

  it('offers a new run to members and not to a viewer', async () => {
    const view = renderList();
    expect(await screen.findByRole('link', { name: 'New run' })).toHaveAttribute('href', `${ROOT}/jobs/new`);
    view.unmount();

    renderList({ slug: 'read-lab' });
    await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(screen.queryByRole('link', { name: 'New run' })).not.toBeInTheDocument();
  });

  it('starts from an empty project', async () => {
    platform.projectJobs.mockResolvedValue([]);
    renderList();

    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByText('Pick a case revision and an engine to run it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a run' })).toHaveAttribute('href', `${ROOT}/jobs/new`);
  });

  it('keeps a failure to read the list apart from an empty one, and tries again', async () => {
    platform.projectJobs.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText(/Jobs can’t be loaded right now \(503/)).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Jobs of the project' })).toBeInTheDocument();
  });

  it('gives a project the account is not in the neutral not-found answer', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderList();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.projectJobs).not.toHaveBeenCalled();
  });

  it('pages a long list', async () => {
    platform.projectJobs.mockResolvedValue(Array.from({ length: 25 }, (_, n) => jobOf(`job-${n}`, 'minizinc', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:10Z')));
    jobsApi.mine.mockResolvedValue([]);
    renderList();

    const table = await screen.findByRole('region', { name: 'Jobs of the project' });
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('Showing 1–20 of 25')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(6));
    expect(screen.getByText('Showing 21–25 of 25')).toBeInTheDocument();
  });
});

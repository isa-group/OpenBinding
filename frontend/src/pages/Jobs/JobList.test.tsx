import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderProjectScreen } from '../../features/workspace/testKit';
import { jobOf } from '../../test/fixtures/jobs';
import { JobList } from './JobList';

const runsApi = vi.hoisted(() => ({ list: vi.fn(), retry: vi.fn() }));

vi.mock('../../api/runs', async () => ({ ...await vi.importActual<typeof import('../../api/runs')>('../../api/runs'), runsApi }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const ROOT = '/app/isa-demo';

const DONE_ID = '3f2b9c1e-7d41-4a8e-9b60-c5d1e2f3a4b5';
const RUN_DIGEST = `sha256-${'ab12cd34ef56'.repeat(5)}`;
const LUCIA = { id: 'user-lucia', username: 'lucia.vega' };
const ANA = { id: 'user-ana', username: 'ana' };
const PROBLEM = { problem: { id: 'case-1', slug: 'checkout-flow', name: 'Checkout flow' }, revision: { id: 'rev-2', revision: 2 } };

const rows = [
  jobOf('job-running-1', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null, { created_by: LUCIA, ...PROBLEM }),
  jobOf('job-theirs-2', 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z', { created_by: ANA }),
  jobOf(DONE_ID, 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z', { created_by: LUCIA, result: { termination: 'FEASIBLE', provenance: { irDigest: RUN_DIGEST } } }),
  jobOf('job-failed-4', 'evolutionary', 'failed', 'UNKNOWN', '2026-10-07T15:00:00Z', '2026-10-07T15:00:20Z', { created_by: ANA }),
];

function renderList(options: { slug?: string } = {}) {
  return renderProjectScreen(<JobList />, {
    path: '/app/:org/runs', url: `/app/${options.slug ?? 'isa-demo'}/runs`, organizations: [group, viewing],
  });
}

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

describe('Runs of an organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runsApi.list.mockResolvedValue({ runs: rows, total: rows.length });
  });

  it('lists every run of the organization with its state, problem, engine, outcome, time and who launched it', async () => {
    renderList();

    expect(await screen.findByRole('heading', { level: 1, name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByText(/Every run in ISA Demo Group\. Every member opens them/)).toBeInTheDocument();
    const table = await screen.findByRole('region', { name: 'Runs of the organization' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    const done = within(table).getByRole('row', { name: /random-search/ });
    expect(within(done).getByText('Completed')).toBeInTheDocument();
    expect(within(done).getByText('Feasible')).toBeInTheDocument();
    expect(within(done).getByText('1 min 5 s')).toBeInTheDocument();
    expect(within(done).getByText('You')).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /minizinc.*No feasible binding/ })).toBeInTheDocument();
    expect(within(table).getAllByText('ana')).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'Checkout flow' })).toHaveAttribute('href', `${ROOT}/problems/checkout-flow`);
    expect(within(table).getByText('version 2')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
    expect(runsApi.list).toHaveBeenCalledWith('isa-demo', { limit: 200 });
  });

  it('opens every run for every member, whoever launched it', async () => {
    renderList();

    const table = await screen.findByRole('region', { name: 'Runs of the organization' });
    const opens = within(table).getAllByRole('link', { name: /^Open run/ });
    expect(opens.map((link) => link.getAttribute('href'))).toEqual([
      `${ROOT}/runs/job-running-1`, `${ROOT}/runs/job-theirs-2`, `${ROOT}/runs/${DONE_ID}`, `${ROOT}/runs/job-failed-4`,
    ]);
    expect(opens.map((link) => link.getAttribute('aria-label')).join(' ')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|job-|sha256-|Open run run/i);
    expect(within(table).queryByText('Owner only')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|job-/i);
  });

  it('narrows the list by status and by engine, with counts on the pills', async () => {
    renderList();

    const table = await screen.findByRole('region', { name: 'Runs of the organization' });
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

  it('lets a member retry a teammate’s failed run and follow the new one', async () => {
    runsApi.retry.mockResolvedValue(jobOf('job-new-5', 'evolutionary', 'queued', null, '2026-10-09T08:00:00Z', null, { retry_of_id: 'job-failed-4' }));
    renderList();

    const table = await screen.findByRole('region', { name: 'Runs of the organization' });
    expect(within(table).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    fireEvent.click(within(table).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Retry queued.')).toBeInTheDocument();
    expect(runsApi.retry).toHaveBeenCalledWith('isa-demo', 'job-failed-4');
    expect(screen.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/runs/job-new-5`);
  });

  it('says why a retry was refused', async () => {
    runsApi.retry.mockRejectedValue(refusal(429, 'concurrency_limit_exceeded'));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/All your run slots are busy \(429/)).toBeInTheDocument();
  });

  it('offers no selection and no Analyze action', async () => {
    renderList();

    await screen.findByRole('region', { name: 'Runs of the organization' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Analyze/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Analyze/ })).not.toBeInTheDocument();
  });

  it('offers a new run and retries to members, and lets a viewer read only', async () => {
    const view = renderList();
    expect(await screen.findByRole('link', { name: 'New run' })).toHaveAttribute('href', `${ROOT}/runs/new`);
    view.unmount();

    renderList({ slug: 'read-lab' });
    const table = await screen.findByRole('region', { name: 'Runs of the organization' });
    expect(screen.queryByRole('link', { name: 'New run' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(table).getAllByRole('link', { name: /^Open run/ })).toHaveLength(4);
  });

  it('starts from an organization without runs', async () => {
    runsApi.list.mockResolvedValue({ runs: [], total: 0 });
    renderList();

    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByText('Pick a problem version and an engine to run it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a run' })).toHaveAttribute('href', `${ROOT}/runs/new`);
  });

  it('keeps a failure to read the list apart from an empty one, and tries again', async () => {
    runsApi.list.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText(/Runs can’t be loaded right now \(503/)).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Runs of the organization' })).toBeInTheDocument();
  });

  it('gives an organization the account is not in the neutral answer, and asks for no runs', async () => {
    renderList({ slug: 'elsewhere' });

    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(runsApi.list).not.toHaveBeenCalled();
  });

  it('pages a long list', async () => {
    runsApi.list.mockResolvedValue({ total: 25, runs: Array.from({ length: 25 }, (_, n) => jobOf(`job-${n}`, 'minizinc', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:10Z')) });
    renderList();

    const table = await screen.findByRole('region', { name: 'Runs of the organization' });
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('Showing 1–20 of 25')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(6));
    expect(screen.getByText('Showing 21–25 of 25')).toBeInTheDocument();
  });
});

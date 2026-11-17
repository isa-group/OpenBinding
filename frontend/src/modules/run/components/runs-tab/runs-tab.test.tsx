import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../api/runsClient';
import { jobOf } from '../../../../test/fixtures/jobs';
import { addressNow, fakeGateway, renderModule, type Answer } from '../../../../test/moduleKit';
import { problemPath } from '../../../../routes/paths/problems';
import { launchPath, runPath } from '../../../../routes/paths/runs';
import RunsTab, { PER_PAGE, REFRESH_MS } from '.';

const DONE_ID = '3f2b9c1e-7d41-4a8e-9b60-c5d1e2f3a4b5';
const RUN_DIGEST = `sha256-${'ab12cd34ef56'.repeat(5)}`;
const ME = { id: '00000000-0000-4000-8000-000000000005', username: 'alex.rivera' };
const ANA = { id: 'user-ana', username: 'ana' };
const PROBLEM = {
  problem: { id: 'case-1', slug: 'checkout-flow', name: 'Checkout flow' },
  revision: { id: 'rev-2', revision: 2 },
};
const ORG = { slug: 'isa-demo', name: 'ISA Demo Group' };

const rows: Job[] = [
  jobOf('job-running-1', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null, {
    created_by: ME,
    ...PROBLEM,
  }),
  jobOf(
    'job-theirs-2',
    'minizinc',
    'completed',
    'INFEASIBLE',
    '2026-10-01T09:00:00Z',
    '2026-10-01T09:00:40Z',
    { created_by: ANA }
  ),
  jobOf(
    DONE_ID,
    'random-search',
    'completed',
    'FEASIBLE',
    '2026-09-30T09:00:00Z',
    '2026-09-30T09:01:05Z',
    { created_by: ME, result: { termination: 'FEASIBLE', provenance: { irDigest: RUN_DIGEST } } }
  ),
  jobOf(
    'job-failed-4',
    'evolutionary',
    'failed',
    'UNKNOWN',
    '2026-10-07T15:00:00Z',
    '2026-10-07T15:00:20Z',
    { created_by: ANA }
  ),
];

const LIST = 'GET /v1/organizations/isa-demo/runs';
const queryOf = (path: string) => new URL(path, 'http://x').searchParams;

/** The gateway's list: the rows that match `state` and `engine`, paged by `limit` and `offset`. */
const listOf =
  (all: Job[]): Answer =>
  ({ path }) => {
    const query = queryOf(path);
    const state = query.get('state');
    const engine = query.get('engine');
    const matching = all.filter(
      row => (!state || row.status === state) && (!engine || row.engine_id === engine)
    );
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 50);
    return { body: { runs: matching.slice(offset, offset + limit), total: matching.length } };
  };

function renderTab(
  options: { role?: 'OWNER' | 'MEMBER' | 'VIEWER'; routes?: Record<string, Answer> } = {}
) {
  const gateway = fakeGateway({
    [LIST]: listOf(rows),
    'GET /v1/organizations/isa-demo/problems': {
      body: { problems: [{ slug: 'checkout-flow', name: 'Checkout flow' }], total: 1 },
    },
    'GET /v1/engines': {
      body: { engines: [{ name: 'minizinc' }, { name: 'evolutionary' }, { name: 'minizinc' }] },
    },
    ...options.routes,
  });
  return renderModule(<RunsTab org={ORG} myRole={options.role ?? 'OWNER'} />, {
    gateway,
    entry: '/orgs/isa-demo/runs',
    path: '/orgs/:org/:tab?',
  });
}

const listCalls = (gateway: ReturnType<typeof fakeGateway>) =>
  gateway.mock.calls
    .map(([path, init]) => [(init as RequestInit | undefined)?.method ?? 'GET', path as string])
    .filter(([method, path]) => method === 'GET' && path.startsWith(LIST.slice(4)));

describe('The Runs tab of an organization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the runs with their state, problem@version, engine, outcome, time and who launched them', async () => {
    const { gateway } = renderTab();

    expect(await screen.findByRole('heading', { level: 2, name: 'Runs' })).toBeInTheDocument();
    expect(await screen.findByLabelText('4 in all')).toHaveTextContent('4');
    expect(screen.getByText(/Every engine run launched in ISA Demo Group\./)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Runs of the organization' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const done = within(list).getByRole('listitem', { name: /random-search/ });
    expect(within(done).getByText('Completed')).toBeInTheDocument();
    expect(within(done).getByText('Feasible')).toBeInTheDocument();
    expect(within(done).getByText('1 min 5 s')).toBeInTheDocument();
    expect(within(done).getByText('You')).toBeInTheDocument();
    expect(within(list).getByText('No feasible binding')).toBeInTheDocument();
    expect(within(list).getAllByText('ana')).toHaveLength(2);
    expect(within(list).getByRole('link', { name: 'Checkout flow@v2' })).toHaveAttribute(
      'href',
      problemPath('isa-demo', 'checkout-flow', undefined, { version: 2 })
    );
    expect(listCalls(gateway)[0][1]).toBe(
      `/v1/organizations/isa-demo/runs?limit=${PER_PAGE}&offset=0`
    );
  });

  it('opens every run on its own page, named without ids or digests', async () => {
    renderTab();

    const list = await screen.findByRole('list', { name: 'Runs of the organization' });
    const opens = within(list).getAllByRole('link', { name: /^Open run/ });
    expect(opens.map(link => link.getAttribute('href'))).toEqual([
      runPath('isa-demo', 'job-running-1'),
      runPath('isa-demo', 'job-theirs-2'),
      runPath('isa-demo', DONE_ID),
      runPath('isa-demo', 'job-failed-4'),
    ]);
    expect(runPath('isa-demo', 'r1')).toBe('/runs/isa-demo/r1');
    expect(opens.map(link => link.getAttribute('aria-label')).join(' ')).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-|job-|sha256-|Open run run/i
    );
    expect(list.textContent).not.toMatch(/sha256-|[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-|job-/i);
  });

  it('asks the gateway for one status and keeps it in the address', async () => {
    const { gateway } = renderTab();

    await screen.findByRole('list', { name: 'Runs of the organization' });
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Running' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Runs of the organization' })).getAllByRole(
          'listitem'
        )
      ).toHaveLength(1)
    );
    expect(screen.getByRole('button', { name: 'Running' })).toHaveAttribute('aria-pressed', 'true');
    expect(addressNow()).toBe('/orgs/isa-demo/runs?state=running');
    expect(listCalls(gateway).at(-1)?.[1]).toContain('state=running');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelled' }));
    expect(await screen.findByText('No runs match these filters')).toBeInTheDocument();
  });

  it('narrows by problem and engine in the Filters popover, from the gateway’s lists', async () => {
    const { gateway } = renderTab();

    await screen.findByRole('list', { name: 'Runs of the organization' });
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    const filters = screen.getByRole('group', { name: 'Filters' });
    const engine = within(filters).getByRole('combobox', { name: 'Engine' });
    expect(
      within(engine)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Any engine', 'evolutionary', 'minizinc']);
    fireEvent.change(engine, { target: { value: 'evolutionary' } });
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Runs of the organization' })).getAllByRole(
          'listitem'
        )
      ).toHaveLength(1)
    );
    expect(addressNow()).toBe('/orgs/isa-demo/runs?engine=evolutionary');

    fireEvent.change(within(filters).getByRole('combobox', { name: 'Problem' }), {
      target: { value: 'checkout-flow' },
    });
    await waitFor(() => expect(listCalls(gateway).at(-1)?.[1]).toContain('problem=checkout-flow'));
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent('2');
  });

  it('lets a member retry a teammate’s failed run and follow the new one', async () => {
    const { gateway } = renderTab({
      routes: {
        'POST /v1/organizations/isa-demo/runs/job-failed-4/retry': {
          status: 201,
          body: jobOf('job-new-5', 'evolutionary', 'queued', null, '2026-10-09T08:00:00Z', null, {
            retry_of_id: 'job-failed-4',
          }),
        },
      },
    });

    const list = await screen.findByRole('list', { name: 'Runs of the organization' });
    expect(within(list).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Retry queued.')).toBeInTheDocument();
    expect(gateway).toHaveBeenCalledWith(
      '/v1/organizations/isa-demo/runs/job-failed-4/retry',
      expect.objectContaining({ method: 'POST' })
    );
    expect(screen.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute(
      'href',
      runPath('isa-demo', 'job-new-5')
    );
  });

  it('says why a retry was refused', async () => {
    renderTab({
      routes: {
        'POST /v1/organizations/isa-demo/runs/job-failed-4/retry': {
          status: 429,
          body: {
            detail: {
              code: 'concurrency_limit_exceeded',
              error: 'Concurrency limit exceeded.',
              concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 },
            },
          },
        },
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/All your run slots are busy \(429/)).toBeInTheDocument();
  });

  it('offers no selection and no Analyze action', async () => {
    renderTab();

    await screen.findByRole('list', { name: 'Runs of the organization' });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Analyze/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Analyze/ })).not.toBeInTheDocument();
  });

  it('offers "Start a run" and retries to members, and lets a viewer read only', async () => {
    const view = renderTab({ role: 'MEMBER' });
    expect(await screen.findByRole('link', { name: 'Start a run' })).toHaveAttribute(
      'href',
      launchPath('isa-demo')
    );
    expect(launchPath('isa-demo')).toBe('/runs/new?org=isa-demo');
    view.unmount();

    renderTab({ role: 'VIEWER' });
    const list = await screen.findByRole('list', { name: 'Runs of the organization' });
    expect(screen.queryByRole('link', { name: 'Start a run' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('link', { name: /^Open run/ })).toHaveLength(4);
  });

  it('starts from an organization without runs', async () => {
    renderTab({ routes: { [LIST]: { body: { runs: [], total: 0 } } } });

    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByText('Pick a problem version and an engine to run it.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Start a run' }).at(-1)).toHaveAttribute(
      'href',
      launchPath('isa-demo')
    );
  });

  it('keeps a failure to read the list apart from an empty one, and tries again', async () => {
    let calls = 0;
    renderTab({
      routes: {
        [LIST]: request => {
          calls += 1;
          return calls === 1
            ? { status: 503, body: { detail: { code: 'unavailable', error: 'Down.' } } }
            : (listOf(rows) as (r: typeof request) => { body: unknown })(request);
        },
      },
    });

    expect(await screen.findByText(/Runs can’t be loaded right now \(503/)).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('list', { name: 'Runs of the organization' })
    ).toBeInTheDocument();
  });

  it('says a key without jobs:read cannot read runs', async () => {
    renderTab({
      routes: { [LIST]: { status: 403, body: { detail: { code: 'api_key_forbidden' } } } },
    });

    expect(await screen.findByText(/This credential can’t read runs \(403/)).toBeInTheDocument();
    expect(screen.getByText('jobs:read')).toBeInTheDocument();
  });

  it('pages ten runs at a time on the gateway’s offset, with its total', async () => {
    const many = Array.from({ length: 25 }, (_, n) =>
      jobOf(
        `job-${n}`,
        'minizinc',
        'completed',
        'FEASIBLE',
        '2026-10-01T09:00:00Z',
        '2026-10-01T09:00:10Z'
      )
    );
    const { gateway } = renderTab({ routes: { [LIST]: listOf(many) } });

    const list = await screen.findByRole('list', { name: 'Runs of the organization' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Runs of the organization' })).getAllByRole(
          'listitem'
        )
      ).toHaveLength(5)
    );
    expect(addressNow()).toBe('/orgs/isa-demo/runs?page=3');
    expect(listCalls(gateway).at(-1)?.[1]).toBe(
      '/v1/organizations/isa-demo/runs?limit=10&offset=20'
    );
  });

  it('reads the page again while a run on it is still moving, and stops once none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { gateway } = renderTab();
    await screen.findByRole('list', { name: 'Runs of the organization' });
    const before = listCalls(gateway).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS + 50);
    });
    await waitFor(() => expect(listCalls(gateway).length).toBe(before + 1));
    // The list stays on screen while it is read again.
    expect(screen.getByRole('list', { name: 'Runs of the organization' })).toBeInTheDocument();
  });
});

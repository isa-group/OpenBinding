import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderOrgScreen } from '../../features/workspace/testKit';
import {
  CHECKOUT,
  REVISION_1,
  REVISION_2,
  RUN_ID,
  analyticsFixture,
  cellsFixture,
  frontsFixture,
  runFixture,
  studyFixture,
} from '../../test/fixtures/studies';
import { StudyDetail } from './StudyDetail';

const platform = vi.hoisted(() => ({
  study: vi.fn(),
  studyRuns: vi.fn(),
  studyRun: vi.fn(),
  studyCells: vi.fn(),
  analytics: vi.fn(),
  exportStudyRun: vi.fn(),
}));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));

const problems = vi.hoisted(() => ({
  list: vi.fn(),
  revisions: vi.fn(),
  compilation: vi.fn(),
  ir: vi.fn(),
}));
vi.mock('../../api/platform', async () => ({
  ...(await vi.importActual<typeof import('../../api/platform')>('../../api/platform')),
  platformApi: platform,
}));
vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../features/workspace/download', () => download);

/** The one-run read answers from what the study's run list answers. */
function oneRunFromList() {
  platform.studyRun.mockImplementation(async (_org: string, _study: string, id: string) => {
    const runs = (await platform.studyRuns()) as Array<{ id: string }>;
    const found = runs.find(run => run.id === id);
    if (!found)
      throw Object.assign(new HttpError(404, 'Study run not found.'), { code: 'not_found' });
    return found;
  });
}

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const ROOT = '/app/isa-demo';
const RESULTS = `${ROOT}/studies/engines-vs-seeds/results?run=${RUN_ID}`;
const cells = cellsFixture();

const refusal = (status: number, code: string, message = 'refused') =>
  Object.assign(new HttpError(status, message), { code });

/** The Results tab of the study page, on the study run named by `?run=`. */
function renderAnalytics(options: { slug?: string; run?: string } = {}) {
  return renderOrgScreen(<StudyDetail />, {
    path: '/app/:org/studies/:study/:tab?',
    url: `/app/${options.slug ?? 'isa-demo'}/studies/engines-vs-seeds/results?run=${options.run ?? RUN_ID}`,
    organizations: [group, viewing],
  });
}

const figure = (label: string) =>
  within(screen.getByLabelText('Counts of the run')).getByText(label).previousElementSibling;

describe('Analytics of a run, in the Results tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.study.mockResolvedValue({ value: studyFixture(), etag: null });
    oneRunFromList();
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cells);
    platform.analytics.mockResolvedValue(analyticsFixture());
    problems.list.mockResolvedValue({ problems: [CHECKOUT], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
  });

  it('counts the cells and compares the engines on the cost they found', async () => {
    renderAnalytics();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Only what the run recorded\. Nothing here is estimated: lower is better for every objective\./
      )
    ).toBeInTheDocument();
    expect(figure('cells')).toHaveTextContent('8');
    expect(figure('completed')).toHaveTextContent('6');
    expect(figure('failed')).toHaveTextContent('1');
    expect(figure('feasible')).toHaveTextContent('6');
    expect(figure('infeasible')).toHaveTextContent('0');
    expect(figure('median time')).toHaveTextContent('1 min');
    expect(screen.queryByRole('link', { name: 'Weigh trade-offs' })).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Cost found, per engine' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'evolutionary: 2 values from 0.104 to 0.112, median 0.108' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'random-search: 4 values from 0.109 to 0.121, median 0.1145',
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /evolutionary took 1 min 58 s to 2 min; random-search took 58 s to 1 min/,
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Studies' })).toHaveAttribute(
      'href',
      '/app/isa-demo/studies'
    );
  });

  it('plots two objectives and marks the cells on the gateway’s front of one case at a time', async () => {
    renderAnalytics();

    expect(
      await screen.findByRole('img', {
        name: /3 results plotted by Cost and Latency; 2 are best trade-offs: 0\.112 and 440; 0\.118 and 412/,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/Best trade-offs:/)).toHaveTextContent(
      'cell 0 (0.112, 440); cell 3 (0.118, 412).'
    );
    expect(screen.getByRole('link', { name: 'cell 3' })).toHaveAttribute(
      'href',
      `${RESULTS}&cell=${cells[3].id}`
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Problem' }), {
      target: { value: REVISION_2.id },
    });
    expect(screen.getByText(/Best trade-offs:/)).toHaveTextContent(
      'cell 4 (0.104, 420); cell 6 (0.109, 398).'
    );
  });

  it('marks only what the gateway put on the front, in its order, and compares nothing itself', async () => {
    const [first] = frontsFixture();
    // A front the client would never compute: cell 2 is beaten by cell 3 on both objectives.
    platform.analytics.mockResolvedValue(
      analyticsFixture({
        pareto: [
          { ...first, points: [{ ...first.points[1], cell_id: cells[2].id }, first.points[0]] },
        ],
      })
    );
    renderAnalytics();

    expect(await screen.findByText(/Best trade-offs:/)).toHaveTextContent(
      'cell 2 (0.121, 430); cell 0 (0.112, 440).'
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Problem' }), {
      target: { value: REVISION_2.id },
    });
    expect(screen.queryByText(/Best trade-offs:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /3 results plotted by Cost and Latency; 0 are best trade-offs/,
      })
    ).toBeInTheDocument();
  });

  it('lists the gateway’s front of each problem version with its points', async () => {
    renderAnalytics();

    const section = await screen.findByRole('region', { name: 'Pareto front' });
    expect(
      within(section).getByText('4 points · computed by the gateway · lower is better')
    ).toBeInTheDocument();
    const first = within(section).getByRole('region', {
      name: 'Front of checkout-flow · version 1',
    });
    expect(within(first).getAllByRole('row')).toHaveLength(3);
    expect(within(first).getByRole('row', { name: /P1/ })).toHaveTextContent(
      /P1\s*#0\s*evolutionary\s*seed 1\s*0\.112\s*440/
    );
    expect(
      within(section).getByRole('region', { name: 'Front of checkout-flow · version 2' })
    ).toHaveTextContent('P4');
    expect(within(section).getByRole('button', { name: 'Derive compositions' })).toBeDisabled();
  });

  it('ranks the engines by their mean and shows what each ran', async () => {
    renderAnalytics();

    const table = await screen.findByRole('region', { name: 'Engines ranked by cost' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent(/1\s*evolutionary\s*2 of 4/);
    expect(rows[2]).toHaveTextContent(/2\s*random-search\s*4 of 4/);
    expect(rows[2]).toHaveTextContent('+6% vs first');
  });

  it('shows how far apart the seeds are, and how repeatable each engine is', async () => {
    renderAnalytics();

    const table = await screen.findByRole('region', { name: 'Results by seed' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    const random = within(table).getByRole('row', { name: /Checkout flow r1 · random-search/ });
    expect(within(random).getByRole('link', { name: 'seed 1: 0.121' })).toHaveAttribute(
      'href',
      `${RESULTS}&cell=${cells[2].id}`
    );
    expect(within(random).getByRole('link', { name: 'seed 2: 0.118' })).toBeInTheDocument();
    expect(random).toHaveTextContent('0.003');
    expect(
      within(table).getByRole('row', { name: /Checkout flow r1 · evolutionary/ })
    ).toHaveTextContent('seed 2: failed');
    const stability = screen.getByLabelText('Repeatability of each engine');
    expect(within(stability).getByText('bim.builtin/random-search@1.0.0')).toBeInTheDocument();
    expect(within(stability).getByText('25%')).toBeInTheDocument();
    expect(within(stability).getByText('4/4 distinct')).toBeInTheDocument();
  });

  it('keeps the size of the search space from the run’s analytics', async () => {
    renderAnalytics();

    expect(
      await screen.findByRole('heading', { name: 'Largest search space' })
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Search space of each problem version' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('version 2 · 6 tasks')).toBeInTheDocument();
  });

  it('lists every plotted cell with its fingerprint to copy and its page to open', async () => {
    renderAnalytics();

    const table = await screen.findByRole('region', { name: 'Provenance of every cell' });
    expect(within(table).getAllByRole('row')).toHaveLength(9);
    expect(within(table).getByRole('link', { name: 'Open cell 2' })).toHaveAttribute(
      'href',
      `${RESULTS}&cell=${cells[2].id}`
    );
    expect(
      within(table).getByRole('button', { name: 'Copy digest of cell 2' })
    ).toBeInTheDocument();
    expect(within(table).queryByText(cells[2].fingerprint)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
  });

  it('narrows every chart to one engine, or to another measure', async () => {
    renderAnalytics();

    fireEvent.click(await screen.findByRole('button', { name: 'evolutionary' }));
    expect(
      within(screen.getByRole('region', { name: 'Engines ranked by cost' })).getAllByRole('row')
    ).toHaveLength(2);
    expect(screen.queryByRole('img', { name: /^random-search:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Both engines' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Measure' }), {
      target: { value: 'runtime' },
    });
    expect(screen.getByRole('heading', { name: 'Time taken, per engine' })).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Engines ranked by time taken' })
    ).toBeInTheDocument();
  });

  it('exports the run as CSV or JSON from the gateway, under the name the gateway gives', async () => {
    const bytes = new TextEncoder().encode('{}').buffer;
    platform.exportStudyRun.mockResolvedValue({
      bytes,
      fileName: 'engines-vs-seeds-run-1.json',
      mediaType: 'application/json',
    });
    renderAnalytics();

    fireEvent.click(await screen.findByRole('button', { name: 'Export JSON' }));

    await waitFor(() =>
      expect(download.saveBytes).toHaveBeenCalledWith(
        bytes,
        'engines-vs-seeds-run-1.json',
        'application/json'
      )
    );
    expect(platform.exportStudyRun).toHaveBeenCalledWith(
      'isa-demo',
      'engines-vs-seeds',
      RUN_ID,
      'json'
    );
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('says when the gateway refuses an export', async () => {
    platform.exportStudyRun.mockRejectedValue(refusal(403, 'api_key_permission_denied'));
    renderAnalytics();

    fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(
      await screen.findByText('The CSV export couldn’t be made (403 · api_key_permission_denied).')
    ).toBeInTheDocument();
    expect(download.saveBytes).not.toHaveBeenCalled();
  });

  it('explains there is nothing to chart before any cell completes', async () => {
    platform.studyCells.mockResolvedValue(
      cells.map(cell => ({ ...cell, state: 'cancelled' as const, metrics: {}, job_id: null }))
    );
    platform.analytics.mockResolvedValue(
      analyticsFixture({ feasible: 0, runtimes_s: [], objective_distributions: {} })
    );
    renderAnalytics();

    expect(
      await screen.findByText(/No completed cells yet, so there’s nothing to chart\./)
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Engine ranking' })).not.toBeInTheDocument();
  });

  it('says a trade-off needs two objectives', async () => {
    platform.studyCells.mockResolvedValue(
      cells.map(cell => ({
        ...cell,
        metrics:
          cell.state === 'completed'
            ? {
                ...cell.metrics,
                objectives: {
                  cost: (cell.metrics as { objectives: { cost: number } }).objectives.cost,
                },
              }
            : cell.metrics,
      }))
    );
    renderAnalytics();

    expect(
      await screen.findByText('A trade-off needs two objectives, and this run recorded one.')
    ).toBeInTheDocument();
  });

  it('lets a viewer read everything', async () => {
    renderAnalytics({ slug: 'read-lab' });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Provenance of every cell' })).toBeInTheDocument();
    const front = screen.getByRole('region', { name: 'Pareto front' });
    expect(
      within(front).queryByRole('button', { name: 'Derive compositions' })
    ).not.toBeInTheDocument();
    expect(
      within(front).getByText('Read-only: deriving compositions needs MEMBER in Read Lab.')
    ).toBeInTheDocument();
  });

  it('answers a run that is not there with a neutral 404', async () => {
    platform.analytics.mockRejectedValue(refusal(404, 'not_found'));
    renderAnalytics();

    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeInTheDocument();
    expect(screen.getByText('No such run in this study (404).')).toBeInTheDocument();
  });

  it('offers a retry when the analytics cannot be loaded', async () => {
    platform.analytics.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderAnalytics();

    expect(
      await screen.findByText(/Analytics couldn’t be loaded \(503 · unavailable\)/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 2, name: 'Compare results · run #1' })
      ).toBeInTheDocument()
    );
  });
});

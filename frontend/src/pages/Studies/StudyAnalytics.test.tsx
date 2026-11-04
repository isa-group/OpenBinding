import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, reportOf, renderProjectScreen } from '../Project/testKit';
import { CHECKOUT, REVISION_1, REVISION_2, RUN_ID, analyticsFixture, cellsFixture, runFixture, studyFixture } from '../../test/fixtures/studies';
import { StudyDetail } from './StudyDetail';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(), analytics: vi.fn(), reports: vi.fn(),
  cases: vi.fn(), revisions: vi.fn(),
}));
const client = vi.hoisted(() => ({ getJobStatus: vi.fn() }));
const library = vi.hoisted(() => ({ libraryApi: { versions: vi.fn().mockResolvedValue([]) } }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/library', () => library);
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
// The decision workspace is not what is under test here.
vi.mock('../../components/BindingAnalysis/BindingAnalysis', async () => {
  const { createElement } = await import('react');
  return { BindingAnalysis: ({ jobId }: { jobId?: string }) => createElement('div', null, `Binding analysis of ${jobId}`) };
});

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';
const RESULTS = `${ROOT}/studies/engines-vs-seeds/results?run=${RUN_ID}`;
const cells = cellsFixture();

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

/** The Results tab of the study page, on the study run named by `?run=`. */
function renderAnalytics(options: { slug?: string; run?: string } = {}) {
  return renderProjectScreen(<StudyDetail />, {
    path: '/app/:org/:project/studies/:study/:tab?', url: `/app/${options.slug ?? 'isa-demo'}/qos-benchmarks/studies/engines-vs-seeds/results?run=${options.run ?? RUN_ID}`,
    organizations: [group, viewing],
  });
}

const figure = (label: string) => within(screen.getByLabelText('Counts of the run')).getByText(label).previousElementSibling;

// [utest->req~frontend-nav-study-page~1]
describe('Analytics of a run, in the Results tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cells);
    platform.analytics.mockResolvedValue(analyticsFixture());
    platform.reports.mockResolvedValue([]);
    platform.cases.mockResolvedValue([CHECKOUT]);
    platform.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    client.getJobStatus.mockResolvedValue({ id: 'job', status: 'completed', result: { solutions: [] } });
  });

  it('counts the cells and compares the engines on the cost they found', async () => {
    renderAnalytics();

    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })).toBeInTheDocument();
    expect(screen.getByText(/Only what the run recorded\. Nothing here is estimated: lower is better for every objective\./)).toBeInTheDocument();
    expect(figure('cells')).toHaveTextContent('8');
    expect(figure('completed')).toHaveTextContent('6');
    expect(figure('failed')).toHaveTextContent('1');
    expect(figure('feasible')).toHaveTextContent('6');
    expect(figure('infeasible')).toHaveTextContent('0');
    expect(figure('median time')).toHaveTextContent('1 min');
    // [utest->req~frontend-retire-no-link-to-retired~1]
    expect(screen.queryByRole('link', { name: 'Weigh trade-offs' })).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Cost found, per engine' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'evolutionary: 2 values from 0.104 to 0.112, median 0.108' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'random-search: 4 values from 0.109 to 0.121, median 0.1145' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /evolutionary took 1 min 58 s to 2 min; random-search took 58 s to 1 min/ })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
  });

  it('plots two objectives and marks the best trade-offs of one case at a time', async () => {
    renderAnalytics();

    expect(await screen.findByRole('img', { name: /3 results plotted by Cost and Latency; 2 are best trade-offs: 0\.112 and 440; 0\.118 and 412/ })).toBeInTheDocument();
    expect(screen.getByText(/Best trade-offs:/)).toHaveTextContent('cell 0 (0.112, 440); cell 3 (0.118, 412).');
    expect(screen.getByRole('link', { name: 'cell 3' })).toHaveAttribute('href', `${RESULTS}&cell=${cells[3].id}`);
    fireEvent.change(screen.getByRole('combobox', { name: 'Problem' }), { target: { value: REVISION_2.id } });
    expect(screen.getByText(/Best trade-offs:/)).toHaveTextContent('cell 4 (0.104, 420); cell 6 (0.109, 398).');
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
    expect(within(random).getByRole('link', { name: 'seed 1: 0.121' })).toHaveAttribute('href', `${RESULTS}&cell=${cells[2].id}`);
    expect(within(random).getByRole('link', { name: 'seed 2: 0.118' })).toBeInTheDocument();
    expect(random).toHaveTextContent('0.003');
    expect(within(table).getByRole('row', { name: /Checkout flow r1 · evolutionary/ })).toHaveTextContent('seed 2: failed');
    const stability = screen.getByLabelText('Repeatability of each engine');
    expect(within(stability).getByText('bim.builtin/random-search@1.0.0')).toBeInTheDocument();
    expect(within(stability).getByText('25%')).toBeInTheDocument();
    expect(within(stability).getByText('4/4 distinct')).toBeInTheDocument();
  });

  it('keeps the size of the search space from the run’s analytics', async () => {
    renderAnalytics();

    expect(await screen.findByRole('heading', { name: 'Largest search space' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Search space of each problem version' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('version 2 · 6 tasks')).toBeInTheDocument();
  });

  it('lists every plotted cell with its fingerprint to copy and its page to open', async () => {
    renderAnalytics();

    const table = await screen.findByRole('region', { name: 'Provenance of every cell' });
    expect(within(table).getAllByRole('row')).toHaveLength(9);
    expect(within(table).getByRole('link', { name: 'Open cell 2' })).toHaveAttribute('href', `${RESULTS}&cell=${cells[2].id}`);
    expect(within(table).getByRole('button', { name: 'Copy digest of cell 2' })).toBeInTheDocument();
    expect(within(table).queryByText(cells[2].fingerprint)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
  });

  it('narrows every chart to one engine, or to another measure', async () => {
    renderAnalytics();

    fireEvent.click(await screen.findByRole('button', { name: 'evolutionary' }));
    expect(within(screen.getByRole('region', { name: 'Engines ranked by cost' })).getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByRole('img', { name: /^random-search:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Both engines' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Measure' }), { target: { value: 'runtime' } });
    expect(screen.getByRole('heading', { name: 'Time taken, per engine' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Engines ranked by time taken' })).toBeInTheDocument();
  });

  it('leaves the CSV export to the Publish tab', async () => {
    renderAnalytics();

    await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  // [utest->req~frontend-retire-reports-entry-points-removed~1]
  it('offers no report action, whether or not a draft report of the run exists, and reads no report', async () => {
    const action = /create (a |draft )?report|open the report/i;
    const view = renderAnalytics();

    await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' });
    expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: action })).not.toBeInTheDocument();
    view.unmount();

    platform.reports.mockResolvedValue([reportOf('engines-vs-seeds-run-1', 'draft', { study_run_id: RUN_ID })]);
    renderAnalytics();
    await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' });
    expect(screen.queryByRole('link', { name: action })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => /\/reports([/?#]|$)/.test(href))).toEqual([]);
    await waitFor(() => expect(platform.analytics).toHaveBeenCalled());
    expect(platform.reports).not.toHaveBeenCalled();
  });

  it('loads the solutions of one cell only when asked', async () => {
    renderAnalytics();

    const select = await screen.findByRole('combobox', { name: 'Analysis study cell' });
    expect(client.getJobStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load the solutions' }));

    expect(await screen.findByText('Binding analysis of 00000000-0000-4000-8000-000000000300')).toBeInTheDocument();
    expect(client.getJobStatus).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000300');
    fireEvent.change(select, { target: { value: '00000000-0000-4000-8000-000000000302' } });
    expect(screen.queryByText('Binding analysis of 00000000-0000-4000-8000-000000000300')).not.toBeInTheDocument();
  });

  it('says a job that is not the account’s cannot be opened', async () => {
    client.getJobStatus.mockRejectedValue(refusal(404, 'not_found'));
    renderAnalytics();

    fireEvent.click(await screen.findByRole('button', { name: 'Load the solutions' }));

    expect(await screen.findByText(/That run opens only for whoever launched it \(404 · not_found\)\./)).toBeInTheDocument();
  });

  it('explains there is nothing to chart before any cell completes', async () => {
    platform.studyCells.mockResolvedValue(cells.map((cell) => ({ ...cell, state: 'cancelled' as const, metrics: {}, job_id: null })));
    platform.analytics.mockResolvedValue(analyticsFixture({ feasible: 0, runtimes_s: [], objective_distributions: {} }));
    renderAnalytics();

    expect(await screen.findByText(/No completed cells yet, so there’s nothing to chart\./)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Engine ranking' })).not.toBeInTheDocument();
  });

  it('says a trade-off needs two objectives', async () => {
    platform.studyCells.mockResolvedValue(cells.map((cell) => ({ ...cell, metrics: cell.state === 'completed' ? { ...cell.metrics, objectives: { cost: (cell.metrics as { objectives: { cost: number } }).objectives.cost } } : cell.metrics })));
    renderAnalytics();

    expect(await screen.findByText('A trade-off needs two objectives, and this run recorded one.')).toBeInTheDocument();
  });

  it('lets a viewer read everything', async () => {
    renderAnalytics({ slug: 'read-lab' });

    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Provenance of every cell' })).toBeInTheDocument();
  });

  it('answers a run that is not there with a neutral 404', async () => {
    platform.analytics.mockRejectedValue(refusal(404, 'not_found'));
    renderAnalytics();

    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeInTheDocument();
    expect(screen.getByText('No such run in QoS Benchmarks (404).')).toBeInTheDocument();
  });

  it('offers a retry when the analytics cannot be loaded', async () => {
    platform.analytics.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderAnalytics();

    expect(await screen.findByText(/Analytics couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Compare results · run #1' })).toBeInTheDocument());
  });
});

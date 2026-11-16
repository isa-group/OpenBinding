import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Job } from '../../api/platform';
import { org, renderOrgScreen } from '../../features/workspace/testKit';
import { saveBytes } from '../../features/workspace/download';
import type { JobDetail as RunView } from '../../api/runs';
import { NEIGHBORHOOD, PROBLEM_FACTS, RESULT, S1, detailOf, jobOf } from '../../test/fixtures/jobs';
import { RunDetail } from './RunDetail';

const runsApi = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), cancel: vi.fn(), retry: vi.fn(), neighborhood: vi.fn() }));
const problems = vi.hoisted(() => ({ ir: vi.fn(), revision: vi.fn() }));

vi.mock('../../api/runs', async () => ({ ...await vi.importActual<typeof import('../../api/runs')>('../../api/runs'), runsApi }));
const facts = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../entities/problem/facts', async (actual) => ({ ...await actual<typeof import('../../entities/problem/facts')>(), problemFactsApi: facts }));
vi.mock('../../features/workspace/download', () => ({ saveBytes: vi.fn() }));
const compositions = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), derive: vi.fn() }));
vi.mock('../../entities/composition/api', () => ({ compositionsApi: compositions }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const reader = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const ROOT = '/app/isa-demo';
const JOB_ID = '3f2b9c1e-7d41-4a8e-9b60-c5d1e2f3a4b5';
const RUN_DIGEST = `sha256-${'ab12cd34ef56'.repeat(5)}`;

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function renderJob(id = JOB_ID, root = ROOT) {
  return renderOrgScreen(<RunDetail />, { path: '/app/:org/runs/:job', url: `${root}/runs/${id}`, organizations: [group, reader] });
}

const LUCIA = { id: 'user-lucia', username: 'lucia.vega' };
const meta = (status: string, over: Partial<Job> = {}) => jobOf(JOB_ID, 'random-search', status, status === 'completed' ? 'FEASIBLE' : null, '2026-09-30T09:00:00Z', status === 'completed' ? '2026-09-30T09:01:05Z' : null, { result: { provenance: { irDigest: RUN_DIGEST } }, created_by: LUCIA, ...over });
/** What `getRun` answers: the summary of the run and its detail (result, provenance, refs, what the engine reported). */
const full = (status: string, over: Partial<RunView> = {}, summary: Partial<Job> = {}): RunView => ({ ...meta(status, summary), ...detailOf(JOB_ID, status, over) }) as RunView;

describe('One run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runsApi.get.mockResolvedValue(full('completed'));
    runsApi.list.mockResolvedValue({ total: 2, runs: [meta('completed'), jobOf('job-other-9', 'minizinc', 'completed', 'OPTIMAL', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z')] });
    problems.ir.mockResolvedValue({ id: 'compilation-2', ir_digest: 'sha256-c', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, source_map: {} });
    facts.get.mockResolvedValue(PROBLEM_FACTS);
    problems.revision.mockResolvedValue({ document: { apiVersion: 'bim/v1', kind: 'Instance' } });
    runsApi.neighborhood.mockResolvedValue(NEIGHBORHOOD);
    compositions.list.mockResolvedValue({ compositions: [], total: 0, limit: 200, offset: 0 });
  });

  it('shows a finished run: its state, outcome, who ran it and from what', async () => {
    renderJob();

    expect(await screen.findByRole('heading', { level: 1, name: 'random-search run' })).toBeInTheDocument();
    const header = screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement;
    expect(within(header).getByText('Completed')).toBeInTheDocument();
    expect(within(header).getByText('Feasible: meets every must-hold rule')).toBeInTheDocument();
    expect(await within(header).findByText(/launched Sep 30, 2026, 09:00 UTC by you · problem Checkout flow · version 2/)).toBeInTheDocument();
    expect(within(header).getByText(/random-search 1\.0\.0 · mode sampling/)).toBeInTheDocument();
    expect(within(header).queryByRole('link', { name: 'Analyze' })).not.toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Runs' })).toHaveAttribute('href', `${ROOT}/runs`);
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', ROOT);
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
    expect(runsApi.get).toHaveBeenCalledWith('isa-demo', JOB_ID);
  });

  it('draws the timeline from status changes and says it has no progress bar', async () => {
    renderJob();

    const section = await screen.findByRole('region', { name: 'Timeline' });
    expect(within(section).getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent)).toEqual(['Queued', 'Running', 'Completed']);
    expect(within(section).getByText('Finished · not live')).toBeInTheDocument();
    expect(within(section).getByText('Live updates report status changes only; there’s no progress percentage to show.')).toBeInTheDocument();
  });

  it('puts what was asked beside what was used and names the reduction', async () => {
    renderJob();

    const table = await screen.findByRole('region', { name: 'Settings asked and used' });
    const budget = within(table).getByRole('row', { name: /Time budget/ });
    expect(within(budget).getByText('600 s')).toBeInTheDocument();
    expect(within(budget).getByText('60 s')).toBeInTheDocument();
    expect(within(budget).getByText('Reduced to the plan’s ceiling')).toBeInTheDocument();
    const iterations = within(table).getByRole('row', { name: /Iterations/ });
    expect(within(iterations).queryByText('Reduced to the plan’s ceiling')).not.toBeInTheDocument();
  });

  it('shows a completed job through the run result, with names, bounds and raw JSON only behind View source', async () => {
    renderJob();

    const run = await screen.findByRole('region', { name: 'Run result' });
    expect(within(run).getByText('FEASIBLE')).toBeInTheDocument();
    const providers = await within(run).findByRole('region', { name: 'Chosen providers' });
    // The facts name a task by its id and a candidate as the problem writes it; their values and units come along.
    const payment = await within(providers).findByRole('row', { name: /^t1/ });
    expect(payment).toHaveTextContent('c1');
    expect(payment).toHaveTextContent('stripe');
    expect(payment).toHaveTextContent('120');
    expect(within(providers).queryByRole('row', { name: /pay-card payco-eu/ })).not.toBeInTheDocument();

    const figures = within(run).getByRole('list', { name: 'Quality of this combination' });
    expect(within(figures).getByText('latency').closest('li')).toHaveTextContent(/latency.*420/);
    expect(within(figures).getByText('cost').closest('li')).toHaveTextContent(/cost.*9\.5/);
    expect(within(figures).queryByText('Objective')).not.toBeInTheDocument();

    const bounds = within(run).getByRole('region', { name: 'QoS against bounds' });
    expect(await within(bounds).findByText('rules/max-latency')).toBeInTheDocument();
    expect(within(run).getByRole('region', { name: 'Trade-off set' })).toBeInTheDocument();
    expect(within(run).getByText('Numbers are OpenBinding’s own re-check of the engine’s answer.')).toBeInTheDocument();
    expect(await within(run).findByText('Solved with presolve')).toBeInTheDocument();

    const source = within(run).getByText('View source').closest('details') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    expect(within(run).getByRole('region', { name: 'Solution 1 source', hidden: true })).not.toBeVisible();
    expect(within(run).getByRole('region', { name: 'Engine report source', hidden: true })).not.toBeVisible();
    const log = run.lastElementChild as HTMLElement;
    expect(log.tagName).toBe('DETAILS');
    expect(log.querySelector('summary')).toHaveTextContent(/^Engine log/);
  });

  it('loads the facts of the compiled problem once for a completed job, takes the engine report from the run, and has no compare button', async () => {
    renderJob();

    await screen.findByRole('region', { name: 'Chosen providers' });
    await waitFor(() => expect(facts.get).toHaveBeenCalledTimes(1));
    expect(facts.get).toHaveBeenCalledWith('isa-demo', 'checkout-flow', 2, 'compilation-2');
    expect(problems.ir).not.toHaveBeenCalled();
    expect(await screen.findByText('Solved with presolve')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'The engine’s own report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'The engine’s own report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compare with the engine' })).not.toBeInTheDocument();
  });

  it('says the compiled problem is not available (404, then 409) and shows ids, with no notice when the engine reported nothing', async () => {
    const note = 'The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.';
    facts.get.mockRejectedValue(refusal(404, 'not_found'));
    runsApi.get.mockResolvedValue(full('completed', { remote: {} }));
    const view = renderJob();

    const run = await screen.findByRole('region', { name: 'Run result' });
    expect(await within(run).findByText(note)).toBeInTheDocument();
    expect(within(run).getByText('FEASIBLE')).toBeInTheDocument();
    expect(within(run).queryByRole('list', { name: 'Engine notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('stripe')).not.toBeInTheDocument();
    view.unmount();

    facts.get.mockRejectedValue(refusal(409, 'analysis_unavailable'));
    renderJob();
    const again = await screen.findByRole('region', { name: 'Run result' });
    expect(await within(again).findByText(note)).toBeInTheDocument();
  });

  it.each([
    ['queued', 'No result yet. It appears here when the run finishes.'],
    ['running', 'No result yet. It appears here when the run finishes.'],
    ['cancelled', 'Cancelled before producing a result.'],
    ['failed', 'Engine crashed. Retrying starts a new attempt.'],
  ])('fetches no compiled problem for a %s job', async (status, words) => {
    runsApi.get.mockResolvedValue(full(status, status === 'failed' ? { result: { error: 'Engine crashed' } } : {}));
    renderJob();

    await screen.findByRole('heading', { level: 1, name: 'random-search run' });
    if (status === 'failed') {
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('The run failed')).toBeInTheDocument();
      expect(alert).toHaveTextContent(words);
    } else {
      expect(await screen.findByText(words)).toBeInTheDocument();
    }
    expect(screen.queryByRole('region', { name: 'Run result' })).not.toBeInTheDocument();
    expect(facts.get).not.toHaveBeenCalled();
  });

  it('says which problem version and which compilation the run used', async () => {
    renderJob();

    const where = (await screen.findByRole('heading', { name: 'Where this result comes from' })).closest('section') as HTMLElement;
    expect(await within(where).findByRole('link', { name: 'Source and compiled form' })).toHaveAttribute('href', '/app/isa-demo/problems/checkout-flow/source?version=2');
    expect(await within(where).findByRole('link', { name: 'Checkout flow · version 2' })).toHaveAttribute('href', '/app/isa-demo/problems/checkout-flow?version=2');
    expect(within(where).getByText('bim.builtin/random-search 1.0.0 · mode sampling', { exact: false })).toBeInTheDocument();
    expect(within(where).getByText('bim-reference-evaluator/v1')).toBeInTheDocument();
    expect(within(where).getByText('60 s per run')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|job-/i);
    expect(within(where).getAllByRole('button', { name: /^Copy .* digest$/ }).length).toBeGreaterThan(0);
  });

  it('offers no way to add the result to a report', async () => {
    renderJob();

    const where = (await screen.findByRole('heading', { name: 'Where this result comes from' })).closest('section') as HTMLElement;
    expect(within(where).getByRole('button', { name: 'Download compiled problem' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add to a report' })).not.toBeInTheDocument();
    expect(screen.queryByText('Add to a report')).not.toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.length).toBeGreaterThan(3);
    expect(hrefs.filter((href) => /\/reports([/?#]|$)/.test(href))).toEqual([]);
  });

  it('downloads the compiled problem, the instance and the result', async () => {
    renderJob();

    const where = (await screen.findByRole('heading', { name: 'Where this result comes from' })).closest('section') as HTMLElement;
    fireEvent.click(within(where).getByRole('button', { name: 'Download compiled problem' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'run-compiled-problem.json', 'application/json'));
    fireEvent.click(within(where).getByRole('button', { name: 'Download result' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'run-result.json', 'application/json'));
    expect(problems.ir).toHaveBeenCalledWith('isa-demo', 'checkout-flow', 2, 'compilation-2');
    fireEvent.click(within(where).getByRole('button', { name: 'Download instance' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'run-instance.json', 'application/json'));
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'checkout-flow', 2);
  });

  it('checks the single swaps on request, never on its own', async () => {
    renderJob();

    const swaps = (await screen.findByRole('heading', { name: 'What if one task used another provider?' })).closest('section') as HTMLElement;
    expect(runsApi.neighborhood).not.toHaveBeenCalled();
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));

    const list = await within(swaps).findByRole('list', { name: 'Single-task swaps' });
    expect(within(list).getByText('pay-card now')).toBeInTheDocument();
    expect(within(list).getByText('catalog · fastpay')).toBeInTheDocument();
    expect(within(list).getByText('Better')).toBeInTheDocument();
    expect(within(list).getByText('cost +0.013 · latency −85')).toBeInTheDocument();
    expect(within(swaps).getByText(/Checked 1 of 3 possible swaps \(up to 128\) without running the engine again\./)).toBeInTheDocument();
    expect(runsApi.neighborhood).toHaveBeenCalledWith('isa-demo', JOB_ID, 0, '', 128);
  });

  it('words a trade-off swap as the gateway compares it', async () => {
    runsApi.neighborhood.mockResolvedValueOnce({ ...NEIGHBORHOOD, moves: [{ ...NEIGHBORHOOD.moves[0], comparison: 'trade-off' }] });
    renderJob();

    const swaps = (await screen.findByRole('heading', { name: 'What if one task used another provider?' })).closest('section') as HTMLElement;
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));

    const list = await within(swaps).findByRole('list', { name: 'Single-task swaps' });
    expect(within(list).getByText('Trade-off')).toBeInTheDocument();
    expect(within(list).queryByText('Checked')).toBeNull();
  });

  it('says so when the analysis is busy or the compiled problem is gone', async () => {
    runsApi.neighborhood.mockRejectedValueOnce(refusal(429, 'analysis_busy'));
    renderJob();

    const swaps = (await screen.findByRole('heading', { name: 'What if one task used another provider?' })).closest('section') as HTMLElement;
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));
    expect(await within(swaps).findByText(/The analysis service is busy \(429/)).toBeInTheDocument();
    runsApi.neighborhood.mockRejectedValueOnce(refusal(409, 'analysis_unavailable'));
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));
    expect(await within(swaps).findByText(/isn’t available for analysis any more \(409/)).toBeInTheDocument();
  });

  it('shows the claimed and evaluated values as a fixed part of the run, from the engine report loaded with it', async () => {
    renderJob();

    const run = await screen.findByRole('region', { name: 'Run result' });
    expect(within(run).getByRole('region', { name: 'Claimed and evaluated values' })).toBeInTheDocument();
    expect(await within(run).findByText('Solved with presolve')).toBeInTheDocument();
  });

  it('puts the swaps panel inside the run result, its source behind View source', async () => {
    renderJob();

    const run = await screen.findByRole('region', { name: 'Run result' });
    const swaps = (await within(run).findByRole('heading', { name: 'What if one task used another provider?' })).closest('section') as HTMLElement;
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));
    const list = await within(swaps).findByRole('list', { name: 'Single-task swaps' });
    const disclosure = within(swaps).getByText('View source').closest('details') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(within(swaps).getByRole('region', { name: 'Swaps source', hidden: true })).toBeInTheDocument();
    expect(list.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const runSource = within(run).getAllByText('View source').map((node) => node.closest('details') as HTMLElement).find((d) => !swaps.contains(d)) as HTMLElement;
    expect(list.compareDocumentPosition(runSource) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps a run of another organization, or one that does not exist, as one neutral answer', async () => {
    runsApi.get.mockRejectedValue(refusal(404, 'not_found'));
    renderJob('job-theirs-2');

    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeInTheDocument();
    expect(screen.getByText(/Everyone else, including platform administrators, gets this same answer\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute('href', `${ROOT}/runs`);
    expect(runsApi.list).not.toHaveBeenCalled();
    expect(facts.get).not.toHaveBeenCalled();
  });

  it('explains a key without jobs:read and a gateway that does not answer', async () => {
    runsApi.get.mockRejectedValueOnce(refusal(403, 'api_key_forbidden'));
    const view = renderJob();
    expect(await screen.findByText(/This API key can’t read runs or doesn’t include this engine \(403/)).toBeInTheDocument();
    view.unmount();

    runsApi.get.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderJob();
    expect(await screen.findByText(/The run couldn’t be loaded \(503/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Run not found' })).not.toBeInTheDocument();
  });

  it('follows a run that is still going until it finishes', async () => {
    runsApi.get.mockResolvedValueOnce(full('running')).mockResolvedValue(full('completed'));
    renderJob();

    expect(await screen.findByText('Live · connected')).toBeInTheDocument();
    expect(screen.getByText('No result yet. It appears here when the run finishes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(await screen.findByText('Finished · not live', undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Run result' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  }, 15_000);

  it('cancels a running job and says the engine stops at its next check', async () => {
    runsApi.get.mockResolvedValue(full('running'));
    runsApi.cancel.mockResolvedValue(meta('running', { cancellation_requested: true }));
    renderJob();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Cancellation requested. The engine stops at its next check.')).toBeInTheDocument();
    expect(runsApi.cancel).toHaveBeenCalledWith('isa-demo', JOB_ID);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('says a run had already finished when the gateway refuses to cancel it (409)', async () => {
    runsApi.get.mockResolvedValue(full('running'));
    runsApi.cancel.mockRejectedValue(refusal(409, 'terminal_job'));
    renderJob();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Already finished (409 · terminal_job)')).toBeInTheDocument();
    expect(screen.getByText(/had already finished, so it can’t be cancelled/)).toBeInTheDocument();
  });

  it('shows why a run failed and retries it as a new attempt', async () => {
    runsApi.get.mockResolvedValue(full('failed'));
    runsApi.retry.mockResolvedValue(jobOf('job-new-5', 'random-search', 'queued', null, '2026-10-09T08:00:00Z', null, { retry_of_id: JOB_ID }));
    renderJob();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The run failed')).toBeInTheDocument();
    expect(alert).toHaveTextContent('The deployment didn’t answer within the budget (engine unreachable). Retrying starts a new attempt.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Retry queued as a new attempt.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/runs/job-new-5`);
  });

  it('explains a run that failed because the engine takes single values only, and points at Engines', async () => {
    runsApi.get.mockResolvedValue(full('failed', {
      result: {
        code: 'unsupported_capability_value',
        error: 'unsupported_capability_value: unsupported ["interval"]',
        diagnostics: [{ message: 'featureValues interval is not declared', pointer: '/spec/candidates/providers/candidates/fastpay/features/latency' }],
      },
    }));
    renderJob();

    const notice = (await screen.findByText(/^This engine only accepts single values/)).closest('.ui-notice') as HTMLElement;
    expect(notice).toHaveTextContent('This package has range features');
    expect(notice).not.toHaveTextContent('Nothing was started.');
    expect(notice).toHaveTextContent('featureValues interval is not declared (/spec/candidates/providers/candidates/fastpay/features/latency)');
    expect(within(notice).getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
    expect(within(notice).queryByRole('link', { name: 'Edit the candidate' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the library' })).toBeNull();
    expect(screen.queryByRole('link', { name: /library/i })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Engines' }).length).toBeGreaterThan(0);
  });

  it('says nothing about ranges when a run failed for another reason', async () => {
    runsApi.get.mockResolvedValue(full('failed'));
    renderJob();

    await screen.findByRole('alert');
    expect(screen.queryByText(/only accepts single values/)).not.toBeInTheDocument();
  });

  it.each([
    [402, 'quota_exceeded', /Retry refused: Out of allowance/],
    [429, 'concurrency_limit_exceeded', /Retry refused: All your run slots are busy \(429/],
    [503, 'pricing_unavailable', /Limits can’t be checked right now \(503/],
  ])('words a refused retry (%i)', async (status, code, words) => {
    runsApi.get.mockResolvedValue(full('failed'));
    runsApi.retry.mockRejectedValue(refusal(status, code));
    renderJob();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
  });

  it('shows a cancelled run without a result and lets it be retried', async () => {
    runsApi.get.mockResolvedValue(full('cancelled', {}, { finished_at: '2026-09-30T09:00:03Z' }));
    renderJob();

    expect(await screen.findByText('Cancelled before producing a result.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('explains an infeasible result after the verdict and shows the best attempt’s parts below', async () => {
    const attempt = {
      ...S1,
      features: { latency: 742, cost: 9.5 },
      violations: [{ constraint: { resource: 'rules', id: 'max-latency' }, enforcement: 'hard', message: 'Total latency is 742 ms; at most 600 ms is allowed.' }],
    };
    runsApi.get.mockResolvedValue(full('completed', { result: { ...RESULT, termination: 'INFEASIBLE', solutions: [attempt] } }));
    renderJob();

    const run = await screen.findByRole('region', { name: 'Run result' });
    const heading = await within(run).findByRole('heading', { name: 'Why no combination works' });
    const why = heading.closest('section') as HTMLElement;
    expect(within(why).getByText(/Total latency is 742 ms/)).toBeInTheDocument();
    expect(await within(why).findByRole('link', { name: 'See the rules' })).toHaveAttribute('href', '/app/isa-demo/problems/checkout-flow?version=2');
    expect(within(why).getByRole('link', { name: 'Try faster providers' })).toHaveAttribute('href', '/app/isa-demo/problem-editor?problem=checkout-flow&revision=2');

    const badge = within(run).getByText('INFEASIBLE');
    const bounds = await within(run).findByRole('region', { name: 'QoS against bounds' });
    const follows = (before: Element, after: Element) => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(badge, heading)).toBe(true);
    expect(follows(heading, bounds)).toBe(true);
    expect(within(run).getByRole('region', { name: 'Chosen providers' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Best combination found' })).not.toBeInTheDocument();
    expect(within(run).queryByRole('heading', { name: 'What if one task used another provider?' })).not.toBeInTheDocument();
  });

  it('opens another run of the organization', async () => {
    renderJob();

    const picker = await screen.findByRole('combobox', { name: 'Another run of the organization' });
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['This run', 'minizinc · Oct 1, 2026, 09:00 UTC']);
    expect(runsApi.list).toHaveBeenCalledWith('isa-demo', { limit: 26 });
  });

  it('shows a teammate’s run with who launched it, and lets a VIEWER read it without cancelling or retrying', async () => {
    runsApi.get.mockResolvedValue(full('running', {}, { created_by: { id: 'user-ana', username: 'ana' } }));
    const view = renderJob();
    expect(await screen.findByText(/launched Sep 30, 2026, 09:00 UTC by ana/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    view.unmount();

    runsApi.get.mockResolvedValue(full('failed', {}, { created_by: { id: 'user-ana', username: 'ana' } }));
    renderJob(JOB_ID, '/app/read-lab');
    expect(await screen.findByRole('alert')).toHaveTextContent('The run failed');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(runsApi.get).toHaveBeenLastCalledWith('read-lab', JOB_ID);
  });

  it('offers a MEMBER to derive a composition from a completed run, with its solutions, in a dialog', async () => {
    renderJob();

    const panel = await screen.findByRole('region', { name: 'Keep it as a composition' });
    expect(within(screen.getByRole('region', { name: 'Run result' })).getByRole('region', { name: 'Keep it as a composition' })).toBe(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Derive composition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Derive a composition' });
    await waitFor(() => expect(compositions.list).toHaveBeenCalledWith('isa-demo', { archived: false, sort: 'updated', limit: 200 }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Checkout plan' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const points = await within(dialog).findByRole('region', { name: 'Solutions of the run' });
    expect(within(points).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual(['Solution 1', 'Solution 2']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Derive a composition' })).not.toBeInTheDocument());
    expect(compositions.create).not.toHaveBeenCalled();
  });

  it('offers no derivation to a VIEWER, nor for a run with no solution to keep', async () => {
    const view = renderJob(JOB_ID, '/app/read-lab');
    await screen.findByRole('region', { name: 'Run result' });
    expect(screen.queryByRole('button', { name: 'Derive composition' })).not.toBeInTheDocument();
    view.unmount();

    runsApi.get.mockResolvedValue(full('completed', { result: { ...RESULT, termination: 'INFEASIBLE', solutions: [S1] } }));
    const infeasible = renderJob();
    await screen.findByRole('heading', { name: 'Why no combination works' });
    expect(screen.queryByRole('button', { name: 'Derive composition' })).not.toBeInTheDocument();
    infeasible.unmount();

    runsApi.get.mockResolvedValue(full('completed', { result: { termination: 'FEASIBLE', solutions: [] } }));
    renderJob();
    await screen.findByRole('region', { name: 'Run result' });
    expect(screen.queryByRole('button', { name: 'Derive composition' })).not.toBeInTheDocument();
  });
});

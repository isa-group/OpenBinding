import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Job } from '../../api/platform';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { saveBytes } from '../Project/download';
import { INSTANCE, NEIGHBORHOOD, REPORT, detailOf, jobOf, provenanceOf } from '../../test/fixtures/jobs';
import { JobDetail } from './JobDetail';

const jobsApi = vi.hoisted(() => ({ detail: vi.fn(), inProject: vi.fn(), mine: vi.fn(), instance: vi.fn(), cancel: vi.fn(), retry: vi.fn(), report: vi.fn(), ir: vi.fn() }));
const platform = vi.hoisted(() => ({ project: vi.fn(), cases: vi.fn(), revisions: vi.fn() }));
const client = vi.hoisted(() => ({ getBindingNeighborhood: vi.fn() }));

vi.mock('../../api/jobs', () => ({ jobsApi }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../Project/download', () => ({ saveBytes: vi.fn() }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const flujo = caseOf('flujo', 'Flujo de checkout');
const ROOT = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function renderJob(id = 'job-done-3') {
  return renderProjectScreen(<JobDetail />, { path: '/app/:org/:project/jobs/:job', url: `${ROOT}/jobs/${id}`, organizations: [group] });
}

const meta = (status: string, over: Partial<Job> = {}) => jobOf('job-done-3', 'random-search', status, status === 'completed' ? 'FEASIBLE' : null, '2026-09-30T09:00:00Z', status === 'completed' ? '2026-09-30T09:01:05Z' : null, over);

describe('One run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([flujo]);
    platform.revisions.mockResolvedValue([revisionOf(flujo, 1, { source_snapshot_id: 'snapshot-1' }), revisionOf(flujo, 2, { source_snapshot_id: 'snapshot-2' })]);
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'completed'));
    jobsApi.inProject.mockResolvedValue(meta('completed'));
    jobsApi.mine.mockResolvedValue([meta('completed'), jobOf('job-other-9', 'minizinc', 'completed', 'OPTIMAL', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z')]);
    jobsApi.instance.mockResolvedValue(INSTANCE);
    jobsApi.report.mockResolvedValue(REPORT);
    jobsApi.ir.mockResolvedValue({ kind: 'BindingProblem' });
    client.getBindingNeighborhood.mockResolvedValue(NEIGHBORHOOD);
  });

  it('shows a finished run: its state, outcome, who ran it and from what', async () => {
    renderJob();

    expect(await screen.findByRole('heading', { level: 1, name: 'random-search run' })).toBeInTheDocument();
    const header = screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement;
    expect(within(header).getByText('Completed')).toBeInTheDocument();
    expect(within(header).getByText('Feasible: meets every must-hold rule')).toBeInTheDocument();
    expect(await within(header).findByText(/launched Sep 30, 2026, 09:00 UTC by you · case Flujo de checkout/)).toBeInTheDocument();
    expect(within(header).getByText(/random-search 1\.0\.0 · mode sampling/)).toBeInTheDocument();
    expect(within(header).getByRole('link', { name: 'Analyze' })).toHaveAttribute('href', '/app/analysis/workspace?job=job-done-3');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', `${ROOT}/jobs`);
    expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    expect(jobsApi.detail).toHaveBeenCalledWith('job-done-3');
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

  it('shows the authoritative result as figures and a table of chosen providers, with raw JSON only behind View source', async () => {
    renderJob();

    expect(await screen.findByRole('heading', { name: 'Best combination found' })).toBeInTheDocument();
    const figures = screen.getByRole('list', { name: 'Quality of this combination' });
    expect(within(figures).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Objective0.2536weighted · lower is better', 'cost0.118', 'latency412', 'Nice-to-have rules0penalty',
    ]);
    const providers = screen.getByRole('region', { name: 'Chosen providers' });
    expect(within(providers).getAllByRole('row')).toHaveLength(4);
    expect(within(providers).getByRole('row', { name: /pay-card payco-eu/ })).toBeInTheDocument();
    expect(screen.getByText('Numbers are OpenBinding’s own re-check of the engine’s answer.')).toBeInTheDocument();
    expect(screen.getByLabelText('Solution 1 source')).not.toBeVisible();
  });

  it('says which snapshot and which case revision the run used', async () => {
    renderJob();

    const where = (await screen.findByRole('heading', { name: 'Where this result comes from' })).closest('section') as HTMLElement;
    expect(await within(where).findByRole('link', { name: /^Snapshot snapshot/ })).toHaveAttribute('href', `${ROOT}/snapshots/snapshot-2`);
    expect(await within(where).findByRole('link', { name: 'Flujo de checkout · revision 2' })).toHaveAttribute('href', `${ROOT}/cases/flujo/revisions/2`);
    expect(within(where).getByText('bim.builtin/random-search 1.0.0 · mode sampling', { exact: false })).toBeInTheDocument();
    expect(within(where).getByText('bim-reference-evaluator/v1')).toBeInTheDocument();
    expect(within(where).getByText('60 s per run')).toBeInTheDocument();
    expect(within(where).getByRole('link', { name: 'Add to a report' })).toHaveAttribute('href', `${ROOT}/reports`);
  });

  it('downloads the compiled problem, the instance and the result', async () => {
    renderJob();

    const where = (await screen.findByRole('heading', { name: 'Where this result comes from' })).closest('section') as HTMLElement;
    fireEvent.click(within(where).getByRole('button', { name: 'Download compiled problem' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'job-job-done-compiled-problem.json', 'application/json'));
    fireEvent.click(within(where).getByRole('button', { name: 'Download result' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'job-job-done-result.json', 'application/json'));
    expect(jobsApi.ir).toHaveBeenCalledWith('job-done-3');
  });

  it('checks the single swaps on request, never on its own', async () => {
    renderJob();

    const swaps = (await screen.findByRole('heading', { name: 'What if one task used another provider?' })).closest('section') as HTMLElement;
    expect(client.getBindingNeighborhood).not.toHaveBeenCalled();
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));

    const list = await within(swaps).findByRole('list', { name: 'Single-task swaps' });
    expect(within(list).getByText('pay-card now')).toBeInTheDocument();
    expect(within(list).getByText('catalog · fastpay')).toBeInTheDocument();
    expect(within(list).getByText('Better')).toBeInTheDocument();
    expect(within(list).getByText('cost +0.013 · latency −85')).toBeInTheDocument();
    expect(within(swaps).getByText(/Checked 1 of 3 possible swaps \(up to 128\) without running the engine again\./)).toBeInTheDocument();
    expect(client.getBindingNeighborhood).toHaveBeenCalledWith('job-done-3', 0, '', 128);
  });

  it('says so when the analysis is busy or the compiled problem is gone', async () => {
    client.getBindingNeighborhood.mockRejectedValueOnce(refusal(429, 'analysis_busy'));
    renderJob();

    const swaps = (await screen.findByRole('heading', { name: 'What if one task used another provider?' })).closest('section') as HTMLElement;
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));
    expect(await within(swaps).findByText(/The analysis service is busy \(429/)).toBeInTheDocument();
    client.getBindingNeighborhood.mockRejectedValueOnce(refusal(409, 'analysis_unavailable'));
    fireEvent.click(within(swaps).getByRole('button', { name: 'Check single swaps' }));
    expect(await within(swaps).findByText(/isn’t available for analysis any more \(409/)).toBeInTheDocument();
  });

  it('compares the gateway’s re-check with the engine’s own report', async () => {
    renderJob();

    const report = (await screen.findByRole('heading', { name: 'The engine’s own report' })).closest('section') as HTMLElement;
    fireEvent.click(within(report).getByRole('button', { name: 'Compare with the engine' }));
    // Both sides say the same here: OpenBinding’s re-check and the engine’s own account.
    expect(await within(report).findAllByText('FEASIBLE · 1 solution')).toHaveLength(2);
    expect(within(report).getByText('Yes, they agree.')).toBeInTheDocument();
    expect(within(report).getByText('OpenBinding’s re-check')).toBeInTheDocument();
  });

  it('keeps a run that is not yours, or does not exist, as one neutral answer', async () => {
    jobsApi.detail.mockRejectedValue(refusal(404, 'not_found'));
    renderJob('job-theirs-2');

    expect(await screen.findByRole('heading', { name: 'Job not found' })).toBeInTheDocument();
    expect(screen.getByText(/Everyone else, including platform administrators, gets this same answer\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', `${ROOT}/jobs`);
    expect(jobsApi.inProject).not.toHaveBeenCalled();
    expect(jobsApi.instance).not.toHaveBeenCalled();
  });

  it('explains a key without jobs:read and a gateway that does not answer', async () => {
    jobsApi.detail.mockRejectedValueOnce(refusal(403, 'api_key_forbidden'));
    const view = renderJob();
    expect(await screen.findByText(/This API key can’t read jobs or doesn’t include this engine \(403/)).toBeInTheDocument();
    view.unmount();

    jobsApi.detail.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderJob();
    expect(await screen.findByText(/The job couldn’t be loaded \(503/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Job not found' })).not.toBeInTheDocument();
  });

  it('follows a run that is still going until it finishes', async () => {
    jobsApi.detail.mockResolvedValueOnce(detailOf('job-done-3', 'running')).mockResolvedValue(detailOf('job-done-3', 'completed'));
    jobsApi.inProject.mockResolvedValue(meta('running'));
    renderJob();

    expect(await screen.findByText('Live · connected')).toBeInTheDocument();
    expect(screen.getByText('No result yet. It appears here when the run finishes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(await screen.findByText('Finished · not live', undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Best combination found' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  }, 15_000);

  it('cancels a running job and says the engine stops at its next check', async () => {
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'running'));
    jobsApi.cancel.mockResolvedValue(meta('running', { cancellation_requested: true }));
    renderJob();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Cancellation requested. The engine stops at its next check.')).toBeInTheDocument();
    expect(jobsApi.cancel).toHaveBeenCalledWith('job-done-3');
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('says a run had already finished when the gateway refuses to cancel it (409)', async () => {
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'running'));
    jobsApi.cancel.mockRejectedValue(refusal(409, 'terminal_job'));
    renderJob();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Already finished (409 · terminal_job)')).toBeInTheDocument();
    expect(screen.getByText(/had already finished, so it can’t be cancelled/)).toBeInTheDocument();
  });

  it('shows why a run failed and retries it as a new attempt', async () => {
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'failed'));
    jobsApi.retry.mockResolvedValue(jobOf('job-new-5', 'random-search', 'queued', null, '2026-10-09T08:00:00Z', null, { retry_of_id: 'job-done-3' }));
    renderJob();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The run failed')).toBeInTheDocument();
    expect(alert).toHaveTextContent('The deployment didn’t answer within the budget (engine unreachable). Retrying starts a new attempt and counts as a solve.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Retry queued as a new attempt. It counts as a new solve.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-5`);
  });

  it.each([
    [402, 'quota_exceeded', /Retry refused: Out of solves this month/],
    [429, 'concurrency_limit_exceeded', /Retry refused: All your job slots are busy \(429/],
    [503, 'pricing_unavailable', /Limits can’t be checked right now \(503/],
  ])('words a refused retry (%i)', async (status, code, words) => {
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'failed'));
    jobsApi.retry.mockRejectedValue(refusal(status, code));
    renderJob();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
  });

  it('shows a cancelled run without a result and lets it be retried', async () => {
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'cancelled'));
    jobsApi.inProject.mockResolvedValue(meta('cancelled', { finished_at: '2026-09-30T09:00:03Z' }));
    renderJob();

    expect(await screen.findByText('Cancelled before producing a result.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('explains an infeasible result and points back to the rules', async () => {
    jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'completed', {
      result: { termination: 'INFEASIBLE', solutions: [{ violations: [{ constraint: 'sla-latencia', message: 'Total latency is 742 ms; at most 600 ms is allowed.' }] }] },
    }));
    renderJob();

    const why = (await screen.findByRole('heading', { name: 'Why no combination works' })).closest('section') as HTMLElement;
    expect(within(why).getByText(/sla-latencia/)).toBeInTheDocument();
    expect(within(why).getByText(/Total latency is 742 ms/)).toBeInTheDocument();
    expect(await within(why).findByRole('link', { name: 'See the rules' })).toHaveAttribute('href', `${ROOT}/cases/flujo/revisions/2`);
    expect(within(why).getByRole('link', { name: 'Try faster providers' })).toHaveAttribute('href', `${ROOT}/cases/flujo/compose`);
    expect(screen.queryByRole('heading', { name: 'Best combination found' })).not.toBeInTheDocument();
  });

  describe('a run the AutoRouter placed', () => {
    const routed = provenanceOf({
      engineRouting: {
        selectedEngine: 'evolutionary-heuristics', selectedMode: 'elitist-genetic', adaptationReason: 'Selected evolutionary-heuristics with utility score 0.884',
        utilityScore: 0.884, creditsCost: 8, fallbackActivated: true,
      },
      engineRoutingAdmin: {
        adaptationLoopId: 'loop-xyz-99',
        workloadFeatures: { S: 12.3, N_tasks: 10 },
        candidateEvaluations: [
          { engine: 'evolutionary-heuristics', admissible: true, utility: 0.884 },
          { engine: 'minizinc-csp', admissible: false, utility: 0.45, rejectionReason: 'Exceeded phase transition limit' },
        ],
      },
    });

    it('shows the engine it chose, why, what it cost, and the telemetry an administrator gets', async () => {
      jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'completed', { provenance: routed }));
      renderJob();

      const card = (await screen.findByRole('heading', { name: 'AutoRouter decision' })).closest('section') as HTMLElement;
      expect(within(card).getByText('evolutionary-heuristics · elitist-genetic')).toBeInTheDocument();
      expect(within(card).getByText('Fallback activated')).toBeInTheDocument();
      expect(within(card).getByText('Selected evolutionary-heuristics with utility score 0.884')).toBeInTheDocument();
      expect(within(card).getByText(/Utility 0\.884/)).toBeInTheDocument();
      expect(within(card).getByText(/Cost 8 CU/)).toBeInTheDocument();
      expect(within(card).getByText('Routing diagnostics (administrators, own runs)')).toBeInTheDocument();
      expect(within(card).getByText('loop-xyz-99')).toBeInTheDocument();
      expect(within(card).getByText('Exceeded phase transition limit')).toBeInTheDocument();
    });

    it('shows no telemetry when the gateway did not send it', async () => {
      const { engineRoutingAdmin: _omitted, ...plain } = routed;
      void _omitted;
      jobsApi.detail.mockResolvedValue(detailOf('job-done-3', 'completed', { provenance: plain }));
      renderJob();

      expect(await screen.findByRole('heading', { name: 'AutoRouter decision' })).toBeInTheDocument();
      expect(screen.queryByText('Routing diagnostics (administrators, own runs)')).not.toBeInTheDocument();
    });
  });

  it('opens another of the account’s runs from the same project', async () => {
    renderJob();

    const picker = await screen.findByRole('combobox', { name: 'Another of your runs' });
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['This run', 'minizinc · Oct 1, 2026, 09:00 UTC']);
  });
});

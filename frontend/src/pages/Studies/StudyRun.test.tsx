import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { Report, StudyCell } from '../../api/platform';
import { org, project, reportOf, renderProjectScreen } from '../Project/testKit';
import { EVOLUTIONARY, FLUJO, REVISION_1, REVISION_2, RUN_ID, cellFixture, cellsFixture, runFixture, studyFixture } from './fixtures';
import { StudyRun } from './StudyRun';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(), cancelStudyRun: vi.fn(), retryStudyCell: vi.fn(),
  reports: vi.fn(), createReport: vi.fn(), cases: vi.fn(), revisions: vi.fn(),
}));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';
const RUN = `${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}`;

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });
const running = (cells: StudyCell[]) => cells.map((cell) => (cell.state === 'cancelled' ? { ...cell, state: 'running' as const } : cell));

function renderRun(options: { slug?: string; run?: string } = {}) {
  return renderProjectScreen(<StudyRun />, {
    path: '/app/:org/:project/studies/:study/runs/:run', url: `/app/${options.slug ?? 'isa-demo'}/qos-benchmarks/studies/engines-vs-seeds/runs/${options.run ?? RUN_ID}`, organizations: [group, viewing],
  });
}

const draftOf = (over: Partial<Report> = {}) => reportOf('engines-vs-seeds-run-1', 'draft', { study_run_id: RUN_ID, ...over });

describe('One run of a study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cellsFixture());
    platform.reports.mockResolvedValue([]);
    platform.cases.mockResolvedValue([FLUJO]);
    platform.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the run, how its cells ended and the matrix of them', async () => {
    renderRun();

    expect(await screen.findByRole('heading', { level: 1, name: 'Run #1' })).toBeInTheDocument();
    expect(screen.getAllByText('Partial').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sep 20, 2026, 09:00 UTC → Sep 20, 2026, 09:20 UTC/)).toBeInTheDocument();
    const progress = screen.getByRole('region', { name: 'Progress of the run' });
    expect(within(progress).getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeInTheDocument();
    expect(within(progress).getByText('6 of 6 completed are feasible')).toBeInTheDocument();
    expect(within(progress).getByText('Finished · not live')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Compare results' })).toHaveAttribute('href', `${RUN}/analytics`);

    expect(screen.getByRole('heading', { name: 'Cells · cost (lower is better)' })).toBeInTheDocument();
    const heat = screen.getByRole('region', { name: 'Cells of the run as a matrix' });
    expect(within(heat).getAllByRole('link')).toHaveLength(8);
    const best = within(heat).getByRole('link', { name: 'Cell 4, Flujo de checkout r2, evolutionary · seed 1: completed, Cost 0.104' });
    expect(best).toHaveAttribute('href', `${RUN}/cells/00000000-0000-4000-8000-000000000204`);
    expect(best).toHaveClass('is-level-0');
    expect(within(heat).getByRole('link', { name: /Cell 2, .* completed, Cost 0\.121/ })).toHaveClass('is-level-3');
    expect(within(heat).getByRole('link', { name: /Cell 1, .* failed$/ })).toHaveTextContent('engine_unreachable');
    expect(within(heat).getByRole('link', { name: /Cell 5, .* cancelled$/ })).toHaveClass('is-cancelled');
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
  });

  it('colours the matrix by another measure on request', async () => {
    renderRun();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Colour by' }), { target: { value: 'runtime' } });
    expect(screen.getByRole('heading', { name: 'Cells · time taken (lower is better)' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Cells of the run as a matrix' })).getByRole('link', { name: /Cell 2, .* completed, Time taken 58/ })).toHaveClass('is-level-0');
  });

  it('lists every cell and narrows the list by engine and by state', async () => {
    renderRun();

    const table = await screen.findByRole('region', { name: 'Cells of the run' });
    expect(within(table).getAllByRole('row')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Failed (1)' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All (8)' }));
    fireEvent.click(screen.getByRole('button', { name: 'random-search' }));
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelled (1)' }));
    expect(await screen.findByText('No cells match these filters')).toBeInTheDocument();
  });

  it('retries one cell that did not finish', async () => {
    platform.retryStudyCell.mockResolvedValue({ id: 'x', state: 'queued', fingerprint: 'f' });
    renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry cell 1' }));

    expect(await screen.findByText('Cell 1 queued again. It counts as a new solve.')).toBeInTheDocument();
    expect(platform.retryStudyCell).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', RUN_ID, '00000000-0000-4000-8000-000000000201');
  });

  it('retries every failed or cancelled cell, and says when it stopped', async () => {
    platform.retryStudyCell.mockResolvedValueOnce({ id: 'x', state: 'queued', fingerprint: 'f' }).mockRejectedValueOnce(refusal(429, 'concurrency_limit_exceeded', 'busy'));
    renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry 2 unfinished cells' }));

    expect(await screen.findByText(/All your job slots are busy \(429 · concurrency_limit_exceeded\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 cell queued again before this stopped\./)).toBeInTheDocument();
    expect(platform.retryStudyCell).toHaveBeenCalledTimes(2);
  });

  it('says when a sealed report protects the run from a retry', async () => {
    platform.retryStudyCell.mockRejectedValue(refusal(409, 'sealed_evidence'));
    renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry cell 5' }));

    expect(await screen.findByText('A sealed report cites this run (409 · sealed_evidence)')).toBeInTheDocument();
  });

  it('follows a run that is still going and stops when asked to', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    platform.studyRuns.mockResolvedValue([runFixture({ state: 'running', finished_at: null })]);
    platform.studyCells.mockResolvedValue(running(cellsFixture()));
    renderRun();

    expect(await screen.findByText('Live · every 3 s')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Keep updating' })).toBeChecked();
    const before = platform.studyCells.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await waitFor(() => expect(platform.studyCells.mock.calls.length).toBeGreaterThan(before));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep updating' }));
    expect(screen.queryByText('Live · every 3 s')).not.toBeInTheDocument();
    const stopped = platform.studyCells.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(platform.studyCells.mock.calls.length).toBe(stopped);
  });

  it('cancels a run that is going, and offers nothing to cancel once it ended', async () => {
    platform.studyRuns.mockResolvedValue([runFixture({ state: 'running', finished_at: null })]);
    platform.studyCells.mockResolvedValue(running(cellsFixture()));
    platform.cancelStudyRun.mockResolvedValue(runFixture({ state: 'cancelled' }));
    const view = renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Run cancelled. Cells that hadn’t finished are cancelled; you can retry them.')).toBeInTheDocument();
    expect(platform.cancelStudyRun).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', RUN_ID);
    view.unmount();

    platform.studyRuns.mockResolvedValue([runFixture()]);
    renderRun();
    await screen.findByRole('heading', { level: 1, name: 'Run #1' });
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
  });

  it('says why a cancel was refused', async () => {
    platform.studyRuns.mockResolvedValue([runFixture({ state: 'running', finished_at: null })]);
    platform.studyCells.mockResolvedValue(running(cellsFixture()));
    platform.cancelStudyRun.mockRejectedValue(refusal(409, 'sealed_evidence'));
    renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));

    expect(await screen.findByText('A sealed report cites this run (409 · sealed_evidence)')).toBeInTheDocument();
    expect(screen.getByText(/Its results can’t change now\. Start a new run instead\./)).toBeInTheDocument();
  });

  it('creates a draft report pinned to the run, or opens the one that exists', async () => {
    platform.createReport.mockRejectedValueOnce(refusal(409, 'slug_conflict')).mockResolvedValueOnce(draftOf({ slug: 'engines-vs-seeds-run-1-2' }));
    const view = renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Create a report' }));

    expect(await screen.findByText('Draft report created from this run.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the report' })).toHaveAttribute('href', `${ROOT}/reports/engines-vs-seeds-run-1-2`);
    expect(platform.createReport).toHaveBeenNthCalledWith(1, 'isa-demo', 'qos-benchmarks', {
      slug: 'engines-vs-seeds-run-1', title: 'Engines × semillas · run #1', study_run_id: RUN_ID, document: { summary: '', findings: [], provenance: {} },
    });
    expect(platform.createReport).toHaveBeenNthCalledWith(2, 'isa-demo', 'qos-benchmarks', expect.objectContaining({ slug: 'engines-vs-seeds-run-1-2' }));
    view.unmount();

    platform.reports.mockResolvedValue([draftOf()]);
    renderRun();
    expect(await screen.findByRole('link', { name: 'Open the report' })).toHaveAttribute('href', `${ROOT}/reports/engines-vs-seeds-run-1`);
    expect(screen.queryByRole('button', { name: 'Create a report' })).not.toBeInTheDocument();
  });

  it('shows a viewer everything and offers nothing to change', async () => {
    renderRun({ slug: 'read-lab' });

    await screen.findByRole('heading', { level: 1, name: 'Run #1' });
    expect(screen.getByRole('link', { name: 'Compare results' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Open cell/ })).toHaveLength(8);
    for (const name of ['Create a report', 'Cancel run', 'Retry cell 1', 'Retry 2 unfinished cells']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('answers a run that is not the study’s with a neutral 404', async () => {
    renderRun({ run: 'ghost' });

    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeInTheDocument();
    expect(screen.getByText(/This run doesn’t exist \(404\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the study' })).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds`);
  });

  it('says a key without one of the engines cannot show the run', async () => {
    platform.studyCells.mockRejectedValue(refusal(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.'));
    renderRun();

    expect(await screen.findByText(/This API key can’t show this run \(403 · api_key_engine_forbidden\)/)).toBeInTheDocument();
    expect(screen.getByText(/This key does not grant Evolutionary\./)).toBeInTheDocument();
  });

  it('offers a retry when the run cannot be read', async () => {
    platform.studyCells.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderRun();

    expect(await screen.findByText(/The run couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Run #1' })).toBeInTheDocument();
  });

  it('flags a run with no cells', async () => {
    platform.studyCells.mockResolvedValue([]);
    renderRun();

    expect(await screen.findByText(/This run has no cells, which shouldn’t happen\./)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Cells of the run' })).not.toBeInTheDocument();
  });

  it('leaves the squares out of a very large run and pages the table', async () => {
    const many = Array.from({ length: 700 }, (_, n) => cellFixture(n, REVISION_1, EVOLUTIONARY, n, 'completed', { feasible: true, objectives: { cost: n / 1000 }, runtimeSeconds: 1 }));
    platform.studyCells.mockResolvedValue(many);
    platform.studyRuns.mockResolvedValue([runFixture({ cells: 700 })]);
    renderRun();

    expect(await screen.findByText(/This run has 700 cells, too many to draw as squares/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Cells of the run as a matrix' })).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–50 of 700')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Showing 51–100 of 700')).toBeInTheDocument();
  });

  it('keeps the quota in the words of a retry that is out of solves', async () => {
    platform.retryStudyCell.mockRejectedValue(new QuotaError('quota_exceeded', 'full', { limit_id: 'taskStarts', limit: 50, used: 50, renews_at: '2026-11-01T00:00:00Z' }));
    renderRun();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry cell 1' }));

    expect(await screen.findByText(/Out of solves \(402 · quota_exceeded\)/)).toBeInTheDocument();
    expect(screen.getByText(/You’ve used 50 of 50 solves\. They renew on Nov 1, 2026\./)).toBeInTheDocument();
  });
});

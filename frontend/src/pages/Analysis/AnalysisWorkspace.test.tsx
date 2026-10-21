import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { AnalysisWorkspace } from './AnalysisWorkspace';
import { ID_FASTPAY, ID_PAYCO, JOB_DONE, JOB_SECOND, MODEL, ROWS, archiveOf, detailOf } from '../../test/fixtures/analysis';

const api = vi.hoisted(() => ({
  query: vi.fn(), candidate: vi.fn(), receipt: vi.fn(), export: vi.fn(), save: vi.fn(), startPareto: vi.fn(), pareto: vi.fn(), cancelPareto: vi.fn(),
}));
const platform = vi.hoisted(() => ({ studyCell: vi.fn(), studyCells: vi.fn(), report: vi.fn(), organizations: vi.fn(), projects: vi.fn() }));
const files = vi.hoisted(() => ({ saveBytes: vi.fn() }));

vi.mock('../../analysis/archive', async () => ({ ...await vi.importActual<typeof import('../../analysis/archive')>('../../analysis/archive'), analysisApi: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../Project/download', () => files);
vi.mock('../../components/BindingAnalysis/ArchiveChart', () => ({
  ArchiveChart: () => <div data-testid="archive-chart" />,
  ParallelCoordinates: () => null,
}));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const refusal = (status: number, message: string) => new HttpError(status, message);

function renderWorkspace(search = `?job=${JOB_DONE}`) {
  return renderProjectScreen(<AnalysisWorkspace />, { path: '/app/analysis/workspace', url: `/app/analysis/workspace${search}`, organizations: [group] });
}

const lastQuery = () => api.query.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('The decision space', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.query.mockResolvedValue(archiveOf());
    api.candidate.mockImplementation(async (query: { selected?: string }) => detailOf(query.selected === ID_FASTPAY ? ROWS.fastpay : ROWS.payco));
    api.pareto.mockResolvedValue({ id: 'task-1', revision: archiveOf().revision, state: 'running', progress: 0.5, scope: 'archive', layers: false, error: null, result: null });
  });

  it('ranks the stored bindings, recommends one and inspects it', async () => {
    renderWorkspace();

    expect(await screen.findByRole('heading', { level: 1, name: 'Decision space' })).toBeInTheDocument();
    expect(await screen.findByText('1 source · 2 unique bindings, 2 stored occurrences')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Binding a1a1a1a1a1' })).toBeInTheDocument();
    expect(screen.getByText('Balanced compromise · Preferred under your rule')).toBeInTheDocument();
    const ranking = screen.getByRole('region', { name: /Ranking/ });
    expect(within(ranking).getAllByRole('listitem')).toHaveLength(2);
    expect(within(ranking).getByText('Cost 0.118 EUR/request · Latency 412 ms')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Inspector · Binding a1a1a1a1a1' })).toBeInTheDocument();
    expect(await screen.findByText('It has the smallest worst weighted loss among the 2 eligible bindings.')).toBeInTheDocument();
    expect(screen.getByTestId('archive-chart')).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ sources: [JOB_DONE], view: 'decision', rule: 'balanced', page: 0, compare: [] });
    // The raw evaluation is behind "View source", never on the page.
    expect(screen.getByLabelText('Constraints and raw metrics').closest('details')).not.toHaveAttribute('open');
  });

  it('asks again with the priorities and limits that were set', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });

    fireEvent.change(screen.getByRole('slider', { name: 'Cost priority' }), { target: { value: '4' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ weights: { cost: 4 } }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Latency requirement' }), { target: { value: '400' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ requirements: [{ dimension: 'latency', value: 400, space: 'raw' }] }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Recommendation rule' }), { target: { value: 'weighted' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ rule: 'weighted' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reset priorities and requirements' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ weights: {}, requirements: [] }));
  });

  it('inspects another binding and keeps a shortlist of up to four', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Inspector · Binding a1a1a1a1a1' });

    fireEvent.click(screen.getByRole('button', { name: 'Inspect binding b2b2b2b2b2' }));
    expect(await screen.findByRole('heading', { name: 'Inspector · Binding b2b2b2b2b2' })).toBeInTheDocument();
    await waitFor(() => expect(api.candidate).toHaveBeenLastCalledWith(expect.objectContaining({ selected: ID_FASTPAY }), expect.anything()));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Compare a1a1a1a1a1' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ compare: [ID_PAYCO] }));
    expect(await screen.findByRole('heading', { name: 'Shortlist comparison' })).toBeInTheDocument();
  });

  it('moves between the views and keeps the view in the address', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });

    fireEvent.click(screen.getByRole('tab', { name: 'Budgets' }));
    expect(await screen.findByText('Budgets need two objectives that are not constant in these results.')).toBeInTheDocument();
    await waitFor(() => expect(lastQuery()).toMatchObject({ view: 'budgets' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Preferences' }));
    expect(await screen.findByRole('heading', { name: 'Which choice wins for each balance' })).toBeInTheDocument();
    await waitFor(() => expect(lastQuery()).toMatchObject({ view: 'preferences', geometry: 'sensitivity' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(await screen.findByRole('heading', { name: 'Evidence used' })).toBeInTheDocument();
    expect(screen.getByText('Stored job result')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change sources' })).toHaveAttribute('href', `/app/analysis?job=${JOB_DONE}`);
    expect(screen.getByRole('button', { name: 'Copy model digest' })).toBeInTheDocument();
    expect(screen.getByText(MODEL)).toBeInTheDocument();
  });

  it('draws where each binding wins as the priority shifts', async () => {
    api.query.mockResolvedValue(archiveOf({
      geometry: {
        kind: 'sensitivity', state: 'complete', meaning: 'Winners as one priority grows.', axis: 0,
        scenarios: [{ t: 0, winners: [ID_FASTPAY], winnerCount: 1, score: [0] }, { t: 0.5, winners: [ID_PAYCO], winnerCount: 1, score: [0] }, { t: 1, winners: [ID_PAYCO], winnerCount: 1, score: [0] }],
      },
    }));
    renderWorkspace('?view=preferences&job=' + JOB_DONE);

    const bar = await screen.findByRole('img', { name: /b2b2b2b2b2 from 0% to 25%; a1a1a1a1a1 from 25% to 100%/ });
    expect(bar).toBeInTheDocument();
    expect(screen.getByText('Binding a1a1a1a1a1 from 25% to 100%')).toBeInTheDocument();
  });

  it('computes the front in the background and lets it be cancelled', async () => {
    api.startPareto.mockResolvedValue({ id: 'task-1', revision: archiveOf().revision, state: 'running', progress: 0.4, scope: 'archive', layers: false, error: null, result: null });
    api.cancelPareto.mockResolvedValue({ id: 'task-1', revision: archiveOf().revision, state: 'cancelled', progress: 0.4, scope: 'archive', layers: false, error: null, result: null });
    renderWorkspace(`?view=pareto&job=${JOB_DONE}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Compute the front' }));
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progress of the front' })).toHaveAttribute('value', '0.4');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Cancelled\. No partial front is shown/)).toBeInTheDocument();
    expect(api.cancelPareto).toHaveBeenCalledWith('task-1');
  });

  it('keeps the last ranking and offers to refresh when the evidence changed underneath', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });

    api.query.mockRejectedValueOnce(refusal(409, 'The source archive has changed; reload before making this decision'));
    fireEvent.change(screen.getByRole('slider', { name: 'Cost priority' }), { target: { value: '3' } });
    expect(await screen.findByText('The evidence changed (409)')).toBeInTheDocument();
    expect(screen.getByText(/The values below are the last response received, not trusted current evidence/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Binding a1a1a1a1a1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as report' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText('The evidence changed (409)')).not.toBeInTheDocument());
    expect(lastQuery().revision).toBeUndefined();
  });

  it('says the evaluator is busy on a 429 without losing the ranking', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });

    api.query.mockRejectedValueOnce(refusal(429, 'busy'));
    fireEvent.change(screen.getByRole('slider', { name: 'Cost priority' }), { target: { value: '3' } });
    expect(await screen.findByText('The evaluator is busy (429)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Binding a1a1a1a1a1' })).toBeInTheDocument();
  });

  it('answers a source that is not yours, or a key that cannot reach it, with a way back to the sources', async () => {
    api.query.mockRejectedValue(refusal(404, 'One or more analysis sources are unavailable'));
    renderWorkspace();

    expect(await screen.findByText('These sources aren’t available (404)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change sources' })).toHaveAttribute('href', `/app/analysis?job=${JOB_DONE}`);
    expect(screen.queryByRole('heading', { name: /^Binding / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as report' })).toBeDisabled();
  });

  it('refuses sources checked against different models, with the gateway’s reason', async () => {
    api.query.mockRejectedValue(refusal(409, 'The pinned model does not match its stored identity'));
    renderWorkspace(`?job=${JOB_DONE}&job=${JOB_SECOND}`);

    expect(await screen.findByText('These sources can’t be ranked together (409)')).toBeInTheDocument();
    expect(screen.getByText(/The pinned model does not match its stored identity/)).toBeInTheDocument();
  });

  it('exports the receipt as a file', async () => {
    api.receipt.mockResolvedValue({ kind: 'binding-decision' });
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });

    fireEvent.click(screen.getByText('Export'));
    fireEvent.click(screen.getByText('Export receipt'));

    expect(await screen.findByText('Export downloaded.')).toBeInTheDocument();
    expect(files.saveBytes).toHaveBeenCalledWith(expect.anything(), 'binding-decision.json', 'application/json');
  });

  it('saves the decision as a draft report of a project the person can write to', async () => {
    platform.organizations.mockResolvedValue([group, org('read-lab', { effective_role: 'VIEWER' })]);
    platform.projects.mockResolvedValue([project('qos-benchmarks', { name: 'QoS Benchmarks' })]);
    api.save.mockResolvedValue({ slug: 'choice-draft' });
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });

    fireEvent.click(screen.getByRole('button', { name: 'Save as report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as report' });
    // A viewer cannot write, so the organization is not offered.
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'ISA Demo Group' })).toBeInTheDocument());
    expect(within(dialog).queryByRole('option', { name: 'READ-LAB' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'QoS Benchmarks · private' })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText('Project'), { target: { value: 'qos-benchmarks' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ sources: [JOB_DONE] }), 'isa-demo', 'qos-benchmarks', 'Binding decision', expect.stringMatching(/^binding-decision-/)));
    expect(await screen.findByText(/Saved as a draft report with this exact receipt/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/reports/choice-draft');
  });

  it('opens the sources of a study cell', async () => {
    platform.studyCell.mockResolvedValue({ id: 'cell-3', ordinal: 2, job_id: JOB_DONE });
    renderWorkspace('?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=run-1&cell=cell-3');

    expect(await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' })).toBeInTheDocument();
    expect(screen.getByText(/Cell 3 of run run-1…/)).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ sources: [JOB_DONE] });
  });

  it('opens every finished cell of a study run', async () => {
    platform.studyCells.mockResolvedValue([
      { id: 'c1', ordinal: 0, job_id: JOB_DONE, state: 'completed' },
      { id: 'c2', ordinal: 1, job_id: JOB_SECOND, state: 'completed' },
      { id: 'c3', ordinal: 2, job_id: null, state: 'failed' },
    ]);
    renderWorkspace('?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=run-1');

    await screen.findByRole('heading', { name: 'Binding a1a1a1a1a1' });
    expect(lastQuery()).toMatchObject({ sources: [JOB_DONE, JOB_SECOND] });
    expect(screen.getByText(/2 finished cells of run run-1…/)).toBeInTheDocument();
  });

  it('reopens a decision a report recorded, with its own query and a snapshot of it', async () => {
    const recorded = {
      kind: 'binding-decision', version: 'binding-archive/v1', revision: archiveOf().revision, sources: [], dimensions: [],
      query: { sources: [JOB_DONE], rule: 'weighted', weights: { cost: 3 }, revision: archiveOf().revision, compare: [], page: 0 },
      scope: 'Stored evaluated bindings only; unexplored space remains unknown', selected: [detailOf()],
    };
    platform.report.mockResolvedValue({ slug: 'choice', title: 'Checkout choice', document: recorded });
    renderWorkspace('?report=isa-demo/qos-benchmarks/choice');

    expect(await screen.findByText('Balanced compromise · Preferred under your rule')).toBeInTheDocument();
    expect(platform.report).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'choice');
    expect(lastQuery()).toMatchObject({ sources: [JOB_DONE], rule: 'weighted', weights: { cost: 3 }, revision: archiveOf().revision });
    expect(screen.getByText('Saved decision snapshot')).toBeInTheDocument();
    expect(screen.getByText(/saved in Checkout choice/)).toBeInTheDocument();
  });

  it('refuses a report that holds no decision', async () => {
    platform.report.mockResolvedValue({ slug: 'notes', title: 'Notes', document: { summary: 'Nothing recorded here' } });
    renderWorkspace('?report=isa-demo/qos-benchmarks/notes');

    expect(await screen.findByText('This report doesn’t hold a decision')).toBeInTheDocument();
    expect(api.query).not.toHaveBeenCalled();
  });

  it('asks for sources when none was named', async () => {
    renderWorkspace('');

    expect(await screen.findByText('No sources chosen')).toBeInTheDocument();
    // The screen keeps its own heading before there is a ranking.
    expect(screen.getByRole('heading', { level: 1, name: 'Decision space' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose sources' })).toHaveAttribute('href', '/app/analysis');
    expect(api.query).not.toHaveBeenCalled();
  });
});

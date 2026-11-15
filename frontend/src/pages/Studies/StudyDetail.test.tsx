import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { StudyRun } from '../../api/platform';
import { org, renderProjectScreen } from '../../features/workspace/testKit';
import { CHECKOUT, REVISION_1, REVISION_2, RUN_ID, analyticsFixture, cellsFixture, runFixture, studyFixture } from '../../test/fixtures/studies';
import { StudyDetail } from './StudyDetail';

const platform = vi.hoisted(() => ({
  study: vi.fn(), studyRuns: vi.fn(), studyRun: vi.fn(), studyCells: vi.fn(), runStudy: vi.fn(), updateStudy: vi.fn(), deleteStudy: vi.fn(),
  analytics: vi.fn(),
}));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));

const problems = vi.hoisted(() => ({ list: vi.fn(), revisions: vi.fn(), compilation: vi.fn(), ir: vi.fn() }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../features/workspace/download', () => download);
// The decision workspace is not what is under test here.
vi.mock('../../components/BindingAnalysis/BindingAnalysis', async () => {
  const { createElement } = await import('react');
  return { BindingAnalysis: ({ jobId }: { jobId?: string }) => createElement('div', null, `Binding analysis of ${jobId}`) };
});

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const member = org('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' });
const ROOT = '/app/isa-demo';
const STUDY = `${ROOT}/studies/engines-vs-seeds`;
const ETAG = '"study-revision-1"';

const refusal = (status: number, code: string, message = 'refused', extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, message), { code }, extra);

/** The address the page is on, as the person sees it. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

/** `tail` is what follows the study in the address: `/setup` unless a test is about the default tab or another one. */
function renderDetail(slug = 'isa-demo', study = 'engines-vs-seeds', tail = '/setup') {
  return renderProjectScreen(<><StudyDetail /><Where /></>, {
    path: '/app/:org/studies/:study/:tab?', url: `/app/${slug}/studies/${study}${tail}`, organizations: [group, viewing, member],
  });
}

/** The study's runs, as the list and the one-run read both answer them. */
function withRuns(runs: StudyRun[]) {
  platform.studyRuns.mockResolvedValue(runs);
  platform.studyRun.mockImplementation(async (_org: string, _study: string, id: string) => {
    const found = runs.find((run) => run.id === id);
    if (!found) throw refusal(404, 'not_found');
    return found;
  });
}

const where = () => screen.getByTestId('where').textContent;
const runTwo = () => runFixture({ id: 'run-2', run_number: 2, state: 'completed', created_at: '2026-09-21T09:00:00Z' });

describe('One study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.study.mockResolvedValue({ value: studyFixture(), etag: ETAG });
    withRuns([runFixture()]);
    platform.studyCells.mockResolvedValue(cellsFixture());
    problems.list.mockResolvedValue({ problems: [CHECKOUT], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    platform.analytics.mockResolvedValue(analyticsFixture());
  });

  it('opens Progress on the latest study run when the study has runs, and Setup when it has none', async () => {
    withRuns([runFixture(), runTwo()]);
    const view = renderDetail('isa-demo', 'engines-vs-seeds', '');

    const tabs = await screen.findByRole('tablist', { name: 'Study sections' });
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Setup', 'Progress', 'Results']);
    expect(within(tabs).getByRole('tab', { name: 'Progress' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('combobox', { name: 'Study run' })).toHaveValue('run-2');
    expect(await screen.findByRole('heading', { level: 2, name: 'Run #2' })).toBeInTheDocument();
    view.unmount();

    withRuns([]);
    renderDetail('isa-demo', 'engines-vs-seeds', '');
    expect(await screen.findByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('combobox', { name: 'Study run' })).not.toBeInTheDocument();
    expect(await screen.findByText('No runs yet. Running uses 1 study run from your month and runs up to 8 cells.')).toBeInTheDocument();
  });

  it('shows the study run named by ?run= and sets the query when another one is chosen', async () => {
    withRuns([runFixture(), runTwo()]);
    renderDetail('isa-demo', 'engines-vs-seeds', '/results');

    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #2' })).toBeInTheDocument();
    expect(platform.analytics).toHaveBeenLastCalledWith('isa-demo', 'engines-vs-seeds', 'run-2');
    fireEvent.change(screen.getByRole('combobox', { name: 'Study run' }), { target: { value: RUN_ID } });

    await waitFor(() => expect(where()).toBe(`${STUDY}/results?run=${RUN_ID}`));
    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })).toBeInTheDocument();
    expect(platform.analytics).toHaveBeenLastCalledWith('isa-demo', 'engines-vs-seeds', RUN_ID);
  });

  it('keeps the chosen run when another tab is chosen, and says so for a run that is not the study’s', async () => {
    withRuns([runFixture(), runTwo()]);
    const view = renderDetail('isa-demo', 'engines-vs-seeds', `/progress?run=${RUN_ID}`);

    fireEvent.click(await screen.findByRole('tab', { name: 'Results' }));
    await waitFor(() => expect(where()).toBe(`${STUDY}/results?run=${RUN_ID}`));
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    view.unmount();

    renderDetail('isa-demo', 'engines-vs-seeds', '/progress?run=ghost');
    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeInTheDocument();
  });

  it('holds the CSV export of the study run in Results', async () => {
    withRuns([runFixture(), runTwo()]);
    renderDetail('isa-demo', 'engines-vs-seeds', `/results?run=${RUN_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(download.saveBytes).toHaveBeenCalledTimes(1);
    const [bytes, name, type] = download.saveBytes.mock.calls[0] as [ArrayBuffer, string, string];
    expect(name).toBe('engines-vs-seeds-run-1-cells.csv');
    expect(type).toBe('text/csv');
    expect(new TextDecoder().decode(bytes).split('\n')[0]).toBe('cell,case_revision,engine,engine_version,mode,setting,seed,state,feasible,cost,latency,runtime_seconds,job_id,fingerprint');
    expect(screen.queryByRole('tab', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('says Progress and Results have nothing to show before the first study run', async () => {
    withRuns([]);
    renderDetail('isa-demo', 'engines-vs-seeds', '/progress');

    expect(await screen.findByText(/This study has no run yet\. Start one with Run study/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(await screen.findByText(/This study has no run yet\. Start one with Run study/)).toBeInTheDocument();
    expect(platform.studyCells).not.toHaveBeenCalled();
  });

  it('does not say a study has no run while its runs load, and offers a retry when they cannot', async () => {
    platform.studyRuns.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail('isa-demo', 'engines-vs-seeds', '/results');

    expect(screen.queryByText(/This study has no run yet/)).not.toBeInTheDocument();
    expect(await screen.findByText(/The runs couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    expect(screen.queryByText(/This study has no run yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })).toBeInTheDocument();
  });

  it('answers a tab the page does not have with Page not found', async () => {
    renderDetail('isa-demo', 'engines-vs-seeds', '/runs');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Engines × seeds' })).not.toBeInTheDocument();
    expect(platform.study).not.toHaveBeenCalled();
  });

  it('shows the definition, the matrix it expands to, and the runs it has', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeInTheDocument();
    expect(await screen.findByText('2 problem versions × 2 engines × 1 setting × 2 seeds = 8 cells')).toBeInTheDocument();
    const grid = await screen.findByRole('region', { name: 'The cells of the matrix' });
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(5);
    expect(within(grid).getByRole('columnheader', { name: 'random-search (sampling) · seed 2' })).toBeInTheDocument();
    expect(within(grid).getByRole('rowheader', { name: 'Checkout flow r2' })).toBeInTheDocument();
    expect(within(grid).getByText('cell 7')).toBeInTheDocument();
    expect(screen.getByText(/2 problem versions × 2 engines × 1 setting × 2 seeds = 8 cells\. Settings: 1 · engine defaults\. Seeds: 1, 2\. Every run repeats exactly these cells\./)).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Runs' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Run #1/ })).toHaveAttribute('href', `${STUDY}/progress?run=00000000-0000-4000-8000-000000000101`);
    expect(screen.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /library/i })).toBeNull();
    const definition = screen.getByRole('region', { name: 'Definition' });
    expect(within(definition).getByRole('button', { name: 'Copy the definition digest' })).toBeInTheDocument();
    expect(definition.textContent).not.toMatch(/sha256-/);
    expect(within(definition).getByRole('button', { name: 'Edit definition' })).toBeEnabled();
    // Studies belong to the organization: no project tabs, and the crumbs go Home › organization › Studies.
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Studies' })).toHaveAttribute('href', `${ROOT}/studies`);
  });

  it('keeps the raw definition in the Source tab, with Overview as the default', async () => {
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Study definition source' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Study definition source' })).toHaveTextContent('"revision_ids"');
    expect(screen.getByRole('button', { name: 'Download Study definition source' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'The cells of the matrix' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByRole('region', { name: 'The cells of the matrix' })).toBeInTheDocument();
  });

  it('says there are no runs yet and how much one would use', async () => {
    withRuns([]);
    renderDetail();

    expect(await screen.findByText('No runs yet. Running uses 1 study run from your month and runs up to 8 cells.')).toBeInTheDocument();
  });

  it('runs the study (the run freezes its current definition) and offers to follow the new run', async () => {
    platform.runStudy.mockResolvedValue(runFixture({ id: 'run-2', run_number: 2, state: 'queued', finished_at: null }));
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Run study' }));

    expect(await screen.findByText('Run #2 accepted (202). Cells start as run slots free up.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow run #2' })).toHaveAttribute('href', `${STUDY}/progress?run=run-2`);
    expect(platform.runStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds');
  });

  it.each([
    ['402 out of storage', new QuotaError('quota_exceeded', 'full', { limit_id: 'maxRepositoryStorage', limit: 100, used: 100 }), 'Out of storage (402 · quota_exceeded)'],
    ['429 job slots busy', refusal(429, 'concurrency_limit_exceeded', 'busy', { concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 }, retryAfter: 15 }), 'All your run slots are busy (429 · concurrency_limit_exceeded)'],
    ['403 feature', refusal(403, 'feature_not_entitled', 'No studies.'), 'Your plan doesn’t include studies right now (403 · feature_not_entitled)'],
    ['422 not recompilable', refusal(422, 'revision_not_recompilable'), 'A problem version can’t be compiled by the installed toolchain (422 · revision_not_recompilable)'],
    ['403 key engine', refusal(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.'), 'This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)'],
  ])('says why a run was refused: %s', async (_name, failure, title) => {
    platform.runStudy.mockRejectedValue(failure);
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Run study' }));

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText(/accepted \(202\)/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeEnabled();
  });

  it('cannot start a run while archived, and can be restored', async () => {
    platform.study.mockResolvedValue({ value: studyFixture({ archived: true }), etag: ETAG });
    platform.updateStudy.mockResolvedValue({ value: studyFixture(), etag: '"study-revision-2"' });
    renderDetail();

    expect(await screen.findByText('Archived studies keep their runs and results but can’t start new runs until restored.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored. It can start new runs again.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', { archived: false });
  });

  it('edits the definition with the revision it read, and a stale revision is refused with 412', async () => {
    platform.updateStudy.mockResolvedValue({ value: studyFixture(), etag: '"study-revision-2"' });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit definition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit definition' });
    const next = { ...studyFixture().definition, seeds: [1, 2, 3] };
    fireEvent.change(within(dialog).getByLabelText('Definition (JSON)'), { target: { value: JSON.stringify(next) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save definition' }));

    expect(await screen.findByText(/Definition saved\. The next run uses it/)).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', { definition: next }, ETAG);

    platform.updateStudy.mockRejectedValue(refusal(412, 'precondition_failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit definition' }));
    const again = await screen.findByRole('dialog', { name: 'Edit definition' });
    fireEvent.click(within(again).getByRole('button', { name: 'Save definition' }));
    expect(await within(again).findByText('The study changed since you opened it (412 · precondition_failed)')).toBeInTheDocument();
  });

  it('does not send a definition that is not a JSON object with the four lists', async () => {
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit definition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit definition' });
    fireEvent.change(within(dialog).getByLabelText('Definition (JSON)'), { target: { value: '{"seeds": [1]}' } });

    expect(within(dialog).getByText('It needs the lists revision_ids, engines, parameter_sets.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save definition' })).toBeDisabled();
  });

  it('shows the definition the selected run froze, and makes it the study’s again', async () => {
    platform.study.mockResolvedValue({ value: studyFixture({ definition: { ...studyFixture().definition, seeds: [7] } }), etag: ETAG });
    platform.updateStudy.mockResolvedValue({ value: studyFixture(), etag: '"study-revision-2"' });
    renderDetail('isa-demo', 'engines-vs-seeds', `/progress?run=${RUN_ID}`);

    const card = await screen.findByRole('region', { name: 'Frozen definition' });
    expect(within(card).getByRole('button', { name: 'Copy the digest of the frozen definition' })).toBeInTheDocument();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(await within(card).findByRole('button', { name: 'Copy the compilation digest of Checkout flow r2' })).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/sha256-/);
    fireEvent.click(within(card).getByRole('button', { name: 'Use it for the next runs' }));

    expect(await screen.findByText(/The study’s definition is now the one run #1 froze/)).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', { definition: studyFixture().definition }, ETAG);
  });

  it('edits the name and the description', async () => {
    platform.updateStudy.mockResolvedValue({ value: studyFixture({ name: 'Renamed' }), etag: '"study-revision-2"' });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: 'Two engines, two seeds.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', { name: 'Renamed', description: 'Two engines, two seeds.' });
  });

  it('deletes a study that has no runs and goes back to the list', async () => {
    withRuns([]);
    platform.deleteStudy.mockResolvedValue(undefined);
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Engines × seeds?' })).getByRole('button', { name: 'Delete study' }));

    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(platform.deleteStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds');
  });

  it('archives instead of deleting when the study has runs', async () => {
    platform.deleteStudy.mockRejectedValue(refusal(409, 'study_history_retained'));
    platform.updateStudy.mockResolvedValue({ value: studyFixture({ archived: true }), etag: '"study-revision-2"' });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete study' }));

    expect(await screen.findByText('This study has runs, so it was archived instead of deleted. Its runs and results stay intact.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', { archived: true });
  });

  it('lets a viewer read only, and a member run but not delete', async () => {
    const view = renderDetail('read-lab');
    expect(await screen.findByText(/You can read this study\. Running, archiving and editing it need MEMBER in Read Lab\./)).toBeInTheDocument();
    for (const name of ['Run study', 'Archive', 'Edit details', 'Edit definition', 'Delete']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    view.unmount();

    renderDetail('team-lab');
    expect(await screen.findByRole('button', { name: 'Run study' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('answers a study that is not in the organization with a neutral 404', async () => {
    platform.study.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail('isa-demo', 'ghost');

    expect(await screen.findByRole('heading', { name: 'Study not found' })).toBeInTheDocument();
    expect(screen.getByText('No study with this address in ISA Demo Group (404).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All studies' })).toHaveAttribute('href', `${ROOT}/studies`);
  });

  it('offers a retry when the study cannot be read', async () => {
    platform.study.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByText(/The study couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeInTheDocument();
  });

  it('keeps the page when only the runs fail to load', async () => {
    platform.studyRuns.mockRejectedValue(refusal(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeInTheDocument();
    expect(await screen.findByText(/The runs couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeInTheDocument();
  });
});

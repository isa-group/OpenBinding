import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { CHECKOUT, REVISION_1, REVISION_2, RUN_ID, VERSION_ID, analyticsFixture, cellsFixture, digestOf, runFixture, studyFixture } from '../../test/fixtures/studies';
import { StudyDetail } from './StudyDetail';

const platform = vi.hoisted(() => ({
  project: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(), runStudy: vi.fn(), updateStudy: vi.fn(), deleteStudy: vi.fn(),
  cases: vi.fn(), revisions: vi.fn(), analytics: vi.fn(),
}));
const library = vi.hoisted(() => ({ libraryApi: { versions: vi.fn() } }));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/library', () => library);
vi.mock('../Project/download', () => download);
// The decision workspace is not what is under test here.
vi.mock('../../components/BindingAnalysis/BindingAnalysis', async () => {
  const { createElement } = await import('react');
  return { BindingAnalysis: ({ jobId }: { jobId?: string }) => createElement('div', null, `Binding analysis of ${jobId}`) };
});

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const member = org('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';
const STUDY = `${ROOT}/studies/engines-vs-seeds`;

const version = (id: string, ordinal: number) => ({
  id, artifact_id: 'artifact-engines-vs-seeds', ordinal, ref: { namespace: 'isa-demo', name: 'study', version: String(ordinal), versionDigest: digestOf('v') },
  contentDigest: digestOf('e'), manifest: { mediaType: 'application/json', contracts: [], dependencies: [] }, based_on_id: null, public: false, withdrawn: false,
});

const refusal = (status: number, code: string, message = 'refused', extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, message), { code }, extra);

/** The address the page is on, as the person sees it. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

/** `tail` is what follows the study in the address: `/setup` unless a test is about the default tab or another one. */
function renderDetail(slug = 'isa-demo', study = 'engines-vs-seeds', tail = '/setup') {
  return renderProjectScreen(<><StudyDetail /><Where /></>, {
    path: '/app/:org/:project/studies/:study/:tab?', url: `/app/${slug}/qos-benchmarks/studies/${study}${tail}`, organizations: [group, viewing, member],
  });
}

const where = () => screen.getByTestId('where').textContent;
const runTwo = () => runFixture({ id: 'run-2', run_number: 2, state: 'completed', created_at: '2026-09-21T09:00:00Z' });

describe('One study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cellsFixture());
    platform.cases.mockResolvedValue([CHECKOUT]);
    platform.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    platform.analytics.mockResolvedValue(analyticsFixture());
    library.libraryApi.versions.mockResolvedValue([version(VERSION_ID, 1)]);
  });

  it('opens Progress on the latest study run when the study has runs, and Setup when it has none', async () => {
    platform.studyRuns.mockResolvedValue([runFixture(), runTwo()]);
    const view = renderDetail('isa-demo', 'engines-vs-seeds', '');

    const tabs = await screen.findByRole('tablist', { name: 'Study sections' });
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Setup', 'Progress', 'Results']);
    expect(within(tabs).getByRole('tab', { name: 'Progress' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('combobox', { name: 'Study run' })).toHaveValue('run-2');
    expect(await screen.findByRole('heading', { level: 2, name: 'Run #2' })).toBeInTheDocument();
    view.unmount();

    platform.studyRuns.mockResolvedValue([]);
    renderDetail('isa-demo', 'engines-vs-seeds', '');
    expect(await screen.findByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('combobox', { name: 'Study run' })).not.toBeInTheDocument();
    expect(await screen.findByText('No runs yet. Running uses 1 study run from your month and runs up to 8 cells.')).toBeInTheDocument();
  });

  it('shows the study run named by ?run= and sets the query when another one is chosen', async () => {
    platform.studyRuns.mockResolvedValue([runFixture(), runTwo()]);
    renderDetail('isa-demo', 'engines-vs-seeds', '/results');

    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #2' })).toBeInTheDocument();
    expect(platform.analytics).toHaveBeenLastCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', 'run-2');
    fireEvent.change(screen.getByRole('combobox', { name: 'Study run' }), { target: { value: RUN_ID } });

    await waitFor(() => expect(where()).toBe(`${STUDY}/results?run=${RUN_ID}`));
    expect(await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })).toBeInTheDocument();
    expect(platform.analytics).toHaveBeenLastCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', RUN_ID);
  });

  it('keeps the chosen run when another tab is chosen, and says so for a run that is not the study’s', async () => {
    platform.studyRuns.mockResolvedValue([runFixture(), runTwo()]);
    const view = renderDetail('isa-demo', 'engines-vs-seeds', `/progress?run=${RUN_ID}`);

    fireEvent.click(await screen.findByRole('tab', { name: 'Results' }));
    await waitFor(() => expect(where()).toBe(`${STUDY}/results?run=${RUN_ID}`));
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    view.unmount();

    renderDetail('isa-demo', 'engines-vs-seeds', '/progress?run=ghost');
    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeInTheDocument();
  });

  it('holds the CSV export of the study run in Results', async () => {
    platform.studyRuns.mockResolvedValue([runFixture(), runTwo()]);
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
    platform.studyRuns.mockResolvedValue([]);
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
    expect(platform.studies).not.toHaveBeenCalled();
  });

  it('shows the definition, the matrix it expands to, and the runs it has', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeInTheDocument();
    expect(await screen.findByText('Definition version 1 · sealed')).toBeInTheDocument();
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
    expect(screen.getByText('Only one version exists. A new version appears when the definition is sealed again.')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the raw definition in the Source tab, with Overview as the default', async () => {
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Study definition source' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Study definition source' })).toHaveTextContent('"case_revision_ids"');
    expect(screen.getByRole('button', { name: 'Download Study definition source' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'The cells of the matrix' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByRole('region', { name: 'The cells of the matrix' })).toBeInTheDocument();
  });

  it('says there are no runs yet and how much one would use', async () => {
    platform.studyRuns.mockResolvedValue([]);
    renderDetail();

    expect(await screen.findByText('No runs yet. Running uses 1 study run from your month and runs up to 8 cells.')).toBeInTheDocument();
  });

  it('runs the study with the version it uses and offers to follow the new run', async () => {
    platform.runStudy.mockResolvedValue(runFixture({ id: 'run-2', run_number: 2, state: 'queued', finished_at: null }));
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Run study' }));

    expect(await screen.findByText('Run #2 accepted (202). Cells start as run slots free up.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow run #2' })).toHaveAttribute('href', `${STUDY}/progress?run=run-2`);
    expect(platform.runStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', VERSION_ID);
  });

  it.each([
    ['402 out of storage', new QuotaError('quota_exceeded', 'full', { limit_id: 'storageBytes', limit: 100, used: 100 }), 'Out of storage (402 · quota_exceeded)'],
    ['429 job slots busy', refusal(429, 'concurrency_limit_exceeded', 'busy', { concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 }, retryAfter: 15 }), 'All your run slots are busy (429 · concurrency_limit_exceeded)'],
    ['403 feature', refusal(403, 'feature_not_entitled', 'No studies.'), 'Your plan doesn’t include studies right now (403 · feature_not_entitled)'],
    ['409 evidence only', refusal(409, 'evidence_only_study'), 'This study only holds stored evidence (409 · evidence_only_study)'],
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
    platform.studies.mockResolvedValue([studyFixture({ archived: true })]);
    platform.updateStudy.mockResolvedValue(studyFixture());
    renderDetail();

    expect(await screen.findByText('Archived studies keep their runs and results but can’t start new runs until restored.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored. It can start new runs again.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', { archived: false });
  });

  it('changes the definition version the study runs with', async () => {
    library.libraryApi.versions.mockResolvedValue([version(VERSION_ID, 1), version('version-2', 2)]);
    platform.updateStudy.mockResolvedValue(studyFixture({ definition_version_id: 'version-2' }));
    renderDetail();

    const select = await screen.findByRole('combobox', { name: 'Use version' });
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getByRole('option', { name: 'v1 · current' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'version-2' } });

    expect(await screen.findByText(/The study now uses that definition version/)).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', { definition_version_id: 'version-2' });
  });

  it('edits the name and the description', async () => {
    platform.updateStudy.mockResolvedValue(studyFixture({ name: 'Renamed' }));
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: 'Two engines, two seeds.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', { name: 'Renamed', description: 'Two engines, two seeds.' });
  });

  it('deletes a study that has no runs and goes back to the list', async () => {
    platform.studyRuns.mockResolvedValue([]);
    platform.deleteStudy.mockResolvedValue(undefined);
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Engines × seeds?' })).getByRole('button', { name: 'Delete study' }));

    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(platform.deleteStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds');
  });

  it('archives instead of deleting when the study has runs', async () => {
    platform.deleteStudy.mockRejectedValue(refusal(409, 'study_history_retained'));
    platform.updateStudy.mockResolvedValue(studyFixture({ archived: true }));
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete study' }));

    expect(await screen.findByText('This study has runs, so it was archived instead of deleted. Results cited by reports stay intact.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', { archived: true });
  });

  it('lets a viewer read only, and a member run but not delete', async () => {
    const view = renderDetail('read-lab');
    expect(await screen.findByText(/You can read this study\. Running, archiving and editing it need MEMBER in Read Lab\./)).toBeInTheDocument();
    for (const name of ['Run study', 'Archive', 'Edit details', 'Delete']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    view.unmount();

    renderDetail('team-lab');
    expect(await screen.findByRole('button', { name: 'Run study' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('answers a study that is not in the project with a neutral 404', async () => {
    renderDetail('isa-demo', 'ghost');

    expect(await screen.findByRole('heading', { name: 'Study not found' })).toBeInTheDocument();
    expect(screen.getByText('No study with this address in QoS Benchmarks (404).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All studies' })).toHaveAttribute('href', `${ROOT}/studies`);
  });

  it('offers a retry when the studies cannot be read', async () => {
    platform.studies.mockRejectedValueOnce(refusal(503, 'unavailable'));
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

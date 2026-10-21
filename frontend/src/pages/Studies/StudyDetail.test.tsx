import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { CHECKOUT, REVISION_1, REVISION_2, VERSION_ID, cellsFixture, digestOf, runFixture, studyFixture } from '../../test/fixtures/studies';
import { StudyDetail } from './StudyDetail';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(), runStudy: vi.fn(), updateStudy: vi.fn(), deleteStudy: vi.fn(),
  cases: vi.fn(), revisions: vi.fn(),
}));
const library = vi.hoisted(() => ({ libraryApi: { versions: vi.fn() } }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/library', () => library);

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

function renderDetail(slug = 'isa-demo', study = 'engines-vs-seeds') {
  return renderProjectScreen(<StudyDetail />, {
    path: '/app/:org/:project/studies/:study', url: `/app/${slug}/qos-benchmarks/studies/${study}`, organizations: [group, viewing, member],
  });
}

describe('One study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cellsFixture());
    platform.cases.mockResolvedValue([CHECKOUT]);
    platform.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    library.libraryApi.versions.mockResolvedValue([version(VERSION_ID, 1)]);
  });

  it('shows the definition, the matrix it expands to, and the runs it has', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeInTheDocument();
    expect(await screen.findByText('Definition version 1 · sealed in the library')).toBeInTheDocument();
    const grid = await screen.findByRole('region', { name: 'The cells of the matrix' });
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(5);
    expect(within(grid).getByRole('columnheader', { name: 'random-search (sampling) · seed 2' })).toBeInTheDocument();
    expect(within(grid).getByRole('rowheader', { name: 'Checkout flow r2' })).toBeInTheDocument();
    expect(within(grid).getByText('cell 7')).toBeInTheDocument();
    expect(screen.getByText(/2 case revisions × 2 engines × 1 setting × 2 seeds = 8 cells\. Settings: 1 · engine defaults\. Seeds: 1, 2\. Every run repeats exactly these cells\./)).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Runs' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Run #1/ })).toHaveAttribute('href', `${STUDY}/runs/00000000-0000-4000-8000-000000000101`);
    expect(screen.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the definition in the library' })).toHaveAttribute('href', '/app/isa-demo/library/artifact-engines-vs-seeds');
    expect(screen.getByText('Only one version exists. A new version appears when the definition draft in the library is sealed.')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the raw definition behind View source', async () => {
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' });
    const source = screen.getByText('View source').closest('details') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    expect(screen.getByLabelText('Study definition source')).toHaveTextContent('"case_revision_ids"');
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

    expect(await screen.findByText('Run #2 accepted (202). Cells start as job slots free up.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow run #2' })).toHaveAttribute('href', `${STUDY}/runs/run-2`);
    expect(platform.runStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', VERSION_ID);
  });

  it.each([
    ['402 out of storage', new QuotaError('quota_exceeded', 'full', { limit_id: 'storageBytes', limit: 100, used: 100 }), 'Out of storage (402 · quota_exceeded)'],
    ['429 job slots busy', refusal(429, 'concurrency_limit_exceeded', 'busy', { concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 }, retryAfter: 15 }), 'All your job slots are busy (429 · concurrency_limit_exceeded)'],
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

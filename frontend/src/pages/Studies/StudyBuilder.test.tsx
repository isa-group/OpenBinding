import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { EVOLUTIONARY, FLUJO, RANDOM_SEARCH, REVISION_1, REVISION_2, digestOf, revisionFixture, studyFixture } from './fixtures';
import { StudyBuilder } from './StudyBuilder';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), cases: vi.fn(), revisions: vi.fn(), createStudy: vi.fn(), collection: vi.fn(), collectionRevisions: vi.fn(),
}));
const client = vi.hoisted(() => ({ getEngines: vi.fn(), getOwnUsage: vi.fn(), getPricingCatalog: vi.fn() }));
const library = vi.hoisted(() => ({ libraryApi: { list: vi.fn(), versions: vi.fn(), content: vi.fn() } }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
vi.mock('../../api/library', () => library);

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';

const mode = (id: string, seconds: number) => ({
  id, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: id, capabilities: {}, limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
  optionsSchema: { type: 'object', properties: { time_budget_ms: { type: 'integer', default: seconds * 1000 } }, additionalProperties: false },
});
const engineEntry = (ref: typeof RANDOM_SEARCH) => {
  const { mode: id, ...identity } = ref;
  return { ...identity, id: `engine-${identity.name}`, ref: identity, modes: [mode(id, 30)] };
};

const tracked = (id: string, limit: number, used: number) => ({ limit_id: id, limit, used, remaining: Math.max(0, limit - used), unit: null, renews_at: null });
const usage = {
  plan: 'RESEARCH', contract_pending: false, features: {}, capabilities: { maxTimeoutSeconds: 60 },
  limits: {
    studies: tracked('studies', 25, 1), studyRuns: tracked('studyRuns', 100, 4), taskStarts: tracked('taskStarts', 50, 18), solverSeconds: tracked('solverSeconds', 30_000, 7_420),
  },
};

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function renderBuilder(options: { query?: string; slug?: string } = {}) {
  return renderProjectScreen(<StudyBuilder />, {
    path: '/app/:org/:project/studies/new', url: `/app/${options.slug ?? 'isa-demo'}/qos-benchmarks/studies/new${options.query ?? ''}`, organizations: [group, viewing],
  });
}

const checkbox = (name: RegExp) => screen.findByRole('checkbox', { name });
const create = () => screen.getByRole('button', { name: 'Create study' });
const SEEDS = /Seeds \(comma-separated, ranges like 1-5 work\)/;

async function chooseMatrix() {
  fireEvent.click(await checkbox(/Flujo de checkout · revision 1/));
  fireEvent.click(await checkbox(/Flujo de checkout · revision 2/));
  fireEvent.click(await checkbox(/random-search 1\.0\.0/));
  fireEvent.click(await checkbox(/evolutionary 1\.0\.0/));
}

describe('A new study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.cases.mockResolvedValue([FLUJO]);
    platform.revisions.mockResolvedValue([REVISION_1, REVISION_2, revisionFixture(3, { source_snapshot_id: null })]);
    client.getEngines.mockResolvedValue([engineEntry(RANDOM_SEARCH), engineEntry(EVOLUTIONARY)]);
    client.getOwnUsage.mockResolvedValue(usage);
    client.getPricingCatalog.mockResolvedValue({});
    library.libraryApi.list.mockResolvedValue([]);
    library.libraryApi.versions.mockResolvedValue([]);
    library.libraryApi.content.mockResolvedValue('{}');
  });

  it('offers the executable revisions, the engine modes, the settings and the seeds', async () => {
    renderBuilder();

    expect(await screen.findByRole('heading', { level: 1, name: 'New study' })).toBeInTheDocument();
    expect(screen.getByText('Pick the cases, engines, settings and seeds. Every combination becomes one cell.')).toBeInTheDocument();
    expect(await checkbox(/Flujo de checkout · revision 2/)).toBeEnabled();
    expect(await checkbox(/Flujo de checkout · revision 3/)).toBeDisabled();
    expect(screen.getByText(/No compiled snapshot yet, so engines have nothing to run/)).toBeInTheDocument();
    expect(await checkbox(/random-search 1\.0\.0/)).not.toBeChecked();
    expect(screen.getByLabelText(SEEDS)).toHaveValue('1, 2');
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
    expect(create()).toBeDisabled();
    const needed = screen.getByRole('list', { name: 'Still needed' });
    expect(within(needed).getByText('Give the study a name.')).toBeInTheDocument();
    expect(within(needed).getByText('Choose at least one case revision, or a sealed collection.')).toBeInTheDocument();
    expect(within(needed).getByText('Choose at least one engine mode.')).toBeInTheDocument();
  });

  it('counts the cells as the choices are made and shows what one run uses of the plan', async () => {
    renderBuilder();
    await chooseMatrix();

    const aside = screen.getByRole('complementary', { name: 'Matrix and plan' });
    expect(within(aside).getByText('2 case revisions × 2 engines × 1 setting × 2 seeds')).toBeInTheDocument();
    expect(within(aside).getByText('Study definitions of the sponsor')).toBeInTheDocument();
    expect(within(aside).getByText('1 used + up to 1 = 2 of 25')).toBeInTheDocument();
    expect(within(aside).getByText('4 used + up to 1 = 5 of 100')).toBeInTheDocument();
    expect(within(aside).getByText('18 used + up to 8 = 26 of 50')).toBeInTheDocument();
    expect(within(aside).getByText('7,420 used + up to 240 = 7,660 of 30,000 s')).toBeInTheDocument();
    expect(within(aside).getByText(/Each run uses 1 of your study runs this month \(96 left\)/)).toBeInTheDocument();
    expect(within(aside).getByText(/your plan lets one solve run for up to 60 s/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1-5' } });
    expect(within(aside).getByText('2 case revisions × 2 engines × 1 setting × 5 seeds')).toBeInTheDocument();
  });

  it('creates the study with exactly the cases, engines, settings and seeds chosen', async () => {
    platform.createStudy.mockResolvedValue(studyFixture());
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Engines vs seeds' } });
    expect(screen.getByLabelText('Address')).toHaveValue('engines-vs-seeds');
    expect(create()).toBeEnabled();
    fireEvent.click(create());

    await waitFor(() => expect(platform.createStudy).toHaveBeenCalledTimes(1));
    const { mode: randomMode, ...randomIdentity } = RANDOM_SEARCH;
    const { mode: evolutionaryMode, ...evolutionaryIdentity } = EVOLUTIONARY;
    expect(platform.createStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', {
      slug: 'engines-vs-seeds', name: 'Engines vs seeds', description: '',
      definition: {
        case_revision_ids: [REVISION_1.id, REVISION_2.id],
        engines: [{ ...randomIdentity, mode: randomMode }, { ...evolutionaryIdentity, mode: evolutionaryMode }],
        parameter_sets: [{}],
        seeds: [1, 2],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Study created' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the study' })).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds`);
  });

  it('turns a time budget into a setting of the definition and says when the plan reduces it', async () => {
    platform.createStudy.mockResolvedValue(studyFixture());
    renderBuilder();
    fireEvent.click(await checkbox(/Flujo de checkout · revision 2/));
    fireEvent.click(await checkbox(/random-search 1\.0\.0/));
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Budgets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a setting' }));
    fireEvent.change(screen.getAllByLabelText('Time budget (seconds)')[1], { target: { value: '120' } });

    expect(screen.getByText(/Your plan runs at most 60 s per solve, so this setting runs at 60 s/)).toBeInTheDocument();
    expect(screen.getByText('time budget 120 s')).toBeInTheDocument();
    fireEvent.click(create());

    await waitFor(() => expect(platform.createStudy).toHaveBeenCalledTimes(1));
    const sent = platform.createStudy.mock.calls[0][2] as { definition: { parameter_sets: unknown[]; seeds: number[] } };
    expect(sent.definition.parameter_sets).toEqual([{}, { time_budget_ms: 120000 }]);
    expect(sent.definition.seeds).toEqual([1, 2]);
  });

  it('refuses repeated seeds and repeated settings before anything is sent', async () => {
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Dupes' } });
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1, 2, 2' } });

    expect(screen.getByText('Seed 2 appears twice. Each value can appear once.', { selector: 'small' })).toBeInTheDocument();
    expect(create()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1, 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a setting' }));
    expect(screen.getByText('Two settings are identical, so they would repeat the same cells. Change or remove one.')).toBeInTheDocument();
    expect(create()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove setting 2' }));
    expect(create()).toBeEnabled();
    expect(platform.createStudy).not.toHaveBeenCalled();
  });

  it('refuses a matrix over 10,000 cells', async () => {
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Huge' } });
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1-100' } });
    for (let n = 0; n < 25; n += 1) fireEvent.click(screen.getByRole('button', { name: 'Add a setting' }));

    const needed = screen.getByRole('list', { name: 'Still needed' });
    expect(within(needed).getByText('10,400 cells is over the 10,000 limit. Remove an engine, a setting or some seeds.')).toBeInTheDocument();
    expect(create()).toBeDisabled();
  });

  it('says what the gateway refused: no study definitions left, a key without the engine, a taken address', async () => {
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Refused' } });

    platform.createStudy.mockRejectedValueOnce(new QuotaError('quota_exceeded', 'full', { limit_id: 'studies', limit: 25, used: 25 }));
    fireEvent.click(create());
    expect(await screen.findByText('The sponsor has no study definitions left (402 · quota_exceeded)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
    expect(create()).toBeEnabled();

    platform.createStudy.mockRejectedValueOnce(refusal(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.'));
    fireEvent.click(create());
    expect(await screen.findByText(/This API key isn’t allowed to use one of the study’s engines \(403 · api_key_engine_forbidden\)/)).toBeInTheDocument();

    platform.createStudy.mockRejectedValueOnce(refusal(409, 'slug_conflict'));
    fireEvent.click(create());
    expect(await screen.findByText('That address is already used (409 · slug_conflict)')).toBeInTheDocument();

    platform.createStudy.mockRejectedValueOnce(refusal(422, 'engine_mode_incompatible', 'MiniZinc has no mode that supports this goal type.'));
    fireEvent.click(create());
    expect(await screen.findByText(/MiniZinc has no mode that supports this goal type\./)).toBeInTheDocument();
  });

  it('starts from the revision another screen named', async () => {
    renderBuilder({ query: '?case=flujo-checkout&revision=1' });

    expect(await checkbox(/Flujo de checkout · revision 1/)).toBeChecked();
    expect(await checkbox(/Flujo de checkout · revision 2/)).not.toBeChecked();
  });

  it('starts from the cases a project collection pins', async () => {
    platform.collection.mockResolvedValue({ id: 'c1', project_id: qos.id, slug: 'core', name: 'Core set', description: '', created_by_id: 'u', created_at: '2026-08-01T00:00:00Z' });
    platform.collectionRevisions.mockResolvedValue([
      { id: 'cr1', collection_id: 'c1', revision: 1, digest: digestOf('x'), created_at: '2026-08-01T00:00:00Z', items: [{ target_kind: 'case', target_digest: digestOf('1'), target_ref: { caseRevisionId: REVISION_1.id } }] },
      { id: 'cr2', collection_id: 'c1', revision: 2, digest: digestOf('y'), created_at: '2026-08-02T00:00:00Z', items: [
        { target_kind: 'case', target_digest: digestOf('2'), target_ref: { caseRevisionId: REVISION_2.id } },
        { target_kind: 'resource', target_digest: digestOf('3'), target_ref: { resourceRevisionId: 'r' } },
      ] },
    ]);
    renderBuilder({ query: '?collection=core' });

    expect(await screen.findByText(/The cases of the collection Core set are chosen below/)).toBeInTheDocument();
    expect(await checkbox(/Flujo de checkout · revision 2/)).toBeChecked();
    expect(await checkbox(/Flujo de checkout · revision 1/)).not.toBeChecked();
    expect(platform.collection).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'core');
  });

  it('creates a study from a shared definition of the library', async () => {
    library.libraryApi.list.mockResolvedValue([
      { id: 'art-study', organization_id: 'org-isa-demo', namespace: 'isa-demo', name: 'study-1', display_name: 'Engines × semillas', kind: 'Study', description: '', labels: {}, archived: false },
      { id: 'art-other', organization_id: 'org-isa-demo', namespace: 'isa-demo', name: 'catalog', display_name: 'Providers', kind: 'CandidateCatalog', description: '', labels: {}, archived: false },
    ]);
    library.libraryApi.versions.mockResolvedValue([
      { id: 'ver-1', artifact_id: 'art-study', ordinal: 1, ref: { namespace: 'isa-demo', name: 'study-1', version: '1', versionDigest: digestOf('v') }, contentDigest: digestOf('e'), withdrawn: false, public: false },
    ]);
    library.libraryApi.content.mockResolvedValue(JSON.stringify({ cases: [{}, {}], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] }));
    platform.createStudy.mockResolvedValue(studyFixture());
    renderBuilder();

    fireEvent.click(await screen.findByRole('radio', { name: 'Reuse a shared definition' }));
    expect(screen.queryByRole('option', { name: 'Providers' })).not.toBeInTheDocument();
    await screen.findByRole('option', { name: 'Engines × semillas' });
    fireEvent.change(screen.getByLabelText('Study definition'), { target: { value: 'art-study' } });
    await screen.findByRole('option', { name: /v1 · 1/ });
    fireEvent.change(screen.getByLabelText('Sealed version'), { target: { value: 'ver-1' } });

    expect(await screen.findByText(/From the library · 8 cells/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create from this definition' }));
    await waitFor(() => expect(platform.createStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', {
      slug: 'engines-semillas', name: 'Engines × semillas', description: '', definition_version_id: 'ver-1',
    }));
  });

  it('lets a viewer look through the form but not create', async () => {
    renderBuilder({ slug: 'read-lab' });

    expect(await screen.findByText(/Creating studies needs MEMBER; you’re a VIEWER of Read Lab/)).toBeInTheDocument();
    fireEvent.click(await checkbox(/Flujo de checkout · revision 1/));
    fireEvent.click(await checkbox(/random-search 1\.0\.0/));
    expect(create()).toBeDisabled();
    expect(screen.getByLabelText('Study name')).toBeDisabled();
    expect(screen.queryByRole('list', { name: 'Still needed' })).not.toBeInTheDocument();
  });

  it('reads a project that is not there like one the account cannot see', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderBuilder();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError, type EngineCatalogEntry, type EngineMode } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { ENGINE, REGISTRATION, digestOf } from '../../test/fixtures/jobs';
import { usageOf } from '../../test/fixtures/resources';
import { JobLaunch } from './JobLaunch';

const jobsApi = vi.hoisted(() => ({ launch: vi.fn() }));
const casesApi = vi.hoisted(() => ({ analyseSnapshot: vi.fn(), instanceIr: vi.fn() }));
const workbenchApi = vi.hoisted(() => ({ snapshot: vi.fn() }));
const client = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn(), getEngines: vi.fn() }));
const platform = vi.hoisted(() => ({ project: vi.fn(), cases: vi.fn(), revisions: vi.fn(), publicProjects: vi.fn() }));

vi.mock('../../api/jobs', () => ({ jobsApi }));
vi.mock('../../api/cases', () => ({ casesApi }));
vi.mock('../../api/workbench', () => ({ workbenchApi }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../components/Artifacts/ArtifactVersionPicker', () => ({
  ArtifactVersionPicker: ({ onSelect }: { onSelect: (artifact: unknown, version: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onSelect({}, { id: 'version-1', ref: { namespace: 'isa-demo', name: 'rs-60s', version: '1', versionDigest: 'sha256-v' } })}
    >
      Pick sealed settings
    </button>
  ),
}));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const flujo = caseOf('flujo', 'Flujo de checkout');
const ROOT = '/app/isa-demo/qos-benchmarks';

const MINIZINC = { namespace: 'bim.builtin', name: 'minizinc', version: '1.0.0', digest: digestOf('m') };
const MINIZINC_REGISTRATION = { namespace: 'bim.builtin', name: 'minizinc-deployment', version: '1', digest: digestOf('n') };
const EDGE = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: digestOf('e') };
const EDGE_REGISTRATION = { namespace: 'lucia-vega', name: 'edge-solver-eu', version: '1', digest: digestOf('r') };

const mode = (id: string, properties: Record<string, Record<string, unknown>>): EngineMode => ({
  id, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: id, capabilities: {} as EngineMode['capabilities'],
  optionsSchema: { type: 'object', properties, additionalProperties: false }, limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
});

const engines: EngineCatalogEntry[] = [
  { ...ENGINE, id: 'engine-1', ref: ENGINE, modes: [mode('sampling', { time_budget_ms: { type: 'integer', default: 30000 }, iterations: { type: 'integer', default: 100000 } })] },
  { ...MINIZINC, id: 'engine-2', ref: MINIZINC, modes: [mode('cp', {})] },
];

const analysis = (over: Record<string, unknown> = {}) => ({
  valid: true, instanceDigest: digestOf('d'), packageDigest: digestOf('e'), irDigest: digestOf('c'),
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
  compatibleModes: [
    { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
    { engine: MINIZINC, registration: MINIZINC_REGISTRATION, mode: 'cp', compatible: true },
    { engine: EDGE, registration: EDGE_REGISTRATION, mode: 'placement', compatible: false, diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] },
  ],
  ...over,
});

const tracked = (id: string, limit: number, used: number) => ({ limit_id: id, limit, used, remaining: limit - used, unit: null, renews_at: null });

function renderLaunch(search = '?case=flujo&revision=2', slug = 'isa-demo') {
  return renderProjectScreen(<JobLaunch />, {
    path: '/app/:org/:project/jobs/new', url: `/app/${slug}/qos-benchmarks/jobs/new${search}`, organizations: [group, viewing],
  });
}

const refused = (status: number, code: string, extra: Partial<HttpError> = {}) => Object.assign(new HttpError(status, 'refused'), { code }, extra);
const next = async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); };

/** Walks the four steps with what the address chose. */
async function toReview() {
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await screen.findByRole('radiogroup', { name: 'Engine' });
  await next();
  await screen.findByRole('heading', { name: 'Settings' });
  await next();
  await screen.findByRole('heading', { name: 'Before you send' });
}

describe('Start a run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([flujo]);
    platform.publicProjects.mockResolvedValue([]);
    platform.revisions.mockResolvedValue([revisionOf(flujo, 1, { source_snapshot_id: 'snap-1' }), revisionOf(flujo, 2, { source_snapshot_id: 'snap-2' })]);
    client.getOwnUsage.mockResolvedValue(usageOf({
      plan: 'RESEARCH',
      capabilities: { maxTimeoutSeconds: 60, maxIterations: 1_000_000, maxInstanceComplexityLog10: 20 },
      limits: { taskStarts: tracked('taskStarts', 50, 18), solverSeconds: tracked('solverSeconds', 30_000, 7_420), concurrentJobs: tracked('concurrentJobs', 3, 1) },
    }));
    client.getPricingCatalog.mockResolvedValue({});
    client.getEngines.mockResolvedValue(engines);
    casesApi.analyseSnapshot.mockResolvedValue(analysis());
    casesApi.instanceIr.mockResolvedValue({ spec: { candidates: { providers: { candidates: { a: { features: { latency: 40 } } } } } } });
    jobsApi.launch.mockResolvedValue({ id: 'job-new-7', status: 'queued', irDigest: digestOf('c') });
  });

  it('opens on the revision the address names and walks four steps', async () => {
    renderLaunch();

    expect(await screen.findByRole('heading', { level: 1, name: 'New run' })).toBeInTheDocument();
    expect(screen.getByText(/Before sending you’ll see what your plan reduces and what the run will use\./)).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem').map((item) => item.querySelector('b')?.textContent)).toEqual(['What', 'Engine', 'Settings', 'Send']);
    expect(within(steps).getByRole('button', { name: /What/ })).toHaveAttribute('aria-current', 'step');
    expect(within(steps).getByRole('button', { name: /Engine/ })).toBeDisabled();

    const source = await screen.findByRole('radiogroup', { name: 'Source' });
    expect(within(source).getAllByRole('radio')).toHaveLength(2);
    expect(within(source).getByRole('radio', { name: /Flujo de checkout · revision 2/ })).toBeChecked();
    expect(within(source).getByRole('radio', { name: /Flujo de checkout · revision 1/ })).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'Upload a new package in the Workbench' })).toHaveAttribute('href', `${ROOT}/workbench`);
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', `${ROOT}/jobs`);
    expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
  });

  it('checks which engines can run the snapshot and lists the ones that cannot, with the reason', async () => {
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const group_ = await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(casesApi.analyseSnapshot).toHaveBeenCalledWith('snap-2');
    expect(within(group_).getByRole('radio', { name: /^random-search/ })).toBeChecked();
    expect(within(group_).getByRole('radio', { name: /^random-search.*Can run this/ })).toBeEnabled();
    expect(within(group_).getByRole('radio', { name: /^edge-solver.*It cannot read a RoutingOverlay\..*Can’t run this/ })).toBeDisabled();
    expect(within(group_).getByRole('radio', { name: /^AutoRouter/ })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Compare engines' })).toHaveAttribute('href', '/engines');
    expect(screen.getByRole('button', { name: /Engine/ })).toHaveAttribute('aria-current', 'step');
  });

  describe('a package with ranges', () => {
    const ranged = { spec: { candidates: { providers: { candidates: { a: { features: { latency: { min: null, max: 200 } } }, b: { features: { latency: 40 } } } } } } };
    const RANGE_REASON = 'This package has range features; this engine only accepts single values';
    /** The diagnostic the gateway sends for a mode that does not declare interval values (docs/ERRORS.md). */
    const RANGE_DIAGNOSTIC = {
      code: 'unsupported_capability_value', category: 'featureValues', unsupported: ['interval'], allowed: ['scalar'],
      message: 'mode does not support requested featureValues values',
      resource: 'candidates.json', pointer: '/spec/candidates/a/features/latency', irPath: '/spec/candidates/providers/candidates/a/features/latency',
    };
    const refusedRanges = (over: Record<string, unknown>) => ({
      engine: MINIZINC, registration: MINIZINC_REGISTRATION, mode: 'cp', compatible: false,
      diagnostics: [{ ...RANGE_DIAGNOSTIC }], ...over,
    });

    it('turns off the engines that take single values only, with the reason, and links to Engines and to the candidates', async () => {
      casesApi.instanceIr.mockResolvedValue(ranged);
      casesApi.analyseSnapshot.mockResolvedValue(analysis({
        compatibleModes: [{ engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true }, refusedRanges({})],
      }));
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      const off = within(picker).getByRole('radio', { name: /^minizinc/ });
      expect(off).toBeDisabled();
      expect(off).toHaveAccessibleName(new RegExp(RANGE_REASON));
      expect(within(picker).getByRole('radio', { name: /^random-search.*Can run this/ })).toBeEnabled();
      const notice = screen.getByText('This package has range features').closest('.ui-notice') as HTMLElement;
      expect(notice).toHaveTextContent('The engines marked “Can’t run this” only accept single values.');
      expect(within(notice).getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
      expect(within(notice).getByRole('link', { name: 'edit the candidates' })).toHaveAttribute('href', '/app/isa-demo/library');
      expect(casesApi.instanceIr).toHaveBeenCalledWith('snap-2');
    });

    it('says so when no engine accepts ranges, and still lets the AutoRouter look', async () => {
      casesApi.instanceIr.mockResolvedValue(ranged);
      casesApi.analyseSnapshot.mockResolvedValue(analysis({ compatibleModes: [refusedRanges({ engine: ENGINE, registration: REGISTRATION, mode: 'sampling' })] }));
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      expect(within(picker).getByRole('radio', { name: /^random-search/ })).toBeDisabled();
      expect(screen.getByText(/No engine mode accepts ranges yet/)).toBeInTheDocument();
      expect(within(picker).getByRole('radio', { name: /^AutoRouter/ })).toBeChecked();
    });

    it('turns off the catalog modes that do not declare interval values when the gateway could not analyse the package', async () => {
      const intervals = { ...mode('cp', {}), capabilities: { featureValues: { selector: 'only', values: ['scalar', 'interval'] } } as unknown as EngineMode['capabilities'] };
      client.getEngines.mockResolvedValue([engines[0], { ...engines[1], modes: [intervals] }]);
      casesApi.instanceIr.mockResolvedValue(ranged);
      casesApi.analyseSnapshot.mockRejectedValue(refused(503, 'unavailable'));
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      expect(within(picker).getByRole('radio', { name: /^random-search/ })).toBeDisabled();
      expect(within(picker).getByRole('radio', { name: /^minizinc.*Checked when you send/ })).toBeEnabled();
      expect(within(picker).getByRole('radio', { name: /^minizinc/ })).toBeChecked();
    });

    it('offers every engine as before when the package has none, or when its compiled form cannot be read', async () => {
      casesApi.instanceIr.mockRejectedValue(new Error('offline'));
      casesApi.analyseSnapshot.mockRejectedValue(refused(503, 'unavailable'));
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      expect(within(picker).getByRole('radio', { name: /^random-search.*Checked when you send/ })).toBeEnabled();
      expect(screen.queryByText('This package has range features')).not.toBeInTheDocument();
    });

    it('explains a launch the engine refused for ranges, with the pointers and the way forward', async () => {
      casesApi.instanceIr.mockResolvedValue(ranged);
      casesApi.analyseSnapshot.mockResolvedValue(analysis({ compatibleModes: [{ engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true }] }));
      jobsApi.launch.mockRejectedValue(refused(422, 'engine_mode_incompatible', { diagnostics: [{ ...RANGE_DIAGNOSTIC }] }));
      renderLaunch();
      await toReview();

      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));

      const alert = (await screen.findByText(/^This engine only accepts single values/)).closest('.ui-notice') as HTMLElement;
      expect(alert).toHaveTextContent('mode does not support requested featureValues values (candidates.json#/spec/candidates/a/features/latency)');
      expect(within(alert).getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
      expect(within(alert).getByRole('link', { name: 'Edit the candidate' })).toHaveAttribute('href', '/app/isa-demo/library');
    });

    it('explains the same refusal when the gateway could not tell which value, pointing at the compiled problem instead', async () => {
      casesApi.instanceIr.mockResolvedValue(ranged);
      casesApi.analyseSnapshot.mockResolvedValue(analysis({ compatibleModes: [{ engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true }] }));
      const withoutPointer = { ...RANGE_DIAGNOSTIC, resource: undefined, pointer: undefined };
      jobsApi.launch.mockRejectedValue(refused(422, 'engine_mode_incompatible', { diagnostics: [{ code: 'profile_incompatible', message: 'mode profile differs' }, withoutPointer] }));
      renderLaunch();
      await toReview();

      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));

      const alert = (await screen.findByText(/^This engine only accepts single values/)).closest('.ui-notice') as HTMLElement;
      expect(alert).toHaveTextContent('mode does not support requested featureValues values (/spec/candidates/providers/candidates/a/features/latency)');
    });
  });

  it('preselects the engine the person came from', async () => {
    renderLaunch(`?case=flujo&revision=2&engine=${encodeURIComponent(`${MINIZINC.namespace}/${MINIZINC.name}@${MINIZINC.version}#${MINIZINC.digest}`)}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(within(picker).getByRole('radio', { name: /^minizinc/ })).toBeChecked();
    expect(within(picker).getByRole('radio', { name: /^random-search/ })).not.toBeChecked();
  });

  it('shows each setting beside what the plan allows and what the run will use', async () => {
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    await next();
    const table = await screen.findByRole('region', { name: 'Settings against your plan' });
    expect(within(table).getByLabelText('Time budget')).toHaveValue('30');
    expect(within(table).getByText('default 30 s')).toBeInTheDocument();
    expect(within(table).getByText('60 s')).toBeInTheDocument();
    expect(within(table).getByLabelText('Iterations')).toHaveValue('100000');
    expect(within(table).getByText('1,000,000 iterations')).toBeInTheDocument();

    fireEvent.change(within(table).getByLabelText('Time budget'), { target: { value: '600' } });
    expect(within(table).getByText('60 s (reduced)')).toBeInTheDocument();
    expect(screen.getByText('Values above your plan run at the ceiling and the job carries a note; it isn’t an error.')).toBeInTheDocument();

    fireEvent.change(within(table).getByLabelText('Time budget'), { target: { value: 'soon' } });
    expect(within(table).getByLabelText('Time budget')).toHaveAttribute('aria-invalid', 'true');
    expect(within(table).getByText('A positive number')).toBeInTheDocument();
  });

  it('reviews the run with what it adds to the month, then sends it with a one-time key', async () => {
    renderLaunch();
    await toReview();

    const review = screen.getByText('Solve').closest('dl') as HTMLElement;
    expect(within(review).getByText('Flujo de checkout · revision 2')).toBeInTheDocument();
    expect(within(review).getByText('random-search 1.0.0 · mode sampling')).toBeInTheDocument();
    expect(within(review).getByText('Time budget 30 s · Iterations 100,000 iterations')).toBeInTheDocument();
    expect(screen.getByText('18 used + up to 1 = 19 of 50')).toBeInTheDocument();
    expect(screen.getByText('7,420 used + up to 30 = 7,450 of 30,000 s')).toBeInTheDocument();
    expect(screen.getByText('1 used + up to 1 = 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('≈ 10^5.1 of up to 10^20 on your RESEARCH plan')).toBeInTheDocument();
    expect(screen.getByText('Sending twice by accident won’t start two runs: each send carries a one-time key.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    expect(await screen.findByRole('heading', { name: 'Run accepted · queued' })).toBeInTheDocument();
    expect(jobsApi.launch).toHaveBeenCalledTimes(1);
    expect(jobsApi.launch).toHaveBeenCalledWith(
      { snapshot: 'snap-2', engine: ENGINE, registration: REGISTRATION, mode: 'sampling', options: { time_budget_ms: 30000, iterations: 100000 } },
      expect.any(String),
    );
    expect(screen.getByText(/Nothing was reduced\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow the run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-7`);
  });

  it('says what the plan reduced once the run is accepted', async () => {
    renderLaunch();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    await next();
    fireEvent.change(await screen.findByLabelText('Time budget'), { target: { value: '600' } });
    await next();
    expect(await screen.findByText('Time budget 60 s (reduced) · Iterations 100,000 iterations')).toBeInTheDocument();
    expect(screen.getByText('7,420 used + up to 60 = 7,480 of 30,000 s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    expect(await screen.findByText(/Time budget was reduced to 60 s, what your plan allows; the job carries that note\./)).toBeInTheDocument();
    // The request carries what was asked; the gateway reduces it and records that on the job.
    expect(jobsApi.launch).toHaveBeenCalledWith(expect.objectContaining({ options: { time_budget_ms: 600000, iterations: 100000 } }), expect.any(String));
  });

  it('sends the AutoRouter policy instead of an exact engine', async () => {
    renderLaunch();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('radio', { name: /^AutoRouter/ }));
    await next();
    expect(await screen.findByRole('group', { name: 'AutoRouter policy' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Optimization profile'), { target: { value: 'cost_first' } });
    fireEvent.click(screen.getByLabelText('Require an exact solver'));
    await next();
    expect(await screen.findByText('AutoRouter · Cost first')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    await screen.findByRole('heading', { name: 'Run accepted · queued' });
    expect(jobsApi.launch).toHaveBeenCalledWith({
      snapshot: 'snap-2', engine: 'auto',
      options: {
        routing: {
          strategy: 'auto', profile: 'cost_first',
          hardConstraints: { maxCredits: 40, minQuality: 0.85, maxFailureRisk: 0.3, requireExact: true },
          adaptation: { allowFallback: true },
        },
      },
    }, expect.any(String));
  });

  it('sends sealed settings alone when the person uses saved settings', async () => {
    renderLaunch();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    await next();
    fireEvent.click(await screen.findByRole('radio', { name: 'Use saved settings' }));
    expect(screen.queryByRole('region', { name: 'Settings against your plan' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick sealed settings' }));
    expect(screen.getByText('rs-60s · v1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the library' })).toHaveAttribute('href', '/app/isa-demo/library');
    await next();
    expect(await screen.findByText('Saved: rs-60s v1')).toBeInTheDocument();
    expect(screen.getByText('From the saved settings')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    await screen.findByRole('heading', { name: 'Run accepted · queued' });
    expect(jobsApi.launch).toHaveBeenCalledWith({ snapshot: 'snap-2', configuration: { namespace: 'isa-demo', name: 'rs-60s', version: '1', versionDigest: 'sha256-v' } }, expect.any(String));
  });

  it('starts from a snapshot and compiles a revision that has none yet', async () => {
    platform.revisions.mockResolvedValue([revisionOf(flujo, 1), revisionOf(flujo, 2, { document: { kind: 'Instance' } })]);
    workbenchApi.snapshot.mockResolvedValue({ id: 'snap-made', irDigest: digestOf('c') });
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(workbenchApi.snapshot).toHaveBeenCalledTimes(1);
    expect(casesApi.analyseSnapshot).toHaveBeenCalledWith('snap-made');
  });

  it('opens on a snapshot from the address', async () => {
    renderLaunch('?snapshot=snap-9');

    const source = await screen.findByRole('radiogroup', { name: 'Source' });
    expect(within(source).getByRole('radio', { name: /Snapshot snap-9/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(casesApi.analyseSnapshot).toHaveBeenCalledWith('snap-9');
  });

  it('keeps a snapshot that is not yours out of the next step, with the neutral answer', async () => {
    casesApi.analyseSnapshot.mockRejectedValue(refused(404, 'not_found'));
    renderLaunch('?snapshot=snap-x');

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Snapshot not found (404)')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Engine' })).not.toBeInTheDocument();
  });

  it('says so when the problem is too big for the plan (402) and offers the catalog unchecked', async () => {
    casesApi.analyseSnapshot.mockRejectedValue(new QuotaError('instance_complexity_too_large', 'too big', { limit_id: 'maxInstanceComplexityLog10', limit: 9 }));
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too big for your plan (402 · instance_complexity_too_large)');
    expect(within(alert).getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
    const picker = screen.getByRole('radiogroup', { name: 'Engine' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    expect(within(picker).getByRole('radio', { name: /^random-search.*Checked when you send/ })).toBeEnabled();
  });

  it('says there is nothing to solve in a project without revisions', async () => {
    platform.cases.mockResolvedValue([]);
    renderLaunch('');

    expect(await screen.findByText(/Nothing to solve yet\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  describe('when the gateway refuses to start the run', () => {
    async function send() {
      renderLaunch();
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    }

    it('402 out of solves: what was used, when it renews, and where to look', async () => {
      jobsApi.launch.mockRejectedValue(new QuotaError('quota_exceeded', 'Solve quota exhausted.', { limit_id: 'taskStarts', limit: 50, used: 50, renews_at: '2026-11-01T00:00:00Z' }));
      await send();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Out of solves this month (402 · quota_exceeded)');
      expect(alert).toHaveTextContent('You’ve used 50 of 50 solves. They renew on Nov 1, 2026. Nothing was started.');
      expect(within(alert).getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/app/account/usage');
      expect(within(alert).getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      expect(screen.getByRole('button', { name: 'Send run' })).toBeEnabled();
    });

    it('402 too big for the plan', async () => {
      jobsApi.launch.mockRejectedValue(new QuotaError('instance_complexity_too_large', 'too big', { limit_id: 'maxInstanceComplexityLog10', limit: 9 }));
      await send();
      expect(await screen.findByText('Too big for your plan (402 · instance_complexity_too_large)')).toBeInTheDocument();
    });

    it('429 job slots busy, counting down', async () => {
      jobsApi.launch.mockRejectedValue(refused(429, 'concurrency_limit_exceeded', { retryAfter: 15, concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 } }));
      await send();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('All your job slots are busy (429 · concurrency_limit_exceeded)');
      expect(alert).toHaveTextContent('You can run 3 jobs at once.');
      expect(within(alert).getByRole('timer')).toHaveTextContent('A slot should free up in about 15 s.');
    });

    it('403 feature not in the plan, and 403 key without the permission', async () => {
      jobsApi.launch.mockRejectedValueOnce(refused(403, 'feature_not_entitled'));
      await send();
      expect(await screen.findByText('Not included in your plan (403 · feature_not_entitled)')).toBeInTheDocument();

      jobsApi.launch.mockRejectedValueOnce(new HttpError(403, 'The API key does not include engines:execute'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(await screen.findByText('This credential can’t start runs (403)')).toBeInTheDocument();
      expect(screen.getByText('engines:execute')).toBeInTheDocument();
    });

    it('422 mode incompatible lists what the gateway said', async () => {
      jobsApi.launch.mockRejectedValue(refused(422, 'engine_mode_incompatible', { diagnostics: [{ message: 'The mode cannot place a RoutingOverlay.' }] }));
      await send();

      expect(await screen.findByText('This engine can’t run this problem (422 · engine_mode_incompatible)')).toBeInTheDocument();
      expect(screen.getByText('The mode cannot place a RoutingOverlay.')).toBeInTheDocument();
    });

    it('404 engine not allowed by the key, 409 and 503', async () => {
      jobsApi.launch.mockRejectedValueOnce(refused(404, 'not_found'));
      await send();
      expect(await screen.findByText('Engine not available with this key (404 · not_found)')).toBeInTheDocument();

      jobsApi.launch.mockRejectedValueOnce(refused(409, 'engine_reference_mismatch'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(await screen.findByText('The selection conflicts with a sealed one (409 · engine_reference_mismatch)')).toBeInTheDocument();

      jobsApi.launch.mockRejectedValueOnce(new PricingUnavailableError('SPACE is down'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(await screen.findByText('Limits can’t be checked right now (503 · pricing_unavailable)')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /Run accepted/ })).not.toBeInTheDocument();
    });

    it('sends the same one-time key again for the same request, and a new one when the settings change', async () => {
      jobsApi.launch.mockRejectedValueOnce(refused(503, 'unavailable'));
      await send();
      await screen.findByRole('alert');
      jobsApi.launch.mockRejectedValueOnce(refused(503, 'unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      await waitFor(() => expect(jobsApi.launch).toHaveBeenCalledTimes(2));
      expect(jobsApi.launch.mock.calls[1][1]).toBe(jobsApi.launch.mock.calls[0][1]);

      fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
      fireEvent.change(await screen.findByLabelText('Time budget'), { target: { value: '20' } });
      fireEvent.click(screen.getByRole('button', { name: /Send/ }));
      await screen.findByRole('heading', { name: 'Before you send' });
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      await waitFor(() => expect(jobsApi.launch).toHaveBeenCalledTimes(3));
      expect(jobsApi.launch.mock.calls[2][1]).not.toBe(jobsApi.launch.mock.calls[0][1]);
    });
  });

  it('lets a viewer look through the steps but not send', async () => {
    renderLaunch('?case=flujo&revision=2', 'read-lab');

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('You’re a VIEWER of Read Lab. You can look through the steps, but starting a run needs MEMBER.');
    await toReview();
    expect(screen.getByRole('button', { name: 'Send run' })).toBeDisabled();
    expect(jobsApi.launch).not.toHaveBeenCalled();
  });

  it('gives a project the account is not in the neutral not-found answer', async () => {
    platform.project.mockRejectedValue(refused(404, 'not_found'));
    renderLaunch();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.cases).not.toHaveBeenCalled();
  });
});

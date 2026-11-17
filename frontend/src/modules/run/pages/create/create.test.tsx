import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../../core/api/account';
import { HttpError } from '../../../core/api/http';
import { type EngineCatalogEntry, type EngineMode } from '../../../engine/api/engineClient';
import { caseOf, revisionOf } from '../../../../test/fixtures/accounts';
import { orgNode, renderModule } from '../../../../test/moduleKit';
import { problemsPath } from '../../../../routes/paths/problems';
import { runPath, runsPath } from '../../../../routes/paths/runs';
import { ENGINE, REGISTRATION, digestOf } from '../../../../test/fixtures/jobs';
import { usageOf } from '../../../../test/fixtures/resources';
import { FEDERATED_PRESET, presetFixture, presetPage } from '../../../../test/fixtures/presets';
import RunLaunchPage from '.';

const runsApi = vi.hoisted(() => ({ create: vi.fn() }));
const client = vi.hoisted(() => ({
  getOwnUsage: vi.fn(),
  getPricingCatalog: vi.fn(),
  getEngines: vi.fn(),
}));
const problems = vi.hoisted(() => ({ list: vi.fn(), revisions: vi.fn(), compilation: vi.fn() }));
const facts = vi.hoisted(() => ({ get: vi.fn() }));
const presets = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));

vi.mock('../../api/runsApi', async actual => ({
  ...(await actual<typeof import('../../api/runsApi')>()),
  useRunsApi: () => runsApi,
}));
vi.mock('../../../problem/api/problemsClient', () => ({ problemsApi: problems }));
vi.mock('../../../core/utils/problem/facts', async actual => ({
  ...(await actual<typeof import('../../../core/utils/problem/facts')>()),
  problemFactsApi: facts,
}));
vi.mock('../../../engine/api/engineClient', async () => ({
  ...(await vi.importActual<typeof import('../../../engine/api/engineClient')>(
    '../../../engine/api/engineClient'
  )),
  engineClient: client,
}));
vi.mock('../../../settings/api/planClient', async () => ({
  ...(await vi.importActual<typeof import('../../../settings/api/planClient')>(
    '../../../settings/api/planClient'
  )),
  planClient: client,
}));
vi.mock('../../api/presetsApi', async actual => ({
  ...(await actual<typeof import('../../api/presetsApi')>()),
  presetsApi: presets,
}));

/** The facts of the compilation of a revision: candidates with these values, and an objective with these criteria. */
const factsWith = (values: Array<Record<string, unknown>>, criteria: string[] = []) => ({
  binding_space: '2',
  constraints: [],
  features: [{ id: 'latency', unit: 'ms', direction: 'min', required: true }],
  ir_digest: digestOf('c'),
  candidates: values.map((value, index) => ({
    key: `providers/c${index}`,
    resource: 'providers',
    id: `c${index}`,
    provider: null,
    values: value,
    origins: {},
  })),
  objectives: { criteria: criteria.map(id => ({ id })), penalties: [] },
  tasks: [
    {
      id: 't1',
      kind: 'service',
      eligible: values.map((_, index) => ({
        candidate: `providers/c${index}`,
        written: `c${index}`,
      })),
    },
  ],
  workflow: 't1',
});

const group = orgNode('isa-demo', { name: 'ISA Demo Group' });
const viewing = orgNode('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const flujo = caseOf('flujo', 'Flujo de checkout');

const MINIZINC = {
  namespace: 'bim.builtin',
  name: 'minizinc',
  version: '1.0.0',
  digest: digestOf('m'),
};
const MINIZINC_REGISTRATION = {
  namespace: 'bim.builtin',
  name: 'minizinc-deployment',
  version: '1',
  digest: digestOf('n'),
};
const EDGE = {
  namespace: 'edge-lab',
  name: 'edge-solver',
  version: '0.3.1',
  digest: digestOf('e'),
};
const EDGE_REGISTRATION = {
  namespace: 'edge-lab',
  name: 'edge-solver-eu',
  version: '1',
  digest: digestOf('r'),
};

const mode = (id: string, properties: Record<string, Record<string, unknown>>): EngineMode => ({
  id,
  profile: 'qos-binding/v1',
  ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  algorithm: id,
  capabilities: {} as EngineMode['capabilities'],
  optionsSchema: { type: 'object', properties, additionalProperties: false },
  limits: {},
  guarantees: { termination: ['FEASIBLE'], exact: false },
});

const engines: EngineCatalogEntry[] = [
  {
    ...ENGINE,
    id: 'engine-1',
    ref: ENGINE,
    modes: [
      mode('sampling', {
        time_budget_ms: { type: 'integer', default: 30000 },
        iterations: { type: 'integer', default: 100000 },
      }),
    ],
  },
  { ...MINIZINC, id: 'engine-2', ref: MINIZINC, modes: [mode('cp', {})] },
];

/** The compilation of a version by the installed toolchain: its analysis and the engine modes that can run it. */
const analysis = (over: Record<string, unknown> = {}) => ({
  id: 'compilation-2',
  revision_id: 'case-flujo-r2',
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '125892',
  created_at: '2026-08-20T10:05:00Z',
  current: true,
  toolchain: {},
  resources: {},
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
  compatible_modes: [
    { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
    { engine: MINIZINC, registration: MINIZINC_REGISTRATION, mode: 'cp', compatible: true },
    {
      engine: EDGE,
      registration: EDGE_REGISTRATION,
      mode: 'placement',
      compatible: false,
      diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }],
    },
  ],
  ...over,
});

function renderLaunch(search = '?problem=flujo&revision=2', slug = 'isa-demo') {
  return renderModule(<RunLaunchPage />, {
    path: '/runs/new',
    entry: `/runs/new?org=${slug}${search ? `&${search.slice(1)}` : ''}`,
    tree: [group, viewing],
  });
}

const refused = (status: number, code: string, extra: Partial<HttpError> = {}) =>
  Object.assign(new HttpError(status, 'refused'), { code }, extra);

/** Checks the version the address chose: the engine, settings and review cards open below it. */
async function toReview() {
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await screen.findByRole('radiogroup', { name: 'Engine' });
  await screen.findByRole('heading', { name: 'Settings' });
  await screen.findByRole('heading', { name: 'Before you send' });
}

describe('Start a run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.list.mockResolvedValue({ problems: [flujo], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([revisionOf(flujo, 1), revisionOf(flujo, 2)]);
    client.getOwnUsage.mockResolvedValue(
      usageOf({
        plan: 'RESEARCH',
        capabilities: { maxRunMinutes: 1, maxConcurrentRuns: 3 },
      })
    );
    client.getPricingCatalog.mockResolvedValue({});
    client.getEngines.mockResolvedValue(engines);
    problems.compilation.mockResolvedValue(analysis());
    facts.get.mockResolvedValue(factsWith([{ latency: 40 }]));
    runsApi.create.mockResolvedValue({
      id: 'job-new-7',
      status: 'queued',
      irDigest: digestOf('c'),
    });
    presets.list.mockResolvedValue(presetPage([presetFixture(), FEDERATED_PRESET]));
    presets.create.mockImplementation(
      async (_org: string, body: { slug: string; name: string }) => ({
        value: presetFixture({ slug: body.slug, name: body.name, id: 'p-new' }),
        etag: '"p-new"',
      })
    );
  });

  it('opens on the organization and the revision the address names, and opens the other steps once it is checked', async () => {
    renderLaunch();

    expect(await screen.findByRole('heading', { level: 1, name: 'New run' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Before sending you’ll see what your plan reduces and what the run will use\./
      )
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Organization' })).toHaveTextContent(
      'ISA Demo Group'
    );
    expect(screen.getByRole('heading', { level: 2, name: 'What to solve' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Engine' })).not.toBeInTheDocument();

    const source = await screen.findByRole('radiogroup', { name: 'Source' });
    expect(within(source).getAllByRole('radio')).toHaveLength(2);
    expect(
      within(source).getByRole('radio', { name: /Flujo de checkout · version 2/ })
    ).toBeChecked();
    expect(
      within(source).getByRole('radio', { name: /Flujo de checkout · version 1/ })
    ).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'Upload a problem' })).toHaveAttribute(
      'href',
      problemsPath('isa-demo')
    );
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute(
      'href',
      runsPath('isa-demo')
    );
    expect(screen.getByRole('link', { name: 'Back to the runs' })).toHaveAttribute(
      'href',
      runsPath('isa-demo')
    );
    expect(screen.queryByRole('button', { name: 'Send run' })).not.toBeInTheDocument();

    await toReview();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)
    ).toEqual(['What to solve', 'Engine', 'Settings', 'Before you send']);
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('checks which engines can run the version and lists the ones that cannot, with the reason', async () => {
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const group_ = await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(problems.compilation).toHaveBeenCalledWith('isa-demo', 'flujo', 2);
    expect(within(group_).getByRole('radio', { name: /^random-search/ })).toBeChecked();
    expect(
      within(group_).getByRole('radio', { name: /^random-search.*Can run this/ })
    ).toBeEnabled();
    expect(
      within(group_).getByRole('radio', {
        name: /^edge-solver.*It cannot read a RoutingOverlay\..*Can’t run this/,
      })
    ).toBeDisabled();
    expect(within(group_).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Compare engines' })).toHaveAttribute(
      'href',
      '/engines'
    );
  });

  describe('a package with ranges', () => {
    const ranged = factsWith([{ latency: { min: null, max: 200 } }, { latency: 40 }]);
    const RANGE_REASON = 'This package has range features; this engine only accepts single values';
    /** The diagnostic the gateway sends for a mode that does not declare interval values (docs/ERRORS.md). */
    const RANGE_DIAGNOSTIC = {
      code: 'unsupported_capability_value',
      category: 'featureValues',
      unsupported: ['interval'],
      allowed: ['scalar'],
      message: 'mode does not support requested featureValues values',
      resource: 'candidates.json',
      pointer: '/spec/candidates/a/features/latency',
      irPath: '/spec/candidates/providers/candidates/a/features/latency',
    };
    const refusedRanges = (over: Record<string, unknown>) => ({
      engine: MINIZINC,
      registration: MINIZINC_REGISTRATION,
      mode: 'cp',
      compatible: false,
      diagnostics: [{ ...RANGE_DIAGNOSTIC }],
      ...over,
    });

    it('turns off the engines that take single values only, with the reason, and links to Engines', async () => {
      facts.get.mockResolvedValue(ranged);
      problems.compilation.mockResolvedValue(
        analysis({
          compatible_modes: [
            { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
            refusedRanges({}),
          ],
        })
      );
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      const off = within(picker).getByRole('radio', { name: /^minizinc/ });
      expect(off).toBeDisabled();
      expect(off).toHaveAccessibleName(new RegExp(RANGE_REASON));
      expect(
        within(picker).getByRole('radio', { name: /^random-search.*Can run this/ })
      ).toBeEnabled();
      const notice = screen
        .getByText('This package has range features')
        .closest('.ui-notice') as HTMLElement;
      expect(notice).toHaveTextContent(
        'The engines marked “Can’t run this” only accept single values.'
      );
      expect(within(notice).getByRole('link', { name: 'Engines' })).toHaveAttribute(
        'href',
        '/engines'
      );
      expect(within(notice).queryByRole('link', { name: 'edit the candidates' })).toBeNull();
      expect(within(notice).queryByRole('link', { name: /library/i })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Open the library' })).toBeNull();
      expect(facts.get).toHaveBeenCalledWith('isa-demo', 'flujo', 2, 'compilation-2');
    });

    it('says so when no engine accepts ranges', async () => {
      facts.get.mockResolvedValue(ranged);
      problems.compilation.mockResolvedValue(
        analysis({
          compatible_modes: [
            refusedRanges({ engine: ENGINE, registration: REGISTRATION, mode: 'sampling' }),
          ],
        })
      );
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      expect(within(picker).getByRole('radio', { name: /^random-search/ })).toBeDisabled();
      expect(screen.getByText(/No engine mode accepts ranges yet/)).toBeInTheDocument();
    });

    it('offers every engine as before when the package has none, or when its compiled form cannot be read', async () => {
      facts.get.mockRejectedValue(new Error('offline'));
      problems.compilation.mockRejectedValue(refused(503, 'unavailable'));
      renderLaunch();

      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
      expect(
        within(picker).getByRole('radio', { name: /^random-search.*Checked when you send/ })
      ).toBeEnabled();
      expect(screen.queryByText('This package has range features')).not.toBeInTheDocument();
    });

    it('explains a launch the engine refused for ranges, with the pointers and the way forward', async () => {
      facts.get.mockResolvedValue(ranged);
      problems.compilation.mockResolvedValue(
        analysis({
          compatible_modes: [
            { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
          ],
        })
      );
      runsApi.create.mockRejectedValue(
        refused(422, 'engine_mode_incompatible', { diagnostics: [{ ...RANGE_DIAGNOSTIC }] })
      );
      renderLaunch();
      await toReview();

      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));

      const alert = (await screen.findByText(/^This engine only accepts single values/)).closest(
        '.ui-notice'
      ) as HTMLElement;
      expect(alert).toHaveTextContent(
        'mode does not support requested featureValues values (candidates.json#/spec/candidates/a/features/latency)'
      );
      expect(within(alert).getByRole('link', { name: 'Engines' })).toHaveAttribute(
        'href',
        '/engines'
      );
      expect(within(alert).queryByRole('link', { name: 'Edit the candidate' })).toBeNull();
    });

    it('explains the same refusal when the gateway could not tell which value, pointing at the compiled problem instead', async () => {
      facts.get.mockResolvedValue(ranged);
      problems.compilation.mockResolvedValue(
        analysis({
          compatible_modes: [
            { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
          ],
        })
      );
      const withoutPointer = { ...RANGE_DIAGNOSTIC, resource: undefined, pointer: undefined };
      runsApi.create.mockRejectedValue(
        refused(422, 'engine_mode_incompatible', {
          diagnostics: [
            { code: 'profile_incompatible', message: 'mode profile differs' },
            withoutPointer,
          ],
        })
      );
      renderLaunch();
      await toReview();

      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));

      const alert = (await screen.findByText(/^This engine only accepts single values/)).closest(
        '.ui-notice'
      ) as HTMLElement;
      expect(alert).toHaveTextContent(
        'mode does not support requested featureValues values (/spec/candidates/providers/candidates/a/features/latency)'
      );
    });
  });

  it('preselects the engine the person came from', async () => {
    renderLaunch(
      `?problem=flujo&revision=2&engine=${encodeURIComponent(`${MINIZINC.namespace}/${MINIZINC.name}@${MINIZINC.version}#${MINIZINC.digest}`)}`
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(within(picker).getByRole('radio', { name: /^minizinc/ })).toBeChecked();
    expect(within(picker).getByRole('radio', { name: /^random-search/ })).not.toBeChecked();
  });

  it('shows each setting beside what the plan allows and what the run will use', async () => {
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    const table = await screen.findByRole('region', { name: 'Settings against your plan' });
    expect(within(table).getByLabelText('Time budget')).toHaveValue('30');
    expect(within(table).getByText('default 30 s')).toBeInTheDocument();
    expect(within(table).getByText('60 s')).toBeInTheDocument();
    expect(within(table).getByLabelText('Iterations')).toHaveValue('100000');

    fireEvent.change(within(table).getByLabelText('Time budget'), { target: { value: '600' } });
    expect(within(table).getByText('60 s (reduced)')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Values above your plan run at the ceiling and the run carries a note; it isn’t an error.'
      )
    ).toBeInTheDocument();

    fireEvent.change(within(table).getByLabelText('Time budget'), { target: { value: 'soon' } });
    expect(within(table).getByLabelText('Time budget')).toHaveAttribute('aria-invalid', 'true');
    expect(within(table).getByText('A positive number')).toBeInTheDocument();
  });

  it('reviews the run against the plan’s size ceiling, then sends it with a one-time key', async () => {
    renderLaunch();
    await toReview();

    const review = screen.getByText('Solve').closest('dl') as HTMLElement;
    expect(within(review).getByText('Flujo de checkout · version 2')).toBeInTheDocument();
    expect(within(review).getByText('random-search 1.0.0 · mode sampling')).toBeInTheDocument();
    expect(
      within(review).getByText('Time budget 30 s · Iterations 100,000 iterations')
    ).toBeInTheDocument();
    expect(screen.queryByText(/used \+ up to/)).not.toBeInTheDocument();
    expect(
      screen.getByText('≈ 10^5.1 combinations · this deployment sets the ceiling')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Sending twice by accident won’t start two runs: each send carries a one-time key.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    expect(
      await screen.findByRole('heading', { name: 'Run accepted · queued' })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    expect(runsApi.create).toHaveBeenCalledTimes(1);
    expect(runsApi.create).toHaveBeenCalledWith(
      'isa-demo',
      {
        revision: 'case-flujo-r2',
        engine: ENGINE,
        registration: REGISTRATION,
        mode: 'sampling',
        options: { time_budget_ms: 30000, iterations: 100000 },
      },
      expect.any(String)
    );
    expect(screen.getByText(/Nothing was reduced\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow the run' })).toHaveAttribute(
      'href',
      runPath('isa-demo', 'job-new-7')
    );
  });

  it('sends the optimization the gateway requires: one criterion and a weighted-sum mode make a SINGLE weighted-sum run', async () => {
    const withWeightedSum: EngineCatalogEntry[] = [
      {
        ...engines[0],
        modes: [
          {
            ...engines[0].modes[0],
            capabilities: {
              scalarizations: {
                selector: 'only',
                values: [
                  { id: 'weighted-sum', objectiveTypes: ['SINGLE'], weightPolicy: 'required' },
                ],
              },
            } as unknown as EngineMode['capabilities'],
          },
        ],
      },
      engines[1],
    ];
    client.getEngines.mockResolvedValue(withWeightedSum);
    facts.get.mockResolvedValue(factsWith([{ latency: 40 }], ['latency']));
    renderLaunch();
    await toReview();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    await screen.findByRole('heading', { name: 'Run accepted · queued' });
    expect(runsApi.create).toHaveBeenCalledWith(
      'isa-demo',
      expect.objectContaining({
        engine: ENGINE,
        mode: 'sampling',
        optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
      }),
      expect.any(String)
    );
  });

  it('leaves the optimization out when the mode declares no scalarization, and lets the gateway answer', async () => {
    renderLaunch();
    await toReview();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    await screen.findByRole('heading', { name: 'Run accepted · queued' });
    expect(runsApi.create.mock.calls[0][1]).not.toHaveProperty('optimization');
  });

  it('says what the plan reduced once the run is accepted', async () => {
    renderLaunch();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('radiogroup', { name: 'Engine' });
    fireEvent.change(await screen.findByLabelText('Time budget'), { target: { value: '600' } });
    expect(
      await screen.findByText('Time budget 60 s (reduced) · Iterations 100,000 iterations')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    expect(
      await screen.findByText(
        /Time budget was reduced to 60 s, what your plan allows; the run carries that note\./
      )
    ).toBeInTheDocument();
    // The request carries what was asked; the gateway reduces it and records that on the job.
    expect(runsApi.create).toHaveBeenCalledWith(
      'isa-demo',
      expect.objectContaining({ options: { time_budget_ms: 600000, iterations: 100000 } }),
      expect.any(String)
    );
  });

  it('only offers the engine modes the gateway or the catalog lists, and always sends an exact engine', async () => {
    renderLaunch();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const picker = await screen.findByRole('radiogroup', { name: 'Engine' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(3);
    expect(within(picker).getByRole('radio', { name: /^random-search/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
    await screen.findByRole('heading', { name: 'Run accepted · queued' });
    expect(runsApi.create).toHaveBeenCalledWith(
      'isa-demo',
      expect.objectContaining({ engine: ENGINE }),
      expect.any(String)
    );
  });

  describe('run presets', () => {
    const picker = () => screen.findByLabelText('Start from a preset');

    it('starts from a preset: its engine, mode and options read-only, and sends the preset alone', async () => {
      renderLaunch();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      fireEvent.change(await picker(), { target: { value: 'fast-sampling' } });

      const card = screen.getByRole('region', { name: 'Run preset Fast sampling' });
      expect(within(card).getByText('random-search 1.0.0 · mode sampling')).toBeInTheDocument();
      expect(within(card).getByText('time budget 30 s · iterations 5,000')).toBeInTheDocument();
      expect(within(card).getByText('SINGLE · weighted-sum')).toBeInTheDocument();
      expect(within(card).getByText('Can run this')).toBeInTheDocument();
      expect(screen.queryByRole('radiogroup', { name: 'Engine' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Manage run presets' })).toHaveAttribute(
        'href',
        '/orgs/isa-demo/presets'
      );
      expect(presets.list).toHaveBeenCalledWith('isa-demo', { limit: 200 });

      expect(
        await screen.findByText(
          'The settings come from the preset Fast sampling: time budget 30 s · iterations 5,000.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: 'Settings against your plan' })
      ).not.toBeInTheDocument();
      const review = (await screen.findByText('Solve')).closest('dl') as HTMLElement;
      expect(within(review).getByText('Fast sampling (fast-sampling)')).toBeInTheDocument();
      expect(within(review).getByText('random-search 1.0.0 · mode sampling')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save as preset' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(
        await screen.findByRole('heading', { name: 'Run accepted · queued' })
      ).toBeInTheDocument();
      expect(runsApi.create).toHaveBeenCalledWith(
        'isa-demo',
        { revision: 'case-flujo-r2', preset: 'fast-sampling' },
        expect.any(String)
      );
      expect(
        screen.getByText(/It runs with the settings of the preset Fast sampling/)
      ).toBeInTheDocument();
    });

    it('opens on the preset the address names, and names a federated one’s deployment', async () => {
      presets.list.mockResolvedValue(presetPage([presetFixture(), FEDERATED_PRESET]));
      renderLaunch('?problem=flujo&revision=2&preset=edge-deployment');
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

      const card = await screen.findByRole('region', { name: 'Run preset Edge deployment' });
      expect(within(card).getByText('edge-lab/edge-solver-eu 1')).toBeInTheDocument();
      expect(within(card).getByText('Can’t run this')).toBeInTheDocument();
      expect(within(card).getByText('It cannot read a RoutingOverlay.')).toBeInTheDocument();
      expect(await picker()).toHaveValue('edge-deployment');
    });

    it('detaches with Edit: the preset’s settings move into the form and every setting is sent', async () => {
      renderLaunch();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      fireEvent.change(await picker(), { target: { value: 'fast-sampling' } });
      fireEvent.click(
        within(screen.getByRole('region', { name: 'Run preset Fast sampling' })).getByRole(
          'button',
          { name: 'Edit' }
        )
      );

      const engines = await screen.findByRole('radiogroup', { name: 'Engine' });
      expect(within(engines).getByRole('radio', { name: /^random-search/ })).toBeChecked();
      expect(await picker()).toHaveValue('');
      expect(await screen.findByLabelText('Time budget')).toHaveValue('30');
      expect(screen.getByLabelText('Iterations')).toHaveValue('5000');
      await screen.findByRole('heading', { name: 'Before you send' });
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      await screen.findByRole('heading', { name: 'Run accepted · queued' });
      expect(runsApi.create).toHaveBeenCalledWith(
        'isa-demo',
        {
          revision: 'case-flujo-r2',
          engine: ENGINE,
          registration: REGISTRATION,
          mode: 'sampling',
          options: { time_budget_ms: 30000, iterations: 5000 },
          optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
        },
        expect.any(String)
      );
    });

    it('saves the settings chosen here as a preset of the organization', async () => {
      renderLaunch();
      await toReview();

      fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
      const dialog = await screen.findByRole('dialog', { name: 'Save as a run preset' });
      fireEvent.change(within(dialog).getByLabelText('Preset name'), {
        target: { value: 'My sampling' },
      });
      expect(within(dialog).getByLabelText('Preset address')).toHaveValue('my-sampling');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }));

      await waitFor(() =>
        expect(presets.create).toHaveBeenCalledWith('isa-demo', {
          slug: 'my-sampling',
          name: 'My sampling',
          description: '',
          engine: ENGINE,
          registration: null,
          mode: 'sampling',
          options: { time_budget_ms: 30000, iterations: 100000 },
          optimization: null,
        })
      );
      expect(await screen.findByText(/Saved as the run preset My sampling\./)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(presets.list).toHaveBeenCalledTimes(2));
    });

    it('says when the address of a new preset is taken, and keeps the dialog open', async () => {
      presets.create.mockRejectedValue(refused(409, 'slug_conflict'));
      renderLaunch();
      await toReview();
      fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
      const dialog = await screen.findByRole('dialog', { name: 'Save as a run preset' });
      fireEvent.change(within(dialog).getByLabelText('Preset name'), {
        target: { value: 'Fast sampling' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Another preset of this organization has that address (409 · slug_conflict). Change it.'
      );
    });

    it('explains a preset that no longer exists when the run is sent', async () => {
      runsApi.create.mockRejectedValue(refused(422, 'preset_not_found'));
      renderLaunch();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      fireEvent.change(await picker(), { target: { value: 'fast-sampling' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Send run' }));

      expect(
        await screen.findByText('That run preset no longer exists (422 · preset_not_found)')
      ).toBeInTheDocument();
    });

    it('offers the settings here when the organization has no preset or they can’t be read', async () => {
      presets.list.mockRejectedValue(refused(503, 'unavailable'));
      renderLaunch();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

      expect(await picker()).toBeDisabled();
      expect(
        screen.getByText(
          /The organization’s run presets couldn’t be loaded; choose the settings here\./
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('radiogroup', { name: 'Engine' })).toBeInTheDocument();
    });
  });

  it('keeps a version that is gone out of the next step, with the neutral answer', async () => {
    problems.compilation.mockRejectedValue(refused(404, 'not_found'));
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Problem version not found (404)')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Engine' })).not.toBeInTheDocument();
  });

  it('says so when the problem is over the deployment’s size limit (422) and offers the catalog unchecked', async () => {
    problems.compilation.mockRejectedValue(
      refused(422, 'binding_space_over_technical_limit', {
        notice: {
          limit_id: 'MAX_BINDING_SPACE_LOG10',
          state: 'exhausted',
          source: 'technical',
          limit: 20,
          used: 23,
        },
      })
    );
    renderLaunch();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Over this deployment’s size limit (422 · binding_space_over_technical_limit)'
    );
    expect(within(alert).queryByRole('link', { name: 'Compare plans' })).not.toBeInTheDocument();
    const picker = screen.getByRole('radiogroup', { name: 'Engine' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(2);
    expect(
      within(picker).getByRole('radio', { name: /^random-search.*Checked when you send/ })
    ).toBeEnabled();
  });

  it('says there is nothing to solve in an organization without problem versions', async () => {
    problems.list.mockResolvedValue({ problems: [], total: 0, limit: 200, offset: 0 });
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

    it('402 out of an allowance: what the plan allows and where to look', async () => {
      runsApi.create.mockRejectedValue(
        new QuotaError('quota_exceeded', 'Storage exhausted.', {
          limit_id: 'maxRepositoryStorage',
          limit: 50,
          used: 50,
        })
      );
      await send();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Out of storage (402 · quota_exceeded)');
      expect(alert).toHaveTextContent('You’ve used 50 of 50 storage. Nothing was started.');
      expect(within(alert).getByRole('link', { name: 'See your plan' })).toHaveAttribute(
        'href',
        '/me/settings?section=plan'
      );
      expect(within(alert).getByRole('link', { name: 'Compare plans' })).toHaveAttribute(
        'href',
        '/pricing'
      );
      expect(screen.getByRole('button', { name: 'Send run' })).toBeEnabled();
    });

    it('422 over the deployment’s size limit, which no plan changes', async () => {
      runsApi.create.mockRejectedValue(
        refused(422, 'binding_space_over_technical_limit', {
          notice: {
            limit_id: 'MAX_BINDING_SPACE_LOG10',
            state: 'exhausted',
            source: 'technical',
            limit: 20,
            used: 23,
          },
        })
      );
      await send();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'Over this deployment’s size limit (422 · binding_space_over_technical_limit)'
      );
      expect(within(alert).queryByRole('link', { name: 'Compare plans' })).not.toBeInTheDocument();
    });

    it('429 job slots busy, counting down', async () => {
      runsApi.create.mockRejectedValue(
        refused(429, 'concurrency_limit_exceeded', {
          retryAfter: 15,
          concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 },
        })
      );
      await send();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'All your run slots are busy (429 · concurrency_limit_exceeded)'
      );
      expect(alert).toHaveTextContent('You can have 3 runs going at once.');
      expect(within(alert).getByRole('timer')).toHaveTextContent(
        'A slot should free up in about 15 s.'
      );
    });

    it('403 feature not in the plan, and 403 key without the permission', async () => {
      runsApi.create.mockRejectedValueOnce(refused(403, 'feature_not_entitled'));
      await send();
      expect(
        await screen.findByText('Not included in your plan (403 · feature_not_entitled)')
      ).toBeInTheDocument();

      runsApi.create.mockRejectedValueOnce(
        new HttpError(403, 'The API key does not include engines:execute')
      );
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(await screen.findByText('This credential can’t start runs (403)')).toBeInTheDocument();
      expect(screen.getByText('engines:execute')).toBeInTheDocument();
    });

    it('422 mode incompatible lists what the gateway said', async () => {
      runsApi.create.mockRejectedValue(
        refused(422, 'engine_mode_incompatible', {
          diagnostics: [{ message: 'The mode cannot place a RoutingOverlay.' }],
        })
      );
      await send();

      expect(
        await screen.findByText(
          'This engine can’t run this problem (422 · engine_mode_incompatible)'
        )
      ).toBeInTheDocument();
      expect(screen.getByText('The mode cannot place a RoutingOverlay.')).toBeInTheDocument();
    });

    it('404 engine not allowed by the key, 409 and 503', async () => {
      runsApi.create.mockRejectedValueOnce(refused(404, 'not_found'));
      await send();
      expect(
        await screen.findByText('Engine not available with this key (404 · not_found)')
      ).toBeInTheDocument();

      runsApi.create.mockRejectedValueOnce(refused(409, 'engine_reference_mismatch'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(
        await screen.findByText(
          'The selection conflicts with a sealed one (409 · engine_reference_mismatch)'
        )
      ).toBeInTheDocument();

      runsApi.create.mockRejectedValueOnce(new PricingUnavailableError('SPACE is down'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      expect(
        await screen.findByText('Limits can’t be checked right now (503 · pricing_unavailable)')
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /Run accepted/ })).not.toBeInTheDocument();
    });

    it('sends the same one-time key again for the same request, and a new one when the settings change', async () => {
      runsApi.create.mockRejectedValueOnce(refused(503, 'unavailable'));
      await send();
      await screen.findByRole('alert');
      runsApi.create.mockRejectedValueOnce(refused(503, 'unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      await waitFor(() => expect(runsApi.create).toHaveBeenCalledTimes(2));
      expect(runsApi.create.mock.calls[1][2]).toBe(runsApi.create.mock.calls[0][2]);

      fireEvent.change(await screen.findByLabelText('Time budget'), { target: { value: '20' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send run' }));
      await waitFor(() => expect(runsApi.create).toHaveBeenCalledTimes(3));
      expect(runsApi.create.mock.calls[2][2]).not.toBe(runsApi.create.mock.calls[0][2]);
    });
  });

  it('lets a viewer look through the steps but not send', async () => {
    renderLaunch('?problem=flujo&revision=2', 'read-lab');

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(
      'You’re a VIEWER of Read Lab. You can look through the steps, but starting a run needs MEMBER.'
    );
    await toReview();
    expect(screen.getByRole('button', { name: 'Send run' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save as preset' })).not.toBeInTheDocument();
    expect(runsApi.create).not.toHaveBeenCalled();
  });

  it('asks for the organization when the address names none the account is in', async () => {
    renderLaunch('?problem=flujo&revision=2', 'elsewhere');

    expect(
      await screen.findByText(/Choose the organization the run belongs to/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Organization' })).toHaveTextContent(
      'Select an organization'
    );
    expect(problems.list).not.toHaveBeenCalled();
  });
});

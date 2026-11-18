import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../../core/api/account';
import { HttpError } from '../../../core/api/http';
import { addressNow } from '../../../../test/moduleKit';
import { renderStudyScreen } from '../../../../test/studyPage';
import {
  CHECKOUT,
  EVOLUTIONARY,
  RANDOM_SEARCH,
  REVISION_1,
  REVISION_2,
  studyFixture,
} from '../../../../test/fixtures/studies';
import { presetPage } from '../../../../test/fixtures/presets';
import CreateStudyPage from '.';

const platform = vi.hoisted(() => ({
  create: vi.fn(),
}));
const client = vi.hoisted(() => ({
  getEngines: vi.fn(),
  getOwnUsage: vi.fn(),
  getPlansPricing: vi.fn(),
}));

const problems = vi.hoisted(() => ({
  list: vi.fn(),
  revisions: vi.fn(),
  compilation: vi.fn(),
  ir: vi.fn(),
}));
vi.mock('../../api/studiesApi', async () => ({
  ...(await vi.importActual<typeof import('../../api/studiesApi')>('../../api/studiesApi')),
  studiesApi: platform,
}));
vi.mock('../../../problem/api/problemsClient', () => ({ problemsApi: problems }));
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
const presets = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../../run/api/presetsApi', async actual => ({
  ...(await actual<typeof import('../../../run/api/presetsApi')>()),
  presetsApi: presets,
}));

const mode = (id: string, seconds: number) => ({
  id,
  profile: 'qos-binding/v1',
  ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  algorithm: id,
  capabilities: {},
  limits: {},
  guarantees: { termination: ['FEASIBLE'], exact: false },
  optionsSchema: {
    type: 'object',
    properties: { time_budget_ms: { type: 'integer', default: seconds * 1000 } },
    additionalProperties: false,
  },
});
const engineEntry = (ref: typeof RANDOM_SEARCH) => {
  const { mode: id, ...identity } = ref;
  return { ...identity, id: `engine-${identity.name}`, ref: identity, modes: [mode(id, 30)] };
};

const usage = {
  plan: 'RESEARCH',
  contract_pending: false,
  features: {},
  capabilities: { maxRunMinutes: 1, maxStudyCells: 5000 },
};

const refusal = (status: number, code: string, message = 'refused') =>
  Object.assign(new HttpError(status, message), { code });

/** The form `/studies/new`, in the organization `?org=` names (with the rest of the query). */
function renderBuilder(options: { query?: string; slug?: string } = {}) {
  return renderStudyScreen(<CreateStudyPage />, {
    path: '/studies/new',
    url: `/studies/new?org=${options.slug ?? 'isa-demo'}${options.query ?? ''}`,
  });
}

const checkbox = (name: RegExp) => screen.findByRole('checkbox', { name });
const create = () => screen.getByRole('button', { name: 'Create study' });
const SEEDS = /Seeds \(comma-separated, ranges like 1-5 work\)/;

async function chooseMatrix() {
  fireEvent.click(await checkbox(/Checkout flow · version 1/));
  fireEvent.click(await checkbox(/Checkout flow · version 2/));
  fireEvent.click(await checkbox(/random-search 1\.0\.0/));
  fireEvent.click(await checkbox(/evolutionary 1\.0\.0/));
}

describe('A new study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.list.mockResolvedValue({ problems: [CHECKOUT], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    client.getEngines.mockResolvedValue([engineEntry(RANDOM_SEARCH), engineEntry(EVOLUTIONARY)]);
    client.getOwnUsage.mockResolvedValue(usage);
    client.getPlansPricing.mockResolvedValue({ version: '0.2.0', document: {} });
    presets.list.mockResolvedValue(presetPage());
  });

  it('offers the versions of the organization’s problems, the engine modes, the settings and the seeds', async () => {
    renderBuilder();

    expect(await screen.findByRole('heading', { level: 1, name: 'New study' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Pick the problems, engines, settings and seeds. Every combination becomes one cell.'
      )
    ).toBeInTheDocument();
    expect(await checkbox(/Checkout flow · version 2/)).toBeEnabled();
    expect(await checkbox(/Checkout flow · version 1/)).toBeEnabled();
    expect(problems.list).toHaveBeenCalledWith('isa-demo', { limit: 200 });
    expect(await checkbox(/random-search 1\.0\.0/)).not.toBeChecked();
    expect(screen.getByLabelText(SEEDS)).toHaveValue('1, 2');
    expect(screen.getByRole('link', { name: 'Back to organization' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo/studies'
    );
    expect(screen.getByRole('button', { name: 'Organization' })).toHaveTextContent(
      'ISA Demo Group'
    );
    expect(create()).toBeDisabled();
    const needed = screen.getByRole('list', { name: 'Still needed' });
    expect(within(needed).getByText('Give the study a name.')).toBeInTheDocument();
    expect(within(needed).getByText('Choose at least one problem version.')).toBeInTheDocument();
    expect(
      within(needed).getByText('Choose at least one engine mode or run preset.')
    ).toBeInTheDocument();
  });

  it('counts the cells as the choices are made and meters nothing: a run consumes no allowance', async () => {
    renderBuilder();
    await chooseMatrix();

    const aside = screen.getByRole('complementary', { name: 'Matrix and plan' });
    expect(
      within(aside).getByText('2 problem versions × 2 engines × 1 setting × 2 seeds')
    ).toBeInTheDocument();
    expect(
      within(aside).queryByText(
        /used \+ up to|study runs this month|Study definitions of the sponsor/
      )
    ).not.toBeInTheDocument();
    expect(
      within(aside).getByText(/your plan lets one solve run for up to 60 s/)
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1-5' } });
    expect(
      within(aside).getByText('2 problem versions × 2 engines × 1 setting × 5 seeds')
    ).toBeInTheDocument();
  });

  it('creates the study with exactly the cases, engines, settings and seeds chosen', async () => {
    platform.create.mockResolvedValue(studyFixture());
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), {
      target: { value: 'Engines vs seeds' },
    });
    expect(screen.getByLabelText('Address')).toHaveValue('engines-vs-seeds');
    expect(create()).toBeEnabled();
    fireEvent.click(create());

    await waitFor(() => expect(platform.create).toHaveBeenCalledTimes(1));
    const { mode: randomMode, ...randomIdentity } = RANDOM_SEARCH;
    const { mode: evolutionaryMode, ...evolutionaryIdentity } = EVOLUTIONARY;
    expect(platform.create).toHaveBeenCalledWith('isa-demo', {
      slug: 'engines-vs-seeds',
      name: 'Engines vs seeds',
      description: '',
      definition: {
        revision_ids: [REVISION_1.id, REVISION_2.id],
        engines: [
          {
            ...randomIdentity,
            mode: randomMode,
            optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
          },
          {
            ...evolutionaryIdentity,
            mode: evolutionaryMode,
            optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
          },
        ],
        parameter_sets: [{}],
        seeds: [1, 2],
      },
    });
    const sent = platform.create.mock.calls[0][1] as {
      definition: { engines: Array<{ optimization?: unknown }> };
    };
    expect(sent.definition.engines.every(engine => engine.optimization !== undefined)).toBe(true);
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(addressNow()).toBe('/studies/isa-demo/engines-vs-seeds/setup');
  });

  it('turns a time budget into a setting of the definition and says when the plan reduces it', async () => {
    platform.create.mockResolvedValue(studyFixture());
    renderBuilder();
    fireEvent.click(await checkbox(/Checkout flow · version 2/));
    fireEvent.click(await checkbox(/random-search 1\.0\.0/));
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Budgets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a setting' }));
    fireEvent.change(screen.getAllByLabelText('Time budget (seconds)')[1], {
      target: { value: '120' },
    });

    expect(
      screen.getByText(/Your plan runs at most 60 s per solve, so this setting runs at 60 s/)
    ).toBeInTheDocument();
    expect(screen.getByText('time budget 120 s')).toBeInTheDocument();
    fireEvent.click(create());

    await waitFor(() => expect(platform.create).toHaveBeenCalledTimes(1));
    const sent = platform.create.mock.calls[0][1] as {
      definition: { parameter_sets: unknown[]; seeds: number[] };
    };
    expect(sent.definition.parameter_sets).toEqual([{}, { time_budget_ms: 120000 }]);
    expect(sent.definition.seeds).toEqual([1, 2]);
  });

  it('refuses repeated seeds and repeated settings before anything is sent', async () => {
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Dupes' } });
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1, 2, 2' } });

    expect(
      screen.getByText('Seed 2 appears twice. Each value can appear once.', { selector: 'small' })
    ).toBeInTheDocument();
    expect(create()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1, 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a setting' }));
    expect(
      screen.getByText(
        'Two settings are identical, so they would repeat the same cells. Change or remove one.'
      )
    ).toBeInTheDocument();
    expect(create()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove setting 2' }));
    expect(create()).toBeEnabled();
    expect(platform.create).not.toHaveBeenCalled();
  });

  it('refuses a matrix over 10,000 cells', async () => {
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Huge' } });
    fireEvent.change(screen.getByLabelText(SEEDS), { target: { value: '1-100' } });
    for (let n = 0; n < 25; n += 1)
      fireEvent.click(screen.getByRole('button', { name: 'Add a setting' }));

    const needed = screen.getByRole('list', { name: 'Still needed' });
    expect(
      within(needed).getByText(
        '10,400 cells is over the 10,000 limit. Remove an engine, a setting or some seeds.'
      )
    ).toBeInTheDocument();
    expect(create()).toBeDisabled();
  });

  it('says what the gateway refused: an allowance used up, a key without the engine, a taken address', async () => {
    renderBuilder();
    await chooseMatrix();
    fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Refused' } });

    platform.create.mockRejectedValueOnce(
      new QuotaError('quota_exceeded', 'full', {
        limit_id: 'maxRepositoryStorage',
        limit: 500,
        used: 500,
      })
    );
    fireEvent.click(create());
    expect(await screen.findByText('Out of storage (402 · quota_exceeded)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
    expect(create()).toBeEnabled();

    platform.create.mockRejectedValueOnce(
      refusal(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.')
    );
    fireEvent.click(create());
    expect(
      await screen.findByText(
        /This API key isn’t allowed to use one of the study’s engines \(403 · api_key_engine_forbidden\)/
      )
    ).toBeInTheDocument();

    platform.create.mockRejectedValueOnce(refusal(409, 'slug_conflict'));
    fireEvent.click(create());
    expect(
      await screen.findByText('That address is already used (409 · slug_conflict)')
    ).toBeInTheDocument();

    platform.create.mockRejectedValueOnce(
      refusal(422, 'engine_mode_incompatible', 'MiniZinc has no mode that supports this goal type.')
    );
    fireEvent.click(create());
    expect(
      await screen.findByText(/MiniZinc has no mode that supports this goal type\./)
    ).toBeInTheDocument();
  });

  describe('run presets', () => {
    const presetBox = async (name: RegExp) =>
      within(await screen.findByRole('group', { name: 'Run presets' })).findByRole('checkbox', {
        name,
      });

    it('lists the organization’s presets, and turns off with the reason those a study cannot take', async () => {
      renderBuilder();

      expect(await presetBox(/Fast sampling/)).toBeEnabled();
      expect(presets.list).toHaveBeenCalledWith('isa-demo', { limit: 200 });
      const federated = await presetBox(/Edge deployment/);
      expect(federated).toBeDisabled();
      expect(federated.closest('label')).toHaveTextContent(
        'Runs on a federated deployment: presets of federated engines can’t join a study yet.'
      );
      const noGoal = await presetBox(/No goal/);
      expect(noGoal).toBeDisabled();
      expect(noGoal.closest('label')).toHaveTextContent(
        'Names no optimization, which a study engine needs.'
      );
    });

    it('adds a {preset} engine row for each preset picked, counted in the matrix', async () => {
      platform.create.mockResolvedValue(studyFixture());
      renderBuilder();
      fireEvent.click(await checkbox(/Checkout flow · version 2/));
      fireEvent.click(await checkbox(/random-search 1\.0\.0/));
      fireEvent.click(await presetBox(/Fast sampling/));
      fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'With a preset' } });

      const aside = screen.getByRole('complementary', { name: 'Matrix and plan' });
      expect(
        within(aside).getByText('1 problem version × 2 engines × 1 setting × 2 seeds')
      ).toBeInTheDocument();
      fireEvent.click(create());

      await waitFor(() => expect(platform.create).toHaveBeenCalledTimes(1));
      const { mode: randomMode, ...randomIdentity } = RANDOM_SEARCH;
      const sent = platform.create.mock.calls[0][1] as { definition: { engines: unknown[] } };
      expect(sent.definition.engines).toEqual([
        {
          ...randomIdentity,
          mode: randomMode,
          optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
        },
        { preset: 'fast-sampling' },
      ]);
    });

    it('takes a study whose only engine is a preset', async () => {
      platform.create.mockResolvedValue(studyFixture());
      renderBuilder();
      fireEvent.click(await checkbox(/Checkout flow · version 2/));
      fireEvent.click(await presetBox(/Fast sampling/));
      fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Preset only' } });
      expect(create()).toBeEnabled();
      fireEvent.click(create());

      await waitFor(() => expect(platform.create).toHaveBeenCalledTimes(1));
      expect(
        (platform.create.mock.calls[0][1] as { definition: { engines: unknown[] } }).definition
          .engines
      ).toEqual([{ preset: 'fast-sampling' }]);
    });

    it('says how the gateway refused a preset: gone, federated, without an optimization, or the same as another engine', async () => {
      renderBuilder();
      fireEvent.click(await checkbox(/Checkout flow · version 2/));
      fireEvent.click(await presetBox(/Fast sampling/));
      fireEvent.change(screen.getByLabelText('Study name'), { target: { value: 'Refused' } });

      platform.create.mockRejectedValueOnce(
        refusal(422, 'preset_not_found', "This organization has no run preset 'fast-sampling'.")
      );
      fireEvent.click(create());
      expect(
        await screen.findByText(
          'A run preset of the study no longer exists (422 · preset_not_found)'
        )
      ).toBeInTheDocument();

      platform.create.mockRejectedValueOnce(
        refusal(422, 'preset_federated', 'Presets of federated engines cannot join a study yet.')
      );
      fireEvent.click(create());
      expect(
        await screen.findByText(
          'A run preset runs on a federated deployment (422 · preset_federated)'
        )
      ).toBeInTheDocument();

      platform.create.mockRejectedValueOnce(refusal(422, 'preset_incomplete'));
      fireEvent.click(create());
      expect(
        await screen.findByText('A run preset names no optimization (422 · preset_incomplete)')
      ).toBeInTheDocument();

      platform.create.mockRejectedValueOnce(refusal(422, 'duplicate_study_engines'));
      fireEvent.click(create());
      expect(
        await screen.findByText(
          'Two engines of the study are the same (422 · duplicate_study_engines)'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Once its presets are expanded, two engines name the same revision, mode, optimization and options/
        )
      ).toBeInTheDocument();
    });

    it('builds the study from the engines alone when the presets can’t be read', async () => {
      presets.list.mockRejectedValue(refusal(503, 'unavailable'));
      renderBuilder();

      expect(
        await screen.findByText('The organization’s run presets couldn’t be loaded.')
      ).toBeInTheDocument();
      expect(await checkbox(/random-search 1\.0\.0/)).toBeEnabled();
    });
  });

  it('starts from the revision another screen named', async () => {
    renderBuilder({ query: '&problem=checkout-flow&revision=1' });

    expect(await checkbox(/Checkout flow · version 1/)).toBeChecked();
    expect(await checkbox(/Checkout flow · version 2/)).not.toBeChecked();
  });

  it('starts from the engine another screen named', async () => {
    renderBuilder({ query: '&engine=bim.builtin/evolutionary' });

    expect(await checkbox(/evolutionary 1\.0\.0/)).toBeChecked();
    expect(await checkbox(/random-search 1\.0\.0/)).not.toBeChecked();
  });

  it('asks for an organization where the account may create studies, and offers no other', async () => {
    renderBuilder({ slug: 'read-lab' });

    expect(
      await screen.findByText(/Choose the organization the study belongs to/)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Study name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    expect(screen.queryByRole('option', { name: /Read Lab/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Team Lab/ })).toBeInTheDocument();
  });

  it('offers no way to reuse a shared definition: a study keeps its own', async () => {
    renderBuilder();

    await checkbox(/Checkout flow · version 1/);
    expect(
      screen.queryByRole('radio', { name: 'Reuse a shared definition' })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sealed version')).not.toBeInTheDocument();
  });
});

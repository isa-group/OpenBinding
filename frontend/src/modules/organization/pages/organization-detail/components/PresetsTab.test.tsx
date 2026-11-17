import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../core/api/http';
import { type EngineCatalogEntry, type EngineMode } from '../../../../engine/api/engineClient';
import { org } from '../../../../../test/fixtures/accounts';
import {
  FEDERATED_PRESET,
  NO_GOAL_PRESET,
  PRESET_ENGINE,
  presetFixture,
  presetPage,
} from '../../../../../test/fixtures/presets';
import { renderScreen } from '../../../../../test/screenKit';
import PresetsTab from './PresetsTab';

const presets = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const client = vi.hoisted(() => ({ getEngines: vi.fn() }));

vi.mock('../../../../run/api/presetsApi', async actual => ({
  ...(await actual<typeof import('../../../../run/api/presetsApi')>()),
  presetsApi: presets,
}));
vi.mock('../../../../engine/api/engineClient', async () => ({
  ...(await vi.importActual<typeof import('../../../../engine/api/engineClient')>(
    '../../../../engine/api/engineClient'
  )),
  engineClient: client,
}));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });

const mode = (id: string, scalarizations: string[]): EngineMode => ({
  id,
  profile: 'qos-binding/v1',
  ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  algorithm: id,
  capabilities: {
    scalarizations: {
      selector: 'only',
      values: scalarizations.map(value => ({ id: value, objectiveTypes: ['SINGLE', 'MULTI'] })),
    },
  } as unknown as EngineMode['capabilities'],
  optionsSchema: {
    type: 'object',
    properties: { time_budget_ms: { type: 'integer' }, iterations: { type: 'integer' } },
    additionalProperties: false,
  },
  limits: {},
  guarantees: { termination: ['FEASIBLE'], exact: false },
});

const engines: EngineCatalogEntry[] = [
  {
    ...PRESET_ENGINE,
    id: 'engine-1',
    ref: PRESET_ENGINE,
    modes: [mode('sampling', ['weighted-sum']), mode('exhaustive', [])],
  },
];

const refused = (status: number, code: string, message = 'refused') =>
  Object.assign(new HttpError(status, message), { code });

function renderPresets(slug = 'isa-demo') {
  const organization = [group, viewing].find(item => item.slug === slug) ?? group;
  return renderScreen(<PresetsTab organization={organization} />, {
    path: '/orgs/:org/presets',
    url: `/orgs/${slug}/presets`,
  });
}

const card = (name: string) => screen.findByRole('listitem', { name });

describe('the run presets of an organization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    presets.list.mockResolvedValue(presetPage());
    presets.create.mockImplementation(
      async (_org: string, body: { slug: string; name: string }) => ({
        value: presetFixture({ id: 'p-new', slug: body.slug, name: body.name }),
        etag: null,
      })
    );
    presets.update.mockImplementation(
      async (_org: string, slug: string, body: { name: string }) => ({
        value: presetFixture({ slug, name: body.name }),
        etag: null,
      })
    );
    presets.remove.mockResolvedValue(undefined);
    client.getEngines.mockResolvedValue(engines);
  });

  it('lists each preset with its engine, options, optimization and whether a study can take it', async () => {
    renderPresets();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Run presets' })
    ).toBeInTheDocument();
    expect(presets.list).toHaveBeenCalledWith('isa-demo', { limit: 200 });
    const fast = await card('Fast sampling');
    expect(within(fast).getByText('fast-sampling')).toBeInTheDocument();
    expect(within(fast).getByText('random-search 1.0.0 · mode sampling')).toBeInTheDocument();
    expect(within(fast).getByText('time budget 30 s · iterations 5,000')).toBeInTheDocument();
    expect(within(fast).getByText('SINGLE · weighted-sum')).toBeInTheDocument();
    expect(within(fast).getByText('Can be an engine of a study')).toBeInTheDocument();
    expect(within(fast).getByRole('link', { name: 'Start a run' })).toHaveAttribute(
      'href',
      '/runs/new?org=isa-demo&preset=fast-sampling'
    );

    const edge = await card('Edge deployment');
    expect(within(edge).getByText('edge-lab/edge-solver-eu 1')).toBeInTheDocument();
    expect(
      within(edge).getByText(
        'Runs on a federated deployment: presets of federated engines can’t join a study yet.'
      )
    ).toBeInTheDocument();
    expect(
      within(await card('No goal')).getByText('Names no optimization, which a study engine needs.')
    ).toBeInTheDocument();
    expect(
      within(await card('No goal')).getByText('Chosen for the problem when a run starts')
    ).toBeInTheDocument();
  });

  it('creates a preset from the engine catalogue, the mode, the options and the optimization', async () => {
    renderPresets();
    fireEvent.click(await screen.findByRole('button', { name: 'New preset' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run preset' });

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Long search' } });
    expect(within(dialog).getByLabelText('Address')).toHaveValue('long-search');
    fireEvent.change(within(dialog).getByLabelText('Engine'), {
      target: { value: `bim.builtin/random-search@1.0.0#${PRESET_ENGINE.digest}` },
    });
    fireEvent.change(within(dialog).getByLabelText('Mode'), { target: { value: 'sampling' } });
    expect(
      within(dialog).getByText(
        'This mode declares time_budget_ms, iterations. A time budget is in milliseconds.'
      )
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Options (JSON object, optional)'), {
      target: { value: '{"time_budget_ms": 120000}' },
    });
    fireEvent.change(within(dialog).getByLabelText('Optimization'), {
      target: { value: 'SINGLE' },
    });
    fireEvent.change(within(dialog).getByLabelText('Scalarization'), {
      target: { value: 'weighted-sum' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create preset' }));

    await waitFor(() =>
      expect(presets.create).toHaveBeenCalledWith('isa-demo', {
        name: 'Long search',
        description: '',
        slug: 'long-search',
        engine: PRESET_ENGINE,
        mode: 'sampling',
        options: { time_budget_ms: 120000 },
        optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
      })
    );
    expect(await screen.findByText('Created the run preset Long search.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(presets.list).toHaveBeenCalledTimes(2);
  });

  it('checks the shape before sending and says what the gateway refused', async () => {
    presets.create.mockRejectedValueOnce(refused(409, 'slug_conflict'));
    renderPresets();
    fireEvent.click(await screen.findByRole('button', { name: 'New preset' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run preset' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create preset' }));
    expect(within(dialog).getByText('Give the preset a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose the engine the preset runs.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Fast sampling' } });
    fireEvent.change(within(dialog).getByLabelText('Engine'), {
      target: { value: `bim.builtin/random-search@1.0.0#${PRESET_ENGINE.digest}` },
    });
    fireEvent.change(within(dialog).getByLabelText('Options (JSON object, optional)'), {
      target: { value: '[1, 2]' },
    });
    fireEvent.change(within(dialog).getByLabelText('Optimization'), { target: { value: 'MULTI' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create preset' }));
    expect(
      within(dialog).getByText('Options are a JSON object, like {"time_budget_ms": 30000}.')
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Name the scalarization, or leave the optimization to the run.')
    ).toBeInTheDocument();
    expect(presets.create).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Options (JSON object, optional)'), {
      target: { value: '' },
    });
    fireEvent.change(within(dialog).getByLabelText('Optimization'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create preset' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Another preset of this organization has that address (409 · slug_conflict). Change it. Nothing was saved.'
    );
    expect(presets.create).toHaveBeenCalledWith(
      'isa-demo',
      expect.objectContaining({
        slug: 'fast-sampling',
        mode: null,
        options: {},
        optimization: null,
      })
    );
  });

  it('edits a preset in place: the address stays and the settings are sent whole', async () => {
    renderPresets();
    fireEvent.click(
      within(await card('Fast sampling')).getByRole('button', { name: 'Edit Fast sampling' })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit Fast sampling' });

    expect(within(dialog).getByLabelText('Address')).toBeDisabled();
    expect(within(dialog).getByLabelText('Engine')).toHaveValue(
      `bim.builtin/random-search@1.0.0#${PRESET_ENGINE.digest}`
    );
    expect(within(dialog).getByLabelText('Mode')).toHaveValue('sampling');
    expect(within(dialog).getByLabelText('Scalarization')).toHaveValue('weighted-sum');
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Faster sampling' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(presets.update).toHaveBeenCalledWith('isa-demo', 'fast-sampling', {
        name: 'Faster sampling',
        description: 'Thirty seconds of random search.',
        engine: PRESET_ENGINE,
        mode: 'sampling',
        options: { time_budget_ms: 30000, iterations: 5000 },
        optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
      })
    );
    expect(
      await screen.findByText(
        'Saved the changes to Faster sampling. Runs already started keep the settings they copied.'
      )
    ).toBeInTheDocument();
  });

  it('keeps the deployment of a federated preset and names it in the form', async () => {
    renderPresets();
    fireEvent.click(
      within(await card('Edge deployment')).getByRole('button', { name: 'Edit Edge deployment' })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit Edge deployment' });

    expect(
      within(dialog).getByText(/Runs on the deployment edge-lab\/edge-solver-eu 1/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('option', { name: 'edge-solver 0.3.1 (as the preset names it)' })
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(presets.update).toHaveBeenCalledTimes(1));
    expect(presets.update.mock.calls[0][2]).not.toHaveProperty('registration');
    expect(presets.update.mock.calls[0][2]).toMatchObject({
      engine: FEDERATED_PRESET.engine,
      mode: 'placement',
    });
  });

  it('deletes a preset after asking, and says what happens to runs and studies', async () => {
    renderPresets();
    fireEvent.click(within(await card('No goal')).getByRole('button', { name: 'Delete No goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete No goal?' });

    expect(
      within(dialog).getByText(/Runs started from it keep the settings they copied\./)
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete preset' }));
    await waitFor(() =>
      expect(presets.remove).toHaveBeenCalledWith('isa-demo', NO_GOAL_PRESET.slug)
    );
    expect(await screen.findByText('Deleted the run preset No goal.')).toBeInTheDocument();
  });

  it('lets a viewer read the presets, with the options the gateway shows below MEMBER, and change nothing', async () => {
    presets.list.mockResolvedValue(presetPage([presetFixture({ options: { iterations: 5000 } })]));
    renderPresets('read-lab');

    const fast = await card('Fast sampling');
    expect(within(fast).getByText('iterations 5,000')).toBeInTheDocument();
    expect(
      screen.getByText(
        /you can read the presets, with only the options every member may see\. Creating and changing them needs MEMBER\./
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New preset' })).not.toBeInTheDocument();
    expect(within(fast).queryByRole('button', { name: /Edit|Delete/ })).not.toBeInTheDocument();
    expect(within(fast).queryByRole('link', { name: 'Start a run' })).not.toBeInTheDocument();
  });

  it('says when there is no preset yet, and when the list can’t be read', async () => {
    presets.list.mockResolvedValueOnce(presetPage([]));
    const { unmount } = renderPresets();
    expect(await screen.findByText('No run presets yet')).toBeInTheDocument();
    unmount();

    presets.list.mockRejectedValueOnce(refused(503, 'unavailable'));
    renderPresets();
    expect(await screen.findByText(/The run presets couldn’t be loaded \(503/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

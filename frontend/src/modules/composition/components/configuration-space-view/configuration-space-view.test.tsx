import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import { compositionViewModel, type Reader } from '../../../core/utils/composition/viewModel';
import { org } from '../../../../test/fixtures/accounts';
import type {
  CompositionVersionView,
  CompositionView,
  ProblemFacts,
} from '../../../core/api/types';
import { readCompositionFragment } from '../../../core/utils/sphere/composition-fragment';
import { EVALUATED, NEIGHBOURHOOD, fmsVersionView } from '../../../../test/fixtures/analysis';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import CompositionCardPage from '../../pages/card';
import { renderCompositionPage } from '../../../../test/compositionPage';
import ConfigurationSpaceView from '.';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  allVersions: vi.fn(),
  version: vi.fn(),
  content: vi.fn(),
  neighborhood: vi.fn(),
  evaluate: vi.fn(),
  derive: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: api, languageApi: {} }));

const factsApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../core/utils/problem/facts', () => ({ problemFactsApi: factsApi }));

const facts = fmsFacts as ProblemFacts;
const WAIT = { timeout: 3000 };
const BINDING = {
  T1: 'cand_t1_aws',
  T2: 'cand_t2_radius_iot_network',
  T3: 'cand_t3_distance_matrix_api',
  T5: 'cand_t5_amazon_braket',
  T6: 'cand_t6_paypal',
};

const composition: CompositionView = {
  id: 'composition-fleet',
  slug: 'fleet-routing',
  name: 'Fleet routing',
  description: '',
  kind: 'workflow',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  version_count: 3,
  latest_version: {
    id: 'v3',
    ordinal: 3,
    label: '1.2.0',
    values_status: 'verified',
    verified: true,
    created_at: '2026-10-01T00:00:00Z',
  },
};

const linked = (): CompositionVersionView => ({
  ...fmsVersionView(),
  id: 'v3',
  label: '1.2.0',
  ordinal: 3,
});
const declared = (): CompositionVersionView => ({
  ...linked(),
  problem: null,
  values_status: 'declared',
});

const DRAFT = {
  content: 'composition: fleet-routing\nversion: 1.3.0\n',
  document: {},
  values: {},
  diagnostics: [],
};

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search + where.hash}</output>;
}

const where = () => screen.getByTestId('where').textContent ?? '';

function renderDetail(url: string, role: 'MEMBER' | 'VIEWER' = 'MEMBER') {
  return renderCompositionPage(
    <>
      <CompositionCardPage />
      <Where />
    </>,
    {
      url,
      organizations: [org('isa-demo', { name: 'ISA Demo Group', effective_role: role })],
    }
  );
}

function renderTab(
  options: { reader?: Reader; canDerive?: boolean; version?: CompositionVersionView } = {}
) {
  const model = compositionViewModel({
    composition,
    version: options.version ?? linked(),
    facts,
    reader: options.reader ?? 'member',
  });
  const onNotLinked = vi.fn();
  render(
    <MemoryRouter initialEntries={['/compositions/isa-demo/fleet-routing/configuration']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ConfigurationSpaceView
                org="isa-demo"
                composition={composition}
                model={model}
                canDerive={options.canDerive ?? true}
                onNotLinked={onNotLinked}
              />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return { onNotLinked };
}

/** Focus the first configuration that moves `task`, from Quick Browse, and answer the focused card. */
const focusMove = async (task: string) => {
  const browse = await screen.findByRole('region', { name: 'Quick browse' });
  const row = within(browse)
    .getAllByRole('listitem')
    .find(item => item.textContent?.startsWith(`${task}:`)) as HTMLElement;
  fireEvent.click(within(row).getAllByRole('button')[0]);
  return screen.getByRole('group', { name: 'Current selection' });
};

describe('the Configuration tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ value: composition, etag: 'W/"3"' });
    api.allVersions.mockResolvedValue([linked()]);
    api.version.mockResolvedValue(linked());
    api.neighborhood.mockResolvedValue(NEIGHBOURHOOD);
    api.evaluate.mockResolvedValue(EVALUATED);
    api.list.mockResolvedValue({ compositions: [composition], total: 1, limit: 200, offset: 0 });
    api.derive.mockImplementation(
      async (_org: string, _slug: string, body: { seal: boolean; version: string }) =>
        body.seal
          ? { created: true, result: { version: { label: body.version } } }
          : { created: false, result: DRAFT }
    );
    factsApi.get.mockResolvedValue(facts);
  });

  it('shows for a version whose linked problem the member can read, with the explorer and the choice per task', async () => {
    renderDetail('/compositions/isa-demo/fleet-routing/configuration');

    expect(await screen.findByRole('link', { name: 'Configuration' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      await screen.findByRole('region', { name: 'Configuration explorer' })
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Compare' })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'cand_t1_aws for T1' })).toBeChecked();
    expect(screen.getByRole('region', { name: 'Choose per task' })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.neighborhood).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
        version: 'v3',
        limit: 64,
      })
    );
  });

  it('is not a tab of a declared version, and its address explains why there is nothing to explore', async () => {
    api.allVersions.mockResolvedValue([declared()]);
    api.version.mockResolvedValue(declared());
    const { unmount } = renderDetail('/compositions/isa-demo/fleet-routing');

    expect(await screen.findByRole('region', { name: 'Values' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Versions' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Configuration' })).toBeNull();
    unmount();

    renderDetail('/compositions/isa-demo/fleet-routing/configuration');
    expect(
      await screen.findByText(
        'Values are declared: the calculator and configurator need a linked problem you can read.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Configuration explorer' })).toBeNull();
    expect(api.neighborhood).not.toHaveBeenCalled();
  });

  it('goes when the gateway says the version links no problem after all', async () => {
    api.neighborhood.mockRejectedValue(
      Object.assign(new HttpError(422, 'not linked'), { code: 'composition_not_linked' })
    );
    renderDetail('/compositions/isa-demo/fleet-routing/configuration');

    expect(
      await screen.findByText(
        'Values are declared: the calculator and configurator need a linked problem you can read.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Choose per task' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    await waitFor(() => expect(where()).toBe('/compositions/isa-demo/fleet-routing'));
    expect(screen.queryByRole('link', { name: 'Configuration' })).toBeNull();
  });

  it('is never shown to a public reader', () => {
    renderTab({ reader: 'public' });

    expect(
      screen.getByText(
        'Values are declared: the calculator and configurator need a linked problem you can read.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Configuration explorer' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Choose per task' })).toBeNull();
    expect(api.neighborhood).not.toHaveBeenCalled();
  });

  it('opens the derive dialog on this composition, at its next minor, for a move of the explorer', async () => {
    renderTab();

    fireEvent.click(
      within(await focusMove('T1')).getByRole('button', { name: 'Derive as a version' })
    );
    const dialog = screen.getByRole('dialog', { name: 'Derive a composition' });
    expect(
      within(dialog).getByRole('list', { name: 'Steps' }).querySelector('[aria-current="step"]')
    ).toHaveTextContent('What');
    expect(dialog).toHaveTextContent('Into Fleet routing (fleet-routing).');
    expect(within(dialog).getByRole('region', { name: 'Binding to derive' })).toHaveTextContent(
      'cand_t1_google_cloud'
    );
    expect(within(dialog).getByLabelText('Version label')).toHaveValue('1.3.0');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(api.derive).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
        revision: 'fms@1',
        binding: { ...BINDING, T1: 'cand_t1_google_cloud' },
        version: '1.3.0',
        seal: false,
      })
    );
  });

  it('opens the derive dialog for the configurator’s binding, and opens a draft of it in the Editor', async () => {
    renderTab();

    fireEvent.click(screen.getByRole('radio', { name: 'cand_t6_stripe for T6' }));
    const result = screen.getByRole('region', { name: 'This binding' });
    fireEvent.click(within(result).getByRole('button', { name: 'Derive as a new version' }));
    const dialog = screen.getByRole('dialog', { name: 'Derive a composition' });
    expect(within(dialog).getByRole('region', { name: 'Binding to derive' })).toHaveTextContent(
      'cand_t6_stripe'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(result).getByRole('button', { name: 'Open as a draft' }));
    await waitFor(() =>
      expect(where()).toMatch(/^\/editor\?source=isa-demo%2Ffleet-routing#composition=/)
    );
    expect(api.derive).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
      revision: 'fms@1',
      binding: { ...BINDING, T6: 'cand_t6_stripe' },
      version: '1.3.0',
      seal: false,
    });
    expect(readCompositionFragment(where().slice(where().indexOf('#')))).toEqual({
      status: 'ok',
      yaml: DRAFT.content,
    });
  });

  it('tries a move of the explorer in the configurator', async () => {
    renderTab();

    fireEvent.click(
      within(await focusMove('T6')).getByRole('button', { name: 'Try in the configurator' })
    );
    expect(screen.getByRole('radio', { name: 'cand_t6_stripe for T6' })).toBeChecked();
    await waitFor(
      () =>
        expect(api.evaluate).toHaveBeenCalledWith(
          'isa-demo',
          'fleet-routing',
          { version: 'v3', binding: { T6: 'cand_t6_stripe' } },
          expect.any(AbortSignal)
        ),
      WAIT
    );
  });

  it('holds two configurations for comparison in the address, and compares them with the gateway', async () => {
    renderTab();

    fireEvent.click(
      within(await focusMove('T1')).getByRole('button', { name: 'Compare this one' })
    );
    fireEvent.click(within(await focusMove('T6')).getByRole('button', { name: 'Compare with A' }));
    await waitFor(() => expect(where()).toContain('cfgA=T1%3A'));
    expect(where()).toContain('cfgB=T6%3A');
    const compared = await screen.findByRole('region', { name: 'A compared with B' });
    expect(
      within(compared).getByRole('table', { name: 'Tasks bound differently' })
    ).toHaveTextContent('T1');
    await waitFor(() => expect(api.evaluate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Clear both' }));
    await waitFor(() => expect(where()).not.toContain('cfgA'));
  });

  it('lets a viewer explore without deriving', async () => {
    renderTab({ canDerive: false });

    const card = await focusMove('T1');
    expect(
      within(card).getByRole('button', { name: 'Try in the configurator' })
    ).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Derive as a version' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'cand_t6_stripe for T6' }));
    const result = screen.getByRole('region', { name: 'This binding' });
    expect(within(result).queryByRole('button', { name: 'Derive as a new version' })).toBeNull();
    expect(within(result).queryByRole('button', { name: 'Open as a draft' })).toBeNull();
  });
});

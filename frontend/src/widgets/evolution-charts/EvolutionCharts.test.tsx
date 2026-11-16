import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompositionVersionView } from '../../shared/api/types';
import { dateBounds, PREFERENCES_KEY } from './chartData';
import { EvolutionCharts } from './EvolutionCharts';

const api = vi.hoisted(() => ({ allVersions: vi.fn() }));
vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

// jsdom measures nothing, so the responsive container would draw a chart 0 px wide: give every chart a fixed size.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => (
      <div>{cloneElement(children, { width: 560, height: 200 } as never)}</div>
    ),
  };
});

const ANALYTICS = {
  tasks: 3,
  boundTasks: 2,
  localTasks: 1,
  providers: 2,
  upstreamPricings: 0,
  workflow: { depth: 1, and: 0, xor: 1, loop: 0 },
  hasOffering: false,
};

const link = (slug: string, revision: number, digest: string) => ({
  problem: { id: 'p-1', slug, name: slug },
  revision: { id: `r-${revision}`, revision },
  linked_compilation: {
    id: `c-${digest}`,
    compilation_digest: `cd-${digest}`,
    semantic_digest: `sd-${digest}`,
  },
});

const evaluation = (
  outcome: 'verified' | 'semantics_changed' | 'declared',
  digest: string | null
) => ({
  id: `e-${outcome}`,
  basis: digest ? ('bim' as const) : ('declared' as const),
  outcome,
  created_at: '2026-03-01T00:00:00Z',
  compilation: digest
    ? { compilation_digest: `cd-${digest}`, semantic_digest: `sd-${digest}`, toolchain: {} }
    : null,
});

function row(
  ordinal: number,
  day: number,
  over: Partial<CompositionVersionView> = {}
): CompositionVersionView {
  return {
    id: `v-${ordinal}`,
    label: `1.${ordinal}.0`,
    ordinal,
    created_at: `2026-03-${String(day).padStart(2, '0')}T12:00:00Z`,
    values: {},
    values_status: 'declared',
    current_evaluation: evaluation('declared', null),
    problem: null,
    analytics: ANALYTICS,
    ...over,
  } as unknown as CompositionVersionView;
}

const verifiedOn = (slug: string, revision: number, digest: string) =>
  ({
    values_status: 'verified' as const,
    current_evaluation: evaluation('verified', digest),
    problem: link(slug, revision, digest),
  }) as unknown as Partial<CompositionVersionView>;

/** Declared, then linked to shop@1, a new compilation, shop@2 (no longer verified there), and declared again; costs in EUR, then USD. */
const HISTORY = [
  row(1, 1, { values: { cost: { value: 10, unit: 'EUR' } } }),
  row(2, 2, { analytics: null, values: { cost: { value: 12, unit: 'EUR' } } }),
  row(3, 3, {
    ...verifiedOn('shop', 1, 'a'),
    values: { cost: { value: 11.5, unit: 'EUR' }, availability: { value: 0.99, unit: '1' } },
  }),
  row(4, 4, { ...verifiedOn('shop', 1, 'b'), values: { cost: { value: 11, unit: 'USD' } } }),
  row(5, 5, {
    ...verifiedOn('shop', 2, 'b'),
    current_evaluation: evaluation('semantics_changed', 'b'),
    values: { cost: { value: 11, unit: 'USD' } },
  } as Partial<CompositionVersionView>),
  row(6, 6, { values: { cost: { value: 9, unit: 'USD' } } }),
];

const figure = (name: string) => screen.getByRole('figure', { name });

async function renderCharts() {
  const view = render(<EvolutionCharts org="isa-demo" composition="fleet-routing" />);
  await screen.findByRole('heading', { name: 'Values' });
  return view;
}

describe('EvolutionCharts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    api.allVersions.mockResolvedValue(HISTORY);
  });

  afterEach(() => window.localStorage.clear());

  it('reads every version with its analytics, oldest first', async () => {
    await renderCharts();
    expect(api.allVersions).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
      include: ['analytics'],
      order: 'oldest',
    });
    expect(screen.getByText('6 versions, oldest first.')).toBeInTheDocument();
  });

  it('draws one chart per value and unit, and one per structure count', async () => {
    await renderCharts();
    expect(figure('cost · EUR')).toBeInTheDocument();
    expect(figure('cost · USD')).toBeInTheDocument();
    expect(figure('availability · number')).toBeInTheDocument();
    for (const title of [
      'Tasks',
      'Bound tasks',
      'Local tasks',
      'Providers',
      'Upstream pricings',
      'Workflow depth',
      'Parallel blocks',
      'Choice blocks',
      'Repeat blocks',
    ]) {
      expect(figure(title)).toBeInTheDocument();
    }
    // Five versions stored analytics: the stepped line has five points, not six and no zero for the one without.
    expect(figure('Tasks').querySelectorAll('.recharts-line-dot')).toHaveLength(5);
  });

  it('keeps verified, declared and unverified apart, each with its own mark, and names them in the legend', async () => {
    await renderCharts();
    const legend = screen.getByRole('group', { name: 'Value statuses shown' });
    expect(
      within(legend)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Verified', 'Declared', 'Unverified']);
    expect(
      screen.getByText(
        /Verified: solid line, filled dots\. Declared: dashed line, hollow squares\. Unverified: hollow circles, no line\./
      )
    ).toBeInTheDocument();

    const usd = figure('cost · USD');
    expect(usd.querySelectorAll('.ec-dot.is-verified')).toHaveLength(1);
    expect(usd.querySelectorAll('.ec-dot.is-unverified')).toHaveLength(1);
    expect(usd.querySelectorAll('.ec-dot.is-declared')).toHaveLength(1);
    const eur = figure('cost · EUR');
    expect(eur.querySelectorAll('.ec-dot.is-declared')).toHaveLength(2);
    expect(eur.querySelectorAll('.ec-dot.is-verified')).toHaveLength(1);

    fireEvent.click(within(legend).getByRole('button', { name: 'Declared' }));
    expect(within(legend).getByRole('button', { name: 'Declared' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(figure('cost · EUR').querySelectorAll('.ec-dot.is-declared')).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? '{}')).toEqual({
      axis: 'time',
      hidden: ['declared'],
    });
  });

  it('marks where the problem, its compilation or the link changed, on the charts and in words', async () => {
    await renderCharts();
    const marked = screen.getByRole('heading', { name: 'Marked on the charts' })
      .parentElement as HTMLElement;
    const items = within(marked)
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(items).toEqual([
      expect.stringContaining('Linked to shop@1 (“linked”)'),
      expect.stringContaining('Compilation changed (“compilation changed”)'),
      expect.stringContaining('Problem shop@1 to shop@2 (“problem r1 → r2”)'),
      expect.stringContaining('No longer linked to shop@2 (“unlinked”)'),
    ]);
    const lines = figure('cost · USD').querySelectorAll('.recharts-reference-line');
    expect(lines).toHaveLength(4);
    expect(
      [...figure('cost · USD').querySelectorAll('.recharts-reference-line text')].map(
        text => text.textContent
      )
    ).toEqual(['linked', 'compilation changed', 'problem r1 → r2', 'unlinked']);
  });

  it('shows a chart as a table, every version with its value in that unit and its status', async () => {
    await renderCharts();
    const usd = figure('cost · USD');
    fireEvent.click(within(usd).getByRole('button', { name: 'Show as table' }));
    const table = within(figure('cost · USD')).getByRole('table');
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map(item => [...item.querySelectorAll('th, td')].map(cell => cell.textContent));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(['1.1.0', 'Mar 1, 2026', 'No value in this unit', '—']);
    expect(rows[3]).toEqual(['1.4.0', 'Mar 4, 2026', '11 USD', 'Verified']);
    expect(rows[4]).toEqual(['1.5.0', 'Mar 5, 2026', '11 USD', 'Unverified']);
    expect(rows[5]).toEqual(['1.6.0', 'Mar 6, 2026', '9 USD', 'Declared']);
    expect(
      within(figure('cost · USD')).getByRole('button', { name: 'Show as chart' })
    ).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(figure('Tasks')).getByRole('button', { name: 'Show as table' }));
    const tasks = within(within(figure('Tasks')).getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map(item => item.querySelector('th')?.textContent);
    expect(tasks).toEqual(['1.1.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0']);
  });

  it('lists whether each version named an offering', async () => {
    await renderCharts();
    const offering = screen.getByRole('list', { name: 'Offering per version' });
    expect(within(offering).getAllByRole('listitem')).toHaveLength(5);
    expect(within(offering).getAllByRole('listitem')[0]).toHaveTextContent('1.1.0No offering');
  });

  it('switches the horizontal axis to the versions and keeps the choice', async () => {
    await renderCharts();
    fireEvent.click(screen.getByRole('button', { name: 'By version' }));
    expect(screen.getByRole('button', { name: 'By version' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      [
        ...figure('cost · USD').querySelectorAll(
          '.recharts-xAxis .recharts-cartesian-axis-tick-value'
        ),
      ].map(tick => tick.textContent)
    ).toEqual(['1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0']);
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? '{}')).toEqual({
      axis: 'version',
      hidden: [],
    });
  });

  it('asks the gateway for the versions sealed within the days chosen, and clears them', async () => {
    await renderCharts();
    api.allVersions.mockResolvedValue(HISTORY.slice(2, 4));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-03' } });
    await waitFor(() =>
      expect(api.allVersions).toHaveBeenLastCalledWith('isa-demo', 'fleet-routing', {
        include: ['analytics'],
        order: 'oldest',
        createdAfter: '2026-03-03T00:00:00Z',
      })
    );
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-04' } });
    await waitFor(() =>
      expect(api.allVersions).toHaveBeenLastCalledWith('isa-demo', 'fleet-routing', {
        include: ['analytics'],
        order: 'oldest',
        createdAfter: '2026-03-03T00:00:00Z',
        createdBefore: '2026-03-05T00:00:00Z',
      })
    );
    expect(
      await screen.findByText('2 versions in this date range, oldest first.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(api.allVersions).toHaveBeenLastCalledWith('isa-demo', 'fleet-routing', {
        include: ['analytics'],
        order: 'oldest',
      })
    );
    expect(screen.getByLabelText('From')).toHaveValue('');
  });

  it('says so when no version was sealed in the range, and asks nothing for an inverted one', async () => {
    await renderCharts();
    api.allVersions.mockResolvedValue([]);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-04-01' } });
    expect(await screen.findByText('No versions in this date range.')).toBeInTheDocument();

    const calls = api.allVersions.mock.calls.length;
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-01' } });
    expect(
      await screen.findByText(
        'The first day is after the last, so no version can be in that range.'
      )
    ).toBeInTheDocument();
    expect(api.allVersions).toHaveBeenCalledTimes(calls);
  });

  it('says there is no version yet, and offers a retry when the versions cannot be read', async () => {
    api.allVersions.mockResolvedValueOnce([]);
    render(<EvolutionCharts org="isa-demo" composition="fleet-routing" />);
    expect(
      await screen.findByText('No version yet. Seal the first one in the Editor.')
    ).toBeInTheDocument();

    api.allVersions.mockRejectedValueOnce(new Error('offline'));
    render(<EvolutionCharts org="isa-demo" composition="order-desk" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The versions couldn’t be read');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByRole('heading', { name: 'Values' })).toHaveLength(1);
  });
});

describe('dateBounds', () => {
  it('turns the days into the gateway’s bounds: from the start of the first, before the start of the day after the last (UTC)', () => {
    expect(dateBounds('', '')).toEqual({});
    expect(dateBounds('2026-02-28', '2026-02-28')).toEqual({
      createdAfter: '2026-02-28T00:00:00Z',
      createdBefore: '2026-03-01T00:00:00Z',
    });
    expect(dateBounds('', '2026-12-31')).toEqual({ createdBefore: '2027-01-01T00:00:00Z' });
  });
});

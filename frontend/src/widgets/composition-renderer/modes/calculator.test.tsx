import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../api/client';
import { compositionViewModel, type Reader } from '../../../entities/composition/viewModel';
import type { ProblemFacts } from '../../../modules/core/api/types';
import { FMS_COMPOSITION, NEIGHBOURHOOD, fmsVersionView } from '../../../test/fixtures/analysis';
import fmsFacts from '../../../test/fixtures/core/fms.facts.json';
import { CompositionRenderer } from '../CompositionRenderer';
import type { AnalysisActions } from './analysis';
import { moveRows, rowChoices, signed, visibleRows, NO_FILTER } from './calculatorModel';

const api = vi.hoisted(() => ({ neighborhood: vi.fn() }));
vi.mock('../../../entities/composition/api', () => ({ compositionsApi: api }));

const version = fmsVersionView();
const BINDING = {
  T1: 'cand_t1_aws',
  T2: 'cand_t2_radius_iot_network',
  T3: 'cand_t3_distance_matrix_api',
  T5: 'cand_t5_amazon_braket',
  T6: 'cand_t6_paypal',
};

const modelOf = (reader: Reader = 'member') =>
  compositionViewModel({
    composition: FMS_COMPOSITION,
    version,
    facts: fmsFacts as ProblemFacts,
    reader,
  });

function renderCalculator(actions: AnalysisActions = {}) {
  return render(<CompositionRenderer model={modelOf()} mode="calculator" analysis={actions} />);
}

const section = () => screen.getByRole('region', { name: 'One change at a time' });
const table = () => within(section()).getByRole('table');
const bodyRows = () => within(table()).getAllByRole('row').slice(1);

describe('the calculator mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.neighborhood.mockResolvedValue(NEIGHBOURHOOD);
  });

  it('asks the gateway for the moves of the shown version and lists them by task, with its words and deltas as returned', async () => {
    renderCalculator();

    expect(await within(section()).findByText(NEIGHBOURHOOD.conclusion)).toBeInTheDocument();
    expect(api.neighborhood).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
      version: version.id,
      limit: 64,
    });
    expect(bodyRows().map(row => within(row).getByRole('rowheader').textContent)).toEqual([
      'T1',
      'T2',
      'T6',
    ]);
    const [t1, t2, t6] = bodyRows();
    expect(t1).toHaveTextContent('cand_t1_aws');
    expect(t1).toHaveTextContent('cand_t1_google_cloud');
    expect(t1).toHaveTextContent('google');
    expect(within(t1).getByText('Better')).toBeInTheDocument();
    const deltas = within(t1).getByRole('list', { name: 'Changes in the objectives' });
    expect(deltas).toHaveTextContent('cost −20 USD/month loss −0.015');
    expect(deltas).toHaveTextContent('execution_time +10 ms loss +0.001');
    expect(deltas).toHaveTextContent('penalty 0');
    expect(within(t6).getByText('Trade-off')).toBeInTheDocument();
    expect(within(t2).getByText('Not feasible')).toBeInTheDocument();
    expect(t2).toHaveTextContent('Breaks a hard rule');
    expect(within(t2).getByRole('list', { name: 'Rules broken' })).toHaveTextContent(
      'Keep the data in the EU'
    );
    expect(within(t2).getByRole('list', { name: 'Changes in the objectives' })).toHaveTextContent(
      'penalty +5'
    );
    expect(section()).toHaveTextContent(
      'Evaluated 3 of 5 moves (up to 64) on the installed toolchain. Coverage is incomplete'
    );
  });

  it('narrows the moves by candidate or provider, task and comparison word', async () => {
    renderCalculator();
    await within(section()).findByRole('table');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search candidates and providers' }), {
      target: { value: 'STRIPE' },
    });
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('cand_t6_stripe');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search candidates and providers' }), {
      target: { value: 'samsara' },
    });
    expect(bodyRows()[0]).toHaveTextContent('T2');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search candidates and providers' }), {
      target: { value: '' },
    });
    const task = screen.getByRole('combobox', { name: 'Task' });
    expect(
      within(task)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['All tasks', 'T1', 'T2', 'T6']);
    fireEvent.change(task, { target: { value: 'T6' } });
    expect(bodyRows()).toHaveLength(1);

    fireEvent.change(task, { target: { value: '' } });
    const comparison = screen.getByRole('combobox', { name: 'Comparison' });
    expect(
      within(comparison)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Any comparison', 'Better', 'Not feasible', 'Trade-off']);
    fireEvent.change(comparison, { target: { value: 'trade-off' } });
    expect(bodyRows().map(row => within(row).getByRole('rowheader').textContent)).toEqual(['T6']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search candidates and providers' }), {
      target: { value: 'nothing like it' },
    });
    expect(within(section()).getByText(/No move matches/)).toBeInTheDocument();
  });

  it('walks the moves one by one with Previous and Next, marking the focused row', async () => {
    renderCalculator();
    await within(section()).findByRole('table');

    const previous = within(section()).getByRole('button', { name: 'Previous' });
    const next = within(section()).getByRole('button', { name: 'Next' });
    expect(within(section()).getByText(/^Move 1 of 3/)).toBeInTheDocument();
    expect(bodyRows()[0]).toHaveAttribute('aria-current', 'true');
    expect(previous).toBeDisabled();

    fireEvent.click(next);
    expect(within(section()).getByText(/^Move 2 of 3/)).toHaveTextContent(
      'T2 cand_t2_radius_iot_network → cand_t2_samsara_fleet_api'
    );
    expect(bodyRows()[1]).toHaveAttribute('aria-current', 'true');
    expect(bodyRows()[0]).not.toHaveAttribute('aria-current');
    fireEvent.click(next);
    expect(next).toBeDisabled();
    fireEvent.click(previous);
    expect(bodyRows()[1]).toHaveAttribute('aria-current', 'true');
  });

  it('tries a move in the configurator with the whole binding as the document writes it', async () => {
    const onTry = vi.fn();
    renderCalculator({ onTry });
    await within(section()).findByRole('table');

    fireEvent.click(within(bodyRows()[2]).getByRole('button', { name: 'Try in configurator' }));
    expect(onTry).toHaveBeenCalledWith({ ...BINDING, T6: 'cand_t6_stripe' });
    expect(bodyRows()[2]).toHaveAttribute('aria-current', 'true');
    expect(within(section()).queryByRole('button', { name: 'Derive composition' })).toBeNull();
  });

  it('derives a move: the problem version and the binding with the move applied, in written names', async () => {
    const onDerive = vi.fn();
    renderCalculator({ onDerive });
    await within(section()).findByRole('table');

    fireEvent.click(within(bodyRows()[0]).getByRole('button', { name: 'Derive composition' }));
    expect(onDerive).toHaveBeenCalledWith({
      revision: 'fms@1',
      binding: { ...BINDING, T1: 'cand_t1_google_cloud' },
    });
  });

  it('says why the moves could not be evaluated, and asks again on Retry', async () => {
    api.neighborhood.mockRejectedValueOnce(
      Object.assign(new HttpError(429, 'busy'), { code: 'composition_busy' })
    );
    renderCalculator();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The toolchain is busy (429 · composition_busy).'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await within(section()).findByRole('table')).toBeInTheDocument();
    expect(api.neighborhood).toHaveBeenCalledTimes(2);
  });

  it('tells the page when the gateway says the version links no problem', async () => {
    api.neighborhood.mockRejectedValueOnce(
      Object.assign(new HttpError(422, 'not linked'), { code: 'composition_not_linked' })
    );
    const onNotLinked = vi.fn();
    renderCalculator({ onNotLinked });

    await waitFor(() => expect(onNotLinked).toHaveBeenCalledTimes(1));
    expect(section()).toHaveTextContent(
      'Values are declared: the calculator and configurator need a linked problem you can read.'
    );
  });

  it('is not drawn for a reader who may not read the linked problem', () => {
    render(<CompositionRenderer model={modelOf('public')} mode="calculator" />);
    expect(screen.queryByRole('region', { name: 'One change at a time' })).toBeNull();
    expect(api.neighborhood).not.toHaveBeenCalled();
  });
});

describe('the calculator model', () => {
  const model = modelOf();
  const rows = moveRows(NEIGHBOURHOOD.moves, model);

  it('places the gateway’s fields only: the current candidate, the written name, the provider, the deltas with units', () => {
    expect(rows[1]).toMatchObject({
      index: 1,
      task: 'T1',
      from: 'cand_t1_aws',
      to: 'cand_t1_google_cloud',
      provider: 'google',
      comparison: 'better',
      feasible: true,
      penaltyDelta: 0,
    });
    expect(rows[1].deltas[0]).toEqual({
      feature: 'cost',
      value: -20,
      loss: -0.015,
      unit: 'USD/month',
    });
  });

  it('orders by task and then by the gateway’s order, and lists each choice once', () => {
    expect(visibleRows(rows, NO_FILTER).map(row => row.index)).toEqual([1, 2, 0]);
    expect(rowChoices(rows)).toEqual({
      tasks: ['T1', 'T2', 'T6'],
      comparisons: ['better', 'infeasible', 'trade-off'],
    });
  });

  it('writes a delta with its sign, never computing one', () => {
    expect([signed(15), signed(-0.5), signed(0)]).toEqual(['+15', '−0.5', '0']);
  });
});

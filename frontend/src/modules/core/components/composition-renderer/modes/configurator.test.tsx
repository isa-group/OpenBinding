import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../api/http';
import { candidateMatrix } from '../../../utils/binding/candidateMatrix';
import { compositionViewModel } from '../../../utils/composition/viewModel';
import type { CompositionVersionView, ProblemFacts } from '../../../api/types';
import { EVALUATED, FMS_COMPOSITION, fmsVersionView } from '../../../../../test/fixtures/analysis';
import fmsFacts from '../../../../../test/fixtures/core/fms.facts.json';
import { CompositionRenderer } from '../CompositionRenderer';
import type { AnalysisActions } from './analysis';
import { findingTask } from './analysis';
import { changedBinding, selectedMatrix, sideBySide, startSelection } from './configuratorModel';

const api = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock('../../../utils/composition/api', () => ({ compositionsApi: api }));

const facts = fmsFacts as ProblemFacts;
const BINDING = {
  T1: 'cand_t1_aws',
  T2: 'cand_t2_radius_iot_network',
  T3: 'cand_t3_distance_matrix_api',
  T5: 'cand_t5_amazon_braket',
  T6: 'cand_t6_paypal',
};
const WAIT = { timeout: 3000 };

function renderConfigurator(
  actions: AnalysisActions = {},
  version: CompositionVersionView = fmsVersionView()
) {
  const model = compositionViewModel({
    composition: FMS_COMPOSITION,
    version,
    facts,
    reader: 'member',
  });
  return render(<CompositionRenderer model={model} mode="configurator" analysis={actions} />);
}

const result = () => screen.getByRole('region', { name: 'This binding' });
const choose = (candidate: string, task: string) =>
  fireEvent.click(screen.getByRole('radio', { name: `${candidate} for ${task}` }));
const refused = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new HttpError(status, 'refused'), { code, ...extra });

describe('the configurator mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.evaluate.mockResolvedValue(EVALUATED);
  });

  it('starts from the version’s binding and evaluates nothing until a task is bound otherwise', () => {
    renderConfigurator();

    expect(screen.getByRole('radio', { name: 'cand_t1_aws for T1' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'cand_t6_paypal for T6' })).toBeChecked();
    expect(result()).toHaveTextContent('This is the version’s binding.');
    expect(api.evaluate).not.toHaveBeenCalled();
  });

  it('evaluates a choice by its written name, after a pause, and shows its values beside the version’s, never subtracted', async () => {
    renderConfigurator();

    choose('cand_t1_google_cloud', 'T1');
    expect(within(result()).getByRole('status')).toHaveTextContent(
      'The toolchain is evaluating this binding…'
    );
    await waitFor(() => expect(api.evaluate).toHaveBeenCalledTimes(1), WAIT);
    const [org, slug, body, signal] = api.evaluate.mock.calls[0];
    expect([org, slug, body]).toEqual([
      'isa-demo',
      'fleet-routing',
      { version: fmsVersionView().id, binding: { T1: 'cand_t1_google_cloud' } },
    ]);
    expect(signal).toBeInstanceOf(AbortSignal);

    expect(
      await within(result()).findByText('Valid: the toolchain reports no broken hard rule.')
    ).toBeInTheDocument();
    const values = within(result()).getByRole('table');
    const cost = within(values).getByRole('row', { name: /^cost/ });
    expect(
      within(cost)
        .getAllByRole('cell')
        .map(cell => cell.textContent)
    ).toEqual(['3,060 USD/month', '3,080 USD/month']);
    expect(
      within(values)
        .getAllByRole('columnheader')
        .map(header => header.textContent)
    ).toEqual(['Value', 'Version 1.0.0 Verified', 'This binding Verified']);
    expect(values).not.toHaveTextContent(/[+−]\s?20|\b20 USD/);
    expect(within(result()).queryByText('Not comparable')).toBeNull();
  });

  it('evaluates only the latest of several quick changes', async () => {
    renderConfigurator();

    choose('cand_t1_google_cloud', 'T1');
    choose('cand_t6_stripe', 'T6');
    await waitFor(() => expect(api.evaluate).toHaveBeenCalledTimes(1), WAIT);
    expect(api.evaluate.mock.calls[0][2]).toEqual({
      version: fmsVersionView().id,
      binding: { T1: 'cand_t1_google_cloud', T6: 'cand_t6_stripe' },
    });
  });

  it('places the gateway’s findings at the tasks of the request they point at', async () => {
    api.evaluate.mockRejectedValue(
      refused(422, 'evaluation_invalid', {
        diagnostics: [
          {
            code: 'c2y_candidate_unknown',
            message: 'the problem has no candidate cand_t1_google_cloud for T1',
            pointer: '/binding/T1',
          },
        ],
      })
    );
    renderConfigurator();

    choose('cand_t1_google_cloud', 'T1');
    const alert = await within(result()).findByRole('alert', {}, WAIT);
    expect(alert).toHaveTextContent(
      'This binding couldn’t be evaluated (422 · evaluation_invalid)'
    );
    expect(within(alert).getByRole('list', { name: 'What the gateway found' })).toHaveTextContent(
      'Task T1: the problem has no candidate cand_t1_google_cloud for T1 c2y_candidate_unknown'
    );
    const t1 = screen.getByRole('region', { name: 'Candidates for T1' });
    expect(within(t1).getByRole('row', { name: /^cand_t1_google_cloud/ })).toHaveTextContent(
      'See the finding'
    );
  });

  it('says when the composition has no version to evaluate', async () => {
    api.evaluate.mockRejectedValue(refused(409, 'composition_empty'));
    renderConfigurator();

    choose('cand_t1_google_cloud', 'T1');
    expect(await within(result()).findByRole('alert', {}, WAIT)).toHaveTextContent(
      'This composition has no version to evaluate yet (409 · composition_empty).'
    );
  });

  it('tells the page when the version links no problem after all', async () => {
    api.evaluate.mockRejectedValue(refused(422, 'composition_not_linked'));
    const onNotLinked = vi.fn();
    renderConfigurator({ onNotLinked });

    choose('cand_t1_google_cloud', 'T1');
    await waitFor(() => expect(onNotLinked).toHaveBeenCalledTimes(1), WAIT);
    expect(result()).toHaveTextContent(
      'Values are declared: the calculator and configurator need a linked problem you can read.'
    );
  });

  it('says the values are not comparable when the version’s own are not verified', async () => {
    const version = fmsVersionView();
    const changed: CompositionVersionView = {
      ...version,
      current_evaluation: version.current_evaluation && {
        ...version.current_evaluation,
        outcome: 'semantics_changed',
      },
      evaluations: version.evaluations.map(item => ({
        ...item,
        outcome: 'semantics_changed' as const,
      })),
    };
    renderConfigurator({}, changed);

    choose('cand_t1_google_cloud', 'T1');
    expect(await within(result()).findByText('Not comparable', {}, WAIT)).toBeInTheDocument();
    expect(within(result()).getAllByRole('columnheader')[1]).toHaveTextContent('Unverified');
  });

  it('derives the chosen binding or opens it as a draft, with every task in written names', async () => {
    const onDerive = vi.fn();
    const onOpenDraft = vi.fn();
    renderConfigurator({ onDerive, onOpenDraft });

    expect(within(result()).queryByRole('button', { name: 'Derive as a new version' })).toBeNull();
    choose('cand_t1_google_cloud', 'T1');
    fireEvent.click(within(result()).getByRole('button', { name: 'Derive as a new version' }));
    expect(onDerive).toHaveBeenCalledWith({
      revision: 'fms@1',
      binding: { ...BINDING, T1: 'cand_t1_google_cloud' },
    });
    fireEvent.click(within(result()).getByRole('button', { name: 'Open as a draft' }));
    expect(onOpenDraft).toHaveBeenCalledWith({
      revision: 'fms@1',
      binding: { ...BINDING, T1: 'cand_t1_google_cloud' },
    });

    fireEvent.click(
      within(result()).getByRole('button', { name: 'Back to the version’s binding' })
    );
    expect(screen.getByRole('radio', { name: 'cand_t1_aws for T1' })).toBeChecked();
    expect(within(result()).queryByRole('button', { name: 'Derive as a new version' })).toBeNull();
  });

  it('starts from a binding the calculator handed over, and evaluates it', async () => {
    renderConfigurator({ start: { ...BINDING, T6: 'cand_t6_stripe' } });

    expect(screen.getByRole('radio', { name: 'cand_t6_stripe for T6' })).toBeChecked();
    await waitFor(() => expect(api.evaluate).toHaveBeenCalledTimes(1), WAIT);
    expect(api.evaluate.mock.calls[0][2]).toEqual({
      version: fmsVersionView().id,
      binding: { T6: 'cand_t6_stripe' },
    });
  });
});

describe('the configurator model', () => {
  const matrix = candidateMatrix(facts);
  const base = fmsVersionView().evaluations[0].binding as Record<string, string>;

  it('maps written names to candidate keys, and back for the tasks that changed', () => {
    const selection = startSelection(matrix, base, {
      T1: 'cand_t1_google_cloud',
      T9: 'nothing',
      T2: 'unknown',
    });
    expect(selection).toEqual({ ...base, T1: 'catalog/cand_t1_google_cloud' });
    expect(changedBinding(matrix, base, selection)).toEqual({ T1: 'cand_t1_google_cloud' });
    expect(changedBinding(matrix, base, base)).toEqual({});
    const marked = selectedMatrix(matrix, selection).rows.find(row => row.task === 'T1');
    expect(marked?.candidates.map(candidate => candidate.selected)).toEqual([false, true]);
  });

  it('puts values side by side by name, the version’s first, without arithmetic', () => {
    expect(
      sideBySide([{ name: 'cost', value: 3, unit: 'EUR' }], {
        latency: { value: 4, unit: 'ms' },
        cost: { value: 5, unit: 'USD' },
      })
    ).toEqual([
      { name: 'cost', version: { value: 3, unit: 'EUR' }, evaluated: { value: 5, unit: 'USD' } },
      { name: 'latency', version: null, evaluated: { value: 4, unit: 'ms' } },
    ]);
  });

  it('reads the task of a finding only from a pointer into the request’s binding', () => {
    expect(findingTask('/binding/T1')).toBe('T1');
    expect(findingTask('/binding/a~1b~0c/candidate')).toBe('a/b~c');
    expect(findingTask('/values/cost')).toBeNull();
    expect(findingTask(undefined)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { CaseContent } from '../Project/projectModel';
import { CHECKOUT, REVISION_1, REVISION_2, cellsFixture, studyFixture, revisionFixture } from '../../test/fixtures/studies';
import {
  MAX_SEEDS, collectionMembers, defaultSelection, definitionGrid, definitionSize, describeParameters, emptyVariant, engineChoices, enginesOf, explainFailure,
  formatMeasure, formatSeconds, formulaOf, heatLevel, matrixView, measureValue, measuresOf, metricsOf, parametersKey, readSeeds, readVariant, revisionIndex,
  revisionLabel, rivalsOf, seedsOf, solverEstimate, studyContentSize, breakdownText, slot,
} from './studiesModel';

const cases: CaseContent[] = [{ item: CHECKOUT, revisions: [REVISION_1, REVISION_2, revisionFixture(3, { source_snapshot_id: null })] }];

describe('the matrix of a study', () => {
  it('multiplies cases, engines, settings and seeds, and says so in words', () => {
    const size = definitionSize(studyFixture().definition);
    expect(size).toEqual({ cases: 2, engines: 2, settings: 1, seeds: 2, cells: 8 });
    expect(formulaOf(size)).toBe('2 case revisions × 2 engines × 1 setting × 2 seeds');
  });

  it('lays the definition out in the order the gateway expands it', () => {
    const grid = definitionGrid(studyFixture().definition);
    expect(grid.rows).toEqual([REVISION_1.id, REVISION_2.id]);
    expect(grid.columns.map((column) => column.label)).toEqual([
      'evolutionary (genetic) · seed 1', 'evolutionary (genetic) · seed 2', 'random-search (sampling) · seed 1', 'random-search (sampling) · seed 2',
    ]);
    expect(grid.numbered).toBe(true);
    expect(definitionGrid({ ...studyFixture().definition, parameter_sets: [{}, { time_budget_ms: 5000 }] }).numbered).toBe(false);
  });
});

describe('seeds', () => {
  it('reads numbers, lists and ranges', () => {
    expect(readSeeds('1, 2').seeds).toEqual([1, 2]);
    expect(readSeeds('1 2,5-7').seeds).toEqual([1, 2, 5, 6, 7]);
    expect(readSeeds('0').error).toBeUndefined();
  });

  it('refuses what the gateway would: repeats, non-numbers, backwards ranges and more than 100', () => {
    expect(readSeeds('').error).toBe('Give at least one seed.');
    expect(readSeeds('1, 2, 2').error).toBe('Seed 2 appears twice. Each value can appear once.');
    expect(readSeeds('1, x').error).toMatch(/“x” isn’t a whole number/);
    expect(readSeeds('1.5').error).toMatch(/isn’t a whole number/);
    expect(readSeeds('5-3').error).toMatch(/runs backwards/);
    expect(readSeeds(`1-${MAX_SEEDS + 1}`).error).toBe(`A study takes at most ${MAX_SEEDS} seeds.`);
    expect(readSeeds(`1-${MAX_SEEDS}`).seeds).toHaveLength(MAX_SEEDS);
  });
});

describe('settings', () => {
  it('turns what is typed into the parameter set an engine takes', () => {
    expect(readVariant(emptyVariant('a'))).toEqual({ parameters: {} });
    expect(readVariant({ ...emptyVariant('a'), seconds: '30', iterations: '1,000' }).parameters).toEqual({ time_budget_ms: 30000, iterations: 1000 });
    expect(readVariant({ ...emptyVariant('a'), extra: '{"population_size": 40}', seconds: '2.5' }).parameters).toEqual({ population_size: 40, time_budget_ms: 2500 });
  });

  it('says what is wrong with a setting', () => {
    expect(readVariant({ ...emptyVariant('a'), seconds: '0' }).error).toMatch(/seconds above zero/);
    expect(readVariant({ ...emptyVariant('a'), iterations: '2.5' }).error).toMatch(/whole number/);
    expect(readVariant({ ...emptyVariant('a'), extra: '[1]' }).error).toMatch(/JSON object/);
    expect(readVariant({ ...emptyVariant('a'), extra: '{' }).error).toMatch(/aren’t valid JSON/);
  });

  it('tells equal parameter sets apart from different ones whatever the key order', () => {
    expect(parametersKey({ a: 1, b: { c: 2, d: 3 } })).toBe(parametersKey({ b: { d: 3, c: 2 }, a: 1 }));
    expect(parametersKey({ a: 1 })).not.toBe(parametersKey({ a: 2 }));
    expect(parametersKey(undefined)).toBe('{}');
  });

  it('describes parameters for people', () => {
    expect(describeParameters({})).toBe('Engine defaults');
    expect(describeParameters({ time_budget_ms: 30000, population_size: 40 })).toBe('time budget 30 s · population size 40');
  });
});

describe('the solver time a matrix may use', () => {
  const engines = [
    { key: 'a', ref: { namespace: 'n', name: 'a', version: '1', digest: 'd' }, mode: 'm', title: 'a 1', defaultSeconds: 30, federated: false },
    { key: 'b', ref: { namespace: 'n', name: 'b', version: '1', digest: 'd' }, mode: 'm', title: 'b 1', defaultSeconds: null, federated: false },
  ];

  it('sums each cell’s budget, reduced to the plan’s ceiling', () => {
    expect(solverEstimate({ cases: 2, seeds: 2, engines: [engines[0]], settings: [{}], ceiling: 20 })).toEqual({ seconds: 80, complete: true });
    expect(solverEstimate({ cases: 1, seeds: 3, engines: [engines[0]], settings: [{ time_budget_ms: 5000 }, {}], ceiling: null })).toEqual({ seconds: 5 * 3 + 30 * 3, complete: true });
  });

  it('falls back to the ceiling for an engine with no default, and admits when it knows nothing', () => {
    expect(solverEstimate({ cases: 1, seeds: 1, engines: [engines[1]], settings: [{}], ceiling: 60 })).toEqual({ seconds: 60, complete: true });
    expect(solverEstimate({ cases: 1, seeds: 1, engines: [engines[1]], settings: [{}], ceiling: null })).toEqual({ seconds: 0, complete: false });
  });

  it('reads the budget of a mode from its options schema', () => {
    const choices = engineChoices([{
      id: 'e1', namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-x', ref: { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-x' },
      modes: [{ id: 'sampling', optionsSchema: { type: 'object', properties: { time_budget_ms: { type: 'integer', default: 30000 } }, additionalProperties: false } } as never],
    }]);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ mode: 'sampling', title: 'random-search 1.0.0', defaultSeconds: 30, federated: false });
    expect(choices[0].key).toBe('bim.builtin/random-search@1.0.0#sha256-x#sampling');
  });
});

describe('case revisions', () => {
  it('names the revisions of the project and falls back to the start of an id', () => {
    const index = revisionIndex(cases);
    expect(revisionLabel(index, REVISION_2.id)).toBe('Checkout flow · revision 2');
    expect(revisionLabel(index, REVISION_2.id, true)).toBe('Checkout flow r2');
    expect(revisionLabel(index, 'abcdef0123456789')).toBe('Revision abcdef01…');
  });

  it('starts the builder from the case, revision or collection another screen named', () => {
    expect(defaultSelection({ cases, caseSlug: 'checkout-flow', revision: '1', collectionIds: [] })).toEqual([REVISION_1.id]);
    expect(defaultSelection({ cases, caseSlug: 'checkout-flow', revision: null, collectionIds: [] })).toEqual([REVISION_2.id]);
    expect(defaultSelection({ cases, caseSlug: 'checkout-flow', revision: '3', collectionIds: [] })).toEqual([]);
    expect(defaultSelection({ cases, caseSlug: null, revision: null, collectionIds: [REVISION_1.id, 'elsewhere'] })).toEqual([REVISION_1.id]);
    expect(defaultSelection({ cases, caseSlug: 'ghost', revision: null, collectionIds: [] })).toEqual([]);
  });

  it('reads what a sealed collection and a sealed study say about their size', () => {
    expect(collectionMembers(JSON.stringify({ members: [{ caseRevisionId: 'a' }, { resource: 'x' }, { caseRevisionId: 'b' }] }))).toEqual(['a', 'b']);
    expect(collectionMembers('not json')).toBeNull();
    expect(studyContentSize(JSON.stringify({ cases: [1, 2], engines: [1], parameter_sets: [{}, {}], seeds: [1, 2, 3] }))).toMatchObject({ cells: 12 });
    expect(studyContentSize('{}')).toBeNull();
  });
});

describe('the cells of a run', () => {
  const cells = cellsFixture();

  it('reads the metrics the gateway records and tolerates the ones it does not', () => {
    expect(metricsOf(cells[2])).toMatchObject({ feasible: true, objectives: { cost: 0.121, latency: 430 }, runtimeSeconds: 58 });
    expect(metricsOf({ metrics: {} })).toEqual({ objectives: {} });
    expect(metricsOf({ metrics: { objectives: { cost: 'x', ok: 2 }, runtimeSeconds: Number.NaN } }).objectives).toEqual({ ok: 2 });
  });

  it('offers the objectives and the time as the measures, and values only completed cells', () => {
    expect(measuresOf(cells)).toEqual(['cost', 'latency', 'runtime']);
    expect(measureValue(cells[2], 'cost')).toBe(0.121);
    expect(measureValue(cells[2], 'runtime')).toBe(58);
    expect(measureValue(cells[1], 'cost')).toBeNull();
    expect(measureValue(cells[5], 'cost')).toBeNull();
  });

  it('lays the cells out as a matrix of case revisions by engine and seed', () => {
    const view = matrixView(cells);
    expect(view.rows).toEqual([REVISION_1.id, REVISION_2.id]);
    expect(view.columns.map((column) => column.label)).toEqual(['evolutionary · seed 1', 'evolutionary · seed 2', 'random-search · seed 1', 'random-search · seed 2']);
    expect(view.at.get(slot(REVISION_2.id, view.columns[3].key))?.ordinal).toBe(7);
    expect(view.settings).toBe(1);
  });

  it('colours by quarter of the range, lower is better', () => {
    expect([0.104, 0.11, 0.113, 0.121].map((value) => heatLevel(value, 0.104, 0.121))).toEqual([0, 1, 2, 3]);
    expect(heatLevel(5, 5, 5)).toBe(0);
  });

  it('finds the cells that got the same input and the other seeds of one engine', () => {
    expect(rivalsOf(cells[2], cells).map((cell) => cell.ordinal)).toEqual([0, 2]);
    expect(seedsOf(cells[2], cells).map((cell) => cell.seed)).toEqual([1, 2]);
    expect(enginesOf(cells).map((engine) => engine.label)).toEqual(['evolutionary', 'random-search']);
  });

  it('counts how a run ended in words', () => {
    expect(breakdownText(cells)).toBe('6 completed, 1 failed, 1 cancelled of 8 cells');
    expect(breakdownText([])).toBe('No cells');
  });

  it('explains a failed cell by the code the gateway recorded', () => {
    expect(explainFailure({ code: 'engine_unreachable', detail: 'timeout' })).toEqual({ title: 'The engine deployment didn’t answer in time.', detail: 'timeout' });
    expect(explainFailure({ code: 'something_new' }).title).toBe('The engine could not produce a result for this cell.');
    expect(explainFailure({}).detail).toBeNull();
  });

  it('writes numbers and times the way the screens show them', () => {
    expect(formatMeasure(0.123456)).toBe('0.1235');
    expect(formatMeasure(1234.5)).toBe('1,235');
    expect(formatMeasure(undefined)).toBe('—');
    expect(formatSeconds(58)).toBe('58 s');
    expect(formatSeconds(3.14159)).toBe('3.14 s');
    expect(formatSeconds(125)).toBe('2 min 5 s');
    expect(formatSeconds(120)).toBe('2 min');
    expect(formatSeconds(7200)).toBe('2 h');
  });
});

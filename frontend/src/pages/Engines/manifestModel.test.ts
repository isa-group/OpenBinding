import { describe, expect, it } from 'vitest';
import { ENGINE_DOCUMENT } from '../../test/fixtures/engines';
import { describeFixedOption, dimensionLabel, readManifest, valueLabel } from './manifestModel';

describe('reading an engine manifest', () => {
  const view = readManifest(ENGINE_DOCUMENT);
  const mode = view?.modes[0];

  it('lays out identity and mode', () => {
    expect(view).toMatchObject({ namespace: 'alex.rivera', name: 'edge-solver', version: '0.3.1', description: 'Tabu search over edge placements' });
    expect(mode).toMatchObject({ id: 'tabu', profile: 'qos-binding/v1', ir: 'bim/v1 · BindingProblem', algorithm: 'tabu-search', exact: false });
    expect(mode?.termination).toEqual(['FEASIBLE', 'UNKNOWN']);
    expect(mode?.flags).toEqual(['Deterministic without time budget']);
  });

  it('shows feature values, including ranges, as what they mean', () => {
    expect(mode?.featureValues).toEqual({ declared: true, scalar: true, interval: true });
    expect(valueLabel('featureValues', 'interval')).toBe('Interval (ranges, min–max)');
    expect(dimensionLabel('featureValues')).toBe('Feature values');
  });

  it('reads every selector, and keeps scalarizations apart because their values are objects', () => {
    const rows = Object.fromEntries((mode?.capabilities ?? []).map((row) => [row.id, row]));
    expect(rows.workflowNodes).toMatchObject({ selector: 'all', values: [] });
    expect(rows.aggregations).toMatchObject({ selector: 'only', values: ['sequence.sum', 'parallel.max'] });
    expect(rows.scalarizations).toBeUndefined();
    expect(mode?.scalarizations).toEqual([
      { id: 'weighted-sum', objectives: 'one objective', weights: 'weights required' },
      { id: 'pareto-front', objectives: 'several objectives · many objectives', weights: 'no weights' },
    ]);
  });

  it('turns option schemas into ranges, defaults and fixed values', () => {
    expect(mode?.options).toEqual([
      { name: 'time_budget_ms', type: 'integer', range: '1 – 3,600,000', default: '60,000', required: true, fixed: null },
      { name: 'seed', type: 'integer', range: '—', default: '0', required: false, fixed: null },
      { name: 'algorithm', type: 'fixed', range: '—', default: 'tabu', required: false, fixed: 'always tabu' },
    ]);
    expect(mode?.limits).toEqual([['maxIterations', 100000], ['maxTimeBudgetMs', 3600000]]);
  });

  // [utest->req~frontend-registration-fixed-option-rendered~1]
  it('describes a fixed option as words: const, enum and any other keyword as keyword/value pairs', () => {
    expect(describeFixedOption({ const: 'tabu', default: 'tabu' })).toEqual({ summary: 'always tabu', pairs: [{ keyword: 'default', value: 'tabu' }] });
    expect(describeFixedOption({ enum: ['a', 'b', 3] })).toEqual({ summary: 'one of a, b, 3', pairs: [] });
    const other = describeFixedOption({ type: 'array', items: { type: 'string' }, pattern: '^x', uniqueItems: true, examples: ['p', 'q'] });
    expect(other.summary).toBeNull();
    expect(other.pairs).toEqual([
      { keyword: 'type', value: 'array' },
      { keyword: 'items', value: '1 field' },
      // (an object keeps no JSON text: only how many fields it has)
      { keyword: 'pattern', value: '^x' },
      { keyword: 'uniqueItems', value: 'true' },
      { keyword: 'examples', value: 'p, q' },
    ]);
    expect(describeFixedOption({ const: null }).summary).toBe('always null');
    expect(describeFixedOption({ const: { a: 1, b: 2 } }).summary).toBe('always 2 fields');
    expect(describeFixedOption('nonsense')).toEqual({ summary: null, pairs: [] });
    const text = JSON.stringify([describeFixedOption({ const: 'x' }).summary, ...other.pairs.map((pair) => pair.value)]);
    expect(text).not.toContain('{"');
  });

  it('agrees with the options table about what a fixed option says', () => {
    expect(mode?.options.find((option) => option.name === 'algorithm')?.fixed).toBe(describeFixedOption({ const: 'tabu' }).summary);
  });

  it('reads a mode that declares only scalar values, and one that does not declare them at all', () => {
    const scalarOnly = readManifest({ spec: { modes: [{ id: 'a', capabilities: { featureValues: { selector: 'only', values: ['scalar'] } } }, { id: 'b', capabilities: {} }] } });
    expect(scalarOnly?.modes[0].featureValues).toEqual({ declared: true, scalar: true, interval: false });
    expect(scalarOnly?.modes[1].featureValues).toEqual({ declared: false, scalar: false, interval: false });
  });

  it('lists what the document carries beyond the layout, and refuses what is not an engine', () => {
    const extras = readManifest({ metadata: { labels: { team: 'x' } }, spec: { modes: [], extensions: { y: 1 } } });
    expect(extras?.extras).toEqual(['labels', 'extensions']);
    expect(readManifest(null)).toBeNull();
    expect(readManifest({ metadata: {} })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { ENGINE_DOCUMENT } from './fixtures';
import { dimensionLabel, readManifest, valueLabel } from './manifestModel';

describe('reading an engine manifest', () => {
  const view = readManifest(ENGINE_DOCUMENT);
  const mode = view?.modes[0];

  it('lays out identity and mode', () => {
    expect(view).toMatchObject({ namespace: 'lucia.vega', name: 'edge-solver', version: '0.3.1', description: 'Tabu search over edge placements' });
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

import { describe, expect, it } from 'vitest';
import { figuresOf, notesOf, optimizationTypeOf, remoteOf, solutionsOf, unitsOf, verdictOf } from './runResultModel';
import { PROBLEM, REPORT, RESULT, S1, S2 } from './runResultFixtures';

describe('verdictOf', () => {
  // [utest->req~frontend-rendering-run-result-verdict~1]
  it('returns a non-empty string as it is', () => {
    for (const termination of ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'TIMEOUT']) expect(verdictOf(termination)).toBe(termination);
  });

  // [utest->req~frontend-rendering-run-result-verdict~1]
  it('gives UNKNOWN for anything that is not a non-empty string', () => {
    for (const termination of [undefined, null, '', 7, true, {}, ['FEASIBLE']]) expect(verdictOf(termination)).toBe('UNKNOWN');
  });
});

describe('solutionsOf', () => {
  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('returns the solutions in order', () => {
    expect(solutionsOf(RESULT)).toEqual([S1, S2]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('keeps plain objects only', () => {
    expect(solutionsOf({ solutions: [S1, null, 7, 'x', [S2], undefined, S2] })).toEqual([S1, S2]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('gives an empty list when solutions is not an array', () => {
    for (const solutions of [undefined, null, 'x', 3, { 0: S1 }]) expect(solutionsOf({ solutions })).toEqual([]);
    expect(solutionsOf({})).toEqual([]);
  });
});

describe('figuresOf', () => {
  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('reads the features in key order', () => {
    expect(figuresOf(S1)).toEqual([['latency', 420], ['cost', 9.5]]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('prefers features to metrics', () => {
    expect(figuresOf({ features: { latency: 420, cost: 9.5 }, metrics: { latency: 999, cost: 1 } })).toEqual([['latency', 420], ['cost', 9.5]]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('does not fall back to metrics while features is an object', () => {
    expect(figuresOf({ features: {}, metrics: { latency: 999 } })).toEqual([]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('falls back to metrics when features is not an object', () => {
    for (const features of [undefined, null, 'x', 5, [1, 2]]) {
      expect(figuresOf({ features, metrics: { latency: 300 } })).toEqual([['latency', 300]]);
    }
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('gives nothing when neither is an object', () => {
    expect(figuresOf({})).toEqual([]);
    expect(figuresOf({ features: 'x', metrics: [1] })).toEqual([]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('leaves out values that are not finite numbers', () => {
    const features = { latency: 'fast', cost: 9.5, region: { min: 1, max: 2 }, a: Number.NaN, b: Infinity, c: null, d: true, e: 0 };
    expect(figuresOf({ features })).toEqual([['cost', 9.5], ['e', 0]]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('never reads objectives.mode', () => {
    expect(figuresOf({ objectives: { mode: { latency: 1 } } })).toEqual([]);
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('ignores inherited keys', () => {
    // A plain object is non-null, an object and not an array, as in bindingTableModel.ts.
    const inherited = Object.create({ features: { latency: 1 }, metrics: { latency: 2 } }) as Record<string, unknown>;
    expect(figuresOf(inherited)).toEqual([]);
    const own = { features: Object.create({ latency: 1 }) as Record<string, unknown> };
    expect(figuresOf(own)).toEqual([]);
    const withMetrics = Object.create({ features: { latency: 1 } }) as Record<string, unknown>;
    withMetrics.metrics = { cost: 3 };
    expect(figuresOf(withMetrics)).toEqual([['cost', 3]]);
  });
});

describe('optimizationTypeOf', () => {
  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('reads objectives.type of the first solution that has one', () => {
    expect(optimizationTypeOf([S1, S2])).toBe('MULTI');
    expect(optimizationTypeOf([{}, { objectives: { type: '' } }, { objectives: { type: 7 } }, { objectives: { type: 'SINGLE' } }, S1])).toBe('SINGLE');
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('gives null when no solution has one', () => {
    expect(optimizationTypeOf([])).toBeNull();
    expect(optimizationTypeOf([{}, { objectives: null }, { objectives: [] }, { objectives: { type: '' } }])).toBeNull();
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('never reads objectives.mode', () => {
    expect(optimizationTypeOf([{ objectives: { mode: 'legacy-mode' } }])).toBeNull();
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('ignores inherited keys', () => {
    const objectives = Object.create({ type: 'MULTI' }) as Record<string, unknown>;
    expect(optimizationTypeOf([{ objectives }])).toBeNull();
  });
});

describe('unitsOf', () => {
  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('maps each feature of the problem to its unit', () => {
    expect(unitsOf(PROBLEM)).toEqual({ latency: 'ms', cost: 'EUR' });
  });

  // [utest->req~frontend-rendering-run-result-canonical-shape~1]
  it('keeps a feature without a unit as null', () => {
    expect(unitsOf({ ...PROBLEM, features: { availability: { unit: null }, cost: { unit: 'EUR' } } })).toEqual({ availability: null, cost: 'EUR' });
  });

  // [utest->req~frontend-rendering-run-result-without-problem~1]
  it('gives an empty map without a problem', () => {
    expect(unitsOf(null)).toEqual({});
    expect(unitsOf(undefined)).toEqual({});
  });
});

describe('notesOf', () => {
  // [utest->req~frontend-rendering-run-result-claimed-values~1]
  it('reads remote.divergence.notes', () => {
    expect(notesOf(REPORT)).toEqual(['Solved with presolve']);
  });

  // [utest->req~frontend-rendering-run-result-claimed-values~1]
  it('keeps the string items only, a blank one included', () => {
    expect(notesOf({ remote: { divergence: { notes: ['Solved with presolve', 7, null, '', '  ', { a: 1 }, 'b'] } } })).toEqual([
      'Solved with presolve',
      '',
      '  ',
      'b',
    ]);
  });

  // [utest->req~frontend-rendering-run-result-claimed-values~1]
  it('gives an empty list when anything on the path is missing or not as expected', () => {
    expect(notesOf(null)).toEqual([]);
    expect(notesOf(undefined)).toEqual([]);
    expect(notesOf({})).toEqual([]);
    expect(notesOf({ remote: null })).toEqual([]);
    expect(notesOf({ remote: 'x' })).toEqual([]);
    expect(notesOf({ remote: {} })).toEqual([]);
    expect(notesOf({ remote: { divergence: null } })).toEqual([]);
    expect(notesOf({ remote: { divergence: 'x' } })).toEqual([]);
    expect(notesOf({ remote: { divergence: {} } })).toEqual([]);
    expect(notesOf({ remote: { divergence: { notes: 'Solved with presolve' } } })).toEqual([]);
    expect(notesOf({ remote: { divergence: { notes: { 0: 'a' } } } })).toEqual([]);
  });

  // [utest->req~frontend-rendering-run-result-claimed-values~1]
  it('ignores inherited keys', () => {
    const divergence = Object.create({ notes: ['inherited'] }) as Record<string, unknown>;
    expect(notesOf({ remote: { divergence } })).toEqual([]);
    const remote = Object.create({ divergence: { notes: ['inherited'] } }) as Record<string, unknown>;
    expect(notesOf({ remote })).toEqual([]);
  });
});

describe('remoteOf', () => {
  // [utest->req~frontend-rendering-run-result-source~1]
  it('returns the remote object when it has an own key', () => {
    expect(remoteOf(REPORT)).toEqual(REPORT.remote);
  });

  // [utest->req~frontend-rendering-run-result-source~1]
  it('gives null for an empty remote', () => {
    expect(remoteOf({ remote: {} })).toBeNull();
  });

  // [utest->req~frontend-rendering-run-result-source~1]
  it('gives null without a report, a remote, or an object remote', () => {
    expect(remoteOf(null)).toBeNull();
    expect(remoteOf(undefined)).toBeNull();
    expect(remoteOf({})).toBeNull();
    expect(remoteOf({ remote: null })).toBeNull();
    expect(remoteOf({ remote: 'x' })).toBeNull();
    expect(remoteOf({ remote: 3 })).toBeNull();
  });

  // [utest->req~frontend-rendering-run-result-source~1]
  it('counts own keys only', () => {
    const remote = Object.create({ engine: 'demo-solver' }) as Record<string, unknown>;
    expect(remoteOf({ remote })).toBeNull();
    const inheritedRemote = Object.create({ remote: { engine: 'x' } }) as { remote?: unknown };
    expect(remoteOf(inheritedRemote)).toBeNull();
  });
});

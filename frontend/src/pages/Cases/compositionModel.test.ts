import { describe, expect, it } from 'vitest';
import { estimateComposition } from './compositionModel';
import { sourceContents } from './fixtures';

const full = {
  applications: [sourceContents.application],
  catalogs: [sourceContents.catalog],
  constraintSets: [sourceContents.rules],
  optimizations: [sourceContents.goal],
};

describe('estimateComposition', () => {
  it('counts tasks, candidates, rules and criteria of the picked contents', () => {
    const stats = estimateComposition(full);
    expect(stats).toMatchObject({ tasks: 4, serviceTasks: 3, candidates: 5, must: 1, should: 1, criteria: 2, missing: [] });
  });

  it('bounds the size by the product of the candidates each task can use', () => {
    // auth: a1, a2 (2) · stock: s1, s2 (2) · shipping: s2, s3 (2)
    expect(estimateComposition(full).log10).toBeCloseTo(Math.log10(2 * 2 * 2), 6);
  });

  it('cannot size the problem while a task has no provider, and says which', () => {
    const noShipping = { ...sourceContents.catalog, spec: { ...sourceContents.catalog.spec, candidates: { a1: { provides: 'auth' }, s1: { provides: 'stock' } } } };
    const stats = estimateComposition({ ...full, catalogs: [noShipping] });
    expect(stats.log10).toBeNull();
    expect(stats.missing).toEqual(['shipping']);
  });

  it('adds up several catalogs', () => {
    const more = { spec: { candidates: { a3: { provides: 'auth' } } } };
    expect(estimateComposition({ ...full, catalogs: [sourceContents.catalog, more] }).candidates).toBe(6);
  });

  it('counts a candidate with ranges, open or not, like any other: the size of the problem does not depend on its qualities', () => {
    const catalog = sourceContents.catalog as { spec: { candidates: Record<string, { provides: unknown; features?: unknown }> } };
    const ranged = {
      ...catalog,
      spec: {
        ...catalog.spec,
        candidates: Object.fromEntries(Object.entries(catalog.spec.candidates).map(([id, candidate], index) => [id, {
          ...candidate, features: [{ latency: { min: null, max: 200 } }, { latency: { min: 100, max: null } }, { latency: { min: null, max: null } }, { latency: { min: 1, max: 2 } }, { latency: 5 }][index % 5],
        }])),
      },
    };
    expect(estimateComposition({ ...full, catalogs: [ranged] })).toEqual(estimateComposition(full));
  });

  it('has nothing to say about an empty composition', () => {
    expect(estimateComposition({ applications: [], catalogs: [], constraintSets: [], optimizations: [] })).toEqual({
      tasks: 0, serviceTasks: 0, candidates: 0, must: 0, should: 0, criteria: 0, log10: null, missing: [],
    });
  });

  it('waits for a catalog before it names missing providers', () => {
    const stats = estimateComposition({ ...full, catalogs: [] });
    expect(stats.missing).toEqual([]);
    expect(stats.log10).toBeNull();
  });

  it('ignores contents that are not what they should be', () => {
    expect(estimateComposition({ applications: ['x', null], catalogs: [42], constraintSets: [[]], optimizations: [{ spec: { criteria: 'no' } }] }).criteria).toBe(0);
  });
});

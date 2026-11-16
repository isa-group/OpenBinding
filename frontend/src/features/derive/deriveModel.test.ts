import { describe, expect, it } from 'vitest';
import { RESULT, S1, S2 } from '../../test/fixtures/jobs';
import { SLUG_PATTERN } from '../../shared/lib/slug';
import {
  FIRST_LABEL,
  LABEL_PATTERN,
  batchSlugErrors,
  bindingDerivation,
  criteriaOf,
  isPointsSource,
  isRunSource,
  nextMinor,
  pointSlug,
  pointsOf,
  previewValues,
  runDerivation,
} from './deriveModel';

describe('the label of a derived version', () => {
  it('is 1.0.0 for a composition with no version', () => {
    expect(nextMinor(null)).toBe(FIRST_LABEL);
    expect(nextMinor(undefined)).toBe('1.0.0');
    expect(nextMinor('')).toBe('1.0.0');
  });

  it('is the next minor of the latest label, as a string bump', () => {
    expect(nextMinor('1.0.0')).toBe('1.1.0');
    expect(nextMinor('1.2.3')).toBe('1.3.0');
    expect(nextMinor('0.9.0')).toBe('0.10.0');
    expect(nextMinor('2.0.0-rc.1+build.5')).toBe('2.1.0');
    expect(nextMinor('1.99999999999999999999.0')).toBe('1.100000000000000000000.0');
  });

  it('starts again at 1.0.0 when the latest label does not start with three numbers', () => {
    expect(nextMinor('v1.2.0')).toBe('1.0.0');
    expect(nextMinor('1.2')).toBe('1.0.0');
    expect(nextMinor('01.2.0')).toBe('1.0.0');
  });

  it('accepts only Semantic Versioning labels, as the gateway does', () => {
    for (const label of ['1.0.0', '0.1.0', '1.0.0-rc.1', '2.3.4+build.7', '10.20.30-alpha.beta'])
      expect(LABEL_PATTERN.test(label), label).toBe(true);
    for (const label of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-', 'one', ''])
      expect(LABEL_PATTERN.test(label), label).toBe(false);
  });
});

describe('the solutions of a run', () => {
  it('are listed in the result’s order with their objectives as the result writes them, never ranked', () => {
    const points = pointsOf(RESULT.solutions);
    expect(points).toEqual([
      {
        point: 0,
        label: 'Solution 1',
        objectives: [
          { criterion: 'cost', value: 9.5 },
          { criterion: 'latency', value: 420 },
        ],
        score: [0.3, 0.4],
      },
      {
        point: 1,
        label: 'Solution 2',
        objectives: [
          { criterion: 'cost', value: 7 },
          { criterion: 'latency', value: 560 },
        ],
        score: [0.2, 0.55],
      },
    ]);
    // S2 is better on cost and S1 on latency: the order stays the result's.
    expect(pointsOf([S2, S1]).map(point => point.objectives[0].value)).toEqual([7, 9.5]);
    expect(criteriaOf(points)).toEqual(['cost', 'latency']);
  });

  it('keep the index the request names when an entry is not a solution, and read what is missing as missing', () => {
    const points = pointsOf([
      null,
      { objectives: { score: 3, components: [{ value: 'x' }, { criteria: 'cost', value: 4 }] } },
      { decision: {} },
    ]);
    expect(points).toEqual([
      {
        point: 1,
        label: 'Solution 2',
        objectives: [
          { criterion: 'criterion 1', value: null },
          { criterion: 'cost', value: 4 },
        ],
        score: 3,
      },
      { point: 2, label: 'Solution 3', objectives: [], score: null },
    ]);
    expect(criteriaOf(points)).toEqual(['criterion 1', 'cost']);
  });
});

describe('the requests', () => {
  it('derive a solution of a run as a preview or as a version, with the same run, point and label', () => {
    const preview = runDerivation({ run: 'run-1' }, 1, '1.0.0', false);
    expect(preview).toEqual({ run: 'run-1', point: 1, version: '1.0.0', seal: false });
    expect(runDerivation({ run: 'run-1' }, 1, '1.0.0', true)).toEqual({ ...preview, seal: true });
  });

  it('derive a binding of a problem version as a preview or as a version, with the same revision, binding and label', () => {
    const source = {
      revision: 'checkout-flow@2',
      binding: { T1: 'cand_t1_google_cloud', T2: 'cand_t2_radius_iot_network' },
    };
    const preview = bindingDerivation(source, '1.3.0', false);
    expect(preview).toEqual({
      revision: 'checkout-flow@2',
      binding: { T1: 'cand_t1_google_cloud', T2: 'cand_t2_radius_iot_network' },
      version: '1.3.0',
      seal: false,
    });
    expect(bindingDerivation(source, '1.3.0', true)).toEqual({ ...preview, seal: true });
    expect(preview.binding).not.toBe(source.binding);
  });

  it('tell a run from a binding', () => {
    expect(isRunSource({ run: 'run-1', solutions: [] })).toBe(true);
    expect(isRunSource({ revision: 'checkout-flow@2', binding: {} })).toBe(false);
  });

  it('read the values of a preview in the gateway’s order', () => {
    expect(
      previewValues({
        values: {
          cost: { value: 3060, unit: 'USD/month' },
          availability: { value: 0.99, unit: '1' },
        },
      })
    ).toEqual([
      { name: 'cost', value: 3060, unit: 'USD/month' },
      { name: 'availability', value: 0.99, unit: '1' },
    ]);
  });
});

describe('the points of a study front, derived in a batch', () => {
  it('addresses point n of a problem as <problem>-p<n>, within the length of a slug', () => {
    expect(pointSlug('checkout-flow', 3)).toBe('checkout-flow-p3');
    const long = pointSlug('a'.repeat(70), 12);
    expect(long).toHaveLength(64);
    expect(long.endsWith('-p12')).toBe(true);
    expect(pointSlug(`${'a'.repeat(59)}-tail`, 12)).toBe(`${'a'.repeat(59)}-p12`);
    expect(SLUG_PATTERN.test(pointSlug('x-', 1))).toBe(true);
  });

  it('refuses an address that is not a slug, and one two points share', () => {
    const errors = batchSlugErrors(
      [
        { key: 'a', slug: 'same' },
        { key: 'b', slug: 'same' },
        { key: 'c', slug: 'Not A Slug' },
        { key: 'd', slug: 'fine' },
      ],
      SLUG_PATTERN
    );
    expect(errors).toEqual({
      a: 'Another point has same too.',
      b: 'Another point has same too.',
      c: 'Lowercase letters, numbers and hyphens, at most 64.',
    });
  });

  it('tells a batch of points from a run and from a binding', () => {
    expect(isPointsSource({ points: [] })).toBe(true);
    expect(isPointsSource({ run: 'r', solutions: [] })).toBe(false);
    expect(isRunSource({ points: [] })).toBe(false);
  });
});

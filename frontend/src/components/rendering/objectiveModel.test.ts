import { describe, expect, it } from 'vitest';
import { objectiveTermsOf, type ObjectiveProblem } from './objectiveModel';

const OBJ_SINGLE = {
  type: 'SINGLE', scalarization: 'weighted-sum', penalty: 2, score: 2.375,
  components: [
    { criteria: 'fast', feature: { resource: 'app', id: 'latency' }, value: 350, loss: 0.25, weight: 0.5 },
    { criteria: 'reliable', feature: { resource: 'app', id: 'availability' }, value: 99.5, loss: 0.5, weight: 0.5 },
  ],
};
const PROBLEM: ObjectiveProblem = {
  criteria: [{ id: 'fast', direction: 'minimize' }, { id: 'reliable', direction: 'maximize' }],
  features: { latency: { unit: 'ms' }, availability: { unit: '%' } },
};

describe('objectiveTermsOf', () => {
  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('derives terms with a problem', () => {
    const data = objectiveTermsOf(OBJ_SINGLE, PROBLEM);
    expect(data).not.toBeNull();
    expect(data?.scalarization).toBe('weighted-sum');
    expect(data?.penalty).toBe(2);
    expect(data?.score).toBe(2.375);
    expect(data?.terms).toEqual([
      { criterion: 'fast', feature: 'latency', direction: 'minimize', unit: 'ms', value: 350, loss: 0.25, weight: 0.5, weighted: 0.125 },
      { criterion: 'reliable', feature: 'availability', direction: 'maximize', unit: '%', value: 99.5, loss: 0.5, weight: 0.5, weighted: 0.25 },
    ]);
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('derives terms without a problem', () => {
    const data = objectiveTermsOf(OBJ_SINGLE, null);
    expect(data?.terms.map((t) => [t.direction, t.unit])).toEqual([[null, null], [null, null]]);
    expect(data?.terms.map((t) => [t.criterion, t.feature, t.value, t.loss, t.weight, t.weighted])).toEqual([
      ['fast', 'latency', 350, 0.25, 0.5, 0.125],
      ['reliable', 'availability', 99.5, 0.5, 0.5, 0.25],
    ]);
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('gives no direction or unit when the problem names neither', () => {
    const data = objectiveTermsOf(OBJ_SINGLE, { criteria: [{ id: 'other', direction: 'maximize' }], features: {} });
    expect(data?.terms.map((t) => [t.direction, t.unit])).toEqual([[null, null], [null, null]]);
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it.each([null, undefined, 'x', [], { mode: 'single', score: 3 }])('returns null for %j', (value) => {
    expect(objectiveTermsOf(value, PROBLEM)).toBeNull();
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('reads components tolerantly', () => {
    const data = objectiveTermsOf(
      { components: [{ feature: 'latency', value: 'fast', loss: 0.5 }, null], scalarization: 7, penalty: '2', score: [0.25, 'x', 0] },
      null,
    );
    expect(data?.terms[0]).toEqual({ criterion: 'criterion 1', feature: 'latency', direction: null, unit: null, value: null, loss: 0.5, weight: null, weighted: null });
    expect(data?.terms[1]).toEqual({ criterion: 'criterion 2', feature: null, direction: null, unit: null, value: null, loss: null, weight: null, weighted: null });
    expect(data?.scalarization).toBeNull();
    expect(data?.penalty).toBeNull();
    expect(data?.score).toEqual([0.25, null, 0]);
    expect(objectiveTermsOf({ components: [], score: 'bad' }, null)?.score).toBeNull();
  });
});

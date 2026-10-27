import { describe, expect, it } from 'vitest';
import { MAX_TEXT, TOLERANCE, evaluationDiffOf, shortText, type RunValues } from './evaluationDiffModel';

const EVAL = (): RunValues => ({
  termination: 'FEASIBLE',
  solutions: [
    { features: { latency: 120, cost: 3.5 }, score: 0.42 },
    { features: { latency: 90, cost: 5 }, score: 0.47 },
  ],
});

const deepFreeze = <T,>(o: T): T => {
  if (typeof o === 'object' && o !== null) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

describe('evaluationDiffOf', () => {
  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('reports no-claim without a claim', () => {
    for (const claimed of [undefined, null]) {
      const view = evaluationDiffOf(EVAL(), claimed);
      expect(view.status).toBe('no-claim');
      expect(view.claimed).toBeNull();
      expect(view.paired).toBe(false);
      expect(view.rows).toEqual([]);
      expect(view.evaluated).toEqual({ termination: 'FEASIBLE', solutions: 2 });
    }
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('agrees within the tolerance and differs beyond it', () => {
    expect(TOLERANCE).toBe(1e-9);
    const near = EVAL();
    near.solutions[0].features!.latency = 120.0000000005;
    expect(evaluationDiffOf(EVAL(), near).status).toBe('agrees');
    const far = EVAL();
    far.solutions[0].features!.latency = 100;
    const view = evaluationDiffOf(EVAL(), far);
    expect(view.status).toBe('differs');
    expect(view.rows).toEqual([
      { solution: 1, field: { kind: 'feature', name: 'latency' }, claimed: { kind: 'number', value: 100 }, evaluated: { kind: 'number', value: 120 } },
    ]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('orders rows: termination, then features (evaluated keys first, then claim-only), then score', () => {
    const claim: RunValues = {
      termination: 'OPTIMAL',
      solutions: [
        { features: { latency: 'fast', availability: 0.99 }, score: 0.1 },
        { features: { latency: 90, cost: 5 }, score: 0.47 },
      ],
    };
    const rows = evaluationDiffOf(EVAL(), claim).rows;
    expect(rows.map((r) => [r.solution, r.field])).toEqual([
      [null, { kind: 'termination' }],
      [1, { kind: 'feature', name: 'latency' }],
      [1, { kind: 'feature', name: 'cost' }],
      [1, { kind: 'feature', name: 'availability' }],
      [1, { kind: 'score', component: null }],
    ]);
    expect(rows[0].claimed).toEqual({ kind: 'text', text: 'OPTIMAL' });
    expect(rows[1].claimed).toEqual({ kind: 'invalid' });
    expect(rows[2].claimed).toEqual({ kind: 'absent' });
    expect(rows[3].evaluated).toEqual({ kind: 'absent' });
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('never agrees on invalid values, even two of them', () => {
    const ev = EVAL();
    ev.solutions[0].features!.latency = 'x';
    const claim = EVAL();
    claim.solutions[0].features!.latency = 'x';
    expect(evaluationDiffOf(ev, claim).rows).toHaveLength(1);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('gives only a Solutions row when the counts differ', () => {
    const claim = EVAL();
    claim.solutions.push({ features: { latency: 80 }, score: 0.5 });
    claim.solutions[0].features!.latency = 100;
    const view = evaluationDiffOf(EVAL(), claim);
    expect(view.paired).toBe(false);
    expect(view.rows).toEqual([
      { solution: null, field: { kind: 'solutions' }, claimed: { kind: 'number', value: 3 }, evaluated: { kind: 'number', value: 2 } },
    ]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('compares score lists by component, or as one row when shapes differ', () => {
    const ev = EVAL();
    ev.solutions[0].score = [0.4, 0.6];
    const claim = EVAL();
    claim.solutions[0].score = [0.4, 0.5];
    expect(evaluationDiffOf(ev, claim).rows).toEqual([
      { solution: 1, field: { kind: 'score', component: 2 }, claimed: { kind: 'number', value: 0.5 }, evaluated: { kind: 'number', value: 0.6 } },
    ]);
    claim.solutions[0].score = 0.4;
    expect(evaluationDiffOf(ev, claim).rows).toEqual([
      { solution: 1, field: { kind: 'score', component: null }, claimed: { kind: 'number', value: 0.4 }, evaluated: { kind: 'list', values: [0.4, 0.6] } },
    ]);
    claim.solutions[0].score = [0.4];
    expect(evaluationDiffOf(ev, claim).rows[0].field).toEqual({ kind: 'score', component: null });
    claim.solutions[0].score = [0.4, 'x'];
    expect(evaluationDiffOf(ev, claim).rows[0].claimed).toEqual({ kind: 'invalid' });
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('reads metrics and objectives.score as fallbacks', () => {
    const ev: RunValues = { termination: 'FEASIBLE', solutions: [{ metrics: { latency: 120 }, objectives: { score: 0.42 } }] };
    const claim: RunValues = { termination: 'FEASIBLE', solutions: [{ features: { latency: 120 }, score: 0.42 }] };
    expect(evaluationDiffOf(ev, claim).status).toBe('agrees');
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('survives a malformed claim', () => {
    const claim = { termination: 7, solutions: 'many' } as unknown as RunValues;
    const view = evaluationDiffOf(EVAL(), claim);
    expect(view.rows.map((r) => r.field.kind)).toEqual(['termination', 'solutions']);
    expect(view.rows[0].claimed).toEqual({ kind: 'text', text: null });
    expect(view.rows[1].claimed).toEqual({ kind: 'number', value: 0 });
    const junk = { termination: null, solutions: [null, 5, 'x'] } as unknown as RunValues;
    expect(() => evaluationDiffOf(junk, junk)).not.toThrow();
    expect(() => evaluationDiffOf(null as unknown as RunValues, 5 as unknown as RunValues)).not.toThrow();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('treats constructor and __proto__ as ordinary feature names', () => {
    const claim = EVAL();
    claim.solutions[0].features = JSON.parse('{"latency":120,"cost":3.5,"constructor":1,"__proto__":2}');
    const rows = evaluationDiffOf(EVAL(), claim).rows;
    expect(rows.map((r) => r.field)).toEqual([
      { kind: 'feature', name: 'constructor' },
      { kind: 'feature', name: '__proto__' },
    ]);
    expect(rows.map((r) => r.claimed)).toEqual([{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // a feature the claim lacks is not found on the prototype chain
    const ev = EVAL();
    ev.solutions[0].features = JSON.parse('{"constructor":1}');
    const none = EVAL();
    none.solutions[0].features = {};
    expect(evaluationDiffOf(ev, none).rows[0].claimed).toEqual({ kind: 'absent' });
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('is pure on deeply frozen inputs', () => {
    const claim = EVAL();
    claim.solutions[0].features!.latency = 100;
    const ev = deepFreeze(EVAL());
    deepFreeze(claim);
    const a = evaluationDiffOf(ev, claim);
    const b = evaluationDiffOf(ev, claim);
    expect(a).toEqual(b);
  });
});

describe('shortText', () => {
  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('keeps 500 code points whole and cuts longer text with an ellipsis', () => {
    expect(MAX_TEXT).toBe(500);
    expect(shortText('x'.repeat(500))).toBe('x'.repeat(500));
    expect(shortText('x'.repeat(600))).toBe(`${'x'.repeat(500)}…`);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('never splits a surrogate pair at the cut', () => {
    const emoji = '\u{1F600}';
    expect(shortText('x'.repeat(499) + emoji + emoji)).toBe(`${'x'.repeat(499)}${emoji}…`);
  });
});

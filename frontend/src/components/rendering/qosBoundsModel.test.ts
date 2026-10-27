import { describe, expect, it } from 'vitest';
import { qosBoundsOf } from './qosBoundsModel';

const x = (name: string) => ({ kind: 'path', segments: ['features', name] });
const lit = (value: unknown) => ({ kind: 'literal', value });
const cmp = (op: string, left: unknown, right: unknown) => ({ kind: 'compare', op, left, right });
const and = (left: unknown, right: unknown) => ({ kind: 'and', left, right });
const add = (left: unknown, right: unknown) => ({ kind: 'arithmetic', op: 'add', left, right });
const ref = (id: string, resource = 'rules') => ({ resource, id });
const rule = (id: string, enforcement: string, when: unknown, assert: unknown, extra: object = {}) => ({
  ref: ref(id), enforcement, when, assert, ...extra,
});

const QOS = [
  rule('max-latency', 'hard', lit(true), cmp('lte', x('latency'), lit(600))),
  rule('cost-band', 'soft', undefined, and(cmp('lte', lit(2), x('cost')), cmp('lt', x('cost'), lit(10))), { penalty: lit(5) }),
  rule('busy-latency', 'hard', cmp('gt', x('load'), lit(5)), cmp('lte', x('latency'), lit(400))),
  rule('bundle-cost', 'hard', lit(true), cmp('lte', add(x('cost'), x('fee')), lit(12))),
];
const FEATURES = { latency: 412, cost: 11.5, load: 3, fee: 0.25 };
const UNITS = { latency: 'ms', cost: 'EUR', load: null, fee: 'EUR' };
const VIOLATIONS = [{ constraint: ref('cost-band'), enforcement: 'soft', penalty: 2.5 }];

describe('qosBoundsOf', () => {
  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('turns comparisons of one quality with a number into bounds, flipping a number on the left', () => {
    const { bounds } = qosBoundsOf(QOS, FEATURES, VIOLATIONS, UNITS);
    expect(bounds).toEqual([
      { rule: 'max-latency', feature: 'latency', op: 'lte', limit: 600, value: 412, unit: 'ms', enforcement: 'hard', met: true },
      { rule: 'cost-band', feature: 'cost', op: 'gte', limit: 2, value: 11.5, unit: 'EUR', enforcement: 'soft', met: false, penalty: 2.5 },
      { rule: 'cost-band', feature: 'cost', op: 'lt', limit: 10, value: 11.5, unit: 'EUR', enforcement: 'soft', met: false, penalty: 2.5 },
    ]);
    expect(bounds[0]).not.toHaveProperty('penalty');
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('turns other rules into text, with their condition', () => {
    const { rules } = qosBoundsOf(QOS, FEATURES, VIOLATIONS, UNITS);
    expect(rules).toEqual([
      { rule: 'busy-latency', text: 'features.latency ≤ 400', when: 'features.load > 5', enforcement: 'hard', met: true },
      { rule: 'bundle-cost', text: '(features.cost + features.fee) ≤ 12', when: null, enforcement: 'hard', met: true },
    ]);
    const { bounds } = qosBoundsOf(QOS, FEATURES, VIOLATIONS, UNITS);
    expect(bounds.some((b) => b.rule === 'busy-latency')).toBe(false);
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('keeps shapes that are not a bound as text', () => {
    const asserts = [
      cmp('eq', x('latency'), lit(600)),
      cmp('ne', x('latency'), lit(600)),
      cmp('lte', x('latency'), x('cost')),
      cmp('lte', lit(1), lit(2)),
      cmp('lte', { kind: 'path', segments: ['tasks', 'pay', 'latency'] }, lit(600)),
      cmp('lte', x('latency'), { kind: 'negate', value: lit(5) }),
      cmp('eq', x('region'), lit('eu')),
      { kind: 'or', left: cmp('lte', x('latency'), lit(600)), right: cmp('lte', x('cost'), lit(10)) },
      { kind: 'not', value: cmp('gt', x('latency'), lit(600)) },
    ];
    const constraints = asserts.map((a, i) => rule(`r${i}`, 'hard', lit(true), a));
    const { bounds, rules } = qosBoundsOf(constraints, FEATURES, [], UNITS);
    expect(bounds).toEqual([]);
    expect(rules.map((r) => r.text)).toEqual([
      'features.latency = 600',
      'features.latency ≠ 600',
      'features.latency ≤ features.cost',
      '1 ≤ 2',
      'tasks.pay.latency ≤ 600',
      'features.latency ≤ −5',
      'features.region = “eu”',
      '(features.latency ≤ 600) or (features.cost ≤ 10)',
      'not (features.latency > 600)',
    ]);
    expect(rules.map((r) => r.rule)).toEqual(asserts.map((_, i) => `r${i}`));
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('never splits a mixed conjunction and flattens nested ones', () => {
    const mixed = rule('mixed', 'hard', lit(true), and(cmp('lte', x('latency'), lit(600)), cmp('eq', x('region'), lit('eu'))));
    const nested = rule('nested', 'hard', lit(true),
      and(and(cmp('gte', x('cost'), lit(1)), cmp('lte', x('cost'), lit(9))), cmp('lt', x('latency'), lit(700))));
    const { bounds, rules } = qosBoundsOf([mixed, nested], FEATURES, [], UNITS);
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe('mixed');
    expect(rules[0].text).toBe('(features.latency ≤ 600) and (features.region = “eu”)');
    expect(bounds.map((b) => [b.rule, b.op, b.limit])).toEqual([['nested', 'gte', 1], ['nested', 'lte', 9], ['nested', 'lt', 700]]);
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('takes the status from the gateway, not from the value', () => {
    const one = [QOS[0]];
    const first = qosBoundsOf(one, { latency: 700 }, [], UNITS).bounds[0];
    expect(first.met).toBe(true);
    const second = qosBoundsOf(one, { latency: 412 }, [{ constraint: ref('max-latency'), enforcement: 'hard', penalty: 0 }], UNITS).bounds[0];
    expect(second.met).toBe(false);
    expect(second).not.toHaveProperty('penalty');
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it.each([undefined, null, {}])('reads %j violations as not checked', (violations) => {
    const { bounds, rules } = qosBoundsOf(QOS, FEATURES, violations, UNITS);
    expect(bounds).toHaveLength(3);
    expect(rules).toHaveLength(2);
    for (const row of [...bounds, ...rules]) {
      expect(row.met).toBeNull();
      expect(row).not.toHaveProperty('penalty');
    }
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('reports violations of rules the compiled problem does not hold', () => {
    const violations = [
      { constraint: ref('edge-capacity', 'placement'), enforcement: 'hard', penalty: 0, message: 'Pool edge over capacity' },
      { constraint: ref('core-capacity', 'placement'), enforcement: 'soft', penalty: 1.25 },
      { constraint: ref('core-capacity', 'placement'), enforcement: 'soft', penalty: 0.75 },
    ];
    const expected = [
      { rule: 'edge-capacity', text: 'Pool edge over capacity', when: null, enforcement: 'hard', met: false },
      { rule: 'core-capacity', text: 'Reported by the gateway; not a rule of the compiled problem.', when: null, enforcement: 'soft', met: false, penalty: 2 },
    ];
    expect(qosBoundsOf([], {}, violations)).toEqual({ bounds: [], rules: expected });
    const mixed = qosBoundsOf(QOS, FEATURES, [...VIOLATIONS, ...violations], UNITS);
    expect(mixed.rules.map((r) => r.rule)).toEqual(['busy-latency', 'bundle-cost', 'edge-capacity', 'core-capacity']);
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('matches a violation by resource and id', () => {
    const { bounds, rules } = qosBoundsOf([QOS[0]], FEATURES, [{ constraint: ref('max-latency', 'other'), enforcement: 'hard', penalty: 0 }], UNITS);
    expect(bounds[0].met).toBe(true);
    expect(rules).toEqual([
      { rule: 'max-latency', text: 'Reported by the gateway; not a rule of the compiled problem.', when: null, enforcement: 'hard', met: false },
    ]);
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('leaves unexpected input out without throwing', () => {
    const empty = { bounds: [], rules: [] };
    expect(qosBoundsOf('x', null, null)).toEqual(empty);
    expect(qosBoundsOf('x', null, [null, { constraint: {} }, { enforcement: 'hard' }])).toEqual(empty);
    const junk = [null, 7, { enforcement: 'hard' }, { ref: { id: '' }, assert: cmp('lte', x('latency'), lit(1)) }];
    expect(qosBoundsOf(junk, null, [null, { constraint: {} }, { enforcement: 'hard' }])).toEqual(empty);
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it.each([{ latency: 'fast' }, {}, undefined])('gives a missing value as null (%j)', (features) => {
    expect(qosBoundsOf([QOS[0]], features, [], UNITS).bounds[0].value).toBeNull();
  });
});

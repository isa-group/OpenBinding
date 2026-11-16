import { describe, expect, it } from 'vitest';
import { describeExpression, isAlways } from './expressions';

describe('describeExpression', () => {
  it('writes comparisons, paths and calls as short formulas', () => {
    expect(describeExpression({
      kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'latency'] }, right: { kind: 'literal', value: 600 },
    })).toBe('features.latency ≤ 600');
    expect(describeExpression({
      kind: 'and',
      left: { kind: 'compare', op: 'gte', left: { kind: 'path', segments: ['a'] }, right: { kind: 'literal', value: 1 } },
      right: { kind: 'not', value: { kind: 'literal', value: false } },
    })).toBe('(a ≥ 1) and not false');
    expect(describeExpression({ kind: 'call', name: 'max', args: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'x' }] })).toBe('max(1, “x”)');
  });

  it('keeps going when the expression is malformed', () => {
    expect(describeExpression(null)).toBe('…');
    expect(describeExpression({ kind: 'mystery' })).toBe('…');
  });

  it('prints the expressions of the facts of a compiled problem as they are', async () => {
    const facts = (await import('../../test/fixtures/core/json-complete.facts.json')).default;
    expect(facts.constraints.map((rule) => describeExpression(rule.expression))).toContain('features.cost ≤ 30');
    expect(facts.constraints.every((rule) => isAlways(rule.when))).toBe(true);
  });
});

describe('isAlways', () => {
  it('is the literal true only', () => {
    expect(isAlways({ kind: 'literal', value: true })).toBe(true);
    expect(isAlways({ kind: 'literal', value: false })).toBe(false);
    expect(isAlways(null)).toBe(false);
  });
});

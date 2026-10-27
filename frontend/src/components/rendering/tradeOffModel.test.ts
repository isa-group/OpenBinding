import { describe, expect, it } from 'vitest';
import { nonDominated, tradeOffObjectivesOf, tradeOffPointsOf, type TradeOffPoint } from './tradeOffModel';

const POINTS: TradeOffPoint[] = [
  { id: 'solution-1', label: 'Solution 1', values: { cost: 12, latency: 440, availability: 0.99 }, losses: { cost: 12, latency: 440, availability: -0.99 } },
  { id: 'solution-2', label: 'Solution 2', values: { cost: 15, latency: 412, availability: 0.95 }, losses: { cost: 15, latency: 412, availability: -0.95 } },
  { id: 'solution-3', label: 'Solution 3', values: { cost: 18, latency: 450, availability: 0.97 }, losses: { cost: 18, latency: 450, availability: -0.97 } },
  { id: 'solution-4', label: 'Solution 4', values: { cost: 20, latency: 300, availability: 0.9 }, losses: { cost: 20, latency: 300, availability: -0.9 } },
];

const point = (id: string, values: Record<string, number>, losses = values): TradeOffPoint => ({ id, label: id, values, losses });

describe('tradeOffPointsOf', () => {
  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('reads a canonical solution', () => {
    const solution = {
      objectives: {
        components: [
          { criteria: 'cost', feature: { id: 'cost' }, value: 12, loss: 12, weight: 0.5 },
          { criteria: 'availability', feature: { id: 'availability' }, value: 0.99, loss: -0.99, weight: 0.5 },
        ],
      },
    };
    expect(tradeOffPointsOf([solution])).toEqual([
      { id: 'solution-1', label: 'Solution 1', values: { cost: 12, availability: 0.99 }, losses: { cost: 12, availability: -0.99 } },
    ]);
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('skips solutions and components that give no value, and keeps input positions', () => {
    const solutions = [
      {},
      { objectives: { components: null } },
      { objectives: { mode: 'pareto' } },
      {
        objectives: {
          components: [
            { criteria: 'cost', value: 15, loss: 15 },
            { criteria: 'cost', value: 99, loss: 99 },
            { criteria: 'latency', value: Number.NaN, loss: 1 },
            { criteria: 'risk', value: 2, loss: '2' },
            { criteria: '', value: 1, loss: 1 },
          ],
        },
      },
    ];
    expect(tradeOffPointsOf(solutions)).toEqual([
      { id: 'solution-4', label: 'Solution 4', values: { cost: 15 }, losses: { cost: 15 } },
    ]);
  });
});

describe('tradeOffObjectivesOf', () => {
  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('lists the criteria every point carries, in first-point order', () => {
    const p1 = point('p1', { cost: 1, latency: 2, availability: 3 });
    const p2 = point('p2', { latency: 2, cost: 1 });
    expect(tradeOffObjectivesOf([p1, p2])).toEqual(['cost', 'latency']);
    expect(tradeOffObjectivesOf([])).toEqual([]);
  });
});

describe('nonDominated', () => {
  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('drops the dominated point of the fixture', () => {
    expect(nonDominated(POINTS).map((p) => p.label)).toEqual(['Solution 1', 'Solution 2', 'Solution 4']);
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('compares the loss, not the value', () => {
    const a = point('A', { cost: 10, availability: 0.99 }, { cost: 10, availability: -0.99 });
    const b = point('B', { cost: 10, availability: 0.9 }, { cost: 10, availability: -0.9 });
    expect(nonDominated([b, a])).toEqual([a]);
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('keeps equal points and honours the objectives argument', () => {
    const c = point('C', { cost: 5, latency: 100 });
    const d = point('D', { cost: 5, latency: 100 });
    expect(nonDominated([c, d])).toEqual([c, d]);
    expect(nonDominated(POINTS, ['cost']).map((p) => p.label)).toEqual(['Solution 1']);
  });
});

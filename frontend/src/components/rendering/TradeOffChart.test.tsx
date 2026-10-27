import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TradeOffChart } from './TradeOffChart';
import type { TradeOffPoint } from './tradeOffModel';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScatterChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Scatter: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));

const POINTS: TradeOffPoint[] = [
  { id: 'solution-1', label: 'Solution 1', values: { cost: 12, latency: 440, availability: 0.99 }, losses: { cost: 12, latency: 440, availability: -0.99 } },
  { id: 'solution-2', label: 'Solution 2', values: { cost: 15, latency: 412, availability: 0.95 }, losses: { cost: 15, latency: 412, availability: -0.95 } },
  { id: 'solution-3', label: 'Solution 3', values: { cost: 18, latency: 450, availability: 0.97 }, losses: { cost: 18, latency: 450, availability: -0.97 } },
  { id: 'solution-4', label: 'Solution 4', values: { cost: 20, latency: 300, availability: 0.9 }, losses: { cost: 20, latency: 300, availability: -0.9 } },
];
const THREE = ['cost', 'latency', 'availability'];
const SUMMARY = '4 solutions plotted by cost (horizontal) and latency (vertical); 3 not dominated: Solution 1 (12, 440); Solution 2 (15, 412); Solution 4 (20, 300)';

const rowTexts = () => {
  const table = screen.getByRole('table');
  return within(table).getAllByRole('row').slice(1).map((r) => Array.from(r.querySelectorAll('th, td')).map((c) => c.textContent));
};

describe('TradeOffChart', () => {
  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('renders the region and the table of non-dominated solutions', () => {
    const { container } = render(<TradeOffChart points={POINTS} objectives={THREE} />);
    const region = screen.getByRole('region', { name: 'Trade-off set' });
    expect(within(region).getByRole('region', { name: 'Non-dominated solutions' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Solution', 'cost', 'latency', 'availability']);
    expect(rowTexts()).toEqual([
      ['Solution 1', '12', '440', '0.99'],
      ['Solution 2', '15', '412', '0.95'],
      ['Solution 4', '20', '300', '0.9'],
    ]);
    expect(screen.queryByText('Solution 3')).toBeNull();
    expect(screen.getByText('Not dominated: no other solution is at least as good on every objective and better on at least one.')).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('names the region by label', () => {
    render(<TradeOffChart points={POINTS} objectives={['cost', 'latency']} label="Pareto set of run 14" />);
    expect(screen.getByRole('region', { name: 'Pareto set of run 14' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Trade-off set' })).toBeNull();
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('formats numbers en-US with at most three decimals', () => {
    const p: TradeOffPoint = { id: 'p', label: 'P', values: { cost: 1234.5678, latency: 1 }, losses: { cost: 1234.5678, latency: 1 } };
    const q: TradeOffPoint = { id: 'q', label: 'Q', values: { cost: 0, latency: 2 }, losses: { cost: 0, latency: 2 } };
    render(<TradeOffChart points={[p, q]} objectives={['cost', 'latency']} />);
    expect(rowTexts().map((r) => r[1])).toEqual(['1,234.568', '0']);
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('names the chart by its summary', () => {
    render(<TradeOffChart points={POINTS} objectives={THREE} />);
    expect(screen.getByRole('img', { name: SUMMARY })).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('offers two native axis selects over the objectives', () => {
    render(<TradeOffChart points={POINTS} objectives={THREE} />);
    const h = screen.getByRole('combobox', { name: 'Horizontal axis' });
    const v = screen.getByRole('combobox', { name: 'Vertical axis' });
    expect(h).toHaveValue('cost');
    expect(v).toHaveValue('latency');
    for (const s of [h, v]) {
      expect(s.tagName).toBe('SELECT');
      expect(s).not.toHaveAttribute('tabindex', '-1');
      expect(within(s).getAllByRole('option').map((o) => o.textContent)).toEqual(THREE);
    }
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('changes the vertical axis without changing the table', () => {
    render(<TradeOffChart points={POINTS} objectives={THREE} />);
    const before = rowTexts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Vertical axis' }), { target: { value: 'availability' } });
    expect(screen.getByRole('img', { name: '4 solutions plotted by cost (horizontal) and availability (vertical); 3 not dominated: Solution 1 (12, 0.99); Solution 2 (15, 0.95); Solution 4 (20, 0.9)' })).toBeInTheDocument();
    expect(rowTexts()).toEqual(before);
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('swaps the axes when the same criterion is chosen twice', () => {
    render(<TradeOffChart points={POINTS} objectives={THREE} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Horizontal axis' }), { target: { value: 'latency' } });
    expect(screen.getByRole('combobox', { name: 'Horizontal axis' })).toHaveValue('latency');
    expect(screen.getByRole('combobox', { name: 'Vertical axis' })).toHaveValue('cost');
    expect(screen.getByRole('img', { name: '4 solutions plotted by latency (horizontal) and cost (vertical); 3 not dominated: Solution 1 (440, 12); Solution 2 (412, 15); Solution 4 (300, 20)' })).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('shows a text legend with decorative marks outside the image', () => {
    render(<TradeOffChart points={POINTS} objectives={['cost', 'latency']} />);
    const img = screen.getByRole('img');
    for (const text of ['not dominated', 'dominated']) {
      const item = screen.getByText(text);
      expect(img.contains(item)).toBe(false);
      expect(item.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('shows only the table and a note for one solution', () => {
    render(<TradeOffChart points={[POINTS[0]]} objectives={['cost', 'latency']} />);
    expect(screen.getByRole('region', { name: 'Trade-off set' })).toBeInTheDocument();
    expect(rowTexts()).toEqual([['Solution 1', '12', '440']]);
    expect(screen.getByText('A chart needs at least two solutions; this run has one.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('renders nothing for fewer than two objectives or no point', () => {
    for (const [points, objectives] of [[POINTS, ['cost']], [POINTS, []], [[], ['cost', 'latency']]] as const) {
      const { container, unmount } = render(<TradeOffChart points={points} objectives={objectives} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  // [utest->req~frontend-rendering-trade-off-chart~1]
  it('uses tokens only and a 24px target on the selects', () => {
    const css = readFileSync(join(__dirname, 'TradeOffChart.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toMatch(/select\s*\{[^}]*min-height:\s*24px/);
  });
});

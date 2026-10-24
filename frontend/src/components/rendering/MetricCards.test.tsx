import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricCards } from './MetricCards';

describe('MetricCards', () => {
  // [utest->req~frontend-rendering-metric-cards~1]
  it('renders a list named Key figures by default, or by label', () => {
    const metrics = [{ label: 'Cost', value: 3 }];
    const { unmount } = render(<MetricCards metrics={metrics} />);
    expect(screen.getByRole('list', { name: 'Key figures' })).toBeInTheDocument();
    unmount();

    render(<MetricCards metrics={metrics} label="Run totals" />);
    expect(screen.getByRole('list', { name: 'Run totals' })).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('renders each metric as a list item with the label as dt and the value as dd', () => {
    const { container } = render(<MetricCards metrics={[{ label: 'Cost', value: 7 }, { label: 'Latency', value: 9, unit: 'ms' }]} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('dl')).not.toBeNull();
    expect(items[0].querySelector('dt')).toHaveTextContent('Cost');
    expect(items[0].querySelector('dd')).toHaveTextContent('7');
    expect(items[1].querySelector('dd')).toHaveTextContent('9 ms');
    expect(container.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('formats numbers in en-US with at most three decimals, including 0', () => {
    render(<MetricCards metrics={[{ label: 'Zero', value: 0 }, { label: 'Big', value: 1234.5678 }]} />);

    const [zero, big] = screen.getAllByRole('listitem');
    expect(zero.querySelector('dd')).toHaveTextContent(/^0$/);
    expect(big.querySelector('dd')).toHaveTextContent(/^1,234\.568$/);
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('shows a string value as is', () => {
    render(<MetricCards metrics={[{ label: 'Engine', value: 'cp-sat 9.1' }]} />);

    expect(screen.getByRole('listitem').querySelector('dd')).toHaveTextContent('cp-sat 9.1');
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('shows a dash with the accessible text no value for null', () => {
    render(<MetricCards metrics={[{ label: 'Gap', value: null }]} />);

    const dd = screen.getByRole('listitem').querySelector('dd') as HTMLElement;
    expect(dd).toHaveTextContent('—');
    expect(within(dd).getByText('no value')).toHaveClass('sr-only');
    expect(within(dd).getByText('—')).toHaveAttribute('aria-hidden', 'true');
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('shows the trend label as visible text with an aria-hidden arrow', () => {
    render(
      <MetricCards
        metrics={[
          { label: 'A', value: 1, trend: { direction: 'up', label: '+5% vs last run' } },
          { label: 'B', value: 1, trend: { direction: 'down', label: '-2%' } },
          { label: 'C', value: 1, trend: { direction: 'flat', label: 'no change' } },
        ]}
      />,
    );

    const items = screen.getAllByRole('listitem');
    for (const [i, arrow, text] of [[0, '↑', '+5% vs last run'], [1, '↓', '-2%'], [2, '→', 'no change']] as const) {
      expect(within(items[i]).getByText(text)).toBeVisible();
      const glyph = within(items[i]).getByText(arrow);
      expect(glyph).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('shows the hint as small text and omits it when absent', () => {
    render(<MetricCards metrics={[{ label: 'A', value: 1, hint: 'lower is better' }, { label: 'B', value: 2 }]} />);

    const [a, b] = screen.getAllByRole('listitem');
    expect(within(a).getByText('lower is better').tagName).toBe('SMALL');
    expect(b.querySelector('small')).toBeNull();
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('accepts metrics with the same label when ids differ', () => {
    render(<MetricCards metrics={[{ id: 'x', label: 'Cost', value: 1 }, { id: 'y', label: 'Cost', value: 2 }]} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('renders nothing for empty metrics', () => {
    const { container } = render(<MetricCards metrics={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  // [utest->req~frontend-rendering-metric-cards~1]
  it('has no hard-coded hex colour in its stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/rendering/MetricCards.css'), 'utf8');

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

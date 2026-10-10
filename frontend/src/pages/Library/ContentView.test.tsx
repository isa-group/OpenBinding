import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContentView } from './ContentView';
import { catalogContent, catalogRangesContent } from './fixtures';

describe('ContentView of a candidate catalog', () => {
  it('shows numbers as they are and every kind of range in words', () => {
    render(<ContentView kind="CandidateCatalog" content={catalogRangesContent()} />);

    const stock = screen.getByRole('table', { name: 'Candidates for service/stock' });
    const cells = within(within(stock).getByRole('row', { name: /stockly-1/ })).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['stockly', '35–60', '≤ 0.004', '≥ 99.5']);
    const payment = screen.getByRole('table', { name: 'Candidates for service/payment' });
    expect(within(within(payment).getByRole('row', { name: /fastpay/ })).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['fastpay', '95', '0.034', '99.9']);
  });

  it('spells the interval out for whoever hovers or reads it', () => {
    render(<ContentView kind="CandidateCatalog" content={catalogRangesContent()} />);

    expect(screen.getByText('≤ 0.004')).toHaveAttribute('title', '(−∞, 0.004]');
    expect(screen.getByText('≥ 99.5')).toHaveAttribute('title', '[99.5, +∞)');
    expect(screen.getByText('35–60')).toHaveAttribute('title', '[35, 60]');
  });

  it('reads a range with no limits as unbounded', () => {
    const content = catalogContent() as { spec: { candidates: Record<string, { features: Record<string, unknown> }> } };
    content.spec.candidates['stockly-1'].features.latency_ms = { min: null, max: null };
    render(<ContentView kind="CandidateCatalog" content={content as never} />);

    expect(screen.getByText('unbounded')).toHaveAttribute('title', '(−∞, +∞)');
  });

  it('leaves a catalog without ranges exactly as it was', () => {
    render(<ContentView kind="CandidateCatalog" content={catalogContent()} />);

    const stock = screen.getByRole('table', { name: 'Candidates for service/stock' });
    expect(within(stock).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['stockly', '40', '0.002', '99.99']);
    expect(screen.queryByTitle(/∞/)).not.toBeInTheDocument();
  });
});

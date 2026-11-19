import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionMargins } from '../../api/types';
import margins100 from '../../../../test/fixtures/core/tomatometer.margins.1.0.0.json';
import { MarginTable } from '.';
import { isNegative, twoPlaces } from './money';

const margins = margins100 as unknown as CompositionMargins;

describe('the margin table', () => {
  it('draws one row per plan and single add-on, in the gateway’s order, with its caption', () => {
    render(<MarginTable margins={margins} />);
    const table = screen.getByRole('region', { name: 'Margin per plan' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(margins.rows.length);
    expect(rows.map(row => within(row).getAllByRole('cell')[0].textContent)).toEqual(
      margins.rows.map(row => row.planName)
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(head => head.textContent)
    ).toEqual(['Plan', 'Add-on', 'Basis', 'Revenue', 'Upstream cost', 'Margin']);
    const caption = table.querySelector('caption');
    expect(caption).toHaveTextContent(
      'Offering sphere/tomatometer 1.0.0, read when 1.0.0 was evaluated'
    );
    expect(caption).toHaveTextContent('1,000 users');
    expect(caption).toHaveTextContent('shared uniformly per user');
  });

  it('shows the gateway’s amounts to two places with the full value in a title, and a loss with its word', () => {
    render(<MarginTable margins={margins} />);
    const basic = screen.getAllByRole('row')[1];
    const margin = within(basic).getAllByRole('cell')[5];
    expect(margin).toHaveTextContent('−0.51loss');
    expect(within(margin).getByTitle('-0.508990 USD')).toBeInTheDocument();
    const advanced = screen.getAllByRole('row')[3];
    expect(within(advanced).getAllByRole('cell')[3]).toHaveTextContent('3.99');
    expect(within(advanced).getAllByRole('cell')[5]).toHaveTextContent('3.48');
    expect(within(advanced).getAllByRole('cell')[5]).not.toHaveTextContent('loss');
  });

  it('words every status instead of drawing numbers it does not have', () => {
    const status = (over: Partial<CompositionMargins>) =>
      render(<MarginTable margins={{ ...margins, ...over }} />);
    const { unmount } = status({ status: 'users_required', users: null });
    expect(screen.getByText('Set the number of users to see margins.')).toBeInTheDocument();
    unmount();
    status({ status: 'currency_mismatch', cost: { ...margins.cost!, unit: 'EUR/month' } });
    expect(
      screen.getByText('Costs are in EUR and the offering in USD: no exchange rates are applied.')
    ).toBeInTheDocument();
  });

  it('asks again with the users typed, saving nothing', () => {
    const onChange = vi.fn();
    render(<MarginTable margins={margins} users={{ value: '1000', onChange }} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Users' }), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith('3');
  });

  it('rounds the text and never reads an amount as a number', () => {
    expect(twoPlaces('-0.508990')).toBe('−0.51');
    expect(twoPlaces('11.481010')).toBe('11.48');
    expect(twoPlaces('9.995000')).toBe('10.00');
    expect(twoPlaces('-0.004000')).toBe('0.00');
    expect(twoPlaces('0.000000')).toBe('0.00');
    expect(isNegative('-0.000000')).toBe(false);
    expect(isNegative('-0.029990')).toBe(true);
    for (const file of ['index.tsx', 'money.ts']) {
      const source = readFileSync(
        `${process.cwd()}/src/modules/core/components/margin-table/${file}`,
        'utf8'
      );
      expect(source, file).not.toMatch(/parseFloat|parseInt|Number\(/);
    }
  });
});

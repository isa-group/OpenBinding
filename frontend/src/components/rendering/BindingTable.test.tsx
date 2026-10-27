import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BindingTable } from './BindingTable';
import { bindingFeaturesOf, bindingRowsOf, type BindingRow, type BindingProblemShape } from './bindingTableModel';

const PROBLEM: BindingProblemShape = {
  features: { latency: { unit: 'ms' }, cost: { unit: 'EUR' }, availability: { unit: null } },
  tasks: [
    {
      id: 'pay',
      name: 'Payment',
      candidates: [
        { id: 'stripe', name: 'Stripe Payments', provider: 'Stripe', features: { latency: 120, cost: 0.3, availability: 0.999 } },
        { id: 'adyen', name: 'Adyen', provider: 'Adyen', features: { latency: 90, cost: 0.25 } },
      ],
    },
    {
      id: 'ship',
      name: 'Shipping',
      candidates: [{ id: 'dhl', name: 'DHL Express', provider: 'DHL', features: { latency: { min: 200, max: 400 }, availability: 0.99 } }],
    },
  ],
};

const BINDING = { ship: { resource: 'carriers', id: 'dhl' }, pay: { resource: 'payments', id: 'stripe' } };
const PAYPAL = { pay: { resource: 'payments', id: 'paypal' } };

const full = () => <BindingTable rows={bindingRowsOf(BINDING, PROBLEM)} features={bindingFeaturesOf(PROBLEM)} />;
const headers = () => screen.getAllByRole('columnheader').map((cell) => cell.textContent);
const rowOf = (name: string) => screen.getByRole('rowheader', { name: new RegExp(`^${name}`) }).closest('tr') as HTMLElement;

describe('BindingTable', () => {
  // [utest->req~frontend-rendering-binding-table~1]
  it('renders a named focusable region with a table, scoped headers and rows in order', () => {
    render(full());
    const region = screen.getByRole('region', { name: 'Chosen providers' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toHaveStyle({ minWidth: '680px' });
    expect(headers()).toEqual(['Task', 'Candidate', 'Provider', 'latency (ms)', 'cost (EUR)', 'availability']);
    for (const header of screen.getAllByRole('columnheader')) expect(header).toHaveAttribute('scope', 'col');
    const rowHeaders = screen.getAllByRole('rowheader');
    expect(rowHeaders.map((cell) => cell.textContent)).toEqual(['Payment pay', 'Shipping ship']);
    for (const header of rowHeaders) expect(header).toHaveAttribute('scope', 'row');
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('shows names, ids, provider and values of a row, without totals', () => {
    render(full());
    const row = rowOf('Payment');
    const cells = within(row).getAllByRole('cell');
    expect(within(row).getByRole('rowheader').querySelector('code')).toHaveTextContent('pay');
    expect(cells[0]).toHaveTextContent('Stripe Payments');
    expect(cells[0].querySelector('code')).toHaveTextContent('stripe');
    expect(cells.slice(1).map((cell) => cell.textContent)).toEqual(['Stripe', '120', '0.3', '0.999']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.queryByText(/total/i)).toBeNull();
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('writes a range and a missing value', () => {
    render(full());
    const cells = within(rowOf('Shipping')).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('200–400');
    expect(cells[4]).toHaveTextContent('0.99');
    expect(cells[3].querySelector('[aria-hidden="true"]')).toHaveTextContent('—');
    expect(cells[3].querySelector('.sr-only')).toHaveTextContent('no value');
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('formats open ranges and numbers without repeating the unit', () => {
    const cases: Array<[BindingRow['values'][string], string]> = [
      [{ min: null, max: 500 }, '≤ 500'],
      [{ min: 100, max: null }, '≥ 100'],
      [{ min: null, max: null }, 'unbounded'],
      [1234.5678, '1,234.5678'],
    ];
    for (const [value, text] of cases) {
      const row: BindingRow = { task: 't', taskName: 't', candidate: 'c', candidateName: 'c', provider: null, values: { latency: value } };
      const { unmount } = render(<BindingTable rows={[row]} features={[{ name: 'latency', unit: 'ms' }]} />);
      const cell = screen.getAllByRole('cell')[1];
      expect(cell.textContent).toBe(text);
      expect(cell.textContent).not.toContain('ms');
      unmount();
    }
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('shows only Task and Candidate without the compiled problem', () => {
    render(<BindingTable rows={bindingRowsOf(BINDING, null)} />);
    expect(headers()).toEqual(['Task', 'Candidate']);
    expect(screen.getByRole('table')).toHaveStyle({ minWidth: '320px' });
    const first = screen.getAllByRole('row')[1];
    expect(within(first).getByRole('rowheader').innerHTML).toBe('<code>ship</code>');
    expect(within(first).getAllByRole('cell')[0].innerHTML).toBe('<code>dhl</code>');
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('shows the Provider column only when a provider is known', () => {
    const features = bindingFeaturesOf(PROBLEM);
    const { unmount } = render(<BindingTable rows={bindingRowsOf(PAYPAL, PROBLEM)} features={features} />);
    expect(headers()).not.toContain('Provider');
    expect(screen.getAllByText('no value')).toHaveLength(3);
    unmount();

    render(<BindingTable rows={bindingRowsOf({ ...PAYPAL, ship: { resource: 'carriers', id: 'dhl' } }, PROBLEM)} features={features} />);
    expect(headers()).toContain('Provider');
    expect(within(rowOf('Payment')).getAllByRole('cell')[1]).toHaveTextContent('no value');
    expect(within(rowOf('Shipping')).getAllByRole('cell')[1]).toHaveTextContent('DHL');
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('reads no value for a feature the rows do not carry', () => {
    render(<BindingTable rows={bindingRowsOf(BINDING, PROBLEM)} features={[{ name: 'energy', unit: 'J' }]} />);
    expect(headers()).toContain('energy (J)');
    for (const row of screen.getAllByRole('row').slice(1)) {
      expect(within(row).getAllByRole('cell').at(-1)).toHaveTextContent('no value');
    }
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('does not read inherited properties as values', () => {
    const row: BindingRow = { task: 't', taskName: 't', candidate: 'c', candidateName: 'c', provider: null, values: {} };
    render(<BindingTable rows={[row]} features={[{ name: 'toString', unit: null }]} />);
    expect(screen.getAllByRole('cell')[1]).toHaveTextContent('no value');
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('says so when the solution has no binding assignment', () => {
    const { container } = render(<BindingTable rows={[]} />);
    expect(screen.getByText('This solution carries no binding assignment.')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Chosen providers' })).toBeNull();
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('names the region by a custom label', () => {
    render(<BindingTable rows={bindingRowsOf(BINDING, null)} label="Solution 2 providers" />);
    const region = screen.getByRole('region', { name: 'Solution 2 providers' });
    expect(within(region).getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Chosen providers' })).toBeNull();
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('renders strings from the engine as text', () => {
    const row: BindingRow = {
      task: '<img src=x onerror=alert(1)>',
      taskName: '<img src=x onerror=alert(1)>',
      candidate: '<b>x</b>',
      candidateName: '<b>x</b>',
      provider: null,
      values: {},
    };
    const { container } = render(<BindingTable rows={[row]} />);
    expect(screen.getByRole('rowheader')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(screen.getAllByRole('cell')[0]).toHaveTextContent('<b>x</b>');
    const table = container.querySelector('table') as HTMLElement;
    expect(table.querySelector('img')).toBeNull();
    expect(table.querySelector('b')).toBeNull();
    expect(table.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-binding-table~1]
  it('uses tokens only and imports nothing from pages', () => {
    const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
    expect(read('BindingTable.css')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const source of ['BindingTable.tsx', 'bindingTableModel.ts']) {
      const imports = read(source).split('\n').filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line));
      for (const line of imports) expect(line).not.toContain('pages/');
    }
  });
});

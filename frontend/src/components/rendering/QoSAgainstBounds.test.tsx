import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QoSAgainstBounds } from './QoSAgainstBounds';
import { qosBoundsOf, type QoSBound, type QoSRule } from './qosBoundsModel';

const x = (name: string) => ({ kind: 'path', segments: ['features', name] });
const lit = (value: unknown) => ({ kind: 'literal', value });
const cmp = (op: string, left: unknown, right: unknown) => ({ kind: 'compare', op, left, right });
const ref = (id: string) => ({ resource: 'rules', id });

const QOS = [
  { ref: ref('max-latency'), enforcement: 'hard', when: lit(true), assert: cmp('lte', x('latency'), lit(600)) },
  { ref: ref('cost-band'), enforcement: 'soft', assert: { kind: 'and', left: cmp('lte', lit(2), x('cost')), right: cmp('lt', x('cost'), lit(10)) } },
  { ref: ref('busy-latency'), enforcement: 'hard', when: cmp('gt', x('load'), lit(5)), assert: cmp('lte', x('latency'), lit(400)) },
  { ref: ref('bundle-cost'), enforcement: 'hard', when: lit(true), assert: cmp('lte', { kind: 'arithmetic', op: 'add', left: x('cost'), right: x('fee') }, lit(12)) },
];
const FEATURES = { latency: 412, cost: 11.5, load: 3, fee: 0.25 };
const UNITS = { latency: 'ms', cost: 'EUR', load: null, fee: 'EUR' };
const VIOLATIONS = [{ constraint: ref('cost-band'), enforcement: 'soft', penalty: 2.5 }];

const bound = (extra: Partial<QoSBound> = {}): QoSBound => ({
  rule: 'r', feature: 'latency', op: 'lte', limit: 600, value: 412, unit: 'ms', enforcement: 'hard', met: true, ...extra,
});
const textRule = (extra: Partial<QoSRule> = {}): QoSRule => ({ rule: 'q', text: 'some text', when: null, enforcement: 'hard', met: true, ...extra });

const rowsOf = () => within(screen.getByRole('region', { name: 'Bounds' })).getAllByRole('row').slice(1);
const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);

describe('QoSAgainstBounds', () => {
  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('renders the Bounds table of a solution cell by cell', () => {
    const { bounds, rules } = qosBoundsOf(QOS, FEATURES, VIOLATIONS, UNITS);
    const { container } = render(<QoSAgainstBounds bounds={bounds} rules={rules} />);

    expect(screen.getByRole('region', { name: 'QoS against bounds' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Rule', 'Quality', 'Kind', 'Bound', 'Value', 'Margin', 'Status']);
    const rows = rowsOf();
    expect(rows.map(cellsOf)).toEqual([
      ['max-latency', 'latency', 'must', '≤ 600 ms', '412 ms', '188 ms below', 'met'],
      ['cost-band', 'cost', 'should', '≥ 2 EUR', '11.5 EUR', '9.5 EUR above', 'violated penalty 2.5'],
      ['cost-band', 'cost', 'should', '< 10 EUR', '11.5 EUR', '1.5 EUR above', 'violated penalty 2.5'],
    ]);
    rows.forEach((row) => expect(within(row).getAllByRole('cell')[0].firstElementChild?.tagName).toBe('CODE'));
    expect(within(screen.getByRole('region', { name: 'QoS against bounds' })).getByRole('region', { name: 'Bounds' })).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('lists the other rules with their condition', () => {
    const { bounds, rules } = qosBoundsOf(QOS, FEATURES, VIOLATIONS, UNITS);
    render(<QoSAgainstBounds bounds={bounds} rules={rules} />);

    const items = within(screen.getByRole('list', { name: 'Other rules' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('busy-latency').tagName).toBe('CODE');
    expect(items[0]).toHaveTextContent('features.latency ≤ 400');
    expect(items[0]).toHaveTextContent('applies when features.load > 5');
    expect(items[0]).toHaveTextContent('must');
    expect(items[0]).toHaveTextContent('met');
    expect(items[1]).toHaveTextContent('(features.cost + features.fee) ≤ 12');
    expect(items[1]).not.toHaveTextContent('applies when');
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('follows the gateway status, whatever the margin says', () => {
    const one = [QOS[0]];
    const { unmount } = render(<QoSAgainstBounds {...qosBoundsOf(one, { latency: 700 }, [], UNITS)} />);
    expect(cellsOf(rowsOf()[0]).slice(4)).toEqual(['700 ms', '100 ms above', 'met']);
    unmount();

    const violation = [{ constraint: ref('max-latency'), enforcement: 'hard', penalty: 0 }];
    render(<QoSAgainstBounds {...qosBoundsOf(one, { latency: 412 }, violation, UNITS)} />);
    const row = rowsOf()[0];
    expect(cellsOf(row).slice(4)).toEqual(['412 ms', '188 ms below', 'violated']);
    expect(within(row).getByText('violated')).toHaveClass('badge-error');
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it.each([undefined, null, {}])('says not checked when the violations are %j', (violations) => {
    const { bounds, rules } = qosBoundsOf(QOS, FEATURES, violations, UNITS);
    render(<QoSAgainstBounds bounds={bounds} rules={rules} />);

    expect(screen.getByText('Not checked: this solution carries no violations list from the gateway.')).toBeInTheDocument();
    const badges = screen.getAllByText('not checked');
    expect(badges).toHaveLength(5);
    badges.forEach((badge) => expect(badge).toHaveClass('badge-default'));
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('shows no not-checked paragraph when the list is there', () => {
    const { bounds, rules } = qosBoundsOf(QOS, FEATURES, [], UNITS);
    render(<QoSAgainstBounds bounds={bounds} rules={rules} />);

    expect(screen.queryByText(/Not checked/)).toBeNull();
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it.each([{ latency: 'fast' }, {}, undefined])('shows a dash and no value text for a missing value (%j)', (features) => {
    render(<QoSAgainstBounds {...qosBoundsOf([QOS[0]], features, [], UNITS)} />);

    const cells = within(rowsOf()[0]).getAllByRole('cell');
    for (const cell of [cells[4], cells[5]]) {
      expect(within(cell).getByText('—')).toHaveAttribute('aria-hidden', 'true');
      expect(within(cell).getByText('no value')).toHaveClass('sr-only');
      expect(cell).not.toHaveTextContent('ms');
    }
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('reads at the limit, and no trailing space without a unit', () => {
    render(<QoSAgainstBounds bounds={[bound({ value: 600 }), bound({ unit: null })]} rules={[]} />);

    const [equal, bare] = rowsOf().map(cellsOf);
    expect(equal[5]).toBe('at the limit');
    expect(bare.slice(3, 5)).toEqual(['≤ 600', '412']);
    expect(bare[5]).toBe('188 below');
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('names the status in words with the right badge variant', () => {
    render(
      <QoSAgainstBounds
        bounds={[
          bound({ met: true }),
          bound({ met: false }),
          bound({ met: false, enforcement: 'soft', penalty: 2.5 }),
          bound({ met: null, enforcement: 'soft' }),
        ]}
        rules={[textRule({ met: false, enforcement: 'soft', penalty: 2 })]}
      />,
    );

    const status = rowsOf().map((row) => within(row).getAllByRole('cell')[6]);
    expect(status[0].querySelector('.badge')).toHaveClass('badge-success');
    expect(status[0]).toHaveTextContent(/^met$/);
    expect(status[1].querySelector('.badge')).toHaveClass('badge-error');
    expect(status[1]).toHaveTextContent(/^violated$/);
    expect(status[2].querySelector('.badge')).toHaveClass('badge-warning');
    expect(status[2].textContent).toBe('violated penalty 2.5');
    expect(status[3].querySelector('.badge')).toHaveClass('badge-default');
    expect(status[3]).toHaveTextContent(/^not checked$/);

    const item = screen.getByRole('listitem');
    expect(within(item).getByText('violated')).toHaveClass('badge-warning');
    expect(item).toHaveTextContent('violated penalty 2');
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('renders only the part it was given', () => {
    const { unmount } = render(<QoSAgainstBounds bounds={[]} rules={[textRule()]} />);
    expect(screen.queryByRole('region', { name: 'Bounds' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    unmount();

    render(<QoSAgainstBounds bounds={[bound()]} rules={[]} />);
    expect(screen.queryByRole('list', { name: 'Other rules' })).toBeNull();
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('says there is nothing to check', () => {
    render(<QoSAgainstBounds bounds={[]} rules={[]} />);

    const region = screen.getByRole('region', { name: 'QoS against bounds' });
    expect(region).toHaveTextContent(/^No rules to check\.$/);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('takes the region name from label', () => {
    render(<QoSAgainstBounds bounds={[]} rules={[]} label="Solution 2 against bounds" />);

    expect(screen.getByRole('region', { name: 'Solution 2 against bounds' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'QoS against bounds' })).toBeNull();
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('formats numbers in en-US with at most three decimals', () => {
    render(
      <QoSAgainstBounds
        bounds={[bound({ feature: 'cost', limit: 1000, value: 1234.5678, unit: null, enforcement: 'soft', met: false, penalty: 0.1234 })]}
        rules={[]}
      />,
    );

    expect(cellsOf(rowsOf()[0]).slice(3)).toEqual(['≤ 1,000', '1,234.568', '234.568 above', 'violated penalty 0.123']);
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('renders gateway and problem text as text', () => {
    const { container } = render(
      <QoSAgainstBounds bounds={[]} rules={[textRule({ rule: '<i>r</i>', text: '<b>Pool</b> edge full', met: false })]} />,
    );

    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('<i>r</i>');
    expect(item).toHaveTextContent('<b>Pool</b> edge full');
    expect(container.querySelector('b, i, pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-qos-against-bounds~1]
  it('uses tokens only and imports nothing from pages', () => {
    const dir = join(process.cwd(), 'src/components/rendering');
    expect(readFileSync(join(dir, 'QoSAgainstBounds.css'), 'utf8')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const file of ['QoSAgainstBounds.tsx', 'qosBoundsModel.ts']) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/(from\s*|import\s*\(?\s*)['"][^'"]*pages\//);
    }
  });
});

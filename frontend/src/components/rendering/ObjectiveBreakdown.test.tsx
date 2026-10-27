import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ObjectiveBreakdown } from './ObjectiveBreakdown';
import { objectiveTermsOf, type ObjectiveBreakdownData, type ObjectiveTerm } from './objectiveModel';

const OBJ_SINGLE = {
  type: 'SINGLE', scalarization: 'weighted-sum', penalty: 2, score: 2.375,
  components: [
    { criteria: 'fast', feature: { resource: 'app', id: 'latency' }, value: 350, loss: 0.25, weight: 0.5 },
    { criteria: 'reliable', feature: { resource: 'app', id: 'availability' }, value: 99.5, loss: 0.5, weight: 0.5 },
  ],
};
const OBJ_LEX = {
  ...OBJ_SINGLE, type: 'MULTI', scalarization: 'lexicographic', penalty: 0, score: [0.25, 0.5, 0],
  components: OBJ_SINGLE.components.map((c) => ({ ...c, weight: 0 })),
};
const PROBLEM = {
  criteria: [{ id: 'fast', direction: 'minimize' as const }, { id: 'reliable', direction: 'maximize' as const }],
  features: { latency: { unit: 'ms' }, availability: { unit: '%' } },
};
const single = () => objectiveTermsOf(OBJ_SINGLE, PROBLEM) as ObjectiveBreakdownData;
const lex = () => objectiveTermsOf(OBJ_LEX, PROBLEM) as ObjectiveBreakdownData;
const term = (over: Partial<ObjectiveTerm> = {}): ObjectiveTerm => ({
  criterion: 'c', feature: null, direction: null, unit: null, value: null, loss: null, weight: null, weighted: null, ...over,
});
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);

describe('ObjectiveBreakdown', () => {
  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('renders a region named by label with the summary', () => {
    const { unmount, container } = render(<ObjectiveBreakdown {...single()} />);
    const region = screen.getByRole('region', { name: 'Objective breakdown' });
    expect(Array.from(region.querySelectorAll('dt')).map((e) => e.textContent)).toEqual(['Scalarization', 'Score', 'Penalty']);
    expect(Array.from(container.querySelectorAll('dd')).map((e) => e.textContent)).toEqual(['weighted-sum', '2.375', '2']);
    unmount();

    render(<ObjectiveBreakdown {...single()} label="Solution 1 objective" />);
    expect(screen.getByRole('region', { name: 'Solution 1 objective' })).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('renders the terms table of a weighted sum with its total', () => {
    render(<ObjectiveBreakdown {...single()} />);
    const region = screen.getByRole('region', { name: 'Objective terms' });
    expect(within(region).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Criterion', 'Feature', 'Direction', 'Value', 'Loss', 'Weight', 'Weighted loss',
    ]);
    const rows = within(region).getAllByRole('row');
    expect(within(rows[1]).getByRole('rowheader')).toHaveTextContent('fast');
    expect(cells(rows[1])).toEqual(['latency', 'lower is better', '350 ms', '0.25', '0.5', '0.125']);
    expect(within(rows[2]).getByRole('rowheader')).toHaveTextContent('reliable');
    expect(cells(rows[2])).toEqual(['availability', 'higher is better', '99.5 %', '0.5', '0.5', '0.25']);
    const footer = region.querySelectorAll('tfoot tr');
    expect(footer).toHaveLength(1);
    expect(within(footer[0] as HTMLElement).getByRole('rowheader')).toHaveTextContent('Total weighted loss');
    expect(footer[0]).toHaveTextContent('0.375');
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('renders a list score by criterion, without weight columns or total', () => {
    const { container } = render(<ObjectiveBreakdown {...lex()} />);
    const list = screen.getByRole('list', { name: 'Score' });
    expect(container.querySelectorAll('dd')[1]).toContainElement(list);
    expect(within(list).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['fast: 0.25', 'reliable: 0.5', 'Penalty: 0']);
    const region = screen.getByRole('region', { name: 'Objective terms' });
    expect(within(region).queryByRole('columnheader', { name: 'Weight' })).toBeNull();
    expect(within(region).queryByRole('columnheader', { name: 'Weighted loss' })).toBeNull();
    expect(screen.queryByText('Total weighted loss')).toBeNull();
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('names list score positions for lists of another length', () => {
    const { unmount } = render(<ObjectiveBreakdown {...lex()} score={[0.25]} />);
    expect(within(screen.getByRole('list', { name: 'Score' })).getAllByRole('listitem').map((i) => i.textContent)).toEqual(['fast: 0.25']);
    unmount();

    render(<ObjectiveBreakdown {...lex()} score={[1, 2, 3, 4]} />);
    expect(within(screen.getByRole('list', { name: 'Score' })).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      'fast: 1', 'reliable: 2', 'Penalty: 3', 'Entry 4: 4',
    ]);
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('keeps the weight columns but drops the total for a weighted sum with a list score', () => {
    render(<ObjectiveBreakdown {...single()} score={[0.25, 0.5, 2]} />);
    expect(screen.getByRole('columnheader', { name: 'Weight' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Weighted loss' })).toBeInTheDocument();
    expect(screen.queryByText('Total weighted loss')).toBeNull();
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('shows a dash read as no value for missing data', () => {
    const props = { terms: [term({ unit: 'ms' })], score: null, penalty: null };
    const { container, unmount } = render(<ObjectiveBreakdown {...props} scalarization="weighted-sum" />);
    const expectMissing = (el: Element) => {
      expect(el.querySelector('[aria-hidden="true"]')).toHaveTextContent('—');
      expect(el.querySelector('.sr-only')).toHaveTextContent('no value');
    };
    const body = container.querySelectorAll('tbody td');
    expect(body).toHaveLength(6);
    body.forEach(expectMissing);
    expect(body[2]).not.toHaveTextContent('ms');
    expectMissing(container.querySelector('tfoot td') as Element);
    const dds = container.querySelectorAll('dd');
    expectMissing(dds[1]);
    expectMissing(dds[2]);
    unmount();

    const { container: c2 } = render(<ObjectiveBreakdown {...props} scalarization={null} />);
    expectMissing(c2.querySelectorAll('dd')[0]);
    expect(screen.queryByRole('columnheader', { name: 'Weight' })).toBeNull();
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('shows no value for the total when a weighted loss is missing', () => {
    const data = single();
    data.terms[1] = { ...data.terms[1], weighted: null };
    const { container } = render(<ObjectiveBreakdown {...data} />);
    const total = container.querySelector('tfoot td') as Element;
    expect(total).toHaveTextContent('—');
    expect(total).toHaveTextContent('no value');
    expect(total).not.toHaveTextContent('0.125');
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('formats numbers in en-US with at most three decimals', () => {
    const terms = [0, 1234.5678, -99.5].map((value, i) => term({ criterion: `c${i}`, value }));
    const { container } = render(<ObjectiveBreakdown terms={terms} score={1} penalty={0} scalarization="feasibility" />);
    const values = Array.from(container.querySelectorAll('tbody tr')).map((r) => r.querySelectorAll('td')[2].textContent);
    expect(values).toEqual(['0', '1,234.568', '-99.5']);
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('shows a note and no table without terms', () => {
    const { container } = render(<ObjectiveBreakdown terms={[]} scalarization="feasibility" score={0} penalty={0} />);
    expect(screen.getByText('No objective terms')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
    expect(Array.from(container.querySelectorAll('dt')).map((e) => e.textContent)).toEqual(['Scalarization', 'Score', 'Penalty']);
    expect(Array.from(container.querySelectorAll('dd')).map((e) => e.textContent)).toEqual(['feasibility', '0', '0']);
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('renders strings as text only', () => {
    const data = single();
    data.terms[0] = { ...data.terms[0], criterion: '<b>fast</b>' };
    const { container } = render(<ObjectiveBreakdown {...data} scalarization="<i>sum</i>" />);
    expect(screen.getByText('<b>fast</b>')).toBeInTheDocument();
    expect(screen.getByText('<i>sum</i>')).toBeInTheDocument();
    expect(container.querySelector('b, i, pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-objective-breakdown~1]
  it('uses tokens only in its stylesheet', () => {
    const css = readFileSync(join(__dirname, 'ObjectiveBreakdown.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

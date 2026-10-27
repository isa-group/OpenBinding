import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvaluationDiff } from './EvaluationDiff';
import type { RunValues } from './evaluationDiffModel';

const EVAL: RunValues = {
  termination: 'FEASIBLE',
  solutions: [
    { features: { latency: 120, cost: 3.5 }, score: 0.42 },
    { features: { latency: 90, cost: 5 }, score: 0.47 },
  ],
};
const claim = (change?: (c: RunValues) => void): RunValues => {
  const c = structuredClone(EVAL);
  change?.(c);
  return c;
};

const bodyRows = () =>
  within(screen.getByRole('region', { name: 'Differences' }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

describe('EvaluationDiff', () => {
  // [utest->req~frontend-rendering-evaluation-diff~1]
  it.each([undefined, null])('says the claim is not kept when claimed is %s', (claimed) => {
    render(<EvaluationDiff evaluated={EVAL} claimed={claimed} />);
    const region = screen.getByRole('region', { name: 'Claimed and evaluated values' });
    expect(region).toHaveTextContent('The values the engine claimed are not kept for this run. Gateway evaluation: FEASIBLE, 2 solutions.');
    expect(screen.queryByRole('region', { name: 'Differences' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('uses singulars and the no termination text', () => {
    render(<EvaluationDiff evaluated={{ termination: null, solutions: [{ features: {} }] }} />);
    expect(screen.getByText(/Gateway evaluation: no termination, 1 solution\./)).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('says the claim agrees within the tolerance', () => {
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features!.latency = 120.0000000005; })} />);
    expect(screen.getByText('The engine claim agrees with the gateway evaluation: FEASIBLE, 2 solutions.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('lists one differing feature with its headers', () => {
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features!.latency = 100; })} />);
    expect(screen.getByText('The engine claim differs from the gateway evaluation in 1 value.')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Solution', 'Value', 'Engine claimed', 'Gateway evaluated']);
    expect(bodyRows()).toEqual([['1', 'latency', '100', '120']]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('lists termination and score differences', () => {
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.termination = 'OPTIMAL'; c.solutions[1].score = 0.45; })} />);
    expect(screen.getByText('The engine claim differs from the gateway evaluation in 2 values.')).toBeInTheDocument();
    expect(bodyRows()).toEqual([['Run', 'Termination', 'OPTIMAL', 'FEASIBLE'], ['2', 'Score', '0.45', '0.47']]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('names missing, extra and non-numeric features', () => {
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features = { latency: 'fast', availability: 0.99 }; })} />);
    expect(bodyRows()).toEqual([
      ['1', 'latency', 'not a number', '120'],
      ['1', 'cost', 'not stated', '3.5'],
      ['1', 'availability', '0.99', 'not evaluated'],
    ]);
    expect(screen.getByText(/in 3 values\./)).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('compares solutions one by one only with equal counts', () => {
    render(
      <EvaluationDiff
        evaluated={EVAL}
        claimed={claim((c) => { c.solutions.push({ features: { latency: 80, cost: 9 }, score: 0.5 }); c.solutions[0].features!.latency = 100; })}
      />,
    );
    expect(bodyRows()).toEqual([['Run', 'Solutions', '3', '2']]);
    expect(screen.getByText('Solutions are compared one by one only when both sides have the same number of solutions.')).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('shows score lists by component or whole', () => {
    const ev: RunValues = claim((c) => { c.solutions[0].score = [0.4, 0.6]; });
    const { unmount } = render(<EvaluationDiff evaluated={ev} claimed={claim((c) => { c.solutions[0].score = [0.4, 0.5]; })} />);
    expect(bodyRows()).toEqual([['1', 'Score, component 2', '0.5', '0.6']]);
    unmount();
    render(<EvaluationDiff evaluated={ev} claimed={claim((c) => { c.solutions[0].score = 0.4; })} />);
    expect(bodyRows()).toEqual([['1', 'Score', '0.4', '0.4, 0.6']]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('formats numbers and keeps values apart that read the same at six decimals', () => {
    const { unmount } = render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features!.latency = 1234.5; })} />);
    expect(bodyRows()).toEqual([['1', 'latency', '1,234.5', '120']]);
    unmount();
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features!.latency = 120.000000002; })} />);
    expect(bodyRows()).toEqual([['1', 'latency', '120.000000002', '120']]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('reads the canonical fallbacks', () => {
    render(
      <EvaluationDiff
        evaluated={{ termination: 'FEASIBLE', solutions: [{ metrics: { latency: 120 }, objectives: { score: 0.42 } }] }}
        claimed={{ termination: 'FEASIBLE', solutions: [{ features: { latency: 120 }, score: 0.42 }] }}
      />,
    );
    expect(screen.getByText('The engine claim agrees with the gateway evaluation: FEASIBLE, 1 solution.')).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('does not throw on a malformed claim', () => {
    render(<EvaluationDiff evaluated={EVAL} claimed={{ termination: 7, solutions: 'many' } as unknown as RunValues} />);
    expect(bodyRows()).toEqual([['Run', 'Termination', 'no termination', 'FEASIBLE'], ['Run', 'Solutions', '0', '2']]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('shows prototype property names as feature names', () => {
    render(
      <EvaluationDiff
        evaluated={EVAL}
        claimed={claim((c) => { c.solutions[0].features = JSON.parse('{"latency":120,"cost":3.5,"constructor":1,"__proto__":2}'); })}
      />,
    );
    expect(bodyRows()).toEqual([['1', 'constructor', '1', 'not evaluated'], ['1', '__proto__', '2', 'not evaluated']]);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('shows engine text as text inside bdi', () => {
    const img = '<img src=x onerror=alert(1)>';
    const note = '<b>bold</b> **x** https://example.org';
    const { container } = render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.termination = img; })} notes={[note]} />);
    expect(container.querySelector('img, b, a')).toBeNull();
    expect(screen.getByText(img).tagName).toBe('BDI');
    expect(screen.getByText(note).tagName).toBe('BDI');
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('isolates direction controls in their own bdi', () => {
    const RLO = String.fromCodePoint(0x202e);
    render(
      <EvaluationDiff
        evaluated={EVAL}
        claimed={claim((c) => { c.solutions[0].features = { latency: 120, cost: 3.5, [`${RLO}cost`]: 1 }; })}
        notes={[`${RLO}evil`]}
      />,
    );
    const bdis = Array.from(document.querySelectorAll('bdi')).map((b) => b.textContent);
    expect(bdis).toContain(`${RLO}evil`);
    expect(bdis).toContain(`${RLO}cost`);
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('shortens long engine text at 500 code points', () => {
    const emoji = '\u{1F600}';
    render(<EvaluationDiff evaluated={EVAL} notes={['x'.repeat(600), `${'x'.repeat(499)}${emoji}${emoji}`, 'y'.repeat(500)]} />);
    const items = within(screen.getByRole('list', { name: 'Engine notes' })).getAllByRole('listitem');
    expect(items[0].textContent).toBe(`${'x'.repeat(500)}…`);
    expect(items[1].textContent).toBe(`${'x'.repeat(499)}${emoji}…`);
    expect(items[2].textContent).toBe('y'.repeat(500));
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('lists engine notes, skipping blanks, and omits the list when empty', () => {
    const { unmount } = render(<EvaluationDiff evaluated={EVAL} notes={['Solved with presolve', '', '  ', 'Gap 0.1%']} />);
    const items = within(screen.getByRole('list', { name: 'Engine notes' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Solved with presolve', 'Gap 0.1%']);
    unmount();
    const empty = render(<EvaluationDiff evaluated={EVAL} notes={[]} />);
    expect(screen.queryByRole('list', { name: 'Engine notes' })).toBeNull();
    empty.unmount();
    render(<EvaluationDiff evaluated={EVAL} />);
    expect(screen.queryByRole('list', { name: 'Engine notes' })).toBeNull();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('lists the downgrade reasons', () => {
    const { unmount } = render(
      <EvaluationDiff
        evaluated={EVAL}
        claimed={claim()}
        downgrades={[
          { code: 'termination-changed', message: 'The engine claimed OPTIMAL without proof.' },
          { code: 'solution-dropped', message: 'Malformed decision.', solution: 2 },
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Why the gateway changed the result' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('The engine claimed OPTIMAL without proof.');
    expect(within(items[0]).getByText('termination-changed').tagName).toBe('CODE');
    expect(items[1]).toHaveTextContent('Solution 3');
    expect(items[1]).toHaveTextContent('Malformed decision.');
    expect(within(items[1]).getByText('solution-dropped').tagName).toBe('CODE');
    unmount();
    render(<EvaluationDiff evaluated={EVAL} claimed={claim()} downgrades={[]} />);
    expect(screen.queryByRole('list', { name: 'Why the gateway changed the result' })).toBeNull();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('drops malformed downgrades and fields', () => {
    const bad = [
      { code: '', message: 'empty code' },
      { code: 'c', message: '' },
      { code: 5, message: 'numeric code', solution: -1 },
      { code: 'x', message: 'fractional', solution: 1.5 },
    ] as unknown as Array<{ code: string; message: string; solution?: number }>;
    render(<EvaluationDiff evaluated={EVAL} downgrades={bad} />);
    const list = screen.getByRole('list', { name: 'Why the gateway changed the result' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.querySelector('bdi')?.textContent)).toEqual(['empty code', 'numeric code', 'fractional']);
    expect(list.textContent).not.toMatch(/Solution/);
    expect(items[0].querySelector('code')).toBeNull();
    expect(items[1].querySelector('code')).toBeNull();
    expect(items[2].querySelector('code')).not.toBeNull();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('uses singular wording for one hidden difference or note', () => {
    const features: Record<string, number> = { latency: 120, cost: 3.5 };
    for (let i = 1; i <= 101; i += 1) features[`f${i}`] = 1;
    const notes = Array.from({ length: 21 }, (_, i) => `n${i}`);
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features = features; })} notes={notes} />);
    expect(screen.getByText('1 more difference is not shown.')).toBeInTheDocument();
    expect(screen.getByText('1 more note is not shown.')).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('caps rows at 100 and notes at 20', () => {
    const features: Record<string, number> = { latency: 120, cost: 3.5 };
    for (let i = 1; i <= 150; i += 1) features[`f${String(i).padStart(3, '0')}`] = 1;
    const notes = Array.from({ length: 25 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`);
    render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features = features; })} notes={notes} />);
    expect(screen.getByText('The engine claim differs from the gateway evaluation in 150 values.')).toBeInTheDocument();
    const rows = bodyRows();
    expect(rows).toHaveLength(100);
    expect(rows[99][1]).toBe('f100');
    expect(screen.getByText('50 more differences are not shown.')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Engine notes' })).getAllByRole('listitem');
    expect(items).toHaveLength(20);
    expect(items[19]).toHaveTextContent('n20');
    expect(screen.getByText('5 more notes are not shown.')).toBeInTheDocument();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('takes a custom label and renders no pre', () => {
    const { container } = render(<EvaluationDiff evaluated={EVAL} claimed={claim((c) => { c.solutions[0].features!.latency = 1; })} label="Engine check" />);
    expect(screen.getByRole('region', { name: 'Engine check' })).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  // [utest->req~frontend-rendering-evaluation-diff~1]
  it('uses no hex colour in its stylesheet', () => {
    const css = readFileSync(join(__dirname, 'EvaluationDiff.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

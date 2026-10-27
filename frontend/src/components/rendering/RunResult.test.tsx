import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunResult } from './RunResult';
import { CONSTRAINTS, PROBLEM, REPORT, RESULT, S1, S2 } from './runResultFixtures';

const NO_PROBLEM_NOTE =
  'The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.';

type Props = Parameters<typeof RunResult>[0];

const show = (props: Partial<Props> = {}) => render(<RunResult result={RESULT} problem={PROBLEM} constraints={CONSTRAINTS} {...props} />);
const run = () => screen.getByRole('region', { name: 'Run result' });
const resultWith = (extra: Record<string, unknown>) => ({ ...RESULT, ...extra });
const region = (name: string, hidden = false) => screen.getByRole('region', { name, hidden });
const maybeRegion = (name: string, hidden = false) => screen.queryByRole('region', { name, hidden });

/** The text of the region without the `View source` disclosure. */
function textOutsideSource(): string {
  const copy = run().cloneNode(true) as HTMLElement;
  copy.querySelectorAll('details').forEach((details) => {
    if (details.querySelector('summary')?.textContent === 'View source') details.remove();
  });
  return copy.textContent ?? '';
}

const detailsOf = (summary: string | RegExp) => {
  const found = [...run().querySelectorAll('details')].find((d) => {
    const text = d.querySelector('summary')?.textContent ?? '';
    return typeof summary === 'string' ? text === summary : summary.test(text);
  });
  if (!found) throw new Error(`no details summarised ${String(summary)}`);
  return found;
};

const follows = (before: Element, after: Element) => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
const expectInOrder = (nodes: Element[]) => {
  for (let i = 1; i < nodes.length; i += 1) expect(follows(nodes[i - 1], nodes[i])).toBe(true);
};

const qualityList = () => screen.getByRole('list', { name: 'Quality of this combination' });
const boundRow = (rule: string) => within(region('QoS against bounds')).getByText(rule).closest('tr') as HTMLElement;

describe('RunResult', () => {
  describe('composition order', () => {
    // [utest->req~frontend-rendering-run-result-order~1]
    it('shows the full run in order', () => {
      show({ report: REPORT, notice: <p>Notice</p>, children: <p>Extras</p> });
      const scope = within(run());
      const source = detailsOf('View source');
      const log = detailsOf(/^Engine log/);

      expectInOrder([
        scope.getByText('FEASIBLE'),
        scope.getByText('2 solutions · optimization MULTI'),
        scope.getByText('Notice'),
        scope.getByRole('combobox', { name: /Show solution/ }),
        scope.getByRole('list', { name: 'Quality of this combination' }),
        scope.getByRole('region', { name: 'Chosen providers' }),
        scope.getByRole('region', { name: 'QoS against bounds' }),
        scope.getByRole('region', { name: 'Objective breakdown' }),
        scope.getByRole('region', { name: 'Claimed and evaluated values' }),
        scope.getByRole('region', { name: 'Trade-off set' }),
        scope.getByText('Extras'),
        source,
        log,
      ]);
      expect(source.open).toBe(false);
      expect(log.open).toBe(false);
    });

    // [utest->req~frontend-rendering-run-result-order~1]
    it('shows a run without solutions', () => {
      show({ result: resultWith({ solutions: [], logs: undefined }) });
      const scope = within(run());

      expect(scope.getByText('FEASIBLE')).toBeInTheDocument();
      expect(scope.getByText('0 solutions')).toBeInTheDocument();
      expect(scope.getByText('This run finished without producing a binding.')).toBeInTheDocument();
      expect(scope.getByRole('region', { name: 'Claimed and evaluated values' })).toBeInTheDocument();

      expect(scope.queryByRole('combobox', { name: /Show solution/ })).toBeNull();
      expect(scope.queryByRole('list', { name: 'Quality of this combination' })).toBeNull();
      for (const name of ['Chosen providers', 'QoS against bounds', 'Objective breakdown', 'Trade-off set']) {
        expect(scope.queryByRole('region', { name, hidden: true })).toBeNull();
      }
      expect(scope.queryByText('View source')).toBeNull();
      expect(scope.queryByText(/^Engine log/)).toBeNull();
    });

    // [utest->req~frontend-rendering-run-result-order~1]
    it('shows a solution without figures or objectives', () => {
      const bare = { decision: S1.decision, violations: S1.violations };
      show({ result: resultWith({ solutions: [bare] }) });

      expect(screen.queryByRole('list', { name: 'Quality of this combination' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Objective breakdown' })).toBeNull();
      expect(region('Chosen providers')).toBeInTheDocument();
      expect(region('QoS against bounds')).toBeInTheDocument();
    });
  });

  describe('verdict', () => {
    // [utest->req~frontend-rendering-run-result-verdict~1]
    it('shows each API termination as the first element', () => {
      for (const termination of ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN']) {
        show({ result: resultWith({ termination }) });
        const first = run().firstElementChild as HTMLElement;
        const badge = within(first).getByText(termination);
        expect(badge).toHaveClass('badge');
        if (termination === 'INFEASIBLE') expect(badge).toHaveClass('badge-error');
        cleanup();
      }
    });

    // [utest->req~frontend-rendering-run-result-verdict~1]
    it('shows UNKNOWN without a termination', () => {
      const terminations: unknown[] = [undefined, null, '', 7];
      for (const termination of terminations) {
        show({ result: resultWith({ termination }) });
        const first = run().firstElementChild as HTMLElement;
        expect(within(first).getByText('UNKNOWN')).toHaveClass('badge');
        expect(first.querySelector('.sr-only')).toHaveTextContent(', no conclusion');
        cleanup();
      }
    });
  });

  describe('solution choice', () => {
    // [utest->req~frontend-rendering-run-result-solution-choice~1]
    it('shows the second solution once chosen', () => {
      show({ constraints: CONSTRAINTS });
      const select = screen.getByRole('combobox', { name: /Show solution/ });
      const options = within(select).getAllByRole('option');

      expect(options.map((o) => o.textContent)).toEqual(['Solution 1', 'Solution 2']);
      expect(within(qualityList()).getByText('latency').closest('li')).toHaveTextContent(/latency.*420/);

      const second = options.find((o) => o.textContent === 'Solution 2') as HTMLOptionElement;
      fireEvent.change(select, { target: { value: second.value } });

      expect(within(qualityList()).getByText('latency').closest('li')).toHaveTextContent(/latency.*560/);
      expect(within(qualityList()).getByText('latency').closest('li')).not.toHaveTextContent('420');
      expect(region('Solution 2 source', true)).toBeInTheDocument();
      expect(maybeRegion('Solution 1 source', true)).toBeNull();
      expect(region('Claimed and evaluated values')).toHaveTextContent(/FEASIBLE, 2 solutions\.$/);
      const table = within(region('Non-dominated solutions'));
      expect(table.getByText('Solution 1')).toBeInTheDocument();
      expect(table.getByText('Solution 2')).toBeInTheDocument();
    });

    // [utest->req~frontend-rendering-run-result-solution-choice~1]
    it('offers no choice for one solution', () => {
      show({ result: resultWith({ solutions: [S1] }) });

      expect(screen.queryByRole('combobox', { name: /Show solution/ })).toBeNull();
      expect(region('Solution 1 source', true)).toBeInTheDocument();
    });
  });

  describe('canonical shape', () => {
    // [utest->req~frontend-rendering-run-result-canonical-shape~1]
    it('lets features win over metrics', () => {
      show({ result: resultWith({ solutions: [{ ...S1, metrics: { latency: 999, cost: 1 } }, S2] }) });

      const items = within(qualityList()).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent(/latency.*420.*ms/);
      expect(items[1]).toHaveTextContent(/cost.*9\.5.*EUR/);
      expect(within(boundRow('max-latency')).getByText('420 ms')).toBeInTheDocument();
      expect(textOutsideSource()).not.toContain('999');
    });

    // [utest->req~frontend-rendering-run-result-canonical-shape~1]
    it('falls back to metrics', () => {
      const { features: _features, ...rest } = S1;
      show({ result: resultWith({ solutions: [{ ...rest, metrics: { latency: 300 } }] }) });

      expect(within(qualityList()).getAllByRole('listitem')[0]).toHaveTextContent(/latency.*300.*ms/);
      expect(within(boundRow('max-latency')).getByText('300 ms')).toBeInTheDocument();
    });

    // [utest->req~frontend-rendering-run-result-canonical-shape~1]
    it('reads type and scalarization, not mode', () => {
      const withMode = (s: typeof S1) => ({ ...s, objectives: { ...s.objectives, mode: 'legacy-mode' } });
      show({ result: resultWith({ solutions: [withMode(S1), withMode(S2)] }) });

      expect(within(run()).getByText('2 solutions · optimization MULTI')).toBeInTheDocument();
      const dd = within(region('Objective breakdown')).getByText('Scalarization').nextElementSibling;
      expect(dd).toHaveTextContent('pareto');
      expect(textOutsideSource()).not.toContain('legacy-mode');
    });

    // [utest->req~frontend-rendering-run-result-canonical-shape~1]
    it('leaves out non-numeric figures', () => {
      const features = { latency: 'fast', cost: 9.5, region: { min: 1, max: 2 } };
      show({ result: resultWith({ solutions: [{ ...S1, features }] }), constraints: undefined });

      const items = within(qualityList()).getAllByRole('listitem');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent(/cost.*9\.5.*EUR/);
    });
  });

  describe('names', () => {
    // [utest->req~frontend-rendering-run-result-names~1]
    it('identifies tasks and candidates by name', () => {
      show();
      const table = within(region('Chosen providers'));
      const row = table.getByRole('rowheader', { name: /^Payment/ }).closest('tr') as HTMLElement;

      const cells = within(row).getAllByRole('cell');
      expect(cells[0]).toHaveTextContent('Stripe EU');
      expect(cells[1]).toHaveTextContent('Stripe');
      expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Task', 'Candidate', 'Provider', 'latency (ms)', 'cost (EUR)']);
    });

    // [utest->req~frontend-rendering-run-result-names~1]
    it('shows no digest outside the source', () => {
      const digest = (c: string) => `sha256:${c.repeat(64)}`;
      const result = resultWith({ provenance: { irDigest: digest('a') } });
      const report = { ...REPORT, remote: { engineDigest: digest('b') } };
      show({ result, report });

      expect(textOutsideSource()).not.toMatch(/[0-9a-f]{64}/);
      expect(detailsOf('View source').textContent).toMatch(/b{64}/);
    });
  });

  describe('without the compiled problem', () => {
    // [utest->req~frontend-rendering-run-result-without-problem~1]
    it('says so and renders from the result alone', () => {
      render(<RunResult result={RESULT} problem={null} />);
      const scope = within(run());

      const note = scope.getByText(NO_PROBLEM_NOTE);
      expect(follows(note, scope.getByRole('combobox', { name: /Show solution/ }))).toBe(true);
      const table = within(region('Chosen providers'));
      expect(table.getByText('t1')).toBeInTheDocument();
      expect(table.getByText('c1')).toBeInTheDocument();
      expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Task', 'Candidate']);
      const qos = within(region('QoS against bounds'));
      expect(qos.queryByRole('region', { name: 'Bounds' })).toBeNull();
      expect(within(qos.getByRole('list', { name: 'Other rules' })).getByText('prefer-eu')).toBeInTheDocument();
    });

    // [utest->req~frontend-rendering-run-result-without-problem~1]
    it('shows no note while the problem is loading', () => {
      render(<RunResult result={RESULT} />);

      expect(screen.queryByText(/The compiled problem of this run is not available/)).toBeNull();
      const table = within(region('Chosen providers'));
      expect(table.getByText('t1')).toBeInTheDocument();
      expect(table.getByText('c1')).toBeInTheDocument();
    });
  });

  describe('trade-off set', () => {
    // [utest->req~frontend-rendering-run-result-trade-offs~1]
    it('shows the set for two objectives', () => {
      show();

      const table = within(region('Trade-off set')).getByRole('region', { name: 'Non-dominated solutions' });
      expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Solution', 'cost', 'latency']);
    });

    // [utest->req~frontend-rendering-run-result-trade-offs~1]
    it('shows nothing for one objective', () => {
      const onlyCost = (s: typeof S1) => ({ ...s, objectives: { ...s.objectives, components: s.objectives.components.slice(0, 1) } });
      show({ result: resultWith({ solutions: [onlyCost(S1), onlyCost(S2)] }) });

      expect(maybeRegion('Trade-off set')).toBeNull();
    });

    // [utest->req~frontend-rendering-run-result-trade-offs~1]
    it('shows nothing when the objectives are not shared by every solution', () => {
      const onlyCost = { ...S2, objectives: { ...S2.objectives, components: S2.objectives.components.slice(0, 1) } };
      show({ result: resultWith({ solutions: [S1, onlyCost] }) });

      expect(maybeRegion('Trade-off set')).toBeNull();
    });
  });

  describe('engine claims', () => {
    const SENTENCE = 'The values the engine claimed are not kept for this run. Gateway evaluation: FEASIBLE, 2 solutions.';

    // [utest->req~frontend-rendering-run-result-claimed-values~1]
    it('keeps no claim', () => {
      show();

      const claims = region('Claimed and evaluated values');
      expect(claims).toHaveTextContent(SENTENCE);
      expect(within(claims).queryByRole('region', { name: 'Differences' })).toBeNull();
    });

    // [utest->req~frontend-rendering-run-result-claimed-values~1]
    it('does not take the engine provenance as its claim', () => {
      const remote = {
        termination: 'OPTIMAL',
        solutions: [{ features: { latency: 1 } }],
        divergence: { agrees: false, notes: ['Solved with presolve', 7] },
      };
      show({ report: { ...REPORT, remote } });

      const claims = region('Claimed and evaluated values');
      expect(claims).toHaveTextContent(SENTENCE);
      expect(within(claims).queryByRole('region', { name: 'Differences' })).toBeNull();
      const notes = within(claims).getByRole('list', { name: 'Engine notes' });
      expect(within(notes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Solved with presolve']);
    });

    // [utest->req~frontend-rendering-run-result-claimed-values~1]
    it('shows no notes without a report', () => {
      for (const report of [undefined, null]) {
        show({ report });
        expect(screen.queryByRole('list', { name: 'Engine notes' })).toBeNull();
        cleanup();
      }
    });
  });

  describe('sources', () => {
    // [utest->req~frontend-rendering-run-result-source~1]
    it('shows the solution and the engine report only through SourceView', () => {
      show({ report: REPORT });
      const source = detailsOf('View source');

      expect(source.open).toBe(false);
      const solution = within(source).getByRole('region', { name: 'Solution 1 source', hidden: true });
      expect(within(solution).getByRole('button', { name: 'Download Solution 1 source', hidden: true })).toBeInTheDocument();
      const engine = within(source).getByRole('region', { name: 'Engine report source', hidden: true });
      expect(follows(solution, engine)).toBe(true);

      const pres = [...run().querySelectorAll('pre')];
      expect(pres.length).toBeGreaterThan(0);
      for (const pre of pres) expect(pre.closest('.rendering-source, .rendering-log')).not.toBeNull();
    });

    // [utest->req~frontend-rendering-run-result-source~1]
    it('shows no engine report source for an empty remote or no report', () => {
      for (const report of [{ ...REPORT, remote: {} }, undefined]) {
        show({ report });
        const source = detailsOf('View source');
        expect(within(source).getByRole('region', { name: 'Solution 1 source', hidden: true })).toBeInTheDocument();
        expect(within(source).queryByRole('region', { name: 'Engine report source', hidden: true })).toBeNull();
        cleanup();
      }
    });
  });

  describe('engine log', () => {
    // [utest->req~frontend-rendering-run-result-log~1]
    it('shows the log last, closed', () => {
      show();

      const last = run().lastElementChild as HTMLDetailsElement;
      expect(last.tagName).toBe('DETAILS');
      expect(last.open).toBe(false);
      expect(last.querySelector('summary')).toHaveTextContent('Engine log (2 lines)');
      expect(within(last).getByRole('button', { name: 'Download Engine log', hidden: true })).toBeInTheDocument();
    });

    // [utest->req~frontend-rendering-run-result-log~1]
    it('shows no log when logs is not a non-empty string', () => {
      const logs: unknown[] = [undefined, '', { text: 'x' }];
      for (const value of logs) {
        show({ result: resultWith({ logs: value }) });
        expect(screen.queryByText(/^Engine log/)).toBeNull();
        cleanup();
      }
    });
  });
});

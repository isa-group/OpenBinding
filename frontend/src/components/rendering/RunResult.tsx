import { useState, type ReactNode } from 'react';
import { BindingTable } from './BindingTable';
import { EvaluationDiff } from './EvaluationDiff';
import { LogPanel } from './LogPanel';
import { MetricCards } from './MetricCards';
import { ObjectiveBreakdown } from './ObjectiveBreakdown';
import { QoSAgainstBounds } from './QoSAgainstBounds';
import { SourceView } from './SourceView';
import { TradeOffChart } from './TradeOffChart';
import { VerdictBadge } from './VerdictBadge';
import { bindingFeaturesOf, bindingRowsOf } from './bindingTableModel';
import type { RunValues } from './evaluationDiffModel';
import { objectiveTermsOf } from './objectiveModel';
import { qosBoundsOf } from './qosBoundsModel';
import { tradeOffObjectivesOf, tradeOffPointsOf } from './tradeOffModel';
import {
  figuresOf,
  notesOf,
  optimizationTypeOf,
  remoteOf,
  solutionsOf,
  unitsOf,
  verdictOf,
  type RunProblem,
  type RunReport,
  type RunResultData,
} from './runResultModel';
import './RunResult.css';

interface RunResultProps {
  result: RunResultData;
  /** undefined: not loaded yet; null: not available (no note is shown while loading). */
  problem?: RunProblem | null;
  /** The compiled document's spec.constraints, as qosBoundsOf reads them; [] when absent. */
  constraints?: unknown;
  report?: RunReport | null;
  /** Page content right after the summary. */
  notice?: ReactNode;
  /** Page content after the trade-off set, before the sources. */
  children?: ReactNode;
  label?: string;
}

const NO_PROBLEM =
  'The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.';

/** The whole run: verdict, summary, the shown solution's parts, claims, trade-offs, sources and log, in that order. */
export function RunResult({ result, problem, constraints, report, notice, children, label = 'Run result' }: RunResultProps) {
  const [chosen, setChosen] = useState(0);
  const solutions = solutionsOf(result);
  const n = solutions.length;
  const index = Math.min(chosen, Math.max(n - 1, 0));
  if (index !== chosen) setChosen(index);
  const solution = solutions[index];
  const type = optimizationTypeOf(solutions);
  const units = unitsOf(problem);
  const known = problem ?? null;
  const points = tradeOffPointsOf(solutions);
  const objectives = tradeOffObjectivesOf(points);
  const remote = remoteOf(report);
  const logs = typeof result.logs === 'string' && result.logs !== '' ? result.logs : null;
  const figures = solution ? figuresOf(solution) : [];
  const data = solution ? objectiveTermsOf(solution.objectives, known) : null;
  const termination = typeof result.termination === 'string' && result.termination !== '' ? result.termination : null;
  const k = index + 1;

  return (
    <section aria-label={label} className="rendering-run">
      <div className="rendering-run__verdict">
        <VerdictBadge verdict={verdictOf(result.termination)} />
      </div>
      <p>
        {n} {n === 1 ? 'solution' : 'solutions'}
        {type !== null ? ` · optimization ${type}` : ''}
      </p>
      {problem === null && <p>{NO_PROBLEM}</p>}
      {notice}
      {n === 0 && <p>This run finished without producing a binding.</p>}
      {n > 1 && (
        <label className="rendering-run__choice">
          Show solution
          <select value={index} onChange={(e) => setChosen(Number(e.target.value))}>
            {solutions.map((_, i) => (
              <option key={i} value={i}>{`Solution ${i + 1}`}</option>
            ))}
          </select>
        </label>
      )}
      {solution && figures.length > 0 && (
        <MetricCards
          label="Quality of this combination"
          metrics={figures.map(([name, value]) => ({ id: name, label: name, value, unit: units[name] ?? undefined }))}
        />
      )}
      {solution && (
        <>
          <BindingTable
            rows={bindingRowsOf((solution.decision as { binding?: unknown } | undefined)?.binding, known)}
            features={bindingFeaturesOf(known)}
          />
          <QoSAgainstBounds {...qosBoundsOf(constraints ?? [], Object.fromEntries(figures), solution.violations, units)} />
          {data && <ObjectiveBreakdown {...data} />}
        </>
      )}
      <EvaluationDiff evaluated={{ termination, solutions: solutions as RunValues['solutions'] }} notes={notesOf(report)} />
      {objectives.length >= 2 && <TradeOffChart points={points} objectives={objectives} />}
      {children}
      {(n > 0 || remote !== null) && (
        <details className="rendering-run__source">
          <summary>View source</summary>
          {solution && <SourceView source={solution} label={`Solution ${k} source`} filename={`solution-${k}.json`} />}
          {remote !== null && <SourceView source={remote} label="Engine report source" filename="engine-report.json" />}
        </details>
      )}
      {logs !== null && <LogPanel log={logs} title="Engine log" filename="engine.log" />}
    </section>
  );
}

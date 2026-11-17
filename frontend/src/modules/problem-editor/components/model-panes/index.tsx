import { useMemo } from 'react';
import type { BimValidateResponse } from '../../../core/api/bim';
import { parseBindingSpace } from '../../../core/components/binding-space-badge/bindingSpace';
import { Chip } from '../../../core/components/chip';
import { candidateMatrix } from '../../../core/utils/binding/candidateMatrix';
import { workflowGraph } from '../../../core/utils/binding/workflowGraph';
import type { ProblemFacts } from '../../../core/api/types';
import { WorkflowGraph } from '../../../core/components/workflow-graph/WorkflowGraph';
import { overlayOf } from '../../utils/editorModel';
import { allModesFromAnalysis, engineRows } from '../../utils/engines';
import { MUTED, PANE } from '../../utils/styles';

/** What the panes that draw the checked package say before any check has passed. */
export function NotChecked({ what }: { what: string }) {
  return (
    <p
      className="rounded-xl border border-dashed border-tp-hairline-strong bg-tp-canvas p-6 text-sm text-tp-slate"
      role="note"
    >
      {what} once the package passes a check.
    </p>
  );
}

/** The facts on screen belong to the last valid package, and the package has changed since. */
export function StaleNote() {
  return (
    <p
      className="rounded-md border-l-[3px] border-l-tp-severity-warning bg-tp-severity-warning-bg px-4 py-2 text-sm text-tp-ink"
      role="note"
    >
      <strong>Stale: showing the last valid package.</strong> The last check refused the package;
      its findings are under Problems.
    </p>
  );
}

export interface ModelProps {
  facts: ProblemFacts | null;
  stale: boolean;
  /** Task → `<resource>/<id>` of the highlighted composition version. */
  selection: Record<string, string>;
}

/** The workflow of the last valid package, the graph the renderer draws; a task opens its candidates. */
export function WorkflowPane({
  facts,
  stale,
  selection,
  response,
  onSelectTask,
}: ModelProps & {
  response: BimValidateResponse | null;
  onSelectTask: (task: string) => void;
}) {
  const graph = useMemo(() => (facts ? workflowGraph(facts.workflow) : null), [facts]);
  const matrix = useMemo(
    () => (facts ? candidateMatrix(facts, { selection }) : null),
    [facts, selection]
  );
  if (!facts || !graph || !matrix) return <NotChecked what="The workflow appears" />;
  const analysis = response?.analysis;
  const tiles: Array<[string, string | number]> = analysis
    ? [
        ['Tasks', analysis.tasks],
        ['Candidates', analysis.candidates],
        ['Rules', analysis.constraints],
        ['Placement', analysis.placement ? 'Yes' : 'None'],
        ...(analysis.bindingSpace
          ? [
              ['Combinations', parseBindingSpace(analysis.bindingSpace).formatted] as [
                string,
                string,
              ],
            ]
          : []),
      ]
    : [];
  return (
    <div className={PANE}>
      {stale && <StaleNote />}
      {analysis && (
        <ul
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
          aria-label="What the package holds"
        >
          {tiles.map(([label, value]) => (
            <li
              key={label}
              className="flex flex-col rounded-xl border border-tp-hairline bg-tp-canvas px-3 py-2"
            >
              <b className="text-xl font-semibold text-tp-ink tabular-nums">{value}</b>
              <span className="text-xs text-tp-steel">{label.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={MUTED}>Select a task to see its candidates.</p>
      <WorkflowGraph
        graph={graph}
        overlay={overlayOf(facts, matrix)}
        label="Workflow of the package"
        onSelectTask={onSelectTask}
      />
    </div>
  );
}

/** The engine modes that can run the last valid package, and why the others cannot. */
export function EnginesPanel({
  response,
  stale,
}: {
  response: BimValidateResponse | null;
  stale: boolean;
}) {
  const rows = useMemo(() => engineRows(allModesFromAnalysis(response)), [response]);
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="pe-engines-title">
      <h2
        id="pe-engines-title"
        className="text-[11px] font-semibold tracking-[0.12em] text-tp-slate uppercase"
      >
        Engines
      </h2>
      {!response ? (
        <p className={MUTED}>The engines that can run the package appear once it passes a check.</p>
      ) : rows.length === 0 ? (
        <p className={MUTED}>
          The check listed no engine mode for this package, so nothing can run it yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Engine modes">
          {rows.map(row => (
            <li
              key={row.key}
              className="flex flex-col items-start gap-1 rounded-xl border border-tp-hairline bg-tp-canvas p-3 [&>*]:max-w-full [&>*]:[overflow-wrap:anywhere]"
            >
              <span className="flex flex-wrap items-center gap-1.5 text-sm text-tp-ink">
                <strong className="font-semibold">{row.name}</strong>
                <code className="font-mono text-xs text-tp-slate">{row.mode}</code>
                {row.registered && <Chip tone="accent">Registered</Chip>}
              </span>
              <Chip tone={row.runnable ? 'success' : 'warning'}>
                {row.runnable ? 'Can run it' : 'Cannot run it'}
              </Chip>
              <span className="text-xs text-tp-slate">{row.why}</span>
            </li>
          ))}
        </ul>
      )}
      {response && stale && <p className={MUTED}>For the last valid package.</p>}
    </section>
  );
}

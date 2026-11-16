import { useMemo } from 'react';
import type { BimValidateResponse } from '../../api/bim';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { Chip } from '../../modules/core/components/chip';
import { candidateMatrix } from '../../entities/binding/candidateMatrix';
import { workflowGraph } from '../../entities/binding/workflowGraph';
import type { ProblemFacts } from '../../modules/core/api/types';
import { WorkflowGraph } from '../../widgets/workflow-graph/WorkflowGraph';
import { overlayOf } from './editorModel';
import { allModesFromAnalysis, engineRows } from './engines';

/** What the panes that draw the checked package say before any check has passed. */
export function NotChecked({ what }: { what: string }) {
  return (
    <p className="pe-empty" role="note">
      {what} once the package passes a check.
    </p>
  );
}

/** The facts on screen belong to the last valid package, and the package has changed since. */
export function StaleNote() {
  return (
    <p className="pe-stale" role="note">
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
  return (
    <div className="pe-pane-body">
      {stale && <StaleNote />}
      {analysis && (
        <ul className="pe-counts" aria-label="What the package holds">
          <li>
            <b>{analysis.tasks}</b>
            <span>tasks</span>
          </li>
          <li>
            <b>{analysis.candidates}</b>
            <span>candidates</span>
          </li>
          <li>
            <b>{analysis.constraints}</b>
            <span>rules</span>
          </li>
          <li>
            <b>{analysis.placement ? 'Yes' : 'None'}</b>
            <span>placement</span>
          </li>
        </ul>
      )}
      {analysis?.bindingSpace && <BindingSpaceBadge cardinality={analysis.bindingSpace} />}
      <p className="pe-muted">Select a task to see its candidates.</p>
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
    <section className="pe-engines" aria-labelledby="pe-engines-title">
      <h2 id="pe-engines-title">Engines</h2>
      {!response ? (
        <p className="pe-muted">
          The engines that can run the package appear once it passes a check.
        </p>
      ) : rows.length === 0 ? (
        <p className="pe-muted">
          The check listed no engine mode for this package, so nothing can run it yet.
        </p>
      ) : (
        <ul className="pe-engine-list" aria-label="Engine modes">
          {rows.map(row => (
            <li key={row.key}>
              <span className="pe-engine-name">
                <strong>{row.name}</strong>
                <code>{row.mode}</code>
                {row.registered && <Chip tone="accent">Registered</Chip>}
              </span>
              <Chip tone={row.runnable ? 'success' : 'warning'}>
                {row.runnable ? 'Can run it' : 'Cannot run it'}
              </Chip>
              <span className="pe-muted">{row.why}</span>
            </li>
          ))}
        </ul>
      )}
      {response && stale && <p className="pe-muted">For the last valid package.</p>}
    </section>
  );
}

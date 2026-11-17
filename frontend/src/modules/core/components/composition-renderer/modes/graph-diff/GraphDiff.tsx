import type { CandidateMatrix as Matrix } from '../../../../utils/binding/candidateMatrix';
import type { CompositionViewModel } from '../../../../utils/composition/viewModel';
import { CandidateMatrix } from '../../../candidate-matrix/CandidateMatrix';
import { WorkflowGraph } from '../../../workflow-graph/WorkflowGraph';
import type { Section } from '../../presets';
import { RendererSection } from '../../RendererSection';
import { removedTasks, selectionTags, taskOverlay, workflowChanged, type Diff } from './diffModel';

interface GraphDiffProps {
  /** The later version, with its document (and, for a member who may read the problem, its candidate matrix). */
  model: CompositionViewModel;
  diff: Diff;
  /** The earlier version's choice of candidate for each task (its evaluation's binding); null when it has none. */
  beforeSelection: Readonly<Record<string, string>> | null;
  sections: readonly Section[];
}

/** The matrix with no candidate selected: the tags name the version, or both, that chose each one. */
const unselected = (matrix: Matrix): Matrix => ({
  ...matrix,
  rows: matrix.rows.map(row => ({
    ...row,
    candidates: row.candidates.map(candidate => ({ ...candidate, selected: false })),
  })),
});

/**
 * The workflow of the later version, each task marked added or changed where its binding entry differs from the earlier
 * version's, and the tasks it no longer has named below. For a member with the facts of the later version's problem, the
 * candidate matrix follows with the candidate each version chose marked.
 */
export function GraphDiff({ model, diff, beforeSelection, sections }: GraphDiffProps) {
  const shows = (section: Section) => sections.includes(section);
  const from = diff.from.label;
  const to = diff.to.label;
  const removed = removedTasks(diff, model.tasks);
  const matrix = model.reader === 'member' ? model.matrix : null;
  return (
    <>
      {shows('graph') && (
        <RendererSection title="Workflow changes">
          <p className="cr-muted m-0 text-[13px] text-tp-steel">
            {`The workflow of ${to}. A task marked added or changed is bound differently from ${from}.`}
            {workflowChanged(diff)
              ? ' The workflow itself changed too: the file view shows how.'
              : ''}
          </p>
          <WorkflowGraph
            graph={model.workflow}
            overlay={taskOverlay(diff, model.tasks)}
            label={`The workflow of ${model.identity.name} at ${to}`}
          />
          {removed.length > 0 && (
            <p className="m-0 text-[13px] text-tp-slate [&_code]:font-mono">
              {`Not in ${to} any more: `}
              {removed.map((task, index) => (
                <span key={task}>
                  {index > 0 && ', '}
                  <code>{task}</code>
                </span>
              ))}
            </p>
          )}
        </RendererSection>
      )}
      {shows('candidates') && matrix && (
        <RendererSection title="Problem candidates">
          <p className="cr-muted m-0 text-[13px] text-tp-steel">{`What the linked problem offers each task, with the candidate ${from} and ${to} chose marked.`}</p>
          <CandidateMatrix
            matrix={unselected(matrix)}
            mode="view"
            label={`Candidates chosen by ${from} and ${to}`}
            tags={selectionTags([
              { label: from, selection: beforeSelection },
              { label: to, selection: model.selection },
            ])}
          />
        </RendererSection>
      )}
    </>
  );
}

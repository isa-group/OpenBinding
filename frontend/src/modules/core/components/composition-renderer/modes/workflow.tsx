import type { TaskOverlay } from '../../../utils/binding/workflowGraph';
import type { CompositionViewModel } from '../../../utils/composition/viewModel';
import { CandidateMatrix } from '../../candidate-matrix/CandidateMatrix';
import { WorkflowGraph } from '../../workflow-graph/WorkflowGraph';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';

/**
 * The workflow mode: the composition's workflow, each task with the candidate the binding gives it or marked local. For a
 * member, on a version that links a problem, the problem's candidates follow, from the facts of the compilation the values were
 * evaluated on, with the candidate the evaluation used selected in each task.
 */

interface WorkflowModeProps {
  model: CompositionViewModel;
  sections: readonly Section[];
}

/** What the drawing says of each task: its candidate as the document writes it, or that it is done in house. */
function bindingOverlay(model: CompositionViewModel): Record<string, TaskOverlay> {
  return Object.fromEntries(
    model.tasks.map((task): [string, TaskOverlay] => [
      task.id,
      task.local ? { local: true } : task.candidate ? { candidate: task.candidate } : {},
    ])
  );
}

export function WorkflowMode({ model, sections }: WorkflowModeProps) {
  if (!model.version) return null;
  const shows = (section: Section) => sections.includes(section);
  const matrix = model.reader === 'member' ? model.matrix : null;
  return (
    <>
      {shows('graph') && (
        <RendererSection title="Workflow">
          <WorkflowGraph
            graph={model.workflow}
            overlay={bindingOverlay(model)}
            label={`The workflow of ${model.identity.name}`}
          />
        </RendererSection>
      )}
      {shows('candidates') && matrix && (
        <RendererSection title="Problem candidates">
          <p className="cr-muted">
            What the linked problem offers each task, on the compilation these values were evaluated
            on. The candidate this version uses is selected.
          </p>
          <CandidateMatrix matrix={matrix} mode="view" label="Candidates of the linked problem" />
        </RendererSection>
      )}
    </>
  );
}

import type { CandidateMatrix } from '../../core/utils/binding/candidateMatrix';
import type { TaskOverlay } from '../../core/utils/binding/workflowGraph';
import type { ProblemFacts } from '../../core/api/types';
import type { WorkspaceFiles } from './documents';

/** What the panes of the problem editor share, as plain functions. */

/** The languages the code editor reads a package's files in. */
export type CodeLanguage = 'json' | 'xml' | 'plaintext';

/** How a file of the package is read in the code editor. */
export function fileLanguage(path: string): CodeLanguage {
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(bpmn|xml)$/i.test(path)) return 'xml';
  return 'plaintext';
}

/** The files in the order a reader expects them: the Instance first, then by path. */
export const filePaths = (files: WorkspaceFiles) =>
  Object.keys(files).sort((a, b) =>
    a === 'instance.json' ? -1 : b === 'instance.json' ? 1 : a.localeCompare(b)
  );

/** Each task as the workflow graph shows it: local or not, and the candidate the highlighted composition version chose for it. */
export function overlayOf(
  facts: ProblemFacts,
  matrix: CandidateMatrix
): Record<string, TaskOverlay> {
  const overlay: Record<string, TaskOverlay> = {};
  for (const task of facts.tasks) overlay[task.id] = { local: task.kind === 'local' };
  for (const row of matrix.rows) {
    const chosen = row.candidates.find(candidate => candidate.selected);
    if (chosen)
      overlay[row.task] = { ...overlay[row.task], candidate: chosen.written, status: 'selected' };
  }
  return overlay;
}

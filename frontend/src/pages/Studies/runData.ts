import { HttpError } from '../../api/client';
import { platformApi, type StudyCell, type StudyRun } from '../../api/platform';

export interface RunData {
  run: StudyRun;
  cells: StudyCell[];
}

/**
 * A run and its cells together. A run is found in the study's list (there is no endpoint for one) and its cells have their own, so a run
 * the list leaves out, or the cells answer 404 for, reads as missing, and a 403 from the cells (a key without one of the engines) stays a 403.
 */
export async function loadRun(org: string, project: string, study: string, runId: string): Promise<RunData> {
  const [runs, cells] = await Promise.allSettled([platformApi.studyRuns(org, project, study), platformApi.studyCells(org, project, study, runId)]);
  if (cells.status === 'rejected') throw cells.reason;
  if (runs.status === 'rejected') throw runs.reason;
  const run = runs.value.find((item) => item.id === runId);
  if (!run) throw new HttpError(404, 'Study run not found.');
  return { run, cells: cells.value };
}

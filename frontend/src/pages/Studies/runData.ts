import { platformApi, type StudyCell, type StudyRun } from '../../api/platform';

export interface RunData {
  run: StudyRun;
  cells: StudyCell[];
}

/**
 * A run (with the definition it froze) and its cells together. A run or cells the gateway answers 404 for read as missing, and a 403
 * (a key without one of the engines) stays a 403.
 */
export async function loadRun(org: string, study: string, runId: string): Promise<RunData> {
  const [run, cells] = await Promise.allSettled([platformApi.studyRun(org, study, runId), platformApi.studyCells(org, study, runId)]);
  if (cells.status === 'rejected') throw cells.reason;
  if (run.status === 'rejected') throw run.reason;
  return { run: run.value, cells: cells.value };
}

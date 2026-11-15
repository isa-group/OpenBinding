import { platformApi } from '../../api/platform';
import type { StudyContent } from '../../features/workspace/model';
import { latestRun } from './projectModel';

/**
 * The studies of a project with their runs (archived ones too: their runs are sealed history). The cells of the latest run
 * are read for the first `withCells` live studies only, which is what the overview card draws.
 */
export async function loadStudies(org: string, project: string, withCells = 0): Promise<StudyContent[]> {
  const studies = await platformApi.studies(org, project, true);
  const live = studies.filter((study) => !study.archived).slice(0, withCells).map((study) => study.id);
  return Promise.all(studies.map(async (study) => {
    const runs = await platformApi.studyRuns(org, project, study.slug).catch(() => []);
    const run = latestRun(runs);
    const latestCells = run && live.includes(study.id)
      ? await platformApi.studyCells(org, project, study.slug, run.id).catch(() => undefined)
      : undefined;
    return { study, runs, latestCells };
  }));
}

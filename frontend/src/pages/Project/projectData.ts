import { platformApi } from '../../api/platform';
import type { Publication, Report } from '../../api/platform';
import { latestRun, type CaseContent, type StudyContent } from './projectModel';

/** The cases of a project with their sealed revisions. A case whose revisions can't be read still shows, with none. */
export async function loadCases(org: string, project: string): Promise<CaseContent[]> {
  const cases = await platformApi.cases(org, project);
  return Promise.all(cases.map(async (item) => ({
    item,
    revisions: await platformApi.revisions(org, project, item.slug).catch(() => []),
  })));
}

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

export interface ReportsContent {
  reports: Report[];
  publications: Publication[];
}

export async function loadReports(org: string, project: string): Promise<ReportsContent> {
  const [reports, publications] = await Promise.all([
    platformApi.reports(org, project),
    platformApi.publications(org, project).catch(() => []),
  ]);
  return { reports, publications };
}

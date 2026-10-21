import { HttpError } from '../../api/client';
import { platformApi, type Report, type Study, type StudyRun } from '../../api/platform';

/** The draft every report starts from; the report screen fills it in. */
const EMPTY_DOCUMENT = { summary: '', findings: [], provenance: {} };

/** The reports that already cite this run, so a second click opens the first draft instead of piling up copies. */
export function reportsOfRun(reports: readonly Report[], run: Pick<StudyRun, 'id'>): Report[] {
  return reports.filter((report) => report.study_run_id === run.id);
}

/**
 * A draft report pinned to a run (`POST …/reports`). Its address is made from the study and the run; when that address is taken
 * by another report the next free one (`-2`, `-3`…) is used, so a person never has to invent one to start.
 */
export async function createRunReport(org: string, project: string, study: Pick<Study, 'slug' | 'name'>, run: Pick<StudyRun, 'id' | 'run_number'>): Promise<Report> {
  const base = `${study.slug}-run-${run.run_number}`.slice(0, 60).replace(/-+$/g, '');
  for (let attempt = 1; ; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      return await platformApi.createReport(org, project, { slug, title: `${study.name} · run #${run.run_number}`, study_run_id: run.id, document: EMPTY_DOCUMENT });
    } catch (caught) {
      const taken = caught instanceof HttpError && caught.status === 409;
      if (!taken || attempt >= 6) throw caught;
    }
  }
}

// Address builders of the studies area. Code that links to an organization's studies, the create form or a study builds the
// address here, so the segments are named once. The list is the organization's Studies tab (`/orgs/:org/studies`), the
// form is `/studies/new` and a study is `/studies/:org/:study/:tab?`, SPHERE's card page.

import { orgPath } from '../../modules/organization/types/paths';

/** The segment of the Studies tab, the create form and the study page. */
export const STUDIES_SEGMENT = 'studies';

/** The segments of the study page after the study: no segment is the tab the page chooses (Progress once it has runs). */
export const STUDY_TAB_SEGMENTS = ['setup', 'progress', 'results', 'front', 'settings'] as const;

export type StudyTabSegment = (typeof STUDY_TAB_SEGMENTS)[number];

export const isStudyTabSegment = (value: string): value is StudyTabSegment =>
  (STUDY_TAB_SEGMENTS as readonly string[]).includes(value);

function withQuery(
  path: string,
  values: Record<string, string | number | boolean | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '' && value !== false) query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** The studies of an organization: its Studies tab, `/orgs/<org>/studies`, the archived ones with `archived`. */
export const studiesPath = (org: string, filter: { archived?: boolean } = {}): string =>
  withQuery(orgPath(org, STUDIES_SEGMENT), { archived: filter.archived });

/** What the study page shows: the study run (`run`) and the cell open in the side sheet (`cell`). */
export interface StudyQuery {
  run?: string;
  cell?: string;
}

/** One study, at a tab, with the run and the cell it shows: `/studies/<org>/<study>/<tab>?run=&cell=`. */
export function studyPath(
  org: string,
  study: string,
  tab?: StudyTabSegment,
  query: StudyQuery = {}
): string {
  const base = `/${STUDIES_SEGMENT}/${encodeURIComponent(org)}/${encodeURIComponent(study)}`;
  return withQuery(tab ? `${base}/${tab}` : base, { run: query.run, cell: query.cell });
}

/** What the create form starts from: a problem version (`problem`, `revision`), an engine (`namespace/name`), or both. */
export interface StudyStart {
  problem?: string;
  revision?: number | string;
  engine?: string;
}

/** The create form (`study-builder`): `/studies/new?org=&problem=&revision=&engine=`. */
export function newStudyPath(org?: string, start: StudyStart = {}): string {
  return withQuery(`/${STUDIES_SEGMENT}/new`, {
    org,
    problem: start.problem,
    revision: start.revision,
    engine: start.engine,
  });
}

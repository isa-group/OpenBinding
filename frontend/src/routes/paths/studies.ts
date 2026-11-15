// Address builders of the studies area (organization-level since F0b B7). Code that links to the study list, the study builder or a
// study builds the address here, so the segment is named once.

/** The segment of the study list, the study builder and the study page. */
export const STUDIES_SEGMENT = 'studies';

/** The study list of an organization: `/app/<org>/studies`. */
export const studiesPath = (org: string): string => `/app/${encodeURIComponent(org)}/${STUDIES_SEGMENT}`;

/** One study of an organization (its Setup tab): `/app/<org>/studies/<study>`. */
export const studyPath = (org: string, study: string): string => `${studiesPath(org)}/${encodeURIComponent(study)}`;

/** What the builder starts from: a problem version, an engine (`namespace/name`), or both. */
export interface StudyStart {
  case?: string;
  revision?: number | string;
  engine?: string;
}

/** The study builder of an organization (`study-builder`): `/app/<org>/studies/new`, with `?case=&revision=` and `?engine=`. */
export function newStudyPath(org: string, start: StudyStart = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(start)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.toString();
  return `${studiesPath(org)}/new${search ? `?${search}` : ''}`;
}

// Address builders of the problems area (M2.6; organization-level since F0b). Code that links to a problem, a problem version or the problem list builds the address here,
// so the segment is named once.

/** The segment of the problem list and the problem page. */
export const PROBLEMS_SEGMENT = 'problems';

/** The segments of the problem page after the problem: no segment is the Overview tab. */
export const PROBLEM_TAB_SEGMENTS = ['runs', 'versions', 'source', 'settings'] as const;

export type ProblemTabSegment = (typeof PROBLEM_TAB_SEGMENTS)[number];

export const isProblemTabSegment = (value: string): value is ProblemTabSegment => (PROBLEM_TAB_SEGMENTS as readonly string[]).includes(value);

/** The query of a problem page: the problem version shown (`version`) and the pair that the Versions tab compares (`from`, `to`). */
export interface ProblemView {
  version?: number | string;
  from?: number | string;
  to?: number | string;
}

/** The root of an organization's workspace: `/app/<org>`. */
export const organizationPath = (org: string): string => `/app/${encodeURIComponent(org)}`;

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** The problem list of an organization: `/app/<org>/problems`. */
export const problemsPath = (org: string): string => `${organizationPath(org)}/${PROBLEMS_SEGMENT}`;

/** The problem page, with its tab and the version or pair it shows. */
export function problemPath(org: string, problem: string, tab?: ProblemTabSegment, view: ProblemView = {}): string {
  return withQuery(`${problemsPath(org)}/${encodeURIComponent(problem)}${tab ? `/${tab}` : ''}`, { ...view });
}

/** What the problem editor opens: a revision of a problem (the newest without `revision`), or a template. */
export interface ProblemEditorTarget {
  problem?: string;
  revision?: number | string;
  template?: string;
}

/** The problem editor of an organization: `/app/<org>/problem-editor`, with `?problem=&revision=` or `?template=`. */
export function problemEditorPath(org: string, target: ProblemEditorTarget = {}): string {
  return withQuery(`${organizationPath(org)}/problem-editor`, { problem: target.problem, revision: target.revision, template: target.template });
}

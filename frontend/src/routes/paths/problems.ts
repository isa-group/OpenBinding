// Address builders of the problems area (M2.6). Code that links to a problem, a problem version or the problem list builds the address here,
// so the rename of the segment (`cases` to `problems`, slice 13) is one edit.

/** The segment of the problem list and the problem page. Slice 13 changes it to `problems`. */
export const PROBLEMS_SEGMENT = 'cases';

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

/** The problem list of a project; `root` is `/app/<org>/<project>`. */
export const problemsPath = (root: string): string => `${root}/${PROBLEMS_SEGMENT}`;

/** The problem page of a project, with its tab and the version or pair it shows. */
export function problemPath(root: string, problem: string, tab?: ProblemTabSegment, view: ProblemView = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(view)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.toString();
  return `${problemsPath(root)}/${encodeURIComponent(problem)}${tab ? `/${tab}` : ''}${search ? `?${search}` : ''}`;
}

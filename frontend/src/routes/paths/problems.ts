// Address builders of the problems area. Code that links to a problem, a problem version or the problem list builds the
// address here, so the segments are named once: the list is the organization's Problems tab (`/orgs/:org/problems`), a
// problem is SPHERE's card page (`/problems/:org/:problem/:tab?`).

import type { ProblemOrigin } from '../../modules/core/api/types';

/** The segment of the organization's Problems tab and of the problem pages. */
export const PROBLEMS_SEGMENT = 'problems';

/** The segments of the problem page after the problem: no segment is the Overview tab. */
export const PROBLEM_TAB_SEGMENTS = [
  'candidates',
  'versions',
  'runs',
  'compositions',
  'source',
  'settings',
] as const;

export type ProblemTabSegment = (typeof PROBLEM_TAB_SEGMENTS)[number];

export const isProblemTabSegment = (value: string): value is ProblemTabSegment =>
  (PROBLEM_TAB_SEGMENTS as readonly string[]).includes(value);

/**
 * The query of a problem page: the problem version shown (`version`), the pair that the Versions tab compares (`from`, `to`), and
 * the composition version whose selection the Candidates tab highlights (`composition`, `compositionVersion`: a label, an id or an
 * ordinal).
 */
export interface ProblemView {
  version?: number | string;
  from?: number | string;
  to?: number | string;
  composition?: string;
  compositionVersion?: number | string;
}

/** What the problem list shows: the problems whose latest version came from `origin`, and those a version of `composition` links. */
export interface ProblemsFilter {
  origin?: ProblemOrigin;
  composition?: string;
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

/** The problems of an organization, its Problems tab: `/orgs/<org>/problems`, with its filters. */
export const problemsPath = (org: string, filter: ProblemsFilter = {}): string =>
  withQuery(`/orgs/${encodeURIComponent(org)}/${PROBLEMS_SEGMENT}`, {
    origin: filter.origin,
    composition: filter.composition,
  });

/** The problem page, `/problems/<org>/<problem>/<tab>`, with the version or pair it shows. */
export function problemPath(
  org: string,
  problem: string,
  tab?: ProblemTabSegment,
  view: ProblemView = {}
): string {
  return withQuery(
    `/${PROBLEMS_SEGMENT}/${encodeURIComponent(org)}/${encodeURIComponent(problem)}${tab ? `/${tab}` : ''}`,
    {
      version: view.version,
      from: view.from,
      to: view.to,
      composition: view.composition,
      compositionVersion: view.compositionVersion,
    }
  );
}

/**
 * What the problem editor opens: a revision of a problem (the newest without `revision`), or a template; and the composition
 * version whose selection it highlights (`composition`, `compositionVersion`: a label, an id or an ordinal), named as on the
 * problem page.
 */
export interface ProblemEditorTarget {
  problem?: string;
  revision?: number | string;
  template?: string;
  composition?: string;
  compositionVersion?: number | string;
}

/**
 * The problem editor of an organization: `/app/<org>/problem-editor`, with `?problem=&revision=` or `?template=`, and
 * `&composition=&compositionVersion=` for a highlight.
 */
export function problemEditorPath(org: string, target: ProblemEditorTarget = {}): string {
  return withQuery(`${organizationPath(org)}/problem-editor`, {
    problem: target.problem,
    revision: target.revision,
    template: target.template,
    composition: target.composition,
    compositionVersion: target.compositionVersion,
  });
}

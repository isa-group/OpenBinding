// The only place that knows retired addresses. Data only: the redirect component lives in index.tsx.

/** What React Router hands to a matched route: decoded segments, absent when the path has none. */
export type RetiredParams = Readonly<Partial<Record<string, string>>>;

export type RetiredRoute = {
  id: string;
  path: string;
  slice: 1 | 2 | 3 | 4 | 5;
  target: (query: URLSearchParams, params: RetiredParams) => string;
};

/** Present with a non-empty value; the first value of a repeated key is used. */
function carried(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  return value ? value : undefined;
}

/** The decision-space rule: the run, else the study, else the run history. Every other parameter is dropped. */
function decisionSpaceTarget(query: URLSearchParams): string {
  const org = carried(query, 'org');
  const project = carried(query, 'project');
  const study = carried(query, 'study');
  const run = carried(query, 'run');
  if (org && project && study) {
    const studyPath = `/app/${encodeURIComponent(org)}/${encodeURIComponent(project)}/studies/${encodeURIComponent(study)}`;
    return run ? `${studyPath}/progress?run=${encodeURIComponent(run)}` : studyPath;
  }
  return '/app/runs';
}

/** The library catalogue rule (organization level): the organization overview. The artifact, the draft, the version and the query are dropped. */
function organizationTarget(_query: URLSearchParams, params: RetiredParams): string {
  const { org } = params;
  return org ? `/app/${encodeURIComponent(org)}` : '/app';
}

/** The composer rule: the workbench of the project, with the case. The opened query and the hash are dropped. */
function workbenchTarget(_query: URLSearchParams, params: RetiredParams): string {
  const { org, project, case: slug } = params;
  if (!org || !project || !slug) return '/app';
  return `/app/${encodeURIComponent(org)}/${encodeURIComponent(project)}/workbench?case=${encodeURIComponent(slug)}`;
}

/** The sponsorship rule: the administration overview. The organization, the query and the hash are dropped. */
function administrationTarget(): string {
  return '/app/admin';
}

/**
 * The library entries come first: on a tie of rank React Router takes the earlier route, and the composer (slice 4) ties with
 * lib-draft and lib-version, which win.
 * The sponsorship screen (slice 5) goes last: it outranks every route that matches the same addresses.
 */
export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  { id: 'lib-list', path: '/app/:org/library', slice: 3, target: organizationTarget },
  { id: 'lib-artifact', path: '/app/:org/library/:artifact', slice: 3, target: organizationTarget },
  { id: 'lib-draft', path: '/app/:org/library/:artifact/drafts/:draft', slice: 3, target: organizationTarget },
  { id: 'lib-version', path: '/app/:org/library/:artifact/versions/:version', slice: 3, target: organizationTarget },
  { id: 'analysis-sources', path: '/app/analysis', slice: 1, target: decisionSpaceTarget },
  { id: 'analysis-workspace', path: '/app/analysis/workspace', slice: 1, target: decisionSpaceTarget },
  { id: 'case-composer', path: '/app/:org/:project/cases/:case/compose', slice: 4, target: workbenchTarget },
  { id: 'admin-sponsor', path: '/app/admin/organizations/:org/sponsor', slice: 5, target: administrationTarget },
];

// The only place that knows retired addresses (M2.4, ADR-0020). Data only: the redirect component lives in index.tsx.

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

// [impl->req~frontend-retire-redirect-decision-space~1]
/** The decision-space rule: the run, else the study, else the job history. Every other parameter is dropped. */
function decisionSpaceTarget(query: URLSearchParams): string {
  const org = carried(query, 'org');
  const project = carried(query, 'project');
  const study = carried(query, 'study');
  const run = carried(query, 'run');
  if (org && project && study) {
    const studyPath = `/app/${encodeURIComponent(org)}/${encodeURIComponent(project)}/studies/${encodeURIComponent(study)}`;
    return run ? `${studyPath}/runs/${encodeURIComponent(run)}` : studyPath;
  }
  return '/app/jobs';
}

// [impl->req~frontend-retire-reports-redirect~1]
/** The report editor rule: the project's publications. The report, the query and the hash are dropped. */
function publicationsTarget(_query: URLSearchParams, params: RetiredParams): string {
  const { org, project } = params;
  if (!org || !project) return '/app';
  return `/app/${encodeURIComponent(org)}/${encodeURIComponent(project)}/publications`;
}

// [impl->req~frontend-retire-library-redirect~1]
/** The library catalogue rule (organization level): the organization overview. The artifact, the draft, the version and the query are dropped. */
function organizationTarget(_query: URLSearchParams, params: RetiredParams): string {
  const { org } = params;
  return org ? `/app/${encodeURIComponent(org)}` : '/app';
}

// [impl->req~frontend-retire-library-redirect~1]
/** The project library and resources rule: the collections of the project. The resource, the query and the hash are dropped. */
function collectionsTarget(_query: URLSearchParams, params: RetiredParams): string {
  const { org, project } = params;
  if (!org || !project) return '/app';
  return `/app/${encodeURIComponent(org)}/${encodeURIComponent(project)}/collections`;
}

// [impl->req~frontend-retire-composer-redirect~1]
/** The composer rule: the workbench of the project, with the case. The opened query and the hash are dropped. */
function workbenchTarget(_query: URLSearchParams, params: RetiredParams): string {
  const { org, project, case: slug } = params;
  if (!org || !project || !slug) return '/app';
  return `/app/${encodeURIComponent(org)}/${encodeURIComponent(project)}/workbench?case=${encodeURIComponent(slug)}`;
}

// [impl->req~frontend-retire-redirect-generic~1]
// [impl->req~frontend-retire-reports-redirect~1]
// [impl->req~frontend-retire-library-redirect~1]
// [impl->req~frontend-retire-composer-redirect~1]
/**
 * The library entries come first: on a tie of rank React Router takes the earlier route, and `/app/<org>/library/reports`,
 * `/app/<org>/library/library` and `/app/<org>/library/resources` match the library artifact as well as the project reports, the
 * project library and the project resources. The composer (slice 4) goes last: it ties with lib-draft and lib-version, which win.
 */
export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  { id: 'lib-list', path: '/app/:org/library', slice: 3, target: organizationTarget },
  { id: 'lib-artifact', path: '/app/:org/library/:artifact', slice: 3, target: organizationTarget },
  { id: 'lib-draft', path: '/app/:org/library/:artifact/drafts/:draft', slice: 3, target: organizationTarget },
  { id: 'lib-version', path: '/app/:org/library/:artifact/versions/:version', slice: 3, target: organizationTarget },
  { id: 'analysis-sources', path: '/app/analysis', slice: 1, target: decisionSpaceTarget },
  { id: 'analysis-workspace', path: '/app/analysis/workspace', slice: 1, target: decisionSpaceTarget },
  { id: 'rep-list', path: '/app/:org/:project/reports', slice: 2, target: publicationsTarget },
  { id: 'rep-detail', path: '/app/:org/:project/reports/:report', slice: 2, target: publicationsTarget },
  { id: 'proj-library', path: '/app/:org/:project/library', slice: 3, target: collectionsTarget },
  { id: 'proj-resources', path: '/app/:org/:project/resources', slice: 3, target: collectionsTarget },
  { id: 'proj-resource-detail', path: '/app/:org/:project/resources/:resource', slice: 3, target: collectionsTarget },
  { id: 'case-composer', path: '/app/:org/:project/cases/:case/compose', slice: 4, target: workbenchTarget },
];

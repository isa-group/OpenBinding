// The only place that knows retired addresses (M2.4, ADR-0020). Data only: the redirect component lives in index.tsx.

export type RetiredRoute = { id: string; path: string; target(query: URLSearchParams): string };

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

// [impl->req~frontend-retire-redirect-generic~1]
export const RETIRED_ROUTES: RetiredRoute[] = [
  { id: 'analysis-sources', path: '/app/analysis', target: decisionSpaceTarget },
  { id: 'analysis-workspace', path: '/app/analysis/workspace', target: decisionSpaceTarget },
];

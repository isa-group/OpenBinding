import { lazy } from 'react';
import { live } from '../define';
import { moved, type MovedRoute } from '../moved';
import { problemPath, problemsPath } from '../paths/problems';
import type { RouteDefinition } from '../types';

// Area: problems. The problems of a project, the problem page with its tabs, and the workbench.

const CaseList = lazy(() => import('../../pages/Cases/CaseList').then((module) => ({ default: module.CaseList })));
const CaseDetail = lazy(() => import('../../pages/Cases/CaseDetail').then((module) => ({ default: module.CaseDetail })));
const Workbench = lazy(() => import('../../pages/Workbench/Workbench').then((module) => ({ default: module.Workbench })));

export const routes: RouteDefinition[] = [
  live('case-list', '/app/:org/:project/problems', <CaseList />),
  live('case-detail', '/app/:org/:project/problems/:case/:tab?', <CaseDetail />),
  live('wb-workbench', '/app/:org/:project/workbench', <Workbench />),
];

const projectRoot = (params: Readonly<Partial<Record<string, string>>>) => `/app/${encodeURIComponent(params.org ?? '')}/${encodeURIComponent(params.project ?? '')}`;

const movedAddresses: MovedRoute[] = [
  // The addresses of the problem list and the problem page before the segment became `problems` (slice 13). The tab, the query and the
  // hash go on. The static entries below (`revisions`, `compare`) and the retired composer outrank `:tab`, so every redirect is one hop.
  moved('case-list-moved', '/app/:org/:project/cases', '/app/:org/:project/problems'),
  moved('case-moved', '/app/:org/:project/cases/:case', '/app/:org/:project/problems/:case'),
  moved('case-tab-moved', '/app/:org/:project/cases/:case/:tab', '/app/:org/:project/problems/:case/:tab'),
  // A problem version: the Overview of the problem page, showing that version. The version is a number, or a digest or id that the page resolves.
  moved('case-revision-moved', '/app/:org/:project/cases/:case/revisions/:revision', '/app/:org/:project/problems/:case', {
    target: (_query, params) => problemPath(projectRoot(params), params.case ?? '', undefined, { version: params.revision }), permanent: true, keepQuery: false,
  }),
  // The comparison of two versions: the Versions tab, with the pair (`from`, `to`) it already carries.
  moved('case-compare-moved', '/app/:org/:project/cases/:case/compare', '/app/:org/:project/problems/:case/versions', {
    target: (query, params) => {
      const address = problemPath(projectRoot(params), params.case ?? '', 'versions');
      const search = query.toString();
      return search ? `${address}?${search}` : address;
    },
  }),
  // A snapshot has no page of its own: the project's problems. The snapshot id is dropped.
  moved('snap-detail-moved', '/app/:org/:project/snapshots/:snapshot', '/app/:org/:project/problems', {
    target: (_query, params) => problemsPath(projectRoot(params)), permanent: true, keepQuery: false,
  }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };

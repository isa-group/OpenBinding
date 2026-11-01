import { lazy } from 'react';
import { live } from '../define';
import { fillPath, moved, type MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: studies. A study with its tabs Setup, Progress, Results and Publish; the runs, cells and analytics are views of the study page.

const StudyList = lazy(() => import('../../pages/Studies/StudyList').then((module) => ({ default: module.StudyList })));
const StudyBuilder = lazy(() => import('../../pages/Studies/StudyBuilder').then((module) => ({ default: module.StudyBuilder })));
const StudyDetail = lazy(() => import('../../pages/Studies/StudyDetail').then((module) => ({ default: module.StudyDetail })));

// [impl->req~frontend-retire-screens-not-routed~1]
// [impl->req~frontend-retire-screen-count~1]
// [impl->req~frontend-retire-reports-screens-not-routed~1]
// [impl->req~frontend-retire-reports-screen-count~1]
// [impl->req~frontend-nav-study-page~1]
export const routes: RouteDefinition[] = [
  live('study-list', '/app/:org/:project/studies', <StudyList />),
  live('study-builder', '/app/:org/:project/studies/new', <StudyBuilder />),
  live('study-detail', '/app/:org/:project/studies/:study/:tab?', <StudyDetail />),
];

/** The study page address of a study run (and a cell), the old run, analytics and cell addresses taking the run and cell they named. */
const onStudyPage = (tab: string, withCell = false): MovedRoute['target'] => (_query, params) => {
  const query = new URLSearchParams({ run: params.run ?? '' });
  if (withCell) query.set('cell', params.cell ?? '');
  return `${fillPath(`/app/:org/:project/studies/:study/${tab}`, params)}?${query.toString()}`;
};

// [impl->req~frontend-nav-study-page~1]
const movedAddresses: MovedRoute[] = [
  moved('study-run-moved', '/app/:org/:project/studies/:study/runs/:run', '/app/:org/:project/studies/:study/progress', { target: onStudyPage('progress'), keepQuery: false }),
  moved('study-analytics-moved', '/app/:org/:project/studies/:study/runs/:run/analytics', '/app/:org/:project/studies/:study/results', { target: onStudyPage('results'), keepQuery: false }),
  moved('study-cell-moved', '/app/:org/:project/studies/:study/runs/:run/cells/:cell', '/app/:org/:project/studies/:study/results', { target: onStudyPage('results', true), keepQuery: false }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };

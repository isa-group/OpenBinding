import { lazy } from 'react';
import { live } from './define';
import type { RouteDefinition } from './types';

// D6 · Studies, reports & publications (8 screens)

const StudyList = lazy(() => import('../pages/Studies/StudyList').then((module) => ({ default: module.StudyList })));
const StudyBuilder = lazy(() => import('../pages/Studies/StudyBuilder').then((module) => ({ default: module.StudyBuilder })));
const StudyDetail = lazy(() => import('../pages/Studies/StudyDetail').then((module) => ({ default: module.StudyDetail })));
const StudyRun = lazy(() => import('../pages/Studies/StudyRun').then((module) => ({ default: module.StudyRun })));
const StudyCell = lazy(() => import('../pages/Studies/StudyCell').then((module) => ({ default: module.StudyCell })));
const StudyAnalytics = lazy(() => import('../pages/Studies/StudyAnalytics').then((module) => ({ default: module.StudyAnalytics })));
const ProjPublications = lazy(() => import('../pages/Reports/ProjPublications').then((module) => ({ default: module.ProjPublications })));
const Verifier = lazy(() => import('../pages/Reports/Verifier').then((module) => ({ default: module.Verifier })));

// [impl->req~frontend-retire-screens-not-routed~1]
// [impl->req~frontend-retire-screen-count~1]
// [impl->req~frontend-retire-reports-screens-not-routed~1]
// [impl->req~frontend-retire-reports-screen-count~1]
export const d6Routes: RouteDefinition[] = [
  live('study-list', '/app/:org/:project/studies', <StudyList />),
  live('study-builder', '/app/:org/:project/studies/new', <StudyBuilder />),
  live('study-detail', '/app/:org/:project/studies/:study', <StudyDetail />),
  live('study-run', '/app/:org/:project/studies/:study/runs/:run', <StudyRun />),
  live('study-cell', '/app/:org/:project/studies/:study/runs/:run/cells/:cell', <StudyCell />),
  live('study-analytics', '/app/:org/:project/studies/:study/runs/:run/analytics', <StudyAnalytics />),
  live('proj-publications', '/app/:org/:project/publications', <ProjPublications />),
  live('verifier', '/app/verifier', <Verifier />),
];

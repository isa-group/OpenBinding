import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: problems. The cases of a project, their revisions, the snapshots and the workbench.

const CaseList = lazy(() => import('../../pages/Cases/CaseList').then((module) => ({ default: module.CaseList })));
const CaseDetail = lazy(() => import('../../pages/Cases/CaseDetail').then((module) => ({ default: module.CaseDetail })));
const SnapshotDetail = lazy(() => import('../../pages/Cases/SnapshotDetail').then((module) => ({ default: module.SnapshotDetail })));
const CaseRevision = lazy(() => import('../../pages/Cases/CaseRevision').then((module) => ({ default: module.CaseRevision })));
const CaseCompare = lazy(() => import('../../pages/Cases/CaseCompare').then((module) => ({ default: module.CaseCompare })));
const Workbench = lazy(() => import('../../pages/Workbench/Workbench').then((module) => ({ default: module.Workbench })));

// [impl->req~frontend-retire-composer-screen-not-routed~1]
// [impl->req~frontend-retire-composer-screen-count~1]
export const routes: RouteDefinition[] = [
  live('case-list', '/app/:org/:project/cases', <CaseList />),
  live('case-detail', '/app/:org/:project/cases/:case', <CaseDetail />),
  live('case-revision', '/app/:org/:project/cases/:case/revisions/:revision', <CaseRevision />),
  live('case-compare', '/app/:org/:project/cases/:case/compare', <CaseCompare />),
  live('wb-workbench', '/app/:org/:project/workbench', <Workbench />),
  live('snap-detail', '/app/:org/:project/snapshots/:snapshot', <SnapshotDetail />),
];

export const moved: MovedRoute[] = [];

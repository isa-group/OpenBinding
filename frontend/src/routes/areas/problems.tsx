import { lazy } from 'react';
import { live } from '../define';
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

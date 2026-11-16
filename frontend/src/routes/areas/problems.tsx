import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: problems. The problems of an organization, the problem page with its tabs, and the organization's problem editor (still the Workbench screen).

const ProblemList = lazy(() => import('../../pages/Problems/ProblemList').then((module) => ({ default: module.ProblemList })));
const ProblemDetail = lazy(() => import('../../pages/Problems/ProblemDetail').then((module) => ({ default: module.ProblemDetail })));
const Workbench = lazy(() => import('../../pages/Workbench/Workbench').then((module) => ({ default: module.Workbench })));

export const routes: RouteDefinition[] = [
  live('problem-list', '/app/:org/problems', <ProblemList />),
  live('problem-detail', '/app/:org/problems/:case/:tab?', <ProblemDetail />),
  live('problem-editor', '/app/:org/problem-editor', <Workbench />),
];

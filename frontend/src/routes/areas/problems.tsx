import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: problems. The problems of an organization, the problem page with its tabs, and the organization's problem editor.

const ProblemList = lazy(() =>
  import('../../pages/Problems/ProblemList').then(module => ({ default: module.ProblemList }))
);
const ProblemDetail = lazy(() =>
  import('../../pages/Problems/ProblemDetail').then(module => ({ default: module.ProblemDetail }))
);
const ProblemEditorPage = lazy(() =>
  import('../../pages/Problems/ProblemEditorPage').then(module => ({
    default: module.ProblemEditorPage,
  }))
);

export const routes: RouteDefinition[] = [
  live('problem-list', '/app/:org/problems', <ProblemList />),
  live('problem-detail', '/app/:org/problems/:case/:tab?', <ProblemDetail />),
  live('problem-editor', '/app/:org/problem-editor', <ProblemEditorPage />),
];

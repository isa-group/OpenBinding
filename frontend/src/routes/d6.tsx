import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D6 · Studies, analysis, reports & publications (12 screens)

const StudiesPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.StudiesPage })));
const ProjectRecordsPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.ProjectRecordsPage })));
const AnalysisPage = lazy(() => import('../pages/Platform/AnalysisPage').then((module) => ({ default: module.AnalysisPage })));
const ReportDetailPage = lazy(() => import('../pages/Platform/ReportDetailPage').then((module) => ({ default: module.ReportDetailPage })));
const VerifierPage = lazy(() => import('../pages/Platform/VerifierPage').then((module) => ({ default: module.VerifierPage })));

export const d6Routes: RouteDefinition[] = [
  live('study-list', '/app/:org/:project/studies', <StudiesPage />),
  pending('study-builder', '/app/:org/:project/studies/new'),
  pending('study-detail', '/app/:org/:project/studies/:study'),
  pending('study-run', '/app/:org/:project/studies/:study/runs/:run'),
  pending('study-cell', '/app/:org/:project/studies/:study/runs/:run/cells/:cell'),
  pending('study-analytics', '/app/:org/:project/studies/:study/runs/:run/analytics'),
  live('analysis-sources', '/app/analysis', <AnalysisPage />),
  pending('analysis-workspace', '/app/analysis/workspace'),
  live('rep-list', '/app/:org/:project/reports', <ProjectRecordsPage kind="reports" />),
  live('rep-detail', '/app/:org/:project/reports/:report', <ReportDetailPage />, { paramAliases: { report: 'reportSlug' } }),
  pending('proj-publications', '/app/:org/:project/publications'),
  live('verifier', '/app/verifier', <VerifierPage />),
];

import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D6 · Studies, analysis, reports & publications (12 screens)

const StudyList = lazy(() => import('../pages/Studies/StudyList').then((module) => ({ default: module.StudyList })));
const StudyBuilder = lazy(() => import('../pages/Studies/StudyBuilder').then((module) => ({ default: module.StudyBuilder })));
const StudyDetail = lazy(() => import('../pages/Studies/StudyDetail').then((module) => ({ default: module.StudyDetail })));
const StudyRun = lazy(() => import('../pages/Studies/StudyRun').then((module) => ({ default: module.StudyRun })));
const StudyCell = lazy(() => import('../pages/Studies/StudyCell').then((module) => ({ default: module.StudyCell })));
const StudyAnalytics = lazy(() => import('../pages/Studies/StudyAnalytics').then((module) => ({ default: module.StudyAnalytics })));
const ProjectRecordsPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.ProjectRecordsPage })));
const AnalysisPage = lazy(() => import('../pages/Platform/AnalysisPage').then((module) => ({ default: module.AnalysisPage })));
const ReportDetailPage = lazy(() => import('../pages/Platform/ReportDetailPage').then((module) => ({ default: module.ReportDetailPage })));
const VerifierPage = lazy(() => import('../pages/Platform/VerifierPage').then((module) => ({ default: module.VerifierPage })));

export const d6Routes: RouteDefinition[] = [
  live('study-list', '/app/:org/:project/studies', <StudyList />),
  live('study-builder', '/app/:org/:project/studies/new', <StudyBuilder />),
  live('study-detail', '/app/:org/:project/studies/:study', <StudyDetail />),
  live('study-run', '/app/:org/:project/studies/:study/runs/:run', <StudyRun />),
  live('study-cell', '/app/:org/:project/studies/:study/runs/:run/cells/:cell', <StudyCell />),
  live('study-analytics', '/app/:org/:project/studies/:study/runs/:run/analytics', <StudyAnalytics />),
  live('analysis-sources', '/app/analysis', <AnalysisPage />),
  pending('analysis-workspace', '/app/analysis/workspace'),
  live('rep-list', '/app/:org/:project/reports', <ProjectRecordsPage kind="reports" />),
  live('rep-detail', '/app/:org/:project/reports/:report', <ReportDetailPage />, { paramAliases: { report: 'reportSlug' } }),
  pending('proj-publications', '/app/:org/:project/publications'),
  live('verifier', '/app/verifier', <VerifierPage />),
];

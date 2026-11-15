import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: studies (organization-level since F0b B7). A study with its tabs Setup, Progress and Results; the runs, cells and analytics are
// views of the study page.

const StudyList = lazy(() => import('../../pages/Studies/StudyList').then((module) => ({ default: module.StudyList })));
const StudyBuilder = lazy(() => import('../../pages/Studies/StudyBuilder').then((module) => ({ default: module.StudyBuilder })));
const StudyDetail = lazy(() => import('../../pages/Studies/StudyDetail').then((module) => ({ default: module.StudyDetail })));

export const routes: RouteDefinition[] = [
  live('study-list', '/app/:org/studies', <StudyList />),
  live('study-builder', '/app/:org/studies/new', <StudyBuilder />),
  live('study-detail', '/app/:org/studies/:study/:tab?', <StudyDetail />),
];

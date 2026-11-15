import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: studies. A study with its tabs Setup, Progress, Results and Publish; the runs, cells and analytics are views of the study page.

const StudyList = lazy(() => import('../../pages/Studies/StudyList').then((module) => ({ default: module.StudyList })));
const StudyBuilder = lazy(() => import('../../pages/Studies/StudyBuilder').then((module) => ({ default: module.StudyBuilder })));
const StudyDetail = lazy(() => import('../../pages/Studies/StudyDetail').then((module) => ({ default: module.StudyDetail })));

export const routes: RouteDefinition[] = [
  live('study-list', '/app/:org/:project/studies', <StudyList />),
  live('study-builder', '/app/:org/:project/studies/new', <StudyBuilder />),
  live('study-detail', '/app/:org/:project/studies/:study/:tab?', <StudyDetail />),
];

import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: project. The project page and its settings (General and Members).

const ProjectOverview = lazy(() => import('../../pages/Project/ProjectOverview').then((module) => ({ default: module.ProjectOverview })));
const ProjectSettings = lazy(() => import('../../pages/Project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));

export const routes: RouteDefinition[] = [
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  live('proj-settings', '/app/:org/:project/settings/:section?', <ProjectSettings />),
];

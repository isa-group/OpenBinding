import { lazy } from 'react';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: project. The project page, its settings (General and Members) and its published results.

const ProjectCreate = lazy(() => import('../../pages/Project/ProjectCreate').then((module) => ({ default: module.ProjectCreate })));
const ProjectOverview = lazy(() => import('../../pages/Project/ProjectOverview').then((module) => ({ default: module.ProjectOverview })));
const ProjectSettings = lazy(() => import('../../pages/Project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));
const ProjPublications = lazy(() => import('../../pages/Reports/ProjPublications').then((module) => ({ default: module.ProjPublications })));

// [impl->req~frontend-nav-project-tabs~1]
export const routes: RouteDefinition[] = [
  live('proj-create', '/app/:org/new-project', <ProjectCreate />),
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  live('proj-settings', '/app/:org/:project/settings/:section?', <ProjectSettings />),
  live('proj-publications', '/app/:org/:project/published', <ProjPublications />),
];

// `/files` stays valid: the gateway's resolve `web_url` for a file points there. `/package` and `/publications` are on their way out.
// [impl->req~frontend-nav-files-retired~1]
// [impl->req~frontend-nav-project-tabs~1]
const movedAddresses: MovedRoute[] = [
  moved('proj-moved-publications', '/app/:org/:project/publications', '/app/:org/:project/published'),
  moved('proj-moved-files', '/app/:org/:project/files', '/app/:org/:project', { permanent: true, keepQuery: false }),
  moved('proj-moved-package', '/app/:org/:project/package', '/app/:org/:project/settings', { keepQuery: false }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };

import { lazy } from 'react';
import { live } from '../define';
import { fillPath, moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: project. The project page, its settings (General and Members) and its published results.

const ProjectOverview = lazy(() => import('../../pages/Project/ProjectOverview').then((module) => ({ default: module.ProjectOverview })));
const ProjectSettings = lazy(() => import('../../pages/Project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));
const ProjPublications = lazy(() => import('../../pages/Reports/ProjPublications').then((module) => ({ default: module.ProjPublications })));

export const routes: RouteDefinition[] = [
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  live('proj-settings', '/app/:org/:project/settings/:section?', <ProjectSettings />),
  live('proj-publications', '/app/:org/:project/published', <ProjPublications />),
];

// A new project is made in the dialog over the organization, open at `/app/:org?create=project`.
// `/files` stays valid: the gateway's resolve `web_url` for a file points there. `/package` and `/publications` are on their way out.
const movedAddresses: MovedRoute[] = [
  moved('proj-moved-create', '/app/:org/new-project', '/app/:org', { target: (_query, params) => `${fillPath('/app/:org', params)}?create=project`, keepQuery: false }),
  moved('proj-moved-publications', '/app/:org/:project/publications', '/app/:org/:project/published'),
  moved('proj-moved-files', '/app/:org/:project/files', '/app/:org/:project', { permanent: true, keepQuery: false }),
  moved('proj-moved-package', '/app/:org/:project/package', '/app/:org/:project/settings', { keepQuery: false }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };

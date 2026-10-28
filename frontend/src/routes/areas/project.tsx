import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: project. The project page and its settings, package, files and publications.

const ProjectCreate = lazy(() => import('../../pages/Project/ProjectCreate').then((module) => ({ default: module.ProjectCreate })));
const ProjectOverview = lazy(() => import('../../pages/Project/ProjectOverview').then((module) => ({ default: module.ProjectOverview })));
const ProjectSettings = lazy(() => import('../../pages/Project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));
const ProjectPackage = lazy(() => import('../../pages/Project/ProjectPackage').then((module) => ({ default: module.ProjectPackage })));
const ProjFiles = lazy(() => import('../../pages/Resources/ProjFiles').then((module) => ({ default: module.ProjFiles })));
const ProjPublications = lazy(() => import('../../pages/Reports/ProjPublications').then((module) => ({ default: module.ProjPublications })));

export const routes: RouteDefinition[] = [
  live('proj-create', '/app/:org/new-project', <ProjectCreate />),
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  live('proj-settings', '/app/:org/:project/settings', <ProjectSettings />),
  live('proj-package', '/app/:org/:project/package', <ProjectPackage />),
  live('proj-files', '/app/:org/:project/files', <ProjFiles />),
  live('proj-publications', '/app/:org/:project/publications', <ProjPublications />),
];

export const moved: MovedRoute[] = [];

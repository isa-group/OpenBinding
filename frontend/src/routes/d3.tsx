import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D3 · Organization & collaboration (10 screens)

const PlatformDashboard = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.PlatformDashboard })));
const ProjectOverview = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.ProjectOverview })));
const OrganizationSettingsPage = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.OrganizationSettingsPage })));

export const d3Routes: RouteDefinition[] = [
  live('app-home', '/app', <PlatformDashboard />),
  pending('org-create', '/app/organizations/new'),
  live('org-overview', '/app/:org', <ProjectOverview />),
  live('org-settings', '/app/:org/settings', <OrganizationSettingsPage />),
  pending('org-members', '/app/:org/settings/members'),
  pending('org-audit', '/app/:org/settings/audit'),
  pending('proj-create', '/app/:org/new-project'),
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  pending('proj-settings', '/app/:org/:project/settings'),
  pending('proj-package', '/app/:org/:project/package'),
];

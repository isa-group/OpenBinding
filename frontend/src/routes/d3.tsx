import { lazy } from 'react';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D3 · Organization & collaboration (10 screens)

const AppHome = lazy(() => import('../pages/AppHome/AppHome').then((module) => ({ default: module.AppHome })));
const OrgCreate = lazy(() => import('../pages/Organization/OrgCreate').then((module) => ({ default: module.OrgCreate })));
const OrgOverview = lazy(() => import('../pages/Organization/OrgOverview').then((module) => ({ default: module.OrgOverview })));
const OrgSettings = lazy(() => import('../pages/Organization/OrgSettings').then((module) => ({ default: module.OrgSettings })));
const OrgMembers = lazy(() => import('../pages/Organization/OrgMembers').then((module) => ({ default: module.OrgMembers })));
const OrgAudit = lazy(() => import('../pages/Organization/OrgAudit').then((module) => ({ default: module.OrgAudit })));
// The project screens are rebuilt in the next task; the project overview still renders the current page.
const ProjectOverview = lazy(() => import('../pages/Platform/PlatformPages').then((module) => ({ default: module.ProjectOverview })));

export const d3Routes: RouteDefinition[] = [
  live('app-home', '/app', <AppHome />),
  live('org-create', '/app/organizations/new', <OrgCreate />),
  live('org-overview', '/app/:org', <OrgOverview />),
  live('org-settings', '/app/:org/settings', <OrgSettings />),
  live('org-members', '/app/:org/settings/members', <OrgMembers />),
  live('org-audit', '/app/:org/settings/audit', <OrgAudit />),
  pending('proj-create', '/app/:org/new-project'),
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  pending('proj-settings', '/app/:org/:project/settings'),
  pending('proj-package', '/app/:org/:project/package'),
];

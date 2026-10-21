import { lazy } from 'react';
import { live } from './define';
import type { RouteDefinition } from './types';

// D3 · Organization & collaboration (10 screens)

const AppHome = lazy(() => import('../pages/AppHome/AppHome').then((module) => ({ default: module.AppHome })));
const OrgCreate = lazy(() => import('../pages/Organization/OrgCreate').then((module) => ({ default: module.OrgCreate })));
const OrgOverview = lazy(() => import('../pages/Organization/OrgOverview').then((module) => ({ default: module.OrgOverview })));
const OrgSettings = lazy(() => import('../pages/Organization/OrgSettings').then((module) => ({ default: module.OrgSettings })));
const OrgMembers = lazy(() => import('../pages/Organization/OrgMembers').then((module) => ({ default: module.OrgMembers })));
const OrgAudit = lazy(() => import('../pages/Organization/OrgAudit').then((module) => ({ default: module.OrgAudit })));
const ProjectCreate = lazy(() => import('../pages/Project/ProjectCreate').then((module) => ({ default: module.ProjectCreate })));
const ProjectOverview = lazy(() => import('../pages/Project/ProjectOverview').then((module) => ({ default: module.ProjectOverview })));
const ProjectSettings = lazy(() => import('../pages/Project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));
const ProjectPackage = lazy(() => import('../pages/Project/ProjectPackage').then((module) => ({ default: module.ProjectPackage })));

export const d3Routes: RouteDefinition[] = [
  live('app-home', '/app', <AppHome />),
  live('org-create', '/app/organizations/new', <OrgCreate />),
  live('org-overview', '/app/:org', <OrgOverview />),
  live('org-settings', '/app/:org/settings', <OrgSettings />),
  live('org-members', '/app/:org/settings/members', <OrgMembers />),
  live('org-audit', '/app/:org/settings/audit', <OrgAudit />),
  live('proj-create', '/app/:org/new-project', <ProjectCreate />),
  live('proj-overview', '/app/:org/:project', <ProjectOverview />),
  live('proj-settings', '/app/:org/:project/settings', <ProjectSettings />),
  live('proj-package', '/app/:org/:project/package', <ProjectPackage />),
];

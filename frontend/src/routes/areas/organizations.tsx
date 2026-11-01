import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: organizations. The workspace home and the organization pages.

const AppHome = lazy(() => import('../../pages/AppHome/AppHome').then((module) => ({ default: module.AppHome })));
const OrgCreate = lazy(() => import('../../pages/Organization/OrgCreate').then((module) => ({ default: module.OrgCreate })));
const OrgOverview = lazy(() => import('../../pages/Organization/OrgOverview').then((module) => ({ default: module.OrgOverview })));
const OrgSettings = lazy(() => import('../../pages/Organization/OrgSettings').then((module) => ({ default: module.OrgSettings })));

export const routes: RouteDefinition[] = [
  live('app-home', '/app', <AppHome />),
  live('org-create', '/app/organizations/new', <OrgCreate />),
  live('org-overview', '/app/:org', <OrgOverview />),
  live('org-settings', '/app/:org/settings/:section?', <OrgSettings />),
];

export const moved: MovedRoute[] = [];

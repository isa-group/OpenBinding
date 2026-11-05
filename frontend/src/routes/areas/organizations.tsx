import { lazy } from 'react';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: organizations. The workspace home and the organization pages. A new organization is made in the dialog over the home,
// open at `/app?create=organization`.

const AppHome = lazy(() => import('../../pages/AppHome/AppHome').then((module) => ({ default: module.AppHome })));
const OrgOverview = lazy(() => import('../../pages/Organization/OrgOverview').then((module) => ({ default: module.OrgOverview })));
const OrgSettings = lazy(() => import('../../pages/Organization/OrgSettings').then((module) => ({ default: module.OrgSettings })));

export const routes: RouteDefinition[] = [
  live('app-home', '/app', <AppHome />),
  live('org-overview', '/app/:org', <OrgOverview />),
  live('org-settings', '/app/:org/settings/:section?', <OrgSettings />),
];

const movedAddresses: MovedRoute[] = [
  moved('org-moved-create', '/app/organizations/new', '/app?create=organization', { keepQuery: false }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };

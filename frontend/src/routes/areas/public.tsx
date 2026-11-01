import { lazy } from 'react';
import { Home } from '../../pages/Home/Home';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: public. The pages anybody can open without an account.
// [impl->req~frontend-nav-status-retired~1]
// [impl->req~frontend-nav-examples-in-explore~1]

const ExplorePage = lazy(() => import('../../pages/Public/Explore').then((module) => ({ default: module.ExplorePage })));
const About = lazy(() => import('../../pages/About/About').then((module) => ({ default: module.About })));
const WorkbenchPage = lazy(() => import('../../pages/Public/PublicPages').then((module) => ({ default: module.WorkbenchPage })));
const Pricing = lazy(() => import('../../pages/Pricing/Pricing').then((module) => ({ default: module.Pricing })));

export const routes: RouteDefinition[] = [
  live('pub-home', '/', <Home />),
  live('pub-explore', '/explore/:section?', <ExplorePage />),
  live('pub-workbench', '/workbench', <WorkbenchPage />),
  live('pub-about', '/about', <About />),
  live('pub-pricing', '/pricing', <Pricing />),
];

// The status page is gone: About holds a one-line note of the same check.
const movedAddresses: MovedRoute[] = [
  moved('status-retired', '/status', '/about', { keepQuery: false }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };

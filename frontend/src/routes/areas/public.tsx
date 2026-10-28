import { lazy } from 'react';
import { Home } from '../../pages/Home/Home';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: public. The pages anybody can open without an account.

const ExplorePage = lazy(() => import('../../pages/Public/Explore').then((module) => ({ default: module.ExplorePage })));
const About = lazy(() => import('../../pages/About/About').then((module) => ({ default: module.About })));
const Status = lazy(() => import('../../pages/Status/Status').then((module) => ({ default: module.Status })));
const WorkbenchPage = lazy(() => import('../../pages/Public/PublicPages').then((module) => ({ default: module.WorkbenchPage })));
const Pricing = lazy(() => import('../../pages/Pricing/Pricing').then((module) => ({ default: module.Pricing })));

export const routes: RouteDefinition[] = [
  live('pub-home', '/', <Home />),
  live('pub-explore', '/explore', <ExplorePage />),
  live('pub-workbench', '/workbench', <WorkbenchPage />),
  live('pub-about', '/about', <About />),
  live('pub-status', '/status', <Status />),
  live('pub-pricing', '/pricing', <Pricing />),
];

export const moved: MovedRoute[] = [];

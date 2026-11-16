import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: compositions. The public compositions of every organization and the public page of one, which anybody opens and signed-in
// people see in the application layout; the compositions of an organization and the composition page with its tabs.

const PublicCompositionList = lazy(() => import('../../pages/PublicCompositions/PublicCompositionList').then((module) => ({ default: module.PublicCompositionList })));
const Showcase = lazy(() => import('../../pages/PublicCompositions/Showcase').then((module) => ({ default: module.Showcase })));
const CompositionList = lazy(() => import('../../pages/Compositions/CompositionList').then((module) => ({ default: module.CompositionList })));
const CompositionDetail = lazy(() => import('../../pages/Compositions/CompositionDetail').then((module) => ({ default: module.CompositionDetail })));

export const routes: RouteDefinition[] = [
  live('pub-compositions', '/compositions', <PublicCompositionList />, { sessionHeader: true }),
  live('pub-showcase', '/c/:org/:composition', <Showcase />, { sessionHeader: true }),
  live('composition-list', '/app/:org/compositions', <CompositionList />),
  live('composition-detail', '/app/:org/compositions/:composition/:tab?', <CompositionDetail />),
];

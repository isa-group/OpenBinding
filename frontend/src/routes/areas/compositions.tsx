import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: compositions. The compositions of an organization and the composition page with its tabs.

const CompositionList = lazy(() => import('../../pages/Compositions/CompositionList').then((module) => ({ default: module.CompositionList })));
const CompositionDetail = lazy(() => import('../../pages/Compositions/CompositionDetail').then((module) => ({ default: module.CompositionDetail })));

export const routes: RouteDefinition[] = [
  live('composition-list', '/app/:org/compositions', <CompositionList />),
  live('composition-detail', '/app/:org/compositions/:composition/:tab?', <CompositionDetail />),
];

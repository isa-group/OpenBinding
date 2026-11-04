import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: collections. The collections of a project.

const CollList = lazy(() => import('../../pages/Resources/CollList').then((module) => ({ default: module.CollList })));
const CollDetail = lazy(() => import('../../pages/Resources/CollDetail').then((module) => ({ default: module.CollDetail })));

// [impl->req~frontend-retire-library-screens-not-routed~1]
// [impl->req~frontend-retire-library-screen-count~1]
export const routes: RouteDefinition[] = [
  live('coll-list', '/app/:org/:project/collections', <CollList />),
  live('coll-detail', '/app/:org/:project/collections/:collection', <CollDetail />),
];

export const moved: MovedRoute[] = [];

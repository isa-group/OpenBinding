import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: verify. The permanent link of a result and the verifier.

const Resolve = lazy(() => import('../../pages/Resolve/Resolve').then((module) => ({ default: module.Resolve })));
const Verifier = lazy(() => import('../../pages/Reports/Verifier').then((module) => ({ default: module.Verifier })));

export const routes: RouteDefinition[] = [
  live('pub-resolve', '/resolve/:kind/:digest', <Resolve />),
  live('verifier', '/app/verifier', <Verifier />),
];

export const moved: MovedRoute[] = [];

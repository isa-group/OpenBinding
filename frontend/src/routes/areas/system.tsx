import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: system. Screens for the people who build the application.

const States = lazy(() => import('../../pages/System/States').then((module) => ({ default: module.States })));

export const routes: RouteDefinition[] = [
  live('sys-states', '/app/system/states', <States />),
];

export const moved: MovedRoute[] = [];

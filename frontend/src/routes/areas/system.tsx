import { lazy } from 'react';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: system. Screens for the people who build the application. They exist in development builds only.

// The import sits behind the build flag so that a production bundle holds the page nowhere.
const States = import.meta.env.DEV
  ? lazy(() => import('../../pages/System/States').then((module) => ({ default: module.States })))
  : null;

export const routes: RouteDefinition[] = [
  live('sys-states', '/app/system/states', States ? <States /> : null, { devOnly: true }),
];

export const moved: MovedRoute[] = [];

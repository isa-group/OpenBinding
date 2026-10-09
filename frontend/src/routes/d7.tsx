import { lazy } from 'react';
import { RegisterEngine } from '../pages/RegisterEngine/RegisterEngine';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D7 · Engines & language (account) (4 screens)

const AppEngines = lazy(() => import('../pages/Platform/AppEngines').then((module) => ({ default: module.AppEngines })));

export const d7Routes: RouteDefinition[] = [
  live('eng-register', '/app/engines/new', <RegisterEngine />),
  live('eng-registrations', '/app/engines/registrations', <AppEngines />),
  pending('eng-registration-detail', '/app/engines/registrations/:name'),
  pending('lang-extensions', '/app/language/extensions'),
];

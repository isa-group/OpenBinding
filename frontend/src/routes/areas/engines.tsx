import { lazy } from 'react';
import { Engines } from '../../pages/Engines/Engines';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: engines. The public catalog and the engines registered by the account.

const EngineDetail = lazy(() => import('../../pages/EngineDetail/EngineDetail').then((module) => ({ default: module.EngineDetail })));
const RegisterEngine = lazy(() => import('../../pages/RegisterEngine/RegisterEngine').then((module) => ({ default: module.RegisterEngine })));
const EngRegistrations = lazy(() => import('../../pages/Engines/EngRegistrations').then((module) => ({ default: module.EngRegistrations })));
const EngRegistrationDetail = lazy(() => import('../../pages/Engines/EngRegistrationDetail').then((module) => ({ default: module.EngRegistrationDetail })));

export const routes: RouteDefinition[] = [
  live('eng-catalog', '/engines', <Engines />),
  live('eng-detail', '/engines/:namespace/:name/:version', <EngineDetail />),
  live('eng-register', '/app/engines/new', <RegisterEngine />),
  live('eng-registrations', '/app/engines/registrations', <EngRegistrations />),
  live('eng-registration-detail', '/app/engines/registrations/:name', <EngRegistrationDetail />),
];

export const moved: MovedRoute[] = [];

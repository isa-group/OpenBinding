import { lazy } from 'react';
import { live } from './define';
import type { RouteDefinition } from './types';

// D7 · Engines & language (account) (4 screens)

const RegisterEngine = lazy(() => import('../pages/RegisterEngine/RegisterEngine').then((module) => ({ default: module.RegisterEngine })));
const EngRegistrations = lazy(() => import('../pages/Engines/EngRegistrations').then((module) => ({ default: module.EngRegistrations })));
const EngRegistrationDetail = lazy(() => import('../pages/Engines/EngRegistrationDetail').then((module) => ({ default: module.EngRegistrationDetail })));
const LangExtensions = lazy(() => import('../pages/Engines/LangExtensions').then((module) => ({ default: module.LangExtensions })));

export const d7Routes: RouteDefinition[] = [
  live('eng-register', '/app/engines/new', <RegisterEngine />),
  live('eng-registrations', '/app/engines/registrations', <EngRegistrations />),
  live('eng-registration-detail', '/app/engines/registrations/:name', <EngRegistrationDetail />),
  live('lang-extensions', '/app/language/extensions', <LangExtensions />),
];

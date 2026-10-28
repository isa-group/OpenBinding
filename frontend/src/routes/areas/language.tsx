import { lazy } from 'react';
import { Examples } from '../../pages/Examples/Examples';
import { Profiles } from '../../pages/Profiles/Profiles';
import { live } from '../define';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: language. The problem language: profiles, schemas, examples and the extensions of the account.

const Schemas = lazy(() => import('../../pages/Schemas/Schemas').then((module) => ({ default: module.Schemas })));
const LangExtensions = lazy(() => import('../../pages/Engines/LangExtensions').then((module) => ({ default: module.LangExtensions })));

export const routes: RouteDefinition[] = [
  live('lang-profiles', '/language', <Profiles />),
  live('lang-schemas', '/language/schemas/:kind', <Schemas />),
  live('lang-examples', '/examples', <Examples />),
  live('lang-extensions', '/app/language/extensions', <LangExtensions />),
];

export const moved: MovedRoute[] = [];

import * as account from './areas/account';
import * as admin from './areas/admin';
import * as auth from './areas/auth';
import * as collections from './areas/collections';
import * as engines from './areas/engines';
import * as language from './areas/language';
import * as organizations from './areas/organizations';
import * as problems from './areas/problems';
import * as project from './areas/project';
import * as publicArea from './areas/public';
import * as runs from './areas/runs';
import * as studies from './areas/studies';
import * as system from './areas/system';
import * as verify from './areas/verify';
import type { MovedRoute } from './moved';
import type { RouteDefinition } from './types';

/** The area modules, in registry order. Each area file belongs to the tasks that change its screens. */
const areas = {
  public: publicArea,
  auth,
  verify,
  system,
  language,
  engines,
  account,
  organizations,
  project,
  problems,
  collections,
  runs,
  studies,
  admin,
} as const;

export type AreaName = keyof typeof areas;

/** One list of screens per area. */
export const routesByArea = Object.fromEntries(
  Object.entries(areas).map(([name, area]) => [name, area.routes]),
) as Record<AreaName, RouteDefinition[]>;

export const routeDefinitions: RouteDefinition[] = Object.values(routesByArea).flat();

/** The addresses that moved, from every area. */
export const movedRoutes: MovedRoute[] = Object.values(areas).flatMap((area) => area.moved);

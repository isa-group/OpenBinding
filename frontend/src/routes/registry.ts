import * as account from './areas/account';
import * as admin from './areas/admin';
import * as auth from './areas/auth';
import * as compositions from './areas/compositions';
import * as engines from './areas/engines';
import * as organizations from './areas/organizations';
import * as problems from './areas/problems';
import * as publicArea from './areas/public';
import * as runs from './areas/runs';
import * as studies from './areas/studies';
import type { RouteDefinition } from './types';

/** The area modules, in registry order. Each area file belongs to the tasks that change its screens. */
const areas = {
  public: publicArea,
  auth,
  engines,
  account,
  organizations,
  compositions,
  problems,
  runs,
  studies,
  admin,
} as const;

export type AreaName = keyof typeof areas;

/** One list of screens per area. */
export const routesByArea = Object.fromEntries(
  Object.entries(areas).map(([name, area]) => [name, area.routes])
) as Record<AreaName, RouteDefinition[]>;

export const routeDefinitions: RouteDefinition[] = Object.values(routesByArea).flat();

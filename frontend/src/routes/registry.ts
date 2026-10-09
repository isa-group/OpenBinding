import { d1Routes } from './d1';
import { d2Routes } from './d2';
import { d3Routes } from './d3';
import { d4Routes } from './d4';
import { d5Routes } from './d5';
import { d6Routes } from './d6';
import { d7Routes } from './d7';
import { d8Routes } from './d8';
import type { RouteDefinition } from './types';

/** One list per prototype domain. Each domain file belongs to the tasks that rebuild its screens. */
export const routesByDomain = {
  D1: d1Routes,
  D2: d2Routes,
  D3: d3Routes,
  D4: d4Routes,
  D5: d5Routes,
  D6: d6Routes,
  D7: d7Routes,
  D8: d8Routes,
} as const;

export const routeDefinitions: RouteDefinition[] = Object.values(routesByDomain).flat();

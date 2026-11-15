import type { components } from './openapi';

// Named aliases of the generated gateway schemas the frontend reads. They are type names only: the shapes live in openapi.ts,
// which `pnpm gen:api` writes from docs/openapi.json. Add an alias when a module first needs a schema.

type Schemas = components['schemas'];

/** The single-task swaps of one solution of a run (`GET …/runs/{run}/neighborhood`). */
export type NeighborhoodResponse = Schemas['NeighborhoodResponse'];

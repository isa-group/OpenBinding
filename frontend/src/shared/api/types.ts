import type { components } from './openapi';

// Named aliases of the generated gateway schemas the frontend reads. They are type names only: the shapes live in openapi.ts,
// which `pnpm gen:api` writes from docs/openapi.json. Add an alias when a module first needs a schema.

type Schemas = components['schemas'];

/** The single-task swaps of one solution of a run (`GET …/runs/{run}/neighborhood`). */
export type NeighborhoodResponse = Schemas['NeighborhoodResponse'];

/** The facts of one compiled problem (`GET …/compilations/{compilation}/facts`; `facts` of `POST /v1/bim/validate?include=facts`). */
export type ProblemFacts = Schemas['ProblemFactsView'];

/** What changed from one version of a composition to another (`GET …/compositions/{composition}/diff`). */
export type CompositionVersionDiff = Schemas['CompositionVersionDiff'];

/** One candidate of a problem's facts: its key, provider, values by feature and where each value is written. */
export type ProblemFactsCandidate = Schemas['ProblemFactsCandidate'];

/** One constraint of a problem's facts: `<resource>/<id>`, its enforcement and its IR expressions. */
export type ProblemFactsConstraint = Schemas['ProblemFactsConstraint'];

/** Where a value of a candidate is written in its package (`kind: package`; F3 adds the other origins). */
export type ProblemValueOrigin = Schemas['ProblemValueOrigin'];

/** What `POST /v1/bim/validate` answers for a valid package, with `facts` when `include=facts` asks for them. */
export type AnalysisResult = Schemas['AnalysisResult'];

/** One version of a composition as the gateway serves it (`GET …/compositions/{composition}/versions/{version}`). */
export type CompositionVersionView = Schemas['CompositionVersionView'];

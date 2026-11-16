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

/** Where the latest version of a problem came from: an upload, the problem editor, QACOForge or (F3) SPHERE. */
export type ProblemOrigin = Schemas['LatestRevision']['origin'];

/** Where a value of a candidate is written in its package (`kind: package`; F3 adds the other origins). */
export type ProblemValueOrigin = Schemas['ProblemValueOrigin'];

/** What `POST /v1/bim/validate` answers for a valid package, with `facts` when `include=facts` asks for them. */
export type AnalysisResult = Schemas['AnalysisResult'];

/** One version of a composition as the gateway serves it (`GET …/compositions/{composition}/versions/{version}`). */
export type CompositionVersionView = Schemas['CompositionVersionView'];

/** A composition of an organization (`GET …/compositions/{composition}`); a public reader gets it with member ids removed. */
export type CompositionView = Schemas['CompositionView'];

/** The latest version of a composition as a composition view and its list name it, with whether its values are verified. */
export type CompositionVersionSummary = Schemas['CompositionVersionSummary'];

/** A page of an organization's compositions (`GET /v1/organizations/{org}/compositions`). */
export type CompositionList = Schemas['CompositionList'];

/** A page of the public compositions of every organization (`GET /v1/compositions`). */
export type PublicCompositionList = Schemas['PublicCompositionList'];

/** What creating a composition takes (`POST …/compositions`). */
export type CompositionCreate = Schemas['CompositionCreate'];

/** What a change of a composition may name (`PATCH …/compositions/{composition}`). */
export type CompositionUpdate = Schemas['CompositionUpdate'];

/** A page of a composition's versions (`GET …/versions`): light rows unless `include` asks for more. */
export type CompositionVersionList = Schemas['CompositionVersionList'];

/** One evaluation of a version: its outcome, values, the binding the toolchain was given and what it found. */
export type EvaluationView = Schemas['EvaluationView'];

/** The current evaluation of a version, named on every version view (a light row included). */
export type EvaluationSummary = Schemas['EvaluationSummary'];

/** Where a version was derived from: a run and its point, or a binding of a problem revision. */
export type VersionDerivation = Schemas['VersionDerivation'];

/** What a version was forked from. */
export type ForkedFrom = Schemas['ForkedFrom'];

/** A global value of a version or an evaluation: the number and its unit as written (`"1"` when it has none). */
export type ValueView = Schemas['ValueView'];

/** A finding about a Composition2Yaml document, located by path, pointer and (in text) span. */
export type CompositionDiagnosticView = Schemas['CompositionDiagnosticView'];

/** What checking a document against a composition answers (`POST …/versions/check`), storing nothing. */
export type CheckResult = Schemas['CheckResult'];

/** What sealing a document answers (`POST …/versions`), 201 for a new version and 200 for the one that holds its bytes. */
export type SealResult = Schemas['SealResult'];

/** What a fork answers when it forked (201). */
export type ForkResult = Schemas['ForkResult'];

/** What a fork answers when the source's slug is taken in the target and none was given (200). */
export type ForkNameTaken = Schemas['ForkNameTaken'];

/** What forking a version takes (`POST …/fork`). */
export type CompositionFork = Schemas['CompositionFork'];

/** What evaluating another binding of a version takes (`POST …/evaluate`). */
export type CompositionEvaluate = Schemas['CompositionEvaluate'];

/** The values and validity of another binding of a version, as the toolchain computed them. */
export type EvaluateResult = Schemas['EvaluateResult'];

/** The toolchain's one-task alternatives of a version's binding (`GET …/neighborhood`). */
export type CompositionNeighborhoodResponse = Schemas['CompositionNeighborhoodResponse'];

/** One move of a composition's neighbourhood: a task bound to another candidate, as the toolchain compared it with the version's binding. */
export type CompositionMove = Schemas['CompositionMove'];

/** What deriving a version takes (`POST …/derive`): a run and its point, or a binding of a problem revision. */
export type CompositionDerive = Schemas['CompositionDerive'];

/** A derived version, sealed. */
export type DeriveResult = Schemas['DeriveResult'];

/** A derived document that was not sealed (`seal: false`). */
export type DeriveDraft = Schemas['DeriveDraft'];

/** What linting a Composition2Yaml text answers (`POST /v1/compositions/validate`). */
export type ValidateResult = Schemas['ValidateResult'];

/** A Composition2Yaml text read as its JSON model (`POST /v1/compositions/parse`). */
export type ParseResult = Schemas['ParseResult'];

/** What changed between two Composition2Yaml texts (`POST /v1/compositions/diff`). */
export type DiffResult = Schemas['DiffResult'];

/** A run preset of an organization (`GET …/presets/{preset}`); below MEMBER its options are redacted, as a run's are. */
export type RunPresetView = Schemas['RunPresetView'];

/** A page of an organization's run presets, by name (`GET …/presets`). */
export type RunPresetList = Schemas['RunPresetList'];

/** What creating a run preset takes (`POST …/presets`). */
export type RunPresetCreate = Schemas['RunPresetCreate'];

/** What a change of a run preset may name (`PATCH …/presets/{preset}`); absent fields stay. */
export type RunPresetUpdate = Schemas['RunPresetUpdate'];

/** An exact engine or deployment reference: namespace, name, version and digest. */
export type ImmutableResourceRef = Schemas['ImmutableResourceRef'];

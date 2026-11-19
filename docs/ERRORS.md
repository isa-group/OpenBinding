# Errors: one problem document for every 422

Every `422` the gateway sends — a request Pydantic refuses, a route that refuses a
value it understood, the BIM compiler refusing a package, the pricing linter
refusing a document — has the same body. It follows RFC 9457 (problem details),
extended with a stable `code` and a list of `diagnostics`. OpenAPI names it
`Problem`; each finding is a `Diagnostic`.

```json
{
  "type": "https://openbinding.dev/problems/validation_error",
  "title": "validation_error",
  "status": 422,
  "code": "validation_error",
  "detail": "Request validation failed: /spec/limits/maxTasks: Input should be greater than 0 (+1 more)",
  "diagnostics": [
    {
      "code": "greater_than",
      "message": "Input should be greater than 0",
      "in": "body",
      "pointer": "/spec/limits/maxTasks",
      "loc": ["body", "spec", "limits", "maxTasks"],
      "context": {"gt": 0}
    }
  ]
}
```

## Problem

| Field | Type | Meaning |
|---|---|---|
| `type` | string | `https://openbinding.dev/problems/<code>` |
| `title` | string | **Same value as `code`.** `/v1/bim/validate` and the other BIM routes always did this and clients read `title` as the code; it is kept. |
| `status` | integer | the HTTP status (`422`) |
| `code` | string | stable, machine-readable. `validation_error` when the request itself is malformed (types, required fields, ranges, JSON syntax); a specific code (`weak_password`, `invalid_instance`, `checksum_mismatch`, …) when a route refuses a value it understood. |
| `detail` | string | one-line, human-readable summary. For request validation: `Request validation failed: <pointer or parameter>: <message>` plus `(+N more)`. |
| `diagnostics` | array | **always present and never empty on a 422.** A refusal that names no finer detail has one diagnostic restating `code`/`detail`. |

A route may add fields of its own beside these (for example `conflicts` on
`incompatible_target_engines`). They never replace a canonical key; if one tried
to, it is kept under `extra`.

## Diagnostic

| Field | Present | Meaning |
|---|---|---|
| `code` | always | for request validation, the Pydantic error type (`missing`, `string_type`, `greater_than_equal`, `too_short`, `extra_forbidden`, `json_invalid`, …); otherwise the route's or the compiler's finding code |
| `message` | always | human-readable |
| `pointer` | when a field is at fault | RFC 6901 JSON Pointer (`/spec/limits/maxTasks`, `/features/0`; keys are escaped with `~0`/`~1`). Into the request body for validation errors; into `resource` for compiler findings; into the YAML for pricing. |
| `in` | request validation | `body`, `query`, `path`, `header` or `cookie` |
| `parameter` | `in` ≠ `body` | the query/path/header/cookie parameter (`limit`, `cursor`) |
| `resource` | compiler findings | the package file the finding is about |
| `span` | when known | position in the source text: `{"offset": 12}` for malformed JSON; `{"line", "column"}` for documents; for Composition2Yaml documents always present, `{"line", "column", "end_line", "end_column"}` (one-based, the end exclusive) or `null` when there is no text to point into (a JSON document) |
| `severity` | Composition2Yaml findings | `error` refuses the document; `warning` and `info` only inform (one list, errors first) |
| `path` | Composition2Yaml findings | the dotted path of the element at fault (`binding.t1.from.version`, `workflow.seq[1].and[0]`; empty for the whole document). Readable but ambiguous, since a task id may contain a dot; `pointer` (always present on these findings, `""` for the document) is built from the same segments and is not |
| `document` | a refused `diffCompositions` | `before` or `after`: the side the finding is about |
| `hint` / `fix` | when known | what to do / a concrete replacement (`"This field is required."`, the JSON parser's reason) |
| `loc` | request validation | the raw Pydantic location (`["body", "features", 0]`), nothing lost |
| `context` | request validation | the limits that were exceeded (`{"ge": 1}`, `{"max_length": 64}`) — scalars only |
| `related`, `bpmnElement`, `irPath` | compiler findings | unchanged |
| `category`, `unsupported`, `allowed` | `unsupported_capability_value` | the capability dimension (`featureValues`), the values the problem uses that the engine mode does not take (`["interval"]`), and the values the mode does take (`["scalar"]`) |

The value the client sent is **never** echoed back (it may be a password or a
token); FastAPI's `input` is dropped on purpose.

A diagnostic that arrives with only a code, or only a message, is completed
(`message` = code, or `code` = the problem's code); one that already has both is
passed through untouched, so the compiler keeps every field it had.

## Candidate feature values and ranges

A candidate feature value is a finite number or a range `{"min", "max"}`: both
ends are mandatory and each is a finite number or `null`; `null` means infinity at
that end. `min <= max` is only checked when both ends are finite, and a bare
`null` is not a value. The package is refused with these findings
(`invalid_instance`, 422):

| `code` | Where | Meaning |
|---|---|---|
| `schema` | `pointer` into the candidate catalog (`/spec/candidates/c1a/features/latency`) | the value is not a number or a `{min, max}` object: a missing or extra key, a string such as `"inf"`, a boolean, a bare `null` |
| `finite_number` | `pointer` to the offending end (`…/latency/max`) or to the scalar | the number is not finite (`NaN`, `±Infinity`, a literal that overflows a double) |
| `feature_interval_order` | `pointer` to the range | both ends are finite and `min` is greater than `max` |

A valid package whose ranges the selected engine mode cannot run is refused when
the job is created:

| `code` | Status | Meaning |
|---|---|---|
| `engine_mode_incompatible` | 422 | the problem uses a construct the selected mode does not declare; `diagnostics` lists every incompatibility |
| `unsupported_capability_value` | one of those diagnostics | `category` (`featureValues`) names the capability dimension, `unsupported` the values the problem uses and the mode does not take (`["interval"]` for a range, also an open one), `allowed` the values the mode takes (`["scalar"]`). For `featureValues` it also carries `resource` (the catalog file), `pointer` (the first candidate feature value with the unsupported kind, e.g. `/spec/candidates/c1a/features/latency`) and `irPath` (the same value in the BindingProblem); without a known source it carries `irPath` only |

## Why a job failed

A job that fails has `status` `failed` and a `result` with `termination` `UNKNOWN`, no solutions, a fixed `error`
sentence, a stable `code` and the `correlationId` of the log line that holds the detail. The codes:

| `code` | Meaning |
|---|---|
| `engine_unreachable` | the engine could not be reached |
| `engine_timeout` | the engine did not answer in time |
| `engine_incompatible` | the engine answered 422: the problem uses a construct or option the requested mode does not support |
| `engine_rejected` | the engine refused the request with another status |
| `engine_protocol_error` | the engine answered in a form the gateway cannot accept |
| `engine_failed` | the engine reported that it could not solve the problem |
| `engine_endpoint_invalid` | the engine endpoint is not acceptable under the network policy of the gateway |
| `engine_error` | the request to the engine failed |
| `credential_unavailable` | the credential for the engine cannot be used |
| `bim_evaluation_failed` | the answer of the engine could not be evaluated |
| `job_input_invalid` | the stored request of the job is no longer valid |
| `registration_changed` | the engine registration changed after the job was submitted |
| `lease_lost` | the worker running the job was lost |
| `job_abandoned` | the job was not finished in time and was abandoned |
| `internal_error` | anything else; the details are in the service log |

`engine_mode_incompatible` (above) is refused when the job is created, before any engine runs;
`engine_incompatible` is the engine's own refusal while the job runs.

## Where it comes from

One place decides the wire shape: `openbinding_gateway/models/problem.py` for the
document and `main.py` for the handlers.

| Source | Handler |
|---|---|
| FastAPI/Pydantic refuses the request (`RequestValidationError`) | `request_validation_error` → `validation_error`, one diagnostic per Pydantic error |
| a route raises `api_error(422, …)` / `HTTPException(422, …)` | `http_error` → the route's `code`; its `error`/`message` becomes `detail`; its `diagnostics` are normalised |
| the BIM compiler refuses a package (`CompileError`) | the route's own `invalid_instance`; any route that does not catch it is covered by `compile_error` |
| a BIM route that returns its refusal instead of raising (`_problem`, `_error_from_http`) | the same `problem_response` helper |

Routes keep raising `api_error(422, code, message)`; they need not know the shape.

### Media type

The stateless language services and the engine routes (`/v1/bim/…`, `/v1/compositions/…`,
`/v1/engines`, `/v1/engine-registrations` — the prefixes in `_PROBLEM_JSON_PREFIXES`) answer
`application/problem+json`, as the BIM routes always did. The platform routes
(accounts, organizations and their problems, runs and studies, pricing, …)
keep `application/json`. The runs moved to `/v1/organizations/{org}/runs` in F0b and
answer the platform envelope since: a refusal other than a 422 carries `code` beside
`detail: {code, error, …}`, with the extras of a limit (`quota`, `concurrency`,
`binding_space`) inside `detail`; a 422 keeps the problem document (`diagnostics`, extras
at the top level) as `application/json`. The body is identical; only the media type differs, and
the OpenAPI document declares the right one per path. Nothing was changed here
on purpose: switching the platform routes would be harmless to a JSON client but
is not needed.

## Problems

| `code` | Status | Meaning |
|---|---|---|
| `unsupported_media_type` | 415 | an upload (`POST …/problems`, `POST …/problems/{problem}/revisions`, `POST /v1/bim/validate`) whose body is not `application/vnd.bim+zip` (or `application/zip`) |
| `payload_too_large` | 413 | the package is larger than the toolchain's compressed limit or the plan's upload limit |
| `invalid_request` | 422 | the body is not a readable `.bim.zip` package |
| `invalid_instance` | 422 | the compiler refuses the package; `diagnostics` locate the refusal |
| `slug_conflict` | 409 | the problem slug is in use in the organization |
| `problem_has_runs` | 409 | `DELETE …/problems/{problem}`: a run, a study cell or a sealed study names one of its revisions, which are kept as their evidence |
| `problem_has_compositions` | 409 | `DELETE …/problems/{problem}`: a sealed composition version, or one of its evaluations, names one of its revisions. Delete the compositions that link the problem first |
| `revision_not_recompilable` | 422 | the installed toolchain refuses a stored revision (or reads it as another package); `reason` carries the refusal |
| `problem_facts_unreadable` | 422 | `getProblemCompilationFacts` or `validateBimPackage?include=facts`: the compiled problem lacks a member the facts read, or holds one this version cannot read; `reason` says which |
| `validation_error` | 422 | `validateBimPackage` with an `include` item other than `ir` and `facts` |
| `content_unavailable` | 409 | the stored package of a revision cannot be read |
| `revision_required` | 422 | `createRun` (`POST /v1/organizations/{org}/runs`) without `revision` |
| `revision_not_in_organization` | 409 | `createRun` names a revision of another organization the caller can see: launch it from that organization |
| `contract_not_installed` | 422 | a retry of a run whose compilation needs a contract the installed toolchain does not have |
| `preset_with_settings` | 422 | `createRun` names a `preset` together with `engine`, `registration`, `mode`, `options` or `optimization`: a run takes its settings from the preset or from the request, never both |
| `preset_not_found` | 422 | `createRun` names a `preset` the run's organization has no run preset by (slug or id) |
| `invalid_request_fields` | 422 | `createRun`: a field outside the run contract, or a `preset` that is not a slug or id |
| `revision_moved` | 409 | `applySphereRecipe`: another revision was added after `base` (an editor save, an upload, another apply); `latest` is its number. Preview again on it |
| `problem_exists` | 409 | `expandSphereRecipe` or `applySphereRecipe` with `base: null` on a slug the organization already uses |
| `sphere_preview_stale` | 409 | `applySphereRecipe`: the recipe now generates another package than `expect.packageDigest` (another snapshot, another base); `packageDigest` is the new one |
| `sphere_recipe_invalid` | 422 | `applySphereRecipe`: the recipe is malformed, or names a version as `latest`; `diagnostics` are the `sphere_*` findings below |
| `sphere_recipe_refused` | 422 | `applySphereRecipe`: the recipe has an error finding (an unreadable pricing, an unknown plan, an unmapped value…); `diagnostics` are the `sphere_*` findings below |

## SPHERE reads

The SPHERE routes of an organization (`…/sphere/pricings…`, `…/pricing-snapshots/…`, `…/connections/sphere`):

| `code` | Status | Meaning |
|---|---|---|
| `sphere_pricing_not_found` | 404 | a pricing or version that is missing, hidden, private without access, or not a SPHERE id: one answer for every unreadable one |
| `pricing_snapshot_not_found` | 404 | a snapshot that does not exist, or that the caller may not read under that organization |
| `sphere_registry_unknown` | 422 | a `registry` the deployment does not define in `SPHERE_REGISTRIES` |
| `sphere_pricing_invalid`, `sphere_syntax_unsupported` | 422 | a version that is not a Pricing2Yaml 3.x pricing; `diagnostics` locate why |
| `sphere_busy` | 503 | SPHERE's rate limit, or the gateway's back-off for it; `Retry-After` says when to try again |
| `sphere_unavailable` | 503 | SPHERE cannot be read right now (`reason`: `timeout`, `unavailable`, `transport`, `too_large`, `integrity`, `redirect`, `encoding`, `disabled`) |
| `sphere_key_malformed` | 422 | `PUT …/connections/sphere` with a key that is not `sk-` and 64 hexadecimal characters |
| `sphere_key_rejected` | 422 | SPHERE does not accept the key |
| `secrets_unavailable` | 503 | the deployment has no `SECRETS_FERNET_KEYS`, so a key cannot be stored |

A URL that cannot be read (an offering) never reaches the API as an error: its reason is the warning
`c2y_offering_unreadable` of the evaluation.

## SPHERE imports

`expandSphereRecipe` (`POST …/problems/{problem}/sphere/expand`) answers these findings in `diagnostics` with a
`200`; `applySphereRecipe` refuses a recipe with an **error** among them (`422 sphere_recipe_refused`). Each is
`{code, severity, message, at}`, `at` a JSON Pointer into the recipe (`/tasks/0/from/1`) or a candidate key
(`sphere-email/email.mailgun.foundation`), plus the members the code names. The compiler's own refusals of the
generated package (`missing_feature`, `feature_value_domain`, `capability_predicate`, `ineligible_task`,
`normalization_required`…) come back in the same list in a preview, and as `422 invalid_instance` in an apply.

| `code` | Severity | Meaning |
|---|---|---|
| `sphere_recipe_shape` | error | the recipe is malformed: a missing or unknown member, a value of the wrong kind, an id that is not a SPHERE id (24 lowercase hexadecimal characters), a bound passed (64 KiB, 16 tasks, 8 sources a task, 24 distinct pricing versions) |
| `sphere_source_unreadable` | error | a pricing version could not be read; `reason`: `not_found` (missing, or private without access), `unavailable`, `busy` (with `retryAfter`), `deadline` (the preview's 30 s ran out) or `registry_unknown` |
| `sphere_billing_unknown` | error | the pricing declares no such billing period (one with no `billing` block declares only `monthly`) |
| `sphere_syntax_unsupported` | error | the pricing is Pricing2Yaml 1.x or 2.x; only 3.0 and 3.1 are read |
| `sphere_pricing_invalid` | error | the pricing is not a Pricing2Yaml document this gateway reads |
| `sphere_expand_unsupported` | error | `expand: configurations` (add-on combinations); only `plans` is imported |
| `sphere_version_unpinned` | error | an apply whose recipe still says `latest` |
| `sphere_plan_unknown`, `sphere_addon_unknown` | error | the recipe names a plan or add-on the pricing does not have (or a metered add-on, which is never imported) |
| `sphere_feature_unknown`, `sphere_limit_unknown` | error | a property reads a feature or usage limit the pricing does not declare (alias it with `names`; a required limit may be assumed with `assume`) |
| `sphere_guarantee_unmapped` | error | a boolean guarantee with no value for it in the spec's `map` |
| `sphere_unlimited_unmapped` | error | an unlimited limit read into a problem feature without `unlimitedAs` |
| `sphere_property_unmapped` | error | a candidate gets no value for a target (no manual value for its provider, a hand-made candidate without it, a value that is not a number for a feature) |
| `sphere_currency_mismatch` | error | the pricing's currency is not the recipe's; no currency is converted |
| `sphere_demand_too_large` | error | a demand above `1e8`, the value that stands for unlimited |
| `sphere_too_many_candidates` | error | more than 50 candidates from one source, or a package over the package limits |
| `sphere_no_candidates` | error | no candidate is generated for a task |
| `sphere_id_collision`, `sphere_id_too_long` | error | two plans or variants slug to one id (`Pro` and `PRO`), or an id over 128 characters |
| `sphere_task_unknown`, `sphere_task_capability_conflict` | error | the base problem has no such task, or it requires another capability |
| `sphere_feature_conflict` | error | the problem already has the feature with another unit or direction, or a priced feature is not `scope: selectedCandidate` |
| `sphere_requires_conflict`, `sphere_resource_conflict` | error | a task's `requires.predicate`, or a catalog `sphere-<service>`, that no earlier SPHERE recipe of the problem wrote: the import never overwrites it |
| `sphere_property_missing_on_candidate` | error | a candidate of another catalog provides the capability but lacks a property the requirements read; add it to the recipe as a hand-made candidate |
| `sphere_limit_assumed` | warning | a required limit the pricing does not declare took the recipe's `assume` value |
| `sphere_price_not_numeric`, `sphere_price_expression` | warning | a plan or add-on without a published price, or whose price expression has no value, is left out (an **error** when the recipe names that plan) |
| `sphere_unit_unknown`, `sphere_unit_per_user` | warning | a price unit with no period is taken as monthly; a per-user price without `seats` is priced for one seat |
| `sphere_rescaled` | warning | generated values go past a feature's domain or a criterion's normalisation, which were widened |
| `sphere_objective_manual_only` | warning | every generated value of an objective's feature was set by hand |
| `sphere_content_hash_unverified` | warning | SPHERE's content hash of the version differs from the one computed here; the bytes match their ETag and are used |
| `sphere_plan_private`, `sphere_pruned`, `sphere_version_not_latest`, `sphere_candidate_removed` | info | a private plan was left out; a dominated candidate was pruned (`prune: dominated`); a newer version exists; a candidate of the base revision is no longer generated (a binding to it will not survive) |

## Run presets

The run presets of an organization (`/v1/organizations/{org}/presets`) follow the runs: a non-member gets
`404 not_found` on every route, a role below MEMBER `403 insufficient_role` on a write.

| `code` | Status | Meaning |
|---|---|---|
| `not_found` | 404 | no such organization or preset, or the caller is not a member |
| `insufficient_role` | 403 | `createRunPreset`, `updateRunPreset`, `deleteRunPreset` below MEMBER |
| `slug_conflict` | 409 | the preset slug is in use in the organization |
| `invalid_request_fields` | 422 | a setting of the wrong shape: `engine` not a name or an immutable reference, `registration` not an immutable reference, `mode` not a mode id, `options` not an object of at most 65 536 bytes as JSON, `optimization` not `{type: SINGLE\|MULTI\|MANY, scalarization, weights?: [{criteria, value}]}`; its one diagnostic's `pointer` names the setting (`/optimization/weights/0`). Whether the engine runs the problem is checked when a run uses the preset |

## Studies

A study names its engines exactly or by run preset (`{preset: <slug or id>}`). Writing a study (`createStudy`,
`updateStudy`) expands each preset once to refuse what no run could run, and stores it as given; each `runStudy`
expands it again and freezes the exact engine, mode, optimization, options and the preset's `{id, slug}`
([ADR 0052](adr/0052-study-front-export-and-presets-on-the-server.md)).

| `code` | Status | Meaning |
|---|---|---|
| `preset_not_found` | 422 | a study engine names a preset the study's organization has no run preset by (slug or id) |
| `preset_federated` | 422 | the preset runs a registered (federated) engine, which a study cell cannot run yet |
| `preset_incomplete` | 422 | the preset names no optimization, which a study engine needs |
| `invalid_engine` | 422 | an engine of the study, or the one a preset holds, no longer resolves to an engine mode with those options |
| `duplicate_study_engines` | 422 | two engines of the study are the same once its presets are expanded (revision, mode, optimization and options) |
| `api_key_engine_forbidden` | 403 | an API key does not grant every exact engine revision the study's presets expand to |

`exportStudyRun` (`GET …/studies/{study}/runs/{run}/export?format=csv|json`) refuses a `format` other than `csv` and
`json` with `422 validation_error`; a missing study or run, or a caller who may not read the study, is answered as by
the other study reads.

## Composition2Yaml

The stateless services `/v1/compositions/{validate,parse,serialise,diff}` answer
`application/problem+json`. `validateComposition` is a lint: it answers 200 `{valid, diagnostics}`
whether or not the document is valid. The others refuse a document with an error.

| `code` | Status | Meaning |
|---|---|---|
| `composition_invalid` | 422 | `parseComposition`, `serialiseComposition` or `diffCompositions` read a document with at least one error; `diagnostics` lists every finding (the `c2y_*` codes below), located; on a diff each names its `document` |
| `composition_busy` | 429 | every Composition2Yaml slot of this process is taken (`COMPOSITION_LANGUAGE_SLOTS`, 4); `Retry-After: 1`. Refused at once rather than queued |

A diff (`diffCompositions`, and `diffCompositionVersions` below) answers SPHERE's PricingDiff shape:
`general` (top-level changes, `workflow` compared whole; `version` and `evidence` are not reported), the
`binding`, `values` and `offering` `sections` with their entries, `totals` and `isEmpty`, plus
`comparison {comparable, problemRefChanged, compilationChanged, valueStatus}`. Value changes are listed only
when the two sides are `comparable`.
| `payload_too_large` | 413 | a document longer than 262 144 bytes (a JSON document to serialise: 524 288); `limitBytes` says the limit |
| `unsupported_media_type` | 415 | `validate` and `parse` read `application/yaml`, `text/yaml` or `application/x-yaml`; `serialise` and `diff` read `application/json` |
| `rate_limit_exceeded` | 429 | past the `read` budget of the client ([ACCESS_POLICY.md](ACCESS_POLICY.md)) |

The findings, in the order a document is read (size, YAML, root, sections, coherence, schema).
Every one is an error unless its severity says otherwise. The language's specification,
[COMPOSITION2YAML.md](COMPOSITION2YAML.md) §14, lists the same codes with their severity and phase,
and tests an example of most of them.

| `c2y_*` code | Meaning |
|---|---|
| `c2y_too_long` | the document, or the canonical text written from it, is longer than 262 144 UTF-8 bytes |
| `c2y_syntax` | not YAML, or YAML that JSON cannot hold: an alias, a duplicate key, a key that is not a string, a number that is not finite, an integer past ±(2^53 − 1), bytes that are not UTF-8; located where the reader stopped |
| `c2y_problem_content` | content that belongs to the BIM problem (tasks, properties, candidates, constraints, objectives) |
| `c2y_unknown_key` | a key the language does not have (`presentation:` included) |
| `c2y_missing_key` | a required key is absent; its path is the key's own, its span the parent's |
| `c2y_type` | a value of the wrong JSON type |
| `c2y_syntax_version_type` | `syntaxVersion` is not a quoted `<major>.<minor>` string (unquoted, YAML reads `1.0` as a number) |
| `c2y_syntax_version_unsupported` | `syntaxVersion` names a version this gateway does not read (supported: `1.0`) |
| `c2y_slug_invalid` | `composition` is not a slug |
| `c2y_version_not_semver` | `version` is not a Semantic Versioning label |
| `c2y_kind_unknown` | `kind` is not `application`, `workflow`, `pipeline` or `system` |
| `c2y_problem_ref` | `problem.ref` or `problem.compilation` is malformed |
| `c2y_workflow_malformed` | a workflow node that is not a task, `null` or one well-formed `seq`/`and`/`xor`/`loop` |
| `c2y_task_id_invalid`, `c2y_property_id_invalid` | an id the container would not accept |
| `c2y_candidate_ref_invalid` | a candidate that is neither an id nor `<resource>/<id>` |
| `c2y_task_unbound` | a workflow task with no `binding` entry |
| `c2y_binding_unknown_task` | a `binding` entry for a task the workflow does not have |
| `c2y_binding_entry` | an entry that is not exactly one of `candidate` or `local: true`, or a `from` beside `local: true` |
| `c2y_xor_probabilities` | an `xor` with some probabilities stated and some not, or `uniform: true` beside probabilities |
| `c2y_xor_sum` | the stated probabilities of an `xor` do not add up to exactly 1 (decimal arithmetic) |
| `c2y_from_version_missing` | a `from` without the SPHERE version it pins |
| `c2y_from_incomplete` | a `from` without its `sphere` or `plan` |
| `c2y_from_shape` | a malformed `from` field, or an add-on listed twice |
| `c2y_from_registry_unknown` | a `from` on a registry `SPHERE_REGISTRIES` does not define |
| `c2y_offering_sources` | an `offering` with no source or with more than one |
| `c2y_offering_shape` | a malformed `offering`: a key, type or value it may not have (its plans and its version live outside the document) |
| `c2y_offering_url_not_https` | an offering URL that is not an absolute `https://` URL |
| `c2y_offering_registry_unknown` | **warning**: an offering on a registry `SPHERE_REGISTRIES` does not define; the composition stays valid |
| `c2y_value_shape` | a value that is a boolean, or an empty unit |
| `c2y_evidence_shape` | evidence that does not hold together (a run and `manual`, a point without a run, a run that is not a UUID, an unknown `evaluatedBy`) |
| `c2y_evidence_gateway_without_problem`, `c2y_evidence_run_without_problem` | gateway evidence or a run on a composition linked to no problem |
| `c2y_slug_mismatch` | **info**: the document's slug is not the slug of the composition it is submitted to |
| `c2y_schema` | the JSON Schema backstop refused something no specific rule names |
| `c2y_more` | **info**: more findings than a list holds (100); fix these first |

Against a compiled problem, and when assessing a document in an organization (the organization's routes):

| `c2y_*` code | Meaning |
|---|---|
| `c2y_workflow_mismatch` | the workflow is not the problem's |
| `c2y_candidate_unknown` | no catalog of the problem holds the candidate |
| `c2y_candidate_ambiguous` | two catalogs give the task the same id: write `<resource>/<id>` |
| `c2y_candidate_not_allowed`, `c2y_task_local_mismatch` | the task may not take the candidate; `local: true` on a service task or a candidate on a local one. Reported only when the toolchain refuses the binding, to locate its refusal |
| `c2y_property_unknown` | a value of a property the problem does not have |
| `c2y_unit_missing`, `c2y_unit_mismatch` | a bare number where the problem has a unit; a unit that is not the problem's |
| `c2y_value_differs` | **warning**: a declared value is not the one the toolchain computes; the computed one is kept |
| `c2y_value_not_computed` | **warning**: a declared value of a property the toolchain does not compute; dropped |
| `c2y_constraint_violated` | the binding violates a hard constraint |
| `c2y_constraint_soft` | **warning**: the binding misses a soft constraint, with its penalty |
| `c2y_provenance_mismatch` | a `from` disagrees with the provenance a SPHERE-generated problem recorded for its candidate (owner/name, registry, version, plan, add-ons); located at the first field that differs |
| `c2y_provenance_missing` | **warning**: an entry without `from` on a candidate a SPHERE import generated; the version pins no upstream version of its own |
| `c2y_problem_foreign` | `problem.ref` names a problem of another organization; it is not looked up there |
| `c2y_problem_not_found` | the organization has no such problem or revision (or it was deleted while the version was being sealed) |
| `c2y_problem_not_recompilable` | the installed toolchain refuses the linked revision's stored package |
| `c2y_compilation_not_found` | the revision has no compilation with the digest `problem.compilation` names |
| `c2y_compilation_superseded` | **info**: the named compilation was made by another toolchain release that reads the problem alike; the binding is evaluated on the installed one's |
| `c2y_compilation_semantics_changed` | the installed toolchain reads the revision differently from the named compilation: derive the composition again |
| `c2y_binding_invalid` | the toolchain refuses the binding; its message as given, beside the located `c2y_candidate_not_allowed` / `c2y_task_local_mismatch` |
| `c2y_evaluation_failed` | the toolchain could not evaluate the binding |
| `c2y_run_not_found` | the organization has no run `evidence.run` names (or the caller may not see it) |
| `c2y_run_foreign_revision` | the run solved another revision, or a compilation that reads it differently |
| `c2y_run_point_invalid` | the run has no binding to cite, or `evidence.point` is not one of its solutions (`deriveComposition`: the request's `point`) |
| `c2y_run_binding_mismatch` | the binding is not the run's solution (`point`) or none of them; the message lists the tasks that differ |

An evaluation created on a seal, a derivation that seals, a fork or a re-evaluation records the offering version it
read (`EvaluationView.offering`); reading it can give `c2y_offering_unreadable` (**warning**: the offering cannot be
read, the reason in words; no margins) and `c2y_offering_invalid_pricing` (**warning**: its content is not a valid
Pricing2Yaml 3.x pricing; no margins). Neither invalidates the binding or blocks a seal.

## Compositions

The compositions of an organization (`/v1/organizations/{org}/compositions`). A composition the caller
cannot read answers as a missing one: `404 not_found` for a non-member and for another organization's
composition, never `403`. A public composition is read by anybody through the five read routes; to a caller
who is not a member, a missing organization, a missing composition and a private one give the same body. A
credential that names nobody is `401 unauthorized` there too. A member whose role is too weak for a write gets
`403 organization_forbidden`.

| `code` | Status | Meaning |
|---|---|---|
| `not_found` | 404 | no such organization or composition, or the caller cannot read it; `deriveComposition`: no such run or problem revision in the organization (or the caller may not see the run) |
| `organization_forbidden` | 403 | the caller reads the organization but its role is too weak: MEMBER creates and edits, ADMIN deletes. `updateComposition` that changes `visibility` needs ADMIN: "Changing visibility requires ADMIN access to the organization." |
| `unauthorized` | 401 | a read of a composition with a credential that names nobody (an expired or malformed token, a revoked key): refresh it, or send none to read as a visitor |
| `rate_limit_exceeded` | 429 | a visitor (no credential) past the anonymous `read` budget on the reads of a public composition; `Retry-After` says when the window ends |
| `feature_not_entitled` | 403 | `createComposition`, `forkComposition`: the caller's plan lacks the `repository` feature |
| `slug_conflict` | 409 | the composition slug is in use in the organization (`forkComposition`: the `slug` given is in use in the target; without one, a taken slug answers 200 `{nameTaken: true, existingComposition}` and nothing is forked) |
| `invalid_request` | 422 | `listCompositionVersions`: `created_after` is later than `created_before` |
| `validation_error` | 422 | an `include` item the route does not have: `getCompositionVersion` takes `document`, `listCompositionVersions` `analytics` and `evaluations` |
| `diff_version_missing` | 422 | `diffCompositionVersions` needs a default the composition cannot give: it has no version yet, or none before `to`. Name `from` |
| `composition_fork_same_organization` | 409 | `forkComposition` into the source's own organization: a fork goes to another organization; seal a new version instead |
| `composition_fork_problem_unreadable` | 409 | `forkComposition` of a version that links a problem, which the target organization cannot read. Set `dropProblem` to fork it without `problem` and `evidence`, its values declared |
| `api_key_boundary` | 403 | `forkComposition`: the API key's boundary does not reach the target organization or slug |
| `composition_invalid` | 422 | `createCompositionVersion` read or judged a document with at least one error; `diagnostics` lists every finding (the `c2y_*` codes above), located in the submitted text. `checkCompositionVersion` answers the same findings with 200. `forkComposition`: the forked copy was refused as a new seal would be (for example `c2y_from_registry_unknown` once a registry left `SPHERE_REGISTRIES`) |
| `version_label_taken` | 409 | `createCompositionVersion`, `deriveComposition`: another content of the composition holds this `version:`; `version` names it (`id`, `ordinal`, `label`) |
| `composition_busy` | 429 | `createCompositionVersion`, `checkCompositionVersion`, `forkComposition`, `diffCompositionVersions`, `getCompositionVersion` with `include=document`, `reevaluateCompositionVersion`, `evaluateComposition`, `getCompositionNeighborhood`, `deriveComposition`: every Composition2Yaml or evaluation slot of this process is taken (`COMPOSITION_EVALUATION_SLOTS`, 2); `Retry-After: 1` |
| `composition_empty` | 409 | `evaluateComposition`, `getCompositionNeighborhood` without `version`: the composition has no version yet |
| `composition_not_linked` | 422 | `evaluateComposition`, `getCompositionNeighborhood`: the version links no problem, so its values are declared and the toolchain has nothing to evaluate. `reevaluateCompositionVersion` of such a version answers its declared evaluation |
| `evaluation_invalid` | 422 | `evaluateComposition`: the toolchain could not evaluate the binding (an unknown candidate, its refusal, a problem it reads differently); `diagnostics` lists the `c2y_*` findings, and one about a task the request rebinds points at `/binding/<task>`. A binding it evaluated answers 200, `valid` false on a hard violation. `reevaluateCompositionVersion`: the installed toolchain could not evaluate the version (its package no longer compiles, the evaluation failed); nothing is stored |
| `revision_not_found` | 404 | `evaluateComposition` with a `revision` the linked problem does not have (a demand variant is another revision of it) |
| `evaluation_not_found` | 404 | `getCompositionVersionMargins` with an `evaluation` that is not one of the version's |
| `unknown_billing` | 422 | `getCompositionVersionMargins`: the offering has no billing period by that id |
| `unknown_cost` | 422 | `getCompositionVersionMargins`: the version has no global value by that name, or it is not an amount per period (`CUR/month`, `/year`, `/week`) |
| `analysis_invalid` | 422 | `getCompositionNeighborhood`: the toolchain cannot analyse the version's binding or the task named |
| `c2y_compilation_semantics_changed` | 422 | `getCompositionNeighborhood`: the installed toolchain reads the linked revision differently from the compilation the version names; derive the composition again |
| `derivation_invalid` | 422 | `deriveComposition`: the binding cannot be derived; `diagnostics` lists the `c2y_*` findings. Those about the request point into it: `/point` (`c2y_run_point_invalid`: a run that did not complete, a point out of range, a solution that is not a binding), `/binding/<task>` (an unknown task or candidate, a task left unbound, the toolchain's refusal) and `/offering/...` (an offering that is not one). The others point into the derived document: `c2y_constraint_violated` (a binding with a hard violation is not derivable), `c2y_compilation_semantics_changed` (the run solved a compilation the installed toolchain reads differently: run the problem again) |
| `payload_too_large` | 413 | a document longer than 262 144 bytes; `limitBytes` says the limit |
| `unsupported_media_type` | 415 | a document not sent as `application/yaml`, `text/yaml` or `application/x-yaml` |
| `rate_limit_exceeded` | 429 | past the `evaluate` budget of the caller ([ACCESS_POLICY.md](ACCESS_POLICY.md)) |
| `bim_unavailable` | 503 | the toolchain does not answer |

## Composition environments and the feed

The environments of a composition (`…/compositions/{composition}/environments`), their adoptions, feed keys and feed
([ADR 0054](adr/0054-composition-environments-and-the-feed.md)). Every route needs a credential (401 before any
lookup); a caller without a role gets the composition's 404 parity: `Composition not found.` for a private or
missing composition, `Environment not found.` for every environment route of a public one (the body a member gets
for a missing environment).

| `code` | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | no credential, or one that names nobody (an expired token, a revoked key or feed key, an inactive member) |
| `environment_key_elsewhere` | 401 | an environment feed key (`obe_…`) sent to any route but its environment's feed: it opens nothing else. The stateless language and BIM routes answer it as they answer no credential |
| `not_found` | 404 | no such composition, environment, version or feed key, or the caller cannot read them (the parity above); a feed key sent to another environment's feed |
| `nothing_adopted` | 404 | `getEnvironmentFeed`: nothing is adopted in the environment yet |
| `organization_forbidden` | 403 | a member whose role is too weak: VIEWER reads, ADMIN creates, edits, deletes and manages feed keys, MEMBER checks, and adopting needs the environment's `adoptRole` |
| `insufficient_api_key_permission` | 403 | a personal key without the route's permission: `compositions:adopt` to adopt (write does not imply it), `compositions:write` and `keys:write` for feed keys, `compositions:read` for the feed |
| `api_key_boundary` | 403 | a personal key whose boundary excludes the composition, organization, method or kind (the feed too, even with a matching `If-None-Match`) |
| `precondition_required` | 428 | `adoptCompositionVersion` without `If-Match`, or with `*`: adopting needs the environment's `ETag`. Nothing was applied |
| `precondition_failed` | 412 | a stale `If-Match` on an environment edit, delete or adopt; the current `ETag` is in the header |
| `already_in_effect` | 409 | `adoptCompositionVersion`: that version is already in effect in the environment |
| `composition_archived` | 409 | `adoptCompositionVersion` in an archived composition: restore it first (its feeds keep serving) |
| `evaluation_stale` | 409 | `adoptCompositionVersion` of a linked version with no evaluation by the installed toolchain: re-evaluate it first |
| `binding_invalid` | 409 | `adoptCompositionVersion` of a version whose binding the installed toolchain finds invalid; `diagnostics` says why |
| `evaluation_semantics_changed` | 409 | `adoptCompositionVersion`: the installed toolchain reads the version's problem differently; derive it again and adopt the new version |
| `composition_in_operation` | 409 | `deleteComposition` of a composition that has environments; `environments` names them. Delete them first |
| `environment_limit` | 409 | `createCompositionEnvironment` past `COMPOSITION_ENVIRONMENTS_MAX` environments (5 by default; `limit` says it) |
| `slug_conflict` | 409 | `createCompositionEnvironment` with a slug in use in the composition |
| `feed_key_limit` | 409 | `createEnvironmentFeedKey` with two live keys already: revoke one first |
| `operator_not_member` | 422 | the operator named is not a member of the organization |
| `feed_rate_limited` | 429 | `getEnvironmentFeed` read more than `FEED_RATE_PER_MINUTE` times (60) in a minute with one credential; `Retry-After` says when |

## Organizations

| `code` | Status | Meaning |
|---|---|---|
| `slug_reserved` | 422 | `createOrganization` with a slug that names an address of the application (`new` and `join`, the static children of `/orgs/`, and `public`) |
| `slug_conflict` | 409 | the organization slug is in use |
| `historical_references` | 409 | `deleteOrganization`: the organization, or one below it, has runs or study runs, which are kept as history |

## Accounts and plans

| `code` | Status | Meaning |
|---|---|---|
| `quota_exceeded` | 402 | a per-account limit of the plan would be passed: `maxApiKeys`, `maxFederatedEngines`, `maxProblems`, `maxRepositoryStorage`. `quota` names `limit_id`, `limit` and `used` |
| `username_unavailable` | 409 | registration or a first CAS sign-in asked for a reserved username: one that names engines or engine registrations already (engine namespaces are usernames baked into immutable manifests, and they outlive a deleted account), or one starting with `deleted-`, the pseudonyms of deleted accounts |
| `last_owner` | 409 | `DELETE /v1/users/me`: the account owns an organization; it hands it over first |
| `owner_transfer_required` | 409 | a member route named the owner of the organization: the owner's seat moves only by `PUT /v1/organizations/{org}/owner` |

Quotas are per account: there are no billing sponsors. Deleting an account pseudonymises it
([ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md)).

## Sign-in

`/v1/auth/*` answers carry `Cache-Control: no-store`. See [IDENTITY.md](IDENTITY.md).

| `code` | Status | Meaning |
|---|---|---|
| `identity_disabled` | 409 | a SCORETech Identity route was called on a gateway that signs people in locally (`AUTH_PROVIDER=local`) |
| `local_auth_disabled` | 409 | a local credential route (register, login, password reset) was called on a gateway that signs people in with SCORETech Identity (`AUTH_PROVIDER=scoretech`) |
| `origin_refused` | 403 | a sign-in route that reads the session cookie was called without an `Origin` from the frontend (`FRONTEND_URL`'s origin or `AUTH_TRUSTED_ORIGINS`) |

## Conditional writes (`If-Match`)

These operations take an optional `If-Match` header:

- `PATCH /v1/organizations/{org}`
- `PATCH …/problems/{problem}`
- `PATCH …/studies/{study}`
- `PATCH …/compositions/{composition}`
- `PATCH …/presets/{preset}`
- `PATCH` and `DELETE …/environments/{environment}`
- `PATCH /v1/users/me`
- `PUT /v1/notifications/preferences`
- `PUT /v1/engine-registrations/{name}/credential`
- `POST /v1/admin/users/{user_id}/plan`
- `POST /v1/admin/users/{user_id}/subscription`

The first nine are the covered-operations table of change `optimistic-concurrency`, with `updateComposition` and `updateRunPreset` added in F1. Their `200`, and the
single-resource `GET` of the same resource, carry an `ETag`. The tag is a strong, opaque entity tag, so send it back
unchanged and never parse it. Without `If-Match` nothing is checked and the request behaves as it always did, with
the last writer winning.

The last two change an account's SPACE contract: their tag is the subscription's, as
`GET /v1/admin/users/{user_id}/subscription` returns it (none when SPACE keeps no contract versions; then only `*`
matches). The gateway also applies their novation only to the contract version it has just read, so a contract that
moves while the request is being applied is refused too: `412 precondition_failed` when `If-Match` named a
revision, `409 contract_changed` otherwise. Nothing was written either way
([ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md)).

| `code` | Status | Meaning |
|---|---|---|
| `precondition_failed` | 412 | `If-Match` did not match the resource's current `ETag`: somebody changed it since you read it, or (for `*` or a tag) it has no current state yet, such as an engine credential never set. The response carries the **current** `ETag` header (none when the resource has no current state). **Nothing in the request was applied**: no field, no audit event, no side effect (no registration reset). Re-read the resource, merge, and retry with the new tag |
| `precondition_required` | 428 | `POST …/environments/{environment}/adopt` only: there `If-Match` is required and must name an entity-tag (absent or `*` is refused); nothing was applied |
| `invalid_if_match` | 400 | `If-Match` is present but is neither `*` nor a comma-separated list of quoted entity tags (`"abc"`, `W/"abc"`), or it is longer than 2048 characters. Examples: an unquoted value, `*` mixed with tags, a missing comma, an empty value. Nothing was applied. Of repeated `If-Match` header fields only the first is read |

Weak tags (`W/"…"`) are well-formed but never match, because `If-Match` uses strong comparison (RFC 9110 §13.1.1).
`*` matches whenever the resource exists. Authentication (`401`), not-found (`404`) and permission (`403`) refusals
(for an organization update, also the authorisation on a new parent)
come first, so a caller who may not read the resource never sees its `ETag`. `412` comes before the refusals that
depend on stored state or on the stored tree (`402`, `409` and `422` such as
`ambiguous_parent` or `already_registered`). A request
body the framework refuses is still `422 validation_error`.

Both codes keep the shape of their route family (below): platform routes answer
`{"detail": {"code", "error"}, "type", "title", "status", "code"}`, and
`/v1/engine-registrations/…` answers `Problem` as `application/problem+json`. The tag appears only in the `ETag`
header, never in the body.

## Reading them in the browser

The frontend reads every refusal through one function, `readApiError` (`frontend/src/modules/core/api/errors.ts`): the
problem document of a 422 and of the language and BIM routes, and the platform shape `{"detail": {"code", "error"}}`
elsewhere, with the `code`, the message, the located `diagnostics` (`fromC2y` places a `c2y_*` finding's span in the
text), the current `ETag` of a `412` and the `Retry-After` of a `429`. The derive and fork dialogs word a refusal
from its `code` and add `(status · code)`; a composition that is not found, private or missing, is one state ("No
composition here, or you cannot see it"), never "private".

## The other statuses

`400`, `401`, `402`, `403`, `404`, `409`, `429`, `503`, … keep the shape they
had; nothing was removed.

* **Platform routes** (everything outside the BIM prefixes) answer
  `{"detail": {"code", "error", …extra}}`. Every coded failure now also carries
  the canonical keys beside it: `type`, `title`, `status`, `code` (the same
  value as `detail.code`). `detail` stays an **object** here — turning it into a
  string would break every client that reads `detail.code` — so this is the one
  deliberate difference from `Problem`: read `code`/`status` at the top level
  everywhere; read `detail` as a string only on 422 and on BIM routes.
  Failures with a plain-string `detail` (`{"detail": "Not Found"}`) are unchanged.
* **BIM routes** answer `Problem` (`type`, `title`, `status`, `code`, `detail`,
  optional `diagnostics`, plus route-specific fields such as `quota`).

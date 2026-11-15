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
| `revision_not_recompilable` | 422 | the installed toolchain refuses a stored revision (or reads it as another package); `reason` carries the refusal |
| `content_unavailable` | 409 | the stored package of a revision cannot be read |
| `revision_required` | 422 | `createRun` (`POST /v1/organizations/{org}/runs`) without `revision` |
| `revision_not_in_organization` | 409 | `createRun` names a revision of another organization the caller can see: launch it from that organization |
| `contract_not_installed` | 422 | a retry of a run whose compilation needs a contract the installed toolchain does not have |

## Composition2Yaml

The stateless services `/v1/compositions/{validate,parse,serialise,diff}` answer
`application/problem+json`. `validateComposition` is a lint: it answers 200 `{valid, diagnostics}`
whether or not the document is valid. The others refuse a document with an error.

| `code` | Status | Meaning |
|---|---|---|
| `composition_invalid` | 422 | `parseComposition`, `serialiseComposition` or `diffCompositions` read a document with at least one error; `diagnostics` lists every finding (the `c2y_*` codes below), located; on a diff each names its `document` |
| `composition_busy` | 429 | every Composition2Yaml slot of this process is taken (`COMPOSITION_LANGUAGE_SLOTS`, 4); `Retry-After: 1`. Refused at once rather than queued |
| `payload_too_large` | 413 | a document longer than 262 144 bytes (a JSON document to serialise: 524 288); `limitBytes` says the limit |
| `unsupported_media_type` | 415 | `validate` and `parse` read `application/yaml`, `text/yaml` or `application/x-yaml`; `serialise` and `diff` read `application/json` |
| `rate_limit_exceeded` | 429 | past the `read` budget of the client ([ACCESS_POLICY.md](ACCESS_POLICY.md)) |

The findings, in the order a document is read (size, YAML, root, sections, coherence, schema).
Every one is an error unless its severity says otherwise.

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

Against a compiled problem (the organization's routes, from F1 B8):

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

## Compositions

The compositions of an organization (`/v1/organizations/{org}/compositions`). A composition the caller
cannot read answers as a missing one: `404 not_found` for a non-member and for another organization's
composition, never `403`. A member whose role is too weak for a write gets `403 organization_forbidden`.

| `code` | Status | Meaning |
|---|---|---|
| `not_found` | 404 | no such organization or composition, or the caller cannot read it |
| `organization_forbidden` | 403 | the caller reads the organization but its role is too weak: MEMBER creates and edits, ADMIN deletes |
| `feature_not_entitled` | 403 | `createComposition`: the caller's plan lacks the `repository` feature |
| `slug_conflict` | 409 | the composition slug is in use in the organization |

## Organizations

| `code` | Status | Meaning |
|---|---|---|
| `slug_reserved` | 422 | `createOrganization` with a slug that names a page of the application (`admin`, `account`, `engines`, `organizations`, `invitations`, `runs`, `problems`, `studies`, `settings`, `workbench`, `new`) |
| `slug_conflict` | 409 | the organization slug is in use |
| `historical_references` | 409 | `deleteOrganization`: the organization, or one below it, has runs or study runs, which are kept as history |

## Accounts and plans

| `code` | Status | Meaning |
|---|---|---|
| `quota_exceeded` | 402 | a per-account limit of the plan would be passed: `maxApiKeys`, `maxFederatedEngines`, `maxProblems`, `maxRepositoryStorage`. `quota` names `limit_id`, `limit` and `used` |
| `username_unavailable` | 409 | registration or a first CAS sign-in asked for a reserved username: one that names engines or engine registrations already (engine namespaces are usernames baked into immutable manifests, and they outlive a deleted account), or one starting with `deleted-`, the pseudonyms of deleted accounts |
| `last_owner` | 409 | `DELETE /v1/users/me`: the account is the last OWNER of an organization |

Quotas are per account: there are no billing sponsors. Deleting an account pseudonymises it
([ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md)).

## Conditional writes (`If-Match`)

These operations take an optional `If-Match` header:

- `PATCH /v1/organizations/{org}`
- `PATCH …/problems/{problem}`
- `PATCH …/studies/{study}`
- `PATCH …/compositions/{composition}`
- `PATCH /v1/users/me`
- `PUT /v1/notifications/preferences`
- `PUT /v1/engine-registrations/{name}/credential`
- `POST /v1/admin/users/{user_id}/plan`
- `POST /v1/admin/users/{user_id}/subscription`

The first eight are the covered-operations table of change `optimistic-concurrency`, with `updateComposition` added in F1. Their `200`, and the
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

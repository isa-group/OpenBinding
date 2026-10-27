# OpenBinding gateway: architecture as it is (912648c)

This describes `openbinding-gateway/src/openbinding_gateway/` as it is, not as
it is meant to become. Claims cite the file that supports them. Where the code
does not match the intended layering, that is stated under
[Known debt](#known-debt-pending-work).

## Layers

```
routes/  ──►  services/  ──►  repositories/ , integrations  ──►  db/
  │              │                    │
  └──────────────┴──► domain/ , models/ (DTO) , core/   (no dependency upwards)
                       jobs/  (job lifecycle; must not import routes)
```

| Package | Role | Evidence |
|---|---|---|
| `routes/` | HTTP: FastAPI routers, request parsing, authentication dependencies, translation of results and refusals to responses. `main.py` is the composition root: `create_app()` includes every router (`app.include_router(...)`) and the lifespan installs the pricing gate and the job reconciler, see [Composition layer](#composition-layer-create_app) | `main.py` |
| `services/` | Use cases that are not HTTP: `execution.py` (run a persisted job), `engines.py` (Engine selection and compatibility), `snapshots.py` (compile and persist a snapshot, who may see it), `instances.py` (upload, validate, snapshot and read back a package, see [Instances and snapshots](#instances-and-snapshots)), `discovery.py` (the read-only catalog documents, see [Discovery](#discovery)), `job_submission.py` (validate, reserve and persist a job, see [Job submission](#job-submission)), `engine_registry.py` (the Engine registry, see [Engine registry](#engine-registry)), `entitlements.py` (the only reader of an account's plan, see [Entitlements](#entitlements)) | `services/*.py` |
| `repositories/` | Database queries: `jobs.py` (`get_owned`, `list_owned`, `find_retry_of`, `list_for_project`) and `organizations.py`, see [Repositories](#repositories) | `repositories/*.py` |
| Integrations | `space_client/` (the pricing gate over the SPACE client, plus a fake for tests), `sphere_client.py` (read-only pricing source), `cas.py`, `mailer.py`, `job_dispatch.py` (Dramatiq/Redis) | respective files |
| `db/` | SQLAlchemy ORM models and session handling (`models.py`, `platform_models.py`, `artifact_models.py`, `base.py`) | `db/` |
| `domain/` | Rules without I/O: `entitlements.py` (transport-neutral `Refusal`, e.g. `concurrency_refusal`), `idempotency.py` (request fingerprint) | `domain/*.py` |
| `models/` | Pydantic request/response schemas (DTO), see below | `models/*.py` |
| `core/` | `settings.py` (every environment variable in one place) and `logging.py` | `core/` |
| `access/`, `security/` | Plan policy (`access/policy.py`: clamping, ceilings and quota rules, applied through `services/entitlements.py`), contract bookkeeping (`access/contracts.py`), public-read matrix; hashing of passwords, tokens and API keys | respective files |
| `jobs/` | The job lifecycle: `leases.py`, `reconciler.py`, `limits.py`, `lifecycle.py` ([IDEMPOTENCY.md](../IDEMPOTENCY.md)) | `jobs/*.py` |
| `integrations/bim.py`, `v1/`, `generator/` | The BIM port (`BimPort`, settings, error translation), the remaining `v1/` platform code (archive, remote Engine transport) and the instance generator (see [the BIM boundary](#the-bim--platform-boundary)) | `integrations/`, `v1/`, `generator/` |

Not every module follows the layer table yet: several top-level modules
(`artifacts.py`, `reports.py`, `studies.py`, `study_jobs.py`,
`collaboration.py`, `telemetry.py`)
mix use-case logic and persistence outside `services/` and `repositories/`.
(`analysis_jobs.py` and `sponsor_proposals.py` were in this list when this page
was written; M9.6 removed both, and the sections below that name them describe
the gateway before that.)

## Composition layer (`create_app`)

`openbinding_gateway.main.create_app(settings=None)` builds routers, middleware,
handlers and lifespan with no shared state. `app = create_app()` stays at the end
of `main.py` for `uvicorn openbinding_gateway.main:app`. No engine, session, Redis
connection or task is created at import or by `create_app`; they start in the
lifespan.

Import effects that remain:

- `main.py` (module bottom): `load_environment_file()` reads `OPENBINDING_ENV_FILE`
  or `./.env` into `os.environ` on import.
- `main.py` (module bottom): `settings = get_settings()` caches the process
  settings on import; `tests/test_b2_cors.py` reads `main.settings`.
- `main.py` (`create_app`, only when called without settings):
  `configure_logging()` replaces the root and uvicorn log handlers, so
  `app = create_app()` does this on import.
- `job_dispatch.py:120`: `_TIME_LIMIT_MS` calls `get_settings()` on import;
  `main.py` imports it through the routes, before `load_environment_file()` runs,
  so it sees `.env` values only if they are already in the process environment.
- `security/bodylimit.py:108`: `BodyLimitMiddleware` calls `get_settings()` per
  request, so an explicit `Settings` given to `create_app` does not set the body
  limits.
- `main.py` (`readiness`): the dependency uses `Depends(get_settings)`, so an
  explicit `Settings` does not reach `/health/ready`.

## Repositories

`openbinding_gateway/repositories/` holds async functions that take the session,
return ORM entities, import no FastAPI, never commit, and never decide who may do
what.

- `repositories/jobs.py`: job lookups and listings by owner, project and retry
  origin; the owner filter is part of every query, and a missing row is reported
  by the caller.
- `repositories/organizations.py`: organization listing, direct memberships (one,
  listed, locked, owner count), project listing and slug check per organization,
  invitation lookup by token prefix, and audit events per organization; every
  query is filtered by the organization id it is given.

Queries that were left where they are, and why:

- `collaboration.py`: organization/project resolution by slug or id, effective role
  over the ancestor chain, `require_role`/`require_project`, sponsor usage and
  capacity. They are tied to the authorization rules (role strength, public read,
  401/403/404 choice), so they stay with the rules instead of moving into the data
  layer.
- `access/public_read.py`: `admit_public_project`, because the public-read grant,
  rate limit and visibility decision are an access policy, not a lookup.
- `routes/organizations.py`: the cascade delete of a project or organization,
  binding cases and revisions, project resources (artifact joins and visitor
  filtering), user and sponsor lookups through `session.get`, sponsor-wide
  membership counts for quotas, and `select ... for update` on the sponsor row.
  They are single-use or tied to a handler's transaction and rule, and moving them
  would only relocate code without removing duplication.

## Entitlements

`services/entitlements.py` is the **only** module that reads an account's plan
(`get_gate().caps(user_id)`). `EntitlementService` is stateless (the gate is
looked up on every call, so the one installed by the lifespan or by a test is
the one consulted) and is usable from routes, `jobs/` and plain modules:

| Intent | Method | Rule it delegates to |
|---|---|---|
| read the plan | `caps_for(user_id)` raises the domain exception `EntitlementsUnavailable` (a `PricingUnavailable`, so retrying callers keep working); `caps_or_503(user_id, prefix="")` raises the stable `503 pricing_unavailable` | `space_client` gate |
| a feature the plan must have | `require_feature(caps, feature, detail=...)` (403 `feature_not_entitled`), `feature_refusal(...)` for callers that combine refusals | `domain/entitlements.py` |
| ceilings and clamps | `payload_ceiling`, `solve_timeout`, `clamp_options`, `complexity_too_large` | `access/policy.py` |
| per-request upload limit | `upload_limit(user_id)` | plan `maxPayloadBytes`, capped at 512 MiB |
| sponsor and storage quotas | `enforce_sponsor_usage(sponsor_id, usage)` (402 `sponsor_quota_exceeded`), `enforce_storage_quota(sponsor_id, incoming, stored_bytes)` (402 `storage_quota_exceeded`) | `access/policy.py` (`sponsor_quota_breach`, `storage_quota_breach`) |

Routes that want it take it as a dependency (`Depends(get_entitlements)`,
`routes/jobs.py` `retry_job`, `routes/studies.py` `run_study`); the others use the
shared `entitlement_service`. The order of the checks around each read was kept:
the gateway validates the optimization before reading the plan, and a study cell
launch that finds pricing unavailable stays retryable
(`study_jobs.RETRYABLE_LAUNCH_CODES`), so `POST .../runs` still answers `202` when
only the cell launch fails (`run_study` itself still answers `503` if the plan is
unreadable before the run is created).

**Inventory of plan reads** (`grep -n '\.caps(\|get_gate' src/`), before the
service existed: `routes/jobs.py:107`, `routes/artifacts.py:173` and `:199`,
`routes/v1.py:2222` and `:2543` (the second one is now in
`services/job_submission.py`), `routes/users.py:63`, `routes/studies.py:637`,
`collaboration.py:282`. `study_jobs.py`, `studies.py`, `analysis_jobs.py` and
`sponsor_proposals.py` (the last two removed by M9.6) never read the gate; they reach it through
`collaboration.enforce_sponsor_usage` and the job-creation path. Now the only
`.caps(` call is `services/entitlements.py:63`.

`get_gate` is still used for the **contract lifecycle**, which is not a plan
decision: `routes/admin.py:84` (import; calls at `:226`, `:281`, `:341`, `:390`,
`:469`), `routes/auth.py:191`, `routes/cas.py:160`, `:306`, `:397`, `:418`,
`routes/users.py:56` (import; calls at `:571` and `:782`),
`access/contracts.py:57`, `job_dispatch.py:45` and `:61` (worker gate lifetime),
`main.py:155` (lifespan). `space_client/` is the gate itself.

`tests/test_architecture_layers.py` enforces it: no module but
`services/entitlements.py` calls `.caps(...)`, and the modules allowed to reach
`get_gate` are the frozen list `GATE_LIFECYCLE_LEGACY` (plus the composition root
and `space_client/`); the list can only shrink
(`test_only_the_entitlement_service_reads_plan_capabilities`,
`test_no_new_module_reaches_for_the_gate`,
`test_gate_lifecycle_legacy_has_no_stale_entries`).

## Job submission

`POST /v1/jobs` is a thin controller over `services/job_submission.py`:

1. `routes/v1.py` (`create_job`, `_create_job_core`, `_read_job_request`)
   authenticates the caller, applies the transport rules (reserved and malformed
   `Idempotency-Key`, content type, body and package size limits, multipart,
   JSON parsing, the field set of the job contract) and builds a
   `JobSubmissionInput`;
2. `JobSubmission(session, caller, commit=..., study_cell_id=...).submit(input)`
   resolves the source (snapshot, configuration or upload), computes the
   request fingerprint and rules out a replay, selects the Engine and mode,
   reads the plan through `entitlement_service` and clamps the options, resolves
   the EngineRegistration, builds the provenance, takes the account lock, checks
   the concurrency limit and persists the snapshot and the `Job`, and returns a
   `JobSubmissionResult` (`kind` is `created`, `replay` or `problem`, with
   `status`, `body` and `headers`);
3. the route dispatches a `created` job (after the commit, if it was asked to),
   and turns the result into the response: the document for a new job, plain JSON
   for a replay and `application/problem+json` for a problem.

The service does not import `routes` or build FastAPI responses; of FastAPI it
only uses `HTTPException`, to translate those the Engine, snapshot and
configuration helpers raise. It holds no mutable module state. Dispatching stays in
`routes/v1.py` on purpose: `dispatch_persisted_job` is replaced or called
through `routes.v1` by many tests and by `study_jobs`. `pending_launches`,
`discard_pending_launches` and `STUDY_CELL_KEY_PREFIX` live in the service and
are re-exported by `routes/v1.py` for `study_jobs.py`. The route also hands its
own binding of `persist_snapshot` to the service so that replacing
`v1.persist_snapshot` keeps working (`tests/test_launch_atomicity.py`).

The job routes were **not** moved to a `routes/jobs_v1.py`: `create_job` and
`_create_job_core` are used through `routes.v1` by `study_jobs.py` and by tests,
and the router's position in the OpenAPI path order (checked by the contract
test) must not change. Moving the router is a follow-up that needs those callers
changed first.

## Engine registry

`POST /v1/engines` and the `/v1/engine-registrations` family (register, list,
read, report, activate, deactivate, publication request, approve, reject, delete,
`PUT .../credential`) are thin controllers over `services/engine_registry.py`:

1. `routes/v1.py` authenticates the caller, reads the body within the
   expanded-document limit (`_read_json_body`: `413`, or `422` with the route's
   own code for malformed JSON) and builds a `RegistrationKey` from the query
   string;
2. the service does the application work and answers with a plain value or raises
   `RegistryProblem(status, code, detail, diagnostics)`:
   - **destination policy** (`register_engine`): HTTPS, or trusted internal HTTP
     only where `federation_require_https` is off, no userinfo or fragment, and
     every address the name resolves to must be in the permitted network class
     (no private, loopback, link-local, multicast, reserved or unspecified address
     over HTTPS). The check is `v1.remote.validate_endpoint`, run off the event
     loop by `avalidate_endpoint` (its blocking `getaddrinfo` runs in a worker
     thread), and the transport pins the validated address and never follows a
     redirect (`fetch_remote_document`);
   - **registration** is idempotent: the same identity with the same digest returns
     the stored summary, the same identity with other content is
     `409 immutable_registration`; it stores a private, inactive registration with
     a `pending` report and fetches nothing from the endpoint;
   - **state changes** (`change_registration`) verify the deployment first
     (`verify_registration`: pinned OpenAPI, auth, health, a deterministic solve
     probe) for `activate`, `request_publication` and `approve`. A deployment that
     is down or answers something else is a `failed` report and
     `409 conformance_failed` with the checks, and leaves the registration
     inactive; it is never an exception;
   - **credentials** (`set_credential`) are encrypted with
     `security.secrets.CredentialStore` (`MultiFernet`) and decrypted only to
     talk to the deployment; every answer is a registration summary, report or
     document, none of which carries a credential or its ciphertext, and no
     message the service builds contains one;
3. the route turns a `RegistryProblem` into `application/problem+json`.

The Engine resolution a registration pins (`engine_document_for_registration`)
lives in `services/engines.py` beside the manifest catalog it uses.

The service does not import `routes`, takes `fastapi` only for `HTTPException`
and holds no mutable module state (`test_engine_registry_is_independent_of_routes_and_fastapi_responses`).
The process settings, the endpoint validator, the transport (`fetch`, `solve`) and
the deployment check (`verify`) are arguments. `routes/v1.py` hands over its own
bindings of `get_settings`, `validate_endpoint`, `fetch_remote_document`,
`solve_remote` and `_verify_registration` on every call, so the tests that replace
them there (`tests/test_v1_platform_contracts.py`,
`tests/test_v1_lifecycle_rbac.py`, `tests/test_federated_multi_heuristic_example.py`)
are unchanged. `v1.py` also keeps `_verify_registration` (a wrapper) and the names
`_conformance_shape`, `_conformance_optimization`, `_assert_protocol_schema`,
`_assert_operation_auth`, `_operation_schema` and `RemoteEngineError`, which those
tests read; no existing test had to change its patch target.
`tests/test_engine_registry_service.py` calls the service directly.

The read-only engine discovery (`GET /v1/engines`, `/engines/revisions`,
`/engines/{namespace}/{name}/revisions/{version}`) is in `services/discovery.py`
([Discovery](#discovery)).

## Instances and snapshots

`POST /v1/instances`, `POST /v1/validate`, `POST /v1/instances/validate`,
`GET /v1/instances/{id}` (with `/source` and `/ir`) and `GET /v1/snapshots/{id}`
(with `/archive`) are thin controllers over `services/instances.py`:

1. `routes/v1.py` authenticates the caller and wraps the request in a
   `PackageRequest` (the headers, the way to read the body and the two package size
   limits, which the service asks for only when they apply);
2. the service does the application work and answers with a plain value, raises
   `InstanceProblem(status, code, detail)` for a refusal with a code of its own, or
   the `HTTPException` it always raised for what the toolchain refuses (`415`/`413`
   for the media type and size of an upload, `422` for a package it cannot read,
   with the toolchain's message):
   - `read_package`, `multipart_zip` and `compile_upload` (upload limits and
     toolchain errors);
   - `validate_legacy` and `validate_package` (an upload or an exact snapshot
     reference; the plan's complexity limit; the compatible Engine modes);
   - `create_snapshot` (compile, then persist);
   - `instance_view`, `instance_source`, `instance_ir`, `snapshot_detail` and
     `snapshot_archive` (the readers: a snapshot is found only for its owner);
3. the route turns the outcome into the response (`_service_problem` for an
   `InstanceProblem`, `_error_from_http` for an `HTTPException`).

What decides *which* snapshot is stored or seen is `services/snapshots.py`, not
repeated in `instances.py`: `persist_snapshot` deduplicates by package and
compilation digest **inside the owner** (the unique constraint is
`owner, package, compilation`), so the same package uploaded by two accounts is two
independent snapshots and neither account can read the other's, and
`owned_snapshot` is the single visibility rule (the owner, or a member of an
organization the snapshot is shared with through a case).
`tests/test_instances_service.py` calls the service directly and pins those
properties, the upload limits and the controlled error for a corrupt package.

`routes/v1.py` resolves on every call the names that tests replace and hands them
over: `persist_snapshot` and `compile_resolved` (arguments of `create_snapshot`,
`validate_*`), and `_max_compressed` / `_max_expanded` (the lambdas of
`_package_request`). `_read_package`, `_multipart_zip`, `_error_from_http` and
`_BIM_ZIP_TYPES` stay as thin names in `v1.py` because the job upload path and the
tests use them. The responses and `docs/openapi.json` are unchanged.

There is no HTTP handler for the deterministic probe: it is `services/probe.py`,
used by `verify_registration` (Engine registry).

## Discovery

`GET /v1/profiles`, `/dialects`, `/resources` (and `/resources/{name}`),
`/schemas/{kind}`, `/examples` (and `/examples/{path}`), `/engines`,
`/engines/revisions` and `/engines/{namespace}/{name}/revisions/{version}` build
their documents in `services/discovery.py`; `/catalog` is the composition of
those handlers and stays in the route. The service raises
`DiscoveryProblem(status, code, detail)`; the route renders it. It reads, never
writes, and keeps no state: the resources registered without a database are held by
the route that registers them (`_CUSTOM_RESOURCE_RECORDS`) and passed in, and the
installed Dialects are always the ones of this process. `v1.py` keeps
`_builtin_dialects` and `_installed_dialect_contract` as wrappers (the
publication routes and the tests use them) and passes its own `_manifest` to
`engine_revision_document`.

`GET /v1/engines/{name}` stays in the route: the permission check
(`allows_engine`) is its whole decision and the rest is `services.engines`.

## MVC in a JSON API

OpenBinding does not render HTML on the server, so the classic triad maps like
this:

- **Model** is the domain and its persistence: the ORM entities in `db/`
  (`User`, `Job`, `Organization`, …) with the rules in `domain/`, `services/`
  and `jobs/`.
- **View** is the *response schema*: the Pydantic classes of `models/` that
  define the JSON a client sees (and that become `docs/openapi.json`). The React
  application in `frontend/` is a separate client, not a view of this server.
- **Controller** is the route function in `routes/`.

The consequence that matters: **a DTO is not an ORM entity.** `models/*.py` are
Pydantic `BaseModel`s; `db/*.py` are SQLAlchemy mapped classes. A route
converts between them explicitly so that the wire format can change without a
migration and a column can change without a breaking API. `models/` imports
Pydantic and FastAPI, and (in `models/accounts.py`) the API-key permission
vocabulary from `security/apikeys.py`; it does not import `db/`, which was
checked with a search for `from ..db` in the package.

## Direction of dependencies

Allowed: `routes → services → repositories / integrations → db`, and every
layer may use `domain`, `models` and `core`. Forbidden: any of `services/`,
`domain/` and `jobs/` importing `routes`.

Known exceptions to "downwards only", from reading the imports:

- `domain/entitlements.py` refers to `space_client.PlanCaps` for typing only
  (`TYPE_CHECKING`).
- `jobs/lifecycle.py` and `jobs/reconciler.py` import `..study_jobs`,
  `..job_dispatch` and `..telemetry` lazily, inside functions, because those
  modules still live at the top level. (`..sponsor_proposals` and
  `..analysis_jobs` were imported the same way until M9.6 removed them.)
- `services/engines.py`, `services/engine_registry.py`, `services/snapshots.py`,
  `services/instances.py`, `services/discovery.py`, `services/job_submission.py`
  and `services/entitlements.py` import FastAPI's `HTTPException` (the last one only for its HTTP-raising
  helpers, `*_or_503`, `require_*` and `enforce_*`; `caps_for` raises a plain
  domain exception), so services
  are not completely framework-free.

### Architecture tests

`openbinding-gateway/tests/test_architecture_layers.py` enforces what is
mechanically checkable, using `ast` so that imports inside functions count:

- `services/`, `domain/` and `jobs/` do not import `openbinding_gateway.routes`
  (`test_services_domain_and_jobs_do_not_import_routes`);
- no module outside `routes/` and those three layers may start importing
  `routes`: the existing offenders are frozen in `ALLOWED_LEGACY`
  (`artifacts`, `reports`, `study_jobs`; `analysis_jobs` was removed by M9.6;
  `main` is exempt as the composition root), the list may only shrink
  (`test_no_new_module_imports_routes`, `test_allowed_legacy_has_no_stale_entries`);
- `services/job_submission.py` imports `routes` nowhere and uses `fastapi` only for
  `HTTPException` (`test_job_submission_is_independent_of_routes_and_fastapi_responses`);
- `services/engine_registry.py` imports `routes` nowhere, uses `fastapi` only for
  `HTTPException` and keeps no mutable module state
  (`test_engine_registry_is_independent_of_routes_and_fastapi_responses`);
- `services/instances.py` and `services/discovery.py` import `routes` nowhere, use
  `fastapi` only for `HTTPException` and keep no mutable module state
  (`test_the_v1_services_are_independent_of_routes_and_fastapi_responses`);
- `routes/v1.py` is frozen at `MAX_LINES` lines, a ratchet that may only go down
  (`test_v1_router_does_not_grow`, `test_the_v1_ceiling_follows_the_file_down`);
- plan capabilities are read only in `services/entitlements.py` ([Entitlements](#entitlements));
- nothing imports a `metering` module (`test_nothing_imports_the_retired_metering_module`);
- the detector itself recognises every import form (`test_detector_sees_every_import_form`).

`tests/test_bim_boundary.py` checks that only `integrations/bim*.py` import the
BIM packages. `test_architecture_layers.py` also constrains `integrations/`; the
rest of the table (`models/`, `db/`) is convention, not enforcement.

## The BIM / platform boundary

BIM is a language and a toolchain: load a package, compile it to a canonical
`BindingProblem`, evaluate and re-evaluate bindings, validate the Engine
protocol. The platform is everything around it: accounts, organizations,
projects, plans, jobs and queues, persistence, the artifact library, studies,
reports, the resolver and the HTTP routes. The toolchain must not know the
platform, and the platform reaches BIM through a small port.

**Current state.** The gateway depends on `bim-core` and `bim-client` from
[`bim-toolchain/`](../../bim-toolchain/README.md) (the future private repository
`javiercavlop/bim-toolchain`; the remote does not exist yet) and reaches the
language only through `bim_client.BimPort`, built in
`openbinding_gateway/integrations/bim.py`. `BIM_MODE=inproc` (default) runs
`InProcessBim`; `BIM_MODE=http` runs `HttpBim` against `bim-service` and refuses
to start if the service `compilerDigest` differs from the local one. Routes,
services, the generator, studies and reports use the port; BIM errors are
translated to HTTP in one place. Details in [BIM_CORE.md](../BIM_CORE.md).

`integrations/` may import `core`, `models` and the BIM packages, and must not
import `routes`, `services`, `repositories`, `jobs` or `db`
(`test_architecture_layers.py`). The residual direct `bim_core` use in
`integrations/bim_host.py` is enforced by `tests/test_bim_boundary.py`.

## Known debt (pending work)

These are real and not scheduled; no dates are promised.

- `routes/v1.py` is 1,329 lines (frozen at 1,400 by
  `test_v1_router_does_not_grow`; it was about 2,960 before job creation moved
  to `services/job_submission.py`, about 2,570 before the Engine registry
  moved to `services/engine_registry.py`, and 1,692 before instances, snapshots
  and discovery moved to `services/instances.py` and `services/discovery.py`).
  What is left, and why: the controllers of every service above (authentication,
  permission, service call, translation to a response, plus the names the tests
  replace); the job routes and their transport (`create_job`, `_create_job_core`,
  `_read_job_request`, which `study_jobs.py` and many tests reach through the
  router); and the code that still has not moved, in this order of expected size:
  the dialect and resource registries (`POST /dialects`, `POST /resources` and
  their approvals), which hold their own publication logic inline and the
  in-module `_CUSTOM_RESOURCE_RECORDS` that `discovery` receives as an argument;
  the job read routes (`/jobs/{id}`, neighbourhood with its `_ANALYSIS_SLOTS`
  semaphore, IR, instance, report), whose queries belong in
  `repositories/jobs.py`; and `GET /engines/{name}`. Each should move into
  `services/` and `repositories/` and lower `MAX_LINES` when it does.
- Four modules still import `routes` (`ALLOWED_LEGACY` above). `study_jobs.py`
  still calls `v1._create_job_core` and the pending-launch helpers through the
  router; once it calls `JobSubmission` directly it can leave the list.
- `repositories/` holds two modules (`jobs.py`, `organizations.py`); the remaining
  queries are in routes and top-level modules, some deliberately
  ([Repositories](#repositories)).
- The contract lifecycle (create, novate, read the subscription, pricing token,
  remove) still calls `get_gate()` from `routes/admin.py`, `routes/auth.py`,
  `routes/cas.py`, `routes/users.py` and `access/contracts.py`
  (`GATE_LIFECYCLE_LEGACY`). It is not a plan read, but it should move behind a
  service of its own like entitlements did.
- The per-account `apiKeys` limit in `routes/users.py` is still decided inline
  (it needs the session for the count); only the read of the plan goes through
  the service.

Related: [ACCOUNTS_AND_PLANS.md](../ACCOUNTS_AND_PLANS.md),
[IDEMPOTENCY.md](../IDEMPOTENCY.md), [qa/JOINT_STATUS.md](../qa/JOINT_STATUS.md).

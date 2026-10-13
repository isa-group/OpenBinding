# Architecture of the OpenBinding gateway

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
| `routes/` | HTTP: FastAPI routers, request parsing, authentication dependencies, translation of results and refusals to responses. `main.py` is the composition root: it includes every router (`app.include_router(...)`) and starts the lifespan, which installs the pricing gate and the job reconciler | `main.py` |
| `services/` | Use cases that are not HTTP: `execution.py` (run a persisted job), `engines.py` (Engine selection and compatibility), `snapshots.py` (persist a compilation), `entitlements.py` (the only reader of an account's plan, see [Entitlements](#entitlements)) | `services/*.py` |
| `repositories/` | Database queries. At present only `jobs.py` (`get_owned`, `list_owned`, `find_retry_of`, `list_for_project`) | `repositories/jobs.py` |
| Integrations | `space_client/` (the pricing gate over the SPACE client, plus a fake for tests), `sphere_client.py` (read-only pricing source), `cas.py`, `mailer.py`, `job_dispatch.py` (Dramatiq/Redis) | respective files |
| `db/` | SQLAlchemy ORM models and session handling (`models.py`, `platform_models.py`, `artifact_models.py`, `base.py`) | `db/` |
| `domain/` | Rules without I/O: `entitlements.py` (transport-neutral `Refusal`, e.g. `concurrency_refusal`), `idempotency.py` (request fingerprint) | `domain/*.py` |
| `models/` | Pydantic request/response schemas (DTO), see below | `models/*.py` |
| `core/` | `settings.py` (every environment variable in one place) and `logging.py` | `core/` |
| `access/`, `security/` | Plan policy (`access/policy.py`: clamping, ceilings and quota rules, applied through `services/entitlements.py`), contract bookkeeping (`access/contracts.py`), public-read matrix; hashing of passwords, tokens and API keys | respective files |
| `jobs/` | The job lifecycle: `leases.py`, `reconciler.py`, `limits.py`, `lifecycle.py` ([IDEMPOTENCY.md](IDEMPOTENCY.md)) | `jobs/*.py` |
| `integrations/bim.py`, `v1/`, `generator/` | The BIM port (`BimPort`, settings, error translation), the remaining `v1/` platform code (archive, remote Engine transport) and the instance generator (see [the BIM boundary](#the-bim--platform-boundary)) | `integrations/`, `v1/`, `generator/` |

Not every module follows the layer table yet: several top-level modules
(`artifacts.py`, `reports.py`, `studies.py`, `study_jobs.py`, `analysis_jobs.py`,
`collaboration.py`, `sponsor_proposals.py`, `telemetry.py`)
mix use-case logic and persistence outside `services/` and `repositories/`.

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
`routes/v1.py:2222` and `:2543`, `routes/users.py:63`, `routes/studies.py:637`,
`collaboration.py:282`. `study_jobs.py`, `studies.py`, `analysis_jobs.py` and
`sponsor_proposals.py` never read the gate; they reach it through
`collaboration.enforce_sponsor_usage` and the job-creation path. Now the only
`.caps(` call is `services/entitlements.py:63`.

`get_gate` is still used for the **contract lifecycle**, which is not a plan
decision: `routes/admin.py:88` (import; calls at `:230`, `:285`, `:345`, `:394`,
`:473`), `routes/auth.py:191`, `routes/cas.py:160`, `:306`, `:397`, `:418`,
`routes/users.py:56` (import; calls at `:571` and `:782`),
`access/contracts.py:57`, `job_dispatch.py:45` and `:61` (worker gate lifetime),
`main.py:146` (lifespan). `space_client/` is the gate itself.

`tests/test_architecture_layers.py` enforces it: no module but
`services/entitlements.py` calls `.caps(...)`, and the modules allowed to reach
`get_gate` are the frozen list `GATE_LIFECYCLE_LEGACY` (plus the composition root
and `space_client/`); the list can only shrink
(`test_only_the_entitlement_service_reads_plan_capabilities`,
`test_no_new_module_reaches_for_the_gate`,
`test_gate_lifecycle_legacy_has_no_stale_entries`).

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
  `..job_dispatch`, `..sponsor_proposals`, `..telemetry` and
  `..analysis_jobs` lazily, inside functions, because those modules still live
  at the top level.
- `services/engines.py`, `services/snapshots.py` and `services/entitlements.py`
  import FastAPI's `HTTPException` (the last one only for its HTTP-raising
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
  (`analysis_jobs`, `artifacts`, `reports`, `study_jobs`;
  `main` is exempt as the composition root), the list may only shrink
  (`test_no_new_module_imports_routes`, `test_allowed_legacy_has_no_stale_entries`);
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
[`bim-toolchain/`](../bim-toolchain/README.md) (the future private repository
`javiercavlop/bim-toolchain`; the remote does not exist yet) and reaches the
language only through `bim_client.BimPort`, built in
`openbinding_gateway/integrations/bim.py`. `BIM_MODE=inproc` (default) runs
`InProcessBim`; `BIM_MODE=http` runs `HttpBim` against `bim-service` and refuses
to start if the service `compilerDigest` differs from the local one. Routes,
services, the generator, studies and reports use the port; BIM errors are
translated to HTTP in one place. Details in [BIM_CORE.md](BIM_CORE.md).

`integrations/` may import `core`, `models` and the BIM packages, and must not
import `routes`, `services`, `repositories`, `jobs` or `db`
(`test_architecture_layers.py`). The residual direct `bim_core` use in
`integrations/bim_host.py` is enforced by `tests/test_bim_boundary.py`.

## Known debt (pending work)

These are real and not scheduled; no dates are promised.

- `routes/v1.py` is about 3,250 lines and holds job creation, snapshot
  persistence, Engine registration and much else. Its logic should move into
  `services/` and `repositories/`.
- Four modules still import `routes` (`ALLOWED_LEGACY` above).
- `repositories/` holds one module; most queries are in routes and top-level
  modules.
- The contract lifecycle (create, novate, read the subscription, pricing token,
  remove) still calls `get_gate()` from `routes/admin.py`, `routes/auth.py`,
  `routes/cas.py`, `routes/users.py` and `access/contracts.py`
  (`GATE_LIFECYCLE_LEGACY`). It is not a plan read, but it should move behind a
  service of its own like entitlements did.
- The per-account `apiKeys` limit in `routes/users.py` is still decided inline
  (it needs the session for the count); only the read of the plan goes through
  the service.

Related: [ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md),
[IDEMPOTENCY.md](IDEMPOTENCY.md), [qa/JOINT_STATUS.md](qa/JOINT_STATUS.md).

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
| `services/` | Use cases that are not HTTP: `execution.py` (run a persisted job), `engines.py` (Engine selection and compatibility), `snapshots.py` (persist a compilation) | `services/*.py` |
| `repositories/` | Database queries. At present only `jobs.py` (`get_owned`, `list_owned`, `find_retry_of`, `list_for_project`) | `repositories/jobs.py` |
| Integrations | `space_client/` (the pricing gate over the SPACE client, plus a fake for tests), `sphere_client.py` (read-only pricing source), `cas.py`, `mailer.py`, `job_dispatch.py` (Dramatiq/Redis) | respective files |
| `db/` | SQLAlchemy ORM models and session handling (`models.py`, `platform_models.py`, `artifact_models.py`, `base.py`) | `db/` |
| `domain/` | Rules without I/O: `entitlements.py` (transport-neutral `Refusal`, e.g. `concurrency_refusal`), `idempotency.py` (request fingerprint) | `domain/*.py` |
| `models/` | Pydantic request/response schemas (DTO), see below | `models/*.py` |
| `core/` | `settings.py` (every environment variable in one place) and `logging.py` | `core/` |
| `access/`, `security/` | Plan policy (`access/policy.py`: clamping and ceilings), contract bookkeeping (`access/contracts.py`), public-read matrix; hashing of passwords, tokens and API keys | respective files |
| `jobs/` | The job lifecycle: `leases.py`, `reconciler.py`, `limits.py`, `lifecycle.py` ([IDEMPOTENCY.md](IDEMPOTENCY.md)) | `jobs/*.py` |
| `v1/`, `generator/` | The BIM language implementation and the instance generator (see [the BIM boundary](#the-bim--platform-boundary)) | `v1/`, `generator/` |

Not every module follows the layer table yet: several top-level modules
(`artifacts.py`, `reports.py`, `studies.py`, `study_jobs.py`, `analysis_jobs.py`,
`collaboration.py`, `sponsor_proposals.py`, `pricing_bootstrap.py`, `telemetry.py`)
mix use-case logic and persistence outside `services/` and `repositories/`.

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

- `domain/idempotency.py` imports `..v1.canonical` (the BIM canonical digest).
- `domain/entitlements.py` refers to `space_client.PlanCaps` for typing only
  (`TYPE_CHECKING`).
- `jobs/lifecycle.py` and `jobs/reconciler.py` import `..study_jobs`,
  `..job_dispatch`, `..sponsor_proposals`, `..telemetry` and
  `..analysis_jobs` lazily, inside functions, because those modules still live
  at the top level.
- `services/engines.py` and `services/snapshots.py` import FastAPI's
  `HTTPException`, so services are not completely framework-free.

### Architecture tests

`openbinding-gateway/tests/test_architecture_layers.py` enforces what is
mechanically checkable, using `ast` so that imports inside functions count:

- `services/`, `domain/` and `jobs/` do not import `openbinding_gateway.routes`
  (`test_services_domain_and_jobs_do_not_import_routes`);
- no module outside `routes/` and those three layers may start importing
  `routes`: the existing offenders are frozen in `ALLOWED_LEGACY`
  (`analysis_jobs`, `artifacts`, `pricing_bootstrap`, `reports`, `study_jobs`;
  `main` is exempt as the composition root), the list may only shrink
  (`test_no_new_module_imports_routes`, `test_allowed_legacy_has_no_stale_entries`);
- nothing imports a `metering` module (`test_nothing_imports_the_retired_metering_module`);
- the detector itself recognises every import form (`test_detector_sees_every_import_form`).

`tests/test_bim_core_boundary.py` checks the import rule of the in-place BIM
copy. Neither test constrains `models/`, `db/` or integrations, so the rest of
the table is convention, not enforcement. I did not run these tests for this
document.

## The BIM / platform boundary

BIM is a language and a toolchain: load a package, compile it to a canonical
`BindingProblem`, evaluate and re-evaluate bindings, validate the Engine
protocol. The platform is everything around it: accounts, organizations,
projects, plans, jobs and queues, persistence, the artifact library, studies,
reports, the resolver and the HTTP routes. The toolchain must not know the
platform, and the platform reaches BIM through a small port.

**Current state (transitional).** The gateway imports its own copy of the
compiler as `openbinding_gateway.v1` (`routes/`, `services/`, `generator/`,
`domain/idempotency.py`, `studies.py`, `reports.py`, `artifacts.py`, … all
import it). A copy of the language was made in
[`bim-toolchain/`](../bim-toolchain/README.md) (`bim-core`), which is the future
private repository `javiercavlop/bim-toolchain`; the remote does not exist yet.
The planned shape is `bim-core` (compilation and evaluation), `bim-service` (HTTP
API under `/bim/v1`) and `bim-client` (a `BimPort` with in-process and HTTP
implementations). In this tree only `bim-core` is present, and the gateway does
not depend on it. The cut-over is **pending work**; see
[BIM_CORE.md](BIM_CORE.md).

## Known debt (pending work)

These are real and not scheduled; no dates are promised.

- `routes/v1.py` is about 3,250 lines and holds job creation, snapshot
  persistence, Engine registration and much else. Its logic should move into
  `services/` and `repositories/`.
- The gateway still imports `openbinding_gateway.v1` (53 import occurrences in
  25 files by a text search), so the BIM boundary above is not yet a real
  boundary.
- Five modules still import `routes` (`ALLOWED_LEGACY` above).
- `repositories/` holds one module; most queries are in routes and top-level
  modules.
- Code from before the removal of metering and pricing administration is still
  present: `routes/pricing.py`, `space_client/deployments.py` and the
  contract-renewal sweeps called by `jobs/reconciler.py`. Which of them are
  still reachable was not traced. The pricing fixture
  `space/pricing/openbinding.yml` still declares consumption-style limits that
  no code reads, and `core/settings.py` still has a second, destructive-operation
  SPACE key setting used by the deployment client.

Related: [ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md),
[IDEMPOTENCY.md](IDEMPOTENCY.md), [qa/JOINT_STATUS.md](qa/JOINT_STATUS.md).

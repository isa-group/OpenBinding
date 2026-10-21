# Extraction log

First real cut of BIM (compilation) out of OpenBinding into a self-contained `bim-toolchain/` directory, the
future root of a separate private repository (`javiercavlop/bim-toolchain`, not created yet; extractable with
`git subtree split`). The originals under `openbinding-gateway/src/openbinding_gateway/v1/` were copied, not moved,
and are untouched.

## Copied as is

| From (OpenBinding) | To (bim-toolchain) |
| --- | --- |
| `openbinding-gateway/src/openbinding_gateway/v1/{canonical,package,expressions,compiler,__init__}.py` | `packages/bim-core/src/bim_core/` (then edited, see below) |
| `…/v1/vendor/omg/bpmn/2.0.2/*` (5 XSD + README) | `…/bim_core/resources/vendor/omg/bpmn/2.0.2/` (unchanged, notices preserved) |
| `schemas/bim/v1/*.schema.json` (12) | `…/bim_core/resources/schemas/bim/v1/` (unchanged) |
| `schemas/engine-contract.openapi.yaml` | `…/bim_core/resources/schemas/` (unchanged) |
| `openbinding-gateway/tests/golden/bim_baseline/*.json` (5) | `golden/bim_baseline/` (unchanged) |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | `./` (unchanged) |
| `tests/test_v1_canonical.py` | `packages/bim-core/tests/` (imports renamed by `sed`, otherwise unchanged) |
| `tests/test_complete_bpmn_json_regression.py` | same; rewritten afterwards because it needed `tests/_repo.py` |

`schemas/bim/v1/manifests/` was not copied: Engine manifests are a platform catalog and stay in OpenBinding.
Not copied either: the corpus (`examples/`, `engines/*/tests/fixtures`, …) and any dataset.

## Tests migrated from OpenBinding

The bootstrap only copied two tests; the rest import platform code or `tests/_repo.py`. They were rewritten to use
`bim_core` only, reading the corpus through `BIM_CORPUS_ROOT` (`conftest.require_corpus_path`, which skips with a
warning when the corpus is absent). Original → `packages/bim-core/tests/`:

| Original | Migrated as | Left out (stays in OpenBinding / later task) |
| --- | --- | --- |
| `test_v1_package_security` | `test_package_security.py` (uses `Limits`, not monkeypatched constants) | `_multipart_zip` route test |
| `test_v1_language` | `test_v1_language.py` (11 of 13 tests) | the two `POST /v1/jobs` `TestClient` tests (`accounts_unavailable`) |
| `test_b5_golden` | `test_b5_golden.py` (pinned finite-range canonical JSON and digests, unchanged values) | protocol-digest test against the federation example / engine OpenAPI (`routes._protocol_digest`) |
| `test_b8_range_refusal_pointer` | `test_b8_range_refusal_pointer.py`: the language half, i.e. `sourceMap` + IR layout give `resource`/`pointer`/`irPath` of the range (lookup reproduced from `services/engines.py::_feature_value_location`) | refusals from `mode_compatibility` against a scalar-only mode; the `422 engine_mode_incompatible` API test |
| `test_complete_bpmn_example` | `test_complete_bpmn_example.py` (lowering test) | MiniZinc eligibility (`routes._manifest`, `_mode_compatibility`) |
| `test_b5_corpus` | `test_b5_corpus.py` (open ranges compile and stay in the IR; malformed ranges rejected) | whole-corpus compile (`tools/check_bim_corpus.py`; covered by `test_baseline_equivalence.py`), `frontend` exclusion tests, scalar-Engine refusals |
| `test_b5_open_ranges` | `test_b5_open_ranges.py` (compile, IR round trip, validator, schemas read through `schema_root()`, evaluator/expression behaviour; 88 cases) | `featureValues` capability tests (`routes._ir_features`/`_mode_compatibility`), remote Engine payload (`v1.remote`), neighbourhood analysis (`v1.analysis`), the weighted-product tests (need `base_package` of `test_bim_v1_language_final`) |
| `test_bim_v1_language_final` | **partly migrated** in the evaluation step, see below | the compile-time tests |
| `test_v1_canonical`, `test_complete_bpmn_json_regression` | copied by the bootstrap | — |

`test_bim_v1_language_final.py` (1961 lines): the evaluation step migrated the tests about evaluation, the execution
optimization and the neighbourhood (next section). The rest only needs `bim_core` and can be ported mechanically in
a later step: multi-resource identity, CEL span diagnostics, duplicate-resource diagnostics, BindingProblem schema
closure, installed Profile/Dialect framework, adapter and dialect installation, registered resources, the interval
validators, placement validation, BPMN lowering, contextual aliases. `test_schema_root_prefers_the_deployment_configuration`
(`SCHEMAS_DIR`, which `bim_core` deliberately no longer reads) is obsolete: replace it by the `schema_root()` test in
`test_public_surface.py`. `DEMO`-based tests there need `BIM_CORPUS_ROOT`.

New tests written for this cut (no OpenBinding original): `test_public_surface.py` (public names, `__all__`,
`schema_root`, descriptors, `toolchain_identity`, `ir_digest`, `from_document`, `compilation_digest`, including the
recomputation of the platform's `snapshot_problem` semantic digest), `test_settings_and_errors.py`,
`test_toolchain_digest.py`, `test_boundary.py` (no environment access, no `parents[`, resources only through
`importlib.resources`), `test_baseline_equivalence.py`.

## Changed in the copied code

1. **Packaging.** `pyproject.toml` (hatchling, `src` layout, Python ≥ 3.11, `jsonschema` and `lxml`), `README.md`,
   `py.typed`, version 0.1.0. No license was declared then: `NOTICE.md` said the decision was pending (*historical:
   the license is CC-BY-4.0 since step 6, below*).
2. **Resources via `importlib.resources`.** New `assets.py`. `compiler.py` no longer reads `SCHEMAS_DIR`, uses
   `Path(__file__).parents[4]` or reads the XSD next to itself; `package.py` loads the BPMN XSD from
   `bim_core/resources`, not from `openbinding_gateway.v1`.
3. **Injected settings.** New `settings.py` (`Limits`, `Limits.from_env`, `configure`, `default_limits`).
   `package.py` has no module-level `MAX_*` constants and no environment access; `load_package(..., limits=)` and
   `InstancePackage(files, limits)` take the limits. A bad `BIM_MAX_*` value used to raise `RuntimeError` at import;
   it now raises `ContractError(code="invalid_limit")` from `Limits.from_env`, with the same text.
4. **Errors.** New `errors.py`. `PackageError` and `CompileError` moved there and are re-exported from `package` and
   `compiler`; `ExpressionError` and `CanonicalizationError` stay in their modules. All derive from `BimError` and
   `ValueError`. Messages and class names are unchanged (the baseline records the names).
5. **IR integrity.** `BindingProblem.from_document(document, *, verify=True, expected_digest=None)`, `ir_digest`
   (the formula that `compile_instance` used inline and the platform's `snapshot_problem` repeated) and
   `compilation_digest` (the formula of `persist_snapshot`), both read from
   `openbinding_gateway/services/snapshots.py:194-197,305-325` and reproduced without importing the platform.
6. **Public names.** `_schema_root`, `_dialect_type_matches`, `_dialect_xml_type_matches`,
   `_resource_schema_diagnostics`, `_dialect_descriptor`, `_profile_descriptor` lost their underscore (a local
   variable named `profile_descriptor` was renamed to avoid shadowing). `bim_core.__all__` lists the public
   surface; `toolchain_identity()` was added.
7. **Toolchain digest.** New `toolchain.py`: `compiler_bundle_digest()` covers all `.py` files and `resources/`,
   walked with `importlib.resources`. The synthetic package built for registered resources inherits the limits of
   the package being compiled.
8. **Tools and tests.** `tools/baseline_core.py` (adapted from `tools/bim_baseline.py`: `bim_core` only, corpus
   located through `BIM_CORPUS_ROOT`, corpus and negatives only) and the tests in `packages/bim-core/tests/`.

## Decisions and deviations

- `CompileDiagnostic` is not made a `BimError`: it is a frozen dataclass that is never raised, only carried in
  `BimError.diagnostics`. The task text listed it among the classes to derive from `BimError`; this was read as
  applying to the exception classes.
- (First cut) The evaluator kept raising `ValueError`; the evaluation step below added `EvaluationError` without
  changing those sites.
- The platform's "semantic digest" check is exposed as `ir_digest` to avoid a clash with the baseline's semantic
  digest, which also drops `spec.profile`. See `DIGESTS.md`.
- `from_document` also validates the document against the installed `BindingProblem` schema, which the platform
  did not do when reading a snapshot.
- `compiler_bundle_digest()` is memoised (`lru_cache`); `toolchain.bundle_digest(root)` is the uncached function
  the tests use to show that adding a file changes the digest.
- The BPMN XSD bundle is read from a real directory (`as_file`), so zip imports of the package are unsupported.
- The full corpus comparison is the default in `test_baseline_equivalence.py`; `BIM_BASELINE_SAMPLE_ONLY=1` runs
  only the ten-package sample (OpenBinding's own test did the reverse).

## Evaluation, re-evaluation, protocol and compatibility (step 3-3)

Copied (not moved) from the platform, which is untouched. New modules of `bim_core`, with their origin in
`openbinding-gateway/src/openbinding_gateway/` (line numbers of the platform at this commit):

| Module | Origin | What |
| --- | --- | --- |
| `evaluator.py` | `bim_core/compiler.py` `BindingProblem.validate_binding` (3621), `evaluate_binding` (4096), `evaluate_constraints` (4153), `evaluate_objectives` (4178), `evaluate` (4222) | public API over the methods: `validate_binding`, `evaluate`, `evaluate_many`, `evaluate_features`, `evaluate_violations`, `evaluate_objectives`; failures become `EvaluationError` |
| `reevaluate.py` | `services/execution.py` 37-135: `candidate_ref`, `binding_violations`, `authoritative_evaluation`, `reevaluate_result` | same logic, on the evaluator API |
| `protocol.py` | `v1/remote.py` 137-235 `_validate_result`, 238-247 `_validate_job_receipt`, 250-277 `_validate_job`; `services/engines.py` 29-46 `protocol_document`, `protocol_digest` | `validate_result`, `validate_job_receipt`, `validate_job`, `protocol_document`, `protocol_digest`; the contract is read from `resources/schemas` |
| `compat.py` | `services/engines.py` 153-162 `selector_values`, 242-264 `schema_diagnostics`, 267-283 `embedded_secret_paths`, 286-410 `engine_contract_diagnostics`, 413-490 `engine_mode` (split into `select_mode`, `validate_options`, `resolve_engine_mode`), 496-825 `candidate_count`, `ir_features`, `mode_compatibility` and their helpers, 828-836 `engine_ref`, 1130-1156 `mode_execution_contract`, `persisted_mode_contract`; `routes/v1.py` 647-713 `_resolve_execution_optimization` → `resolve_optimization` | `HTTPException` → `ContractError(code, message, diagnostics, http_status=422)` |
| `neighborhood.py` | `v1/analysis.py` (whole file) | `analyze_neighborhood`; the 2 s budget is the `seconds` parameter |
| `conformance.py` | `routes/v1.py` 216-471 (`_pointer`, `_schema_semantics`, `_operation_schema`, `_assert_operation_auth`, `_assert_protocol_schema`, `_conformance_*`), 508-601 recomposed as `openapi_diagnostics`, 612-619 as `assert_conformance_result` | no network; `RemoteEngineError` → `ProtocolError` |

Not ported: `v1/remote.py` outside 137-277 (httpx transport, SSRF policy, DNS pinning, size limits),
`services/engines.py` (manifest lookup in the catalog/database, registrations, visibility, `registration_transport`),
the rest of `services/execution.py` (job claiming, metering, persistence), and the network half of
`_verify_registration` (`routes/v1.py` 474-644: fetching the served OpenAPI, health call, the probe request).

Tests: `test_evaluator`, `test_reevaluate`, `test_protocol`, `test_compat`, `test_neighborhood`, `test_conformance`
(new), `test_vectors_extra` (new), `test_language_final_evaluation` (migrated, below), `_language.py` (shared builders)
and extensions of `test_baseline_equivalence`, `test_boundary` and `test_public_surface`.

Migrated from the platform's tests, mechanically (imports; `HTTPException` → `ContractError`/`http_status`):

| Original | Migrated as |
| --- | --- |
| `test_bim_v1_language_final.py`: execution-objective cardinality (11 cases), compiled optimization vs execution type, multi-resource evaluation, binding completeness, parallel operator, weighted product, fractional product, metric neutral, normalization/clamp, no comparison epsilon, `when` short-circuit, optional provider, soft penalty per scalarization, the interval evaluator tests, the non-finite endpoints, neighbourhood with intervals | `test_language_final_evaluation.py` |
| `test_binding_analysis.py`: the 6 tests that need only the problem | `test_neighborhood.py` (its endpoint/ownership test stays in OpenBinding) |
| `test_b5_open_ranges.py`: the `featureValues` capability tests | `test_compat.py` (the engine list is the four fixtures; the remote-payload tests need httpx and stay in OpenBinding) |

Still not migrated: the rest of `test_bim_v1_language_final.py` listed above, `test_v1_remote.py`,
`test_v1_job_guarantees.py` and `test_v1_platform_contracts.py` (they exercise the transport, the database or the
routes).

### Decisions and deviations of this step

- **The evaluator was not moved out of `BindingProblem`.** The methods share private helpers of the compiler
  (candidate lookup, expressions, placement, scalar-feature access) and `compiler.py` would have had to import
  `evaluator.py` and the reverse. `evaluator.py` is the stable public API instead; no behaviour changes and the
  golden negatives, which record `ValueError`, stay valid. `EvaluationError` is raised only by the facade, with
  `from exc` so the original exception is the `__cause__`. Moving the code remains possible later without changing
  the API.
- `neighborhood.py` evaluates the base through the facade (so it raises `EvaluationError`) and every move through
  `problem.evaluate` exactly as before, catching only `ValueError`/`ArithmeticError` as the original did: a
  `KeyError`/`TypeError` raised by a move is a bug and still propagates.
- **Small hardening, the only behaviour differences from the originals** (each has tests): membership tests against
  sets no longer raise `TypeError` for an unhashable value (a JSON list or object as `termination`, objective
  `type`, `enforcement`, job `status`, a scalarization type, a stored mode guarantee, an allowed termination) —
  the value is just invalid; `validate_options` reports `invalid_option`/`option_type` when a limited option is not
  a number (it used to compare and raise `TypeError`); `assert_conformance_result` does not crash on a malformed
  `decision`; `resolve_optimization` rejects a non-string objective type with `invalid_optimization_type`.
- **New, not in the originals:** `validate_result(..., finite=True)` rejects NaN/Infinity anywhere in a message;
  `openapi_diagnostics` collects the findings of independent checks instead of stopping at the first (the original
  stopped at the first and the host needs the first only: take `[0]`); error codes on every `ProtocolError`;
  `ContractError.http_status` (and `httpStatus` in `as_dict()`).
- A failed job reported by an engine is `ProtocolError(code="engine_job_failed")` with the engine's own message
  (the original raised `RemoteEngineError` with the same message).
- `validate_result` keeps accepting a float NaN/Infinity by default, as the original does (the transport's strict
  parser rejects them first). `reevaluate_result` is safe against such values in `solutions` because it replaces
  every number, but it passes `provenance` through untouched, so a non-finite value there reaches the caller; this is
  pinned in `test_vectors_extra.py`. A host that serializes provenance must use `allow_nan=False` or validate with
  `finite=True`.
- `pyyaml` (`>=6,<7`, the range the gateway uses) was added to the dependencies of `bim-core` for `protocol.py`.
  `tests/test_boundary.py` allows `yaml` and requires it in `pyproject.toml`.
- **Engine manifests are fixtures**, copied by the bootstrap check to `tests/fixtures/manifests/` (4 files). The
  OpenBinding goldens list a fifth Engine, `meta-router-csp`, whose manifest is not in the repository: see
  `DIGESTS.md` (legitimate difference, new goldens in `golden/bim_core/`). `compat.json` and `protocol.json` of
  OpenBinding's *current* goldens already list four Engines, and the copy in `golden/bim_baseline` lists five, so in
  this worktree `test_the_goldens_are_the_ones_recorded_in_openbinding` (byte equality of the five files) could not
  pass as it was (it failed in the first run of this step); it now requires byte equality for `corpus`,
  `negatives` and `vectors`, and equality modulo the missing Engine and the `toolchain` fields for `compat` and
  `protocol`. `golden/bim_baseline` was not touched.
- The worker can only run registered checks, not `tools/baseline_core.py` directly, so the goldens without an
  OpenBinding original were created by the tests themselves the first time they ran
  (`conftest.check_or_create_golden`; that run failed on purpose, the next one compared). Their content is justified
  by independent comparisons (see `DIGESTS.md`), not by having been produced by the same code. The command line of
  `baseline_core.py` is exercised by tests (`--check` finds no difference; write mode, into a temporary directory,
  writes documents equal to the committed goldens and never writes `compat.json`/`protocol.json` of
  `golden/bim_baseline`).
- `baseline_core.py` keeps `analyze_directory`/`build_corpus` (same signatures) and adds `analyze_package`,
  `build_corpus_and_compat`, `build_all`, `build_vectors`, `build_vectors_extra`, `build_protocol`,
  `build_evaluator_errors`, `differences`, `mismatches` (new signature) and `without_engines`.

## Verification status

Run in the worker with `uv sync --locked --extra test` in `openbinding-gateway` (only to get pytest and ruff) and
`PYTHONPATH=../bim-toolchain/packages/bim-core/src`, with the registered checks:

- `pytest packages/bim-core/tests`: **1014 passed, 1 xfailed (strict, ported as is), 0 failed, 0 skipped** in about
  39 s, with the corpus present (`BIM_CORPUS_ROOT` defaults to the repository root). Before this step: 294 passed.
  That includes the 82 corpus packages and the negatives, the 10 vectors, the compatibility of all packages with the
  four Engines, the protocol digests, the evaluator errors, the 49 adversarial vectors and the command line of
  `baseline_core.py`. Without the corpus the corpus-dependent tests skip with a warning.
  The first run of the step had 12 failures, none of them in the code under test: 5 `test_boundary` cases because
  module docstrings mentioned the platform by name (reworded), 1 `test_conformance` assertion that expected the
  operation label in a message that has none, and 6 about the goldens that did not exist yet or that were compared
  with the stale copy (above). The second run is the one reported.
- `import bim_core`: 43 public names; no `os.environ`/`getenv`/`parents[`/`fastapi`/`sqlalchemy`/`httpx`/`pydantic` in
  `src`; `git status` clean outside `bim-toolchain/`.
- `ruff check` on `src`, `tools` and `tests`: clean. `git diff --check`: clean.

One test of the first cut was wrong, not the code: `from_document(..., verify=False)` on a document whose
`spec.profile.digest` was altered gives a different `ir_digest`, because `spec.profile` is deliberately part of that
digest (documented in `DIGESTS.md`). The test now asserts this, and a new test recomputes the digest exactly as
`snapshot_problem` does (drop `metadata` and `spec.{instance,dialects,sourceMap}`) over a real compilation.

## Missing
- The rest of `test_bim_v1_language_final.py` (list above) and moving the evaluation code out of `BindingProblem`,
  if wanted (the API would not change).
- OpenBinding consuming `bim_core` as a dependency (shim for `openbinding_gateway.v1`, regenerating pinned digests
  and snapshot contracts): its remote client would call `bim_core.protocol.validate_result` (translating
  `ProtocolError` to `RemoteEngineError`), its routes would translate `ContractError.http_status`, and the
  `meta-router-csp` question (a manifest is missing in the repository) should be settled before regenerating goldens.
- The license decision; creating the remote repository; building and publishing a wheel; a `uv.lock`.

## HTTP service, client and contracts (step 4)

`bim-core` is the same: **no file under `packages/bim-core/src` changed**, so `compilerDigest`, the digests of the
builtin Profile and Dialects and every `irDigest` are those of the previous step. New (all new code, no platform code
copied):

| Where | What |
| --- | --- |
| `packages/bim-service/` | `bim_service`: FastAPI application under `/bim/v1` (`app.py`), operations as plain functions over `bim_core` (`operations.py`), problem+json (`problems.py`), pure-ASGI middleware for context, authentication and the body limit (`middleware.py`), the concurrency gate (`runtime.py`), tokens from a file (`auth.py`), `BimServiceSettings` (`settings.py`), request models and the multipart reader (`models.py`, `wire.py`); `Dockerfile`; `.dockerignore` at the context root |
| `packages/bim-client/` | `bim_client`: `BimPort` (`port.py`), `InProcessBim`, `HttpBim`, the errors and the problem → exception translation, the shared input/output rules (`wire.py`) and the `TypedDict` return types |
| `contracts/` | `openapi/bim-service.v1.json` (generated) and `consumers/openbinding/*.json` (7 fixtures), see `contracts/README.md` |
| `tools/` | `dump_service_openapi.py` (`--check` for CI) and `consumer_fixtures.py` (the demo package and the scripts behind the fixtures) |
| `docs/` | `SERVICE.md`, `CLIENT.md`; this log, `README.md` and `CONTRACT.md` updated |
| tests | `packages/bim-service/tests` (auth, API, limits, OpenAPI, consumer fixtures) and `packages/bim-client/tests` (port, equivalence battery) |

### Decisions and deviations of this step

- **`bim-service` does not depend on `bim-client`, and the glue exists twice.** The Dockerfile installs `bim-core` and
  `bim-service` only; `operations.py` and `InProcessBim` therefore compose the same `bim_core` functions separately.
  The equivalence battery is what keeps the two in step (it found no difference).
- **`validate` and `validate-result` report findings as data** (`200` with `valid: false`); `compile` reports the same
  findings as `422 compile_error`. A package that cannot be read at all is `422` in both. `/evaluate` always takes a list
  of bindings (`onError` = `raise` or `collect`); the port has `evaluate` (one) and `evaluate_many`. `/compatibility` and
  `/optimization/resolve` take the Engine manifest and a mode *id* (validated with `resolve_engine_mode`, so a manifest
  with findings is `engine_contract_invalid`).
- **Strict JSON on the wire, in both implementations.** `bim_core.validate_result` accepts a NaN by default and
  `reevaluate_result` passes `provenance` through untouched (`CONTRACT.md`); through the port a NaN or an infinity is
  `ContractError("request_invalid")` and the service validates with `finite=True`. So the adversarial vectors of
  `golden/vectors_extra.json` that contain one are *refused identically* by both implementations instead of compared with
  the golden (the others are compared with it).
- **Anonymous mode is stricter than asked.** `BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1` only applies when no tokens file is
  configured; a configured file that is invalid stops the start even with the flag (a typo must not open the service).
- **No `python-multipart`.** It is not in the gateway environment (`uv.lock`), and Starlette's form parsing needs it, so
  `multipart/form-data` is read by a small strict reader (`wire.parse_multipart`: parts `package` and
  `registeredResources`, no nesting, no transfer encodings).
- **Authentication and the size limit are pure ASGI middleware**, outside the framework's body parsing, so that 401 and
  413 are decided before the body is read (FastAPI would read it first and turns an exception raised while reading into a 400).
- **Time budgets release the request, not the thread** (`SERVICE.md`); the slot and the tenant's share come back when the
  thread ends.
- **`bim-core` tests: helpers moved to `core_support.py`.** The three suites run in one pytest session (one registered
  check), and the core tests did `from conftest import ...`, which only works while there is a single module called
  `conftest`. The helpers moved unchanged to `tests/core_support.py`, `conftest.py` keeps the fixture, and the 15 test modules
  import from `core_support`. Nothing else in them changed.
- **Fixtures and the OpenAPI document were written by the tests.** The worker cannot run tools directly, so, as for the
  goldens, the first run of `test_the_fixtures_exist_or_are_created` and `test_the_committed_openapi_is_the_generated_one`
  created the files and failed on purpose; the next run compared. They were then read and the expectations that can be
  stated in words (which Engine mode is compatible, how a discrepancy is repaired, ...) are asserted by tests.
- **Fixtures never embed an IR** (`$ref` to an earlier step) and record normalized answers, so they survive a change of
  `compilerDigest` (`contracts/README.md`).

### A finding about `bim-core`, not changed here

The IR compiled from a **directory** and from the **`.bim.zip` made from it** can differ in the *order* of the eligibility
lists. `to_zip()` writes JSON in canonical form (sorted keys) and the eligible candidates of a task are listed in the order
of the catalog's keys, so a catalog whose candidates are not in alphabetical order gives another `irDigest` and semantic
digest once zipped. This happens in the corpus (`05_multi_obj`, `05_single_obj_various`); `golden/bim_baseline` records the
directory form. `test_equivalence.py::test_a_package_and_its_directory_differ_only_in_the_order_of_the_eligibility_lists`
shows that sorting the eligibility lists removes every difference. A comment in `InstancePackage.digest` says a
pretty-printed directory and its ZIP "must have the same resource, Instance and IR digests"; for the IR that is not so
(the resource and Instance digests were not compared here). Not fixed: it would change `irDigest` (a MAJOR change
by the rules of `DIGESTS.md`), and it does not affect the production path (the platform stores and compiles the ZIP). A
decision for the owner: canonicalize the order of candidates when lowering, or document it.

### Verification status

Run in the worker with the registered checks (`uv sync --locked --extra test`; `PYTHONPATH` on the three `src`
directories; FastAPI 0.141.1, Starlette 1.3.1, pydantic 2.13.4, httpx 0.28.1):

- `pytest packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests`: **1217 passed, 1 xfailed (strict,
  ported as is), 0 failed, 0 skipped** in about 48 s, with the corpus present. The previous step had 1014 passed, 1 xfailed:
  **203 new tests** (service and client). Without the corpus the corpus-dependent tests skip with a warning.
- `tools/dump_service_openapi.py --check`: up to date. `ruff check ../bim-toolchain`: clean. `git diff --check`: clean.
- No import of `openbinding_gateway` in any new file (`grep` over `bim-toolchain`; the only hits are the strings of the
  boundary tests and the prose of this log). The registered isolation check runs `cd ..` from `openbinding-gateway` and
  searched a directory that does not exist from there (`grep: bim-toolchain: No such file or directory`, and `git`
  refused the repository for ownership), so it passed without testing anything; the isolation was checked with a search of
  the tree instead. Everything written is under `bim-toolchain/`.
- Runs that failed on the way, none because of a defect of `bim_core`: the first run had 15 collection errors (the
  `conftest` name collision above); the second had the two files created on purpose, a wrong expectation of mine about the
  demo (two eligible candidates per task, not one) and the two corpus packages of the finding above.

### Not verified

- **The Dockerfile has not been built** and the image has not been run. `pip install` of the two local projects, the
  `groupadd`/`useradd` of `python:3.11-slim`, the `HEALTHCHECK` and `uvicorn --factory` are as written, not as observed.
- **The service has only been run through ASGI** (`httpx.ASGITransport`, `TestClient`, and direct ASGI calls for the body
  limit), never under `uvicorn`/`h11`: keep-alive and `Connection: close` after a 413, `--workers`, graceful shutdown and
  the behaviour with real slow clients are untested. Starlette 1.3 warns that `TestClient` with `httpx` is deprecated
  (it asks for `httpx2`); the tests use it for `HttpBim` and for the ASGI mount.
- **No load or memory measurement.** A 32 MiB body is read whole into memory (JSON with base64 holds roughly three copies
  of a package while it is decoded); the defaults of the limits are reasoned, not measured. The concurrency gate is tested
  with blocked threads, not with real compilations under load.
- **Multi-process behaviour**: the limits are per process; nothing shares them.
- **A token file that changes while the service runs** is not re-read by the service (only by `HttpBim`).
- **OpenBinding does not use any of this yet.** No file outside `bim-toolchain/` changed.

### Missing (as of step 4; packaging, CI and release are done in step 5 below)

- An OpenBinding adapter for `BimPort` (configuration choosing `InProcessBim` or `HttpBim`, mapping `BimError` and
  `BimServiceError` to its HTTP errors) and a replay of `contracts/consumers/openbinding/` from OpenBinding's side.
- Building the image; a `uv.lock` per package; publishing wheels; the remote repository; the license decision.
- A decision on the eligibility order (above).

## Packaging, clean-environment verification, CI and release (step 5)

> **Historical.** This section records step 5 as it was. Superseded by "Step 6" at the end of this log: the license is now
> CC-BY-4.0 (a `license` field exists), the packaging tests no longer skip for lack of `dist/` (they build it), the
> `compilerDigest` of the wheels is `sha256-ccc55839…` (the figure below, `sha256-18a20c7d…`, is that of the code before the
> normalization of the IR order), and the test counts and byte sizes below are those of that day.

Until this step no wheel had been built and nothing had been installed outside the gateway environment. No file under
any `src/` directory changed (so `compilerDigest` is the one of step 4 and the digest definition was not touched).

### What changed

| Where | What |
| --- | --- |
| `packages/*/pyproject.toml` | *Historical (step 5):* `license-files = ["NOTICE.md"]` (no `license` field); **now** `license = "CC-BY-4.0"` and `license-files = ["LICENSE", "NOTICE.md"]`. Neutral classifiers plus `Private :: Do Not Upload`, `hatchling>=1.27`, an explicit sdist (`/src`, readme, notice, pyproject), `[tool.uv.sources] … workspace = true` in the two dependents |
| `packages/*/NOTICE.md` | byte copies of the root `NOTICE.md` (hatchling reads only below the project directory); a test keeps them equal (*now* `packages/*/LICENSE` too, copies of the root `LICENSE`) |
| `packages/bim-{service,client}/src/*/py.typed` | new (only `bim_core` had one) |
| `pyproject.toml`, `.gitignore` | uv workspace at the root (no project); `dist/`, `.venv/`, `.verify-venv/`, `__pycache__/` ignored |
| `packages/bim-service/Dockerfile`, `.dockerignore` | the Dockerfile copies `NOTICE.md` of the two packages it installs; `.dockerignore` excludes `.github`, `dist` and the venvs. Still not built |
| `packages/bim-core/tests/fixtures/example-package/` | the demo package as files, plus `binding.json` |
| `tools/toolchain_json.py`, `tools/smoke_installed.py` | the release descriptor and the `python -I` smoke test |
| `tools/test_packaging_metadata.py`, `test_built_artifacts.py`, `test_toolchain_json.py`, `test_workflows.py`, `packaging_support.py` | 62 new tests |
| `packages/bim-core/tests/test_boundary.py` | *historical:* one assertion `license-files == ["NOTICE.md"]` instead of "no license-files", `license` absent; **now** `license == "CC-BY-4.0"` and `license-files == ["LICENSE", "NOTICE.md"]` |
| `.github/workflows/ci.yml`, `release.yml` | lint, tests (3.11/3.12 × 3 packages), golden/corpus (warns when the corpus is absent), OpenAPI and consumer-contract checks, build, clean install + isolated smoke; the release builds, verifies, writes `toolchain.json` and `SHA256SUMS` and creates a *draft* release; no PyPI, no secrets, `contents: read` (write only in the draft job); actions by major version (security TODO) |
| `docs/PACKAGING.md`, `docs/RELEASING.md`, `CHANGELOG.md`, `README.md` | new / updated |

### Results (actual runs, Python 3.11, registered checks)

- `uv build` of the three packages: **3 wheels and 3 sdists** built (`bim_core` 122 520 B wheel / 104 296 B sdist,
  `bim_service` 25 611 / 20 696, `bim_client` 17 794 / 13 353). Built twice; same sizes both times. `uv build` builds the
  wheel from the sdist.
- Clean venv (`python3 -m venv`, `pip install dist/*.whl`, no gateway environment): installed without error; the
  dependencies came from an index (network available). `python -I` imports the three packages and lists the resources.
- `tools/smoke_installed.py` under `python -I` with an empty environment (run by `test_built_artifacts.py`): imports,
  `importlib.resources` listing (12 schemas, engine contract, 5 XSD + README, three `py.typed`), compile, evaluate,
  re-evaluate, validate, service via `TestClient` (`/healthz`, `/capabilities`, `/validate-result`, `/compile`) and
  `InProcessBim.compile`: passed.
- `compilerDigest`: wheel in the clean venv = source tree (`PYTHONPATH`) =
  `sha256-18a20c7d12fbba1c6b82dde90e6db40ed877959bb82d9a80083da8114c105172`. The package unpacked from the sdist and a
  wheel rebuilt from it give the same value (asserted by tests); so do the service and `InProcessBim` in the venv.
  `toolchain_identity()` (including the Profile and Dialect versions) is identical between wheel and tree.
  **No change to the digest definition was needed.**
- `pytest packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests tools`: **1279 passed, 1 xfailed
  (strict, ported as is), 0 failed, 0 skipped** in about 48 s (step 4: 1217 passed). 62 new tests: 22 on the built
  archives and the clean venv, 26 on the metadata and the example package, 8 on `toolchain.json`, 6 on the workflows. (The tests that need
  `dist/` and `.venv` skip when they are absent; the registered checks build first.)
- `ruff check ../bim-toolchain`: clean. `git diff --check`: clean.

### Decisions and deviations

- **`LICENSE` is not shipped in the wheels** (*historical, superseded: the license was later decided as CC-BY-4.0 and
  `LICENSE` and `NOTICE.md` are both shipped; see step 6*). The task asked for `license-files` pointing at `NOTICE.md`/`LICENSE`;
  only `NOTICE.md` is listed, because a `License-File` entry for the CC BY 4.0 text would read as the code's licence,
  which `NOTICE.md` says is undecided. `THIRD_PARTY_NOTICES.md` is OpenBinding's platform credits and is not shipped
  either. The owner decides with the licence (`RELEASING.md`).
- **Tests are not in the sdists** (they need root-level goldens and fixtures). The "package rebuilt from the sdist"
  is therefore checked by digest and by rebuilding the wheel, not by running the suite from the sdist.
- **hatchling adds `.gitignore` to every sdist**; the test expects it.
- **`example-package/binding.json` sits next to the package files** because a package directory cannot hold undeclared
  entries and this worker could not delete a file it had first placed elsewhere: `fixtures/example-binding.json` is an
  identical, unused leftover and can be deleted. The smoke script and the tests leave `binding.json` out of the package.
- **Check ordering.** `uv run --locked` without `--extra test` (registered check 4) re-syncs the gateway environment and
  removes `pytest`; run check 0 again before check 1. Order used: 2, 3, 4, 0, 1, 5.
- **Not verified:** the workflows on GitHub, the Docker image, `uv sync` in the workspace, Python 3.12, an offline
  install. See `PACKAGING.md`.

### Missing

- The licence decision and holder; the remote repository; pinning actions by SHA; a first tag and release.
- Everything listed under *Missing* of the previous steps.

(Several "not verified" and "missing" items of steps 4 and 5 have been closed since; see the next section, which
supersedes them where it says so.)

## Estado reconciliado

Reconciliation of the "Not verified" / "Missing" lists above with evidence already integrated in the repository. Paths
are relative to the repository root. "Sin verificar" means that no evidence could be cited when this section was
written; it is not a claim that the item is false. This section re-ran no check.

| Item | Estado | Evidencia |
| --- | --- | --- |
| `bim-service` container runs as UID 10001 | Cerrado | `bim-toolchain/packages/bim-service/Dockerfile` (`groupadd`/`useradd` uid 10001, `USER 10001:10001`) |
| `bim-service` `cpus` / `pids_limit` | Cerrado (declarado) | `compose.lab.json`, service `bim-service`: `mem_limit` 256m, `cpus` 1.5, `pids_limit` 256 |
| Gateway runs as UID 10001; Dockerfile stages `base` / `test` / `production`; uv pinned to 0.8.22 | Cerrado | `openbinding-gateway/Dockerfile` (`FROM python:3.11-slim AS base`, `FROM base AS test`, `FROM base AS production`, `COPY --from=ghcr.io/astral-sh/uv:0.8.22`, `USER 10001:10001`) |
| `bim-service` image has been built and run | Sin verificar | no build record found; the header of `bim-toolchain/packages/bim-service/Dockerfile` still says "NOT BUILT" |
| Effect of `cpus` / `pids_limit` under load, container memory (cgroup) limit, OOM behaviour | Pendiente | `docs/qa/BIM_LOAD.md`, "NOT measured" |
| Generic 500 with `correlationId`; hostile inputs answered 4xx | Sin verificar | the described behaviour is not in the files read for this section (no citation); check `bim-toolchain/packages/bim-service/tests/` before relying on it |
| Rotation, saturation and bounded-memory tests (tokens, slots, body limit) | Cerrado (en proceso, ASGI) | `docs/qa/BIM_LOAD.md`; `bim-toolchain/packages/bim-service/tests/test_rotation_and_saturation.py` (20 tests). Memory is measured with `tracemalloc`; no real load test, no uvicorn, no cgroup |
| Per-tenant share keyed by token identity (B5) | Cerrado | `bim-toolchain/CHANGELOG.md`, [Unreleased] / Changed, "Contract change, `bim-service`: the per-tenant concurrency share is keyed by the authenticated identity" |
| Request body decoded and validated in the bounded worker pool (B8-1) | Cerrado | `bim-toolchain/CHANGELOG.md`, [Unreleased] / Changed |
| Optional switch interval and memory budget (B8-2, off by default) | Cerrado | `bim-toolchain/CHANGELOG.md`, [Unreleased] / Added; `docs/SERVICE.md` "Memory budget" |
| Process mode (B8-3) | Pendiente | `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_probe.py` ("Only processes (B8-3) close this"); the GIL stall in thread mode stays a strict `xfail` (`CHANGELOG.md`) |
| RSS measurement inside the container (B8-0) | Pendiente | `docs/qa/BIM_LOAD.md` ("RSS ... was not used", "No real container memory"); `test_analysis_b8_memory.py` uses `tracemalloc` only |
| Raw ZIP equals the directory | Cerrado, 82/82 | `bim-toolchain/packages/bim-core/tests/test_zip_dir_equivalence_corpus.py` (`test_the_raw_zip_is_the_directory`, `EXPECTED_PACKAGES = 82`) |
| Canonical ZIP (`to_zip()`) differs from the directory | Cerrado en 0.2.0: 82/82 equal (was 64 of 82 different); MAJOR change decided by the owner on 2026-10-14 | same test file (all 82 and the permutations are ordinary tests; the 64 are `data/zip_divergent_packages.json`, the packages whose semantic digest moved); `bim-toolchain/CHANGELOG.md` `semantic-change`; `docs/qa/IR_NORMALIZATION.md`; `golden/bim_normalized/zip_equivalence.json` |
| Publishing `javiercavlop/bim-toolchain` | Pendiente: one external step (below) | `docs/RELEASING.md` |
| Licence | *Historical (when this table was written):* not decided. **Now: CC-BY-4.0**, holder javiercavlop (titular del repositorio OpenBinding), see step 6 | `NOTICE.md`, `licenses.json`, `docs/LICENSING.md` |

Precisions to the rows above, read from the tree when this note was written (no check was run for it):

- **B5** is implemented in `bim_service/auth.py` (`Authenticator.identify`): the share is keyed by the tenant bound to the
  authenticated token; `X-BIM-Tenant` is ignored for it. With one configured tenant (the lab) no default per-tenant limit
  applies; the global ceiling is unchanged; the limit is per process.
- **B8**: decode, validate and render run in the bounded pool (B8-1, slot before decoding). In thread mode the GIL still
  lets a large body or CPU-bound work slow the loop: **3 strict `xfail` remain** in
  `packages/bim-service/tests/analysis/test_analysis_b8_probe.py` (CPU-bound operations vs `/healthz`; loop stall while a
  large body is parsed; a timed-out operation keeps its slot until its thread ends). Process mode (B8-3) is not done.
- **Zip/directory equivalence (M4-A1, closed by M4-B in 0.2.0)**: the raw ZIP equals the directory for 82/82 and, since
  the owner decided on 2026-10-14 to normalize the order of the sets of the IR (`CHANGELOG.md` `semantic-change`), so
  does the canonical ZIP and any permutation of the JSON members; the 64 strict `xfail` are ordinary tests. The
  `bim-toolchain` CI has never been executed (its nested
  `.github/` is not run by GitHub inside this monorepo, per `docs/qa/analysis/BIM_B5_B8_M4_IR.md`).
- **Gateway side, outside this directory** (`docs/qa/SECURITY_REVIEW.md` has the detail): VIEWER is read-only (MEMBER or
  more for launch, retry, cancel and pareto); stable public errors with `correlationId` (`core/public_errors.py`);
  engine evidence kept before BIM re-evaluation (`job_engine_evidence`, `POST /v1/jobs/{id}/reevaluate`); best-effort
  remote cancel of lost attempts (`jobs/remote_attempts.py`, `cancel_engine_attempts`), only for an Engine that declares
  the capability. The PostgreSQL harness now builds the `test` stage and `seed` has no `user` and no bind; that run has
  not been observed (the last observed 58 passed / 0 skipped used the old root `seed`).
- **Guarantees not claimed**: the queue and the effects on Engines are at-least-once; there is no distributed
  exactly-once execution (`docs/IDEMPOTENCY.md` of the OpenBinding repository). SPACE integration is on hold and untested.
- The row "Generic 500 with `correlationId`" above concerns `bim-service` and stays *Sin verificar*; the gateway has its
  own implementation (`core/public_errors.py`).

The two statements of step 4 that the table supersedes: "No load or memory measurement" is now partial (rotation,
saturation and `tracemalloc` checks exist, nothing at container level), and the per-tenant share is no longer keyed by
`X-BIM-Tenant`.

### The only external step left to publish

*Historical.* When this table was written, publishing `javiercavlop/bim-toolchain` needed, from outside this worktree: (1) written
confirmation of the rights (ownership of the code and the terms of OMG for the vendored BPMN XSDs), and (2) a Git credential
limited to that repository. Nothing was published, no remote was created and no licence was written. Since step 6 the license is
written and the OMG files have their own switch; what is still outside this worktree is in `docs/DELIVERY.md`.

## Step 6: license, OMG XSDs, export, reproducible release check, corpus tier, goldens' metadata

No file under `packages/*/src` changed: `compilerDigest` is `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e`
(the 0.2.0 value of `DIGESTS.md`), nothing that must not move moved (`baseline_core.py --check`: 82 packages, 0 differences).
Details per topic are in `CHANGELOG.md` ([Unreleased]), `docs/LICENSING.md`, `docs/OMG_XSD_RIGHTS.md`, `docs/GOLDEN_METADATA.md`,
`docs/DELIVERY.md` and `docs/PACKAGING.md`; this section is the record of what was run.

### What was decided (by the owner, for this step) and how it was done

- **The corpus is not copied.** The 82 packages come from datasets whose licenses could not be verified. The tests that read it carry
  the marker `openbinding_corpus`, found by static analysis of the tests (`tools/corpus_tier.py`), and a guard test runs the rest with an
  empty corpus and fails on a skip or a failure. `golden/synthetic/corpus.json` is a golden of this repository's own packages.
- **SPDX in a manifest** (`licenses.json`) and in `pyproject.toml`, not in each `.py` (it would change `compilerDigest`).
- **Action pins:** markers, a test, and the exact list; no SHA invented (no network to GitHub).
- **Regeneration of the goldens' metadata:** a tool that verifies before it writes (`tools/regen_normalized_metadata.py`).

### Findings

- The five OMG XSD files contain **no** copyright or license text and no XML comment at all (read from the bytes). The controller's
  findings name two of them; the vendored README and the previous `NOTICE.md` claimed that the notices were preserved, which is not true of
  these bytes. State: not demonstrated; the export blocks them by default.
- The `compilerDigest` registered in `golden/bim_normalized/corpus.json` (`sha256-749170b5…`) was not the one of the toolchain (`sha256-ccc55839…`);
  now refreshed, 165 lines, nothing else changed.
- Builds are reproducible: two builds in two directories gave identical bytes for all six artifacts.

### Results (actual runs of the registered checks, Python 3.11.2, `uv 0.8.14`, hatchling 1.32.4)

| Check | Result |
| --- | --- |
| 0, `regen_normalized_metadata.py --write` | ok at the first run: golden and the gateway's copy rewritten (`9322bc09…` → `6f60c4fa…`), comparison written, `golden/synthetic/corpus.json` created, table of the XSD inventory generated; `git diff --stat`: the two `corpus.json`, 330 lines each |
| 1, `verify_release.py` | **failed at the first run** (my tool read the last line of standard output and error together and took a warning for the smoke report; fixed to read standard output alone); second run: ok, six artifacts identical in both builds (hashes in `DELIVERY.md`), `compilerDigest` equal in wheel, tree, sdist, installation and service, OpenAPI and consumer fixtures up to date, `baseline_core.py --check` 82 packages 0 differences, `toolchain.json` of the wheels equal to the tree's except the `runtime` versions (lxml 6.1.3.0 in the clean venv, 6.1.1.0 in the tree environment) |
| 2, full pytest, no skip by build or corpus | **first run: 2277 passed, 10 failed**, 0 skipped: the fixture tree of `test_export_repo.py` had a `packages/bim-core` directory with no notice (nine tests) and one assertion assumed it ran in the source tree, not in an exported copy (that one also made the guard and the whole-tree export test fail, because they run the suite on copies). Fixed in the tests, not in the tools. **Second run: 2287 passed, 3 xfailed (strict), 0 failed, 0 skipped** (end of step 5: 1279 passed, 1 xfailed) |
| 3, `--check` of baseline, metadata, OpenAPI, consumer fixtures, XSD inventory | ok: `BIM baseline check: 82 packages, 0 differences`; `toolchain metadata check: … 0 problems`; `bim-service.v1.json is up to date`; `xsd inventory: 0 problems; cleared=False` |
| 4, gateway tests of the consumer side | 402 passed, 2 skipped: the two are the gateway's own tests marked slow (`BIM_BASELINE_FULL=1`), not a build or corpus skip |
| 5, scope | ok: nothing outside `bim-toolchain/` and `openbinding-gateway/tests/golden/`, nothing in `bim_core/src` or the frozen goldens |

The documents were edited after these runs (the figures above are those of the runs); the report of the task says which checks were repeated on the final state.

### Not verified

- GitHub: the workflows (also the exported ones), the first run of CI, the pins to SHAs; the export on macOS; `gh repo create` and the push.
- Python 3.12; the Docker image of `bim-service`; `ruff` (not a registered check); an install without a network (the venv is installed from
  the uv cache first and from the network if that fails; which served was not recorded).
- The download of the XSDs from omg.org (tested with a stand-in); the terms of OMG, which nobody here has read.
- Legal questions about CC BY 4.0 for software (recorded as a risk, not decided) and the legal name of the holder.
- `packages/*/README.md` still say the license is undecided; they were not among the files this step could change.

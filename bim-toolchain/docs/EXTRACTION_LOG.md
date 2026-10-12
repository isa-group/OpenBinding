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
   `py.typed`, version 0.1.0. No license is declared: `NOTICE.md` says the decision is pending.
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

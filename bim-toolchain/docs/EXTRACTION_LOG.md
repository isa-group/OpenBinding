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
| `test_bim_v1_language_final` | **not migrated** | see below |
| `test_v1_canonical`, `test_complete_bpmn_json_regression` | copied by the bootstrap | — |

`test_bim_v1_language_final.py` (1961 lines) was left for the next task. About two thirds of it only needs `bim_core`
(helpers `envelope`/`base_package`/`package`, multi-resource identity, CEL span diagnostics, duplicate-resource
diagnostics, BindingProblem schema closure, product aggregation and domains, normalization/clamp, constraint
semantics, installed Profile/Dialect framework, adapter and dialect installation, registered resources, intervals,
placement, BPMN lowering, contextual aliases) and can be ported mechanically by importing from `bim_core` and its
`compiler` module. Items that need the platform: `_resolve_execution_optimization` (route; the two tests using it),
`analyze_neighborhood` (analysis, two tests), and `test_schema_root_prefers_the_deployment_configuration`
(`SCHEMAS_DIR`, which `bim_core` deliberately no longer reads: obsolete, replace by the `schema_root()` test in
`test_public_surface.py`). `DEMO`-based tests there need `BIM_CORPUS_ROOT`.

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
- The evaluator keeps raising `ValueError` for invalid bindings; the golden negatives record `ValueError`. Moving
  them to `EvaluationError` (a `ValueError` subclass) is deferred, together with the protocol work.
- The platform's "semantic digest" check is exposed as `ir_digest` to avoid a clash with the baseline's semantic
  digest, which also drops `spec.profile`. See `DIGESTS.md`.
- `from_document` also validates the document against the installed `BindingProblem` schema, which the platform
  did not do when reading a snapshot.
- `compiler_bundle_digest()` is memoised (`lru_cache`); `toolchain.bundle_digest(root)` is the uncached function
  the tests use to show that adding a file changes the digest.
- The BPMN XSD bundle is read from a real directory (`as_file`), so zip imports of the package are unsupported.
- The full corpus comparison is the default in `test_baseline_equivalence.py`; `BIM_BASELINE_SAMPLE_ONLY=1` runs
  only the ten-package sample (OpenBinding's own test did the reverse).

## Verification status

Run in the worker with `uv sync --locked --extra test` in `openbinding-gateway` (only to get pytest and ruff) and
`PYTHONPATH=../bim-toolchain/packages/bim-core/src`:

- `pytest packages/bim-core/tests`: **294 passed, 0 failed, 0 skipped** in about 14 s, with the corpus present
  (`BIM_CORPUS_ROOT` defaults to the repository root). That includes the full comparison of the 82 corpus
  packages against `golden/bim_baseline/corpus.json` and of the negatives against `negatives.json`, so
  `BIM_BASELINE_SAMPLE_ONLY` is not needed in the normal suite; it stays available as an opt-out. Without the corpus,
  the corpus-dependent tests skip with a warning (those in `test_baseline_equivalence.py`, `test_v1_language.py`,
  `test_b5_*`, `test_b8_*`, `test_complete_bpmn_*`).
- `import bim_core`: 30 public names, no environment access, no `os.environ`/`getenv`/`parents[` in `src`.
- `ruff check` on `src`, `tools` and `tests`: clean. `git diff --check`: clean.

One test of the previous attempt was wrong, not the code: `from_document(..., verify=False)` on a document whose
`spec.profile.digest` was altered gives a different `ir_digest`, because `spec.profile` is deliberately part of that
digest (documented in `DIGESTS.md`). The test now asserts this, and a new test recomputes the digest exactly as
`snapshot_problem` does (drop `metadata` and `spec.{instance,dialects,sourceMap}`) over a real compilation.

## Missing
- Next task: evaluation and re-evaluation (`vectors.json`), the engine protocol (`protocol.json`, `ProtocolError`),
  mode compatibility (`compat.json`, `services/engines.py::mode_compatibility`/`ir_features`), the service and the
  client; plus migrating `test_bim_v1_language_final` (above) and the platform-dependent halves listed in the table.
- OpenBinding consuming `bim_core` as a dependency (shim for `openbinding_gateway.v1`, regenerating pinned digests
  and snapshot contracts).
- The license decision; creating the remote repository; building and publishing a wheel; a `uv.lock`.

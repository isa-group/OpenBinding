# BIM core

`bim-core` is the pure BIM language implementation (package loader, canonical JSON, expression evaluator, Instance compiler, vendored OMG BPMN 2.0.2 XSDs and the BIM schemas), packaged to be installed without the OpenBinding platform. Its packaging lives in [`packages/bim-core`](../packages/bim-core/pyproject.toml); see its [README](../packages/bim-core/README.md) for the intended API.

## Boundary

**Core** (installed as `bim_core`):

- `openbinding-gateway/src/openbinding_gateway/v1/{__init__,canonical,package,expressions,compiler}.py`
- `openbinding-gateway/src/openbinding_gateway/v1/vendor/omg/bpmn/2.0.2/*`
- `schemas/bim/v1/*.schema.json`, `schemas/bim/v1/manifests/*.json`, `schemas/engine-contract.openapi.yaml`

Core modules may import only the standard library, `jsonschema`, `lxml` and each other (one-level relative imports). `__init__.py` imports `.compiler` and `.package` only.

**Platform** (stays in OpenBinding, never imported by the core): accounts, organizations and API keys; projects; pricing and metering; persisted snapshots and the artifact library; engine registries and registrations; the job queue; studies and reports; the resolver; adaptive routing; the HTTP generator; the gateway routes. In the `v1` directory, `archive.py`, `archive_geometry.py`, `analysis.py` and `remote.py` are platform code (pydantic, httpx, ...) and are excluded from the wheel.

`openbinding-gateway/tests/test_bim_core_boundary.py` runs in the normal suite. It checks the import rule with `ast` (including imports inside functions and dynamic imports), that `packages/bim-core/pyproject.toml` is valid TOML with only `jsonschema` and `lxml` as dependencies, that every packaged file exists and that the lists are complete, and that compiling `examples/demo/01_simple_seq` twice gives the same digest and `compiler_bundle_digest()` is stable. It pins no literal digest.

## Why extraction is by packaging

The core is about 4800 lines in `compiler.py` alone. Its bytes feed `compiler_bundle_digest()` (a digest of `canonical.py`, `compiler.py`, `expressions.py` and `package.py`), which in turn determines the `compilerDigest`, the SemVer build metadata of the builtin Profile and Dialect releases, and the digests of IR and stored snapshots. Moving or editing a file changes all of them. The first extraction therefore leaves every file where it is and assembles the wheel from those paths (hatch `force-include` for modules, `shared-data` for schemas), so the bytes, and every digest, stay identical.

Hatch applies no excludes to `force-include` entries, so a directory entry for `v1/` would also ship the platform modules. Files are listed one by one instead, and the boundary test keeps the lists in sync with the directories.

## Not verified

No build was run (the authoring environment had no shell). Written from hatch's documented behaviour but not executed:

- `bypass-selection = true` on the wheel target, needed because there is no `bim_core/` directory;
- `force-include` / `shared-data` sources outside the project root through `../..` paths;
- that `shared-data` places `schemas/...` at the environment prefix, so the unchanged `Path(__file__).parents[4] / "schemas" / "bim" / "v1"` fallback in `compiler.py` resolves for `site-packages/bim_core/compiler.py` in a POSIX virtualenv (it does not for `--user`, Windows or system installs; `SCHEMAS_DIR` is the reliable route);
- that no `__pycache__` or other stray file reaches the wheel (hence file lists);
- that an sdist cannot be built (sources are outside the directory); build wheels only;
- that hatchling accepts `license = {text = ...}` without a warning for the installed version.

The first action of whoever has a shell is `uv build --wheel` in `packages/bim-core`, installing it in a clean virtualenv and running `load_package`/`compile_instance` on `examples/demo/01_simple_seq`, comparing `compiler_bundle_digest()` with the gateway's.

## Known blockers for standalone use (not applied here)

1. **`importlib.resources` points at the host package.** `package.py` (`_bpmn_schema`) calls `package_files("openbinding_gateway.v1")`. Installed as `bim_core`, that raises `ModuleNotFoundError` the first time a BPMN document is validated (it is lazy, so plain JSON instances work). Worse, with the gateway also installed it silently reads the gateway's copy, which hides the problem. Fix: `package_files(__package__)` (or `"bim_core"`) together with package data in the wheel.
2. **Schema location.** `compiler.py` reads `SCHEMAS_DIR` or `parents[4]/schemas/bim/v1`; the second only works by the layout accident described above.
3. **Limits from the environment.** `package.py` reads `BIM_MAX_*` at import time.

Changing `package.py` or `compiler.py` changes `compiler_bundle_digest()`. They are deliberately untouched now.

## Requirements for the future contract release

A contract release is allowed to change digests and must be a deliberate, reviewed event:

- Replace the environment reads with injected settings (an explicit object or function arguments for the `BIM_MAX_*` limits and the schema root); the gateway adapts its `SCHEMAS_DIR` and `BIM_MAX_*` configuration to it.
- Ship the schemas and XSDs as package data of `bim_core` and load them with `importlib.resources` relative to `__package__`, removing every `openbinding_gateway` reference (the boundary test already restricts that string to the one known place) and the `parents[4]` lookup.
- Regenerate everything derived from the compiler bytes: `compiler_bundle_digest()`, builtin Profile and Dialect versions (`1.0.0+<base32>`), the digests pinned in examples and fixtures, golden values in tests, the protocol digest pinned by the federated example, and the digests in stored snapshots. State plainly that historical snapshots keep their old exact contracts and need the old toolchain to be recompiled.
- Move the sources into `packages/bim-core/src/bim_core` and keep a shim `openbinding_gateway.v1` re-exporting `bim_core` for one released version, then remove it.
- Decide the license, then update `pyproject.toml`.

## Current consumers

All import `openbinding_gateway.v1.*` and keep working unchanged:

- `experimentation/*` (`qacobench/campaign.py`, `qacobench/preflight.py`, `icws/run_experiments.py`, `icsoc/campaign.py`, `icsoc/generator/validation.py` and their tests);
- `tools/check_bim_corpus.py`, `tools/build_bim_packages.py`, `tools/check_bim_conciseness.py`;
- the gateway itself (routes, persistence, seeds, tests) and `datasets/scripts/transform_*.py`.

## License and publication

The license in `packages/bim-core/pyproject.toml` is a placeholder: `TBD - pending owner decision (repository currently CC BY 4.0)`. No license has been chosen. Creating a separate remote repository, or publishing the package to any index, requires explicit human approval; this work only prepares the in-repository packaging.

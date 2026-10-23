# PR #24: the OMG BPMN XSDs leave Git, every build downloads them verified

Owner decision: CRP `crp-pr24-omg-xsd`, option `remove-verified-download`, condition 3 as corrected. Third attempt, written
from scratch on `feat/platform-integration` at `cc9cee5`. Nothing was committed, pushed or published by this work.

## What was done

| Condition | What |
| --- | --- |
| 1. Automatic, verified download | `bim-toolchain/packages/bim-core/hatch_build.py` (standard library only, outside `src/bim_core`): `download()` reads the five files over https, compares each SHA-256 and writes nothing unless all five match (temporary files + `os.replace`); `ensure()` does nothing if the five are there and verify, otherwise downloads; without network it raises an error with the exact command (`python3 <path>/hatch_build.py --ensure --directory <dir>`, or `python3 tools/xsd_inventory.py --ensure`); runs as a script (`--ensure`); holds the hatchling hook class that runs `ensure()` before every build. |
| | CI: `python3 tools/xsd_inventory.py --ensure` right after every `actions/checkout` of `bim-toolchain/.github/workflows/{ci,release}.yml` (9 checkouts; the `lint` job also runs `--check`); root `.github/workflows/ci.yml`, job `bim-corpus`: `--ensure` and `--check` before the locked sync. `PIN-PENDING` markers kept. |
| | Docker: `COPY hatch_build.py` + `RUN python .../hatch_build.py --ensure` before the install in `openbinding-gateway/Dockerfile`, `bim-toolchain/packages/bim-service/Dockerfile`, `experimentation/qacobench/Dockerfile` and (it also installs bim-core) `experimentation/qacobench/Gateway.Dockerfile`; root `.dockerignore` lets `!bim-toolchain/packages/bim-core/hatch_build.py` through. `compose.lab*.json` and the seed unchanged. |
| | Source installs (pip, editable, `uv sync`, `uv build`): the hook, `[tool.hatch.build.hooks.custom] path = "hatch_build.py"`. Tests: `tools/xsd_session.py` (`pytest_sessionstart`, `pytest_report_header`) imported by `bim-toolchain/conftest.py` and the three package `tests/conftest.py`; `packaging_support.ensure_xsd()` from `ensure_dist()`, `verify_release.py` and the packaging test that compiles the example package. Tools: `experimentation/qacobench/_common.py` ensures the files when it puts the bim-core sources on `sys.path`; `regen_normalized_metadata.py` ensures before writing the table. |
| 2. Same bytes, same place | No `.py` or resource under `src/bim_core` touched (the vendored README included). `bim_core` downloads nothing when used. No threshold or golden touched. `compilerDigest` is therefore unchanged; the packaging tests that compare it (wheel, tree, sdist) ran inside the nested export run, see below. |
| 3. Never in the repository, always in the artifacts | `.gitignore` (root and `bim-toolchain/`) ignore the five paths. `xsd_inventory.py --check` (and `test_xsd_inventory.py`) fail if `git ls-files` lists one or `git check-ignore --no-index` says it is not ignored; silent outside a checkout. `[tool.hatch.build] artifacts = ["src/bim_core/resources/vendor/omg/bpmn/2.0.2/*.xsd"]` and `/hatch_build.py` in the sdist `include`: nothing excludes the files from a wheel, sdist, SDK or image. `packaging_support.xsd_problems()` + `verify_release.py` (`xsd-in-artifacts`) + `test_built_artifacts.py` compare their bytes inside the wheel and the sdist of bim-core with `licenses.json`. |
| 4. Documents | `licenses.json` `present_in_tree: false` (and the wording of `cleared_format` / `redistribution`); `OMG_XSD_RIGHTS.md` rewritten around "How the files arrive" (generated table untouched, rights still NOT DEMONSTRATED, shipping them in artifacts is the owner's decision); the four `NOTICE.md` byte-equal; `THIRD_PARTY_NOTICES.md`, `LICENSING.md`, `PACKAGING.md`, `RELEASING.md`, `DELIVERY.md`, `CHANGELOG.md`, `EXTRACTION_LOG.md` (step 7), `bim-toolchain/README.md`, `bim-core/README.md`, root `README.md`. `DELIVERY.md` (and `PACKAGING.md`, `RELEASING.md`, `CHANGELOG.md`) say the six artifact hashes are out of date and ask for `python3 tools/verify_release.py --skip-corpus`. |

`tools/xsd_inventory.py`: new `--ensure`; `--fetch DIR` delegates to the shared download; `--check` also checks Git; `--write` only with the five present (error otherwise); without the files `--check` requires the generated table to list the digests of `licenses.json`; `present_in_tree` must be `false`.
`tools/export_repo.py`: `--xsd`, `include_xsd`, `drop_xsd`, `patch_workflow` removed; refuses a committed tree that versions the files or whose `licenses.json` lacks `present_in_tree: false`; never copies them; the self-containment test downloads them into its copy (injectable opener).

Tests added or adjusted: `test_xsd_inventory.py`, `test_export_repo.py`, `test_license_metadata.py`, `test_workflows.py`, `test_packaging_metadata.py`, `test_built_artifacts.py`, `test_verify_release.py` and the new `openbinding-gateway/tests/test_omg_xsd_wiring.py` (Dockerfiles, `.dockerignore`, workflows, `.gitignore`). No test uses the real network (opener injected or `hatch_build.urlopen` replaced).

## Registered checks (actual runs, in this worktree)

| Check | Result |
| --- | --- |
| 0, `git rm --cached` of the five XSDs | ok, exit 0, no output (files stay on disk, ignored) |
| 1, `xsd_inventory.py --check` | ok: `xsd inventory: 0 problems; cleared=False` |
| 2, pytest with `uv run --python-preference only-system` (system Python, which has `pidfd_open`) | **first run failed before collecting anything**: `ImportError while loading conftest .../openbinding-gateway/tests/conftest.py: No module named 'pytest_asyncio'` (that conftest imports the gateway and its dependencies and the check's environment has neither). Fixed (see deviations) and re-run: **140 passed, 0 failed, 0 skipped, 0 errors in 232 s** |

Check 2 includes `test_this_tree_exports_and_the_export_passes_the_suite_without_the_corpus`, which exports this tree and runs the suites of `bim-core`, `bim-service`, `bim-client` and `tools/` on a copy where the XSDs were downloaded (injected opener) — so the packaging tests (`ensure_dist`, `uv build` of the three packages, wheel/sdist contents, the sdist rebuilt into a wheel, `compilerDigest` in three forms, smoke test in a clean venv) ran inside that nested session, which reported `selfTest: passed` with no skip.

## Deviations from the brief

- **`openbinding-gateway/tests/conftest.py` changed** (not in the brief). Check 2 puts `test_omg_xsd_wiring.py` in the same session as the toolchain tests, in an environment without the gateway, and that conftest imports `pytest_asyncio` and `openbinding_gateway` at import time. It now detects whether `openbinding_gateway` is importable (`GATEWAY_INSTALLED`); when it is not, the gateway-specific bootstrap and the four autouse fixtures that import it are skipped. When the gateway is installed nothing changes (a missing `pytest_asyncio` still raises). The gateway suite itself was **not** run.
- `experimentation/qacobench/Gateway.Dockerfile` also changed (it installs bim-core; the brief names `Dockerfile` of qacobench only). `experimentation/qacobench/_common.py` and `regen_normalized_metadata.py` got a call to the ensure.
- `bim-toolchain/conftest.py` also appends `packages/*/src` to the end of `sys.path` (as the brief says), so the tests of `tools/` import `bim_core` without `PYTHONPATH`.
- `xsd_session` only acts on sessions whose collected paths are inside `bim-toolchain/`; `BIM_XSD_SESSION=skip` turns it off.
- `docs/DEMO.md` (the lab demo) was not edited: it is outside the file scope. The demo builds the same images, so the download happens in the image build and needs network access there.

## Not verified

- No Docker image was built; the new `COPY`/`RUN` lines are checked as text (`test_omg_xsd_wiring.py`, the existing `test_docker_context.py` and `test_container_hardening.py` logic is untouched by them but those two were not re-run).
- No workflow ran on GitHub; they are parsed as YAML only. The root `ci.yml` and the `bim-corpus` job's `uv sync --locked` building bim-core with the hook were not run.
- The download from omg.org never ran (tests use an injected opener); the `https` request itself, certificates and proxies in an image are untested. The HTTP code path of `hatch_build.urlopen` has only the "only https" refusal tested.
- hatchling's handling of the custom hook and of `artifacts` was exercised only through the nested session of check 2 (builds of the three packages inside the export copy, where the files were already in place, so the hook did nothing there). A build that really has to download in the hook was tested with a stand-in object, not with hatchling.
- `tools/verify_release.py` was not run directly; `DELIVERY.md` hashes were not recomputed (they are out of date, all six artifacts changed).
- The gateway test suite, `lab/` tests, `ruff`, Python 3.12, macOS: not run. Git's behaviour in `--check` was tested with temporary repositories; the repository check passed in this worktree, but if Git had refused to run there (ownership), `--check` would have stayed silent, and I did not confirm that it ran.
- `OMG_XSD_RIGHTS.md` still says NOT DEMONSTRATED; nothing here decides whether the artifacts may carry the files (owner's decision).

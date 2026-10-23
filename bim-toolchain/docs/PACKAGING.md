# Packaging

Three distributions, each a normal `src`-layout project built with `hatchling` (`hatchling>=1.27`, needed for
`license-files`), versioned together (`0.2.0`):

| Distribution | Import | Runtime dependencies | Contents of the wheel |
| --- | --- | --- | --- |
| `bim-core` | `bim_core` | `jsonschema>=4.21,<5`, `lxml>=5.2,<7`, `pyyaml>=6,<7` | the 16 modules, `py.typed`, and all of `bim_core/resources/` (12 BIM v1 JSON Schemas, `engine-contract.openapi.yaml`, the five OMG BPMN 2.0.2 XSDs and their README) |
| `bim-service` | `bim_service` | `bim-core>=0.2,<0.3`, `fastapi>=0.110,<1.0`, `pydantic>=2.0,<3.0`, `uvicorn>=0.27,<1.0` | the modules of the service, `py.typed` |
| `bim-client` | `bim_client` | `bim-core>=0.2,<0.3`, `httpx>=0.27,<1.0` | `BimPort`, `InProcessBim`, `HttpBim`, errors, types, `py.typed` |

Every wheel and sdist also carries `LICENSE` and `NOTICE.md` (`license-files`) and the readme. Test-only extras exist
(`bim-service[test]`, `bim-client[test]`) and are not installed by default.

## Metadata decisions

- **The license is an SPDX expression, `license = "CC-BY-4.0"`** (PEP 639), in each `pyproject.toml`: the wheels and
  sdists carry `License-Expression: CC-BY-4.0` and no free-text `License` field. There is no `License ::` classifier
  (an expression and a license classifier together are refused by the build backend; `hatchling>=1.27` is the first that
  writes PEP 639 metadata). `license-files = ["LICENSE", "NOTICE.md"]` ships the full license text (wheels:
  `*.dist-info/licenses/LICENSE`; sdists: `LICENSE` at the top; metadata: `License-File: LICENSE`) and the notice, which
  states the license, the holder, the attribution and the scope. hatchling only reads files below the project directory, so
  every package keeps a byte copy of the root `LICENSE` (the unchanged text of OpenBinding) and of `NOTICE.md`; tests fail if a
  copy differs from the root file, and `verify_release.py` checks the built archives (`license-files`).
  `THIRD_PARTY_NOTICES.md` is not shipped. The OMG BPMN XSDs inside the wheel of `bim-core` are not
  covered by the license: [`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md), [`LICENSING.md`](LICENSING.md).
- **The five OMG BPMN XSDs are not versioned in Git but are in every artifact.** `packages/bim-core/hatch_build.py` (standard
  library only, outside `src/bim_core`, so `compilerDigest` does not change) is a hatchling build hook
  (`[tool.hatch.build.hooks.custom]`): before every build (wheel, sdist, editable: `pip install`, `pip install -e`, `uv sync`,
  `uv build`) it downloads the files from omg.org over https, compares each SHA-256 with the declared one and writes nothing
  unless all five match; it does nothing if they are there. `[tool.hatch.build] artifacts` lists the five paths so that the
  wheel and the sdist carry them although `.gitignore` ignores them, and the sdist includes `/hatch_build.py` so that
  `uv build` can build the wheel from it. Nothing excludes them from an artifact. Without network the build stops with
  `python3 <path>/hatch_build.py --ensure --directory <dir>`; put the files in place beforehand with
  `python3 tools/xsd_inventory.py --ensure` (which is what the workflows, `tools/xsd_session.py` and
  `packaging_support.ensure_xsd()` do). `verify_release.py` and `test_built_artifacts.py` compare the bytes of the five files
  inside the wheel and the sdist with `licenses.json`. Whether they stay in the artifacts is a decision of the owner
  ([`OMG_XSD_RIGHTS.md`](OMG_XSD_RIGHTS.md)).
- **`NOTICE.md` and `LICENSE` exist four times each**: at the root and in each `packages/*/` directory, because hatchling
  only reads files below the project directory. `tools/test_packaging_metadata.py` and `tools/test_license_metadata.py` fail
  if a copy differs from the root file.
- **Classifiers are neutral** (Python 3 / 3.11 / 3.12, OS independent, `Typing :: Typed`, FastAPI for the service) plus
  `Private :: Do Not Upload`, which makes PyPI refuse the files. Remove it only when publishing is decided.
- **Dependencies between members are version ranges**, never paths: `bim-core>=0.2,<0.3`. A MINOR bump of `bim-core`
  (`0.3.0`) requires widening the range in the other two in the same change (done for `0.2.0`, the normalization of
  the IR order, `CHANGELOG.md`). Before 1.0 the minor number is the one that marks a breaking change.
- **The version is written twice** (`pyproject.toml` and `_version.py`, which becomes `__version__`) and a test fails
  if they differ, or if the three packages differ.
- **The sdist** contains `src/`, `README.md`, `LICENSE`, `NOTICE.md`, `pyproject.toml`, `PKG-INFO` and the `.gitignore` hatchling
  adds (the sdist of `bim-core` also has `hatch_build.py`, the build hook). It does not contain the tests: they read goldens and fixtures that live at the root of the repository, so an
  sdist could not run them.

## Workspace (development)

`pyproject.toml` at the root declares a uv workspace with the three members and `[tool.uv.sources]` with
`workspace = true` for `bim-core` (and `bim-service` for the client's test extra). It declares no project and builds
nothing. The sources are development metadata: they are not part of a built wheel (`Requires-Dist` is the plain range).

```sh
uv sync                      # one environment with the three members editable
uv run pytest packages/bim-core/tests
```

The tests also run without installing anything, with `PYTHONPATH` (see `README.md`); that is what the registered
checks of the extraction use.

## Build

```sh
python3 tools/xsd_inventory.py --ensure      # the OMG XSDs are not in Git; the build hook would download them anyway
rm -rf dist
for p in bim-core bim-service bim-client; do (cd packages/$p && uv build --out-dir ../../dist); done
```

`uv build` makes the sdist first and builds the wheel *from that sdist*, so a successful build already shows that the
sdist is complete. Output in `dist/` (ignored by git): `bim_core-0.2.0{.tar.gz,-py3-none-any.whl}` and the same for
`bim_service` and `bim_client`.

## Verify

`python tools/verify_release.py` does all of the following in one go and prints one JSON summary with the SHA-256 of every
artifact (below); the numbered list is what each part checks.

0. **Build twice, compare**: `tools/verify_release.py` copies the sources to two different directories, runs `uv build` of
   the three packages in each with the same `SOURCE_DATE_EPOCH` (`1767225600`, `packaging_support.SOURCE_DATE_EPOCH`) and
   compares the SHA-256 of the six artifacts. A difference is explained member by member (names, CRC, timestamps, modes,
   the gzip header). The test `test_two_builds_in_two_directories_give_the_same_bytes` does the same for one package.
1. **Open the archives**: `tools/test_built_artifacts.py` checks, for each wheel and sdist, the name, version,
   `Requires-Python`, `Requires-Dist` (no path or URL), `License-Expression: CC-BY-4.0`, no `License ::` classifier,
   `License-File: LICENSE` and `License-File: NOTICE.md` (both equal to the root files), `Private :: Do Not Upload`, `py.typed`, that every source file and every resource is present
   and nothing else (no tests, no bytecode), and that the sdist has the resources too. It builds `dist/` and `.verify-venv`
   itself when they are missing or the sources changed (`packaging_support.ensure_dist`, `ensure_verify_venv`: a
   fingerprint of the sources is kept next to the output); it needs `uv` and **fails**, not skips, without it.
2. **Clean environment, no gateway**:

   ```sh
   python3 -m venv .verify-venv && . .verify-venv/bin/activate
   pip install dist/*.whl
   python -I tools/smoke_installed.py packages/bim-core/tests/fixtures/example-package
   ```

   `-I` ignores `PYTHONPATH` and the working directory. The smoke test refuses to run if `bim_core` is not under
   `site-packages`. It lists the resources with `importlib.resources`, compiles the example package, evaluates a
   binding, re-evaluates an engine answer, validates it, starts the service with `TestClient`, compiles through it and
   through `InProcessBim`, and checks that all report the same `compilerDigest`. `test_built_artifacts.py` runs it
   with an empty environment on the venv it creates (the venv is made with `venv` and the wheels are installed with
   `uv pip install`, first from the uv cache and then, if that fails, from the network).
3. **Digest**: the three `compilerDigest`s below must be equal.

The example package (`packages/bim-core/tests/fixtures/example-package/`) is the demo of `tools/consumer_fixtures.py`
written as files, plus `binding.json` (a binding, not a package entry: the smoke script leaves it out of the
package). A test keeps it equal to the demo.

### `compilerDigest` in the three forms

`compiler_bundle_digest()` covers every `.py` file and everything under `resources/` of the package directory, skipping
`__pycache__` and `*.pyc`; `py.typed`, `*.dist-info` (outside the package directory), `LICENSE` and `NOTICE.md` are not part of it.

Current result, from `tools/verify_release.py` (Python 3.11.2, hatchling 1.32.4, 0.2.0; the check is run by the tool on every
release and the same three forms are asserted by `test_built_artifacts.py`):

| Form | `compilerDigest` |
| --- | --- |
| (a) wheel, unzipped by the installed `bim_core` (`bundle_digest(zipfile.Path(...))`), and the distribution installed in the clean venv, `python -I`, and the service in it | `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e` |
| (b) source tree (`PYTHONPATH=packages/bim-core/src`) | `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e` |
| (c) package unpacked from the sdist | `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e`; a wheel rebuilt from that sdist is asserted equal by `test_the_digest_of_a_wheel_rebuilt_…` |

*Historical:* the extraction (step 5, before the normalization of the IR order) recorded `sha256-18a20c7d12fbba1c6b82dde90e6db40ed877959bb82d9a80083da8114c105172` for the three forms; the
digest changed with `bim_core` (`DIGESTS.md`), not with the way it is packaged.

They are equal, so the definition of the digest was **not** changed: neither `dist-info` nor `__pycache__` was being
counted. The builtin Profile and Dialect versions and the `profiles`/`dialects` of `toolchain_identity()` are equal in
(a) and (b) too (compared in full). The clean venv also gives the same digest in the service (`/bim/v1/compile`) and
through `InProcessBim`.

## toolchain.json

`python tools/toolchain_json.py --output toolchain.json` (or `--check FILE`) describes a release: the versions of the
three packages, `compilerDigest`, `protocolDigest`, the digest of the engine contract, of each of the 12 schemas and
of the vendored XSDs, the identity of the builtin Profile and Dialects, and the versions of Python, `lxml`
(and libxml2), `jsonschema` and `pyyaml` in use. It has no date, path or host, so the same installation always writes
the same bytes. The release workflow generates it from the installed wheels and attaches it to the draft release.

## Consumers (OpenBinding)

OpenBinding must depend on a **released** `bim-core` (and, if it uses HTTP, `bim-client`), pinned to an exact version
or range, installed from the release artifacts or from the private repository by tag. It must not reference a path into
this repository, and the `[tool.uv.sources] workspace = true` entries do not apply to it. A new `compilerDigest`
invalidates every stored IR (`DIGESTS.md`): recompile after upgrading, and replay `contracts/consumers/openbinding/`.

## Reproducible builds

The SHA-256 and sizes of the six artifacts are in the table of [`DELIVERY.md`](DELIVERY.md#4-expected-values), obtained by
two identical builds after `LICENSE` was added to the packages (that change altered all six files; `compilerDigest` is the
same as before). **Those hashes are out of date**: the build hook, the `artifacts` entry and the changed `NOTICE.md` changed
all six artifacts (the `compilerDigest` is the same). Run `python3 tools/verify_release.py --skip-corpus` for the current ones.

`tools/verify_release.py` builds the three packages twice, each time from a fresh copy of the sources in another directory,
with `SOURCE_DATE_EPOCH=1767225600`, and compares the SHA-256 of the six artifacts. In the run recorded in `DELIVERY.md` they
were identical, so nothing had to be corrected (why they are, member timestamps from the epoch and a fixed order, was not
inspected: the comparison is the evidence, and if it ever fails the tool lists which member and which field differ). What
the guarantee covers: the same sources, the same `uv` and the same `hatchling` give the same bytes (the `Generator` of the
wheel is reported in the summary); a different backend version may write other bytes. The artifacts are not signed.

## Not verified

- The release and CI workflows have never run (no remote); `.github/workflows/*.yml` is checked only by
  `tools/test_workflows.py` (parsed as YAML, structure and policy), not by GitHub. That includes the step after every checkout
  that runs `python3 tools/xsd_inventory.py --ensure`.
- Actions are pinned by major version only: every `uses:` is marked `PIN-PENDING`, a test fails on one that is neither marked nor
  pinned to a commit SHA, and `licenses.json` lists exactly which are pending. No SHA was looked up or invented (no network
  to GitHub).
- The wheels were installed by `uv pip install`, first offline (from the uv cache) and then, if that fails, with network
  access to an index; which of the two served in the recorded runs was not recorded, so an offline install is **not**
  claimed.
- `uv sync` / `uv run` inside the workspace were not run (the registered checks use the gateway's own uv project).
  `uv build` of each member did run with the workspace root in place (and in a copy of it) and accepted it.
- Only Python 3.11 was used here; 3.12 is covered by the CI matrix, not run.
- The verified download of the OMG XSDs (`hatch_build.py`, `xsd_inventory.py --ensure` and `--fetch`) is tested with a
  stand-in for the network (digest match, mismatch, https only, no network, nothing written on a failure); the tests never use
  the network. Whether hatchling really runs the hook and includes the ignored files through `artifacts` is exercised by
  `tools/test_built_artifacts.py` and `verify_release.py`, which this change did not run (they are not among its registered
  checks); the download from omg.org itself has never run from this work.
- `ruff` was not run on this change (it is not a registered check).
- The `Dockerfile` was edited to copy `NOTICE.md`; no record of a build was found (sin verificar). It does create and
  use UID/GID 10001 (`USER 10001:10001`), and `compose.lab.json` limits the `bim-service` container to `cpus` 1.5 and
  `pids_limit` 256; the effect of those limits has not been measured (`docs/qa/BIM_LOAD.md`). The gateway image
  (`openbinding-gateway/Dockerfile`: stages `base`/`test`/`production`, uv 0.8.22, UID 10001) is outside this
  directory. See "Estado reconciliado" in `EXTRACTION_LOG.md`.

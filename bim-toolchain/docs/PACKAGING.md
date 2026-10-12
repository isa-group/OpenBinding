# Packaging

Three distributions, each a normal `src`-layout project built with `hatchling` (`hatchling>=1.27`, needed for
`license-files`), versioned together (`0.1.0`):

| Distribution | Import | Runtime dependencies | Contents of the wheel |
| --- | --- | --- | --- |
| `bim-core` | `bim_core` | `jsonschema>=4.21,<5`, `lxml>=5.2,<7`, `pyyaml>=6,<7` | the 16 modules, `py.typed`, and all of `bim_core/resources/` (12 BIM v1 JSON Schemas, `engine-contract.openapi.yaml`, the five OMG BPMN 2.0.2 XSDs and their README) |
| `bim-service` | `bim_service` | `bim-core>=0.1,<0.2`, `fastapi>=0.110,<1.0`, `pydantic>=2.0,<3.0`, `uvicorn>=0.27,<1.0` | the modules of the service, `py.typed` |
| `bim-client` | `bim_client` | `bim-core>=0.1,<0.2`, `httpx>=0.27,<1.0` | `BimPort`, `InProcessBim`, `HttpBim`, errors, types, `py.typed` |

Every wheel and sdist also carries `NOTICE.md` (`license-files`) and the readme. Test-only extras exist
(`bim-service[test]`, `bim-client[test]`) and are not installed by default.

## Metadata decisions

- **No `license` field, no `License ::` classifier.** The licence is pending (`NOTICE.md`). `license-files` ships
  `NOTICE.md`, which says so, and which also covers the OMG BPMN schemas. `LICENSE` (CC BY 4.0, copied from
  OpenBinding) and `THIRD_PARTY_NOTICES.md` (OpenBinding's platform credits) are **not** shipped in the distributions:
  a `License-File` entry for the CC BY text would read as the licence of the code, which it is not. Decide this with the
  licence (see `RELEASING.md`).
- **`NOTICE.md` exists four times**: at the root and in each `packages/*/` directory, because hatchling only reads
  files below the project directory. `tools/test_packaging_metadata.py` fails if a copy differs from the root file.
- **Classifiers are neutral** (Python 3 / 3.11 / 3.12, OS independent, `Typing :: Typed`, FastAPI for the service) plus
  `Private :: Do Not Upload`, which makes PyPI refuse the files. Remove it only when publishing is decided.
- **Dependencies between members are version ranges**, never paths: `bim-core>=0.1,<0.2`. A MINOR bump of `bim-core`
  (`0.2.0`) requires widening the range in the other two in the same change.
- **The version is written twice** (`pyproject.toml` and `_version.py`, which becomes `__version__`) and a test fails
  if they differ, or if the three packages differ.
- **The sdist** contains `src/`, `README.md`, `NOTICE.md`, `pyproject.toml`, `PKG-INFO` and the `.gitignore` hatchling
  adds. It does not contain the tests: they read goldens and fixtures that live at the root of the repository, so an
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
rm -rf dist
for p in bim-core bim-service bim-client; do (cd packages/$p && uv build --out-dir ../../dist); done
```

`uv build` makes the sdist first and builds the wheel *from that sdist*, so a successful build already shows that the
sdist is complete. Output in `dist/` (ignored by git): `bim_core-0.1.0{.tar.gz,-py3-none-any.whl}` and the same for
`bim_service` and `bim_client`.

## Verify

1. **Open the archives**: `tools/test_built_artifacts.py` checks, for each wheel and sdist, the name, version,
   `Requires-Python`, `Requires-Dist` (no path or URL), absence of `License`, `License-File: NOTICE.md`,
   `py.typed`, that every source file and every resource is present and nothing else (no tests, no bytecode), and
   that the sdist has the resources too.
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
   with an empty environment when `.verify-venv` exists.
3. **Digest**: the three `compilerDigest`s below must be equal.

The example package (`packages/bim-core/tests/fixtures/example-package/`) is the demo of `tools/consumer_fixtures.py`
written as files, plus `binding.json` (a binding, not a package entry: the smoke script leaves it out of the
package). A test keeps it equal to the demo.

### `compilerDigest` in the three forms

`compiler_bundle_digest()` covers every `.py` file and everything under `resources/` of the package directory, skipping
`__pycache__` and `*.pyc`; `py.typed`, `*.dist-info` (outside the package directory) and `NOTICE.md` are not part of it.
Result of the extraction (Python 3.11):

| Form | `compilerDigest` |
| --- | --- |
| (a) wheel installed in the clean venv, `python -I` | `sha256-18a20c7d12fbba1c6b82dde90e6db40ed877959bb82d9a80083da8114c105172` |
| (b) source tree (`PYTHONPATH=packages/bim-core/src`) | `sha256-18a20c7d12fbba1c6b82dde90e6db40ed877959bb82d9a80083da8114c105172` |
| (c) package unpacked from the sdist, and a wheel rebuilt from that sdist | equal to (b), asserted by `test_the_digest_of_the_unpacked_sdist_…` and `test_the_digest_of_a_wheel_rebuilt_…` |

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

## Not verified

- The release and CI workflows have never run (no remote); `.github/workflows/*.yml` is checked only by
  `tools/test_workflows.py` (parsed as YAML, structure and policy), not by GitHub.
- Actions are pinned by major version only (security TODO in both files).
- The wheels were installed with network access to an index for the third-party dependencies; an offline install was
  not needed and not tried.
- `uv sync` / `uv run` inside the workspace were not run (the registered checks use the gateway's own uv project).
  `uv build` of each member did run with the workspace root in place and accepted it.
- Only Python 3.11 was used here; 3.12 is covered by the CI matrix, not run.
- The `Dockerfile` was edited to copy `NOTICE.md` and has still not been built.

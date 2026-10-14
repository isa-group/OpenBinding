# bim-toolchain

The BIM toolchain, prepared as the root of its own (future, private) repository.

**BIM here is a service-composition and binding language**: a package of JSON (and BPMN) documents describes an
application workflow, the candidate services that can fill each task, constraints and an optimization, and the
compiler lowers it to a canonical, digest-addressed `BindingProblem` that solver engines consume. It has nothing to
do with Building Information Modeling.

Three pieces live here, and OpenBinding consumes BIM through a port with two implementations:

* **`bim-core`**: the language, compiler, evaluator, re-evaluation, engine protocol and compatibility, as a library;
* **`bim-service`**: a stateless HTTP API over it (`/bim/v1`), with its own limits and service-to-service authentication;
* **`bim-client`**: `BimPort` and its two implementations, `InProcessBim` (calls `bim-core`) and `HttpBim` (calls
  `bim-service`), which return the same values and raise the same errors.

For now the code was copied, not moved; see [`docs/EXTRACTION_LOG.md`](docs/EXTRACTION_LOG.md).

## Layout

```
bim-toolchain/
  pyproject.toml                    uv workspace of the three packages (builds nothing)
  .gitignore                        dist/, .venv/, .verify-venv/, __pycache__
  .github/workflows/                ci.yml, release.yml (for the future repository; never run yet)
  CHANGELOG.md                      SemVer; says what changed in the digests
  LICENSE                           CC BY 4.0 (OpenBinding's, unchanged)
  THIRD_PARTY_NOTICES.md            OpenBinding's credits, unchanged, plus a section on what this repository adds
  NOTICE.md                         the license (CC-BY-4.0), holder, attribution and scope; OMG BPMN schemas: rights not demonstrated
  licenses.json                     the manifest: SPDX identifier, scope, OMG XSD clearance switch, pending action pins
  packages/bim-core/
    pyproject.toml, README.md, LICENSE and NOTICE.md (copies of the root ones, shipped as license-files)
    src/bim_core/                   the package (src layout, py.typed)
      resources/                    JSON Schemas, engine contract, vendored OMG BPMN 2.0.2 XSDs
    tests/                          tests/fixtures/manifests: Engine manifests; fixtures/example-package: a small BIM package
  packages/bim-service/
    pyproject.toml, README.md, LICENSE, NOTICE.md, Dockerfile
    src/bim_service/                FastAPI application, middleware, limits, authentication, operations
    tests/
  packages/bim-client/
    pyproject.toml, README.md, LICENSE, NOTICE.md
    src/bim_client/                 BimPort, InProcessBim, HttpBim, errors, types
    tests/                          includes the equivalence battery
  contracts/
    openapi/bim-service.v1.json     the OpenAPI document of the service (generated)
    consumers/openbinding/*.json    the interactions OpenBinding has with BIM, with the responses it expects
  golden/bim_baseline/              digests and numeric summaries recorded in OpenBinding (0.1.x, frozen)
  golden/bim_normalized/            the baseline of the normalized IR (0.2.0); only its `toolchain` members are refreshed
  golden/synthetic/                 the golden that needs no corpus (synthetic packages and the example package)
  golden/bim_core/                  goldens that have no OpenBinding original (see docs/DIGESTS.md)
  golden/vectors_extra.json         adversarial re-evaluation / result-validation vectors
  golden/toolchain_metadata_comparison.json   before/after of the last refresh of the `toolchain` members
  tools/baseline_core.py            recomputes the baseline with bim_core only
  tools/regen_normalized_metadata.py  refreshes the informative `toolchain` members of the goldens (docs/GOLDEN_METADATA.md)
  tools/dump_service_openapi.py     writes / checks contracts/openapi/bim-service.v1.json
  tools/consumer_fixtures.py        the demo package and the scripts behind contracts/consumers/
  tools/toolchain_json.py           writes / checks toolchain.json (versions, digests, runtime versions)
  tools/smoke_installed.py          smoke test of installed wheels, run with python -I in a clean venv
  tools/verify_release.py           two reproducible builds, clean venv, smoke test, digests, contracts, one JSON summary
  tools/export_repo.py              exports this directory as a new repository, one commit (docs/DELIVERY.md)
  tools/xsd_inventory.py            inventory of the vendored OMG XSDs, read from their bytes; verified download
  tools/corpus_tier.py              marks the tests that read the OpenBinding corpus (-m 'not openbinding_corpus')
  tools/test_*.py, packaging_support.py   packaging, license, export and release tests; workflows
  docs/                             CONTRACT.md, DIGESTS.md, SERVICE.md, CLIENT.md, PACKAGING.md, RELEASING.md, EXTRACTION_LOG.md,
                                    LICENSING.md, OMG_XSD_RIGHTS.md, GOLDEN_METADATA.md, DELIVERY.md
```

## Building and installing

```sh
for p in bim-core bim-service bim-client; do (cd packages/$p && uv build --out-dir ../../dist); done   # wheel + sdist
python3 -m venv .verify-venv && .verify-venv/bin/pip install dist/*.whl
.verify-venv/bin/python -I tools/smoke_installed.py packages/bim-core/tests/fixtures/example-package
```

See [`docs/PACKAGING.md`](docs/PACKAGING.md) (what each wheel contains, how the digest is compared between the wheel,
the source tree and the sdist, how consumers depend on a release) and [`docs/RELEASING.md`](docs/RELEASING.md)
(SemVer and digest rules, checklist, rollback, extracting this directory into its own repository, what to decide first).

## Running the tests

They need `jsonschema`, `lxml`, `pyyaml`, `fastapi`, `pydantic`, `httpx` and `pytest` (Python ≥ 3.11). The three packages
are not installed, they are put on the path, and the three suites run in one session:

```sh
cd bim-toolchain
PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src \
  python -m pytest --rootdir=. packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests tools
```

The tests in `tools/` that open the built archives or use the clean venv build what they need (`dist/`, `.verify-venv`,
rebuilt when the sources change) with `uv`; a missing `uv` is an error, not a skip.

The corpus of BIM packages is not part of this directory. The tests that read it are marked `openbinding_corpus`
(found by reading the tests, `tools/corpus_tier.py`); they look under `BIM_CORPUS_ROOT` (default: the directory that
contains `bim-toolchain/`). In OpenBinding the whole suite runs. In a repository exported from it, which has no corpus:

```sh
python -m pytest --rootdir=. -m 'not openbinding_corpus' -rs packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests tools
```

runs everything else with no skip (a guard test runs exactly that against an empty corpus and fails on a skip or a failure),
and `golden/synthetic/corpus.json` is the golden it compares with. By default the equivalence test compares all packages
with the goldens; `BIM_BASELINE_SAMPLE_ONLY=1` limits it to ten.

`python tools/verify_release.py` builds the three distributions twice in two directories and compares their SHA-256,
installs the wheels in a clean venv, runs the isolated smoke test, compares the `compilerDigest` of wheel, tree, sdist and
installation, checks the OpenAPI document, the consumer fixtures, the corpus baseline (`--skip-corpus` where there is none)
and `toolchain.json`, and prints one JSON summary.

To compare or regenerate the baseline, the OpenAPI document and the consumer fixtures by hand:

```sh
PYTHONPATH=packages/bim-core/src python tools/baseline_core.py --check          # compare with the goldens
PYTHONPATH=packages/bim-core/src python tools/baseline_core.py                  # rewrite them (reviewed changes only)
PYTHONPATH=packages/bim-core/src:packages/bim-service/src python tools/dump_service_openapi.py --check   # CI
PYTHONPATH=packages/bim-core/src:packages/bim-service/src python tools/dump_service_openapi.py           # rewrite it
PYTHONPATH=packages/bim-core/src:packages/bim-service/src python tools/consumer_fixtures.py --check
```

## Running the service

```sh
BIM_SERVICE_TOKENS_FILE=/run/secrets/bim_tokens \
  PYTHONPATH=packages/bim-core/src:packages/bim-service/src \
  uvicorn --factory bim_service.app:create_app --port 8080
```

It does not start without a valid tokens file. See [`docs/SERVICE.md`](docs/SERVICE.md) (endpoints, errors, limits,
authentication, deployment, what it does not do) and [`docs/CLIENT.md`](docs/CLIENT.md) (the port, why it is the
boundary, how the two implementations are kept equal).

## License

The material written for this repository is licensed under **CC-BY-4.0** (SPDX), the license of OpenBinding; holder:
javiercavlop (titular del repositorio OpenBinding); credit the holder, link the license and indicate changes. It is
declared in the `license` field of each `pyproject.toml` (the wheels carry `License-Expression: CC-BY-4.0`) and in
[`licenses.json`](licenses.json). It does **not** cover the five OMG BPMN 2.0.2 schemas under
`bim_core/resources/vendor` (rights not demonstrated, [`docs/OMG_XSD_RIGHTS.md`](docs/OMG_XSD_RIGHTS.md): the export leaves
them out until the holder clears them), the dependencies, or the material credited in `THIRD_PARTY_NOTICES.md`. CC BY 4.0
is not designed for software: that risk is recorded in [`docs/LICENSING.md`](docs/LICENSING.md) and the decision of the
holder is untouched. No dataset is redistributed. See [`NOTICE.md`](NOTICE.md).

Nothing has been published: [`docs/DELIVERY.md`](docs/DELIVERY.md) has the exact steps to export this directory as its own
repository and publish it by hand.

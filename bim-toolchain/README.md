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
  LICENSE, THIRD_PARTY_NOTICES.md   copied unchanged from OpenBinding
  NOTICE.md                         license pending; OMG BPMN notices; no datasets
  packages/bim-core/
    pyproject.toml, README.md
    src/bim_core/                   the package (src layout)
      resources/                    JSON Schemas, engine contract, vendored OMG BPMN 2.0.2 XSDs
    tests/                          tests/fixtures/manifests: Engine manifests used as test inputs
  packages/bim-service/
    pyproject.toml, README.md, Dockerfile
    src/bim_service/                FastAPI application, middleware, limits, authentication, operations
    tests/
  packages/bim-client/
    pyproject.toml, README.md
    src/bim_client/                 BimPort, InProcessBim, HttpBim, errors, types
    tests/                          includes the equivalence battery
  contracts/
    openapi/bim-service.v1.json     the OpenAPI document of the service (generated)
    consumers/openbinding/*.json    the interactions OpenBinding has with BIM, with the responses it expects
  golden/bim_baseline/              digests and numeric summaries recorded in OpenBinding
  golden/bim_core/                  goldens that have no OpenBinding original (see docs/DIGESTS.md)
  golden/vectors_extra.json         adversarial re-evaluation / result-validation vectors
  tools/baseline_core.py            recomputes the baseline with bim_core only
  tools/dump_service_openapi.py     writes / checks contracts/openapi/bim-service.v1.json
  tools/consumer_fixtures.py        the demo package and the scripts behind contracts/consumers/
  docs/                             CONTRACT.md, DIGESTS.md, SERVICE.md, CLIENT.md, EXTRACTION_LOG.md
```

## Running the tests

They need `jsonschema`, `lxml`, `pyyaml`, `fastapi`, `pydantic`, `httpx` and `pytest` (Python ≥ 3.11). The three packages
are not installed, they are put on the path, and the three suites run in one session:

```sh
cd bim-toolchain
PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src \
  python -m pytest --rootdir=. packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests
```

The corpus of BIM packages is not part of this directory. Tests that need it look under `BIM_CORPUS_ROOT`
(default: the directory that contains `bim-toolchain/`) and skip with a warning when it is missing. By default the
equivalence test compares all packages with the goldens; `BIM_BASELINE_SAMPLE_ONLY=1` limits it to ten.

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

## License status

The license of the code has **not been decided**; nothing is declared in the package metadata. `LICENSE`
(CC BY 4.0) and `THIRD_PARTY_NOTICES.md` are OpenBinding's, kept unchanged. The OMG BPMN 2.0.2 schemas keep their
notices. No dataset is redistributed. See [`NOTICE.md`](NOTICE.md).

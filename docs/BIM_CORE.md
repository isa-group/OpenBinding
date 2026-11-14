# BIM core

> The BIM language lives in its own repository,
> [`javiercavlop/bim-toolchain`](https://github.com/javiercavlop/bim-toolchain)
> (**private** for now; the owner plans to move it to the SCORELabUS
> organization when it goes public). OpenBinding consumes its release
> **v0.2.0** and reaches it through `bim_client.BimPort`. The former in-place
> copy (`openbinding_gateway/v1/{canonical,package,expressions,compiler,analysis}.py`,
> `v1/vendor/`, `packages/bim-core/`) and the `bim-toolchain` directory of this
> repository have been removed.

## Current state

| Piece | Where | State |
|---|---|---|
| `bim-core`: package loading, canonical JSON, expressions, compilation, evaluation, re-evaluation, engine protocol, compatibility, conformance kit | wheel of the toolchain release v0.2.0 | A dependency of the gateway (`bim-core==0.2.0`) |
| `bim-client`: `BimPort` with `InProcessBim` and `HttpBim` | wheel of the toolchain release v0.2.0 | A dependency of the gateway (`bim-client==0.2.0`) |
| `bim-service`: HTTP API under `/bim/v1` | wheel of the toolchain release v0.2.0 | Only in the `test` extra (`bim-service==0.2.0`): the tests of `HttpBim` run it in process. A separate deployable of the toolchain repository ([`SERVICE.md`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/docs/SERVICE.md)); neither the lab nor the default deployment runs it |
| OpenBinding consuming the toolchain | `openbinding-gateway/src/openbinding_gateway/integrations/bim.py` | Implemented. Every compile, evaluation and re-evaluation goes through the port |

## How the gateway depends on it

`openbinding-gateway/pyproject.toml` pins `bim-core==0.2.0` and
`bim-client==0.2.0` in `[project.dependencies]` (and `bim-service==0.2.0` only
in the `test` extra). `[tool.uv.sources]` names the wheels of the GitHub
Release `v0.2.0` as files of `openbinding-gateway/.bim-wheels/`, and
`openbinding-gateway/uv.lock` records the SHA-256 of each (those of the release
assets). GitHub serves the assets of a private repository only through its API
with a token, so they cannot be plain URLs while the repository is private;
`python3 tools/fetch_bim_toolchain.py --wheels` downloads them and keeps a file
only if its SHA-256 is the lock's. The `bim-core` wheel carries the five OMG BPMN 2.0.2 XSDs:
OpenBinding no longer downloads them (the owner decided on 2026-11-14 that the
release artifacts carry them; their redistribution rights are still "not
demonstrated", see the toolchain's
[`OMG_XSD_RIGHTS.md`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/docs/OMG_XSD_RIGHTS.md)).

While the repository is private, downloading the wheels needs a token that can
read it:

- **Locally**, `BIM_TOOLCHAIN_TOKEN` (a fine-grained token with read-only
  Contents access to `javiercavlop/bim-toolchain`), or else `gh auth token`,
  read by `tools/fetch_bim_toolchain.py --wheels` before `uv sync`.
- **Docker builds** take the build secret `bim_toolchain_token` from the
  environment variable `BIM_TOOLCHAIN_TOKEN` (`docker-compose.yml`,
  `compose.lab*.json` and `experimentation/qacobench/compose.yaml` declare it).
  The gateway Dockerfile runs the same tool with the secret mounted only for that
  `RUN`, then `uv export --frozen` of the lock and installs the result with
  `--require-hashes`.
- **CI** uses the repository secret `BIM_TOOLCHAIN_TOKEN` through
  `.github/actions/bim-toolchain-access`.

**Upgrading the toolchain** is a pull request in OpenBinding that bumps the pin
(`tools/fetch_bim_toolchain.py --wheels --bootstrap vX.Y.Z`, the versions and wheel
files in `pyproject.toml`, `uv lock`, and
`experimentation/qacobench/bim-toolchain.txt`) and passes the consumer contract
below.

## Consumer contract

The CI job `bim-toolchain` checks that a release keeps the meaning of this
repository's corpus. It checks out the **test kit** of the pinned tag (`tools/`,
`golden/`, `contracts/` and the test fixtures, **without** `packages/*/src`) into
`.bim-toolchain/` (gitignored; `python3 tools/fetch_bim_toolchain.py` does the
same locally, and `BIM_TOOLCHAIN_ROOT` points to another checkout), then runs,
against the **installed** release wheels:

- the toolchain's corpus tier, `pytest -m openbinding_corpus` with
  `BIM_CORPUS_ROOT` set to this repository;
- `tools/baseline_core.py --check` of the kit;
- the gateway's BIM consumer tests: `tests/test_bim_baseline.py`,
  `tests/test_bim_consumer_contract.py`, `tests/test_bim_zip_dir_equivalence.py`,
  `tests/test_bim_v1_conciseness.py` and `tests/composition`;
- the composition round-trip gate `tools/check_composition_roundtrip.py`
  (82/82 packages). It reads the pinned golden
  `openbinding-gateway/tests/golden/bim_baseline/corpus.json`, a byte copy of the
  release's [`golden/bim_normalized/corpus.json`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/golden/bim_normalized/corpus.json).

No test may skip there. The job fails if a release changes the IR or the
semantic digests of this corpus. The checked-in corpus is 82 packages
(`tools/check_bim_corpus.py --expected 82`, `EXPECTED_PACKAGES = 82` in
`tools/check_bim_guard.py`): the 83rd was bim-core's own example package, which
left with the toolchain.

## The port

`integrations/bim.py` is the only place that builds a port. The lab and the
default deployment run BIM **in process** (`InProcessBim`, the default of
`BIM_MODE`); `http` remains a setting for a separately deployed `bim-service`.

| Setting | Meaning |
|---|---|
| `BIM_MODE` | `inproc` (default) or `http` |
| `BIM_SERVICE_URL` | Required when `BIM_MODE=http` |
| `BIM_SERVICE_TOKEN_FILE` | File holding the bearer token; the token is never an environment value |
| `BIM_SERVICE_TIMEOUT_S` | Request timeout |
| `BIM_TENANT` | Tenant header sent to the service |
| `BIM_SERVICE_ALLOW_INSECURE_HTTP` | `false` by default. `true` lets the token travel over plain `http` to a non-loopback host (trusted private network only; logs a warning once). Loopback `http` is always allowed |

`get_bim()` is cached and closed in the application lifespan; tests replace it
with `bim_override`. In `http` mode startup fails if `/capabilities` cannot be
read or if the service `compilerDigest` differs from the one the gateway's own
`bim-core` reports. `abim()` wraps the port in `asyncio.to_thread` for async
routes.

Errors are translated in one place (`problem_for`): `CompileError` and other
`BimError`s become the error's `http_status` or 422 (`invalid_instance` for
compilation failures); `BimServiceError` becomes 503 `bim_unavailable` (with
`Retry-After`), 413/422 for service limits, or 502 `bim_service_error`.

IR documents are stored as plain dictionaries. Snapshot integrity is not
re-implemented in the gateway: every port operation rebuilds the IR from the
document and rejects a mismatch.

## What stays in OpenBinding

The toolchain does not know accounts, organizations, projects, plans, jobs,
queues, persistence, the artifact library, studies, reports, the resolver or the
HTTP routes. See [gateway-as-is.md](architecture/gateway-as-is.md#the-bim--platform-boundary).
Engine manifests are a platform catalogue.

Checks about a single document (resource schema validation, secure XML parse and
BPMN XSD validation, the Engine manifest contract) go through
`bim_client.BimResourcePort`, an extension of `BimPort` implemented by
`InProcessBim` (with `bim_core`) and by `HttpBim` (over the `bim-service`
endpoints below). `integrations/bim_host.py` asks the port of the process and
nothing else: it has no import of `bim_core`, and `dialect_type_matches` and
`dialect_xml_type_matches` are computed there over the manifests that
`dialects()` returned.

### bim-service endpoints for single documents

The BIM frontier is closed: `bim-service` publishes these operations (its
OpenAPI document is
[`contracts/openapi/bim-service.v1.json`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/contracts/openapi/bim-service.v1.json)
in the toolchain), `HttpBim` implements them, and with `BIM_MODE=http` the
gateway would run no BIM validation in its own process. Request bodies are JSON,
errors are `application/problem+json` as elsewhere, and the routes need the same
bearer token and obey the same body limit as the others.

| Method and path | Body | Response 200 |
| --- | --- | --- |
| `POST /bim/v1/resources/validate` | `{document: object, apiVersion, kind, mediaType, resource: string, dialects: [manifest] \| null}` | `{diagnostics: [{code, message, resource, pointer, ...}]}` (empty when valid) |
| `POST /bim/v1/engines/validate` | `{document: object}` | `{diagnostics: [{code, message, ...}]}` (empty when valid) |
| `POST /bim/v1/resources/xml/root` | `{contentBase64: string}` | `{namespace: string, localName: string}`; `PackageError` problem if the XML is malformed, not UTF-8 or uses a forbidden construct |
| `POST /bim/v1/resources/xml/validate-bpmn` | `{contentBase64: string}` | `{valid: true}`; `PackageError` problem if it does not conform to OMG BPMN 2.0.2 |

The semantics and errors are those of `InProcessBim.validate_resource`,
`validate_engine`, `xml_resource_root` and `validate_bpmn_resource`; the
toolchain's equivalence tests compare the two implementations. The boundary test
(`tests/test_bim_boundary.py`) allows `bim_host.py` no name beyond the error
classes (its `EXTRA` entry is empty), and `tests/test_bim_port_host.py` asserts
that it imports nothing from the toolchain and that, over HTTP, each operation is
one request to its endpoint. `BimOperationUnavailable` is still exported by
`bim_client`, but nothing raises it. The startup `compilerDigest` comparison
stays: the gateway keeps `bim-core` for the error classes and for canonical
hashing.

`schemas/bim/v1` and the Engine contract YAML stay in
the repository; `tests/test_bim_schema_parity.py` asserts they are byte-equal to
the resources shipped in `bim_core`.

## Digests

`protocolDigest` and the baseline goldens in `test_bim_baseline.py` are
unchanged. `compilerDigest` (the toolchain bundle digest), the `irDigest` values
that embed it and the built-in version strings differ from the former in-place
copy, because the toolchain's bytes differ (the toolchain's
[`DIGESTS.md`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/docs/DIGESTS.md)).
Snapshots written by the old copy keep their exact contracts and need the old
toolchain to be recompiled.

## Offline tools and the image context

The repository's offline tools use the library in process (`from bim_core import
compile_instance, load_package`), run with `uv run --project openbinding-gateway`:
`tools/{build_bim_packages,check_bim_corpus,check_bim_conciseness}.py`,
`datasets/scripts/transform_*.py` and `experimentation/{qacobench,icws,icsoc}`.
`tools/bim_baseline.py` only gives the platform's corpus, Engine manifests and
golden directory to `tools/baseline_core.py` of the test kit (`.bim-toolchain/`
or `BIM_TOOLCHAIN_ROOT`), which computes the documents. The QACOBench images
install the same release wheels from `experimentation/qacobench/bim-toolchain.txt`
(the same files and SHA-256 as the lock) with the same build secret.

The images are built with the repository root as context. The root `.dockerignore`
is the only effective ignore file (a `Dockerfile.dockerignore` would take its place
under BuildKit and there is none); no toolchain source enters the context, since
the images install the release wheels.
`tests/test_docker_context.py` evaluates it with Docker's matching rules against
every path the gateway Dockerfile copies.

In the lab (`compose.lab.json`) the gateway, the worker and the seed run BIM in
process; they get no `BIM_*` variable. The worker still never receives
`GATEWAY_JWT_SECRET`.

## Cost of the port and test time

Going through the port makes each operation verify and copy the IR it receives
(about 3 ms for the demo), so what must not grow is the number of port calls per
gateway operation. `tests/test_00_perf_probe.py` counts them (descriptors asked once
per port, one `compile` per compilation, one `reevaluate` per answer, one
`evaluate_many` per 500 bindings) instead of timing anything, and
`tests/conftest.py` pins `BIM_MODE=inproc` so a variable left in the environment
cannot send the suite to a service. The same conftest hashes passwords with the
cheapest Argon2 parameters: creating and signing in an account is the largest cost
of the API tests (the suite ran about 280 s with the production parameters and
151 s without).

## Licence and publication

The toolchain's licensing is documented in its repository
([`LICENSING.md`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/docs/LICENSING.md)).
Its wheels are assets of the GitHub Release of the private repository; no
package has been published to a package index. Making the repository public
(and moving it to SCORELabUS) is the owner's decision.

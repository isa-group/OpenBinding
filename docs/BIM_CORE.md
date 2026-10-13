# BIM core

> **Superseded.** The BIM language lives in
> [`bim-toolchain/`](../bim-toolchain/README.md) (the future private repository
> `javiercavlop/bim-toolchain`; the remote has **not** been created). The gateway
> consumes it through `bim_client.BimPort`. The former in-place copy
> (`openbinding_gateway/v1/{canonical,package,expressions,compiler,analysis}.py`,
> `v1/vendor/`, `packages/bim-core/`) has been removed; see
> [Offline tools](#offline-tools-and-the-image-context).

## Current state

| Piece | Where | State in this tree |
|---|---|---|
| `bim-core`: package loading, canonical JSON, expressions, compilation, evaluation, re-evaluation, engine protocol, compatibility, conformance kit | `bim-toolchain/packages/bim-core` | Present; a dependency of the gateway |
| `bim-service`: HTTP API under `/bim/v1` | `bim-toolchain/packages/bim-service` | Present. **Not** installed in the gateway image; only the toolchain runs it |
| `bim-client`: `BimPort` with `InProcessBim` and `HttpBim` | `bim-toolchain/packages/bim-client` | Present; a dependency of the gateway |
| OpenBinding consuming the toolchain | `openbinding-gateway/src/openbinding_gateway/integrations/bim.py` | Implemented. Every compile, evaluation and re-evaluation goes through the port |

## How the gateway depends on it

`openbinding-gateway/pyproject.toml` lists `bim-core` and `bim-client` in
`[project.dependencies]` and resolves them with `[tool.uv.sources]` path entries
(`editable = true`, which must match bim-client's own workspace source or uv
reports conflicting URLs). The Dockerfile copies those two packages into
`/bim-toolchain/packages/...` and installs them with `uv pip install --no-sources`
before the gateway; it does not install `bim-service`. The build context must
therefore contain `bim-toolchain/packages/{bim-core,bim-client}`; the root
`.dockerignore` allowlist has to admit them (see below).

## The port

`integrations/bim.py` is the only place that builds a port.

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
HTTP routes. See [ARCHITECTURE.md](ARCHITECTURE.md#the-bim--platform-boundary).
Engine manifests are a platform catalogue.

The only direct `bim_core` use left in the gateway is `integrations/bim_host.py`
(resource-level schema and XML validation, and the Engine manifest contract). It
is guarded by the startup `compilerDigest` comparison and by
`tests/test_bim_boundary.py`. `schemas/bim/v1` and the Engine contract YAML stay in
the repository; `tests/test_bim_schema_parity.py` asserts they are byte-equal to
the resources shipped in `bim_core`.

## Digests

`protocolDigest` and the baseline goldens in `test_bim_baseline.py` are
unchanged. `compilerDigest` (the toolchain bundle digest), the `irDigest` values
that embed it and the built-in version strings differ from the former in-place
copy, because the toolchain's bytes differ (`bim-toolchain/docs/DIGESTS.md`).
Snapshots written by the old copy keep their exact contracts and need the old
toolchain to be recompiled.

## Offline tools and the image context

The repository's offline tools use the library in process (`from bim_core import
compile_instance, load_package`), run with `uv run --project openbinding-gateway`:
`tools/{build_bim_packages,check_bim_corpus,check_bim_conciseness}.py`,
`datasets/scripts/transform_*.py` and `experimentation/{qacobench,icws,icsoc}`.
`tools/bim_baseline.py` only gives the platform's corpus, Engine manifests and
golden directory to `bim-toolchain/tools/baseline_core.py`, which computes the
documents. The qacobench image copies `bim-toolchain/packages/bim-core/src` too.

The images are built with the repository root as context. The root `.dockerignore`
is the only effective ignore file (a `Dockerfile.dockerignore` would take its place
under BuildKit and there is none); it lets through the `pyproject.toml`, `README.md`,
`NOTICE.md` and `src/` of `bim-core` and `bim-client` and nothing else of the
toolchain (not `bim-service`, tests, corpus or goldens).
`tests/test_docker_context.py` evaluates it with Docker's matching rules against
every path the gateway Dockerfile copies.

In the lab (`compose.lab.json`) the worker and the seed reach the toolchain like
the gateway: `BIM_MODE=http`, `BIM_SERVICE_URL=http://bim-service:8080` and a token
file written from `DEMO_BIM_TOKEN` into a tmpfs by the `sh -c` command. The worker
still never receives `GATEWAY_JWT_SECRET`.

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

No licence has been decided; `bim-toolchain/NOTICE.md` says so. Creating the
remote repository or publishing a package to any index requires explicit human
approval and has not happened.

## History

The first approach left every file in `openbinding_gateway/v1` and assembled a
wheel from those paths (`packages/bim-core/pyproject.toml`, hatch
`force-include`). That wheel was never built and is replaced by
`bim-toolchain/packages/bim-core`.

# bim-service

A stateless HTTP API over `bim-core`. It compiles and validates BIM packages, tells whether an Engine mode can run an
IR, evaluates and re-evaluates bindings, checks the shape of an engine result and analyses the neighbourhood of a
binding. It is `bim_core` behind HTTP and adds nothing to its semantics.

The contract is `contracts/openapi/bim-service.v1.json` (generated from the application; `tools/dump_service_openapi.py
--check` fails when it is out of date). The version of the HTTP API is `bim-service/v1`; every route is under `/bim/v1`.
Within `v1` changes are additive (new optional members, new routes, new error codes); removing or changing a member is
`/bim/v2`.

## What it does not do

* **No state.** No database, no cache, no files written. Every answer is a pure function of the request and of the
  installed toolchain, so replicas are interchangeable and a request can be repeated.
* **No accounts, roles, organizations, projects, pricing, metering or persisted snapshots.** Those stay in OpenBinding,
  which decides who may call BIM and stores what it wants from the answers.
* **No jobs, queue, studies, reports, engine registry or engines.** Engine manifests are *inputs* of
  `/compatibility` and `/optimization/resolve`; the service never fetches one, never calls an engine and never runs a
  solver. `/reevaluate` judges an answer that the caller already has.
* **No authorization beyond the shared secret.** Anyone with a token can use every route. `X-BIM-Tenant` identifies
  nobody and authorizes nothing.
* **No TLS.** Terminate it in front of the service (ingress, sidecar, service mesh). The bearer token is a secret on the
  wire: do not expose the service over plain HTTP outside a trusted network.
* **No shared rate limiting.** The limits below are per process.
* **No interruption of a running operation.** A time budget releases the *request*; the thread that computes keeps its
  slot until it ends (see Limits).

## Endpoints

All `/bim/v1` routes need `Authorization: Bearer <token>`; `/healthz` and `/readyz` do not.

| Method and path | Purpose | Request | Response |
| --- | --- | --- | --- |
| `GET /healthz` | liveness | – | `{"status": "ok"}` |
| `GET /readyz` | readiness | – | `{"status": "ready"}` or 503 |
| `GET /bim/v1/capabilities` | what this service is and allows | – | `apiVersion`, `service {name, version}`, `toolchain` (`toolchain_identity()`), `compilerDigest`, `protocol {id, digest}`, `protocolDigest`, `limits {package, service}`, `profiles`, `dialects` (descriptors), `schemaKinds` |
| `GET /bim/v1/profiles`, `/dialects` | installed contracts | – | `{profiles: [{reference, descriptor, manifest}]}`, `{dialects: [...]}` |
| `GET /bim/v1/schemas/{kind}` | a BIM v1 JSON Schema (`Instance`, `Application`, `CandidateCatalog`, `ConstraintSet`, `Optimization`, `RoutingOverlay`, `Placement`, `Profile`, `Dialect`, `Engine`, `EngineRegistration`, `BindingProblem`) | – | the schema; 404 `schema_not_found` |
| `GET /bim/v1/protocol` | the `bim-engine/v1` contract | – | `{id, digest, document}` |
| `GET /bim/v1/openapi.json` | this API | – | OpenAPI document |
| `POST /bim/v1/compile` | package → IR | `{package: <base64 .bim.zip>, registeredResources: [...]}` or `multipart/form-data` (`package`, optional `registeredResources` as JSON) | `ir`, `irDigest`, `instanceDigest`, `packageDigest`, `compilationDigest`, `inputDigest`, `sourceMap`, `analysis`, `toolchain` |
| `POST /bim/v1/validate` | the same, without the IR | as `compile` | `valid`, `diagnostics`, `packageDigest`, `inputDigest`, `toolchain` and, when valid, `irDigest`, `instanceDigest`, `compilationDigest`, `sourceMap`, `analysis` |
| `POST /bim/v1/compatibility` | can an Engine mode run this IR? | `{ir, manifest, mode?, options?}` | `compatible`, `diagnostics`, `mode {id, terminationGuarantees}`, `options` (defaults applied) |
| `POST /bim/v1/optimization/resolve` | validate an execution-time optimization selection | `{ir, manifest, mode?, optimization}` | `optimization {type, scalarization, weights}` (normalized), `mode` |
| `POST /bim/v1/evaluate` | canonical evaluation of bindings | `{ir, bindings: [..], execution?, onError?: "raise"\|"collect"}` | `results: [{evaluation} \| {error}]` |
| `POST /bim/v1/reevaluate` | the authoritative result for an engine's answer | `{ir, result, execution?, allowedTerminations?}` | `{termination, solutions, provenance}` |
| `POST /bim/v1/validate-result` | is `result` shaped like a `bim-engine/v1` result? (shape only) | `{result}` | `{valid, error: {code, message} \| null}` |
| `POST /bim/v1/neighborhood` | evaluate the one-task alternatives of a binding | `{ir, binding, task?, limit?, seconds?, execution?}` | the analysis of `bim_core.analyze_neighborhood` |

How each maps to `bim_core`: `compile`/`validate` → `load_package` + `compile_instance` (+ `RegisteredResource`);
`compatibility` → `resolve_engine_mode` + `mode_compatibility`; `optimization/resolve` → `resolve_engine_mode` +
`resolve_optimization`; `evaluate` → `evaluate_many`; `reevaluate` → `reevaluate_result`; `validate-result` →
`validate_result`; `neighborhood` → `analyze_neighborhood`; the IR of every request goes through
`BindingProblem.from_document` (so it must be an IR of *this* toolchain: `contract_not_installed` otherwise, see
`DIGESTS.md`). The descriptors are `toolchain_identity`, `profile_descriptor`, `dialect_descriptor`, `protocol_digest`,
`protocol_document` and the bundled schemas.

### Packages

* `package` is the `.bim.zip` in base64, or the file part of a multipart upload. `registeredResources` lists the
  approved registry revisions that the instance pins, each `{namespace, name, version, digest, mediaType,
  contentBase64, versionManifest?}` where `digest` is the pin written in the instance (the content digest, or the
  `versionDigest` of the manifest). A registered resource that is missing, altered or listed twice is refused.
* `inputDigest` identifies everything a compilation read: the digest of the portable package and of every registered
  resource. `packageDigest` is the digest of the canonical archive, `instanceDigest` that of the instance and its
  resources, `irDigest` that of the IR and `compilationDigest` the formula of OpenBinding's persisted snapshots
  (`docs/DIGESTS.md`). `irDigest`, `compilationDigest` and `toolchain.compilerDigest` change with the toolchain bytes;
  `packageDigest`, `instanceDigest`, `inputDigest` and the semantic digest do not.
* `analysis` is `{bindingSpaceLog10, bindingSpaceCardinality (a decimal string), bindingSpaceBreakdown,
  serviceTasks, candidates}`.
* `validate` reports the findings of the compilation as data (`valid: false`, `diagnostics`); a package that cannot
  even be read (not a ZIP, unsafe paths, limits) is an error, as in `compile`.
* The `.bim.zip` stores JSON in canonical form (sorted keys), and the eligible candidates of a task are listed in the
  order of the catalog's keys: the IR compiled from a package can list them in another order than the IR compiled
  from the directory it was made from (`test_equivalence.py` shows that nothing else differs). Compile the package that
  you will keep.

### JSON

Every request is strict JSON: a NaN or an infinity anywhere is `request_invalid`, and every request object is closed
(an unknown member is refused). Responses are strict JSON too. Numbers keep the distinction between integers and floats
that JSON text has.

## Errors

Every error is `application/problem+json` (RFC 9457):

```json
{
  "type": "urn:bim-toolchain:problem:compile_error",
  "title": "Compile error",
  "status": 422,
  "detail": "resource is not valid UTF-8 JSON: missing.json",
  "code": "compile_error",
  "errorType": "CompileError",
  "diagnostics": [{"code": "resource_missing", "message": "...", "resource": "missing.json", "pointer": "/"}]
}
```

`type` is always `urn:bim-toolchain:problem:<code>`. One handler translates every `bim_core.BimError`: `code`,
`detail` (the message) and `diagnostics` are the error's, `errorType` names its class (`PackageError`, `CompileError`,
`ExpressionError`, `CanonicalizationError`, `EvaluationError`, `ProtocolError`, `ContractError`, or `BimError`) so a client
can raise the same one, and `status` is `ContractError.http_status` when it has one and 422 otherwise (500 for the two
codes that are the installation's fault, `protocol_document_invalid` and `invalid_limit`). `httpStatus` (when the
original had one) and `span` (an `ExpressionError`) are extension members. The codes of `bim_core` are in
`CONTRACT.md`. Messages are those of `bim_core` and may quote the input (a path, a name): do not treat them as safe
to show to end users.

Problems about the service rather than the input have no `errorType`:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | `Content-Length` is not a number |
| 401 | `unauthorized` | no valid bearer token (with `WWW-Authenticate: Bearer`); also for paths that do not exist |
| 404 | `not_found`, `schema_not_found` | unknown route; unknown schema kind |
| 405 | `method_not_allowed` | wrong method (with `Allow`) |
| 413 | `payload_too_large` | the body exceeds `BIM_SERVICE_MAX_BODY_BYTES`; the connection is closed |
| 415 | `unsupported_media_type` | `/compile` and `/validate` take JSON or `multipart/form-data` |
| 422 | `request_invalid` | the body does not match the contract (a `ContractError`; `diagnostics` hold JSON pointers and messages, never the offending values) |
| 422 | `limit_exceeded` | more bindings, registered resources or `seconds` than the service allows |
| 429 | `rate_limited` | the tenant already has its share of operations in flight (`Retry-After`) |
| 503 | `service_busy` | no slot became free within `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` (`Retry-After`) |
| 503 | `operation_timeout` | the operation exceeded `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` |
| 503 | `not_ready` | `/readyz` before the service is ready |
| 500 | `internal_error` | anything unexpected: the answer says nothing about the input, the log has the exception class only |

## Limits

All configurable through `BIM_SERVICE_*` variables (`BimServiceSettings.from_env`) and published, with their effective
values, by `GET /bim/v1/capabilities` (`limits.service`; `limits.package` are the `bim_core` package limits).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BIM_SERVICE_MAX_BODY_BYTES` | 32 MiB | largest request body. Declared `Content-Length` over it: 413 **without reading a byte**; otherwise the bytes are counted as they arrive and the request is cut off with 413 when the limit is crossed |
| `BIM_SERVICE_MAX_CONCURRENCY` | 4 | CPU operations at once (size of the worker thread pool); compile, evaluate and the rest run in it, never in the event loop |
| `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` | 250 | how long a request waits for a slot before 503 |
| `BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT` | 2 | operations one `X-BIM-Tenant` may have in flight (0 = unlimited); more is 429 |
| `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` | 60 | time budget of one operation |
| `BIM_SERVICE_RETRY_AFTER_SECONDS` | 1 | value of `Retry-After` for 429 and 503 |
| `BIM_SERVICE_MAX_REGISTERED_RESOURCES` | 64 | registered resources per request |
| `BIM_SERVICE_MAX_BINDINGS` | 1000 | bindings per `/evaluate` |
| `BIM_SERVICE_NEIGHBORHOOD_MAX_SECONDS` | 10 | largest `seconds` of `/neighborhood` (its own budget is cooperative between evaluations) |
| `BIM_MAX_COMPRESSED_BYTES`, `BIM_MAX_EXPANDED_BYTES`, `BIM_MAX_ENTRY_BYTES`, `BIM_MAX_ENTRIES`, `BIM_MAX_COMPRESSION_RATIO`, `BIM_MAX_PATH_DEPTH` | 16 MiB, 64 MiB, 16 MiB, 256, 100, 16 | the `bim_core.Limits` applied to every package (passed to `load_package(limits=)`, never installed globally) |
| `BIM_SERVICE_LOG_LEVEL` | `INFO` | |

The size of the body is limited by pure ASGI middleware that counts bytes, so it does not depend on the framework
having read the body. Authentication runs before the body is read too: an unauthenticated request is refused (401)
without looking at its body.

A thread cannot be interrupted. When an operation exceeds its time budget the *response* is 503 `operation_timeout`,
but the thread keeps its slot (and its tenant's share) until it ends, so a runaway operation cannot be used to start
more work than `BIM_SERVICE_MAX_CONCURRENCY` allows. Size the budgets from the package limits: compiling a package at
the default limits can take far longer than evaluating a binding. The pool is per process; compile and evaluate are
CPU-bound Python, so more throughput needs more processes (`uvicorn --workers N`) or replicas, each with its own
limits.

## Authentication

Service-to-service, one shared secret with room for a rotation.

* `BIM_SERVICE_TOKENS_FILE` names a file with **one or two** tokens, one per line, each at least 32 printable ASCII
  characters. Tokens are never read from the environment, never logged and never in an error message.
* A request is accepted when its `Authorization: Bearer <token>` matches either token. Each accepted token is compared
  with `hmac.compare_digest` over fixed-length digests, with no early exit.
* **The service does not start without a valid file** (fail closed): `create_app()` raises `ServiceConfigError` for a
  missing or unreadable file, a token shorter than 32 characters, characters other than printable ASCII, a repeated
  token, no token or more than two. `BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1` (exactly `1`) turns authentication off and logs
  a warning, but only when **no** file is configured: a configured file that is wrong still stops the start.
* Rotation: write `old` and `new` (in either order) to the file and restart the service; move the callers to `new`;
  write `new` alone and restart. Callers that use `bim_client.HttpBim(token_file=...)` pick the new token up without a
  restart. The file is read at start only.

`GET /healthz` and `/readyz` need no token and reveal nothing (no version, no digest, no configuration).

### Tenant and trace

`X-BIM-Tenant` is an opaque identifier (`[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`; anything else is ignored). It is used for
the log line and for the per-tenant share of in-flight operations, never for authorization and never for a result:
the same request gives the same answer with any tenant. `traceparent` (W3C Trace Context) is propagated: a valid one
is returned unchanged on the response, a missing or invalid one is replaced by a new one, and the trace id is in the
log line.

### Logs

One line per request through the `bim_service` logger: method, path (never the query string), status, duration, tenant
and trace id. No body, no package content, no header value other than the sanitized tenant, no token. An unexpected
exception is logged by class name only, because its message may quote the input.

## Deployment

```sh
# a tokens file: 32+ printable ASCII characters per line
umask 077; head -c 36 /dev/urandom | base64 > tokens

pip install ./packages/bim-core ./packages/bim-service
BIM_SERVICE_TOKENS_FILE=$PWD/tokens uvicorn --factory bim_service.app:create_app --host 0.0.0.0 --port 8080 --no-access-log
```

`packages/bim-service/Dockerfile` builds an image from the context `bim-toolchain/`: `python:3.11-slim`, an unprivileged
user (uid 10001), only `bim-core` and `bim-service` installed (no tests, goldens, corpus or docs in the image), the
licence files under `/usr/share/doc/bim-service/`, a `HEALTHCHECK` on `/healthz` and `uvicorn --factory` as `CMD`.
The tokens are mounted at `/run/secrets/bim_service_tokens` (a Docker or Kubernetes secret), not baked in.

```sh
docker build -f packages/bim-service/Dockerfile -t bim-service:0.1.0 .
docker run --rm -p 8080:8080 -v "$PWD/tokens:/run/secrets/bim_service_tokens:ro" bim-service:0.1.0
```

*The Dockerfile has not been built or run*; it was written without a Docker daemon (see `EXTRACTION_LOG.md`).

Kubernetes notes: use `/healthz` for liveness and `/readyz` for readiness; a failing start (no tokens, invalid file)
exits non-zero, so a bad rollout never takes traffic. Kubernetes injects `BIM_SERVICE_PORT` and `BIM_SERVICE_SERVICE_HOST`
into the pods of a Service called `bim-service`; unknown `BIM_SERVICE_*` variables are ignored for that reason. Put the
service behind TLS and restrict it with a network policy to the pods that call it: the token is a defence in depth, not
the perimeter.

The process-wide state is the installed toolchain, memoised descriptors, and the caches of `bim_core` (compiled XSD,
schema validators, the bundle digest). Importing `bim_service` reads nothing from the environment; only
`create_app()` does.

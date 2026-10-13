# bim-service

A stateless HTTP API over `bim-core`. It compiles and validates BIM packages, tells whether an Engine mode can run an
IR, evaluates and re-evaluates bindings, checks the shape of an engine result, analyses the neighbourhood of a
binding and checks single documents (a resource against its Dialect, an Engine manifest, a standalone XML resource).
It is `bim_core` behind HTTP and adds nothing to its semantics.

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
* **No authorization beyond the bearer token.** Anyone with a token can use every route. The tenant a token is bound
  to only decides the per-tenant concurrency share; `X-BIM-Tenant` identifies nobody and authorizes nothing.
* **No TLS.** Terminate it in front of the service (ingress, sidecar, service mesh). The bearer token is a secret on the
  wire: do not expose the service over plain HTTP outside a trusted network.
* **No shared rate limiting.** The limits below are per process.
* **No interruption of a running operation.** A time budget releases the *request*; the thread that computes keeps its
  slot until it ends (see Limits). Threads also share the GIL with the event loop: see "Where the work runs".

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
| `POST /bim/v1/resources/validate` | a resource document against the schema of the installed Dialect that claims its type | `{document: object, apiVersion, kind, mediaType, resource: string, dialects?: [manifest] \| null}` | `{diagnostics: [{code, message, resource, pointer, ...}]}` (empty when valid) |
| `POST /bim/v1/engines/validate` | an Engine manifest against the installed Profile it declares | `{document: object}` | `{diagnostics: [{code, message, ...}]}` (empty when valid) |
| `POST /bim/v1/resources/xml/root` | the root element of a standalone XML resource, parsed securely | `{contentBase64: string}` | `{namespace, localName}` (`namespace` is `""` without one); 422 `package_error` if the XML is malformed, not UTF-8 or uses a forbidden construct |
| `POST /bim/v1/resources/xml/validate-bpmn` | a standalone XML resource against OMG BPMN 2.0.2 | `{contentBase64: string}` | `{valid: true}`; 422 `package_error` if it does not conform (or is refused as above) |

How each maps to `bim_core`: `compile`/`validate` → `load_package` + `compile_instance` (+ `RegisteredResource`);
`compatibility` → `resolve_engine_mode` + `mode_compatibility`; `optimization/resolve` → `resolve_engine_mode` +
`resolve_optimization`; `evaluate` → `evaluate_many`; `reevaluate` → `reevaluate_result`; `validate-result` →
`validate_result`; `neighborhood` → `analyze_neighborhood`; `resources/validate` → `resource_schema_diagnostics`;
`engines/validate` → `engine_contract_diagnostics`; `resources/xml/root` and `resources/xml/validate-bpmn` →
`InstancePackage.xml_root` and `.xml` over a package of the one resource; the IR of every request goes through
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

### Single documents

* A finding is data: `resources/validate` and `engines/validate` answer 200 with the `diagnostics` that `bim_core`
  returns (an identity that no installed Dialect claims is a `schema_unavailable` diagnostic, not an error). `apiVersion`,
  `kind` and `mediaType` are any JSON value, compared by equality; `dialects`, when given, restricts the Dialects
  considered (manifests as `GET /dialects` returns them).
* `contentBase64` is strict base64 (no whitespace, no missing padding, no alphabet other than the standard one); anything
  else is 422 `request_invalid` with the pointer `/contentBase64`. The XML is never resolved against the network or
  the file system: a DTD, an entity declaration, an XInclude or a `schemaLocation` anywhere in the document is refused
  with 422 `package_error` ("XML uses a forbidden external construct") before it is parsed.
* The size of a request is bounded by `BIM_SERVICE_MAX_BODY_BYTES` like every body (413), and the decoded XML by
  `BIM_MAX_ENTRY_BYTES`, as an entry of a package would be (422 `package_error`).
* These routes run in the same worker pool as the others, so concurrency, tenant share and time budget apply.

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
| 422 | `package_error` | (a `PackageError`, with `errorType`) `resources/xml/*`: the XML is malformed, not UTF-8, forbidden, over `BIM_MAX_ENTRY_BYTES` or not conformant BPMN |
| 415 | `unsupported_media_type` | `/compile` and `/validate` take JSON or `multipart/form-data` |
| 422 | `request_invalid` | the body does not match the contract (a `ContractError`; `diagnostics` hold JSON pointers and messages, never the offending values) |
| 422 | `limit_exceeded` | more bindings, registered resources or `seconds` than the service allows |
| 429 | `rate_limited` | the tenant bound to the caller's token already has its share of operations in flight (`Retry-After`) |
| 429 | `memory_budget` | `BIM_SERVICE_MEMORY_BUDGET_BYTES` is set and the operations in flight already use it, or the request is larger than the whole budget and something else is in flight (`Retry-After`); never sent when the budget is off |
| 503 | `service_busy` | no slot became free within `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` (`Retry-After`) |
| 503 | `operation_timeout` | the operation exceeded `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` |
| 503 | `not_ready` | `/readyz` before the service is ready |
| 500 | `internal_error` | anything unexpected: a fixed `detail`, no exception message, traceback or path, and the extension member `correlationId` (the trace id of the `traceparent` that the answer carries; a request without a valid one gets a fresh id). The log line of the same request has `correlation_id=<id>`, the exception class and the frames (file, function, line), never the exception message, which may quote the input |

Input that is hostile but small is still a client error, never a 500: JSON nested deeper than the parser accepts is
`request_invalid` (422) or `http_error` (400, from the framework's body parsing), and a corrupt or truncated ZIP is a
`PackageError` (422). The time budget of an operation and the size of the body (below) bound the rest.

`correlationId` is not declared in `contracts/openapi/bim-service.v1.json`: `Problem` allows extension members, so the
snapshot is unchanged. Declaring the member would be a contract change to regenerate with
`tools/dump_service_openapi.py`.

## Limits

All configurable through `BIM_SERVICE_*` variables (`BimServiceSettings.from_env`) and published, with their effective
values, by `GET /bim/v1/capabilities` (`limits.service`; `limits.package` are the `bim_core` package limits).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BIM_SERVICE_MAX_BODY_BYTES` | 32 MiB | largest request body. Declared `Content-Length` over it: 413 **without reading a byte**; otherwise the bytes are counted as they arrive and the request is cut off with 413 when the limit is crossed |
| `BIM_SERVICE_MAX_CONCURRENCY` | 4 | CPU operations at once (size of the worker thread pool); decoding and validating the body, compile, evaluate and the rest, and rendering the answer, all run in it (see "Where the work runs") |
| `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` | 250 | how long a request waits for a slot before 503 |
| `BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT` | unset (2 with two or more tenants, else none) | operations one **tenant** (the one bound to the token of the request, never the `X-BIM-Tenant` header) may have in flight; more is 429. 0 = unlimited. Unset: the limit of 2 applies only when the tokens file names **two or more tenants**; with one tenant (every caller shares a token) it would only halve the service, so none applies. Set explicitly, it applies whatever the number of tenants. `limits.service.maxConcurrentOperationsPerTenant` publishes the value in force (0 = none), not the nominal default |
| `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` | 60 | time budget of one operation |
| `BIM_SERVICE_RETRY_AFTER_SECONDS` | 1 | value of `Retry-After` for 429 and 503 |
| `BIM_SERVICE_MAX_REGISTERED_RESOURCES` | 64 | registered resources per request |
| `BIM_SERVICE_MAX_BINDINGS` | 1000 | bindings per `/evaluate` |
| `BIM_SERVICE_NEIGHBORHOOD_MAX_SECONDS` | 10 | largest `seconds` of `/neighborhood` (its own budget is cooperative between evaluations) |
| `BIM_SERVICE_SWITCH_INTERVAL` | unset (the interpreter's, 0.005) | seconds, positive. `sys.setswitchinterval` applied while the application runs (by its lifespan, not when it is created) and restored at shutdown. A shorter one (0.0001) gives the event loop the GIL more often while pool threads run CPU-bound Python, at some cost in their throughput (see "Where the work runs"). `limits.service.switchIntervalSeconds` publishes the interval in force in the process |
| `BIM_SERVICE_MEMORY_BUDGET_BYTES` | 0 (off) | memory that the operations in flight may be estimated to need. Each operation is charged **8 times its request body** (`BODY_MEMORY_FACTOR`; measured 3.8x for a package and 7.9x for an IR of small objects, so an estimate, not a guarantee) from the moment it holds a slot until its thread ends. See "Memory budget". `limits.service.memoryBudgetBytes` publishes it (0 = off) |
| `BIM_MAX_COMPRESSED_BYTES`, `BIM_MAX_EXPANDED_BYTES`, `BIM_MAX_ENTRY_BYTES`, `BIM_MAX_ENTRIES`, `BIM_MAX_COMPRESSION_RATIO`, `BIM_MAX_PATH_DEPTH` | 16 MiB, 64 MiB, 16 MiB, 256, 100, 16 | the `bim_core.Limits` applied to every package (passed to `load_package(limits=)`, never installed globally) |
| `BIM_SERVICE_LOG_LEVEL` | `INFO` | |

The size of the body is limited by pure ASGI middleware that counts bytes, so it does not depend on the framework
having read the body. Authentication runs before the body is read too: an unauthenticated request is refused (401)
without looking at its body.

The global ceiling (`BIM_SERVICE_MAX_CONCURRENCY` slots, `BIM_SERVICE_ACQUIRE_TIMEOUT_MS`) is independent of the
per-tenant share: the sum of the shares may exceed the slots, and the slots are never exceeded whatever a request
claims or however many tenants exist.

### Where the work runs

The event loop reads the body (bytes only; the 413 limit counts them as they arrive) and moves bytes. Everything that
costs CPU or memory in proportion to the request runs in the worker pool, in this order: tenant share, **slot**, optional
memory budget, then in the pool thread the decoding (`json.loads`, validation of the models including the walk that
refuses NaN and infinity, base64, multipart), the operation and the rendering of the answer. Consequences:

* A request that finds no slot decodes nothing: the number of decoded bodies in memory is bounded by the number of slots,
  not by the number of requests that arrive. The raw bytes of a request that is waiting for a slot are still held (at most
  `BIM_SERVICE_MAX_BODY_BYTES` each, once).
* The answers for bad input are the same as before (422 `request_invalid` with pointers below `/body`, 400 `http_error`,
  415, 413), but they now come from the pool: while every slot is taken a malformed body is answered 503 `service_busy`
  (or 429) like any other request, instead of 422.
* The slot is never released before the thread ends (timeout or client gone), because that would allow more threads than
  slots. A client that disconnects frees its slot (and its memory charge) when its thread finishes.

This **bounds** the cost; it does not remove it. `json.loads` and pydantic-core are C code that does not release the GIL
while they run, and the compiler and the evaluator are pure Python that the interpreter switches between threads only
every switch interval (5 ms by default). So in thread mode a large body being parsed can still stall the event loop for
about as long as the parse takes (about 40 ms per MB, measured), and CPU-bound operations make `/healthz` slower
(median 60-120 ms with four of them, against 0.3 ms idle, measured locally with the interpreter's interval; a few ms
with `BIM_SERVICE_SWITCH_INTERVAL=0.0001`, at some cost in throughput that has not been established). Both are pinned as
open defects (strict `xfail`) in `packages/bim-service/tests/analysis/test_analysis_b8_probe.py`. Only worker processes
would remove them; that mode does not exist.

### Memory budget

Off by default (0): nothing changes. When `BIM_SERVICE_MEMORY_BUDGET_BYTES` is set, an operation that holds a slot is
charged 8 times its body and the charge is returned when its thread ends (not at the timeout, not when the client goes
away). A charge that does not fit in what is left is refused at once with **429 `memory_budget`** and `Retry-After`
(there is no queue; retry after the interval). A request whose charge is larger than the whole budget is **admitted
when nothing else is charged** (otherwise it could never run) and, while it runs, every other request is refused with
the same 429; when something else is in flight it is refused with 429 `memory_budget` too. 429 is stable and the client
should retry after `Retry-After`; unlike a 503 it means "this process is using its memory", not "busy". The budget does not
count the raw bytes of requests waiting for a slot, the memory of the interpreter, or anything that is not a request;
set it from `(memory limit - resident size at rest) / 8`, which needs to be measured in the target container.

A thread cannot be interrupted. When an operation exceeds its time budget the *response* is 503 `operation_timeout`,
but the thread keeps its slot (and its tenant's share) until it ends, so a runaway operation cannot be used to start
more work than `BIM_SERVICE_MAX_CONCURRENCY` allows. Size the budgets from the package limits: compiling a package at
the default limits can take far longer than evaluating a binding. The pool is per process; compile and evaluate are
CPU-bound Python, so more throughput needs more processes (`uvicorn --workers N`) or replicas, each with its own
limits.

## Authentication

Service-to-service bearer tokens; each token is bound to a **tenant**, and the tenant of the token that authenticated
a request is the identity of the caller.

* `BIM_SERVICE_TOKENS_FILE` names a file with one token per line, each at least 32 printable ASCII characters. Tokens
  are never read from the environment, never logged and never in an error message (an error names a line number only,
  not even a tenant label).
* **File format.** A line is either `<token>` or `<tenant><spaces or tabs><token>`. A line with only a token belongs to
  the tenant `default`, so a file written for earlier versions (one or two tokens, nothing else) keeps its meaning: one
  tenant. A tenant label matches `[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`. Blank lines are ignored; there are no comments.
  Example (each `<...>` stands for 32+ printable ASCII characters without spaces):

  ```
  <token of the default tenant>
  lab-gateway <first token of lab-gateway>
  lab-gateway <second token of lab-gateway, present during its rotation>
  batch-worker <token of batch-worker>
  ```

* **Contract change (rotation).** Up to **two tokens per tenant** are accepted (the old and the new one during that
  tenant's rotation) with at most **64 tenants**. Earlier versions accepted two tokens in total. A token belongs to one
  tenant only: the same token on two lines, in the same tenant or in two, is an error.
* A request is accepted when its `Authorization: Bearer <token>` matches any token of the file, and it is attributed to
  the tenant of that token. The presented token is compared with every stored one using `hmac.compare_digest` over
  fixed-length digests, with no early exit, whatever the outcome.
* **The service does not start without a valid file** (fail closed): `create_app()` raises `ServiceConfigError` for a
  missing or unreadable file, a line that is neither `<token>` nor `<tenant> <token>`, a tenant label that does not
  match the pattern, a token shorter than 32 characters, characters other than printable ASCII, a repeated token, a
  third token for one tenant, more than 64 tenants or no token. `BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1` (exactly `1`) turns
  authentication off (every caller is the tenant `anonymous`) and logs a warning, but only when **no** file is
  configured: a configured file that is wrong still stops the start.
* **Per-tenant share.** The share of concurrent operations (`BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT`) is counted per
  tenant. The two tokens of a tenant share one count; a token of tenant A never consumes the share of tenant B; a
  request cannot choose, change, omit or spoof its tenant, because only its token decides. The share applies by default
  only when the file names two or more tenants (see Limits), so the laboratory topology, where gateway, worker and seed
  share **one** token (one tenant), is not throttled; give each caller its own labelled token to get fairness between
  them.
* Rotation (per tenant): add the new token as a second line of the same tenant (either order) and restart the service;
  move that tenant's callers to `new`; delete the old line and restart. Callers that use
  `bim_client.HttpBim(token_file=...)` pick the new token up without a restart (their file holds the bare token, see
  `CLIENT.md`). The file is read at start only.

The rotation, saturation and memory behaviour is exercised locally (in process, no real load) by
`packages/bim-service/tests/test_rotation_and_saturation.py`; `docs/qa/BIM_LOAD.md` lists what is and is not measured.

`GET /healthz` and `/readyz` need no token and reveal nothing (no version, no digest, no configuration).

### Tenant and trace

`X-BIM-Tenant` is informative only: what the caller says it is (`[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`; anything else is
ignored). It is **not** the key of the per-tenant share (that is the tenant bound to the token, see Authentication),
and it is used neither for authorization nor for a result: the same request gives the same answer with any value, none
or a malformed one, and sending, changing or omitting it neither evades nor consumes anyone's share. When it differs
from the identity of the token it is added to the log line as `claimed_tenant`. `traceparent` (W3C Trace Context) is propagated: a valid one
is returned unchanged on the response, a missing or invalid one is replaced by a new one, and the trace id is in the
log line.

### Logs

One line per request through the `bim_service` logger: method, path (never the query string), status, duration, the
tenant of the token (`-` when unauthenticated), the sanitized `X-BIM-Tenant` as `claimed_tenant` when it differs, and
the trace id. No body, no package content, no header value other than the sanitized claim, no token. An unexpected
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

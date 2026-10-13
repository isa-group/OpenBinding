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
* **No interruption of a running operation in thread mode (the default).** A time budget releases the *request*; the
  thread that computes keeps its slot until it ends (see Limits). Threads also share the GIL with the event loop: see
  "Where the work runs". `BIM_SERVICE_EXECUTOR=process` (opt-in, Linux only) runs the operations in worker processes
  that are killed at the time budget or when the client goes away: see "Worker processes".

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
| 413 | `memory_budget_exceeded` | `BIM_SERVICE_MEMORY_BUDGET_BYTES` is set and the estimate of the request (8 times its body) is larger than the whole budget: it can never fit, alone or not. Not retryable, no `Retry-After`; refused before the body is read when `Content-Length` says so, and in any case before anything is decoded or a slot is taken; the connection is closed when the body was not read. Never sent when the budget is off |
| 413 | `pending_body_too_large` | the body alone is larger than the whole limit of request bodies in flight (`BIM_SERVICE_MAX_PENDING_BODY_BYTES`). Not retryable, no `Retry-After`, same timing as above |
| 429 | `memory_budget` | `BIM_SERVICE_MEMORY_BUDGET_BYTES` is set and the request would fit the budget, but not what the operations in flight leave of it (`Retry-After`: it may fit once they finish); never sent when the budget is off |
| 429 | `pending_body_bytes` | the request bodies in flight (waiting for a slot or running) plus this one exceed `BIM_SERVICE_MAX_PENDING_BODY_BYTES` (`Retry-After`). Refused before the body is read when `Content-Length` says so, else when the bytes received cross the limit; the connection is closed |
| 503 | `service_busy` | no slot became free within `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` (`Retry-After`) |
| 503 | `operation_timeout` | the operation exceeded `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` |
| 503 | `not_ready` | `/readyz` before the service is ready |
| 500 | `internal_error` | anything unexpected: a fixed `detail`, no exception message, traceback or path, and the extension member `correlationId` (the trace id of the `traceparent` that the answer carries; a request without a valid one gets a fresh id). The log line of the same request has `correlation_id=<id>`, the exception class and the frames (file, function, line), never the exception message, which may quote the input. With `BIM_SERVICE_EXECUTOR=process` also a worker that crashed, was killed from outside (the OOM killer), ran out of its memory allowance or broke the protocol; the log line is `worker_exit pid= signal= op= rss_ready= correlation_id=`, again without input. A `MemoryError` while the body is parsed is a 500 in both executors (before this change thread mode answered 400 `http_error`, as it does for bytes that are not UTF-8) |

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
| `BIM_SERVICE_EXECUTOR` | `thread` | where the operations run: `thread` (a pool of `BIM_SERVICE_MAX_CONCURRENCY` threads, the behaviour described everywhere else in this document) or `process` (`BIM_SERVICE_MAX_CONCURRENCY` worker processes, Linux only; see "Worker processes"). Any other value stops the start; `process` stops it on a system without `os.pidfd_open` and `signal.pidfd_send_signal`. `limits.service.executor` publishes the value in force |
| `BIM_SERVICE_MAX_CONCURRENCY` | 4 | CPU operations at once (size of the worker thread pool, or the number of worker processes); decoding and validating the body, compile, evaluate and the rest, and rendering the answer, all run in it (see "Where the work runs") |
| `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` | 250 | how long a request waits for a slot before 503 |
| `BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT` | unset (2 with two or more tenants, else none) | operations one **tenant** (the one bound to the token of the request, never the `X-BIM-Tenant` header) may have in flight; more is 429. 0 = unlimited. Unset: the limit of 2 applies only when the tokens file names **two or more tenants**; with one tenant (every caller shares a token) it would only halve the service, so none applies. Set explicitly, it applies whatever the number of tenants. `limits.service.maxConcurrentOperationsPerTenant` publishes the value in force (0 = none), not the nominal default |
| `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` | 60 | time budget of one operation |
| `BIM_SERVICE_RETRY_AFTER_SECONDS` | 1 | value of `Retry-After` for 429 and 503 |
| `BIM_SERVICE_MAX_REGISTERED_RESOURCES` | 64 | registered resources per request |
| `BIM_SERVICE_MAX_BINDINGS` | 1000 | bindings per `/evaluate` |
| `BIM_SERVICE_NEIGHBORHOOD_MAX_SECONDS` | 10 | largest `seconds` of `/neighborhood` (its own budget is cooperative between evaluations) |
| `BIM_SERVICE_SWITCH_INTERVAL` | unset (the interpreter's, 0.005) | seconds, positive. `sys.setswitchinterval` applied while the application runs (by its lifespan, not when it is created) and restored at shutdown. A shorter one (0.0001) gives the event loop the GIL more often while pool threads run CPU-bound Python, at a cost of about 10% of the evaluator's throughput measured (see "What thread mode cannot do"). `limits.service.switchIntervalSeconds` publishes the interval in force in the process |
| `BIM_SERVICE_MEMORY_BUDGET_BYTES` | 0 (off) | memory that the operations in flight may be estimated to need. Each operation is charged **8 times its request body** (`BODY_MEMORY_FACTOR`; measured 3.8x for a package and 7.9x for an IR of small objects with `tracemalloc`, and 7.5x per additional concurrent request in resident memory at the body limit, so an estimate, not a guarantee) from the moment it holds a slot until its thread ends. A request whose estimate is larger than the whole budget is never admitted (413 `memory_budget_exceeded`). See "Memory budget". `limits.service.memoryBudgetBytes` publishes it (0 = off) |
| `BIM_SERVICE_MAX_PENDING_BODY_BYTES` | unset: twice `budget // 8` with a memory budget, else 0 (off) | request-body bytes that may be in flight at once, waiting for a slot or running, counted from the moment the body starts to be read until the operation's thread ends. 0 = off, whatever the budget. More is 429 `pending_body_bytes`; a body larger than the whole limit is 413 `pending_body_too_large`. `limits.service.maxPendingBodyBytes` publishes the value in force (0 = off), not the nominal default. See "Memory budget" |
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
  not by the number of requests that arrive. The raw bytes of a request that is waiting for a slot are still held, because
  the framework buffers the whole body before the gate is asked for a slot (at most `BIM_SERVICE_MAX_BODY_BYTES` each,
  once). Without `BIM_SERVICE_MAX_PENDING_BODY_BYTES` (or a memory budget, which derives it) nothing bounds how many such
  bodies exist at once but the number of connections; with it, the bodies in flight are counted before they are read
  (`Content-Length`) or as they arrive (chunked), and the excess is refused (see "Memory budget").
* The answers for bad input are the same as before (422 `request_invalid` with pointers below `/body`, 400 `http_error`,
  415, 413), but they now come from the pool: while every slot is taken a malformed body is answered 503 `service_busy`
  (or 429) like any other request, instead of 422.
* In thread mode the slot is never released before the thread ends (timeout or client gone), because that would allow
  more threads than slots. A client that disconnects frees its slot (and its memory charge) when its thread finishes. In
  process mode they are released when the worker has been killed and reaped.

This **bounds** the cost; it does not remove it. `json.loads` and pydantic-core are C code that does not release the GIL
while they run, and the compiler and the evaluator are pure Python that the interpreter switches between threads only
every switch interval (5 ms by default). So in thread mode a large body being parsed can still stall the event loop for
most of the time the parse takes, and long CPU-bound operations make `/healthz` slower. The three open defects are
pinned as strict `xfail` in `packages/bim-service/tests/analysis/test_analysis_b8_probe.py`; each was reproduced, and
the root causes and numbers are in "What thread mode cannot do" below. Worker processes remove them
(`BIM_SERVICE_EXECUTOR=process`, opt-in, "Worker processes" below): the same three tests run against that executor as normal
passing tests.

### What thread mode cannot do (and what process mode does instead)

Thread mode (`BIM_SERVICE_EXECUTOR=thread`, the default) keeps the three limitations below; they are documented, not
fixed, and the strict `xfail` of each in `tests/analysis/test_analysis_b8_probe.py` is the `[thread]` parameter of a test
whose `[process]` parameter passes. `BIM_SERVICE_EXECUTOR=process` closes all three at the costs listed under "Worker
processes"; each item ends with what process mode did in the same test.

Reproduced with `packages/bim-service/tests/analysis/test_analysis_b8_evidence.py` on 2026-10-13: CPython 3.11.2, Linux
7.0.0-30-generic, 16 CPUs, in a cgroup v2 with `memory.max` 2684354560 (2.5 GiB). The figures vary between runs; the ones
below are those of one run of the finished suite ("last run" below; a further run agreed within the ranges given), and the
ranges are over the runs made while writing this section. They are not the timings of a deployed service: client and service share one process and one event loop.

**1. A large body stalls the event loop** (`test_the_loop_is_not_stalled_while_a_large_body_is_parsed`, xfail). A
13.6 MiB evaluate body handled in a plain worker thread, with a 2 ms timer on the loop:

| Stage | Alone | Longest loop stall |
| --- | --- | --- |
| `json.loads` | 350 ms | 316 ms |
| `pydantic_core.from_json` | 404 ms | 366 ms |
| `validate_python(EvaluateRequest)` | 142 ms | 10 ms |
| `contains_non_finite` (pure Python) | 141 ms | 10 ms |
| `json.dumps` (rendering) | 149 ms | 147 ms |
| `decode_model_body` (all of the above) | 470 ms | 343 ms |

(Earlier runs: `json.loads` alone 430-457 ms with a 315-324 ms stall; the other rows within 10%. Timings of the whole body
therefore vary with the machine, the ratio does not.)

Root cause: `json.loads`, `pydantic_core.from_json` and `json.dumps` are each one C call that keeps the GIL until it
returns, so the loop gets it back only afterwards (stall ≈ 70-100% of the call). The parts that are Python (validation of
the models, the walk that refuses NaN and infinity) are switched every interval and stall the loop for about 10 ms.
Not fixable in thread mode within the rules of this service: the parse cannot be split without replacing `json.loads` by a
hand-written chunked parser on the request path. That would be a second JSON parser in front of every request (a risk of
differences in what it accepts, in the positions of the 422 diagnostics and in the depth that gives 400, which are wire
behaviour) and slower in CPU (not measured, not tried), and it would still leave single large leaves (one base64 string,
`base64.b64decode`) as one call. Lowering `BIM_SERVICE_MAX_BODY_BYTES` bounds the stall but is a different limit, not a fix.

*Process mode:* the parent never parses the body, so the loop does not wait for it. The test passes with the same
12 MiB body and the same threshold (longest lag of a 5 ms timer under 0.3 times the synchronous `json.loads`). A request of
33553091 bytes (just under the 32 MiB limit) took 184 ms from the first byte offered to the answer, with the longest stall
of the 5 ms timer at 13 ms (the worker was a stand-in that parses the body and answers at once).

**2. `/healthz` under CPU-bound operations** (`test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool`, xfail:
it runs with the interpreter's default interval). Four clients in a loop, four slots, 30 probes per round, three rounds
per interval, medians per round:

| Load | 5 ms (default) | 1 ms | 0.1 ms |
| --- | --- | --- | --- |
| synthetic pure Python (analysis test; earlier runs, `docs/qa/analysis/BIM_B5_B8_M4_IR.md`) | 60-118 ms | 21-34 ms | 3.6-6.4 ms |
| real `/evaluate`, 1000 bindings of the demo IR (last run) | 34.3, 35.9, 43.9 ms | 26.7, 17.8, 18.8 ms | 9.4, 9.0, 7.7 ms |
| the same, previous run | 26.3, 80.5, 40.1 ms | 24.3, 22.2, 31.9 ms | 6.5, 9.4, 7.0 ms |
| real `/compile`, demo package (last run) | 2.2, 4.1, 2.1 ms | 2.2, 2.8, 2.6 ms | 2.0, 2.0, 2.5 ms |

Throughput, same runs (requests per second, per round): last run, evaluate 11.4, 12.4, 11.9 at 5 ms against 10.2, 11.0, 11.6
at 0.1 ms (median 11.9 against 11.0, 8% lower); previous run 12.5, 12.3, 12.7 against 11.1, 11.3, 10.6 (10% lower). Compile
38.8-40.0 at 5 ms against 38.4-40.4 at 0.1 ms (no difference). Four spinning threads, 1 s per round, interleaved: median at
0.1 ms 98.6% of the default in the last run (3 rounds; 1 ms: 105.2%), and 93.8%, 100.1%, 92.9%, 97.3% in the four runs
before. Noisy: 0% to 7% on the synthetic load, 8-10% on the evaluator.

Root cause: GIL scheduling. A pool thread running Python keeps the GIL for a whole interval, and answering a request
takes the loop many acquisitions, so latency is several intervals per hop when four threads compete. A short operation
(compile of a small package) does not reproduce it: its threads block or finish often. The mitigation exists and works:
`BIM_SERVICE_SWITCH_INTERVAL` (tests that pass: `test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load`,
`test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval`). **It stays off by default**: it costs about
8-10% of the evaluator's throughput in the measurements above, it is process-wide state, and the symptom is a slower
`/healthz` (tens of ms; the longest probe in the earlier measurements of the analysis document was about 1 s, against a lab
healthcheck timeout of 3 s that it quotes and that was not re-read here), not an outage. An operator who watches `/healthz`
latency can set 0.0001-0.001 knowing that cost. The test that keeps the xfail measures the defaults, so it stays an open
defect.

*Process mode:* the test passes (median under 20 ms with four slots busy for 3 s each). On the real evaluator (1000
bindings of the demo IR, four clients, four slots, `/healthz` probed every 20 ms meanwhile) the `/healthz` medians were 28.8,
45.2, 17.4 and 42.0 ms in thread mode and 1.2, 1.1, 1.1 and 1.2 ms in process mode (longest probe 225, 135, 179, 152 ms
against 36, 36, 36, 47 ms), in four runs of the same test on the machine of "Measurements" below.

**3. A timed-out operation keeps its slot** (`test_a_timed_out_operation_gives_its_slot_back`, xfail). A running thread has
no stop. The one lever CPython offers is `PyThreadState_SetAsyncExc` (an exception raised inside the thread), and its
behaviour was measured: in a thread running pure Python it ended the thread 0.4-5 ms after it was sent; in a thread inside
`json.loads` of the 12 MiB body the sender (which asked to wake up after 50 ms) only ran after 342-386 ms, when the call had
returned, because the sender cannot run while the C call holds the GIL, and that sender would be the event loop that
enforces the time budget. So it cannot bound work that sits in one C call, as the parse does (measured); ZIP inflation and
`lxml` validation are C calls too, but were not tested. It is also unsafe, **by reading and not reproduced**: the exception can be delivered at any bytecode, also
in the executor's own code after the operation returned (the future would never complete and its slot would never be
released) or half-way through the fill of a process-wide cache of `bim_core`, which the next requests would then use.
Giving the slot back at the timeout without stopping the thread would allow more threads than slots. So thread mode keeps
the slot until the thread ends, as documented under Limits.

*Process mode:* the worker is signalled and reaped at the time budget, the slot goes back after the child is gone, and
the next request is served (the test passes; the next request waits for the replacement worker to start, see below).

### Worker processes (`BIM_SERVICE_EXECUTOR=process`)

Opt-in; the default stays `thread` and nothing changes for it (the wire behaviour is byte-identical, with one documented
exception: a `MemoryError` while a body is parsed is now a 500 and not a 400, in both executors). Linux only: the service
refuses to start (`ServiceConfigError`) without `os.pidfd_open` and `signal.pidfd_send_signal`, or when the kernel has no
pidfd. The code is `bim_service/workers.py` (parent), `bim_service/_worker.py` (child) and `bim_service/jobs.py` (the table
`JOBS` of operation id to job, which is the code of the routes: the same job runs in a pool thread and in a worker).

**Slots.** `BIM_SERVICE_MAX_CONCURRENCY` (N) worker slots each own at most one child. A slot is `EMPTY`, `STARTING`,
`IDLE`, `BUSY` or `DYING`; a child is started only from `EMPTY` and a slot becomes `EMPTY` only after `waitpid` returned
for its previous child, so there are never more than N children and no zombies. The concurrency token is still the
`BoundedSemaphore` of the gate: whoever holds one takes one slot that is not busy from a free list. The order in the gate
is the one of thread mode (memory check, tenant share, slot, memory charge, dispatch); what an operation holds is given
back after its worker has returned or been reaped, in the order memory charge, tenant share, slot, body reservation.
Workers are started lazily by the first requests, or all at once by the lifespan of the application (which is what
`uvicorn` runs); clients that never run the lifespan (`httpx.ASGITransport` in tests) still get their children stopped, by
`Gate.close()`, by a `weakref.finalize` of the gate and by a hook that runs before the interpreter joins its threads.
Nothing is bound to an event loop: no asyncio transports or child watchers. The blocking parent I/O (sending the request,
reading the answer, waiting on a pidfd) runs in a `ThreadPoolExecutor(max_workers=N)` named `bim-io`; the loop awaits it.

**The child** is started with `python -s -c 'from bim_service._worker import main; main()' <fd>` (no `preexec_fn`, its own
session, `close_fds`, working directory `/`, stdin/stdout/stderr on `/dev/null`) and an environment of `PATH`,
`LANG=C.UTF-8`, `PYTHONPATH` (the directories that hold `bim_service` and `bim_core`), `PYTHONDONTWRITEBYTECODE=1`,
`MALLOC_ARENA_MAX=2` and `PYTHONHASHSEED` only if the parent has one. It has **no `BIM_SERVICE_*` variable and no token**
(`/proc/<pid>/environ` is checked by a test); everything it needs arrives in the first frame. `PR_SET_PDEATHSIG` is not
used: a worker that sees the socket close (the parent died, or closed it) exits at once if it is idle; a busy one exits
when it tries to answer or at its CPU limit.

**The wire between them** is one `AF_UNIX` `SOCK_STREAM` socket pair per child. A frame is `struct.pack('!4sBII', b'BIMW',
kind, header_len, body_len)` + header + body, `kind` 1 `CONFIG` (parent to child, once), 2 `REQUEST`, 3 `READY`, 4
`RESPONSE`; the header is UTF-8 JSON built by the sender, the body is opaque bytes, and **nothing is pickled**. A
`REQUEST` carries the operation id, the content type and the raw request bytes; a `RESPONSE` carries the sequence
number, status, media type, `Retry-After` if any, the resident size of the worker and the outcome (`ok`, `problem`,
`crash`, `memory`) and, as its body, the JSON that the client receives. The parent checks, before it allocates anything for
what a worker sent: the magic, the kind, a header of at most 16 KiB, a body of at most the allowance (below), a header that
is a JSON object, the sequence number of the outstanding request, a status in {200, 400, 413, 415, 422, 429, 500, 503}, the
media type `application/json` or `application/problem+json`, and no header but `Retry-After` of at most 64 printable
characters. A violation kills the child and answers 500. The body is read into **one** `bytearray` allocated after those
checks and relayed in 1 MiB slices with a `Content-Length`; the parent never parses or renders it again.

**Start of a worker.** The child reads its configuration, applies the interpreter limits of the parent
(`sys.set_int_max_str_digits`, the recursion limit), imports the service and warms it up (so a broken installation stops
the start), lowers its priority (`nice 10`, so that the parent keeps the CPU), writes 1000 to `oom_score_adj` (the OOM killer
takes a worker before the parent), and then limits itself: `RLIMIT_AS` = its `VmSize` when ready + the **allowance** + a
slack, `RLIMIT_CORE` 0 (no core file), `RLIMIT_FSIZE` 0, `RLIMIT_NOFILE` 64. The allowance is `8 x BIM_SERVICE_MAX_BODY_BYTES`
(the estimate the memory budget charges for the largest body; it is also the largest answer a worker may send), the slack
is `max(32 MiB, BIM_SERVICE_MAX_BODY_BYTES)`. `RLIMIT_AS` limits the *virtual* size of the address space, not resident memory.
Before every request it sets a soft `RLIMIT_CPU` of the CPU used so far + the operation timeout + 2 s. It then sends `READY`
with its pid, resident and virtual size, the limits it applied and a digest of the static capabilities of its toolchain: a
parent that sees another digest kills the child (it would answer from another toolchain).

**What happens to a request.**

| Event | The worker | The client sees |
| --- | --- | --- |
| Answer (200) or a deterministic error (400, 413, 415, 422 including `limit_exceeded`) | kept | the same bytes thread mode gives |
| Time budget exceeded (it starts when the request is first written to a ready worker; the start of a child is bounded apart, by 30 s) | `SIGTERM` through its pidfd, `SIGKILL` after 0.2 s, reaped | 503 `operation_timeout` |
| The CPU limit of the request (`SIGXCPU`) | killed by the kernel, reaped | 503 `operation_timeout` |
| Client disconnects (task cancelled, or `http.disconnect` seen by a watcher once the body is read) | stopped and reaped as above | none (logged; the access line says 499) |
| Killed from outside (the OOM killer), `SIGSEGV`, `SIGABRT`, non-zero exit, an exception the service does not map, `MemoryError`, or a peak of virtual size within 1 MiB of its limit | reaped, replaced | 500 `internal_error` with `correlationId`, nothing else |
| A frame that breaks the protocol, or another toolchain | killed, replaced | 500 `internal_error` (a start failure at start) |
| No worker could be started | the slot backs off | 503 `service_busy` with `Retry-After` |
| Shutdown while the request runs | stopped | 503 `service_busy` |

A worker is **never reused** after a timeout, a disconnect, a crash, a memory failure, a protocol violation or an identity
mismatch. A healthy one is retired after its answer when its resident size is more than 16 MiB above the one at `READY`
or after 1000 answers. Signals are sent only through the pidfd, which cannot reach a recycled pid.

**Replacement.** A slot whose child was reaped is refilled in the background if its previous start was at least 0.5 s ago,
and otherwise by the next request that takes the slot (which waits for the rest of the 0.5 s), so a storm of timeouts is not a
storm of spawns (50 consecutive timeouts with two slots: never more than two children, and never more than two starts in 0.5
s, tested). Consecutive start failures back off 0.5 s, 1 s, 2 s, ... up to 30 s per slot; a request that finds its slot
backing off is 503 `service_busy` at once, and while **every** slot backs off `/readyz` is 503 `not_ready`. `/healthz` is
always 200.

**Shutdown.** The lifespan (and `Gate.close()`) closes the write side of the socket of every idle worker, sends `SIGTERM` to
the busy ones, waits up to 2 s on the pidfds, kills what is left and calls `waitpid` on every child (a test: 2 busy and 2 idle
workers, all reaped in under 3 s, no zombie, no pidfd left).

**Memory composition and the fit rule.** After all N workers report `READY` (the start made by the lifespan) the service
checks `P + Q + N*C + B + N*(L + R) + margin <= M` and refuses to start (`ServiceConfigError`) when it fails; it never
reduces N by itself. `M` is `/sys/fs/cgroup/memory.max` of cgroup v2 (`max` or no such file: no check), `margin` is 10% of `M`, `P` the
resident size of the parent when it checks, `Q` the request bodies that may wait (`BIM_SERVICE_MAX_PENDING_BODY_BYTES` in
force, 0 if none), `C` the resident size of the largest worker when ready, `B` the memory budget (without one, N times the
allowance, which is the hard bound of the workers' address space), `L` the body limit and `R` the largest answer (the
allowance), buffered by the parent per slot. It is arithmetic on a model, not a measurement of a running service: answers
that wait to be sent to slow clients are not bounded by the slots, and workers that are started lazily without the
lifespan are not checked.

**Measurements** (`tests/analysis/test_analysis_b8_workers.py`, printed in the "measurements" section of the pytest session;
2026-10-13; CPython 3.11.2, Linux 7.0.0-30-generic, 16 CPUs, a cgroup v2 with `memory.max` 2684354560, which is a limit and not a
resident size; client and service share one process):

* A worker when ready (`bim_core` imported, warmed up, `C`): `VmRSS` 51564544 bytes (49.2 MiB, the same in three starts),
  `VmSize` 58.6 MiB (61452288 bytes), `RLIMIT_AS` 363442176 bytes at the default body limit (61452288 + 256 MiB allowance + 32
  MiB slack). The parent in that run was the test process, 274.0 MiB, the runner included.
* Cold start to `READY` (spawn, imports, warm-up, handshake): 294, 261 and 262 ms (median 262 ms), with the files cached.
* A 33553091-byte request (just under 32 MiB) to a worker that answers at once: 184 ms from the first byte offered to the
  answer; the longest stall of a 5 ms timer on the loop meanwhile, 13 ms (43 ticks). The parent does not parse it; the worker
  does (the stand-in parses the JSON and decodes the base64).
* The same `/evaluate` payload (1000 bindings of the demo IR), four concurrent clients with six requests each, four slots,
  four runs: thread mode 12.0, 13.1, 12.5 and 12.8 requests/s, latency median 324, 302, 270 and 307 ms, p95 456, 402, 447 and 398
  ms; process mode 22.2, 23.4, 23.7 and 23.6 requests/s, latency median 182, 176, 179 and 178 ms, p95 202, 195, 201 and 197 ms. On this
  machine (16 CPUs) four workers gave about 1.9 times the throughput of four threads, because the evaluator is pure Python
  and threads share the GIL; on a machine with fewer CPUs than slots the gain is smaller. The latency of a *single* request
  with nothing else running was not measured, and process mode adds the copy of the body and of the answer through the
  socket and the parse of the answer's header, so no claim is made that it costs nothing there.
* **The fit rule for the laboratory** (`mem_limit` 256 MiB, N=2, L=16 MiB, B=128 MiB, Q=32 MiB as in `compose.lab.json`),
  with the `C` above and `P` = 55451648 (the lab container's PID 1 in thread mode, measured earlier; the parent of a
  process-mode service was not measured in that container): `P` 55451648 + `Q` 33554432 + `N*C` 103129088 + `B` 134217728 +
  `N*(L+R)` 301989888 (R = 8 x 16 MiB = 128 MiB) + margin 26843545 = **655186329 bytes against 268435456: process mode does
  not fit the laboratory container with those settings** (it needs about 2.4 times the memory). With the same proportions
  (B = 8 L, Q = 2 L) the largest body limit that fits is **2 MiB with N=2** (B 16 MiB, Q 4 MiB: 244144537 bytes required) and **6
  MiB with N=1** (B 48 MiB, Q 12 MiB: 253397401 bytes). `compose.lab.json` was not changed: another contract owns the
  laboratory configuration, and thread mode there is as documented under "Memory budget".

**What process mode does not do.** It does not make the service faster per request (see the single-request note above) and
it does not make an operation cheaper in memory: each worker holds `C` at rest plus what a request needs, so N workers cost
about N times `C` more than N threads. It limits the address space of a worker, not its resident memory, so a request can
still use up to the allowance; the memory budget (an estimate, 8 times the body) is still what refuses work in advance.
The parent holds each request body until its worker has answered and each answer until it is sent. A worker killed by
the OOM killer is a 500 for the request it was serving. Python limits are copied from the parent at start
(`sys.set_int_max_str_digits`, recursion limit); other process-wide state the parent changes later (for instance
`bim_core.configure`) is not propagated. `limits.service.executor` is the only change to the published contract
(`capabilities` is not typed in the OpenAPI document, which is unchanged). The behaviour of the `pids_limit` of the lab container
with N+1 processes was not measured.

Tests (`tests/test_process_executor.py`, with `tests/process_standins.py` loaded in the workers through the constructor-only,
unpublished setting `worker_preload`, and `tests/fake_worker.py` for the protocol violations): children never above N with
2N concurrent requests; a timeout and a disconnect reap the child and give back slot, tenant share, memory charge and body
bytes within 1 s; 50 consecutive timeouts; a worker killed from outside; memory above the allowance; a crash; garbage on the
standard streams; ten kinds of protocol violation without allocating the declared length; shutdown with busy and idle
workers; no `BIM_SERVICE_*` or token in the environment of a worker; retiring on memory growth; and a corpus of 37 requests
(deep nesting, NaN and infinity, a 5000-digit integer, invalid UTF-8, bad base64, duplicate and unknown multipart parts, a
missing boundary, 415, unknown members, XXE, billion laughs, a ZIP bomb, too many registered resources or bindings, and
one request for every route) plus the 31 steps of the consumer fixtures, whose status, content type, `Retry-After` and body
bytes are equal in thread mode and in three fresh workers (three hash seeds): no difference was found, so no
determinism problem of `bim-core` was observed. The path of `SIGXCPU` and the retirement after 1000 answers by the real
constant (the test lowers it) are implemented but not reached by a test of the real limits: the wall-clock budget fires first.

The memory table was produced by the test measurement fixture (report values printed in the 'measurements' section of the pytest session), and its figures are the RSS of a fresh Python process, not cgroup totals.

### Memory budget

Off by default (0): nothing changes. When `BIM_SERVICE_MEMORY_BUDGET_BYTES` is set, an operation that holds a slot is
charged 8 times its body and the charge is returned when its thread ends (not at the timeout, not when the client goes
away). `BODY_MEMORY_FACTOR` (8) is an **estimate, not a guarantee**: it was measured at 3.8x to 7.9x with `tracemalloc` and
7.5x to 8.4x in resident memory, and a request can cost more (a package that inflates, for one).

* A charge that would fit the budget but not what the operations in flight leave of it is refused at once with
  **429 `memory_budget`** and `Retry-After` (there is no queue; retry after the interval). 429 is stable and the client
  should retry after `Retry-After`; unlike a 503 it means "this process is using its memory", not "busy".
* A request whose charge is larger than the whole budget can **never** run, so it is not admitted, not even when nothing
  else is in flight (an earlier version admitted it alone; that let a single request exceed the budget, and the container
  with it). It is refused with **413 `memory_budget_exceeded`**, no `Retry-After`, and a detail that says it can never fit
  the configured budget. The check comes first: before the tenant share and the slot are taken (so the refusal holds
  nothing, and no counter changes), before the body is decoded, and, when `Content-Length` is declared, before a byte of
  the body is read. For a chunked body the bytes are counted as they arrive and the request is cut off at the first chunk
  that makes the estimate exceed the budget.
* **Request bodies in flight.** The framework buffers a whole body before the gate is asked for a slot, so the bodies of
  the requests waiting for one were bounded only by the number of connections. `BIM_SERVICE_MAX_PENDING_BODY_BYTES` bounds
  the total of body bytes in flight, waiting or running, from the first byte read until the operation's thread ends (so,
  like the slot and the charge, a timed-out or abandoned operation keeps its bytes counted until its thread finishes).
  The declared `Content-Length` is reserved before reading; without one the bytes received are counted. What does not fit
  is refused with **429 `pending_body_bytes`** and `Retry-After`; a body larger than the whole limit with
  **413 `pending_body_too_large`**. With a budget and no explicit value the limit is twice what the budget admits as raw
  bodies (`budget // 8`): as many bytes may wait as may run, so the worst case is about `1.25 x budget` plus the memory at
  rest. Set to 0 it is off (the 413 `memory_budget_exceeded` check stays); with neither a budget nor a value nothing is
  counted and the wire behaviour is the one of the earlier versions.

The budget does not count the memory of the interpreter or anything that is not proportional to a request body; set it
from `(memory limit - resident size at rest - pending bytes) / 8`, which needs to be measured in the target container.

**Measured resident memory at the body limit.** `packages/bim-service/tests/analysis/test_analysis_b8_rss.py` starts a fresh
Python process per row (`rss_support.py`), builds the application, and sends N = 1, 2 and 4 concurrent `/evaluate` requests
of exactly `BIM_SERVICE_MAX_BODY_BYTES` (33554432 bytes holding about 588 thousand small objects) through the ASGI application, with the
evaluator itself replaced by a stand-in (the numbers are those of reading, decoding, validating and rendering, not of the
evaluator), and reads `/proc/self/status` of that process. Last run, 2026-10-13: process `python3`, CPython 3.11.2,
Linux 7.0.0-30-generic, 16 CPUs (the pids of that run were 15414, 15416 and 15419). The process holds the client too, so the
one 32 MiB request body, shared by all the requests, is in these figures.

| N | `VmRSS` idle | `VmRSS` with the request | peak `VmHWM` (reset before the run) | peak above idle | after the run (gc / `malloc_trim`) | time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 54.5 MiB | 86.5 MiB | 354.1 MiB | 299.6 MiB (9.4x body) | 90.5 / 90.5 MiB | 1.4 s |
| 2 | 54.6 MiB | 86.6 MiB | 594.7 MiB | 540.1 MiB (8.4x per request) | 90.2 / 89.7 MiB | 2.9 s |
| 4 | 54.6 MiB | 86.6 MiB | 1074.7 MiB | 1020.1 MiB (8.0x per request) | 93.3 / 92.8 MiB | 6.0 s |

* Idle is imports plus the built application (the bare interpreter with the test harness imported was 27.1-27.2 MiB). The
  peaks of the three earlier runs of the rows were 354.4, 594.3 and 1072.5-1074.4 MiB: reproducible to 2 MiB.
* Each additional concurrent request added 240 MiB at the peak (594.7 - 354.1 = 240.6 MiB; (1074.7 - 594.7) / 2 = 240.0 MiB)
  = **7.5 times the body**, which is what `BODY_MEMORY_FACTOR = 8` charges. One request alone peaked at 299.6 MiB above idle,
  of which 32 MiB is the client's copy of the body in this process: about 268 MiB for a deployed server (by subtraction, not
  measured separately).
* Nothing is kept: after the requests the process is within 3-7 MiB of where it was with the request loaded, and `malloc_trim`
  gives back little.
* Against the 256 MiB `mem_limit` (268435456 bytes) of the laboratory container: idle 54.5 MiB (the lab container's PID 1
  was measured at 55451648 bytes) plus about 268 MiB for one request at the limit is more than 256 MiB. A single request of
  32 MiB cannot be run in that container. The default limit of 32 MiB is therefore not what the laboratory advertises:
  `compose.lab.json` sets `BIM_SERVICE_MAX_BODY_BYTES=16777216`, `BIM_SERVICE_MAX_CONCURRENCY=2`,
  `BIM_SERVICE_MEMORY_BUDGET_BYTES=134217728` (8 x 16 MiB, so a request at the limit is admissible, alone) and
  `BIM_SERVICE_MAX_PENDING_BODY_BYTES=33554432`, and `limits.service` publishes those values. Worst case from these figures:
  55451648 at rest + 8.4 x 16 MiB admitted (the 8.4x of the first request) + 2 x 16 MiB waiting (the chunks and the joined
  body coexist while it is assembled) = 229.9 million bytes, 38.5 million (36.7 MiB) below the limit. This is arithmetic on
  the measurements above and was **not run in a 256 MiB container**; it covers memory proportional to request bodies, not
  what a hostile package inflates to (`BIM_MAX_EXPANDED_BYTES`, 64 MiB by default, per request).

The cgroup figures are reported apart by the test because they are not the process's: the cgroup of the run has
`memory.max` 2684354560 (2560 MiB) and held 1255 MiB (the test runner, page cache) before each row; `memory.current` sampled
every 20 ms by the parent while the child ran reached 1514.1, 1759.7 and 2246.3 MiB for N = 1, 2 and 4 (259, 504 and 990 MiB
above the start) and was 1259.8, 1260.7 and 1263.5 MiB at the end. `memory.peak` (2560.1 MiB) had already reached the limit
before the test and says nothing about it. The host reported `MemAvailable` 10732.3 MiB. The test runs N = 4 only if the
memory it can see (the smaller of `MemAvailable` and the cgroup headroom including page cache) holds `(8 x N + 2)` bodies, and
prints what it did not run.

`BIM_SERVICE_MEMORY_BUDGET_BYTES` stays **off by default**: the right value is
`(limit of the target container - idle - pending bytes) / 8` and the only container measured is the one above, 2.5 GiB. `BIM_SERVICE_SWITCH_INTERVAL` stays unset for the reasons given
under "What thread mode cannot do". `BODY_MEMORY_FACTOR` stays 8: the measured 7.5x does not justify changing it.

In process mode the charge, the tenant share, the slot and the body bytes are returned once the worker has been killed and
reaped (at the time budget or when the client goes away), not when the computation would have ended.

In thread mode a thread cannot be interrupted. When an operation exceeds its time budget the *response* is 503 `operation_timeout`,
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

`BIM_SERVICE_EXECUTOR=process` needs Linux with pidfd (kernel 5.3 or later; the service says so and stops otherwise) and a
container whose memory limit holds the parent, N workers and their buffers: size it with the fit rule under "Worker
processes", which the start enforces. The workers are children of the `uvicorn` process (`N` plus the process itself under
a `pids_limit`; not measured). Under `uvicorn --workers K` every process has its own N workers.

The process-wide state is the installed toolchain, memoised descriptors, and the caches of `bim_core` (compiled XSD,
schema validators, the bundle digest). Importing `bim_service` reads nothing from the environment; only
`create_app()` does.

# bim-client

`bim_client.port.BimPort` is the interface through which a host (OpenBinding) uses BIM, and it has two implementations
that are interchangeable:

* `InProcessBim` calls `bim_core` in the current process;
* `HttpBim` calls a `bim-service` (see `SERVICE.md`) with `httpx`.

```python
from bim_client import HttpBim, InProcessBim

bim = InProcessBim()                                              # development, tests, batch jobs
bim = HttpBim("https://bim.internal", token_file="/run/secrets/bim_token", tenant="org-1234")

compiled = bim.compile(open("demo.bim.zip", "rb").read())         # CompileResult
ir = compiled["ir"]
check = bim.compatibility(ir, engine_manifest, mode="seeded")     # CompatibilityResult
answer = bim.reevaluate(ir, engine_result)                        # the authoritative result
```

OpenBinding picks the implementation in one place, from configuration, and everything else depends on `BimPort`.

## Why this is the boundary

OpenBinding keeps accounts, roles, persistence, jobs, studies and engines. BIM is a pure computation over documents.
The seam between the two is placed where the contract is narrowest and most stable:

1. **Inputs and outputs are JSON, and only JSON.** The IR crosses the boundary as the document that `compile` returned
   (a `dict`), never as a `BindingProblem` object; an engine result, a binding, an Engine manifest, an execution option are
   plain JSON values; a package is `bytes`. There is no object identity, no callback, no stream, no session. This is what
   makes an in-process call and an HTTP call able to give the same answer, and what lets the platform store any of it.
2. **Identity is by digest.** `packageDigest`, `instanceDigest`, `inputDigest`, `irDigest` and `compilationDigest` identify
   what was computed from what (`DIGESTS.md`); the platform stores and compares those, not toolchain objects.
3. **Failures are a closed hierarchy with codes.** `PackageError`, `CompileError`, `ContractError`, `EvaluationError`,
   `ProtocolError`... each with `code`, message and `diagnostics`, the same on both sides. The platform maps a code to an
   HTTP status of its own (`ContractError.http_status` is a suggestion); it never parses messages.
4. **Every operation is a bounded, stateless request/response.** No long-running work crosses the seam; jobs, retries and
   persistence are the host's.
5. **The toolchain is pinned in the data.** An IR names the Profile and Dialects (and so the `compilerDigest`) that
   produced it, and BIM refuses an IR of another toolchain (`contract_not_installed`). With a service, one deployed
   toolchain serves the whole platform; in process, each host version carries its own. The port makes the choice a
   deployment decision and not a code change.

What moving BIM behind HTTP buys: its CPU, memory and parsing of untrusted XML/ZIP run in a process with no database
credentials, no accounts and its own limits, concurrency cap and time budgets (`SERVICE.md`), and BIM can be released and
scaled on its own. What staying in process buys: no network, no serialization, and the simplest development loop. The
equivalence tests are what make that choice safe.

## The port

`BimPort` (a `typing.Protocol`, `runtime_checkable`) has these methods, with the signatures in `port.py`:

| Method | Returns | Mirrors |
| --- | --- | --- |
| `capabilities()` | `Capabilities` | `GET /capabilities` |
| `profiles()`, `dialects()` | `list[{reference, descriptor, manifest}]` | `GET /profiles`, `/dialects` |
| `schema(kind)` | the JSON Schema | `GET /schemas/{kind}` |
| `protocol()` | `{id, digest, document}` | `GET /protocol` |
| `compile(package, registered_resources=())` | `CompileResult` | `POST /compile` |
| `validate(package, registered_resources=())` | `ValidationResult` | `POST /validate` |
| `compatibility(ir, manifest, *, mode=None, options=None)` | `CompatibilityResult` | `POST /compatibility` |
| `resolve_optimization(ir, manifest, requested, *, mode=None)` | `OptimizationResolution` | `POST /optimization/resolve` |
| `evaluate(ir, binding, execution=None)` | the evaluation | `POST /evaluate` (one binding) |
| `evaluate_many(ir, bindings, execution=None, *, on_error="raise")` | `list[EvaluationOutcome]` | `POST /evaluate` |
| `reevaluate(ir, result, execution=None, allowed_terminations=None)` | `{termination, solutions, provenance}` | `POST /reevaluate` |
| `validate_result(payload)` | `ResultValidation` | `POST /validate-result` |
| `neighborhood(ir, binding, *, task=None, limit=64, seconds=2.0, execution=None)` | the analysis | `POST /neighborhood` |
| `close()` | – | – |

The return types are `TypedDict` s (`bim_client.types`) over the wire format, camelCase members included. `HttpBim`
returns the decoded response; `InProcessBim` returns the same structure after the same JSON round trip (no tuples, no
shared references, no NaN), so `==` between the two is meaningful, and mutating a result never touches an input or a
later result.

### Registered resources

`registered_resources` is a sequence of `{namespace, name, version, digest, mediaType, content: bytes,
versionManifest?}`. `HttpBim` sends `content` as base64; both validate the members the same way.

### Inputs

Every input is checked before anything is computed or sent, by the same functions in both implementations
(`bim_client.wire`): it must be strict JSON (no NaN, no infinity, no bytes, no objects), the IR, the manifest, the result,
the execution and the options must be JSON objects, `limit` an integer, `seconds` a positive finite number. A violation is
`ContractError("request_invalid", http_status=422)` with a diagnostic that points at the argument, and `HttpBim` does not
touch the network.

## Errors

| Raised | When |
| --- | --- |
| `PackageError`, `CompileError`, `ExpressionError`, `CanonicalizationError`, `EvaluationError`, `ProtocolError`, `ContractError` (and `BimError`) | exactly the errors of `bim_core`, with the same `code`, message, `diagnostics`, `http_status` and, for `ExpressionError`, `span` |
| `bim_client.BimServiceError` (a `BimError`; `HttpBim` only) | the service could not be reached or refused for a reason that is not the input: `code` is `unauthorized`, `payload_too_large`, `rate_limited`, `service_busy`, `operation_timeout`, `limit_exceeded`, ... or `service_unavailable`, `service_timeout`, `bad_response`, `http_<status>`, `token_unavailable`; `status` is the HTTP status, `retry_after` the seconds of `Retry-After` |

`HttpBim` rebuilds the exception from the problem document (`errorType`, `code`, `detail`, `diagnostics`, `httpStatus`,
`span`; `bim_client.exception_from_problem`). The `diagnostics` of every error are plain dictionaries in both implementations
(`CompileError` keeps `CompileDiagnostic` objects, which `HttpBim` rebuilds from their `as_dict()`), so `as_dict()` is
equal on both sides.

**Retries are the caller's.** The client never retries. Every operation is idempotent, so a caller may retry `429`,
`503` and transport errors after `retry_after`; a `4xx` that is a `BimError` is a verdict on the input and will not change.

## `HttpBim`

```python
HttpBim(base_url, *, token=None, token_file=None, tenant=None, traceparent=None,
        timeout=30.0, connect_timeout=5.0, client=None, allow_insecure_http=False)
```

* **Token**: `token`, or the first line of `token_file`, which is read again whenever the file changes (a rotation
  reaches a running client). It is not in `repr` and not in any error. A token is not sent over plain `http` to a host
  that is not the loopback, unless `allow_insecure_http=True`.
* **Timeouts** configure the `httpx.Client` that `HttpBim` creates; a `client` you pass keeps its own (and is not closed
  by `close()`). Timeouts become `BimServiceError("service_timeout")`; the service's own budget is `operation_timeout`.
* **`tenant`** is sent as `X-BIM-Tenant`: opaque, for the service's logs and its per-tenant share of concurrency. It never
  changes a result. **`traceparent`** is a callable returning a W3C `traceparent` (or `None`) for each request.

## Differences between the two implementations

They are few, and each is deliberate:

1. `BimServiceError` exists only over HTTP, and so do the service limits (body size, bindings per request, registered
   resources, `seconds` ceiling, concurrency, time budgets).
2. `capabilities()["service"]` and `["limits"]["service"]` are `None` in process; everything else in `capabilities()`
   is equal.
3. An unexpected exception (a bug) is the exception itself in process and `BimServiceError("internal_error", status=500)`
   over HTTP.
4. Both implementations apply the strict-JSON boundary, which `bim_core` called directly does not: `validate_result` there
   accepts a NaN unless `finite=True`, and `reevaluate_result` passes `provenance` through untouched. Through the port a
   NaN or an infinity is `request_invalid`, so a result never contains one.
5. An IR is only valid on a toolchain with the same Profile and Dialects (`compilerDigest`). An IR compiled by a service
   cannot be evaluated by an `InProcessBim` of another `bim-core` build, and the other way round:
   `ContractError("contract_not_installed")`. Compare `capabilities()["compilerDigest"]` of both when mixing.

## How the equivalence is checked

`packages/bim-client/tests/test_equivalence.py` mounts the service in ASGI (`starlette.testclient.TestClient`, which is an
`httpx.Client`, injected into `HttpBim`) and sends the same cases to `InProcessBim` and to `HttpBim`:

* every interaction of `contracts/consumers/openbinding/*.json` (compile, validate, compatibility, optimization, evaluate,
  re-evaluation with and without discrepancy, result validation);
* ten packages of the corpus (when `BIM_CORPUS_ROOT` has it): compile, validate, evaluate, `evaluate_many`, neighbourhood
  and compatibility with two Engines, also compared with `golden/bim_baseline/corpus.json`;
* the ten vectors of `golden/bim_baseline/vectors.json` and the 49 adversarial ones of `golden/vectors_extra.json`
  (re-evaluation and result validation), also compared with the recorded answers;
* 25 failing calls (a package that is not a ZIP or has findings, bad bindings, a refused Engine mode, option, manifest or
  optimization, an IR of another toolchain or with a broken schema, an unknown schema kind, inputs that are not strict
  JSON), compared as errors: class, `code`, message, `diagnostics`, `http_status`;
* registered resources, the descriptors, `capabilities()` and the tenant.

The answers must be equal: the same IR, digests and diagnostics, and for an error the same class, `code`, message,
`diagnostics`, `http_status` and `span`. `test_client_port.py` checks that both classes have exactly the signatures of
`BimPort`, that every `BimError` survives the round trip through a problem document, and the token, header and
transport-failure behaviour.

## Using it from OpenBinding

A thin adapter in the platform owns the port (`bim: BimPort`), calls it from its services and translates errors at the
edge: a `BimError` becomes the platform's HTTP error with `error.http_status or 422`, `code` and `diagnostics`; a
`BimServiceError` becomes a 502/503 of its own. The platform's persistence stores `packageDigest`, `irDigest`,
`compilationDigest` and the IR as it does today with snapshots; `inputDigest` additionally identifies registered
resources. This change does not touch OpenBinding.

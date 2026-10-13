# bim-service

Stateless HTTP API (`bim-service/v1`, routes under `/bim/v1`) over [`bim-core`](../bim-core): compile and
validate BIM v1 packages, check Engine compatibility, resolve execution options, evaluate and re-evaluate
bindings, validate the shape of an engine result and analyse the neighbourhood of a binding.

It has no database, no accounts, no jobs and no engines. Every answer is a pure function of the request and of
the installed toolchain. See [`docs/SERVICE.md`](../../docs/SERVICE.md) for the endpoints, errors, limits,
authentication and deployment, and [`docs/CLIENT.md`](../../docs/CLIENT.md) for the client that talks to it.

```sh
BIM_SERVICE_TOKENS_FILE=/run/secrets/bim_tokens uvicorn --factory bim_service.app:create_app --port 8080
```

The service refuses to start without a valid tokens file (`BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1` is for local
development only). The OpenAPI document is committed at `contracts/openapi/bim-service.v1.json` and
regenerated with `tools/dump_service_openapi.py`.

The operations run in a pool of threads by default. `BIM_SERVICE_EXECUTOR=process` (opt-in, Linux only) runs them in
worker processes that are killed at the time budget or when the client goes away, at a memory cost that
[`docs/SERVICE.md`](../../docs/SERVICE.md#worker-processes-bim_service_executorprocess) measures and checks at start.

License: undecided, see [`NOTICE.md`](../../NOTICE.md).

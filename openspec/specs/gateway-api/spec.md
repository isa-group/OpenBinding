# gateway-api Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored (the code is the executable truth).

## Purpose

Cross-cutting HTTP contract of the OpenBinding gateway (`openbinding-gateway`): the published OpenAPI document,
the uniform error format, health endpoints, request-size limits, CORS, login throttling and production start-up
guards. Endpoint behaviour of each area is specified in its own capability.

## Requirements

### Requirement: Committed OpenAPI snapshot
THE gateway SHALL publish an OpenAPI document generated from the application that is byte-identical to the committed `docs/openapi.json`.

`req~gateway-api-openapi-snapshot~1`

Evidence: `openbinding-gateway/tools/dump_openapi.py`; `.github/workflows/ci.yml`; `openbinding-gateway/tests/test_app_factory.py::test_openapi_matches_the_module_level_app`

#### Scenario: A contract change without a refreshed snapshot
- **GIVEN** a change that adds a response field to a Pydantic model in `models/`
- **WHEN** `python tools/dump_openapi.py --check` runs in CI
- **THEN** the check fails until `docs/openapi.json` is regenerated and committed

### Requirement: Documented operations
THE gateway SHALL give every operation in its OpenAPI document a unique operation id, a tag, a summary, a concrete success media schema and the security requirements that its runtime dependencies enforce.

`req~gateway-api-documented-operations~1`

Evidence: `openbinding-gateway/tests/test_openapi_contract.py`

#### Scenario: Security declared equals security enforced
- **GIVEN** an operation that depends on an authenticated user
- **WHEN** the OpenAPI document is generated
- **THEN** the operation lists `BearerAuth` and `ApiKeyAuth` and its required API-key permissions

### Requirement: Uniform problem document
WHEN the gateway refuses a request, THE gateway SHALL answer with an `application/problem+json` body containing `type`, `title` equal to `code`, `status`, a stable machine-readable `code` and `detail`, and, for status 422, a non-empty `diagnostics` list.

`req~gateway-api-problem-document~1`

Evidence: `openbinding-gateway/tests/test_b4_problem_schema.py`; `docs/ERRORS.md`

#### Scenario: Request validation error
- **GIVEN** a JSON body with a missing required field `spec.limits.maxTasks`
- **WHEN** the client sends it
- **THEN** the gateway answers 422 with `code` `validation_error` and one diagnostic whose `pointer` is `/spec/limits/maxTasks`
- **AND** the submitted value is not echoed

### Requirement: Body size limits
IF a request body exceeds the configured limit for its route (JSON routes and upload routes have separate ceilings), THEN THE gateway SHALL answer 413 with a problem document without passing the body to the route, including for chunked bodies without `Content-Length`.

`req~gateway-api-body-limit~1`

Evidence: `openbinding-gateway/tests/test_security_hardening.py`; `openbinding-gateway/src/openbinding_gateway/security/bodylimit.py`

#### Scenario: Chunked JSON body over the limit
- **GIVEN** the default JSON ceiling of 16 MiB
- **WHEN** a client streams a chunked JSON body of 17 MiB to a JSON route
- **THEN** the gateway answers 413 and the route handler never runs

### Requirement: Closed CORS in production
WHILE `APP_ENV` is `prod`, THE gateway SHALL refuse to start unless `CORS_ALLOW_ORIGINS` is a non-empty list of exact origins without a wildcard.

`req~gateway-api-cors-production~1`

Evidence: `openbinding-gateway/tests/test_b2_cors.py::test_production_refuses_a_wildcard`; `openbinding-gateway/tests/test_b2_cors.py::test_production_refuses_an_empty_list`

#### Scenario: Wildcard origin in production
- **GIVEN** `APP_ENV=prod` and `CORS_ALLOW_ORIGINS=*`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an explanatory error

### Requirement: Insecure production configuration refused
WHILE `APP_ENV` is `prod`, THE gateway SHALL refuse to start with a missing or short `GATEWAY_JWT_SECRET`, with plain-HTTP federation, or with a BIM service token sent over plain HTTP.

`req~gateway-api-production-guards~1`

Evidence: `openbinding-gateway/tests/test_prod_insecure_flags.py`; `openbinding-gateway/src/openbinding_gateway/core/settings.py`

#### Scenario: Plain-HTTP BIM service in production
- **GIVEN** `APP_ENV=prod`, `BIM_MODE=http` and an `http://` BIM service URL with a token
- **WHEN** the gateway starts
- **THEN** it refuses to start

### Requirement: Health endpoints
THE gateway SHALL expose `GET /health`, `GET /health/live` (process liveness) and `GET /health/ready` (required dependencies) without authentication.

`req~gateway-api-health~1`

Evidence: `openbinding-gateway/src/openbinding_gateway/main.py`; `docs/openapi.json`; GAP: no test pins the readiness answer when PostgreSQL or Redis is down

#### Scenario: Readiness with a dependency down
- **GIVEN** the database is unreachable
- **WHEN** a probe calls `GET /health/ready`
- **THEN** the gateway reports not ready (exact status code to be pinned by a test)

### Requirement: Login throttling
WHEN sign-in attempts for one client address and identifier exceed the configured window budget, THE gateway SHALL refuse further attempts with 429, without letting a forwarded header choose the bucket.

`req~gateway-api-login-throttle~1`

Evidence: `openbinding-gateway/tests/test_security_hardening.py`; `openbinding-gateway/src/openbinding_gateway/core/ratelimit.py`

#### Scenario: Spraying identifiers from one address
- **GIVEN** one address that has used its budget
- **WHEN** it tries many different identifiers
- **THEN** the attempts are refused with 429

## Out of scope

- Behaviour of individual endpoint families (see `instances-snapshots`, `job-execution`, `engine-registry`, `auth-roles-entitlements`, …).
- TLS termination (nginx/ingress) and deployment manifests (see `lab-deployment`).

## TODO

- Pin the readiness status codes and body by a test (GAP above).
- `/v1/resolve/{kind}/{digest}` answers 404 at runtime but its OpenAPI entry lists only 200/422 (contract drift; see `resolver-verifier`).
- Correlation ids and structured logging (`tests/test_structured_logging.py`) not yet specified.
- Rate limits other than login (registration, refresh) not yet specified.

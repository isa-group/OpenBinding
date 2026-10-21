# service-api Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: OpenBinding `spec/baseline` @ 9b5be00, `bim-toolchain` 0.2.0 — reverse-engineered, spec-anchored. Paths are relative to `bim-toolchain/`.

## Purpose

`bim-service`: a stateless HTTP API over `bim-core` under `/bim/v1` (`bim-service/v1`), with bearer-token
authentication, request limits, a worker pool (thread mode by default, process mode opt-in) and problem documents.
Contract: `contracts/openapi/bim-service.v1.json`; docs: `docs/SERVICE.md`.

## Requirements

### Requirement: Token authentication
THE service SHALL require `Authorization: Bearer <token>` on every `/bim/v1` route and on unknown paths, accept any token of the configured file (two during a rotation), compare tokens in constant time, never log them, and serve `/healthz` and `/readyz` without a token and without revealing anything.

`req~bim-service-api-token-auth~1`

Evidence: `packages/bim-service/tests/test_service_auth.py::test_a_request_without_a_token_is_refused`; `packages/bim-service/tests/test_service_auth.py::test_both_tokens_are_accepted_during_a_rotation`; `packages/bim-service/tests/test_service_auth.py::test_every_accepted_token_is_compared_in_constant_time`; `packages/bim-service/tests/test_service_auth.py::test_tokens_never_reach_the_logs`; `packages/bim-service/tests/test_service_auth.py::test_health_and_readiness_need_no_token_and_reveal_nothing`

#### Scenario: Unknown path without a token
- **GIVEN** no `Authorization` header
- **WHEN** a client calls `GET /bim/v1/does-not-exist`
- **THEN** the service answers 401, not 404

### Requirement: Refuse to start without valid tokens
IF no tokens file is configured, or it is missing, a directory, or unacceptable, THEN THE service SHALL refuse to start, unless anonymous development mode is enabled by the literal flag `BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1` with no tokens file configured.

`req~bim-service-api-start-guard~1`

Evidence: `packages/bim-service/tests/test_service_auth.py::test_the_service_does_not_start_without_a_tokens_file`; `packages/bim-service/tests/test_service_auth.py::test_the_anonymous_flag_does_not_excuse_a_broken_tokens_file`; `packages/bim-service/tests/test_service_auth.py::test_only_the_literal_1_enables_anonymous_access`

#### Scenario: Typo in the tokens file path
- **GIVEN** `BIM_SERVICE_TOKENS_FILE` pointing to a missing file and the anonymous flag set
- **WHEN** the service starts
- **THEN** start-up fails

### Requirement: Tenant header never authorizes
THE service SHALL use the tenant bound to the token only for its per-tenant concurrency share and logs, and SHALL never let `X-BIM-Tenant` change authorization or a result.

`req~bim-service-api-tenant-header~1`

Evidence: `packages/bim-service/tests/test_service_auth.py::test_the_tenant_header_never_authorizes`; `packages/bim-service/tests/test_service_api.py::test_the_claimed_tenant_is_for_logs_only_and_never_changes_a_result`

#### Scenario: Claiming another tenant
- **GIVEN** a token bound to tenant A
- **WHEN** the request carries `X-BIM-Tenant: B`
- **THEN** the request is accounted to A and the answer is unchanged

### Requirement: Limits decided before reading
IF a request body is declared or streamed beyond the body limit, THEN THE service SHALL answer 413 without reading further (an unauthenticated oversized request is answered 401); IF no worker slot frees within the wait, THEN THE service SHALL answer 503 with `Retry-After`; IF a tenant exceeds its share, THEN THE service SHALL answer 429 while others are served.

`req~bim-service-api-limits~1`

Evidence: `packages/bim-service/tests/test_service_limits.py::test_a_declared_length_over_the_limit_is_refused_without_reading_a_byte`; `packages/bim-service/tests/test_service_limits.py::test_an_unauthenticated_oversized_request_is_refused_as_unauthenticated`; `packages/bim-service/tests/test_service_limits.py::test_no_free_slot_within_the_wait_is_a_503_with_retry_after`; `packages/bim-service/tests/test_service_limits.py::test_a_tenant_over_its_share_gets_429_while_others_are_served`

#### Scenario: Saturated service
- **GIVEN** all worker slots busy for longer than the wait
- **WHEN** another compile request arrives
- **THEN** the service answers 503 `service_busy` with `Retry-After`

### Requirement: Deterministic stateless operations
WHEN the same request is sent to any replica, THE service SHALL return the same answer computed only from the request and the installed toolchain, writing no state; `compile` SHALL return the IR with `irDigest`, `instanceDigest`, `packageDigest`, `compilationDigest`, `inputDigest`, `sourceMap`, `analysis` and `toolchain`.

`req~bim-service-api-deterministic-operations~1`

Evidence: `packages/bim-service/tests/test_service_api.py::test_compile_returns_the_ir_and_everything_that_identifies_it`; `packages/bim-service/tests/test_service_api.py::test_compilation_is_deterministic`; `docs/SERVICE.md`

#### Scenario: Two replicas
- **GIVEN** two service replicas with the same release
- **WHEN** the same package is compiled on both
- **THEN** both answers are byte-identical

### Requirement: Findings as data, failures as problems
WHEN `validate` or `validate-result` finds problems in an input that could be read, THE service SHALL answer 200 with `valid: false` and the findings; WHEN `compile` finds them, THE service SHALL answer 422 `compile_error`; every error SHALL be `application/problem+json` without echoing the input, and an unexpected failure SHALL be a generic 500 with a correlation id.

`req~bim-service-api-findings-and-problems~1`

Evidence: `packages/bim-service/tests/test_service_api.py::test_validate_reports_findings_as_data`; `packages/bim-service/tests/test_service_api.py::test_a_package_with_findings_is_a_compile_error_with_its_diagnostics`; `packages/bim-service/tests/test_service_api.py::test_requests_that_do_not_match_the_contract_are_422_without_echoing_the_input`; `packages/bim-service/tests/test_service_hostile.py::test_an_unexpected_failure_is_a_generic_500_with_a_correlation_id_and_no_detail`

#### Scenario: Invalid package validated
- **GIVEN** a package with an unknown reference
- **WHEN** it is posted to `/bim/v1/validate`
- **THEN** the answer is 200 with `valid: false` and the diagnostic

### Requirement: Refuse IR of another toolchain
IF a request carries an IR produced by another toolchain, THEN THE service SHALL refuse it with the toolchain's `ContractError` code.

`req~bim-service-api-foreign-ir~1`

Evidence: `packages/bim-service/tests/test_service_api.py::test_an_ir_of_another_toolchain_is_refused_with_its_contract_error`

#### Scenario: IR compiled by 0.1.x
- **GIVEN** an IR whose profile digest belongs to 0.1.x
- **WHEN** it is sent to `/bim/v1/evaluate` on 0.2.0
- **THEN** the service refuses it with `contract_not_installed`

### Requirement: Generated OpenAPI contract
THE service SHALL describe every operation and its problem responses in an OpenAPI document generated deterministically from the application and identical to `contracts/openapi/bim-service.v1.json`.

`req~bim-service-api-openapi~1`

Evidence: `packages/bim-service/tests/test_service_openapi.py::test_the_committed_openapi_is_the_generated_one`; `packages/bim-service/tests/test_service_openapi.py::test_every_operation_documents_its_problems_as_problem_json`

#### Scenario: New response field
- **GIVEN** a change that adds a field to the compile answer
- **WHEN** `tools/dump_service_openapi.py --check` runs
- **THEN** it fails until the committed document is regenerated

## Out of scope

- The client port (`client-port`); language semantics (`language-compiler`, `evaluator-protocol`).
- TLS, shared rate limiting, authorization beyond tokens (explicit non-goals in `docs/SERVICE.md`).

## TODO

- Process mode (`BIM_SERVICE_EXECUTOR=process`): CPU-time kill, recycling, memory admission, parent death (tests exist under `packages/bim-service/tests/`).
- Thread mode cannot interrupt running work (3 strict `xfail`, B8): decide whether process mode becomes the default.
- Multipart reader rules and `registeredResources` limits.

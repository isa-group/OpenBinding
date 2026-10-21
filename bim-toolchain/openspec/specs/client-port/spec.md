# client-port Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: OpenBinding `spec/baseline` @ 9b5be00, `bim-toolchain` 0.2.0 — reverse-engineered, spec-anchored. Paths are relative to `bim-toolchain/`.

## Purpose

`bim-client`: the `BimPort` protocol through which a host uses BIM, with two interchangeable implementations,
`InProcessBim` (calls `bim_core`) and `HttpBim` (calls `bim-service` with `httpx`). Docs: `docs/CLIENT.md`.

## Requirements

### Requirement: Both implementations satisfy the port
THE client SHALL provide `InProcessBim` and `HttpBim` that implement every method of `BimPort` with the port's signatures and no method the port lacks.

`req~bim-client-port-port-conformance~1`

Evidence: `packages/bim-client/tests/test_client_port.py::test_both_implementations_satisfy_the_port`; `packages/bim-client/tests/test_client_port.py::test_both_implementations_have_the_signature_of_the_port`; `packages/bim-client/tests/test_client_port.py::test_the_port_has_no_method_the_implementations_lack`

#### Scenario: New port method
- **GIVEN** a method added to `BimPort` but only to `InProcessBim`
- **WHEN** the client tests run
- **THEN** they fail

### Requirement: Equivalent answers and errors
WHEN the same call is made through `InProcessBim` and `HttpBim`, THE client SHALL return equal values and raise the same exception class with the same code for every consumer interaction, corpus package, baseline vector and adversarial vector.

`req~bim-client-port-equivalence~1`

Evidence: `packages/bim-client/tests/test_equivalence.py::test_every_consumer_interaction_is_answered_identically`; `packages/bim-client/tests/test_equivalence.py::test_failing_calls_fail_identically`; `packages/bim-client/tests/test_equivalence.py::test_the_adversarial_vectors_are_answered_identically_and_as_recorded`

#### Scenario: A compile error over HTTP
- **GIVEN** a package that does not compile
- **WHEN** it is compiled in process and over HTTP
- **THEN** both raise `CompileError` with the same code and diagnostics

### Requirement: Strict JSON inputs
IF an input is not strict JSON (NaN, Infinity, non-string keys, non-JSON types), THEN THE client SHALL raise `ContractError("request_invalid")` before anything is sent or computed, in both implementations.

`req~bim-client-port-strict-json~1`

Evidence: `packages/bim-client/tests/test_client_port.py::test_an_input_that_is_not_strict_json_fails_before_anything_is_sent`

#### Scenario: NaN in an engine result
- **GIVEN** an engine result containing `NaN`
- **WHEN** `reevaluate` is called through either implementation
- **THEN** `ContractError` with code `request_invalid` is raised and no request is made

### Requirement: Problems become the original exceptions
WHEN `HttpBim` receives a problem document, THE client SHALL raise the exception the service built it from (same class, code, message and diagnostics), and SHALL report a problem without an error type as a service error.

`req~bim-client-port-problem-mapping~1`

Evidence: `packages/bim-client/tests/test_client_port.py::test_a_problem_becomes_the_exception_it_was_made_from`; `packages/bim-client/tests/test_client_port.py::test_a_problem_without_error_type_is_about_the_service`; `packages/bim-client/tests/test_client_port.py::test_http_errors_are_raised_as_the_exceptions_of_the_problems`

#### Scenario: 503 service busy
- **GIVEN** the service answers 503 `service_busy`
- **WHEN** `HttpBim.compile` is called
- **THEN** the client raises a service error, not a `CompileError`

### Requirement: Results independent of inputs
THE client SHALL return results that share no mutable state with its inputs or with each other.

`req~bim-client-port-independent-results~1`

Evidence: `packages/bim-client/tests/test_client_port.py::test_results_are_independent_of_the_inputs_and_of_each_other`

#### Scenario: Mutating a returned IR
- **GIVEN** an IR returned by `compile`
- **WHEN** the host mutates it
- **THEN** a second call returns an unmodified IR

## Out of scope

- How a host chooses the implementation (OpenBinding `integrations/bim.py`, `BIM_MODE`) and the `compilerDigest` start-up check (OpenBinding `instances-snapshots`).

## TODO

- Timeouts, retries and token-file reload of `HttpBim`.
- `BimResourcePort` (single-document operations) requirements.

# evaluator-protocol Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: OpenBinding `spec/baseline` @ 9b5be00, `bim-toolchain` 0.2.0 — reverse-engineered, spec-anchored. Paths are relative to `bim-toolchain/`.

## Purpose

The judging half of `bim-core`: canonical evaluation of bindings (`evaluator.py`), authoritative re-evaluation of
engine answers (`reevaluate.py`), structural validation of `bim-engine/v1` messages and the protocol digest
(`protocol.py`), engine-mode compatibility and execution options (`compat.py`), neighbourhood analysis
(`neighborhood.py`) and the conformance kit (`conformance.py`).

## Requirements

### Requirement: Canonical evaluation
WHEN a binding is evaluated against an IR, THE toolchain SHALL first validate it as a closed binding of eligible candidates and then return the canonical features, violations, penalties and objectives without modifying the input, raising `EvaluationError` for an invalid binding or a failed evaluation and letting programming errors propagate.

`req~bim-evaluator-protocol-canonical-evaluation~1`

Evidence: `packages/bim-core/tests/test_evaluator.py::test_evaluate_is_the_canonical_evaluation`; `packages/bim-core/tests/test_evaluator.py::test_every_part_validates_the_binding_first`; `packages/bim-core/tests/test_evaluator.py::test_a_bug_is_not_disguised_as_an_evaluation_error`; `golden/bim_normalized/corpus.json`

#### Scenario: Ineligible candidate
- **GIVEN** a binding that assigns task `t1` a candidate not eligible for `t1`
- **WHEN** it is evaluated
- **THEN** an `EvaluationError` with code `binding_invalid` is raised

### Requirement: Authoritative re-evaluation
WHEN an engine answer is re-evaluated, THE toolchain SHALL keep only the decision of each solution, replace every QoS field the engine sent with the canonical evaluation, and pass provenance through unchanged.

`req~bim-evaluator-protocol-authoritative-reevaluation~1`

Evidence: `packages/bim-core/tests/test_reevaluate.py::test_every_qos_field_the_engine_sent_is_replaced`; `packages/bim-core/tests/test_reevaluate.py::test_penalties_follow_the_optimization_not_the_engine`; `packages/bim-core/tests/test_vectors_extra.py`

#### Scenario: Engine reports a better objective than it achieved
- **GIVEN** an answer whose objective value is lower than the canonical value of its binding
- **WHEN** it is re-evaluated
- **THEN** the result carries the canonical value

### Requirement: Termination never stronger than justified
WHEN an engine answer is re-evaluated, THE toolchain SHALL lower the termination to `UNKNOWN` unless the solutions and the mode's declared guarantees support it: a claim of a solution without one, a claim of infeasibility with a solution, an ineligible binding, or a binding with a hard violation SHALL yield `UNKNOWN`.

`req~bim-evaluator-protocol-termination-lowering~1`

Evidence: `packages/bim-core/tests/test_reevaluate.py::test_a_termination_is_never_stronger_than_what_the_mode_declares`; `packages/bim-core/tests/test_reevaluate.py::test_a_claim_of_infeasibility_with_a_solution_is_unknown`; `packages/bim-core/tests/test_reevaluate.py::test_a_binding_with_a_hard_violation_is_kept_but_makes_the_termination_unknown`

#### Scenario: INFEASIBLE with a solution
- **GIVEN** an answer with termination `INFEASIBLE` and one solution
- **WHEN** it is re-evaluated
- **THEN** the termination is `UNKNOWN`

### Requirement: Structural result validation
WHEN a decoded engine message is validated, THE toolchain SHALL accept it only if it matches the closed `bim-engine/v1` shape (one of the four terminations, closed solution, objective, penalty and violation structures, no extra fields), raising `ProtocolError` with a stable code otherwise, and with `finite=True` SHALL reject any non-finite number.

`req~bim-evaluator-protocol-result-shape~1`

Evidence: `packages/bim-core/tests/test_protocol.py::test_the_termination_must_be_one_of_the_four_names`; `packages/bim-core/tests/test_protocol.py::test_the_result_has_no_other_fields_than_the_protocol_defines`; `packages/bim-core/tests/test_protocol.py::test_finite_mode_rejects_a_non_finite_number_wherever_it_is`

#### Scenario: Extra field in a result
- **GIVEN** a result with an additional member `debug`
- **WHEN** it is validated
- **THEN** a `ProtocolError` with code `unknown_fields` is raised

### Requirement: Protocol digest
THE toolchain SHALL publish the bundled engine contract and a protocol digest that changes whenever the contract or the `BindingProblem` schema it references changes.

`req~bim-evaluator-protocol-protocol-digest~1`

Evidence: `packages/bim-core/tests/test_protocol.py::test_the_protocol_digest_pins_the_binding_problem_schema`; `packages/bim-core/tests/test_protocol.py::test_the_protocol_digest_follows_the_openapi_document`

#### Scenario: Schema edited
- **GIVEN** a change to `binding-problem.schema.json`
- **WHEN** `protocol_digest()` is computed
- **THEN** it differs from the previous value

### Requirement: Mode compatibility and options
WHEN an IR is checked against an engine mode, THE toolchain SHALL report every capability dimension the problem uses that the mode does not declare (selector `none` refuses any use, `all` accepts anything), every exceeded mode limit, and SHALL validate options against the mode's schema and limits starting from its defaults, one diagnostic per unknown option.

`req~bim-evaluator-protocol-mode-compatibility~1`

Evidence: `packages/bim-core/tests/test_compat.py::test_selector_none_refuses_every_use_of_the_dimension`; `packages/bim-core/tests/test_compat.py::test_the_limits_of_the_mode_bound_tasks_candidates_and_objectives`; `packages/bim-core/tests/test_compat.py::test_unknown_options_are_refused_one_diagnostic_each`; `packages/bim-core/tests/test_compat.py::test_open_ranges_fail_closed_against_every_engine_mode_like_finite_ones`

#### Scenario: Interval features on a scalar mode
- **GIVEN** an IR with interval feature values and a mode that declares only scalar values
- **WHEN** compatibility is checked
- **THEN** the result is incompatible with a diagnostic listing `interval` as unsupported and `scalar` as allowed

### Requirement: Bounded expressions
IF an expression would produce an integer above the configured bit limit (one million bits by default) through powers, products or weighted aggregations, THEN THE toolchain SHALL refuse it in bounded time.

`req~bim-evaluator-protocol-bounded-expressions~1`

Evidence: `packages/bim-core/tests/test_expression_limits.py::test_the_default_limit_is_one_million_bits`; `packages/bim-core/tests/test_expression_limits.py::test_the_hostile_powers_are_refused_in_bounded_time`

#### Scenario: Hostile power
- **GIVEN** an expression whose power would produce an integer far above one million bits
- **WHEN** it is evaluated
- **THEN** it is refused in bounded time with an expression error

### Requirement: Honest neighbourhood analysis
WHEN the neighbourhood of a binding is analysed, THE toolchain SHALL evaluate each eligible one-task substitution canonically within the time budget, count failed evaluations as incomplete, and never claim local optimality for partial or empty coverage.

`req~bim-evaluator-protocol-neighbourhood~1`

Evidence: `packages/bim-core/tests/test_neighborhood.py::test_partial_and_empty_coverage_never_claims_unchecked_local_optimality`; `packages/bim-core/tests/test_neighborhood.py::test_failed_evaluations_are_not_counted_as_complete`

#### Scenario: Budget exhausted
- **GIVEN** a budget of 0.01 s and many alternatives
- **WHEN** the neighbourhood is analysed
- **THEN** the analysis reports partial coverage and no optimality claim

## Out of scope

- Package loading and compilation (`language-compiler`); HTTP exposure (`service-api`).
- Engine-side behaviour (OpenBinding `engine-protocol`).

## TODO

- Conformance kit (`openapi_diagnostics`, `assert_conformance_result`) requirements.
- `resolve_optimization` (execution-time optimization selection, weights normalization) requirements.
- Decide whether the evaluator code moves out of `BindingProblem` (EXTRACTION_LOG; API unchanged).

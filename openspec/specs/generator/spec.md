# generator Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

Synthetic BIM v1 instance generation over HTTP: `POST /v1/generator/instances`, `POST /v1/generator/corpus`,
`POST /v1/generator/convert-legacy` (`openbinding-gateway/src/openbinding_gateway/generator/`, `routes/generator.py`),
backed by the Java QACO generator `engines/bim-generator`. Contract in `docs/BIM_GENERATOR.md` (Spanish).
QACOBench generates its QFBS suite exclusively through this endpoint.

## Requirements

### Requirement: Pure function of the request
WHERE `persist` is not requested, THE gateway SHALL serve the generator endpoints to any caller, including anonymous ones, without touching shared state.

`req~generator-pure-function~1`

Evidence: `docs/BIM_GENERATOR.md`; `docs/openapi.json`; `openbinding-gateway/tests/test_generator_routes.py::test_generate_instance_endpoint_success`

#### Scenario: Anonymous generation
- **GIVEN** no credentials
- **WHEN** a client posts a valid configuration to `/v1/generator/instances`
- **THEN** the gateway answers 200 with a six-resource BIM package and stores nothing

### Requirement: Persisting requires an account and a role
IF a generation request sets `persist: true` without an account, THEN THE gateway SHALL answer 401; WHEN it targets a project, THE gateway SHALL require MEMBER or higher in that project.

`req~generator-persist-authorization~1`

Evidence: `openbinding-gateway/tests/test_generator_routes.py::test_generate_instance_persist`; `docs/BIM_GENERATOR.md`

#### Scenario: Anonymous persist
- **GIVEN** no credentials
- **WHEN** a client posts a configuration with `persist: true`
- **THEN** the gateway answers 401

### Requirement: Seeded reproducibility
WHEN two requests carry identical parameters and seed, THE generator SHALL produce packages with the same `compilation_digest` and the same evaluation of every binding.

`req~generator-seeded-reproducibility~1`

Evidence: `openbinding-gateway/tests/test_generator_routes.py::test_explicit_features_and_distributions_are_seeded`; `openbinding-gateway/tests/test_generator_routes.py::test_generated_bpmn_matches_native_workflow`; `docs/BIM_GENERATOR.md`

#### Scenario: Same seed twice
- **GIVEN** a configuration with `seed: 42`
- **WHEN** it is posted twice
- **THEN** both packages compile to the same `compilation_digest`

### Requirement: Configuration validation
IF a configuration has unknown keys (including `qos_properties`, `templates`, `weights`), incomplete feature definitions, aggregations foreign to the feature scope, a scalar together with its distribution, `tension` without guaranteed feasibility, or more than 100 expanded features or 1,000,000 candidate-feature values, THEN THE gateway SHALL answer 422 naming the field.

`req~generator-config-validation~1`

Evidence: `openbinding-gateway/tests/test_generator_routes.py::test_invalid_generator_configuration_reports_field`; `openbinding-gateway/tests/test_generator_routes.py::test_corpus_rejects_ignored_base_configuration`; `docs/BIM_GENERATOR.md`

#### Scenario: Weights in a generation request
- **GIVEN** a configuration with a `weights` member
- **WHEN** it is posted
- **THEN** the gateway answers 422 with a diagnostic pointing at `weights`

### Requirement: Guaranteed feasibility witness
WHERE `guarantee_feasibility` is true, THE generator SHALL derive every constraint bound so that one common witness selection satisfies all constraints.

`req~generator-feasibility-witness~1`

Evidence: `openbinding-gateway/tests/test_generator_routes.py::test_guaranteed_constraints_share_a_feasible_witness`

#### Scenario: Three constraints with tension 0.8
- **GIVEN** `guarantee_feasibility: true`, `constraints: 3`, `tension: 0.8`
- **WHEN** an instance is generated
- **THEN** there is a binding that satisfies all three constraints

### Requirement: Target engine compatibility hint
WHERE `target_engines` is given, THE generator SHALL refuse with 422 a configuration whose objectives or aggregations the target engine modes cannot run, and SHALL NOT select an engine on the user's behalf.

`req~generator-target-engines~1`

Evidence: `openbinding-gateway/tests/test_generator_routes.py::test_target_engine_rejects_unsupported_objective_and_aggregation`; `openbinding-gateway/tests/test_generator_routes.py::test_generate_instance_incompatible_engines`

#### Scenario: Product aggregation for MiniZinc
- **GIVEN** `target_engines: ["minizinc-csp"]` and a `product` aggregation the mode does not support
- **WHEN** the configuration is posted
- **THEN** the gateway answers 422 naming the incompatibility

## Out of scope

- QFBS design and campaign logic (`qacobench-experimentation`).
- Legacy QACO CLI formats of `bim-generator` other than `--config`.

## TODO

- BPMN output equivalence (`dialects: ["bpmn-workflow/v1"]`) and `include_file_bytes` as requirements.
- Corpus endpoint (`/corpus`) seeds and ZIP output; `/convert-legacy`.
- Translate `docs/BIM_GENERATOR.md` to English (repo convention) — owner decision.

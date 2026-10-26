## MODIFIED Requirements

### Requirement: Plan bounds the number of API keys
IF creating an API key would exceed the plan's `maxApiKeys` limit (revoked keys excluded), THEN THE gateway SHALL answer 402 `quota_exceeded`.

`req~auth-roles-entitlements-api-key-quota~2`

Needs: impl, utest

#### Scenario: Second key on the basic plan
- **GIVEN** a recorded pricing with a plan `basic` whose `maxApiKeys` is 1, and a `basic` account with one active key
- **WHEN** it creates another key
- **THEN** the gateway answers 402 `quota_exceeded`

#### Scenario: Third key on FREE
- **GIVEN** a FREE account (`maxApiKeys` 2) with two active keys and one revoked key
- **WHEN** it creates another key
- **THEN** the gateway answers 402 `quota_exceeded` with `quota.limit_id` `maxApiKeys`, `quota.limit` 2 and `quota.used` 2, and creates no key

#### Scenario: Revoked keys do not count
- **GIVEN** a FREE account with one active key and three revoked keys
- **WHEN** it creates another key
- **THEN** the key is created

### Requirement: Entitlements from the plan service
WHEN a decision depends on the caller's plan, THE gateway SHALL read the plan's features and limits only through the plans module (`openbinding_gateway/modules/plans/`).

`req~auth-roles-entitlements-plan-reads~2`

Needs: impl, utest

#### Scenario: SPACE unreachable during a launch
- **GIVEN** `SPACE_ENABLED=true` and SPACE not answering
- **WHEN** a member submits a job
- **THEN** the gateway answers 503 `pricing_unavailable` and creates no job

#### Scenario: A route reads the gate directly
- **GIVEN** a change that makes `routes/users.py` call the SPACE adapter's `caps` without going through the plans module's application API
- **WHEN** the unit suite runs
- **THEN** the architecture test fails

#### Scenario: Refusals come from the plans module
- **GIVEN** a FREE account and a recorded pricing where `FREE` sets `studies` to `false`
- **WHEN** the account launches a study run
- **THEN** the gateway answers 403 `feature_not_entitled`
- **AND** a recording fake of the plans port shows that the contract was read through the plans module only

### Requirement: No metering
THE gateway SHALL NOT charge accounts, hold a local pricing or SPACE logic of its own, or keep its own count of credits, compute units, `solverHours` or `generatedInstances`.

`req~auth-roles-entitlements-no-metering~2`

Needs: impl, utest

#### Scenario: Reintroducing a metering module
- **GIVEN** a change that adds `openbinding_gateway/metering.py` and imports it
- **WHEN** the unit suite runs
- **THEN** the architecture test fails

#### Scenario: Reintroducing a local pricing
- **GIVEN** a change that adds a pricing document read by the gateway at run time, or a module that evaluates plan features itself instead of asking SPACE
- **WHEN** the unit suite runs
- **THEN** the architecture tests (`tests/test_no_local_pricing.py`, `tests/test_architecture_layers.py`) fail
- **AND** the recorded pricing under `tests/fixtures` and `docs/pricing/` used by tests and documentation is not a local pricing

#### Scenario: A local count of solver hours
- **GIVEN** a change that adds a database model or column whose name contains `solver_hours`, `solverHours`, `generated_instances` or `generatedInstances`
- **WHEN** the unit suite runs
- **THEN** the architecture test fails

#### Scenario: SPACE tracks the renewable limits
- **GIVEN** a FREE account that runs 300 000 ms on a built-in engine
- **WHEN** the gateway admits the run
- **THEN** the only record of the consumption is SPACE's evaluation, and the gateway stores no used-hours value

## ADDED Requirements

### Requirement: No analysis worker
`req~lab-deployment-no-analysis-worker~1`
THE files `docker-compose.yml`, `deploy/compose/production/compose.yaml` and every `compose.lab*.json` SHALL define no service that consumes the Dramatiq queue `analysis`.

Needs: impl, utest

#### Scenario: Compose services
- **GIVEN** the committed deployment files
- **WHEN** the static check reads every service's `command`
- **THEN** no command passes `analysis` as a queue to `dramatiq`
- **AND** no service is named `analysis-worker` or `analysis-worker-dev`

#### Scenario: Lab worker keeps solving
- **GIVEN** `compose.lab.json`
- **WHEN** the static check reads the worker service's command
- **THEN** it runs `dramatiq openbinding_gateway.worker` with `--queues default`

#### Scenario: Analysis worker reintroduced
- **GIVEN** a change that adds a service running `dramatiq openbinding_gateway.worker --queues analysis` to `docker-compose.yml`
- **WHEN** the unit suite runs
- **THEN** the static check fails

Evidence: `lab/tests/test_lab_compose.py`; `openbinding-gateway/tests/test_compose_worker_secrets.py`

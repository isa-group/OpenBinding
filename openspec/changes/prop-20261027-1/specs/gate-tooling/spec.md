## MODIFIED Requirements

### Requirement: Trace over the G6 paths, report-only
THE `trace` job SHALL run the verified jar with `trace -o plain` over those of `openspec/specs`, `openbinding-gateway/src`, `openbinding-gateway/tests`, `engines`, `frontend/src`, `acceptance`, `lab`, `tools` and `.github/workflows` that exist, in that order, in a step with `continue-on-error: true` until a CI run into `develop` exits 0.

`req~gate-tooling-trace-paths~2`

Needs: utest

Evidence (planned, slice S1): lab/tests/test_ci_gate_tooling.py::test_trace_step_covers_g6_paths_report_only, asserting the nine-path list

#### Scenario: The path list in the workflow
- **GIVEN** `.github/workflows/ci.yml`
- **WHEN** the `run` script of the trace step of job `trace` is read
- **THEN** its `for path in` list is exactly `openspec/specs openbinding-gateway/src openbinding-gateway/tests engines frontend/src acceptance lab tools .github/workflows`
- **AND** the step has `continue-on-error: true`

#### Scenario: An absent path is skipped
- **GIVEN** a checkout without `acceptance/`
- **WHEN** the trace step runs
- **THEN** it logs `skipped (absent): acceptance` and traces the eight other paths

#### Scenario: Lab and tooling tags are traced
- **GIVEN** `lab/tests/test_previews.py` holds the tag `[utest->req~lab-deployment-preview-on-demand~1]`
- **AND** no file under `openspec/specs` declares `req~lab-deployment-preview-on-demand~1`
- **WHEN** the trace step runs
- **THEN** its plain report lists that link from `lab/tests/test_previews.py` as a defect
- **AND** the `trace` job does not fail

#### Scenario: Trace defects do not block
- **GIVEN** requirements without coverage tags
- **WHEN** the trace step reports defects and exits non-zero
- **THEN** the `trace` job does not fail

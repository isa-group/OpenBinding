# Tasks: prop-20261027-1

Capability: `gate-tooling`. Requirement: `req~gate-tooling-trace-paths~2` (MODIFIED from `~1`).
No feature flag. Order: S0, then S1.

## S0. OpenSpec change (specifier, low risk)

- [x] S0.1 Write `proposal.md`, `design.md`, `tasks.md` and the delta `specs/gate-tooling/spec.md`.
- [ ] S0.2 `openspec validate prop-20261027-1 --strict` (G1).
- Files: `openspec/changes/prop-20261027-1/**`.

## S1. CI trace step reads `lab`, `tools`, `.github/workflows` (implementer, high risk by rule), after S0

- [ ] S1.1 Test first in `lab/tests/test_ci_gate_tooling.py`: keep `G6_PATHS` (it still pins
      `.agentic/project.yaml`), add `CI_TRACE_PATHS = [*G6_PATHS, "lab", "tools", ".github/workflows"]`, assert the
      trace loop against it in `test_trace_step_covers_g6_paths_report_only` and move its tag to
      `[utest->req~gate-tooling-trace-paths~2]`. The test fails on the base (red).
- [ ] S1.2 Change only the `for path in` list of the trace step in `.github/workflows/ci.yml` to the nine paths.
- [ ] S1.3 The test file is green, including `test_project_yaml_g1_g6_stay_todo_with_notes` and the other `trace`-job
      tests.
- Files: `.github/workflows/ci.yml` (the path list only), `lab/tests/test_ci_gate_tooling.py` (the constants and
  `test_trace_step_covers_g6_paths_report_only` only).
- Checks (`cwd: openbinding-gateway`): `uv sync --locked --extra test`; red-before
  `uv run --locked --extra test pytest -q ../lab/tests/test_ci_gate_tooling.py -k trace_step_covers_g6_paths`;
  `uv run --locked --extra test pytest -q ../lab/tests/test_ci_gate_tooling.py`; `lab-static`.
- Evidence beyond the checks: the PR's own `trace` job logs the nine paths and its defects; `ci-required` stays green.
- Size: about 1 line of YAML and 5-8 lines of test.

## Archive (after merge)

- [ ] A.1 `openspec archive prop-20261027-1 --yes` in an archive task, then `openspec validate --all --strict` and
      the trace.

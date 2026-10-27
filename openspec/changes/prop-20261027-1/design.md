# Design: prop-20261027-1

## Context

The `trace` job downloads OpenFastTrace 4.11.0, verifies its checksum and then runs
`trace -o plain` over a fixed path list in a `continue-on-error: true` step (`.github/workflows/ci.yml:285-292`).
The static test `lab/tests/test_ci_gate_tooling.py::test_trace_step_covers_g6_paths_report_only` pins that list to
the constant `G6_PATHS` (`:39,200-202`). The same constant also pins the G6 `oft-trace` argv in
`.agentic/project.yaml:62` through `test_project_yaml_g1_g6_stay_todo_with_notes` (`:272-285`), and that file is
R11, owner only (intake F5).

## Decisions

1. **Append, do not reorder.** The new list is
   `openspec/specs openbinding-gateway/src openbinding-gateway/tests engines frontend/src acceptance lab tools .github/workflows`.
   The requirement keeps "in that order", and appending keeps the workflow diff to one line. Considered: sorting
   the list (rejected: it changes the existing order for no gain).
2. **`.github/workflows`, not `.github`.** Only `ci.yml` holds tags there. `.github/pull_request_template.md:6` holds
   the placeholder `req~<capability>-<slug>~N`, which is not a spec item (intake F4).
3. **`lab` and `tools` as whole directories.** Neither holds Markdown, so OpenFastTrace imports no extra spec items
   from them, only coverage tags (intake F11, F13).
4. **CI and `project.yaml` may differ.** The test keeps `G6_PATHS` (the six paths, still pinning
   `project.yaml`) and adds a CI-only constant with the three extra paths. `req~gate-tooling-project-yaml-notes~1`
   stays unchanged. Coordinator decision CRP-2: `.agentic/project.yaml` is left untouched in this change; widening
   the local argv is a separate owner change that would move that requirement to `~2`.
5. **New revision `~2`.** The obligation changes (three more paths, a different absent-path count), so every tag on
   `~1` has to be re-checked. The only one is `lab/tests/test_ci_gate_tooling.py:195`, which S1 moves to `~2`.
6. **`Needs: utest` only.** The obligation is proven by the static test. No `impl` is required: the workflow line
   carries no tag today, and S1 owns only the path list in `ci.yml`.
7. **No feature flag.** CI configuration, one atomic line in a report-only step. Reverting the line is the rollback.

## Risks

- **More defects on the first wider run** (inference from intake F9-F11, not executed). Tags under `lab/`, `tools/`
  and `ci.yml` point at ids declared only in unarchived changes, and some `~2` tags point at ids whose living
  revision is still `~1`. Expected orphaned-link families:
  - `ci-speed`: `ci-speed-change-detection~1`, `ci-speed-job-timeouts~1`, `ci-develop-push~2`,
    `ci-develop-push-concurrency~2`, `gate-tooling-bim-toolchain-tests~2`;
  - `m05-pr-previews`: `lab-deployment-preview-on-demand~1`, `lab-deployment-single-loopback-port~2`;
  - `m41-space-bootstrap`: `lab-space-bootstrap-creates~1`, `lab-space-no-direct-http~1`;
  - `m45-lab-pricing-wiring`: `lab-deployment-pricing-profile-optional~2`.

  Mitigation: the step stays report-only; the PR of S1 records its own trace defects grouped by the change that
  declares each missing id; the links resolve as those changes are archived.
- **"A CI run into `develop` exits 0" moves further away.** That condition gates both `continue-on-error` and the
  `todo: true` of G1/G6. Accepted: visibility of the drift is the purpose of the change.
- **Review level.** `.github/**` is R10, high by rule (`REVIEW.md:23,27`). Coordinator decision CRP-1: S1 keeps the
  high panel unless the owner lowers it.
- **Collisions.** S1 is serialized with any open task that owns `ci.yml` or `test_ci_gate_tooling.py`.

## Migration

None. No data, API or schema. Rollback is reverting the one workflow line and the test constant.

## Open questions

- CRP-1 (owner): lower S1 to the low panel through a recorded override (`REVIEW.md:102-106`)? Default without an
  answer: high panel.
- CRP-2 (owner, non-blocking): should the local G6 argv in `.agentic/project.yaml` follow the CI list later?
  Default: no change now.

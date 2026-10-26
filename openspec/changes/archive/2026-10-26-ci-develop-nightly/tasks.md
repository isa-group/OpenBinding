# Tasks: ci-develop-nightly

One slice, one PR into `develop`. Risk high by path (R10). Owned: `.github/workflows/nightly.yml` (new),
`lab/tests/test_ci_nightly.py` (new), this change. Read-only: `.github/workflows/ci.yml`, `lab/tests/test_ci_triggers.py`,
`REVIEW.md`, `.agentic/project.yaml`.

- [x] 1. Test: `lab/tests/test_ci_nightly.py` with `test_nightly_triggers_only_on_a_schedule`,
  `test_nightly_has_one_off_hour_cron`, `test_nightly_permissions_are_actions_write_only`,
  `test_nightly_is_one_job_with_one_gh_step_and_no_actions_or_secrets`,
  `test_nightly_run_line_has_no_expression_and_no_checkout`, `test_nightly_dispatches_ci_on_develop_only` and
  `test_ci_can_be_dispatched_and_has_no_schedule`, tagged `[utest->req~...~1]`. All but the last are red on the base.
- [x] 2. `.github/workflows/nightly.yml` as in design.md.
- [ ] 3. Review: panel for high risk (`reviewer`, `test-reviewer`, `security-auditor`, `arch-reviewer`) and owner
  review through CODEOWNERS. The security-auditor checks the `actions: write` scope. The PR says that the nightly
  starts only after a release to `main`.

Checks (`cwd: openbinding-gateway`):
`["uv","run","--locked","--extra","test","pytest","../lab/tests/test_ci_nightly.py"]` (red before, green after),
then `../lab/tests/test_ci_gate_tooling.py`, then `../lab/tests`.

G1: `["openspec","validate","ci-develop-nightly","--strict"]`.

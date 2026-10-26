# Tasks: ci-develop-triggers

One slice, one PR into `develop`. Risk high by path (R10). Owned: `.github/workflows/ci.yml` (`on:`, a new
top-level `concurrency:` block and the changelog step `if`), `lab/tests/test_ci_triggers.py` (new). Read-only: this change,
`lab/tests/test_ci_gate_tooling.py`, `REVIEW.md`, `.agentic/project.yaml`.

- [x] 1. Test: `lab/tests/test_ci_triggers.py` with `test_ci_runs_on_push_to_develop`,
  `test_triggers_leave_permissions_and_pull_request_unchanged`, `test_push_concurrency_cancels_only_push_runs`,
  `test_ci_can_be_dispatched_manually` and `test_changelog_check_runs_only_on_pull_requests`, tagged
  `[utest->req~...~1]`. The first four are red on the base.
- [x] 2. `ci.yml`: the `on:` and `concurrency:` blocks of design.md and the `if` of the `frontend` changelog step; no
  other byte changes.
- [ ] 3. Review: panel for high risk (`reviewer`, `test-reviewer`, `security-auditor`, `arch-reviewer`) and owner
  review through CODEOWNERS. The PR reports its own CI run and, after the merge, the first push run on `develop`.

Checks (`cwd: openbinding-gateway`):
`["uv","run","--locked","--extra","test","pytest","../lab/tests/test_ci_triggers.py"]` (red before, green after),
then `["uv","run","--locked","--extra","test","pytest","../lab/tests"]`.

G1: `["openspec","validate","ci-develop-triggers","--strict"]`.

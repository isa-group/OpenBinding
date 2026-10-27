# Tasks: ci-action-pins

S1 and S2 both edit `.github/workflows/ci.yml`, so they run in series. Both are risk area R10 (high review panel:
reviewer, test-reviewer, security-auditor, arch-reviewer). Checks are the proposed ones of intake §4
(`cwd: openbinding-gateway` unless noted): C1 `uv sync --locked --extra test`; C3 pytest over
`lab/tests/test_ci_action_pins.py`, `test_ci_gate_tooling.py`, `test_ci_triggers.py`, `test_ci_nightly.py` and
`test_ci_changes.py`; C4 `lab-static` (timeout about 900 s); C5 `git diff --check` (`cwd: .`).

## S0 OpenSpec change (specifier, low)
- [x] 0.1 `proposal.md`, `design.md`, `tasks.md` and the `gate-tooling` delta: MODIFIED
      `req~gate-tooling-pinned-steps~2`, ADDED `req~gate-tooling-checkout-credentials~1`.
- [ ] 0.2 G1: `openspec validate ci-action-pins --strict` (not registered for S0; `openspec-validate` is `todo: true`,
      `.agentic/project.yaml:34`).
- Files: `openspec/changes/ci-action-pins/**`.

## S1 Pin every action by commit SHA (implementer, high by area)
- [ ] 1.1 Re-verify the five SHAs of design.md against their tags by lookup; pin the commit, not an annotated tag
      object.
- [ ] 1.2 In `ci.yml`, each of the 26 `uses:` becomes `<owner>/<action>@<sha> # v<x>.<y>.<z>`; the `with:` blocks stay.
- [ ] 1.3 `test_ci_gate_tooling.py` and `test_ci_triggers.py` compare action names (`uses` cut at `@`); they pass on
      the base and after 1.2. Retag `test_gate_jobs_pin_versions_and_add_no_actions` to
      `[utest->req~gate-tooling-pinned-steps~2]`.
- [ ] 1.4 New `lab/tests/test_ci_action_pins.py`, `[utest->req~gate-tooling-pinned-steps~2]`: every root workflow
      `uses:` (step and job level) is `<owner>/<action>@<40 hex>` with a `# vX.Y.Z` comment of the table's major, one
      pin per action, names equal to the table; control cases for a tag, a short SHA, no comment, upper case, another
      major and a second SHA.
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_action_pins.py`, `lab/tests/test_ci_gate_tooling.py`,
  `lab/tests/test_ci_triggers.py`. Checks: C1, red-before overlay of the new test (exit 1, pattern `@v4`), C3, C4, C5;
  GitHub: the PR run with every area green.
- Depends on S0.

## S2 Drop persisted checkout credentials (implementer, high by area)
- [ ] 2.1 `persist-credentials: false` on the checkouts of `changes`, `ci-required`, `bim-corpus`, `bim-toolchain`,
      `lab`, `engines`, `frontend` and `frontend-e2e`.
- [ ] 2.2 Extend `test_workflow_is_hardened` to every job, `[utest->req~gate-tooling-checkout-credentials~1]`, with
      the exception list `{gateway-unit, test}` that fails when a listed job stops running remote git; keep the
      message `credentials persist`.
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py`. Checks: C1, red-before overlay of the test
  on the S1 head (exit 1, pattern `credentials persist`), C3, C4, C5; GitHub: the PR run with every area green.
- Depends on S1 merged into `develop`.

## Owner items (non-blocking)
- CRP-1: how pins are kept current; recommended option (b), the weekly dependencies audit (design.md).
- Q3: the constitution 10.5 GAP sentence after S1 merges (design.md).

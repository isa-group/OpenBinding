# Handoff: prop-20261027-3
- Status: waiting-review (intake written; no code) · Updated: 2026-10-27
- Branch / head: task/e5f7486b78274ca4 / base 5a47e475 · PR: none

## Goal
Pin every `uses:` of the root workflows to a full commit SHA, keeping the tag as a comment, and drop persisted git
credentials where no job needs them. This closes the constitution 10.5 GAP (`constitution.md:124-129`) for INTENT O8
(`INTENT.md:169,218`).

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261027-3/intake.md` (facts F1-F12, slices S0-S2, gates, questions).
- Confirmed: 26 tag-pinned `uses:` in `.github/workflows/ci.yml` (lines listed in F1). There are none in `nightly.yml`
  (`lab/tests/test_ci_nightly.py:124`).
- Confirmed: only `openspec` and `trace` set `persist-credentials: false` (`ci.yml:241,268`).
- Found: the living spec names the five actions by tag (`openspec/specs/gate-tooling/spec.md:87-102`,
  `req~gate-tooling-pinned-steps~1`), so the change needs revision `~2`.
- Found: lab tests match the literal `@vN` (`lab/tests/test_ci_gate_tooling.py:40-46,97-100,155,177,246-249,259,697-698,725-727,768`;
  `lab/tests/test_ci_triggers.py:177,208`). An edit of ci.yml alone fails CI job `lab`.
- Found: `gateway-unit` and `test` run `git ls-remote`/`git fetch origin`, with a warning-and-skip fallback (`ci.yml:353-360,431-438`).
- Not found in the tree: R1-SEC-001, R1-SEC-004 (for this change) and followup `b4c4b3d5956543bf`.
- Pin targets looked up on 2026-10-27 (intake §2 table, GitHub refs API). They are data to re-verify, not repository facts.
- No code was written and no check was run (none are registered for this task).

## Decisions
- D1: three slices: S0 OpenSpec change, S1 pins, S2 credentials. Reason: one capability per slice. S1 and S2 share
  `ci.yml`, so they run in sequence.
- D2: S1 and S2 are high risk by area (R10 `.github/**`, `.agentic/project.yaml:134-136`), with the high review panel.
  The change itself is mechanical. The proposal's "low" describes the behaviour risk.
- D3: no feature flag. Reason: a workflow cannot be flagged, and each slice is one revertable commit.
- D4: the existing CI tests are made pin-agnostic (they compare the action name), and the pin rule goes in a new
  `lab/tests/test_ci_action_pins.py`. Reason: a clean red-before overlay, and later workflow edits do not churn tests.
- D5: keep the credential on `gateway-unit` and `test` (allow-list in the S2 test). Reason: their remote fetch fails
  silently into a skip (F4).
- D6: pin each action to the commit its major tag points to today. Reason: same behaviour as now. Pin the commit, not
  the annotated tag object (setup-uv `v6`).

## Ruled out
- Editing ci.yml without the tests: F7 makes CI job `lab` fail.
- Pinning the nested `bim-toolchain/.github` workflows here: R7, not run by GitHub, and already guarded as `PIN-PENDING` (F10).
- Dependabot in this change: it is a new tool and an owner decision (CRP-1).
- Bumping any action major: out of scope. Same versions only.

## Open questions and risks
- CRP-1 (owner): who keeps the pins current. Recommended: the weekly dependencies audit (`project.yaml:160`). This does
  not block S1 or S2.
- Q3 (owner): remove the GAP sentence at `constitution.md:128-129` after S1 merges (owner-only file).
- Q1, Q2, Q4, Q5 (coordinator): one PR or two, the credential allow-list, ordering with m91 S2 (which also edits `ci.yml`
  job `lab`), and the nested workflows.
- Risk: a SHA that resolves but is not the tag in the comment. Mitigation: the implementer and the security-auditor each
  verify by lookup. PR CI only proves that the SHA resolves.
- Risk: the full CI per PR (a ci.yml change runs every area, `tools/ci_changes.py:78`). Accepted. It is also the proof.

## Next three steps
1. Coordinator: open OpenSpec change `ci-action-pins` (S0). It modifies `req~gate-tooling-pinned-steps~1` to `~2`
   ("every `uses:` names one of the five actions by a 40-hex commit SHA with a `# vX.Y.Z` comment of the same major")
   and adds `req~gate-tooling-checkout-credentials~1`. Raise CRP-1 and Q3 to the owner.
2. Implementer: S1 per intake §4, with checks 1-5. Re-verify the five SHAs by lookup first.
3. After S1 merges into `develop`: run S2 per intake §4, then the pr-steward attaches each PR's CI run (every area) as G5 evidence.

## Evidence
- Tasks: this intake (planner; no checks registered or run) · Heads: 5a47e475 · CI: none run for this intake.
- Lookups (2026-10-27): the GitHub refs API for actions/checkout, actions/setup-python, astral-sh/setup-uv,
  actions/setup-java and actions/setup-node (intake §2).

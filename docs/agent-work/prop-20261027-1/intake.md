# Intake: P-20261027-1, trace the lab, tools and workflow tags in the G6 OpenFastTrace step

- Kind: maintenance, size S, owner-approved, not auto-start (it edits `.github/`) · Base: `task/63328c22569e4b2f` at `5a47e475`
- INTENT objective: **O7, delivery flow** (`INTENT.md:168`). Signal to watch: "Spec drift: code without
  `[impl->req~…]` tags, specs with `GAP` evidence" (`INTENT.md:219`).
- PR checklist item this change makes meaningful for more of the repository: "G6 OpenFastTrace trace clean"
  (`.github/pull_request_template.md:21`).

## 1. Objective

Make the CI trace step (gate G6, report-only) read the coverage tags that live in `lab/`, `tools/` and
`.github/workflows/`. Then a broken or stale `utest`/`impl` tag there shows up as a trace defect on every PR,
just as it already does for the gateway, engines and frontend.

## 2. Facts checked against the code at `5a47e475`

| # | Fact | Evidence |
|---|---|---|
| F1 | The trace step loops over `openspec/specs openbinding-gateway/src openbinding-gateway/tests engines frontend/src acceptance`. It skips absent paths and runs the jar with `trace -o plain "${paths[@]}"` | `.github/workflows/ci.yml:285-292` |
| F2 | The step is report-only (`continue-on-error: true`). The download and checksum steps are not | `ci.yml:282-286`; `lab/tests/test_ci_gate_tooling.py:186-191` |
| F3 | Tag counts outside the traced paths match the proposal: 276 in 14 files under `lab/` (`test_previews.py` 71, `test_space_lab_bootstrap.py` 47, `test_lab_pricing_profile.py` 42, `test_ci_gate_tooling.py` 27, `test_ci_changes.py` 27, `test_ci_triggers.py` 13, `test_ci_nightly.py` 9, `test_ci_shard.py` 9, `previews/previews.py` 9, `test_no_direct_space_http.py` 8, `test_lab_compose.py` 7, `test_preview_isolation.py` 4, `test_lab_compose_config.py` 2, `test_lab_process_profiles.py` 1), 3 under `tools/` (`ci_required.py`, `ci_changes.py`, `ci_shard.py`) and 4 in `ci.yml` (`:20,45,332,515`). Total: 283 in 18 files | grep `\[(impl\|utest\|itest\|dsn)->[a-z]+~` over `lab`, `tools`, `.github` |
| F4 | `.github/workflows/nightly.yml` has no tag. `.github/pull_request_template.md:6` holds the placeholder `req~<capability>-<slug>~N`. `.github/CODEOWNERS` has none | same grep; `pull_request_template.md:6` |
| F5 | The static test pins the loop to the constant `G6_PATHS` (`test_ci_gate_tooling.py:39,200-202`). **The same constant also pins the G6 argv in `.agentic/project.yaml`** (`test_ci_gate_tooling.py:280`; `project.yaml:62`). Appending paths to `G6_PATHS` alone would therefore break `test_project_yaml_g1_g6_stay_todo_with_notes`. Changing `project.yaml` is R11 | `test_ci_gate_tooling.py:272-285`; `project.yaml:137-139` |
| F6 | The living requirement names the six paths, "in that order": `req~gate-tooling-trace-paths~1`. Its scenario says "traces the five other paths". A wider list is a behaviour change, so it needs a new revision `~2` | `openspec/specs/gate-tooling/spec.md:57-72` |
| F7 | `req~gate-tooling-project-yaml-notes~1` requires `oft-trace` to keep "its six paths" | `openspec/specs/gate-tooling/spec.md:104-115` |
| F8 | No unarchived change touches either requirement | grep `gate-tooling-trace-paths\|Trace over the G6 paths\|Factory configuration notes` in `openspec/changes` without `archive/`: no match |
| F9 | Many of the ids tagged under `lab/`, `tools/` and `ci.yml` are declared only in **unarchived** changes, not in `openspec/specs`. Examples: `ci-speed-change-detection~1`, `ci-speed-job-timeouts~1`, `ci-develop-push~2`, `ci-develop-push-concurrency~2`, `gate-tooling-bim-toolchain-tests~2` (`openspec/changes/ci-speed/specs/gate-tooling/spec.md:6,37,67,100,233`); `lab-deployment-preview-on-demand~1` and `lab-deployment-single-loopback-port~2` (`m05-pr-previews/specs/lab-deployment/spec.md:6,37`); `lab-space-bootstrap-creates~1` and `lab-space-no-direct-http~1` (`m41-space-bootstrap/specs/lab-deployment/spec.md:35,123`); `lab-deployment-pricing-profile-optional~2` (`m45-lab-pricing-wiring/specs/lab-deployment/spec.md:46`). For those families, `openspec/specs` declares only `gate-tooling-bim-toolchain-tests~1`, `ci-develop-push~1`, `ci-develop-push-concurrency~1`, `ci-develop-dispatch~1`, `ci-develop-changelog-pr-only~1`, `ci-develop-nightly~1`, `ci-develop-nightly-develop-only~1` and `lab-deployment-single-loopback-port~1` | `openspec/specs/gate-tooling/spec.md:203,292,312,332,345,358,379`; `openspec/specs/lab-deployment/spec.md:18` |
| F10 | No living spec declares `Needs:`, so the living specs produce no "uncovered" defects. The new defects come from tags whose target is missing (orphaned links) | grep `^Needs:` in `openspec/`: hits only under `openspec/changes/**` |
| F11 | OFT 4.11.0's tag importer scans `.py`, `.yml`, `.yaml`, `.json`, `.sh` and `.toml`, among others. A coverage link whose target does not exist ("orphaned") is a defect, and `trace` exits non-zero | lookup (deep, medium confidence): `https://raw.githubusercontent.com/itsallcode/openfasttrace/4.11.0/importer/tag/src/main/java/org/itsallcode/openfasttrace/importer/tag/TagImporterFactory.java`, `https://github.com/itsallcode/openfasttrace/blob/main/doc/spec/design.md` (the defect rule was read on `main`, not on the tag) |
| F12 | `.github/**` is risk area **R10, high**, and "the highest-risk area touched sets the PR risk level". `.github/` is owner-reviewed through CODEOWNERS | `REVIEW.md:23,27`; `.agentic/project.yaml:134-136`; `.github/CODEOWNERS:16` |
| F13 | `lab/` holds 25 files, `tools/` 16 top-level files, none of them Markdown. OFT therefore imports no extra spec items from these paths | glob `lab/**/*`, `tools/*` |
| F14 | The `lab` CI job runs `pytest lab/tests -q` (`ci.yml:217`). The registered `lab-static` check is `uv run --locked --extra test pytest ../lab/tests` in `openbinding-gateway` | `.agentic/project.yaml:49` |

Findings that change the proposal:

1. **The test edit is not just "extend the path list".** `G6_PATHS` also pins `.agentic/project.yaml` (F5).
   The test has to split the constant: keep `G6_PATHS` (the six paths of `project.yaml`) and add a CI-only
   `CI_TRACE_PATHS`. Otherwise the change spills into R11.
2. **The risk is high by rule, not low.** The content risk is low (F2), but `.github/**` is R10 (F12). Only the
   owner can lower it (CRP-1).
3. **A spec delta is needed.** `req~gate-tooling-trace-paths~1` lists the six paths (F6). The test tag moves to `~2`.
4. **The first wider run will report more defects, not fewer** (inference from F9-F11, NOT EXECUTED). Tags that
   point at requirements of the unarchived changes `ci-speed`, `m05-pr-previews`, `m41-space-bootstrap` and
   `m45-lab-pricing-wiring`, and the `~2` tags whose living spec is still `~1`, will be orphaned links until those
   changes are archived. That is the intended visibility. It also moves "a CI run into develop exits 0"
   (`spec.md:58`, `project.yaml:64`) further away.
5. Proposal evidence not confirmed in the repository: the three task ids it cites (`d34fb29a2aa54f04`,
   `7c9b98886c9f4ddc`, `95631626928742bd`) appear nowhere under the repository. The closest record is
   `docs/agent-work/m91-modules-skeleton/review/round2-findings.md:7` (R2-REV-001: "G6 traces
   `openbinding-gateway/src` and tests only"). The `R2-TST-003` in the repository
   (`docs/agent-work/m09-compose-only/review/round2.md:17`) is about something else. The task records may hold the
   cited followups, but this intake cannot confirm them.

## 3. Scope

In scope:

- The trace step's path list gets `lab`, `tools` and `.github/workflows`, appended after `acceptance`, so the
  existing order is unchanged: `openspec/specs openbinding-gateway/src openbinding-gateway/tests engines frontend/src acceptance lab tools .github/workflows`.
- `req~gate-tooling-trace-paths~2` (MODIFIED) in a new OpenSpec change `prop-20261027-1`.
- `lab/tests/test_ci_gate_tooling.py`: a CI-only path constant, the loop assertion against it, and the tag moved
  to `~2`.
- The PR records the defects of its own CI trace run (still report-only). pr-steward reads them with `ci_log`.

Non-goals:

- `.agentic/project.yaml` (R11). The local G6 `oft-trace` argv keeps its six paths and `todo: true` (F7, CRP-2).
- Removing `continue-on-error` from the trace step, or making G6 blocking.
- Fixing the orphaned links (F9). They disappear when `ci-speed`, `m05-pr-previews`, `m41-space-bootstrap` and
  `m45-lab-pricing-wiring` are archived. The archive tasks own that work.
- Adding `openspec/changes` to the trace. The trace's contract is the living specs, and in-flight deltas would add
  items that are not yet accepted. That is a separate decision.
- Adding all of `.github`. The PR template's placeholder (F4) is not a spec item, and no other file there holds
  tags.
- Any new action, download, permission or job. The OFT version and checksum stay as they are.
- Moving tags between directories (proposal alternative a).

## 4. Slices

Two slices, in order. No feature flag (section 6). No interface contract: no API or schema changes.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S0 | OpenSpec change: trace over the G6 paths plus lab, tools and workflows | specifier (or the coordinator), default model, low effort, about 15 turns | `openspec/changes/prop-20261027-1/**` (`proposal.md`, `design.md`, `tasks.md`, `specs/gate-tooling/spec.md`) | `openspec/specs/gate-tooling/spec.md:57-72,104-115`, this intake | about 40-60 lines | **low**: spec-only. `openspec/specs/**` is untouched until a later archive task | none |
| S1 | CI trace step reads `lab`, `tools`, `.github/workflows`; static test pins it | implementer, default model and effort, about 20 turns, test-first | `.github/workflows/ci.yml` (only line 289, the `for path in …` list), `lab/tests/test_ci_gate_tooling.py` (only the constants at `:37-39` and `test_trace_step_covers_g6_paths_report_only` at `:195-206`) | `ci.yml:258-292`, `test_ci_gate_tooling.py:272-285` (must keep passing), `.agentic/project.yaml:61-64`, S0's delta | about 1 line of YAML + 5-8 lines of test | **high by rule** (R10 `.github/**`, F12). The content risk is low: one path list in a `continue-on-error` step, no new action, permission or download. CRP-1 can lower it | S0 (requirement id `~2`); no other open task may own `ci.yml` or `test_ci_gate_tooling.py` at the same time |

S0 content (for the contract):

- MODIFIED `### Requirement: Trace over the G6 paths, report-only`, new id `req~gate-tooling-trace-paths~2`:
  "THE `trace` job SHALL run the verified jar with `trace -o plain` over those of `openspec/specs`,
  `openbinding-gateway/src`, `openbinding-gateway/tests`, `engines`, `frontend/src`, `acceptance`, `lab`, `tools`
  and `.github/workflows` that exist, in that order, in a step with `continue-on-error: true` until a CI run into
  `develop` exits 0."
- Scenario "An absent path is skipped": "logs `acceptance` as skipped and traces the other eight paths".
- New scenario "Lab and tooling tags are traced": GIVEN a `[utest->req~…]` tag in `lab/tests/` whose requirement
  is missing from `openspec/specs`, WHEN the trace step runs, THEN it reports the orphaned link and the job does not
  fail.
- `req~gate-tooling-project-yaml-notes~1` stays unchanged. `design.md` states why `project.yaml` keeps six paths
  (CRP-2) and lists the expected orphaned-link families (F9).
- Validate with `openspec validate prop-20261027-1 --strict` (G1).

S1 content (for the contract):

1. Test first. In `test_ci_gate_tooling.py`, keep `G6_PATHS` as is (it still pins `project.yaml`, `:280`). Add
   `CI_TRACE_PATHS = [*G6_PATHS, "lab", "tools", ".github/workflows"]`. In
   `test_trace_step_covers_g6_paths_report_only`, assert `loop.group(1).split() == CI_TRACE_PATHS`, and change the
   tag at `:195` to `[utest->req~gate-tooling-trace-paths~2]`. The test now fails on the base (red).
2. Change `ci.yml:289` to the nine-path list. No other line of `ci.yml` changes.
3. The test is green. `test_project_yaml_g1_g6_stay_todo_with_notes` is still green, and so are the other
   `trace`-job tests (`:174-192,226-270`).

### Proposed checks (none are registered for this proposal)

S0 (`cwd: .`): `["openspec", "validate", "prop-20261027-1", "--strict"]`. `openspec-validate` is `todo: true`
(`project.yaml:34`), so it may be NOT EXECUTED in the runner. CI runs `--all` report-only (`ci.yml:256`).

S1 (`cwd: openbinding-gateway`, the same as `lab-static`, `project.yaml:49`):

1. `["uv", "sync", "--locked", "--extra", "test"]`
2. Red-before (G3), overlay of the test file only:
   `{"argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_ci_gate_tooling.py", "-k", "trace_step_covers_g6_paths"], "type": "red_before", "expect_exit": [1], "expect_pattern": "test_trace_step_covers_g6_paths_report_only", "overlay": ["lab/tests/test_ci_gate_tooling.py"]}`
3. `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_ci_gate_tooling.py"]`
4. G5: the registered `lab-static`, `["uv", "run", "--locked", "--extra", "test", "pytest", "../lab/tests"]`
5. No YAML lint and no runner check prove that GitHub accepts the workflow. The proof is the PR's own CI run: the
   `trace` job runs and logs the nine paths, and `ci-required` stays green (`ci.yml:47-60`).

## 5. Gates per slice

| Gate | S0 (spec) | S1 (ci.yml + test) |
|---|---|---|
| G1 spec | yes, `openspec validate prop-20261027-1 --strict`. The runner entry is `todo: true` (`project.yaml:34-36`), so it may be NOT EXECUTED | same change, no new delta |
| G2 EPIC | yes, spec-auditor (threshold 2, `project.yaml:38`) | n/a |
| G3 red-before | n/a (no test) | yes, check 2: the loop assertion fails on the base's six-path list |
| G4 acceptance frozen | trivially (`acceptance/**` untouched) | trivially |
| G5 green-after | n/a | checks 3 and 4 |
| G6 trace | n/a | the test carries `[utest->req~gate-tooling-trace-paths~2]`. Locally `oft-trace` is `todo: true` (`project.yaml:62-64`), NOT EXECUTED. In CI, this PR's trace run is the first that reads `lab/tests`, so it traces its own tag. Its defect list goes into the MRP (report-only) |
| G7 contracts | n/a | n/a: no API or schema |
| G8 mutation | n/a | n/a: no production code. Every mutation entry is `todo: true` (`project.yaml:71-74`) |
| G9 quality | n/a | `ruff-gateway` does not cover `lab/tests` (`project.yaml:76`). The PR's CI run is the workflow-syntax evidence |
| G10 secrets/ownership | no secret; no R11 path (`openspec/specs/**` untouched) | no secret, permission or action added. `.github/` is owner-reviewed (`CODEOWNERS:16`). `.agentic/**` untouched. `gitleaks` is `todo: true` |
| G11 review | low panel `[reviewer]` (`project.yaml:142`) | high panel `[reviewer, test-reviewer, security-auditor, arch-reviewer]` (`project.yaml:145`; `REVIEW.md:27,35`) unless the owner lowers it (CRP-1); owner review through CODEOWNERS |
| G12 lab/UI | n/a | n/a: no runtime or UI change |
| G13 review package | n/a with a `how_to_review`: the MODIFIED requirement against `spec.md:57-72` | n/a with a `how_to_review`: the one-line `ci.yml` diff, the test diff, and the PR's `trace` job log with its defects grouped by source change (F9) |

## 6. Feature flags

None. CI configuration is not a runtime feature. S1 is one atomic step, and the trace step is report-only (F2),
so a wider list cannot block a merge. Reverting the one line is the rollback.

## 7. Open questions

Questions that need a CRP (owner):

- **CRP-1: the risk level of S1.** The proposal says low. `REVIEW.md:23,27` makes any `.github/**` change high,
  with the full four-reviewer panel. Options: (a) keep high with the full panel (the default without an answer);
  (b) the owner lowers S1 to low (reviewer only) through a recorded override (`REVIEW.md:102-106`), because the
  change is one path list in a `continue-on-error` step. Recommended: (b). The same question came up for
  `.github/` work in `docs/agent-work/prop-20261025-1/intake.md:170-172`.
- **CRP-2: should the local G6 argv in `.agentic/project.yaml` follow the CI paths?** It is R11 and owner-only
  (`project.yaml:137-139`), and `todo: true` (`:62-64`). Options: (a) keep the six paths now. S1 splits the test
  constants so CI and `project.yaml` can differ, and the change does not block (recommended); (b) the owner widens
  `project.yaml:62` in a separate owner change, and `req~gate-tooling-project-yaml-notes` moves to `~2`. Not
  blocking: S0 and S1 assume (a).

For the coordinator (no owner decision):

- Q1: `.github/workflows` or `.github`? Recommended: `.github/workflows` (F4). The proposal leaves both open.
- Q2: S0 as a new change `prop-20261027-1`, or a delta on an existing change? No unarchived change touches the
  requirement (F8). Recommended: a new change.
- Q3: serialize S1 with any open task that owns `ci.yml` or `test_ci_gate_tooling.py`. The latest CI change, #64
  (`32971e8b`), touched `ci.yml` in several slices.
- Followup: archive `ci-speed`, `m05-pr-previews`, `m41-space-bootstrap` and `m45-lab-pricing-wiring`, so the
  orphaned links of F9 resolve. Each one is a separate archive task.

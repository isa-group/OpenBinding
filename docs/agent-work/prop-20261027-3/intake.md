# Intake: P-20261027-3, pin every GitHub Action in the workflows to a full commit SHA

- Kind: security, size S, owner-approved · Base: `task/e5f7486b78274ca4` at `5a47e475`
- INTENT objective: **O8, Security**: "0 open high or critical findings at each release to `main`" (`INTENT.md:169`).
  Signal to watch: "Dependency advisories and unpinned GitHub Actions" (`INTENT.md:218`, section 10).
- Rule this work closes: constitution 10.5, "GitHub Actions pinned by commit SHA" (`constitution.md:124-125`), which
  is recorded as a GAP: "Actions in `.github/workflows/ci.yml` are pinned by major version" (`constitution.md:128-129`).
- Earlier record of the same gap: finding SEC-006 "Actions pinned by tag, not by SHA", deferred as a repository-wide
  followup (`openspec/changes/archive/2026-10-26-m03-gate-tooling/tasks.md:140`, `design.md:241`). REVIEW.md asks
  reviewers for "Actions pinned by SHA" (`REVIEW.md:62`).

## 1. Objective

Every `uses:` in the root workflows names a 40-hex commit SHA, with the release tag as a trailing comment, and a lab
static test fails when one does not. Each checkout that does no git authentication sets `persist-credentials: false`.
Behaviour stays the same: each pin is the commit that the moving major tag resolves to today.

## 2. Evidence checked against the code at `5a47e475`

| # | Fact | Evidence |
|---|---|---|
| F1 | `ci.yml` has 26 `uses:` lines, all major tags, covering five actions. `actions/checkout@v4` ×12 (33, 55, 73, 141, 197, 239, 266, 305, 347, 397, 473, 528). `actions/setup-python@v5` ×4 (84, 148, 200, 363). `astral-sh/setup-uv@v6` ×4 (94, 153, 205, 368). `actions/setup-java@v4` ×2 (271, 308). `actions/setup-node@v4` ×4 (244, 315, 478, 533). No job-level `uses:` | `.github/workflows/ci.yml` at those lines |
| F2 | `nightly.yml` has no `uses:`, and a test enforces that | `.github/workflows/nightly.yml:22-32`; `lab/tests/test_ci_nightly.py:124` |
| F3 | Only two of the 12 checkouts set `persist-credentials: false`: `openspec` and `trace` | `ci.yml:241,268` |
| F4 | Two jobs run git against `origin` after checkout (`git ls-remote origin`, `git fetch origin data/icsoc-original-dataset`), and fall back to a `::warning::` and a skip when that fails: `gateway-unit` and `test` | `ci.yml:353-360,431-438` |
| F5 | The other jobs use git only locally: `changes` runs `git diff` on a `fetch-depth: 0` checkout, `frontend` builds the changelog from `git log`, and the frontend jobs check out with `fetch-depth: 0` | `ci.yml:33-43,473-475,502-504,528-530`; `tools/generate_changelog.py:34-38` |
| F6 | **The living spec names the five actions by tag.** `req~gate-tooling-pinned-steps~1`: "THE workflow SHALL use no action other than `actions/checkout@v4`, `actions/setup-python@v5`, `astral-sh/setup-uv@v6`, `actions/setup-java@v4` and `actions/setup-node@v4`". Its scenario "No new action" compares the set of `uses:` values with these five | `openspec/specs/gate-tooling/spec.md:87-102` |
| F7 | **Existing lab tests compare `uses:` with the literal tag**, so a ci.yml edit alone makes them fail. That covers `ALLOWED_ACTIONS` and the subset assertion, `_setup()` exact match, and eight lookups by literal `@vN` | `lab/tests/test_ci_gate_tooling.py:40-46,97-100,155,177,246-249,259,697-698,725-727,768`; `lab/tests/test_ci_triggers.py:177,208` |
| F8 | A change to `ci.yml` makes the PR run every area, so PR CI exercises every pinned action | `tools/ci_changes.py:21,78`; `lab/tests/test_ci_changes.py:120-123` |
| F9 | `.github/**` is risk area R10, level high. `openspec/specs/**` is R11 (owner) | `.agentic/project.yaml:134-139` |
| F10 | The nested `bim-toolchain/.github/workflows/{ci,release}.yml` hold 24 more tag-pinned `uses:` (19 + 5; the other `uses:` matches are header comments). Each one is marked `PIN-PENDING` and has its own `tools/test_workflows.py` guard. GitHub does not run a nested `.github/` | `bim-toolchain/.github/workflows/ci.yml:4-6,44-252`; `release.yml:9-11,39-114`; `docs/qa/SECURITY_REVIEW.md:47` |
| F11 | Lab tests run in CI job `lab` (`pytest lab/tests`) and locally as the registered `lab-static` check | `ci.yml:214-217`; `.agentic/project.yaml:49` |
| F12 | An open change plans a new step in job `lab` of `ci.yml` (slice S2 of m91) | `openspec/changes/m91-modules-skeleton/design.md:190-194` |

Proposal evidence not confirmed in the repository: "R1-SEC-001", "R1-SEC-004" and followup `b4c4b3d5956543bf`. The ids
R1-SEC-00x in `docs/agent-work/` belong to other reviews: `m09-compose-only/review/round1.md:32-44` and
`m45-lab-pricing-wiring/review-round1.md:4,18`. The followup id appears nowhere in the tree. They are cited here as the
proposal gives them. The underlying gap is confirmed by F1, F3 and the constitution GAP.

### Current pin targets (data from lookups on 2026-10-27, to be re-verified by the implementer)

| Action | Major tag | Release with the same commit | Commit SHA | Sources |
|---|---|---|---|---|
| actions/checkout | v4 | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` | `api.github.com/repos/actions/checkout/git/refs/tags/v4`, `.../tags/v4.4.0` |
| actions/setup-python | v5 | v5.6.0 | `a26af69be951a213d495a4c3e4e4022e16d87065` | `api.github.com/repos/actions/setup-python/git/refs/tags/v5`, `.../tags/v5.6.0` |
| astral-sh/setup-uv | v6 | v6.8.0 | `d0cc045d04ccac9d8b7881df0226f9e82c39688e` (commit). `v6` is an **annotated** tag, object `d0d8abe6...`. Pin the commit, never the tag object | `api.github.com/repos/astral-sh/setup-uv/git/refs/tags/v6`, `.../git/tags/d0d8abe699bfb85fec6de9f7adb5ae17292296ff`, `.../ref/tags/v6.8.0` |
| actions/setup-java | v4 | v4.9.1 | `cf277c60eb25467037889841efdb72551f06f6c3` | `api.github.com/repos/actions/setup-java/git/refs/tags/v4`, `.../tags/v4.9.1` |
| actions/setup-node | v4 | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `api.github.com/repos/actions/setup-node/git/refs/tags/v4`, `.../matching-refs/tags/v4` |

These are lookup answers (confidence high, read from the GitHub refs API). They are not repository facts. The
implementer re-checks each one with a lookup before writing it, and the security-auditor checks it again. PR CI proves
only that each SHA resolves, not that it matches the tag in the comment.

## 3. Scope

In scope:

- `.github/workflows/ci.yml`: replace the 26 `uses: <owner>/<action>@vN` lines with
  `uses: <owner>/<action>@<40-hex> # vN.x.y`.
- `ci.yml`: add `persist-credentials: false` to the eight checkouts that do no remote git: `changes`, `ci-required`,
  `bim-corpus`, `bim-toolchain`, `lab`, `engines`, `frontend` and `frontend-e2e` (lines 33, 55, 73, 141, 197, 305, 473
  and 528; F5).
- Lab static tests: make the existing CI tests independent of the pin (compare the action name, F7), add a pin test, and
  extend the credential hardening test.
- The OpenSpec delta for `gate-tooling`: `req~gate-tooling-pinned-steps~1` becomes `~2` (F6), plus one ADDED
  requirement for checkout credentials. The coordinator writes it. Living specs change only at archive.

Non-goals:

- `gateway-unit` and `test` keep their checkout as it is (F4). Their remote `git fetch` falls back to a warning and a
  silent skip of the ICSOC tests. Removing the credential there could therefore hide a failure. See Q2.
- The nested `bim-toolchain/.github/**` workflows (F10). They are R7, not run by GitHub, and already guarded by their own
  `PIN-PENDING` test.
- Dependabot or any other pin-update tool (proposal alternative a, see CRP-1). No new action and no `.github/dependabot.yml`.
- Changing any action's version: no bump to v5 of checkout, no new major.
- Editing `constitution.md:128-129` (the GAP line), which is owner-only (`INTENT.md:234`). See Q3.
- Adding `.github` to the G6 trace paths (`ci.yml:289`). That is proposal P1 of the same night.
- The backlog items: the `ci_required` skipped-job rule (R1-SEC-003), `ci_shard` collection parity (R1-SEC-002), the
  blocking G1 step, branch protection, and M0.8.

## 4. Slices

Two slices in order. Both edit `ci.yml`, so they cannot run in parallel. No feature flag is possible or needed: a
workflow is not runtime code, each slice stands alone, and each is reverted by one revert commit. No interface contract
(OpenAPI or JSON Schema) is involved.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S0 | OpenSpec change `ci-action-pins`: proposal, design and tasks, plus a `gate-tooling` delta with MODIFIED `req~gate-tooling-pinned-steps~2` and ADDED `req~gate-tooling-checkout-credentials~1` | specifier (coordinator may do it), default model, low effort, about 15 turns | `openspec/changes/ci-action-pins/**` | this intake, `openspec/specs/gate-tooling/spec.md:87-102`, `openspec/changes/ci-speed/specs/gate-tooling/spec.md` (open delta on the same capability, different requirements) | about 60-90 lines | **low**: spec text only. The archive later touches R11 `openspec/specs/**` with owner approval | none |
| S1 | Pin the 26 `uses:` by commit SHA, with the tag comment, and the pin test (R1-SEC-001) | implementer, default model, medium effort, about 30 turns | `.github/workflows/ci.yml`, `lab/tests/test_ci_action_pins.py` (new), `lab/tests/test_ci_gate_tooling.py`, `lab/tests/test_ci_triggers.py` | §2 pin table (re-verify), F1-F8, `lab/tests/test_ci_nightly.py`, `tools/ci_changes.py` | ci.yml 26 changed lines; tests about 80-120 (outside the limit, `project.yaml:14`) | **high by area** (R10, F9). The change itself is mechanical: same commits as today | S0 written (G1) |
| S2 | `persist-credentials: false` on the eight checkouts with no remote git (R1-SEC-004) | implementer (or mechanical), default model, low effort, about 15 turns | `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py` | F3-F5, `ci.yml:33-43,353-360,431-438,502-504` | ci.yml about 13 added lines; test about 20-30 | **high by area** (R10). The behaviour risk is low: only git commands after checkout could notice | S1 merged into `develop` (same files) |

S1 content (for the contract):

1. In `ci.yml`, each `uses:` becomes `<owner>/<action>@<sha> # v<x>.<y>.<z>`. All occurrences of one action carry the
   same SHA and comment. The `with:` blocks stay as they are.
2. `test_ci_gate_tooling.py` and `test_ci_triggers.py` stop matching the literal tag. A helper returns the action name
   (`uses.split("@", 1)[0]`). `_setup(job, "actions/setup-node")` and the checkout lookups use that helper.
   `ALLOWED_ACTIONS` becomes the five names. The subset assertion at `:246-249` compares names. These edits must pass on
   the base and after S1, because they are characterization tests.
3. New `lab/tests/test_ci_action_pins.py`, tagged `[utest->req~gate-tooling-pinned-steps~2]`. It reads every
   `.github/workflows/*.yml` and `*.yaml` at the root (not `bim-toolchain/`). It checks that:
   - every `uses:` value (step-level and job-level) matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$`;
   - in the raw text, each `uses:` line ends with `# v<major>.<minor>.<patch>`, and the major equals the one in a
     reviewed in-test table `{name: (major, sha, tag)}` (v4/v5/v6/v4/v4, F1);
   - the SHA and comment equal the table entry, so one action has one pin, and the set of names used equals the table;
   - control cases (`_swap`-style, as in `lab/tests/test_space_lab_bootstrap.py:454-529`): a tag (`@v4`), a short SHA, a
     40-hex SHA without a comment, an upper-case SHA, a comment with another major, and a second SHA for the same action
     are each refused by the rule function.
4. Docs: none required. The constitution GAP text goes to the owner (Q3).

S2 content: add `persist-credentials: false` under `with:` of the eight checkouts. Extend `test_workflow_is_hardened`
(`test_ci_gate_tooling.py:253-261`) to every job, tagged `[utest->req~gate-tooling-checkout-credentials~1]`: each
checkout sets `persist-credentials: false`, except an explicit allow-list `{"gateway-unit", "test"}` with the reason
(F4). A new job's checkout must state it. The test also fails if a job in the allow-list stops running remote git.

### Proposed checks (none are registered for this proposal; `cwd: openbinding-gateway` unless noted)

S1:

1. `["uv", "sync", "--locked", "--extra", "test"]`
2. Red-before (G3), overlay of the new test only:
   `{"argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_ci_action_pins.py"], "type": "red_before", "expect_exit": [1], "expect_pattern": "@v4", "overlay": ["lab/tests/test_ci_action_pins.py"]}`.
   On the base, the pin assertion fails on the tag. The test must assert and not error at collection.
3. `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_ci_action_pins.py", "../lab/tests/test_ci_gate_tooling.py", "../lab/tests/test_ci_triggers.py", "../lab/tests/test_ci_nightly.py", "../lab/tests/test_ci_changes.py"]`
4. G5: the registered `lab-static` (`["uv", "run", "--locked", "--extra", "test", "pytest", "../lab/tests"]`,
   `project.yaml:49`). Use a check timeout of about 900 s.
5. G9: `["git", "diff", "--check"]` (`cwd: .`). Ruff is optional: no ruff config was found in `lab/` or at the root,
   and `ruff-gateway` checks only `src tests` (`project.yaml:76`).

S2: checks 1, 3, 4 and 5. Red-before (G3) is an overlay of the edited test file on the S1 head:
`{"argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_ci_gate_tooling.py", "-k", "hardened"], "type": "red_before", "expect_exit": [1], "expect_pattern": "credentials persist", "overlay": ["lab/tests/test_ci_gate_tooling.py"]}`
(`credentials persist` is the existing message at `test_ci_gate_tooling.py:261`, which the extension keeps).

The real proof for both slices is the PR's CI run on GitHub: every area runs (F8), and an unresolvable SHA fails
"Unable to resolve action". The pr-steward attaches it with `ci_status`.

## 5. Gates per slice

| Gate | S0 (spec) | S1 (pins) | S2 (credentials) |
|---|---|---|---|
| G1 spec | `openspec validate --strict`. `openspec-validate` is `todo: true` (`project.yaml:34`), so it is NOT EXECUTED locally. CI job `openspec` is report-only (`ci.yml:254-256`) | same change | same change |
| G2 EPIC | spec-auditor, threshold 2 | n/a | n/a |
| G3 red-before | n/a | check 2 | overlay check (see above) |
| G4 acceptance frozen | trivially: no `acceptance/**`. CI static checks live in `lab/tests` (existing pattern, F7) | trivially | trivially |
| G5 green-after | n/a | checks 3, 4 and PR CI with every area | checks 3, 4 and PR CI |
| G6 trace | requirement ids exist | `[utest->...]` in the new test. `oft-trace` is `todo: true` (`project.yaml:62`), and `.github` is not a trace path (`ci.yml:289`), so `[impl->...]` in ci.yml is not traced | same |
| G7 contracts | n/a | n/a: no API or schema | n/a |
| G8 mutation | n/a | n/a: all mutation checks `todo: true` (`project.yaml:71-74`); the control cases in the pin test stand in | n/a |
| G9 quality | n/a | check 5 | check 5 |
| G10 secrets/ownership | no R11 file outside the change dir | `.github/**` is R10, not R11. `.github/CODEOWNERS` untouched. No secret | same; reduces the token's reach |
| G11 review | low panel `[reviewer]` | **high** panel `[reviewer, test-reviewer, security-auditor, arch-reviewer]` (`project.yaml:145`, R10). The security-auditor re-verifies each SHA against its tag | **high** panel (R10) |
| G12 lab/UI | n/a | n/a: no runtime or UI. PR CI is the evidence | n/a |
| G13 review package | n/a with `how_to_review` | n/a with `how_to_review`: the pin table against the lookup sources, then the test | n/a with `how_to_review`: the eight checkouts and the two excluded jobs |

## 6. Feature flags

None. A workflow file cannot be flag-guarded. Each slice is complete alone and leaves CI working. Rollback is a revert
of the slice's squash commit.

## 7. Open questions

Needs a CRP (new tool or owner-only file; `INTENT.md:232,234`):

- **CRP-1: who keeps the pins current.** A SHA pin freezes an action. Security fixes in v4.x then need a manual bump.
  Options: (a) Dependabot `github-actions` updates with SHA pins (a new `.github/dependabot.yml`, proposal alternative
  a; owner decision); (b) the existing weekly `dependencies` audit, which already watches "unpinned Actions"
  (`project.yaml:160`), also checks pinned SHAs against the latest release of the same major and opens a bump proposal;
  (c) nothing until a finding. Recommended: (b) now. The answer does not block S1 or S2.

For the owner, no CRP needed to start:

- Q3: after S1 merges, the GAP sentence at `constitution.md:128-129` is no longer true. Only the owner edits the
  constitution (`INTENT.md:234`). Recommended: the owner removes "Actions ... pinned by major version" from the GAP and
  adds `lab/tests/test_ci_action_pins.py` to "Enforced".

For the coordinator (no owner decision):

- Q1: one PR or two. Recommended: two (one capability each, R1-SEC-001 then R1-SEC-004). Each PR runs the full CI
  (F8). If CI time matters more, S1 and S2 can share one PR as two commits, with the same panel.
- Q2: `gateway-unit` and `test` keep the persisted credential (F4). The repository is public (`INTENT.md:196`), so an
  anonymous fetch would probably work. But the step turns any failure into a warning and a silent skip, so the change
  could hide lost coverage. Recommended: leave them, and record the allow-list in the S2 test. A later slice can drop it
  once the fallback fails loudly.
- Q4: order with m91 S2, which adds a step to job `lab` (F12). The edits are on different lines. Whichever lands second
  rebases, and its test must use the action-name helper from S1.
- Q5: the nested `bim-toolchain/.github` workflows (F10) stay out. They are pinned when the toolchain moves to its own
  repository, under its own `PIN-PENDING` test.

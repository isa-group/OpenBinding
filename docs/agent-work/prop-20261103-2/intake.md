# Intake: P-20261103-2, stop the committed changelog JSON from costing every change an extra commit

- Kind: dx, size S, owner-approved · Base: `task/61de66fca0ba4d9c` at `b8067258` ("docs(roadmap): record M0.8, M0.9
  and M2.7 as partly delivered (#79)").
- INTENT objective: **O7, Delivery flow** (also O6: PR CI stays green).
- Planner limits: no Bash and no repo tool, so neither `git log` nor CI runs were read. Every claim below comes from
  files in the tree at `b8067258`.

## 1. Objective

A pull request into `develop` no longer needs a final `chore(changelog)` commit to get green CI. The public changelog
JSON (`frontend/src/content/changelog.generated.json`) is regenerated once per release, on the `release/vX.Y.Z`
branch, by the release role. The docs that teach the old rule (lessons item 2, CONTRIBUTING, AGENTS, DoD, PR template,
generator docstring) describe the new one.

## 2. Findings, checked at `b8067258`

| # | Claim | Verified state | Evidence |
|---|---|---|---|
| F1 | The `--check` step runs on every PR | **Confirmed.** Step `Check generated changelog`, `if: github.event_name == 'pull_request'`. CI runs on PRs into both `main` and `develop`. | `.github/workflows/ci.yml:3-7,500-504` |
| F2 | The JSON is derived from `git log baseline..HEAD`; later commits make it stale | **Confirmed.** Only the scope `changelog` and commits that touch nothing but `MAINTENANCE_PATHS` are skipped. Any path under `docs/` adds a documentation entry. | `tools/generate_changelog.py:27-31,34-49,62,91-94,127-129` |
| F3 | Lessons item 2 records the trap | **Confirmed.** | `docs/lessons.md:6` |
| F4 | PR #79 round 1 had a blocker for this alone | **Confirmed.** | `docs/agent-work/prop-20261102-1/handoff.md:1,3` |
| F5 | The coordinator took over regeneration by hand | **Confirmed.** | `docs/agent-work/m0-infra-close/handoff.md:3`; `docs/agent-work/m4-plans-wave0/handoff.md:2` |
| F6 | A task cap was hit before the regeneration task | **Confirmed.** | `docs/agent-work/ci-speed/handoff.md:4` |
| F7 | The develop-push variant was a major | **Confirmed.** It is also the reason the `if` exists (coordinator option A). | `docs/agent-work/ci-develop-push-2/handoff.md:3,5` |
| F8 | 56 files under `docs/agent-work/` mention the changelog | **Confirmed** (Grep, case-insensitive: 111 occurrences in 56 files). | Grep count |
| F9 | Followups d57e0060abc54294 and 93d43ffc4d834a9f | **Partly.** The ids appear in three files; the followup text itself was not read. | `docs/agent-work/prop-20261102-1/plan.md`, `prop-20261102-2/intake.md`, `prop-20261102-2/handoff.md` |
| F10 | (not in the proposal) A **living requirement** pins the current step | `req~ci-develop-changelog-pr-only~1` says the frontend job SHALL run the check on every pull request. Dropping or narrowing the step breaks this requirement, so the change needs a spec delta. | `openspec/specs/gate-tooling/spec.md:342-353` |
| F11 | (not in the proposal) A **lab test** enforces F10 | `test_changelog_check_runs_only_on_pull_requests` asserts exactly one `--check` step with the `if` above. It also asserts that no other step has an `event_name` condition. This test must change, and it gives the red-before (G3). | `lab/tests/test_ci_triggers.py:144-162` |
| F12 | (not in the proposal) The **factory gate** and the daily audit run the check | G9 `changelog` and daily `cheap_checks` both run `--check`. `.agentic/**` is R11 (owner only). If they stay, every task contract that lists G9 `changelog` fails on a branch that has not regenerated the JSON. | `.agentic/project.yaml:83,139,152` |
| F13 | (not in the proposal) **Risk level is high, not low** | `.github/**` is R10 (high), and the highest area touched sets the PR level. The high panel is reviewer, test-reviewer, security-auditor and arch-reviewer. | `REVIEW.md:23,27,35`; `.agentic/project.yaml:134-136,145` |
| F14 | (not in the proposal) More docs teach the old rule | CONTRIBUTING, AGENTS (command list and conventions), DoD (per-change item and release item), PR template checklist. | `CONTRIBUTING.md:35-38`; `AGENTS.md:95,117-120`; `docs/DEFINITION_OF_DONE.md:29,34`; `.github/pull_request_template.md:35` |
| F15 | (not in the proposal) Open changes list the check in their task contracts | G9 `changelog` argv or a final `chore(changelog)` task. | `openspec/changes/m24-sunset/tasks.md:23`; `m96-remove-retired/tasks.md:32`; `prop-20261026-1/tasks.md:43-45`; `m0-infra-close/tasks.md:117` |
| F16 | "the release role already writes the changelog" | **Not verifiable in the repository.** No release procedure file exists. The only in-repo release text is the DoD release section ("Release MRP, changelog, …"). The release role's brief is factory-side. | Glob (no `RELEASE*.md`, no `CHANGELOG.md`); `docs/DEFINITION_OF_DONE.md:32-35`; `CONTRIBUTING.md:13-16` |
| F17 | (not in the proposal) Constraints on editing the generator | `tools/generate_changelog.py` is in `INFRASTRUCTURE` of `test_no_local_pricing.py` (retired names must not appear). `tools/ci_changes.py` treats the JSON path as "no area", which stays correct. | `openbinding-gateway/tests/test_no_local_pricing.py:43-50,104-108`; `tools/ci_changes.py:20,39` |

## 3. Scope and non-goals

In scope (option (b) of the proposal, variant per Q1):
- `ci.yml`: the PR check stops running on PRs into `develop`. **Recommended variant b2:** keep it on PRs into `main`
  (`if: github.event_name == 'pull_request' && github.base_ref == 'main'`), so the release PR (and a hotfix PR,
  `CONTRIBUTING.md:16`) still cannot publish a stale JSON. Variant b1 removes the step outright. Rewrite the comment at
  `ci.yml:500-501`.
- Spec delta for `req~ci-develop-changelog-pr-only` (rev 2 under b2, REMOVED under b1), plus the lab test from F11.
- Docs: lessons item 2, generator docstring and its `MAINTENANCE_PATHS` comment, CONTRIBUTING, AGENTS, DoD, and the PR
  template line (F14). The release step goes into the DoD release section: "regenerate the changelog as the last
  commit of `release/vX.Y.Z` (and of a `hotfix/<id>` into `main`)".

Non-goals:
- Option (a) (generate at build time from git history) and option (c) (path filters in the generator).
- Changing what the generator emits, `tools/changelog-baseline`, `tools/ci_changes.py` or its tests.
- Reducing `fetch-depth: 0` of the frontend job (`ci.yml:475`). It is still needed under b2. Under b1 it is a
  separate speed followup.
- Editing `.agentic/project.yaml` (R11, Q3), the factory's release-role brief (outside the repo, Q5), and the task
  contracts of other open changes (F15, coordinator).
- Regenerating the JSON in this change. Under the new rule `develop` keeps the last committed JSON until the next
  release.

## 4. Slices

The two slices have disjoint files and can run in parallel. They **ship in one PR**: S2's docs say "no changelog
commit", which is only true once S1 lands. Together they are about 40-60 diff lines. The PR's CI evaluates its own
`ci.yml`, so this PR needs no `chore(changelog)` commit either.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S0 | OpenSpec change `prop-20261103-2`: proposal, design (variant from Q1, hotfix path, Q2 answer), tasks, delta `gate-tooling` | specifier (coordinator) · default · ~15 | `openspec/changes/prop-20261103-2/**` | this intake; `openspec/specs/gate-tooling/spec.md:342-353` | ~60 | low (spec only); the archive into `openspec/specs/**` is R11 | Q1, Q2 answered |
| S1 | CI step condition and its test | implementer · default · ~20 | `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `lab/tests/test_ci_triggers.py` | S0 delta; `ci.yml:3-13,468-505`; `lab/tests/test_ci_triggers.py:1-60,144-162` | ~20-30 | **high**: R10 `.github/**` (`REVIEW.md:23`). The behaviour change is small, but the policy sets the level | S0 |
| S2 | Docs and generator docstring | doc-steward · default, low effort · ~15 | `docs/lessons.md`, `tools/generate_changelog.py` (docstring and comment only, no code), `CONTRIBUTING.md`, `AGENTS.md`, `docs/DEFINITION_OF_DONE.md` | S0 design; F14, F17 | ~20-30 | low: R0 paths only | S0; parallel with S1, same PR |

Requirement ids: `req~ci-develop-changelog-pr-only~2` (b2, MODIFIED), or the REMOVED requirement under b1. If b2 is
chosen, S0 should rename it in words ("runs on pull requests into main only"), keeping the id with a rev bump for
trace continuity.

S1 test change (for the test-designer or implementer per the coordinator's contract): under b2, assert exactly one
`--check` step with `if: github.event_name == 'pull_request' && github.base_ref == 'main'`, and keep the rest of the
test. Under b1, assert that no frontend step runs `tools/generate_changelog.py --check`, and that no step has an
`event_name` condition. Tag `[utest->req~ci-develop-changelog-pr-only~2]`.

Proposed checks (argv arrays; none registered yet):
1. S1 red-before and green-after (lab-static form, `.agentic/project.yaml:49`), `cwd: openbinding-gateway`:
   `["uv","run","--locked","--extra","test","pytest","../lab/tests/test_ci_triggers.py","../lab/tests/test_ci_changes.py"]`.
   The edited test fails on the base `ci.yml` and passes after the step edit.
2. S1 full lab suite, `cwd: openbinding-gateway`: `["uv","run","--locked","--extra","test","pytest","../lab/tests"]`.
3. S2 generator untouched in behaviour, `cwd: .`:
   `["python3","-I","-c","import ast;ast.parse(open('tools/generate_changelog.py',encoding='utf-8').read())"]`.
4. S2 retired-name guard, `cwd: openbinding-gateway`:
   `["uv","run","--locked","--extra","test","pytest","tests/test_no_local_pricing.py"]`.
5. Both: BIM guard (registered, `.agentic/project.yaml:52`): `["python3","tools/check_bim_guard.py"]` (lessons 1).
6. Both: `["git","diff","--check"]`.
7. S0: `openspec validate --strict` (G1, `todo: true` in `.agentic/project.yaml:34`; CI job `openspec` runs it).

Do **not** put G9 `changelog` (`.agentic/project.yaml:83`) in these contracts. On this branch it passes only by
accident, and the point of the change is that it no longer gates PRs into `develop`.

## 5. Gates per slice

| Gate | S0 spec | S1 CI + test | S2 docs |
|---|---|---|---|
| G1 spec | yes: `openspec validate --strict` (check 7) | via S0 | via S0 |
| G2 EPIC | yes: spec-auditor, ≥ 2/3 | n/a | n/a |
| G3 red-before | n/a | yes: check 1 fails on base after the test edit | n/a: no test |
| G4 acceptance frozen | yes, trivially: `acceptance/**` untouched | same | same |
| G5 green-after | n/a | checks 1-2; PR CI green without a `chore(changelog)` commit | check 4; PR CI |
| G6 trace | requirement id and Evidence line updated | `[utest->req~ci-develop-changelog-pr-only~2]` | n/a |
| G7 contracts | n/a | n/a | n/a |
| G8 mutation | n/a | n/a | n/a |
| G9 quality | n/a | check 6; YAML parsed by check 1 | checks 3, 5, 6 |
| G10 secrets/ownership | archive touches `openspec/specs/**` (R11) | `.github/**` R10; no secrets, no new Action | owned files only |
| G11 review | low panel `[reviewer]` | **high panel**: reviewer, test-reviewer, security-auditor, arch-reviewer (`REVIEW.md:35`) | low `[reviewer]`; the PR level is high (F13) |
| G12 lab/UI | n/a | n/a: CI only | n/a |
| G13 review package | `how_to_review` | `how_to_test`: the PR's own CI shows the step skipped on a PR into `develop`; check 1 output | `how_to_review`: lessons, CONTRIBUTING, AGENTS, DoD, in that order |

## 6. Feature flags

None. A CI condition cannot be flag-guarded. One PR carries S1 and S2 together, so no half state reaches `develop`.

## 7. Open questions

Need a CRP (owner):
- **Q1, variant.** b1: drop the step. b2: keep it for PRs into `main` only, so release and hotfix PRs must regenerate
  as their last commit. **Recommended: b2.** It keeps a guard where the JSON is published, and the test shape stays
  the same. Risk: a pull_request run checks out the merge ref, so commits that exist only on `main` (hotfixes not yet
  back-merged) could also make the release PR stale. The release role regenerates after syncing.
- **Q2, preview lag.** Between releases the develop preview's About › Changelog shows the JSON of the last release
  (or the last manual regeneration). The proposal says "no product behaviour change". That holds for production, not
  for the develop preview. Accept, or ask for option (a) later?
- **Q3, factory gate (R11).** `.agentic/project.yaml:83` (G9 `changelog`) and `:152` (daily cheap check): remove both,
  or limit them to release tasks. Owner-only file, so this is a separate owner-approved edit, before or with the merge.
- **Q4, risk level.** The proposal says low; `REVIEW.md:23,27` makes the PR high (F13). Plan: high panel unless the
  owner waives it.
- **Q5, release-role procedure.** There is no repo release procedure to "add the regeneration to" (F16). The DoD
  release item (S2) is the in-repo part. The factory's release-role brief needs the same step, and that lives outside
  this repository.

For the coordinator (no CRP):
- After the merge, update the open task contracts that list G9 `changelog` or a final `chore(changelog)` task (F15).
- Followups d57e0060abc54294 and 93d43ffc4d834a9f become moot after the merge. Close them rather than regenerate.

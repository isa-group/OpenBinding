# Intake: P-20261104-1, rate the 12 unrated open security rows and bound M5-K

- Kind: security, size S, owner-approved · Base: `task/bda591af73c643ab` at `a8876def`
- INTENT objective: **O8, Security**: "0 open high or critical findings at each release to `main`", measured by
  "open items in `docs/qa/SECURITY_REVIEW.md`" (`INTENT.md:169`).
- Release this unblocks: R1 = M0-M2. O8 cannot pass today: under the register's own rule an open row that is
  `unrated`, or `>= medium (floor)` with no upper bound, counts as failing (`docs/qa/SECURITY_REVIEW.md:25-26`).

## 1. Objective

Every open row of the register that blocks O8 by default gets a rating proposed from evidence in the tree, with file:line
citations. The 12 unrated rows and M5-K are the rows that block it. The rows that the tree cannot decide go to the owner
in one CRP, which lists them. After the owner confirms or overrides the proposals, the release role reads O8 as a plain
yes or no.

## 2. Evidence checked against the tree at `a8876def`

| # | Fact | Evidence |
|---|---|---|
| F1 | The register says that O8 is not met. 12 open rows are unrated and M5-K is `>= medium (floor)` with no upper bound. The unrated rows are B6-1, M5-S, B8, SPHERE-1, LIC-1, m08-SEC-003, m08-SEC-004, R2-SEC-006, R2-SEC-007, R3-SEC-003, R3-SEC-004 and m09 R1-SEC-003 | `SECURITY_REVIEW.md:38-41` |
| F2 | The proposal's row lines are correct. The unrated rows are at `:66` (B6-1), `:73` (M5-S), `:74` (B8), `:79` (SPHERE-1), `:80` (LIC-1), `:87-88` (m08) and `:89-93` (R2, R3, m09). M5-K is at `:72` and M4-2 at `:75` | `SECURITY_REVIEW.md:66-93` |
| F3 | Every rating is a proposal. The editor proposes, the security-auditor confirms and the owner can override (CRP-2 option a). No rating is final until the owner confirms it | `SECURITY_REVIEW.md:10-12`, `:38-39` |
| F4 | The severity floor: a confirmed authorization, secret-handling or SSRF finding is never rated below medium. REVIEW.md blocks a merge on these at medium or higher | `SECURITY_REVIEW.md:18`; `REVIEW.md:90` |
| F5 | The register work left "a new security audit" out of scope, so nothing in flight rates these rows | `docs/agent-work/prop-20261102-2/intake.md:65` |
| F6 | **M4-2, root CI.** On a push or a manual run, the area detector does not diff and reports every area as changed. The workflow comment says the same. On a pull request the `bim-toolchain` job runs only when the bim area changed | `tools/ci_changes.py:117-118`; `.github/workflows/ci.yml:21`, `:131` |
| F7 | **M4-2, root CI.** For `bim-core`, the `bim-toolchain` job runs the package tests and then `tools/baseline_core.py --check` | `.github/workflows/ci.yml:129-187`, step `:182-187` |
| F8 | **M4-2, corpus root.** Without `BIM_CORPUS_ROOT`, both the tests and the tool use the directory that contains `bim-toolchain/`, which is the repository root of the checkout | `bim-toolchain/packages/bim-core/tests/core_support.py:16,22-25`; `bim-toolchain/tools/baseline_core.py:75,144-146` |
| F9 | **M4-2, loud failure.** `baseline_core.py` exits with code 2 when the corpus is missing. Its default `--expected` is 82, and a different package count is a failure | `baseline_core.py:1400,1405-1407,1413-1414` |
| F10 | **M4-2, a quiet skip remains.** The pytest corpus tests skip with a warning, instead of failing, when `BIM_REQUIRE_CORPUS` is not `1`. The root workflow does not set `BIM_REQUIRE_CORPUS` (no match under `.github/`), so only the tool step in F9 fails loudly. The nested job `golden-corpus`, which does set it, is still only in the nested file that GitHub does not run | `core_support.py:31-36`; `test_baseline_equivalence.py:62-65`; `bim-toolchain/.github/workflows/ci.yml:137,162` |
| F11 | **M5-K, new fact.** The lab pricing bootstrap targets the remote SPACE. It passes `DEMO_SPACE_MANAGEMENT_KEY` as `SPACE_API_KEY` to `pricing-bootstrap` (user `1000:1000`, `restart: no`) | `compose.lab-pricing.json:4-13` |
| F12 | M5-K: the gateway-side lab compose files still pass `SPACE_URL`, `SPACE_API_KEY` and `SPHERE_API_KEY` from the environment. The files are `compose.lab.json` and the four `compose.lab-process*.json` | `compose.lab.json:194-195,201,266-267,273,382-383,395`; `compose.lab-process-n2.json:197-198,204` (same shape in the other three) |
| F13 | PR #69 (2026-10-28) moved the lab to the remote SPACE `space.score.us.es` | `ROADMAP.md:22,146-147` |
| F14 | **m08-SEC-003 still applies to the code.** A missing engine or mode is recorded as `INCOMPATIBLE` with the diagnostic "engine/mode not installed" | `experimentation/qacobench/campaign.py:248,255`; source `docs/agent-work/m08-qacobench-baseline/handoff.md:1` |
| F15 | m08-SEC-004/005: `elapsed_ms` is read from the engine report in two places. Whether a `NaN` or a malformed body is guarded there was **not** read | `campaign.py:65,129` |
| F16 | **m09 R1-SEC-003 (F7) is still open.** Its task box is unticked: the Java engines, `nginx` and `frontend-assets` run as the image user with default capabilities, and only `no-new-privileges` is set. In the production compose, `user` appears only at `:27`, `:54` and `:379`. `cap_drop` does not appear in the file | `openspec/changes/m09-compose-only/tasks.md:128-132`; `deploy/compose/production/compose.yaml:27,54,379` |
| F17 | **R2-SEC-006/007 and R3-SEC-003/004 have dispositions only.** Their text is "deferred, not now" or "follow-up". The only hint is the label "tag vs ordered tag" | `docs/agent-work/m09-compose-only/review/round2.md:25-26,30`; `review/round3.md:11-12`; `m09-compose-only/handoff.md:9` |
| F18 | LIC-1 has no recorded detail | `SECURITY_REVIEW.md:80` |
| F19 | The task ids in the proposal (`7edfd54eef914e16`, `4090a0db23864f85`) appear nowhere in the tree. Their followups were **not read** | grep of the worktree (no match) |
| F20 | `docs/qa/**` is not a risk area. No glob of R1-R11 matches it, and the low panel is `[reviewer]` | `.agentic/project.yaml:105-139,141-142` |
| F21 | **Another proposal also owns this file.** P-20261103-1 (CSV formula neutralising) has `docs/qa/SECURITY_REVIEW.md` in the owned files of its S1. Its F14 describes the page's old layout ("Fixed in this SHA" table), which is now history below the register. That row is not in the file yet (no `CSV` match), and no `csvCell` exists in `frontend/src` | `docs/agent-work/prop-20261103-1/intake.md:32,69,90`; `SECURITY_REVIEW.md:113-116` |
| F22 | `docs/**` commits make `frontend/src/content/changelog.generated.json` stale (lesson 2). The bim-guard check scans every `.md` (lesson 1) | `docs/lessons.md` items 1-2; `.agentic/project.yaml:52,83` |

Deviations from the proposal:

1. The proposal says M4-2 can "probably" be closed. The root job does compare all 82 packages with the goldens on every
   develop push and on pull requests that touch the bim area (F6-F9). The pytest corpus tests in that job can still skip
   quietly (F10). Closing M4-2 also needs a recorded CI run of `develop` in which the step "Check the bim-toolchain
   goldens" passed. That run is not read here: the planner role has no repository access, and the slice reads it with
   `ci_status`.
2. The proposal cites `ci.yml:21` for "every area changed". That line is a comment. The behaviour is in
   `tools/ci_changes.py:117-118` (F6).
3. M5-K has a second reach not named in the proposal: a SPACE **management** key on the remote, shared SPACE (F11).
   This counts toward the upper bound of the rating.
4. File collision with P-20261103-1 (F21): the two must not edit `SECURITY_REVIEW.md` at the same time.

## 3. Scope

In scope:

- `docs/qa/SECURITY_REVIEW.md` only. In the 13 blocking rows (F1), set the Severity, Status, Owner, Evidence and Last
  checked cells, and update M4-2 with F6-F10. Recompute the O8 count paragraph (`:38-41`). Rows re-read in a slice get
  that slice's date.
- Each proposed rating names its class (authorization, secret-handling, SSRF, DoS, disclosure, hardening, test gap)
  and its upper bound, with file:line evidence. A class under the floor (F4) is never rated below medium.
- A row that the tree cannot rate stays `unrated (owner)` and goes into the CRP of §7.

Non-goals:

- Fixing any finding, and any change to code, tests, workflows, compose or deploy files. F7, the SHA pins and the
  missing `BIM_REQUIRE_CORPUS` are followups, not part of this change.
- Rows that already carry a proposed rating and do not block O8 (low and medium rows, closed or obsolete rows),
  except M4-2.
- The History sections (`SECURITY_REVIEW.md:113` onward), `SECURITY.md` and `INTENT.md:169` (R11).
- Recovering the text of R2-SEC-006/007 and R3-SEC-003/004 by guesswork (CRP-A).
- `acceptance/**`, `openspec/specs/**`.

## 4. Slices

One capability: **an O8 answer from the register**. All slices write the same file, so they run **in sequence**, never
in parallel. No interface contract (OpenAPI, JSON Schema) is involved.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | `register-ratings`: propose a rating with evidence for B6-1, M5-S, B8, SPHERE-1, m08-SEC-003, m08-SEC-004, m09 R1-SEC-003, LIC-1, R2-SEC-006/007 and R3-SEC-003/004 (the last five stay `unrated (owner)` unless the tree decides them). Bound M5-K after PR #69 (F11-F13). Update M4-2 (F6-F10, plus one CI run of `develop`). Recompute `:38-41`. Draft the CRP-A row list in the result block | security-auditor, default model, high effort, about 40 turns | `docs/qa/SECURITY_REVIEW.md` | this intake (F1-F22). For B6-1: `openbinding-gateway/src/openbinding_gateway/core/public_errors.py`, the job read and redaction code, and `alembic/versions`. M5-S: `compose*.json`, `lab/**`. B8: `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_probe.py`, `docs/qa/PROCESS_DEPLOYMENT.md`. SPHERE-1: `docs/qa/SPHERE_PRIVACY.md`. m08: `experimentation/qacobench/campaign.py`. m09: `deploy/compose/production/compose.yaml`, `openspec/changes/m09-compose-only/tasks.md:128-132`, `docs/agent-work/m09-compose-only/**`. M5-K: `compose.lab*.json`, `ROADMAP.md:22,146-147`. M4-2: `.github/workflows/ci.yml`, `tools/ci_changes.py`, `bim-toolchain/tools/baseline_core.py`, `core_support.py`. CI: `ci_status` of a `develop` push | 13-15 table rows rewritten, plus 4 count lines: about 40-80 diff lines | **low**: docs only, no risk area (F20). Kind security, so the panel adds an independent security-auditor (§5) | P-20261103-1 S1 not editing `SECURITY_REVIEW.md` at the same time (Q1) |
| S2 | `register-owner-confirmation`: record the owner's answer to CRP-A (confirm or override each proposed rating, and the disposition of each row the tree cannot rate). Mark each confirmed rating with "confirmed (owner, date)" and recompute the O8 count to a yes or no | doc-steward, default model, low effort, about 15 turns | `docs/qa/SECURITY_REVIEW.md` | S1's merged register, the CRP-A answer | about 15-40 lines | **low**: docs only | S1 merged into `develop`; CRP-A answered |
| S3 (only if CRP-A picks option b) | `m09-rereview`: narrow security-auditor re-review of the m09 production compose and runbook area. New findings get new ids and rows. R2-SEC-006/007 and R3-SEC-003/004 become `closed` with "superseded by <new ids>" | security-auditor, default model, high effort, about 40 turns | `docs/qa/SECURITY_REVIEW.md` | `deploy/compose/production/**`, the m09 runbook, `docs/agent-work/m09-compose-only/**`, `openspec/changes/m09-compose-only/**` | about 20-60 lines | **low** by file. The content concerns R10, so the auditor stays in the panel | S1 merged. Runs before S2, and S2 then records the owner's confirmation of S3's rows too |

Order: S1, then S3 if chosen, then S2. Each slice is one PR and is reverted with one commit.

### Proposed checks (none are registered for this proposal)

For every slice:

1. G5, `bim-guard` (registered, `.agentic/project.yaml:52`): `{"cwd": ".", "argv": ["python3", "tools/check_bim_guard.py"]}`.
   Do not write retired route or file literals in the register. Cite the M9.6 test files instead (lesson 1).
2. G9: `{"cwd": ".", "argv": ["git", "diff", "--check"]}`.
3. G9, `changelog` (registered, `.agentic/project.yaml:83`): `{"cwd": ".", "argv": ["python3", "tools/generate_changelog.py", "--check"]}`.
   It is red until the coordinator regenerates `changelog.generated.json` after the last commit (F22). Report a red
   result, do not hide it.

No red-before check (G3): nothing is tested.

## 5. Gates per slice

| Gate | S1 (ratings) | S2 (owner confirmation) | S3 (m09 re-review) |
|---|---|---|---|
| G1 spec | n/a: no behaviour and no requirement. If the change is tracked in OpenSpec, use proposal and tasks only, with no delta spec. `openspec-validate` is `todo: true` (`project.yaml:34`) | same | same |
| G2 EPIC | n/a (no spec delta) | n/a | n/a |
| G3 red-before | n/a: no test | n/a | n/a |
| G4 acceptance frozen | trivially (no `acceptance/**`) | trivially | trivially |
| G5 green-after | check 1 | check 1 | check 1 |
| G6 trace | n/a: no requirement ids | n/a | n/a |
| G7 contracts | n/a | n/a | n/a |
| G8 mutation | n/a | n/a | n/a |
| G9 quality | checks 2 and 3 (changelog regenerated last) | checks 2 and 3 | checks 2 and 3 |
| G10 secrets/ownership | no R11 path (F20). The register names settings and variables (`SPACE_API_KEY`, `DEMO_SPACE_MANAGEMENT_KEY`), never their values | same | same |
| G11 review | `[reviewer, security-auditor]`. The second auditor is a clean instance that did not author S1. It checks each rating against its cited evidence and the floor (F4). This is one role more than the low panel (`project.yaml:142`) | `[reviewer]`: it checks that each row matches the CRP-A answer word for word | `[reviewer, security-auditor]`, as for S1 |
| G12 lab/UI | n/a: no runtime or UI | n/a | n/a |
| G13 review package | n/a with `how_to_review`: read "How to read" (`:8-34`), then the 13 changed rows with their evidence, then the O8 count paragraph | n/a with `how_to_review`: the CRP-A answer beside each changed row and the final O8 yes or no | n/a with `how_to_review`: the new rows and the four superseded ones |

## 6. Feature flags

None. Documentation has no runtime switch. Each slice stands alone and is reverted by one commit.

## 7. Open questions

These need an owner decision (CRP). The ratings and O8 are the owner's to confirm (`SECURITY_REVIEW.md:10-12`;
`INTENT.md:169`).

- **CRP-A: the rows the tree cannot rate, and confirmation of the proposed ratings.** This is one CRP, raised after S1
  is merged. It lists each proposed rating with its evidence, and each row left `unrated (owner)`. The list is expected
  to be R2-SEC-006, R2-SEC-007, R3-SEC-003, R3-SEC-004 and LIC-1 (F17, F18), plus any row S1 could not bound. Options
  for the rows left unrated:
  - (a) The owner supplies the text or rates each row directly.
  - (b) A narrow security-auditor re-review of the m09 area (S3) derives the findings again under new ids, and the four
    m09 rows are closed as superseded.
  - (c) The owner accepts the rows as known and unrated for R1, through a written waiver on the release PR. The O8 rule
    (`:25-26`) still counts them as failing, so this is a waiver, not a pass.
  - (d) Close them as "not recoverable". This is not recommended: `closed` requires a fix with evidence (`:22`), so it
    would bend the status rules.

  Recommended: (b) for the four m09 rows and (a) for LIC-1, which is about licences and a Git credential, so its
  context lies outside the tree. Per row, the owner either confirms the proposed rating or writes a different one.
- **CRP-B (only if S1 finds it): M5-K above medium.** The bound may come out as high: a real management key of a
  shared remote SPACE is passed into a lab container (F11). Who can reach that container or its environment was not
  read here. In that case O8 fails at R1 unless the key is fixed. The owner then chooses to fix before R1 (a separate security change in R10, high risk), to
  rotate and scope the key, or to accept it with a written waiver.

For the coordinator (no owner decision):

- **Q1: serialise with P-20261103-1.** Both proposals own `docs/qa/SECURITY_REVIEW.md` (F21). Recommended: whichever
  slice starts second rebases on the first. P-20261103-1's row goes into the register table (`:43-93`) as a `closed`
  row, not into the History "Fixed in this SHA" table that its intake names (F21). Its contract should say so.
- Q2: whether to track this docs-only change as an OpenSpec change (G1 n/a).
- Q3: CI evidence for M4-2. S1's security-auditor reads `ci_status` for a recent `develop` push. If the role cannot
  read CI, the coordinator supplies the run id and its `bim-toolchain (bim-core)` result.

## 8. Followups (outside this proposal)

- Set `BIM_REQUIRE_CORPUS: "1"` on the `bim-toolchain` job of the root workflow, so that the pytest corpus tests fail
  instead of skipping (F10). This is R10 (`.github/**`, high), so it needs its own proposal.
- F7 of m09: add a non-root `user` and `cap_drop` for the Java engines, `nginx` and `frontend-assets` (F16). This is
  R10 and needs Docker.
- m08-SEC-003/004: change the QACOBench recording or guards if the ratings call for it (F14, F15). This is R8.
- A static test that parses the register and prints the O8 count for the release role (followup of
  P-20261102-2, `prop-20261102-2/intake.md:162-163`).

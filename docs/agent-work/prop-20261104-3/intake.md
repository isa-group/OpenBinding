# Intake: P-20261104-3, a static test that parses the security register and prints the O8 count

- Kind: reliability, size S, owner-approved · Base: `task/1186970ccf094836` at `a8876def`
- INTENT objective: **O8, Security**: "0 open high or critical findings at each release to `main`", measured by
  "open items in `docs/qa/SECURITY_REVIEW.md`" (`INTENT.md:169`).
- Origin: followup of the register intake (`docs/agent-work/prop-20261102-2/intake.md:162-163`, confirmed). The
  task ids `7edfd54eef914e16`, `4090a0db23864f85` and `9ef09b2d4a9f4def` that the proposal cites appear in no file of
  the worktree (grep). They were not verified.

## 1. Objective

A lab test reads the real register in `docs/qa/SECURITY_REVIEW.md` and fails if a row is malformed or the summary
disagrees with the rows. A read-only tool, `tools/o8_count.py`, prints the open-row counts and the O8 verdict, so the
release role can reproduce the O8 answer instead of counting by hand.

## 2. Evidence checked against the tree at `a8876def`

| # | Fact | Evidence |
|---|---|---|
| F1 | The register is one Markdown table with 7 columns: Id, Finding, Severity, Status, Owner, Evidence, Last checked. It has 49 data rows, and no cell contains a pipe character | `docs/qa/SECURITY_REVIEW.md:43-93` |
| F2 | Severity vocabulary: critical, high, medium, low, unrated. `>= medium (floor)` is the authorization/secret/SSRF floor. `unrated (owner)` means the owner must rate it | `SECURITY_REVIEW.md:14-20` |
| F3 | **Severity cells are not bare tokens.** They carry a parenthetical: `low (proposed)`, `low (own input, proposed)`, `medium (secret-handling; proposed)`, `medium (secret-handling, mitigating control not recorded; proposed)`, `>= medium (floor, authorization)`, `>= medium (floor, secret-handling)`, `unrated (owner)`. So the parser accepts one base token, with an optional `>= ` before `medium`, followed by an optional `(...)` | `SECURITY_REVIEW.md:48,67,69,72,84,86,66` |
| F4 | Status vocabulary: `open`, `closed`, `obsolete` | `SECURITY_REVIEW.md:22-23` |
| F5 | O8 rule: O8 fails if any `open` row is critical or high. An `open` row that is `unrated`, or `>= medium (floor)` with no upper bound, also fails O8. `closed` and `obsolete` rows never count. The register has no notation for a bounded `>=`, so the tool treats every `>= medium` as unbounded | `SECURITY_REVIEW.md:25-28` |
| F6 | Last-checked cells are all `YYYY-MM-DD`: 2026-10-14, 2026-10-26, 2026-10-28 or 2026-11-03 | `SECURITY_REVIEW.md:45-93` |
| F7 | Ids are unique, but some contain a space (`m09 R1-SEC-003`). A row id cannot be split on whitespace | `SECURITY_REVIEW.md:93` |
| F8 | **The summary is prose and wraps over 4 lines.** It contains "no row is rated high or critical", "**O8 is not met …**", "Open rows: 27 in total (12 low, 2 medium, 1 `>= medium`, 12 unrated)" and "The 12 unrated open rows are B6-1, M5-S, … and m09 R1-SEC-003." The parser must join the paragraph's lines before matching | `SECURITY_REVIEW.md:38-41` |
| F9 | **The summary matches the rows today** (manual count of rows 45-93): 27 open rows. Low (12): B6-2, B6-4, B6-5, B6-6, M4-2, M4-3, RR-1, SPACE-1, OPS-1, LOAD-1, CI-PIN, CI-SCAN. Medium (2): CI-CRED, WEB-1. `>= medium` (1): M5-K. Unrated (12): the 12 ids on line 41. No open row is critical or high. A first run of the new test should therefore pass | `SECURITY_REVIEW.md:66-93` |
| F10 | Lab tests run in the `lab` CI job, which has no `if:` on a changed area, so they run on every PR. This includes a PR that only edits `docs/qa/SECURITY_REVIEW.md` | `.github/workflows/ci.yml:189-217`; grep for `if: needs.changes` (lines 131, 299, 337, 389, 519, none on `lab`) |
| F11 | Precedent for a tools-plus-lab-test pair: `lab/tests/test_flow_metrics_o6.py` loads `tools/flow_metrics.py` by file path. It checks that the tool runs on the standard library alone (`python -I … --help`) | `lab/tests/test_flow_metrics_o6.py:17-26,242-246` |
| F12 | `tools/o8_count.py` has no `bim` in its name, so CI change detection puts it in the gateway area only. Only `tools/ci_*.py` and `ci.yml` force every area | `tools/ci_changes.py:58-59,78` |
| F13 | Risk areas: `lab/tests/**`, `tools/o8_count.py` and `docs/qa/**` match no glob of R1-R11. The `tools/` entries in R8 are only `check_bim_corpus.py` and `package_zenodo.sh` | `.agentic/project.yaml:105-139` |
| F14 | Registered command for the lab tests: `lab-static`, run from `openbinding-gateway` with `uv run --locked --extra test pytest ../lab/tests` | `.agentic/project.yaml:49` |
| F15 | The size limit excludes tests | `.agentic/project.yaml:14` |
| F16 | No `ruff` gate covers `lab/` or `tools/`. `ruff-gateway` checks `src` and `tests` of the gateway only | `.agentic/project.yaml:76` |
| F17 | Any later commit makes `changelog.generated.json` stale (lesson 2). `bim-guard` scans every file, including this intake (lesson 1) | `docs/lessons.md` items 1-2; `.agentic/project.yaml:52,83` |
| F18 | No other change in `docs/agent-work/` or `openspec/changes/` plans to edit the register's rows. The nightly report's P1 (rate the 12 unrated rows) has no intake in the tree | glob of `docs/agent-work/prop-2026110*/**`; grep of `SECURITY_REVIEW` in `docs/agent-work` |

The proposal's evidence is confirmed: the summary at `:38-41`, the O8 rule at `:25-28`, the severities at `:14-20`
and the register intake followup at `prop-20261102-2/intake.md:162-163`. The intake adds F3, F7 and F8, three parser
traps the proposal does not mention.

## 3. Scope

In scope (S1):

- `tools/o8_count.py`: standard library only, read-only, no network. It reads the register (default
  `docs/qa/SECURITY_REVIEW.md`, overridable with `--register PATH`) and finds the table that starts with the 7
  headers of F1. For each row it checks:
  - the cell count is 7;
  - the id is non-empty and unique;
  - the severity matches `^(>= medium|critical|high|medium|low|unrated)( \(.+\))?$` (F2, F3);
  - the status is one of `open`, `closed` or `obsolete` (F4);
  - the last-checked cell is a valid calendar date in `YYYY-MM-DD` form (`date.fromisoformat`, F6).

  It counts the open rows by base severity and applies the O8 rule of F5. It prints the verdict, the counts and the
  ids that fail O8.
  Exit codes (recommended, Q1): `0` means O8 met, `1` means O8 not met, `2` means the register is malformed. The
  message names the line and the problem.
- `lab/tests/test_security_register.py`: loads the tool by file path, as in F11. It covers:
  - the real register parses with no error;
  - the summary paragraph matches the computed counts (F8): the total, the per-severity counts of "Open rows: … (…)"
    (a severity that is not listed counts as 0), the set of named unrated ids, and "O8 is not met" against "O8 is
    met";
  - synthetic registers in the test, each with one defect, are refused: a wrong cell count, an unknown severity, an
    unknown status, a non-ISO or impossible date, a duplicate id;
  - an open `high`, `critical`, `unrated` or `>= medium` row gives "not met"; closed and obsolete rows never count;
  - the tool runs with `python -I` and `--help`.

Non-goals:

- Editing any row, rating or summary of the register, rating the 12 unrated rows (separate proposal P1 of the
  nightly report), or changing the O8 rule or the severity scale (owner, CRP-1 of P-20261102-2).
- Generating or rewriting the summary from the tool (a `--write` mode). It would be a larger change, and the
  proposal asks for a check.
- A CI step or job of its own. The existing `lab` job collects the test (F10), so `.github/**` (R10) is not touched.
- Linting `lab/` or `tools/` (F16).

## 4. Slices

No interface contract (OpenAPI or JSON Schema) is involved. No feature flag: nothing runs at runtime, and each slice
is reverted by one commit.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | Register parser and O8 verdict tool with its lab test. Write the test first and show it red on the base | implementer, default model, medium effort, about 40 turns | `tools/o8_count.py`, `lab/tests/test_security_register.py` | this intake (F1-F18), `docs/qa/SECURITY_REVIEW.md`, `lab/tests/test_flow_metrics_o6.py` (pattern), `INTENT.md:169`, the OpenSpec change the coordinator writes (Q3) | tool about 100-140 lines; test about 120-180 lines, which the size limit excludes (F15) | **low**: no risk area (F13), no runtime code, API or dependency. The tool reads one file and writes nothing | the OpenSpec change (Q3), if the coordinator creates one |
| S2 (optional) | One sentence in "How to read" of the register: the lab test checks the summary, and `python3 tools/o8_count.py` gives the O8 answer | doc-steward or mechanical, low effort, about 10 turns | `docs/qa/SECURITY_REVIEW.md` | S1's tool and test | 2-4 lines | **low**: docs only, R0 | S1 merged into `develop`; any concurrent change to the register (F18) |

Order: S1, then S2. The owned files do not overlap. S2 edits the file that S1's test reads, so S2 must leave the
summary grammar of F8 intact. Its own CI run confirms that, because the `lab` job always runs (F10).

### Proposed checks (none are registered for this proposal)

S1 (the argument arrays use the form of `lab-static`, `.agentic/project.yaml:49`):

1. G3 red-before, on the base before the tool exists. It must fail with the load assertion:
   `{"cwd": "openbinding-gateway", "argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "../lab/tests/test_security_register.py"]}`
2. G5, the same argv, green after.
3. G5, all lab tests (`lab-static`):
   `{"cwd": "openbinding-gateway", "argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "../lab/tests"]}`
4. G5, `bim-guard`: `{"cwd": ".", "argv": ["python3", "tools/check_bim_guard.py"]}`
5. G9: `{"cwd": ".", "argv": ["git", "diff", "--check"]}`
6. G9, `changelog`: `{"cwd": ".", "argv": ["python3", "tools/generate_changelog.py", "--check"]}`. It stays red until
   the coordinator regenerates the changelog after the last commit (F17). Report that red result; do not hide it.

Do not register `python3 tools/o8_count.py` as a must-pass check. Under the exit codes of Q1 it exits `1` on today's
register (O8 is not met, F9). Check 2 covers the tool's exit codes in-process.

S2: checks 3 (the summary grammar still parses), 4, 5 and 6.

## 5. Gates per slice

| Gate | S1 (tool and test) | S2 (pointer sentence) |
|---|---|---|
| G1 spec | OpenSpec change with a delta spec (Q3), validated by the coordinator. `openspec-validate` is `todo: true` (`project.yaml:34`), so it is not executed locally | n/a: no behaviour |
| G2 EPIC | spec-auditor on the delta, if there is one (Q3) | n/a |
| G3 red-before | check 1 on the base | n/a: no test |
| G4 acceptance frozen | trivially: no `acceptance/**` | trivially |
| G5 green-after | checks 2, 3 and 4 | checks 3 and 4 |
| G6 trace | `[utest->req~…~1]` tags in the test and `[impl->req~…~1]` in the tool, using the delta's ids. `oft-trace` is `todo: true` (`project.yaml:62`) | n/a |
| G7 contracts | n/a: no API or schema | n/a |
| G8 mutation | n/a: no configured mutation tool covers `tools/` (`project.yaml:72-74`, all `todo`) | n/a |
| G9 quality | checks 5 and 6. No ruff gate covers these paths (F16) | checks 5 and 6 |
| G10 secrets/ownership | no R11 path; no secret. The tool reads only the register | same |
| G11 review | low panel `[reviewer]` (`project.yaml:142`). The coordinator may add test-reviewer, since the test's strictness is the deliverable | `[reviewer]` |
| G12 lab/UI | n/a: no runtime or UI | n/a |
| G13 review package | `how_to_test`: run the tool and read its verdict and counts against `SECURITY_REVIEW.md:38-41`, then break one row in a copy and see exit `2`. API 0/0, UI 0/0 | n/a with `how_to_review`: the one sentence |

## 6. Feature flags

None. See §4.

## 7. Open questions

**For a CRP: none.** The tool encodes the O8 rule and the scale that the register already states and attributes to
the owner (`SECURITY_REVIEW.md:10-12,25-28`). It changes neither. If the owner later defines a bounded `>= medium`
notation (F5), the tool and the test follow in a new change.

For the coordinator (no owner decision):

- Q1: exit codes. Recommended: `0` met, `1` not met, `2` malformed. The release role can then use the tool as a yes
  or no gate. Alternative: `0` whenever the register parses, with the verdict on stdout only.
- Q2: summary grammar. Recommended: the test matches the existing sentences of F8 after joining the lines, and
  severity labels may come in any order. A reword of those sentences then fails the test on purpose, so the editor
  keeps the count in a checkable form. Alternative: the tool generates the summary (a non-goal here).
- Q3: track S1 as an OpenSpec change (suggested id `security-register-check`) with three requirements: register
  shape (F1-F4, F6, F7), O8 verdict (F5) and summary consistency (F8). Recommended: yes, since S1 adds behaviour and
  tests carry trace tags (precedent: the `flow-metrics` change).
- Q4: keep S2? Recommended: yes, so that the release role finds the command from the register itself.
- Q5: sequencing with P1 of the same nightly report (rate the 12 unrated rows), if it is approved. A rating change
  edits rows and the summary together. If S1 merges first, P1's PR must keep F8's grammar, and the `lab` job will
  show whether it does. If P1 merges first, S1's test must accept P1's wording.

## 8. Followups (outside this proposal)

- The release role's checklist could name `python3 tools/o8_count.py` as the O8 evidence at the R1 gate. That
  belongs in the release procedure, not in this change.
- Optional later: a `--json` output, if the factory panel wants to show the O8 count.

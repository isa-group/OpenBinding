# Intake: P-20261102-2, a dated register with severity in docs/qa/SECURITY_REVIEW.md

- Kind: docs, size S, owner-approved · Base: `task/d57e0060abc54294` at `5b4c68a6`
- INTENT objective: **O8, Security**: "0 open high or critical findings at each release to `main`", measured by
  "open items in `docs/qa/SECURITY_REVIEW.md`" (`INTENT.md:169`).
- Owner question this answers: "which of these must be closed before the first release to `main`?"
  (`SECURITY.md:50`).

## 1. Objective

`docs/qa/SECURITY_REVIEW.md` opens with one register table. Each known security finding has one row with an id,
the finding, a severity, a status (open, closed or obsolete), an owner, evidence and a last-checked date. The release
role and the owner can then count the open high and critical rows and give a yes or no answer for O8 at the R1 gate.
The existing sections stay below the register, unchanged, as history.

## 2. Evidence checked against the tree at `5b4c68a6`

| # | Fact | Evidence |
|---|---|---|
| F1 | The page is a bounded review of SHA `5aebc7c8`, dated 2026-10-13. Its last status line is "Status 2026-10-14 (head `c2d46151`)" | `docs/qa/SECURITY_REVIEW.md:1-3,39` |
| F2 | No severity column. The page has a "Fixed" table (18 rows), a "Pending" table (5 rows) and a bulleted residual-risk list | `docs/qa/SECURITY_REVIEW.md:13-32,45-51,55-63` |
| F3 | Under `docs/qa`, the word "severity" appears only in `RENDERING_CATALOGUE.md` | search of `docs/qa` (one file) |
| F4 | **The analysis code is gone.** No `routes/analysis.py` or `analysis_jobs.py` under `openbinding-gateway/` (only `models/analysis.py` and test files). `tests/test_removed_operations.py:59-61` expects 404 for `POST /v1/analysis/pareto`, its GET and its `/cancel`. `tests/test_worker_queues.py:57` asserts that module `openbinding_gateway.analysis_jobs` does not exist. M9.6 removed "the `analysis` queue and worker" | glob of `openbinding-gateway/**`; `ROADMAP.md:196,198` |
| F5 | Rows that still cite that removed code: M3 (`/v1/analysis/pareto` and `/cancel`), M1 (the same route and `routes/analysis.py`, inside a longer fix), and B6 (rest) item (3) (`analysis_jobs.py`, `routes/analysis.py`) | `docs/qa/SECURITY_REVIEW.md:18,22,49` |
| F6 | SPACE is described as "on hold, never exercised" and "zero calls". PR #69 (2026-10-28) moved the lab to the remote SPACE `space.score.us.es` | `docs/qa/SECURITY_REVIEW.md:42,61`; `ROADMAP.md:138-139` |
| F7 | The lab compose files still pass `SPACE_API_KEY` and `SPHERE_API_KEY` to services, so M5 (rest) "real keys reach the container by lab design" probably still applies. Not re-checked against the remote-SPACE profile | `docs/qa/SECURITY_REVIEW.md:48`; `compose.lab-process-n2.json:198,204` |
| F8 | m08 deferred SEC-003 ("engine-not-installed recorded INCOMPATIBLE") and SEC-004/005 ("malformed-body hardening/NaN elapsed_ms"). No severity is recorded | `docs/agent-work/m08-qacobench-baseline/handoff.md:1` |
| F9 | m09 deferred R2-SEC-006, R2-SEC-007, R3-SEC-003 ("tag vs ordered tag") and R3-SEC-004. **Only the dispositions are in the tree**, not the finding text or a severity. R3-SEC-003/004 are listed under the severity column as "not now" | `docs/agent-work/m09-compose-only/handoff.md:9`; `review/round2.md:25-26,30`; `review/round3.md:3,11-12` |
| F10 | Other open security items exist outside the page. Actions are pinned by tag (`ci.yml:33` `actions/checkout@v4`), which is SEC-006 of m03 and SEC-001 of ci-speed. Checkouts persist credentials (ci-speed SEC-004). There is no secret scanning, SAST or dependency audit in CI. The bearer session is in `localStorage` | `SECURITY.md:42-48`; `openspec/changes/archive/2026-10-26-m03-gate-tooling/tasks.md:140`; `docs/agent-work/ci-speed/handoff.md:7`; `.agentic/project.yaml:84-88` (`semgrep`, `pip-audit`, `pnpm-audit`, `gitleaks` all `todo: true`) |
| F11 | B6 (rest) items (2), (4), (5) and (6) still point at files that exist: `services/engines.py`, `services/engine_registry.py`, `routes/cas.py`, `tests/test_entitlement_service.py`, `tests/test_published_pricing.py`. Whether the text they describe is still there was **not** re-read | `docs/qa/SECURITY_REVIEW.md:49`; glob of `openbinding-gateway/` |
| F12 | Three severity vocabularies are in use. O8 uses "high or critical". REVIEW.md blocks on an authorization, secret or SSRF finding "of severity medium or higher" and classifies findings as blocking, should-fix or nit. The factory review protocol uses blocker, major, minor and nit, as in m09 round 3 | `INTENT.md:169`; `REVIEW.md:90,100`; `docs/agent-work/m09-compose-only/review/round3.md:3-12` |
| F13 | Other documents restate the open items and are now stale. `docs/qa/JOINT_STATUS.md:156` lists "Open: M1, M4, M5 (rest), B3-B6, B8", but M1 and B3-B5 are in the fixed table. `SECURITY.md:44` still mentions "analysis task errors" | `docs/qa/JOINT_STATUS.md:155-156`; `SECURITY.md:44` |
| F14 | `docs/**` commits are tracked by the changelog generator, so this change makes `changelog.generated.json` stale (lesson 2) | `tools/generate_changelog.py:19,62`; `docs/lessons.md` item 2 |
| F15 | Neither `docs/qa/**` nor `SECURITY.md` is a risk area (R1-R11). R11 is `INTENT.md`, `REVIEW.md`, `.agentic/**` and similar | `.agentic/project.yaml:105-139` |

The proposal's evidence is confirmed: F1, F3, F4/F5 (M3 at `:18`, B6 item 3 at `:49`), F6 (`:42`, `:61`;
`ROADMAP.md:138-139`), F8 and F9. Two additions: M1 at `:22` also cites the removed route (F5), and F10 lists open
items in `SECURITY.md` that are missing from the register.

## 3. Scope

In scope (S1):

- `docs/qa/SECURITY_REVIEW.md` only. Retitle the page as a register, keeping the file path because `INTENT.md:169`
  points at it.
- Add a short "How to read" block: severity scale, status meanings, the O8 rule (an open high or critical row fails
  O8), and "unrated" for a severity the editor cannot set from evidence.
- Add the register table at the top, with these columns: id, finding (one line), severity, status, owner, evidence
  (`path:line` or source file), last checked. Use "2026-11-02" only for rows re-checked in the slice; use the source
  date otherwise.
- Rows: every id in the fixed and pending tables and the residual list (F2), the m08 and m09 deferred findings (F8,
  F9) and the `SECURITY.md` items (F10). A finding reported under several ids (Actions pinning: m03 SEC-006, ci-speed
  SEC-001) gets one row that lists every source id.
- M3, M1's analysis part and B6 (rest) item (3) become **obsolete**, citing M9.6 (`ROADMAP.md:196,198`,
  `tests/test_removed_operations.py:59-61`, `tests/test_worker_queues.py:57`). Split B6 (rest) into one row per item
  so (3) can be obsolete while the others stay open.
- SPACE rows: state the remote SPACE of PR #69 (F6). If a statement cannot be re-checked in the tree, write "not
  re-checked" instead of guessing.
- Keep the sections below as "History (2026-10-13 to 2026-10-14)". Do not rewrite them. Add one line at their top
  saying the register supersedes their status.

Non-goals:

- Fixing any finding, and any code, test, workflow or compose change.
- A new security audit. Severity comes from recorded evidence. Anything not decidable that way is "unrated (owner)"
  (proposal: "anything unclear is marked for the owner rather than guessed").
- Rewording `INTENT.md:169` (R11, owner only).
- Recovering the text of R2-SEC-006/007 and R3-SEC-003/004 (F9). They go in as "description not recorded" (CRP-3).
- A tool or test that parses the register. Possible later, see followups.

## 4. Slices

One required slice, plus one optional slice that the coordinator may drop. No interface contract (OpenAPI or JSON
Schema) is involved. No feature flag: documentation has no runtime switch, and each slice stands alone and is
reverted by one commit.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | Register table, severity scale and status rules at the top of `SECURITY_REVIEW.md`; obsolete analysis rows; m08/m09 and `SECURITY.md` items added; old sections kept as history | doc-steward, default model, medium effort, about 30 turns | `docs/qa/SECURITY_REVIEW.md` | this intake (F1-F15), `INTENT.md:169`, `REVIEW.md:84-100`, `ROADMAP.md:133-141,196-198`, `SECURITY.md:42-50`, `docs/agent-work/m08-qacobench-baseline/handoff.md`, `docs/agent-work/m09-compose-only/{handoff.md,review/*.md}`, `docs/agent-work/ci-speed/handoff.md`, `openbinding-gateway/tests/{test_removed_operations.py,test_worker_queues.py}`, `compose.lab*.json` | about 60-90 added lines, 2-5 changed lines | **low**: docs only, no risk area (F15). The content concerns security, so the panel adds security-auditor (G11) | CRP-1 answered, or S1 uses the recommended option and marks it provisional |
| S2 (optional) | Point `SECURITY.md` "Known open items" and the two `JOINT_STATUS.md` security rows at the register instead of restating stale lists (F13) | doc-steward or mechanical, default model, low effort, about 10 turns | `SECURITY.md`, `docs/qa/JOINT_STATUS.md` | S1's register, F13 | about 10-15 lines | **low**: docs only, no risk area | S1 merged into `develop` (links to its heading) |

Parallelism: the owned files do not overlap, but S2 links to S1's heading, so run S2 after S1. If CI time matters
more, S1 and S2 can be one PR with two commits. That PR would then cover two documents, still for one capability.

### Proposed checks (none are registered for this proposal)

S1 and S2:

1. G5, `bim-guard` (registered, `.agentic/project.yaml:52`): `{"cwd": ".", "argv": ["python3", "tools/check_bim_guard.py"]}`.
   It scans every `.md`, including this intake (lesson 1). Do not write retired route literals into the register;
   cite the M9.6 test files instead.
2. G9: `{"cwd": ".", "argv": ["git", "diff", "--check"]}`.
3. G9, `changelog` (registered, `.agentic/project.yaml:83`): `{"cwd": ".", "argv": ["python3", "tools/generate_changelog.py", "--check"]}`.
   It fails until `frontend/src/content/changelog.generated.json` is regenerated after the last commit (F14). The
   coordinator regenerates it, so a red result before then is expected. Report it, do not hide it.

No red-before check (G3): nothing is tested. A register-shape test is a followup.

## 5. Gates per slice

| Gate | S1 (register) | S2 (pointers) |
|---|---|---|
| G1 spec | n/a: no behaviour and no requirement. If the coordinator wants an OpenSpec change for tracking, it is proposal and tasks only, with no delta spec. `openspec-validate` is `todo: true` (`project.yaml:34`), so it is not executed locally either way | same |
| G2 EPIC | n/a (no spec delta) | n/a |
| G3 red-before | n/a: no test | n/a |
| G4 acceptance frozen | trivially: no `acceptance/**` | trivially |
| G5 green-after | check 1 (`bim-guard`) | check 1 |
| G6 trace | n/a: no requirement ids | n/a |
| G7 contracts | n/a: no API or schema | n/a |
| G8 mutation | n/a | n/a |
| G9 quality | checks 2 and 3 (changelog regenerated last, F14) | checks 2 and 3 |
| G10 secrets/ownership | no R11 file (F15); no secret: the register names settings (`SPACE_API_KEY`), never values | same |
| G11 review | `[reviewer, security-auditor]`: low by area, but the auditor confirms each severity and each obsolete or closed status against its evidence. This is one more role than the low panel (`project.yaml:142`) | low panel `[reviewer]` |
| G12 lab/UI | n/a: no runtime or UI | n/a |
| G13 review package | n/a with `how_to_review`: read "How to read", then the open rows and their evidence, then the obsolete rows against the M9.6 tests | n/a with `how_to_review`: the two pointers and the removed stale lists |

## 6. Feature flags

None. See §4.

## 7. Open questions

These need a CRP, because the answer interprets an owner objective (`INTENT.md:169`, R11):

- **CRP-1: the severity scale and how it counts for O8.** O8 counts "high or critical", while the reviews use other
  scales (F12). Options:
  - (a) critical / high / medium / low, with a one-line definition each, plus "unrated". An unrated open row counts
    as **failing O8** until it is rated (conservative).
  - (b) The same scale, but an unrated row does not count.
  - (c) Map review severities directly: blocker → critical, major → high, minor → medium, nit → low.

  Recommended: (a). For the definitions, use REVIEW.md:90's rule ("authorization, secret-handling or SSRF, medium or
  higher, blocks") as the floor for those classes. Then the R1 answer is "no" until every open row is rated, and the
  answer is never a guess. Without an answer, S1 still lands with (a) and marks the scale "provisional, CRP-1".
- **CRP-2: who sets severity.** Options:
  - (a) The S1 editor proposes each rating with its evidence, the security-auditor confirms it in G11, and the owner
    can override on the PR.
  - (b) The owner rates every row.
  - (c) A security-auditor audit task rates them before S1.

  Recommended: (a). Rows whose evidence does not decide the rating stay "unrated (owner)".
- **CRP-3: the four m09 findings with no recorded text** (F9). Searching the tree and the PR #60 page (lookup, low
  confidence) found no description or severity. Options:
  - (a) Record them as open, "description not recorded", unrated, and ask whoever ran the m09 panel or the owner to
    supply the text.
  - (b) A narrow security-auditor re-review of the m09 runbook area derives findings again under new ids, and the
    four are closed as "superseded".
  - (c) Close them as "not recoverable".

  Recommended: (a) now, then (b) as a followup before R1. Under CRP-1 (a), they block O8 until they are resolved.

For the coordinator (no owner decision):

- Q1: keep S2, or leave the stale lists in `SECURITY.md` and `JOINT_STATUS.md` (F13)? Recommended: keep S2, because
  three conflicting "open" lists defeat the point of the register.
- Q2: whether to track this docs-only change as an OpenSpec change (G1 n/a, §5).
- Q3: owner column. Recommended: one value per row, either a role (security-auditor, doc-steward, owner) or a change
  id. No personal data beyond what `INTENT.md` already names.

## 8. Followups (outside this proposal)

- A lab static test that parses the register (columns, allowed severities and statuses, an ISO date per row) and a
  small tool that prints the O8 count for the release role.
- Re-check B6 (rest) items (2), (4), (5) and (6) against the code (F11). S1 records them as "not re-checked" unless the
  editor reads the cited files.
- A security-auditor re-review of the m09 runbook area (CRP-3 b).

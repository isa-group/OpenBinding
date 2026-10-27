# Design: ci-action-pins

## Context

`ci.yml` uses five actions by major tag (`actions/checkout@v4` ×12, `actions/setup-python@v5` ×4,
`astral-sh/setup-uv@v6` ×4, `actions/setup-java@v4` ×2, `actions/setup-node@v4` ×4; intake F1). `nightly.yml` has no
`uses:` (F2). `req~gate-tooling-pinned-steps~1` names the five actions with their tags, and the lab tests compare the
literal `@vN` (F6, F7), so pinning `ci.yml` alone would break both the requirement and CI job `lab`. Only `openspec`
and `trace` set `persist-credentials: false` (F3). `gateway-unit` and `test` run `git ls-remote` and
`git fetch --depth=1 origin data/icsoc-original-dataset`, and turn a failure into a `::warning::` and a skip (F4).

## Decisions

- D1. Pin to the commit that the major tag resolves to today, and write the release tag of that same commit as the
  comment. Reason: no behaviour change; the comment tells a reader and the audit which release is pinned. Options
  considered: the newest release of each major (a version change, out of scope); the tag object SHA (refused: for an
  annotated tag such as `astral-sh/setup-uv` `v6` it is not a commit, so the commit is pinned).
- D2. The requirement states the rule (40-hex lower-case SHA, release comment of the allowed major, one pin per
  action), not the SHAs. Reason: a patch or minor bump inside the same major then changes `ci.yml` and the test table
  only, with no new revision of the requirement. A new major, or a new action, changes the requirement.
- D3. The match between the SHA and the tag in its comment is checked by people with network access, not by the lab
  test, which runs offline: the implementer resolves each tag before writing it, and the security-auditor resolves it
  again in review. PR CI proves only that each SHA exists ("Unable to resolve action" otherwise). The lab test checks
  the shape, the major, and that one action has one pin.
- D4. The existing CI tests compare action names (`uses` cut at `@`); the pin rule lives in a new
  `lab/tests/test_ci_action_pins.py`. Reason: later pin bumps do not touch unrelated tests, and the new test alone
  gives a clean red-before overlay.
- D5. The credential exception is a named list, `gateway-unit` and `test`, valid only while the job runs remote git.
  Reason: their fetch falls back silently, so dropping the credential could hide lost ICSOC coverage; a new job must
  state `persist-credentials: false`, and an excepted job that stops fetching loses the exception.
- D6. The requirement keeps the capability's layout (statement, ID line, `Evidence` line) with no `Needs:` line, as
  every other `gate-tooling` requirement. Reason: neither `.github` nor `lab/tests` is a G6 trace path
  (`ci.yml:289`), so declared coverage obligations would only add trace defects. Adding `.github` to the trace paths
  is proposal P1 of the same night.
- D7. `req~gate-tooling-pinned-steps~2` keeps its title and its single obligation ("pinned steps") with one sentence
  that carries two `SHALL`, as revision 1 did. Splitting the exact-version part into a new requirement would change an
  obligation this change does not touch.

## Pin data to re-verify (lookup of 2026-10-27, GitHub refs API)

| Action | Major | Release of the same commit | Commit SHA |
|---|---|---|---|
| actions/checkout | v4 | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` |
| actions/setup-python | v5 | v5.6.0 | `a26af69be951a213d495a4c3e4e4022e16d87065` |
| astral-sh/setup-uv | v6 | v6.8.0 | `d0cc045d04ccac9d8b7881df0226f9e82c39688e` (annotated tag; not the tag object) |
| actions/setup-java | v4 | v4.9.1 | `cf277c60eb25467037889841efdb72551f06f6c3` |
| actions/setup-node | v4 | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |

These are lookup answers, not repository facts (intake §2). S1 re-checks each one before writing it.

## Risks

- A SHA that resolves but belongs to another release than its comment: mitigated by D3 (two independent checks).
- A frozen pin misses a security fix released later in the same major: see CRP-1.
- Full CI on each PR of S1 and S2, since a `ci.yml` change runs every area (`tools/ci_changes.py:78`). Accepted: it
  is also the proof that every pinned action resolves.
- Ordering with m91 S2, which adds a step to job `lab` (intake F12): whichever lands second rebases and uses the
  action-name helper of S1.

## Migration and rollback

None at runtime. Each slice is one squash commit that a revert undoes. No feature flag: a workflow cannot be flagged.

## Open questions for the owner (non-blocking)

- CRP-1: who keeps the pins current. A SHA pin freezes an action, so a fix in a later `v4.x` needs a bump.
  - (a) Dependabot `github-actions` updates with SHA pins: a new `.github/dependabot.yml`, a new tool.
  - (b) The existing weekly `dependencies` audit, which already watches "unpinned Actions"
    (`.agentic/project.yaml:160`), also compares each pinned SHA with the latest release of the same major and opens
    a bump proposal when they differ.
  - (c) Nothing until a finding.
  - Recommended: (b). It adds no tool and no new file under `.github/`, and keeps every bump a reviewed change. The
    answer does not block S1 or S2.
- Q3: after S1 merges, the GAP sentence "Actions in `.github/workflows/ci.yml` are pinned by major version"
  (`constitution.md:128-129`) is no longer true. Only the owner edits the constitution. Recommended: remove that part
  of the GAP and add `lab/tests/test_ci_action_pins.py` to "Enforced".

# Change: ci-action-pins

## Why

Proposal P-20261027-3, approved by the owner (intake: `docs/agent-work/prop-20261027-3/intake.md`).

- INTENT objective O8, Security: "0 open high or critical findings at each release to `main`" (`INTENT.md:169`), with
  the signal "Dependency advisories and unpinned GitHub Actions" (`INTENT.md:218`).
- Constitution 10.5: "GitHub Actions pinned by commit SHA" (`constitution.md:124-125`), recorded as a GAP: "Actions in
  `.github/workflows/ci.yml` are pinned by major version" (`constitution.md:128-129`).
- The same gap was deferred as finding SEC-006 of m03 (`openspec/changes/archive/2026-10-26-m03-gate-tooling/tasks.md:140`).

Today `ci.yml` has 26 `uses:` lines, all on a moving major tag (intake F1), and 10 of its 12 checkouts leave the
workflow token in the local git configuration (F3). A moved tag runs code nobody reviewed; a persisted token is
readable by every later step of the job.

## What Changes

- Every `uses:` of the root workflows names its action by a full 40-character commit SHA, with the release tag as a
  trailing `# vX.Y.Z` comment; the set of five allowed actions and their majors stays the same.
- Each pin is the commit that the action's major tag resolves to on the day it is written, so CI behaviour does not
  change.
- Every checkout sets `persist-credentials: false`, except in `gateway-unit` and `test`, which still fetch the ICSOC
  dataset branch from `origin`.
- Lab static tests refuse a tag, a short SHA, a missing or wrong release comment, two pins of one action and a new
  checkout that keeps the credential.

## Impact

- Capability: `gate-tooling` only. Modified: `req~gate-tooling-pinned-steps~1` becomes `req~gate-tooling-pinned-steps~2`
  (the five actions are named by SHA, not by tag). Added: `req~gate-tooling-checkout-credentials~1`.
- Code (slices S1 and S2 of `tasks.md`): `.github/workflows/ci.yml` (risk area R10, high review panel),
  `lab/tests/test_ci_gate_tooling.py`, `lab/tests/test_ci_triggers.py` and a new `lab/tests/test_ci_action_pins.py`.
- No API, schema, image, dependency, lockfile or runtime change. `nightly.yml` has no `uses:` and stays as it is.
- Open change `ci-speed` also modifies `gate-tooling`, on other requirements (`req~ci-develop-push~2`,
  `req~ci-develop-push-concurrency~2`, `req~gate-tooling-bim-toolchain-tests~2`); the two deltas do not overlap.
- Owner items, non-blocking (design.md): CRP-1, how pins are kept current (recommended: the weekly dependencies
  audit); and, after S1 merges, the GAP sentence of `constitution.md:128-129`, which only the owner edits.
- Risk: a SHA that resolves but is not the commit of the tag in its comment. PR CI only proves the SHA exists; the
  implementer and the security-auditor each check it against GitHub (design.md, D3).

## Out of scope

- The nested `bim-toolchain/.github/workflows/*` files: GitHub does not run them, and each already carries a
  `PIN-PENDING` guard of its own (intake F10).
- Dependabot or any other pin-update tool, and any `.github/dependabot.yml` (CRP-1, option a).
- Any version change of an action: no new major, no newer release than the one each major tag points to today.
- Dropping the credential from `gateway-unit` and `test` while their remote fetch falls back to a warning and a skip
  (intake Q2).
- Editing `constitution.md`, adding `.github` to the G6 trace paths, and the other CI backlog items (intake §3).

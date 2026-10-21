<!-- Merge Readiness Package (MRP). Base branch: develop (never main, except release/* PRs opened for the owner). -->

## Change

- Change id: `<id>` · OpenSpec change: `openspec/changes/<id>/`
- Capability: `<capability>` · Requirements: `req~<capability>-<slug>~N`, …
- Risk level (REVIEW.md): low | medium | high — areas touched: R…
- Size: ~N diff lines (excluding tests/generated) · Feature flag: none | `<FLAG>` (default off)

## What and why

<!-- One paragraph: behaviour before, behaviour after, link to the proposal/issue. -->

## Evidence (each with the exact command, exit code and SHA)

- [ ] G1 `openspec validate --strict`
- [ ] G2 EPIC review ≥ 2/3 per dimension
- [ ] G3 red-before (failing output on the base SHA)
- [ ] G4 `acceptance/` unchanged by the implementer
- [ ] G5 green-after: suites of every touched component
- [ ] G6 OpenFastTrace trace clean
- [ ] G7 contracts: `docs/openapi.json` current; BIM consumer fixtures; engine conformance
- [ ] G8 mutation score on changed code
- [ ] G9 lint / types / audit
- [ ] G10 secrets and file ownership
- [ ] G12 UI: screenshots desktop + mobile (if UI changed)

Checks not executed (say why):

## Contract and data impact

- [ ] No public API/schema change — or CRP: `<link>`
- [ ] No BIM semantics / digest change — or CRP: `<link>`
- [ ] No data, secrets, screenshots or raw results added
- [ ] Docs, living specs and ADRs updated; changelog regenerated

## Review panel

<!-- reviewer / test-reviewer / security-auditor / arch-reviewer / perf-reviewer / ui-qa: verdicts and links -->

## Rollback

<!-- How to revert safely (migrations, flags, data). -->

<!-- handoff: docs/agent-work/<id>/handoff.md -->

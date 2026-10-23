Status: DRAFT for owner review (2026-10-21)

# Definition of Done — OpenBinding

A change is done when every applicable item holds and the evidence is in the PR (MRP) with the SHA it ran on.

## Specification
- [ ] OpenSpec change `openspec/changes/<id>/` exists (proposal, tasks, delta specs); `openspec validate --strict` passes (G1).
- [ ] EPIC review ≥ 2/3 on every applicable dimension (G2).
- [ ] Living specs updated on archive; changed requirements bumped (`~N+1`).

## Tests
- [ ] Red-before evidence for each new/changed requirement (G3); `acceptance/` frozen for the change (G4).
- [ ] Full suite of every touched component green (G5): gateway unit (+ `tests/concurrency` on PostgreSQL when
      locking/claim logic changed), bim-toolchain, engines, frontend Vitest + Playwright mocked, corpus check.
- [ ] Trace clean: every requirement has `[impl->…]` and `[utest->…]` coverage or a declared `GAP` (G6).
- [ ] Contracts: `docs/openapi.json` current; BIM consumer fixtures replay; engine conformance (G7).
- [ ] Mutation score on changed code ≥ project threshold (G8).

## Quality and security
- [ ] Lint/types: `ruff check`, `pnpm lint`, `tsc -b` (in `pnpm build`), Maven build; no new warnings (G9).
- [ ] Dependency, licence and secret checks clean; file ownership respected (G9, G10).
- [ ] Review panel for the risk level approved, findings resolved or owner-overridden (G11).
- [ ] UI changes: screenshots desktop and mobile reviewed, keyboard and accessible names checked (G12).

## Documentation and traceability
- [ ] Docs updated (`docs/*.md`, README, `docs/ERRORS.md` for new problem codes); ADR for architectural decisions.
- [ ] `docs/agent-work/<id>/handoff.md` written; commits carry `Change:` and `Refs:` trailers.
- [ ] Changelog regenerated (`tools/generate_changelog.py`) in a `chore(changelog)` commit.
- [ ] No data, secrets, screenshots or raw results added to Git.

## Release (release/vX.Y.Z → main, owner)
- [ ] Full audit panel run; no open high/critical findings (INTENT O6).
- [ ] Release MRP, changelog, preprod deploy in the lab, rollback rehearsed.
- [ ] BIM pin is a released tag; consumer-contract tests green on both repositories.

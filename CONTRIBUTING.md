Status: DRAFT for owner review (2026-10-21)

# Contributing to OpenBinding

This file supersedes the workflow part of `docs/CONTRIBUTING.md`. It applies to humans and agents alike; agents
additionally follow `AGENTS.md`.

## Branches

| Branch | Purpose | From | Merges into | Who merges |
|---|---|---|---|---|
| `main` | released code only | — | — | the owner only |
| `develop` | integration | — | `main` via `release/vX.Y.Z` | agents (squash), when gates and review are green |
| `feat/<id>`, `fix/<id>`, `spec/<id>`, `refactor/<id>` | one change | `develop` | `develop` | merge queue |
| `release/vX.Y.Z` | release candidate | `develop` | `main` (merge commit) | owner |
| `hotfix/<id>` | urgent fix | `main` | `main` and `develop` | owner (into `main`) |
| `data/icsoc-original-dataset` | the original ICSOC dataset | — | never | — |

Never force-push, never push to `main`, never tag. `<id>` is the change id (also used under `openspec/changes/<id>/`
and `docs/agent-work/<id>/`).

## Commits

Conventional Commits: `type(scope): subject` in lower-case imperative, no final period. Types: `feat`, `fix`,
`refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`. Useful scopes: `gateway`, `frontend`, `bim`, `engines`,
`experiments`, `platform`, `auth`, `docs`, `spec`, `adr`.

Trailers:

```
Change: <id>
Refs: req~<capability>-<slug>~<rev>[, …]
```

No AI-assistance markers and no `Co-authored-by` trailers. One coherent change per commit; keep generated files,
dependency updates, docs, tests and behaviour in separate commits when they can be reviewed separately. A PR that adds
commits must also regenerate the changelog (`python3 tools/generate_changelog.py`) in a final
`chore(changelog): …` commit, otherwise CI fails.

## Pull requests

- Size: about ≤ 300 diff lines excluding tests and generated files; one capability. Larger work is sliced by the planner.
- Open as draft from the first commit, base `develop`, using `.github/pull_request_template.md`; the MRP is the body.
- Required: CI green, gate checks (`nipogi/gates`), the review panel for the risk level (`nipogi/review-panel`), see `REVIEW.md`.
- Merge: squash into `develop`; the OpenSpec change is archived in the same merge.

## Feature flags

Multi-slice work that would expose half a feature lands behind a flag. Flags are settings in
`openbinding-gateway/src/openbinding_gateway/core/settings.py` (environment variables, default off; follow existing
switches such as `SPACE_ENABLED`, `SPHERE_ENABLED`, `ENGINE_JOB_MODE`) and, in the frontend, `VITE_*` variables read
in `frontend/src/config.ts`. Every flag has an owner, a removal task and a test for both states.

> OPEN QUESTION: Is a dedicated flag registry wanted, or are settings enough?

## How agents contribute

Fast lane (S): bugs with a reproduction, dependency bumps, docs, and red CI steps (owner decision 2026-10-21) go on
`fix/<id>` with a failing test or the failing CI output first and a reduced review panel. On conflicts with the owner's
commits, the owner's commit wins.

Intake → spec (OpenSpec change) → `openspec validate --strict` + EPIC → tests first → plan → build → PR → review panel →
merge queue (factory brief §6). Each task writes `docs/agent-work/<id>/handoff.md`. CRP for: NEEDS CLARIFICATION, public
API/schema change, constitution conflict, and everything in `INTENT.md` §8.

## How humans contribute

The owner defines intent and requests (issue, chat or `openspec/changes/<id>/proposal.md`), approves CRPs, and merges
release PRs into `main`. External contributors fork, branch from `develop` and open a PR to `develop`; the same gates
and review apply, and a maintainer shepherds it.

## Before you open a PR

- [ ] OpenSpec change validated; requirements traced (`[impl->…]`, `[utest->…]`).
- [ ] Red-before / green-after evidence attached.
- [ ] `docs/openapi.json` regenerated if and only if the HTTP contract changed.
- [ ] Docs and living specs updated; ADR added for architectural decisions.
- [ ] No data, secrets, screenshots or raw results added.

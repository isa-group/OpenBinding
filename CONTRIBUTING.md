# Contributing to OpenBinding

## Branches

| Branch | Purpose | From | Merges into | Who merges |
|---|---|---|---|---|
| `main` | released code only | — | — | the owner only |
| `develop` | integration | — | `main` via `release/vX.Y.Z` | maintainers (squash), when CI is green |
| `feat/<id>`, `fix/<id>`, `refactor/<id>`, `chore/<id>` | one change | `develop` | `develop` | maintainers |
| `release/vX.Y.Z` | release candidate | `develop` | `main` (merge commit) | owner |
| `hotfix/<id>` | urgent fix | `main` | `main` and `develop` | owner (into `main`) |
| `data/icsoc-original-dataset` | the original ICSOC dataset | — | never | — |

Never force-push, never push to `main`, never tag.

## Commits

Conventional Commits: `type(scope): subject` in lower-case imperative, no final period. Types: `feat`, `fix`,
`refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`. Useful scopes: `gateway`, `frontend`, `bim`, `engines`,
`experiments`, `platform`, `auth`, `docs`.

No AI-assistance markers and no `Co-authored-by` trailers. One coherent change per commit; keep generated files,
dependency updates, docs, tests and behaviour in separate commits when they can be reviewed separately.

## Pull requests

- Small and focused: one capability per PR, base `develop`.
- Required: CI green (`ci-required`).
- Merge: squash into `develop`.

## Feature flags

Multi-slice work that would expose half a feature lands behind a flag. Flags are settings in
`openbinding-gateway/src/openbinding_gateway/core/settings.py` (environment variables, default off; follow existing
switches such as `SPACE_ENABLED`, `SPHERE_ENABLED`, `ENGINE_JOB_MODE`) and, in the frontend, `VITE_*` variables read
in `frontend/src/config.ts`. Every flag has a removal plan and a test for both states.

## External contributors

Fork, branch from `develop` and open a PR to `develop`; the same checks apply, and a maintainer shepherds it.

## Before you open a PR

- [ ] A failing test before the fix or feature, passing after.
- [ ] `docs/openapi.json` regenerated (`tools/dump_openapi.py`) if and only if the HTTP contract changed.
- [ ] Docs updated for user-visible or operational changes.
- [ ] No data, secrets, screenshots or raw results added.

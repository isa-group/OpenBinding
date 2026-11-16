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

## Frontend

The frontend follows SPHERE (`SCORELabUS/SPHERE`), its look, behaviour and structure
([ADR 0053](docs/adr/0053-frontend-on-sphere-stack.md), [`frontend/DESIGN.md`](frontend/DESIGN.md)).

- **SPHERE first.** Before writing a screen, component or utility, find its counterpart in SPHERE at the pinned
  revision (`73779a8a`, in `THIRD_PARTY_NOTICES.md`) and copy it into `frontend/src/modules/<domain>`, in SPHERE's
  folders (`api`, `components/<kebab>/index.tsx`, `contexts`, `hooks`, `pages/<kebab>/index.tsx`, `types`, `utils`).
  Change only the data, the wording and OpenBinding's rules, and port its test with it.
- **Origin header and reuse class.** Every copied file opens with `Copied verbatim from`, `Adapted from` (with a
  `Changes:` line) or `Pattern only, after` SPHERE `<path>` (revision), and gets a row in `THIRD_PARTY_NOTICES.md` with
  its class: **verbatim** (only imports, wording and types changed), **adapted** (logic changed) or **pattern-only**
  (the layout followed, the code written here). Invent only when SPHERE has no counterpart.
- **Never copy SPHERE's known defects**: undefined `sphere-*` classes, missing iconify names, button navigation
  instead of links, detached dialogs without a focus trap, small text under 4.5:1, Spanish leftovers, crypto-js
  storage.
- **Styling.** Tailwind `tp-*` utilities and Tailwind's default palette only; no new `.css` file and no hex value
  outside `src/styles/tailwind.css`, where a new colour goes. Small text uses `tp-accent`, not `tp-primary`. Copied
  `dark:` classes stay inert (light only). `cursor-pointer` on every clickable.
- **Modules.** `modules/core` imports no domain module; a module imports another only through its `api/`, `types/`,
  `components/`, `hooks/` or `contexts/` (lint enforces it). Data goes through `use<Domain>Api()` over
  `useAuth().fetchWithInterceptor`, with the generated types and `readApiError`; writes send `If-Match` and a 412 opens
  `offerReloadIfChanged`.
- **Gates.** `pnpm gen:api --check`, `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build`.

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

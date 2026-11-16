# 0050. Frontend layers, generated API types, and what is reused from SPHERE

- Status: accepted
- Date: 2026-11-16 (F2a, decisions D7, D12, D13 and D24 and overrides 14, 15 and 17 of the F2 implementation plan;
  owner decision of 2026-11-15: reuse SPHERE first)

## Context

The frontend grew as pages that import each other (about 90 page-to-page edges), types written by hand in a
monolithic `api/client.ts`, and views that each read the API their own way. F2 adds about 25 components shared by
the composition screens, the run detail and, in F2b, the BIM editor. SPHERE (MIT) already has the diff, versions,
fork and problems-panel pieces the composition screens need, written on Tailwind, framer-motion and react-icons,
which OpenBinding does not use.

## Decision

- **Layers, enforced for new code.** `frontend/src` gains `shared/`, `entities/`, `widgets/`, `features/` and the
  composition pages, checked by `eslint-plugin-boundaries` at **error** (`frontend/eslint.config.js`, asserted by
  `src/test/boundariesLint.test.ts` on fixture slices):
  - `shared` imports `shared`;
  - `entities` import other entities and `shared` (`entities/composition` reads `entities/binding` and
    `entities/problem`), with no cycle;
  - `widgets` import other widgets, `entities` and `shared` (`composition-renderer` composes the leaf widgets), with
    no cycle;
  - `features` import `widgets`, `entities` and `shared`, **never another feature**; a widget that needs a feature's
    dialog takes a callback (`onDerive`, `onFork`, `onTry`) and the page mounts the dialog;
  - `pages` import anything but another page.

  The legacy `components/`, `api/`, `utils/` and `contexts/` count as shared. The existing page-to-page edges stay
  warnings until their areas are rewritten.
- **Shared pieces sit at the lowest layer that serves every consumer.** `ProblemsPanel` is a widget, because the
  catalog mode shows it read-only; `Located` and its adapters are in `shared/diagnostics`; the draft store
  (`drafts.ts`, `useDraftStore.ts`, IndexedDB) and the live-check scheduler (`lintScheduler.ts`: debounce, abort,
  one check of a kind at a time, `Retry-After`) are in `shared/editor`, because both editors are features; the derive
  and fork dialogs are features, because runs, compositions and the showcase all mount them.
- **Generated API types.** `shared/api/openapi.ts` is generated from `docs/openapi.json` by `openapi-typescript`
  (`pnpm gen:api`; `pnpm gen:api --check` in CI) and never edited; `shared/api/types.ts` names the schemas the
  frontend uses; `shared/api/errors.ts` (`readApiError`) reads both error envelopes (the problem document and
  `{detail: {code, error}}`), a `412` with the current `ETag` and a `429` with `Retry-After`. New modules use these
  types; `api/client.ts` keeps transport, auth, admin, engines and pricing until their rewrites.
- **SPHERE first, honestly labelled** (revision `73779a8a`):
  - copied verbatim, with SPHERE's licence header and a new vitest file: `shared/sphere/text-diff.ts`,
    `shared/sphere/requested-version.ts`;
  - adapted copies, headed "Adapted from SPHERE …": `shared/sphere/change-summary.ts` (sections `binding`, `values`,
    `offering`; candidate and value changes), `shared/sphere/composition-fragment.ts` (the `#composition=` share
    fragment, with its encoder), `features/composition-editor/NewVersionMenu.tsx` and
    `widgets/change-summary/useVersionChanges.ts`, each with its ported test;
  - guided rewrites on OpenBinding's components and `--tp-*` CSS, headed "Design follows SPHERE … no code copied":
    the composition detail, the Versions tab, `ProblemsPanel`, `ChangeSummary`, the comparison and file diff,
    `EvolutionCharts`, the upload dialog, the fork dialog, the calculator, the public list and the showcase.

  Every file that keeps SPHERE code has a row under "Code ported from SPHERE" in `THIRD_PARTY_NOTICES.md`.
- **Not copied:** `version-order.ts` (versions carry a server `ordinal`), `pricing-fragment.ts` (nothing to hand to
  SPHERE's editor before F8), the private-access fallback ("This … is private" would contradict the one not-found
  answer of [ADR 0047](0047-public-compositions.md)), the vendored renderer (pricing-renderer is a dependency) and
  `VariablesEditor`.

## Consequences

- A type drift between the gateway and the frontend fails `gen:api --check` instead of a screen.
- The composition screens cannot grow a page-to-page tangle, and a new widget or feature is placed by the rules
  rather than by review.
- Upstream SPHERE fixes to the copied files are taken by hand; the headers say which revision each file follows.

Where: `frontend/eslint.config.js`, `frontend/scripts/gen-api.mjs`, `frontend/src/shared/`, `frontend/src/entities/`,
`frontend/src/widgets/`, `frontend/src/features/`, `THIRD_PARTY_NOTICES.md`, `.github/workflows/ci.yml`.

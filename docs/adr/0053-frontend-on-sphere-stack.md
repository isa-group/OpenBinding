# 0053. The frontend on SPHERE's stack, structure and conventions

- Status: accepted
- Date: 2026-11-16 (F2c, PR-A; owner decision of 2026-11-16: everything in OpenBinding looks, behaves and is built as
  close to SPHERE as possible)
- Supersedes: the feature-sliced layers and the "design follows SPHERE, no code copied" rule of
  [ADR 0050](0050-frontend-layers-and-sphere-reuse.md). Its generated API types and `readApiError` stay.

## Context

SPHERE (`SCORELabUS/SPHERE`, MIT) is where SCORETech's interfaces converge. OpenBinding's frontend was built on its own
CSS, its own primitives and feature-sliced layers, and borrowed SPHERE's ideas without its code, so every screen taken
from SPHERE had to be rewritten and drifted from the original. The owner decided that OpenBinding converges on SPHERE:
its look, its behaviour, and the project itself (libraries, folders, conventions, tooling). Nothing is in production,
so there is no compatibility layer.

## Decision

**Graft SPHERE's skeleton, then pour OpenBinding's screens into it by domain.** PR-A grafts the skeleton without
changing an address; PR-B, PR-C and PR-D move the screens, moving the F2a/F2b logic with `git mv` instead of
rewriting it.

- **Stack.** Tailwind 4 through `@tailwindcss/vite`, with SPHERE's `styles/tailwind.css` and its `tp` tokens;
  framer-motion with SPHERE's motion variants; react-icons with the iconify shim (and `core/utils/icon-map.ts` from
  lucide until lucide is gone); react-loading-skeleton; date-fns; react-dropzone; dnd-kit; react-easy-crop;
  react-helmet-async; Monaco through `@monaco-editor/react`, bundled locally; react-markdown with remark-gfm; prettier
  with SPHERE's settings and the Tailwind plugin (`pnpm format:check` in CI).
- **Cascade.** `tailwind.css` opens with `@layer theme, base, legacy, components, pricing-renderer,
  pricing-renderer.theme, utilities;`. Preflight is on. Every stylesheet of a screen not yet redrawn sits whole in
  `@layer legacy` (a corpus test checks it), so legacy rules beat preflight and lose to SPHERE's components and the
  utilities. `globals.css` bridges the old `--tp-*` names onto the theme. No new `.css` file; hex values only in
  `tailwind.css`.
- **Two palettes, one switch.** SPHERE's orange (`#fa520f`) and OpenBinding's blue (`#0077b6`) are two value sets over
  the same `--color-tp-*` names, chosen with `data-brand` on `<html>` (`modules/core/theme/brand.ts`): the browser's own
  choice, else `VITE_DEFAULT_BRAND`, else SPHERE's. The owner chooses on the finished product. `--color-tp-accent` is
  the primary that small text may use and small white text may sit on (`#cc3a05` / `#0077b6`), so both palettes reach
  WCAG AA; a corpus test computes the ratios. Light only: this is the only theming switch.
- **Structure.** `src/modules/<domain>/{api,components/<kebab>/index.tsx,contexts,hooks,pages/<kebab>/index.tsx,types,utils}`,
  with shared code in `modules/core`. The routes are one `useRoutes` table (`routes/router.tsx`) under SPHERE's
  banners, with an exported `screens` list the screen budget reads. The shell is SPHERE's: `modules/presentation`
  layouts, `OrganizationContext`, the provider order of SPHERE's `App.tsx`. Data goes through `use<Domain>Api()` over
  `useAuth().fetchWithInterceptor`, which shares the session of the remaining legacy client.
- **Module rule** (`eslint-plugin-boundaries`, error): `modules/core` imports no domain module, and a module imports
  another only through its `api/`, `types/`, `components/`, `hooks/` or `contexts/`. SPHERE has no such rule; hooks and
  contexts are public because SPHERE's own modules reach the session through `auth/hooks/useAuth`.
- **Reuse.** Before writing a screen, component or utility, find its counterpart in SPHERE at the pinned revision
  (`73779a8a`) and copy it, with an origin header and a row in `THIRD_PARTY_NOTICES.md` naming its reuse class:
  *verbatim* (only imports, wording and types changed), *adapted* (logic changed; the header says what) or
  *pattern-only* (the layout followed, the code written here). Invent only when there is no counterpart.

**Recorded deviations from SPHERE** (kept on purpose):

- React 19, React Router 7, Vite 7 and Vitest 4: no downgrade; SPHERE's code runs on them, and its
  react-test-renderer tests move to React Testing Library.
- jsdom, React Testing Library and Playwright stay, with Vitest's `app` and `corpus` projects.
- Generated API types (`modules/core/api/openapi.ts`, `pnpm gen:api --check`) and `readApiError` stay; SPHERE writes
  its types by hand.
- URLs use slugs, plus id-based permanent links; tabs and filters live in the URL.
- The VIEWER role stays; anything unreadable is the same in-place 404 as a missing page (`PrivateAccessFallback` is
  never ported).
- Dialogs keep SPHERE's `customConfirm`/`customAlert` API but open in an in-tree `DialogHost` with OpenBinding's focus
  trap and Escape; the button reads "OK".
- Light only: SPHERE's `.dark` block stays commented out and copied `dark:` classes stay inert; no theme provider.
- No crypto-js storage (its key ships in the bundle); plain `localStorage` inside try/catch.
- Lint runs in CI, with the minimal module rule above.
- SPHERE's known defects are fixed while copying: undefined `sphere-*` classes, missing iconify names, button
  navigation (every menu entry is a link with an active state), small text under 4.5:1, Spanish leftovers, prop-types
  and react-transition-group.

## Consequences

- Two styling systems coexist until every screen is redrawn (D8 deletes `globals.css`, the `legacy` layer and the
  remaining stylesheets); the layer order keeps them from fighting.
- The `ui-*` classes stay on the redrawn primitives as hooks for the legacy screens and the tests, with no style.
- `routes/LegacyOrgOutlet.tsx` hands the screens not yet poured into SPHERE's pages the outlet context of the old
  shell, and goes with the last of them.
- A re-sync with SPHERE is a deliberate re-diff of the files in `THIRD_PARTY_NOTICES.md`; keeping the copied `dark:`
  classes keeps those diffs small.

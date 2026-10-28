# Change: m26-navigation

## Why

ROADMAP M2.6 (owner request own-a88d098d12d0454793fb64673a109fbe): "the navigation and project tabs of §5.2, the
Problem/Run vocabulary, the Verify page (resolve and verifier, offender 6) and a development-only system-states
screen", accepted when "the e2e route smoke is green, old URLs redirect, the allow-list is empty, and there are at
most 45 routed screens".

- ARCHITECTURE §5.2 fixes the target navigation:
  - public: Home · Explore · Engines · Language · Pricing · Verify · About · Log in / Sign up;
  - signed in: Home · Problems · Lab (Runs · Studies · Generator) · Engines · Language · Admin, with "+ New" (problem,
    collection, study, run) and the account menu (Profile · Plan · API keys · Identities · Notifications);
  - the project, problem and study tabs;
  - "at most 45 routed screens ... A test counts the route registry".
- INTENT §5 (glossary): "The UI, the documentation and new specs use the left column. The HTTP API `v1` keeps its
  current resource names".
- INTENT §6: resolve and verifier "merge into Verify"; Examples merge "into Explore"; "no Files page"; the system
  states screen is "Not in production builds".
- INTENT O12: "at most 45 routed screens".

The registry holds 69 screens today. The owner approved option A of decisions D-M26-1 to D-M26-7
(`docs/agent-work/m26-navigation/intake.md` §4):
1. a page with sections or tabs counts as one screen, with an optional section segment;
2. the problem page gets its tab frame now;
3. `/status` is retired;
4. no verifier API change;
5. top-level Problems and Lab › Studies open the current project's tab;
6. the addresses are renamed (`cases`, `jobs`, `publications`), with redirects;
7. the workbench diff goes through `SourceView`.

## What Changes

- Routes are declared per area, `src/routes/areas/<area>.tsx`, each area with its own test. A generic moved-routes
  table redirects old public and application addresses. Entries marked `permanent`, such as `/resolve/:kind/:digest`,
  are never removed and may still be linked.
- One public Verify page, `/verify/:kind?/:digest?`, replaces resolve and the verifier:
  - signed out, it resolves links and digests through the public resolve endpoint;
  - checking a document or a file needs an account;
  - the canonical JSON is shown in a collapsed `SourceView`.
- 24 fewer screens (69 to 45), as listed in design.md §2:
  - the account, organization settings, Language hub, Explore, study and problem pages serve their former screens as
    sections or tabs;
  - creating an organization or a project, and a new API key, become dialogs;
  - one password-reset screen;
  - the project Files and Package screens and the public status page are retired;
  - the system-states screen exists only in development builds.
- New public and signed-in headers, the New menu, the account menu and the project tabs follow ARCHITECTURE §5.2.
- The interface says Problem, Run and Published result. The addresses use `problems`, `runs` and `published`, and the
  old addresses redirect. API `v1` paths do not change.
- The raw-rendering allow-list ends empty: offender 6 leaves with Verify, and the unlisted finding 16 is shown in
  `SourceView`.

## Impact

- Capabilities:
  - `frontend-workspace`: 22 ADDED requirements.
  - `resolver-verifier`: 4 ADDED requirements (Verify page, permanent links, signed out, no raw JSON).

  Two capabilities, because the Verify page is the frontend surface of `resolver-verifier`, whose living spec already
  names the verifier screen. No requirement of either living spec is MODIFIED. Values that earlier changes pin and
  this change moves are reconciled at the archive (design.md §7).
- Code, all under `frontend/`:
  - `src/routes/**`: area files, the moved-routes table and its redirect component, the budget test; the domain files
    `d1..d8` go;
  - `src/routes/paths/**`: address builders;
  - the shell components (`components/PlatformShell/**`, `components/Navigation/**`, `components/SiteFooter/**`);
  - the pages of the screens that merge or are retired: Verify, Account, Organization, Project, Language, Examples,
    Status/About, Auth, Studies, Cases, Jobs, Workbench `SourcePanel`;
  - `src/test/rawRenderingAllowList.ts` and a vocabulary scanner;
  - the Playwright specs, the route smoke and the QA gallery (tasks.md).
- APIs: none. No gateway source, `docs/openapi.json` or `src/api/*.ts` operation changes, and API `v1` keeps `cases`,
  `jobs` and `publications`. The gateway still emits old frontend addresses (`citation.url`, the resolve `web_url`
  values, the reset e-mail link), so those entries are `permanent`.
- Not touched (M2.7, change `m27-names-not-digests`): `components/rendering/**`, `CitationPanel`, `VerifyResult` and
  `utils/identity*`.
- Risks (design.md §8):
  - permanent links (journey 1);
  - wide link edits across areas;
  - organizations named `runs`;
  - the 45 target leaves no slack;
  - requirements of unarchived M2.4 and M2.5 changes that this change supersedes.
- G1: `openspec validate m26-navigation --strict`.

## Out of scope

- Global Problems and Studies lists (D-M26-5 B). Permanent links `/p/{id}` and `/c/{id}` (M3.5).
- The problem page's new components (M3.2 to M3.4). The problem editor (M3.6). Import and export on problem and
  collection pages (M3.7). Examples as a collection (M3.8).
- Publishing a study run (M6.5): the study page's Publish tab holds the export and a link to the published results.
- Opening `POST /v1/verifier/inspect[-file]` to anonymous callers (D-M26-4 B).
- Changing the frontend addresses that the gateway emits (a follow-up after this change).
- Digest and name labels, `VerifyResult`, `CitationPanel`, `components/rendering/**` (M2.7).
- Screen ids, route parameter names and query names. They are internal and keep their names (`case-detail`,
  `:case`, `?case=`).
- Editing `openspec/specs/**`, earlier changes, INTENT, ROADMAP or ARCHITECTURE. Archiving.

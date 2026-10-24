# frontend-workspace Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

The React web client (`frontend/`) as an application shell: the route registry and layouts, session handling, the
client-side guard, rendering of gateway problem documents, and cross-cutting UI quality rules (touch targets,
visual hygiene, browser-test coverage). Screen-specific behaviour of the catalogue and pricing is in
`frontend-catalog-pricing`. The frontend is a client of the gateway; it decides no authorization.

## Requirements

### Requirement: One registry for every screen
THE frontend SHALL declare every screen exactly once in `src/routes/` with a unique id and path, placing paths under `/app` in the authenticated application layout and every other path in the public layout.

`req~frontend-workspace-route-registry~1`

Evidence: `frontend/src/routes/routes.test.ts`

#### Scenario: Duplicate path
- **GIVEN** a developer registers a second screen at `/app/jobs`
- **WHEN** the Vitest suite runs
- **THEN** the registry test fails

### Requirement: Client-side guard
WHEN a visitor without a session opens an `/app` screen, THE frontend SHALL redirect to `/login` remembering the path and query string; WHEN a signed-in non-administrator opens an admin screen, THE frontend SHALL redirect to `/app/account`; WHILE the stored session is checked, THE frontend SHALL NOT redirect.

`req~frontend-workspace-client-guard~1`

Evidence: `frontend/src/components/ProtectedRoute.test.tsx`; `frontend/src/routes/routes.test.ts`

#### Scenario: Deep link while signed out
- **GIVEN** no session
- **WHEN** the visitor opens `/app/acme/demo/jobs?tab=failed`
- **THEN** the frontend shows `/login` and returns to `/app/acme/demo/jobs?tab=failed` after sign-in

### Requirement: Session resilience
WHEN the gateway answers 503 or the network is down while the session is refreshed, THE frontend SHALL keep the stored tokens and offer a retry; WHEN another tab signs out or in, THE frontend SHALL follow it; WHEN the person signs out, THE frontend SHALL forget their local workbench drafts.

`req~frontend-workspace-session-resilience~1`

Evidence: `frontend/src/contexts/AuthContext.test.tsx`

#### Scenario: Gateway restarting
- **GIVEN** a signed-in person
- **WHEN** the profile refresh answers 503
- **THEN** the person stays signed in and sees a retry action

### Requirement: Problem documents rendered per field
WHEN the gateway answers with a problem document, THE frontend SHALL keep its `code` and diagnostics, unescape JSON Pointers, and show one message per pointer next to the matching form field.

`req~frontend-workspace-problem-rendering~1`

Evidence: `frontend/src/api/problem.test.ts`; `frontend/src/api/client.test.ts`

#### Scenario: Two diagnostics on one field
- **GIVEN** a 422 with two diagnostics for `/spec/limits/maxTasks`
- **WHEN** the form renders the problem
- **THEN** the field shows the first message only

### Requirement: Touch targets on phones
WHILE the viewport is a phone width, THE frontend SHALL give interactive controls and links outside running text a minimum height of 24 px without changing the desktop layout.

`req~frontend-workspace-touch-targets~1`

Evidence: `frontend/src/test/mobileTouchTargets.test.ts::gives interactive controls a 24px minimum height`; `frontend/src/test/mobileTouchTargets.test.ts::does not touch the desktop layout`

#### Scenario: Link list on a 390 px screen
- **GIVEN** a job-result link list on a 390×844 viewport
- **WHEN** the page renders
- **THEN** each link is at least 24 px high

### Requirement: Visual hygiene
THE frontend SHALL ship no dark theme, no prototype persona names in placeholders, labels, samples or fixtures, and keep shared fixtures in English under `src/test/fixtures`.

`req~frontend-workspace-hygiene~1`

Evidence: `frontend/src/hygiene.test.ts::has no dark theme`; `frontend/src/hygiene.test.ts::names no persona of the prototype`

#### Scenario: Prototype name in a placeholder
- **GIVEN** a placeholder that reads a persona name of the prototype
- **WHEN** the Vitest suite runs
- **THEN** the hygiene test fails naming the file and line

### Requirement: Screens measured in the browser
THE live browser suite SHALL sign in synthetic lab users with a password taken only from the environment and measure every screen at 1440×900 and 390×844 for overflow, console errors, page errors, 5xx answers, landmarks, touch targets and clipped text.

`req~frontend-workspace-live-screen-checks~1`

Evidence: `frontend/src/test/e2eSpecs.test.ts`; `frontend/e2e/live/visual-qa.spec.ts`

#### Scenario: A screen logs a console error
- **GIVEN** the lab stack and the live project
- **WHEN** a screen writes to `console.error`
- **THEN** the live run fails for that screen

## Out of scope

- Server-side authorization (the gateway's; the guard is a convenience).
- Pricing, engine catalogue and language pages (`frontend-catalog-pricing`).

## TODO

- Automated WCAG scan (axe) and `eslint-plugin-jsx-a11y`: GAP (constitution Article 11).
- Keyboard navigation and focus order as explicit requirements.
- Workbench (`InstanceWorkspace`), case composer, job launch and study builder flows.
- Planned OpenAPI-generated SDK (`@hey-api/openapi-ts`) replacing hand-written `src/api/*.ts`.
- Session tokens in `localStorage` (documented trade-off in `AuthContext.tsx`): owner to confirm.
- The registry test still speaks of "82 screens of the prototype"; the prototype (`docs/design-handoff/`) and the QA gallery screenshots were removed from the repository (ADR-0008), so the screen list in `src/routes/` is now the only source. The QA gallery writes to `QA_GALLERY_DIR` (default `frontend/node_modules/.cache/qa-gallery/screenshots/`).

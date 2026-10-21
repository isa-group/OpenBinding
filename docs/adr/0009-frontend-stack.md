Status: DRAFT for owner review (2026-10-21)

# ADR-0009: Frontend stack — React, TypeScript, Vite, pnpm, Vitest and Playwright

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner

## Context and problem

The web client was rebuilt from a design prototype (82 screens) and must stay a pure client of the documented gateway API.

## Decision

React 19 + TypeScript (strict build `tsc -b`), Vite, React Router 7 with a declarative route registry
(`frontend/src/routes/`: one `live(id, path, element, options)` per screen; `/app/**` requires a session, admin screens
require an administrator), pnpm with a frozen lockfile, ESLint (typescript-eslint, react-hooks), Vitest + Testing
Library (jsdom) for unit tests, Playwright for browser tests (mocked project in CI, live project against the lab at
desktop and mobile sizes). The frontend guard is a convenience; authorisation is the gateway's.

## Consequences

- Route ids and paths are a contract with the e2e and QA gallery specs.
- Planned (not done): an OpenAPI-generated SDK (`@hey-api/openapi-ts`) with a deterministic CI check.

## Evidence

`frontend/package.json`, `frontend/src/routes/routes.test.ts`, `frontend/src/components/ProtectedRoute.tsx`,
`frontend/playwright.config.ts`, CI job `frontend`.

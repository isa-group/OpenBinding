Status: PROPOSED for owner review (2026-10-22)

# Project context — OpenBinding

## Purpose

OpenBinding is to QoS-aware service binding and composition problems what SPHERE is to SaaS pricings: a repository
of versioned, citable problems written in BIM (the Binding Instance Model), a collaborative analysis platform and a
laboratory that compares interchangeable engines reproducibly. See `INTENT.md` (purpose, pillars, glossary, scope,
objectives, non-goals), `docs/ARCHITECTURE.md` (target architecture), `ROADMAP.md` (milestones) and
`constitution.md` (binding rules).

## Tech stack

- Gateway: Python 3.11, FastAPI, Pydantic 2, SQLAlchemy 2 async (asyncpg / aiosqlite in tests), Alembic, PostgreSQL 16,
  Redis 7 + Dramatiq, uv (`uv.lock`), ruff, pytest.
- BIM toolchain (`bim-toolchain/`, own `openspec/`): `bim-core`, `bim-service`, `bim-client`, version 0.2.0.
- Engines: Node 20 + TypeScript + Fastify + MiniZinc/Gecode (`minizinc-csp`); Java (binding-core targets Java 8
  bytecode, CI on JDK 21) with Maven + JUnit 5.
- Frontend: React 19, TypeScript, Vite, React Router 7, pnpm, ESLint, Vitest, Playwright.
- Infrastructure: Docker Compose profiles, NiPoGi lab profiles (`compose.lab*.json`), Kustomize, nginx.
- Remote services: SPACE (subscriptions and feature access, through `space-python-client` and `space-react-client`) and
  SPHERE (the OpenBinding pricing, read through its public permanent-link API); pricings rendered with `pricing-renderer`.

## Conventions

- Requirements: EARS, one behaviour per requirement, with OpenFastTrace ids `req~<capability>-<slug>~<rev>`.
  Layout of a requirement block in a living spec:
  1. `### Requirement: <title>`
  2. the EARS sentence (first line, contains SHALL),
  3. the id on its own line in backticks,
  4. `Evidence:` with code/test paths (`path::test_name`) or `GAP`,
  5. one or more `#### Scenario:` with GIVEN/WHEN/THEN bullets.
- Each spec has `## Purpose`, `## Requirements`, `## Out of scope` and `## TODO`.
- Code and test tags: `[impl->req~x~N]`, `[utest->req~x~N]`, `[itest->req~x~N]` in comments next to the implementing code or test.
- Changes live in `openspec/changes/<id>/` (proposal, design, tasks, delta specs) and are archived on merge.
- Spec level: spec-anchored. The code is the executable truth; the living specs describe it and tests enforce alignment.
- Vocabulary: new requirements and UI text use the glossary of `INTENT.md` §5 (Problem, Run, Component…); requirements
  about the HTTP API name the `v1` resources (`cases`, `jobs`, `artifacts`…).
- UI requirements state how data is rendered (constitution Article 15); "shows the JSON" is never an acceptable
  behaviour.

## Capabilities (living specs)

| Capability | Scope |
|---|---|
| `gateway-api` | OpenAPI snapshot, problem documents, health, body limits, CORS, production guards, login throttle |
| `instances-snapshots` | package upload/validation/compilation through `BimPort`, owner-scoped snapshots, toolchain pin |
| `job-execution` | job submission, idempotency, concurrency cap, leases, re-evaluation, evidence, cancellation |
| `engine-protocol` | `bim-engine/v1` contract all engines implement |
| `engine-registry` | engine discovery, registration, SSRF policy, conformance, credentials, federated quota |
| `engine-minizinc` | exact MiniZinc engine |
| `engines-java` | binding-core and the heuristic Java engines |
| `generator` | `/v1/generator/*` synthetic instance generation |
| `auth-roles-entitlements` | accounts, sessions, API keys, roles, CAS, plan entitlements, no metering |
| `collaboration-artifacts` | organizations, projects, library, cases, public read |
| `resolver-verifier` | digest resolution and provenance verification |
| `studies-analysis` | studies, runs, cells, neighbourhood and Pareto analysis |
| `frontend-workspace` | route registry, guard, session, problem rendering, UI quality rules |
| `frontend-catalog-pricing` | pricing page, plan strip, engine catalogue |
| `qacobench-experimentation` | QACOBench campaign reproducibility |
| `lab-deployment` | Compose/lab profiles, images, migrations, Kustomize |

## Domain glossary

- **BIM v1**: the Binding Instance Model, the binding language of OpenBinding (service binding, not Building Information
  Modeling). **QACO**: QoS-aware service composition.
- **Instance / Profile / Dialect**: package root / semantic frame (`qos-binding/v1`) / versioned sublanguage.
- **IR / BindingProblem**: canonical compiled problem; identified by `irDigest`; valid only for its `compilerDigest`.
- **Snapshot**: an owner's stored compilation of a package (UI: the compiled form of a problem version).
  **Case / revision** (UI: Problem / Problem version): a versioned problem composed of exact component versions.
- **Profile chain**: a profile and the profiles it extends; recorded in the IR (ADR-0016).
- **Engine / mode / registration**: solver service / declared algorithm contract / a deployment of an engine revision.
- **Termination**: `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`. **Job states**: `queued`, `running`, `completed`, `failed`, `cancelled`.
- **Study / run / cell**: a matrix definition / one execution of it / one (case revision × engine mode × options) job.
- **QFBS**: synthetic suite of QACOBench generated through the generator endpoint.

## Constraints

See `INTENT.md` §8–9 and `constitution.md`. Datasets never in Git; synthetic data only; SPACE and SPHERE only through their
official clients and public API; only the owner merges `main`.

## External dependencies

SPACE (`https://space.score.us.es`; pinned `ghcr.io/scorelabus/space-*` images in the lab), SPHERE (`https://sphere.score.us.es`;
pinned `ghcr.io/scorelabus/sphere-*` images in the lab), `space-python-client`, `space-react-client`, `pricing-renderer`, Zenodo deposits (QACOBench software and dataset), MiniZincIDE releases
(solver bundle), OMG BPMN 2.0.2 XSDs (vendored in bim-core; redistribution not demonstrated).

The OpenSpec CLI used for G1 is `@fission-ai/openspec` (1.14.3 validated locally on 2026-10-22); pinning it in CI and
confirming that the OFT importer accepts the requirement layout above is `ROADMAP.md` M0.2–M0.3.

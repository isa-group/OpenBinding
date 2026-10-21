Status: DRAFT for owner review (2026-10-21)

# Project context — OpenBinding

## Purpose

OpenBinding is a collaborative platform for describing, solving, comparing and publishing QoS-aware service binding
problems written in BIM v1. See `INTENT.md` for purpose, users, objectives and non-goals, and `constitution.md` for the
binding rules.

## Tech stack

- Gateway: Python 3.11, FastAPI, Pydantic 2, SQLAlchemy 2 async (asyncpg / aiosqlite in tests), Alembic, PostgreSQL 16,
  Redis 7 + Dramatiq, uv (`uv.lock`), ruff, pytest.
- BIM toolchain (`bim-toolchain/`, own `openspec/`): `bim-core`, `bim-service`, `bim-client`, version 0.2.0.
- Engines: Node 20 + TypeScript + Fastify + MiniZinc/Gecode (`minizinc-csp`); Java (binding-core targets Java 8
  bytecode, CI on JDK 21) with Maven + JUnit 5.
- Frontend: React 19, TypeScript, Vite, React Router 7, pnpm, ESLint, Vitest, Playwright.
- Infrastructure: Docker Compose profiles, NiPoGi lab profiles (`compose.lab*.json`), Kustomize, nginx.
- Remote services: SPACE (contracts and entitlements, on hold) and SPHERE (published pricing, read-only).

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

- **BIM v1**: the binding language of OpenBinding (service binding, not Building Information Modeling).
- **Instance / Profile / Dialect**: package root / semantic frame (`qos-binding/v1`) / versioned sublanguage.
- **IR / BindingProblem**: canonical compiled problem; identified by `irDigest`; valid only for its `compilerDigest`.
- **Snapshot**: an owner's stored compilation of a package. **Case / revision**: a versioned experiment composition.
- **Engine / mode / registration**: solver service / declared algorithm contract / a deployment of an engine revision.
- **Termination**: `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`. **Job states**: `queued`, `running`, `completed`, `failed`, `cancelled`.
- **Study / run / cell**: a matrix definition / one execution of it / one (case revision × engine mode × options) job.
- **QFBS**: synthetic suite of QACOBench generated through the generator endpoint.

> OPEN QUESTION: the expansion of the acronym BIM is not stated anywhere in the repository; add it to the glossary.

## Constraints

See `INTENT.md` §6 and `constitution.md`. Datasets never in Git; synthetic data only; SPACE on hold; only the owner merges `main`.

## External dependencies

SPACE (`https://space.score.us.es`), SPHERE, Zenodo deposits (QACOBench software and dataset), MiniZincIDE releases
(solver bundle), OMG BPMN 2.0.2 XSDs (vendored in bim-core; redistribution not demonstrated).

> OPEN QUESTION: the OpenSpec CLI version to pin in CI (G1) and whether the OFT importer accepts the requirement layout
> above (id after the EARS sentence); to be confirmed in the pilot.

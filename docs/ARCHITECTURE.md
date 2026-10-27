Status: PROPOSED for owner review (2026-10-22, revision 2: smaller platform, plans topology, Docker Compose).

# OpenBinding architecture (target)

This document describes the architecture OpenBinding is moving to and the rules that get it there. The product
reasons are in [`INTENT.md`](../INTENT.md), the order of work in [`ROADMAP.md`](../ROADMAP.md), the binding rules in
[`constitution.md`](../constitution.md) and the decisions in [`docs/adr/`](adr/). The gateway as it is at 912648c,
with file-level evidence, is in [`docs/architecture/gateway-as-is.md`](architecture/gateway-as-is.md); the BIM
language is in [`BIM_V1.md`](BIM_V1.md) and [`BIM_CORE.md`](BIM_CORE.md).

Contents: 1 Principles · 2 System context · 3 Containers · 4 Backend · 5 Frontend · 6 Domain model · 7 Key flows ·
8 Language extensibility · 9 Plans (SPACE and SPHERE) · 10 Storage and retention · 11 Quality and gates ·
12 Environments and previews · 13 Repository layout · 14 Decisions

## 1. Principles that shape the architecture

1. **One canonical problem, many engines.** BIM packages compile to one canonical IR; engines receive only the IR,
   declare capabilities, and never decide the final numbers: the gateway re-evaluates every binding.
2. **Modular monolith, hexagonal inside.** One deployable gateway split into bounded-context modules; each module
   keeps its domain free of frameworks and reaches the outside world through ports.
3. **Everything external behind a port, everything shared behind a contract.** BIM toolchain, engines, SPACE,
   SPHERE, CAS, blob storage and mail are adapters; contracts are versioned and tested on both sides.
4. **Render, never dump.** The frontend renders every domain object with a shared catalogue of components; source
   views are secondary (constitution, Article 15).
5. **Immutable evidence, named for people and addressed by digest for machines.** Problem and collection versions,
   compiled forms, runs, study runs and published results are sealed; permanent links and digests make them citable
   and verifiable. Screens name them by name, version number and date; a digest appears only where verifying is the
   task (§5.4).
6. **Small, reversible steps.** The target is reached by strangling the current code module by module, never by a
   rewrite.
7. **Small surface.** Every module, endpoint and screen serves a journey of `INTENT.md` §2; what none needs is
   retired before anything is moved or polished (ADR-0020).
8. **One way to deploy.** Docker Compose runs every environment, production included (ADR-0021).

## 2. System context

```mermaid
flowchart LR
  R([Researcher / curator])
  E([Engine author])
  X([Extension author])
  A([Platform admin])
  P([Paper reader])
  subgraph OB[OpenBinding]
    W[Web app]
    G[Gateway API]
  end
  SPH[(SPHERE<br/>sphere.score.us.es)]
  SPA[(SPACE 1.7.1<br/>local now, space.score.us.es later)]
  CAS[(Universidad de Sevilla CAS)]
  FED[(Federated engines)]
  ADS[(Adapter services)]
  Z[(Zenodo)]
  R & E & X & A & P --> W --> G
  R -. API keys, scripts, QACOBench, MCP .-> G
  G -- space-python-client --> SPA
  SPA -- permanent-link sync --> SPH
  G -- public permanent-link API --> SPH
  G -- CAS 3.0 --> CAS
  G -- bim-engine/v1 --> FED
  G -- bim-adapter/v1 --> ADS
  R -. datasets and artifacts .-> Z
```

SPHERE and SPACE are separate deployments of the group. The OpenBinding pricing is written and versioned in SPHERE
at `sphere.score.us.es`, under the permanent link `https://sphere.score.us.es/p/6ab0a323697330667ccce891`, and
every environment reads it there through SPHERE's public API. SPACE follows that permanent link and operates
subscriptions. Until `space.score.us.es` runs the latest SPACE release (1.7.1 today), each stack that needs plans
runs its own SPACE of that release, linked to the same permanent link; moving to `space.score.us.es` is a change of
configuration (§9.4, INTENT D5). OpenBinding never writes to SPHERE and never re-implements SPACE (§9).

## 3. Containers

```mermaid
flowchart TB
  subgraph Browser
    WEB[Web app<br/>React 19 · Vite · pricing-renderer · space-react-client]
  end
  subgraph Gateway host
    API[Gateway API<br/>FastAPI · modules §4]
    WRK[Workers<br/>Dramatiq: runs, study cells, maintenance]
    PG[(PostgreSQL)]
    RD[(Redis<br/>queues, cache, SPACE client cache)]
    BL[(Blob store<br/>content-addressed files)]
    BIM[bim-service<br/>optional BIM_MODE=http]
  end
  subgraph Engines
    MZ[minizinc-csp]
    JV[Java engines<br/>random-search · many-heuristic · evolutionary]
  end
  WEB -- HTTPS /v1, SSE --> API
  API --- PG & RD & BL
  WRK --- PG & RD & BL
  API & WRK -- BimPort --> BIM
  WRK -- bim-engine/v1 --> MZ & JV
  WRK -- bim-engine/v1 --> FED[(Federated engines)]
  API -- PlanPort --> SPA[(SPACE)]
  API -- public API --> SPH[(SPHERE)]
```

| Container | Responsibility | Technology |
|---|---|---|
| Web app | every screen; renders, never dumps; gates UI features with the pricing token | React 19, Vite, TypeScript, Recharts, `pricing-renderer`, `space-react-client` |
| Gateway API | `/v1` HTTP API, authentication, authorization, all use cases | Python 3.11, FastAPI, SQLAlchemy async, Alembic |
| Workers | runs, study cells and their metrics, generation, retention and reconciliation jobs | Dramatiq over Redis |
| PostgreSQL | operational source of truth | PostgreSQL 16 |
| Redis | queues, leases, caches (including the SPACE client cache) | Redis 7 |
| Blob store | content-addressed bytes (packages, uploads, logs, exports) | filesystem volume; S3-compatible later |
| bim-service | the BIM toolchain over HTTP when the gateway runs `BIM_MODE=http` | `isa-group/bim-toolchain` |
| Engines | solvers behind `bim-engine/v1`; built-in ones run beside the gateway, federated ones anywhere | Node/TypeScript (MiniZinc), Java |

Every container is a Docker Compose service (§12). Until `space.score.us.es` is used, a local SPACE (`space-api`,
its MongoDB and Redis) joins the stack through the `pricing` profile (§9.4).

## 4. Backend: a modular monolith

### 4.1 Modules (bounded contexts)

| Module | Owns | Main ports used | Code today (to move) |
|---|---|---|---|
| `identity` | accounts, sessions, passwords, API keys, external identities (CAS) | `IdentityProvider` (CAS), `Mailer` | `routes/auth.py`, `routes/users.py`, `routes/cas.py`, `cas.py`, `security/*` |
| `collaboration` | organizations (nested), projects, memberships, roles, invitations, audit, notifications, public read | — | `collaboration.py`, `routes/organizations.py` (org/project/member parts), `repositories/organizations.py`, `access/public_read.py` |
| `repository` | problems and versions, collections, package import and export, blobs, permanent links of problems and collections, problem metrics, and the versioned-artifact store as internal storage of sealed parts (resources of problem versions, study definitions, execution configurations) | `BimPort`, `BlobStore` | case/collection/blob routes, `services/snapshots.py`, `services/instances.py`, `artifacts.py`; the library as a catalogue (`routes/library.py`, the library and project-resource parts of `routes/artifacts.py`) retires (§4.3) |
| `language` | profiles, dialects, adapters, schemas, examples, compilation, the extension lifecycle | `BimPort`, `AdapterServicePort` | `integrations/bim*.py`, `services/discovery.py`, dialect/resource/profile routes, `v1/archive.py` |
| `engines` | engine revisions, modes and manifests, federated deployments, conformance, capability matching | `EngineTransport` | `services/engines.py`, `services/engine_registry.py`, `services/probe.py`, `v1/remote.py` |
| `execution` | runs: submission, idempotency, dispatch, leases, cancellation, events, re-evaluation, results (with the trade-off set of a multi-objective run), neighbourhood | `EngineTransport`, `BimPort`, `PlanPort` | `services/job_submission.py`, `services/execution.py`, `jobs/*`, `job_dispatch.py`, `worker.py`, job routes |
| `laboratory` | studies, study runs, cells, protocol metrics, trade-offs across engines, the generator | `execution` application API | `studies.py`, `study_jobs.py`, `routes/studies.py`, `generator/*`; the decision-space workspace (`analysis_jobs.py`, analysis routes, analysis queue and worker) was removed by M9.6 |
| `publishing` | published results (a frozen study run or collection version), citations, Zenodo-ready export, permanent-link resolution, Verify | application APIs of `repository` and `laboratory` | publication parts of `reports.py` and its routes, `routes/resolve.py`, `routes/verifier.py`; reports and editions retire |
| `plans` | the SPACE port, the entitlement map, the pricing descriptor, plan changes and eligibility (RESEARCH through CAS) | `PlanPort` (SPACE), `PricingSource` (SPHERE public API) | `space_client/*`, `services/entitlements.py`, `access/policy.py`, `access/contracts.py`, `domain/entitlements.py`; local metering (`domain/usage_counters.py`) retires; sponsor proposals (`sponsor_proposals.py`) were removed by M9.6, and only the caller can become billing sponsor |
| `administration` | users, queues and engine health, storage and retention, audit, moderation of public content | application APIs of the other modules | `routes/admin.py`, `telemetry.py` |
| `shared` (kernel) | settings, logging, problem+json errors, pagination, digests, clock, ids, mail | — | `core/*`, `mailer.py`, `security/bodylimit.py` |

### 4.2 Layout and dependency rules

```
openbinding-gateway/src/openbinding_gateway/
  app/                 composition root: create_app, lifespan, router registration, middleware, worker entry
  shared/              kernel (no imports from modules)
  modules/
    <module>/
      domain/          entities, value objects, policies; pure Python, no I/O
      application/     use cases, commands and queries, ports (typing.Protocol), public API (__init__.py)
      adapters/
        http/          FastAPI routers, Pydantic request/response schemas, problem mapping
        persistence/   SQLAlchemy models of the tables the module owns, repositories
        <external>/    space/, sphere/, bim/, engines/, cas/, blobstore/, adapters/
```

- Inside a module: `adapters → application → domain`. `domain` imports nothing from frameworks or adapters.
- Between modules: only through the other module's `application` public API, or through in-process domain events
  (audit, notifications, cache invalidation). No cross-module ORM joins; each table has one owning module.
- Modules form layers, and a module imports only modules below it: `administration` → `publishing` → `laboratory`
  → `execution` → `engines` | `repository` → `language` → `collaboration` → `identity` → `plans` → `shared`
  (`|` marks independent siblings).
- External systems only through ports: `BimPort` (exists), `PlanPort`, `PricingSource`, `EngineTransport`,
  `AdapterServicePort`, `BlobStore`, `IdentityProvider`, `Mailer`, `Clock`.
- Patterns: ports and adapters; application services as use-case functions; repositories with a unit of work per
  request (SQLAlchemy session); domain events for side effects; dispatch after commit (exists for runs); strategy
  for engine transports (built-in, federated) and adapter tiers (§8).
- Enforcement: the empty packages `openbinding_gateway/app`, `shared` and `modules` exist, with import-linter
  contracts in `openbinding-gateway/importlinter-modules.ini`: `kernel` (`shared` imports no module, composition
  root or legacy layer), `composition-root` (modules and shared do not import `app`), `no-legacy-http` (modules
  do not import `routes` or `main`), `module-layers` (the order above, `exhaustive`), `module-inside`
  (`adapters → application → domain`) and `pure-domain` (no framework, client or adapter in `domain`). Run them
  from `openbinding-gateway` with
  `uv run --locked --extra test --group lint lint-imports --no-cache --config importlinter-modules.ini`.
  import-linter cannot express "other modules only through `application`" per module pair, so
  `openbinding-gateway/tests/test_modules_cross_import.py` (AST, in the gateway pytest suite) enforces it;
  `tests/test_modules_skeleton.py` checks the structure of the contract file and also runs `lint-imports` against
  planted violations (the teeth test); it is skipped where `lint-imports` is not installed (the CI `test` job syncs
  only `--extra test`) until the blocking CI step, pending, runs it with the `lint` group.
  The legacy `.importlinter` stays report-only and unchanged, next to the existing `tests/test_architecture_layers.py` ratchets. Pending (owner/CI
  follow-up): running the new contracts as a blocking CI step and as a G9 gate entry; until then they are not
  enforced in CI.

### 4.3 Migration: strangler, one module at a time

0. Retire first (ADR-0020). The decision-space workspace, the report editor, the library as a catalogue (organization
   library, project resources, project library), the composer and sponsorship lose their screens, then their
   endpoints, then their code, so nothing retired is ever moved. Done by M9.6 (2026-10-27): the owner skipped the
   `Deprecation`/`Sunset` period because nothing ran in production, and the 41 operations are removed
   ([`API_DEPRECATIONS.md`](API_DEPRECATIONS.md)). The versioned-artifact store itself stays as the repository's internal storage of sealed parts:
   problems are edited and versioned as a whole, and sealed problem versions keep referencing their parts by exact
   digest, so nothing sealed changes. Data follows CRP rules (INTENT §11.5): existing publications keep their
   permanent links as read-only published results; report drafts, decision-space workspaces and sponsorship
   proposals are exported for the owner and dropped (the export tool and the guarded migration are in M9.6; see
   [`runbooks/retired-data-export.md`](runbooks/retired-data-export.md)).
1. Create `app/`, `shared/` and `modules/` with import-linter contracts; move nothing. Packages and contracts exist
   (§4.2); the blocking CI step and G9 entry are pending.
2. New capabilities land directly in modules: `plans` (M4) and the language registry (M5) are the first.
3. Move existing code one module per `refactor/<id>` change, behind characterization tests, keeping
   `docs/openapi.json` byte-identical. Order: plans → language → engines → execution → laboratory → publishing →
   repository → collaboration → identity → administration.
4. Each move deletes the old path, shrinks `ALLOWED_LEGACY`, `GATE_LIFECYCLE_LEGACY` and `MAX_LINES`, and ends
   with `routes/v1.py` and `main.py` reduced to composition.

## 5. Frontend

### 5.1 Layout (feature-sliced)

```
frontend/src/
  app/        providers (auth, query cache, SpaceProvider), router and route registry, shell (header, navigation)
  pages/      route-level screens; compose widgets and features; no HTTP
  widgets/    composite blocks shared by pages (ProblemHeader, RunResult, StudyResults, TradeOffs, PlanSummary)
  features/   user actions (create-problem-version, launch-run, compare-runs, publish-result, install-extension, change-plan)
  entities/   read models with their API hooks and small views (problem, version, run, engine, study, collection,
              published-result, organization, profile, dialect, plan)
  shared/     ui (design system and rendering catalogue §5.3), api (types generated from docs/openapi.json, http,
              problem+json), lib (formatters, including the identity labels of §5.4), config
```

Imports go downwards only (`pages → widgets → features → entities → shared`); features never import each other;
only `shared/api` performs HTTP. The 1,659-line `api/client.ts` is split into `entities/*/api.ts` over generated
types. Enforced with `eslint-plugin-boundaries` (constitution 6.6).

### 5.2 Information architecture

- **Public:** Home · Explore (Problems · Collections · Published results) · Engines · Language · Pricing · Verify ·
  About · Log in / Sign up.
- **Signed in:** header with organization/project switcher; Home · Problems · Lab (Runs · Studies · Generator) ·
  Engines · Language · Admin (administrators); "+ New" (problem, collection, study, run); search; notifications;
  account menu (Profile · Plan · API keys · Identities · Notifications).
- **Project:** Overview · Problems · Collections · Runs · Studies · Published · Settings (General · Members).
- **Problem page (the SPHERE "pricing page" analogue):** header with metrics and version selector; tabs Overview ·
  Runs · Versions · Source · Settings.
- **Run page:** verdict, engine mode and budget first; then the binding table, QoS against bounds, the objective
  breakdown and engine-claimed versus evaluated values; the trade-off set when there are several objectives; the
  log collapsed at the bottom.
- **Study page:** Setup · Progress · Results (protocol metrics, verdicts, gaps, times, ranking, trade-offs) ·
  Publish.
- **Published result page:** what was frozen and when, the rendered results and the citation panel.
- **Screen budget:** at most 45 routed screens (INTENT O12). A test counts the route registry, and each journey of
  INTENT §2 has a Playwright flow that completes in at most five screens.

### 5.3 Rendering catalogue

| Component | Shows | Used in |
|---|---|---|
| `MetricCards` | a row of key numbers with units and trend | dashboards, problem and study headers |
| `ProblemSummary` | tasks, candidates, binding-space size (log10), hard/soft constraints, objectives, profile chain, dialects | problem cards and header, Explore |
| `WorkflowGraph` | the compiled workflow (SEQ, AND, XOR with probabilities, LOOP) | problem Overview, version compare |
| `CandidateMatrix` | tasks × candidates × features, colour scales per feature, intervals as ranges | problem Overview |
| `ConstraintList`, `ObjectiveView` | bounds, hard/soft, penalties; objective terms, weights, directions | problem Overview, run result |
| `MetricSmallMultiples` | evolution of problem metrics across versions | problem Versions, collection page |
| `DistributionChart` | feature-value distributions per task or catalog | problem Overview |
| `BindingTable` | task → candidate → provider with per-feature contributions | run result |
| `QoSAgainstBounds` | aggregated QoS against constraint bounds | run result |
| `ObjectiveBreakdown` | weighted terms of the objective | run result, study cell |
| `TradeOffChart` | the trade-off set: non-dominated bindings as a table and a two-axis chart whose axes are chosen among the objectives | run result, study results |
| `EvaluationDiff` | engine-claimed versus gateway-evaluated values and downgrade reasons | run result |
| `VerdictBadge` | OPTIMAL · FEASIBLE · UNSAT · TIMEOUT · INCOMPATIBLE (with reasons) | everywhere a run appears |
| `CapabilityMatrix`, `ConformanceReport` | engine modes × capabilities; verification checks | engines, extensions |
| `StudyMatrix`, `ProtocolMetrics`, `RankingTable` | cells grid; coverage, yield, gap, reconciliation; ranking | studies |
| `DiagnosticsList` | diagnostics grouped by resource and pointer with code and hint | editor, validation, extensions |
| `LogPanel` | collapsed, searchable, downloadable log | run result, admin errors |
| `PricingTable` | the pricing (`pricing-renderer` React adapter) | Pricing, Plan |
| `FeatureGate` | UI gated by plan (`space-react-client` `<Feature>`) | anywhere a feature depends on the plan |
| `PlanUsage` | features and limits of the user's subscription from the pricing token | Plan, dashboards |
| `SourceView` | read-only code viewer with copy and download | only in Source tabs |
| `CitationPanel` | permanent link, citation (BibTeX, CSL-JSON) and the one copyable digest | problem, collection and published-result pages |
| `VerifyResult` | what a permanent link, a digest or a file resolves to, and whether it matches | Verify |

Charts use Recharts (already a dependency). A hygiene test forbids rendering `JSON.stringify` output or `<pre>`
outside `SourceView` and `LogPanel`, and digest-shaped text outside the components that §5.4 allows (constitution,
Article 15).

### 5.4 Identifiers on screen

People read names, machines read digests (INTENT principle 13).

| Thing | Shown as | Not shown |
|---|---|---|
| Problem version | `checkout-flow` v3 · sealed 20 Aug 2026 | content or version digests |
| Collection version | `QACOBench icws` v2 · 12 problems | digests, member fingerprints |
| Run | run 14 of `checkout-flow` v3 · `minizinc-csp` 1.1.1 exact · 21 Oct 2026 | job UUID, request digest |
| Study run | `engines-vs-suite` run 3 · 21 Oct 2026 | matrix or cell fingerprints |
| Published result | its title · published 22 Oct 2026 | edition fingerprint |
| Engine | `minizinc-csp` 1.1.1 · mode exact | manifest digest |

The API keeps every digest. `CitationPanel`, `VerifyResult` and export manifests are the only places that show one,
as a single value with a copy button; `SourceView` shows files as they are. UUIDs never appear in UI text; URLs
use permanent ids or slugs. The hygiene test fails on a digest-shaped string (`sha256-` or 40/64 hexadecimal
characters) or a UUID rendered anywhere else.

## 6. Domain model

```mermaid
classDiagram
  direction LR
  Organization "1" --> "*" Organization : parent of
  Organization "1" --> "*" Project
  Project "1" --> "*" Problem
  Problem "1" --> "*" ProblemVersion
  ProblemVersion "1" --> "1" CompiledForm
  Project "1" --> "*" Collection
  Collection "1" --> "*" CollectionVersion
  CollectionVersion "*" --> "*" ProblemVersion : ordered members
  Engine "1" --> "*" EngineRevision
  EngineRevision "1" --> "*" Mode
  EngineDeployment "*" --> "1" EngineRevision
  Run "*" --> "1" ProblemVersion
  Run "*" --> "1" Mode
  Run "1" --> "0..1" Result
  Study "1" --> "*" StudyRun
  StudyRun "1" --> "*" Cell
  Cell "1" --> "0..1" Run
  PublishedResult "*" --> "0..1" StudyRun : freezes
  PublishedResult "*" --> "0..1" CollectionVersion : freezes
  Profile "*" --> "0..1" Profile : extends
  Dialect "*" --> "*" Profile : compatible with
  Account "1" --> "1" Plan : SPACE contract
```

Mapping to `v1` names: Problem = `BindingCase`, ProblemVersion = case revision, CompiledForm = snapshot (`InstanceSnapshot`
and its IR), Run = `Job`, Result = job result plus re-evaluation, PublishedResult = a simplified `publications`
record (no report, no editions). A problem version's resources are sealed parts in the internal versioned-artifact
store, addressed by digest; there is no component catalogue (ADR-0020). Every sealed entity has a content digest
that the API returns and Verify checks;
screens name it as §5.4 says. Permanent links address problems, collections and published results independently of
slugs.

## 7. Key flows

### 7.1 Author, validate and version a problem

```mermaid
sequenceDiagram
  actor U as Researcher
  participant W as Web (problem editor)
  participant G as Gateway (repository, language)
  participant B as BIM toolchain
  U->>W: edit resources or upload a package
  W->>G: POST /v1/language/compile (package)
  G->>B: resolve contracts, lower dialects, compile profile chain
  B-->>G: IR, diagnostics, digests
  G-->>W: diagnostics, summary metrics, compatible engine modes
  U->>W: save as a new version
  W->>G: POST .../problems/{p}/versions
  G->>B: compile (exact contracts)
  G->>G: seal version and compiled form, compute problem metrics
  G-->>W: sealed version (number, digest), metrics, permanent link
```

### 7.2 Run a problem

```mermaid
sequenceDiagram
  actor U as Researcher
  participant G as Gateway (execution)
  participant P as Plans (SPACE)
  participant Q as Worker
  participant E as Engine
  U->>G: POST /v1/jobs (version, engine mode, configuration)
  G->>G: capability check (profile chain, IR features)
  alt not covered
    G-->>U: INCOMPATIBLE with the missing capabilities
  else covered
    G->>P: evaluate plan feature and limits
    G->>G: persist run, dispatch after commit
    Q->>E: IR + options (bim-engine/v1)
    E-->>Q: bindings and claims
    Q->>Q: canonical re-evaluation, downgrade unsupported claims
    Q-->>U: SSE status, then the rendered result (trade-off set if several objectives)
  end
```

### 7.3 Study

A study selects collections or problem versions, engine modes, parameter sets and seeds. A study run expands the
matrix into cells, each one a run with frozen inputs; cells retry independently. Analytics read only re-evaluated
results and compute the QACOBench protocol metrics: coverage (processable over submitted), conditional binding
yield (binding-returning over processable), gap to the certified optimum, verdict reconciliation (an UNSAT proof
contradicted by a validated binding, or an OPTIMAL beaten, invalidates the run), runtime distributions and rankings.
With several objectives, the results view also shows, per problem, the trade-off set across engines. The QACOBench
harness keeps working against the public API; the study is the same protocol inside the platform.

### 7.4 Publish a result

`Publish` freezes a finished study run or a collection version. The gateway seals the exact problem versions, engine
revisions, budgets, seeds and computed metrics into a published result with a permanent link, a digest and a
citation, and offers a Zenodo-ready export (results as CSV and JSON plus a manifest with every digest). A published
result is never edited: a correction is a new published result that names the one it corrects, and withdrawal hides
it from Explore while its permanent link keeps answering (§10). There is no document editor; the text of a paper lives
in the paper.

### 7.5 Plans

See §9.

### 7.6 Language extension lifecycle

See §8.4.

## 8. Language extensibility

### 8.1 Layers

| Layer | Owns | Changes how |
|---|---|---|
| BIM core | envelope, `Instance`, role-indexed resources, references, digests, provenance | BIM MAJOR/MINOR release only |
| Profile | a problem family: roles and cardinalities, resource types per role, output IR schema, capability vocabulary, limit vocabulary, evaluation semantics, adapter; **may extend one other profile** | new profile version |
| Dialect | a concrete syntax for resources of one or more profiles (media type, schema or XML root), lowered to the profile's canonical resource types or to declared extension points | new dialect version |
| Adapter | the lowering (and, for profiles, compile hooks and evaluator plug-ins) | tier 0, 1 or 2 (§8.3) |
| Extension package | a digest-addressed bundle: manifests, schemas, adapter descriptor, golden examples, documentation | submitted and reviewed (§8.4) |

### 8.2 Profiles that extend profiles

A profile may declare `extends: {namespace, name, version, digest}` (single inheritance). The child inherits the
parent's roles, cardinalities, resource types, vocabularies and output schema, and may:

- add roles and resource types, and tighten (never loosen) cardinalities;
- add capability dimensions and values, and limit names;
- extend the output IR with new sections described by a schema delta, without changing the meaning of any parent
  field;
- add evaluation semantics (constraints, aggregation operators, objective terms) implemented in the canonical
  evaluator, so the gateway can re-evaluate every binding (constitution 17.3);
- add compile hooks: deterministic pre-solve transforms from extension resources to features or constraints.

Compilation resolves the chain from the root, validates roles and cardinalities against the merged contract, lowers
dialects, runs the parent's lowering, then each child's lowering and hooks, validates the merged output schema and
records the whole chain, every adapter digest and the compiler digest in the IR.

**Placement becomes the reference extension.** `qos-binding-placement/v1` is re-declared as a profile extending
`qos-binding/v1`. It adds the `Placement` resource type in the `candidateCatalog` role (pools, capacities, network
latencies, events, transitions, global latency: the `R` and `L` of the CLASP model), its capability dimension and
evaluator semantics. Its output keeps today's `BindingProblem.spec.placement` shape, so engines, goldens and digests
of existing placement problems do not change; only the declaration moves from the core profile into the extension.
A pricing-aware profile (candidates as subscriptions; iPricings plus expected consumption compiled to cost features,
as in CLASP and PACO) is the next candidate. A domain that fits the core without new semantics — quantum resource
selection — needs no extension at all: it is plain BIM data.

### 8.3 Adapter tiers

| Tier | What it is | Who can install | Safety |
|---|---|---|---|
| 0 Built-in | reviewed Python in `bim-toolchain` (qos-binding, placement, BPMN) | ships with a BIM release | code review, goldens, consumer contracts |
| 1 Declarative | a mapping document evaluated by bim-core's sandboxed transform engine (BIM Expression IR plus structural mapping); no code | organization admins for their organization; platform admins publicly | total and bounded (size, steps, time); double lowering must match byte for byte |
| 2 Adapter service | an HTTP service implementing `bim-adapter/v1` (`GET /manifest`, `GET /health`, `POST /lower`) | platform admins | registered and verified like a federated engine: destination policy, authentication, determinism probes; outputs cached by input digest and stored with the compiled form |

BPMN stays tier 0 but is packaged and installed through the same lifecycle, as the reference for third-party
dialects.

### 8.4 Lifecycle

`draft → submitted → checked → approved → installed → deprecated → retired`, per exact version. Checking runs schema
validation, the golden examples, double lowering, and for tier 2 the conformance probes. A deprecated version still
compiles existing problem versions and is not offered for new ones; a version used by a sealed or cited problem
version is never retired. Approval in production is an owner decision (constitution 17.6).

### 8.5 Language API

| Operation | Purpose |
|---|---|
| `GET /v1/language` | overview: BIM core version, compiler digest, installed profiles and dialects, counts |
| `GET /v1/language/profiles`, `.../profiles/{namespace}/{name}`, `.../versions/{version}` | profiles with their chain, roles, capabilities, schemas and supporting engines |
| `GET /v1/language/dialects` (same shape) | dialects |
| `GET /v1/language/schemas/{kind}` | schemas (download) |
| `POST /v1/language/compile` | compile a package or an exact problem version: diagnostics, summary metrics, compatible engine modes |
| `POST /v1/language/extensions`, `GET .../extensions`, `GET .../extensions/{id}` | submit an extension package and follow its checks |
| `POST /v1/language/extensions/{id}/{approve,reject,deprecate,retire}` | administer the lifecycle |
| `POST /v1/language/adapter-services` and `.../{name}/{activate,deactivate}` | register tier 2 deployments |

The current `/v1/profiles`, `/v1/dialects`, `/v1/resources`, `/v1/schemas/{kind}`, `/v1/catalog`, `/v1/examples`
and `/v1/validate` stay as aliases with `Deprecation` and `Sunset` headers for one minor release (CRP).

### 8.6 Developer kit

`bim-toolchain` ships a `bim-ext` command: `new` (scaffold a dialect or profile), `test` (schemas, golden examples,
double lowering), `pack` (extension package and digest) and `submit` (to a platform with an API key), plus a template
repository and a how-to in `docs/`.

## 9. Plans: SPACE and SPHERE

### 9.1 Topology

```mermaid
flowchart LR
  subgraph SPHS["SPHERE · sphere.score.us.es"]
    PR[OpenBinding pricing<br/>Pricing2Yaml 3.1, versions]
    PL[public permanent-link API<br/>/p/6ab0a323697330667ccce891]
  end
  subgraph SPAS["SPACE 1.7.1 · local now, space.score.us.es later"]
    SV[service openbinding<br/>source sphere, policy all_last]
    CT[(contracts)]
    EV[feature evaluation<br/>solver hours, generated instances,<br/>pricing tokens]
  end
  subgraph OBS[OpenBinding]
    PM[plans module<br/>space-python-client]
    UI[web: space-react-client token-only<br/>pricing-renderer]
  end
  PR --> PL
  PL -- synchronization, every 5 min --> SV
  SV --- CT --- EV
  PM -- contracts, evaluate, revert, token, events --> EV
  PM -- pricing descriptor and YAML --> PL
  UI -- pricing token, pricing --> PM
```

| Who | Responsibility |
|---|---|
| SPHERE (`sphere.score.us.es`) | authoring and versioning of the OpenBinding pricing; public permanent-link API |
| SPACE | contracts, feature evaluation, the solver-hours and generated-instances usage levels, contract migration when the pricing changes, events |
| OpenBinding | enforcement points and its own counts for the other limits, contract creation (registration, CAS link), plan changes for FREE and RESEARCH and by administrators, pricing display, token issuance to the browser |

| Environment | SPHERE | SPACE |
|---|---|---|
| Unit tests and CI | a recorded copy of the pricing in `tests/fixtures`; no network | a fake `PlanPort` or `OpenGate` |
| Lab, PR previews, develop preview | `sphere.score.us.es`, read only | the stack's own SPACE 1.7.1 (`pricing` profile), linked to the permanent link |
| Production | `sphere.score.us.es` | the same local profile until `space.score.us.es` runs the latest release, then `space.score.us.es` |

### 9.2 Gateway side

- `modules/plans` implements `PlanPort` with `space-python-client` 1.x (asynchronous transport, Redis cache provider)
  and a MANAGEMENT-scoped key; `OpenGate` remains for development and tests and is refused with `APP_ENV=prod`.
- The **entitlement map** (operation → SPACE feature id `openbinding-<name>` and limits) lives in
  `modules/plans/domain`. At start-up and on `pricing_activated`, the gateway checks that every feature and limit it
  references exists in the active pricing and fails closed otherwise.
- Pricing 0.2.0 (`docs/pricing/`) declares seven features and twelve limits. SPACE tracks two usage levels, both
  renewable and monthly: `solverHours` and `generatedInstances`. A run on a built-in engine, a study cell or the
  solver part of a solver-aware generation is admitted while the month's hours are not exhausted and then consumes
  its time budget; a run that stops early is not refunded, so the count can be checked against the budgets. A
  generation is admitted while the month's instances are not exhausted and consumes the instances it writes. The
  other limits are plan values that the gateway compares with its own counts (running runs, cells of a study run, a
  run's budget, instances per generation request, problems and collections owned, repository storage, private
  projects, federated engines, API keys), so no counter can drift. The repository limits apply to FREE only; the
  other plans declare them as `.inf`.
- Gated operations call `evaluate(user, feature, expected_consumption)`; an operation that fails after consuming
  calls `revert_evaluation` (SPACE honours it within two minutes).
- SPACE events (`synchronized`, `pricing_created`, `pricing_activated`, `pricing_archived`, `service_disabled`)
  invalidate caches and are relayed to browsers as a `plans.changed` notification.
- `GET /v1/plans/pricing` (public) returns the pricing descriptor (permanent link, SPHERE version id and label,
  content hash, the version SPACE has activated) and the YAML read from SPHERE's public API
  (`/api/v1/public/pricings/{pricingId}` and `.../versions/{versionId}/yaml`, bounded to 5 MiB, hash-verified,
  ETag-cached). OpenBinding holds no SPHERE key.
- Removed: `sphere_client.py`, `pricing_catalog.py`, the deprecated `/v1/pricing` proxy and `/v1/pricing/catalog`,
  admin pricing validation, `space_client/deployments.py`, the release sweeps, local metering
  (`domain/usage_counters.py`) and the sponsorship capacity checks (ADR-0015, ADR-0020).

### 9.3 Browser side

- `SpaceProvider` with `allowConnectionWithSpace: false`; the token comes from `GET /v1/users/me/pricing-token` and is
  refreshed on sign-in, on plan change and on `plans.changed`. No SPACE key ever reaches the browser.
- `<Feature id="openbinding-…">` gates UI; the server enforces the same decision.
- The Pricing page and the account Plan page render the pricing with `pricing-renderer` (React adapter, themed with
  the OpenBinding tokens); signed-in users see their plan selected; FREE, and RESEARCH for accounts with a
  Universidad de Sevilla CAS identity, change self-service; LAB shows "Contact us".
- `space-react-client` 0.3.3 declares React ^18.3.1; OpenBinding runs React 19. A spike validates it in token-only
  mode; if it fails, the fix is proposed upstream to `Alex-GF/space-react-client` rather than forked.

### 9.4 A local SPACE linked to the remote SPHERE

The stack gains an optional `pricing` profile with SPACE 1.7.1 (`ghcr.io/scorelabus/space-api:1.7.1`, pinned by
digest, with its MongoDB and Redis; the SPACE web client only when an administrator needs it) and a one-shot
`pricing-bootstrap` that:

1. creates the SPACE organization of the stack and a MANAGEMENT key, kept in the stack's secret store;
2. creates the `openbinding` service from the SPHERE permanent link (`source: sphere`, `policy: all_last`) and runs a
   first synchronization;
3. creates contracts for the synthetic users of the seed.

SPACE runs with `SPHERE_PUBLIC_URL=https://sphere.score.us.es` and `SPHERE_SYNC_ENABLED=true`: its worker checks the
link on a staggered five-minute schedule, so a new public version of the pricing migrates the contracts without any
change in OpenBinding. SPHERE is not run locally; the stack needs outbound HTTPS to `sphere.score.us.es` only.
Estimated memory ≈ 0.7 GiB, measured before the profile is on by default.

When `space.score.us.es` runs the latest release, the owner switches by configuration (SPACE URL and key); the plans
module, the entitlement map and the browser code do not change. Contracts held by a local SPACE are synthetic and are
not carried over.

## 10. Storage and retention

| Data | Where | Retention |
|---|---|---|
| Sealed problem and collection versions, compiled forms, published results | PostgreSQL + blob store | permanent; withdrawal hides, never deletes |
| Sealed parts in the versioned-artifact store (resources, study definitions, execution configurations) | PostgreSQL + blob store | permanent while a sealed version, a study run or a run references them |
| Drafts | PostgreSQL | until deleted; owner notified after 180 idle days |
| Runs and results | PostgreSQL + blob store | permanent while part of a study run or a published result; otherwise 365 days |
| Raw engine logs | blob store | 90 days unless the run belongs to a published result |
| Data of retired features (report drafts, decision-space workspaces, sponsorship proposals) | export for the owner | dropped after the export, by a guarded migration that refuses to drop non-empty tables without an export manifest (M9.6, §4.3) |
| Uploads not referenced by any version | blob store | 30 days |
| Notifications | PostgreSQL | 180 days |
| Audit events | PostgreSQL | permanent |
| Lab previews | lab Docker volumes | expire after 7 idle days; `develop` preview is permanent |
| Factory work trees and task branches | lab project directory | archived within 24 h of merge or cancellation; archives kept 30 days |
| Factory and gate reports | lab state | 90 days, except release evidence |
| Datasets, raw campaign results | Zenodo | never in Git or the platform database |

Purges run through `/v1/admin/maintenance/preview|purge` and scheduled workers; factory retention runs through the
factory's maintenance operations (constitution, Article 18).

## 11. Quality architecture

| Level | What | Where | Gate |
|---|---|---|---|
| Specification | EARS requirements with `req~…~N` ids, scenarios | `openspec/` | G1, G2 |
| Acceptance | executable scenarios written from the spec before the code: API flows with pytest, UI flows with Playwright | `acceptance/api/`, `acceptance/ui/` | G3, G4 |
| Unit and property | pytest, Hypothesis, Vitest | per package | G5 |
| Contract | OpenAPI snapshot, JSON Schemas, Schemathesis, BIM and engine consumer contracts; SPHERE against a recorded pricing in CI and `sphere.score.us.es` in the lab; SPACE against its pinned image in the lab | CI and lab | G7 |
| Traceability | OpenFastTrace over specs, code, tests and acceptance | CI | G6 |
| Mutation | mutmut (Python), Stryker (TypeScript) on changed code | Actions | G8 |
| Static | ruff, mypy (ratcheted), ESLint, Semgrep, dependency audit, licences, import-linter, boundaries | CI | G9 |
| Secrets and ownership | secret scan, owned globs | CI | G10 |
| Review panel | reviewers by risk | factory | G11 |
| Preview | lab deployment, Playwright flows, ui-qa screenshots (desktop and mobile), axe | NiPoGi lab | G12 |

Acceptance tests are the specification made executable: each scenario carries `[utest->req~…]`, is frozen before
implementation and runs against the preview of the change's head.

## 12. Environments and previews

| Environment | Where | Compose files | Data | Purpose |
|---|---|---|---|---|
| Development | developer machine or factory work tree | `docker-compose.yml` (profile `dev`) | synthetic | build and unit tests |
| Lab | NiPoGi rootless lab Docker | `deploy/compose/lab*.json` profiles | synthetic seed | integration, gates, e2e |
| PR preview | NiPoGi lab, one stack per PR head on demand | the lab files | synthetic seed | G12 before merging into `develop` |
| Develop preview | NiPoGi lab, follows `develop`; `https://openbinding.home.javiercavlop.com` | the lab files | synthetic seed | the owner reviews `develop` from the Mac or the iPhone |
| Production | Universidad de Sevilla servers (`openbinding.score.us.es`) | `deploy/compose/production` overlay | real | only on the owner's order |

Docker Compose is the only deployment tool (ADR-0021): one base definition and an overlay per environment, images
pinned by digest, secrets mounted as files, health checks on every service, PostgreSQL backups by a scheduled
`pg_dump` service and volume snapshots. There are no Kubernetes manifests.

The develop preview sits behind the homelab Caddy (TLS, home network and WireGuard VPN only) with an AdGuard
rewrite; web and API share its origin (`/api`), so no CORS entry is needed. PR previews expire after 7 idle days.

## 13. Repository layout

The application directories keep their names; the clutter at the root moves:

| From | To |
|---|---|
| `compose.lab*.json`, `compose.pgtest.json` | `deploy/compose/` |
| `docker-compose.yml` | stays at the root as the development entry point |
| `deploy/kubernetes/` | removed (ADR-0021) |
| `nginx/`, `up.sh` | `deploy/` |
| `pricings/` (FaaS iPricings of CLASP) | `experimentation/clasp/pricings/` |
| `output/` (Zenodo packaging) | `experimentation/qacobench/zenodo/` |
| — | `acceptance/` (new), `deploy/compose/production/` (new), `docs/pricing/` (OpenBinding's pricing proposals and their rationale; SPHERE holds the published versions) |
| `bim-toolchain/` | removed after the extraction to `isa-group/bim-toolchain` (ADR-0004) |

Each move is one `refactor/<id>` change that updates CI, Dockerfiles, documentation links and tests together.

## 14. Decisions

| ADR | Decision |
|---|---|
| [0001](adr/0001-record-architecture-decisions.md)–[0013](adr/0013-committed-openapi-snapshot.md) | baseline decisions (BIM as canonical language behind a port, engines as services, durable jobs, pinned MiniZinc, datasets outside Git, frontend stack, problem+json, layered gateway, OpenAPI snapshot) |
| [0014](adr/0014-render-never-dump.md) | render, never dump |
| [0015](adr/0015-plans-through-space-and-sphere-clients.md) | plans through SPACE and SPHERE with their real clients (supersedes 0010); SPHERE at `sphere.score.us.es`, a local SPACE until `space.score.us.es` runs the latest release |
| [0016](adr/0016-extensible-language-profiles-and-dialects.md) | profiles that extend profiles, adapter tiers, language API |
| [0017](adr/0017-modular-monolith-and-feature-sliced-frontend.md) | modular monolith and feature-sliced frontend (evolves 0012) |
| [0018](adr/0018-problem-centred-vocabulary.md) | problem-centred vocabulary in the UI, API `v1` unchanged |
| [0019](adr/0019-previews-and-retention.md) | previews before merge and storage retention |
| [0020](adr/0020-smaller-platform.md) | a smaller platform: journeys decide what exists; five features retire; people read names, machines read digests |
| [0021](adr/0021-docker-compose-only.md) | Docker Compose deploys every environment; Kubernetes manifests removed |

Status: PROPOSED for owner review (2026-10-22, revision 2: smaller platform, plans topology, Docker Compose). The
factory updates the Status column; milestones change only with the owner's approval (INTENT §11).

# Roadmap — OpenBinding

The order in which the factory turns [`INTENT.md`](INTENT.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
into working software. Each milestone becomes owner requests; the coordinator slices them into changes of one
capability (≤ ~300 diff lines), each one specified in OpenSpec, tested first, built, reviewed, previewed in the NiPoGi
lab and squash-merged into `develop`. Releases to `main` are pull requests that only the owner merges.

How to follow it: the factory panel (`nipogi-fabrica`), the factory connector in Claude (status, events, items that
need the owner), the develop preview at `https://openbinding.home.javiercavlop.com`, and this file.

## Overview

| Id | Milestone | Depends on | Preview checkpoint | Release | Status |
|---|---|---|---|---|---|
| M0 | Foundation: integration landed, gates, previews, storage, Docker Compose only | — | develop preview reachable from the Mac and the iPhone | — | in progress (M0.3 done; M0.1 unverified; M0.5 in progress; CI also runs on pushes to `develop`, manually and nightly; flaky-test register in `docs/qa/FLAKY_TESTS.md`) |
| M1 | Specification v2 (this document set) | — | — | — | done (PR #25, merged 2026-10-23) |
| M2 | Render, never dump; retirements, navigation and vocabulary | M0 | every screen in the QA gallery, desktop and mobile, within the screen budget | R1 = M0–M2 | in progress (M2.1 and M2.2 merged, PR #38; M2.4 in progress, slice 1 under review) |
| M3 | Problem repository | M2 (catalogue) | Explore → problem page → versions → runs | R2 = M3–M4 | planned |
| M4 | Plans: SPHERE remote, SPACE local then remote | M0; pricing 0.2.0 published | the pricing-change scenario of M4 | R2 | in progress (M4.0 done; M4.1 partly, PR #36) |
| M5 | Language extensibility | M0; bim-toolchain release | placement as an extension; a tier-1 dialect installed | R3 = M5–M6 | planned |
| M6 | Laboratory, published results and QACOBench inside the platform | M3 | a study reproducing an icws suite, published and verified | R3 | planned |
| M7 | Engines | M5 (profile support) | engine health and onboarding | R4 | planned |
| M8 | Collaboration and administration completion | M2, M4 | overviews on real data | R4 | planned |
| M9 | Architecture migration (continuous) | — | none (behaviour-preserving) | with each release | planned |

M2, M4 and the first steps of M9 can run in parallel; M3 starts when the M2 rendering components exist.

## M0 — Foundation

Goal: `develop` is green, gated and previewable, and the lab does not fill up.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M0.1 | Land PR #24 (integration of the platform on the QACOBench 1.1.1 release) | CI green (frontend job on Node 22); review panel approved; `develop` fast-forwarded to the reviewed head, keeping the 303 commits |
| M0.2 | OpenSpec strict validation | `openspec validate --strict --all` exits 0 (today 16 specs fail on requirement text length) |
| M0.3 | Gate tooling | OpenSpec CLI (G1) and OpenFastTrace (G6) run in CI and in the gate runner; `acceptance/api` (pytest) and `acceptance/ui` (Playwright) runners exist; import-linter and ESLint boundaries run in report-only mode (G9); a `bim-toolchain` CI job runs its tests and goldens on every change under `bim-toolchain/` until the extraction to `isa-group/bim-toolchain` |
| M0.4 | Develop preview | a lab stack follows `develop` and is rebuilt after each merge; `https://openbinding.home.javiercavlop.com` (homelab Caddy site and AdGuard rewrite, in place since 2026-10-22) serves it to the Mac and the iPhone |
| M0.5 | PR previews | the factory brings up a preview per PR head on demand and expires it after 7 idle days |
| M0.6 | Storage and retention in the lab | stale work trees and task branches archived through the factory maintenance operations; retention jobs for reports and archives; lab disk below 70 % of the quota |
| M0.7 | Factory hygiene | local integration commits keep the Conventional Commit subject and trailers of the task |
| M0.8 | QACOBench after the integration: capability refusals get their own error code `engine_incompatible` (additive, in `docs/ERRORS.md` and the OpenAPI snapshot) instead of `campaign.py` parsing messages; `minizinc-csp` 1.1.1 gets a new frozen baseline and the `CHANGED_MANIFESTS` exception goes; `reference/1.1.1` stays the historical reference and 1.1.2 is released from a green `develop` (CRP for the release itself) | no baseline exceptions left; a `reference/1.1.2` whose provenance digests match the platform; `reference/1.1.1` unchanged |
| M0.9 | Docker Compose only (ADR-0021): `deploy/kubernetes/`, its CI step and its documentation removed; a `deploy/compose/production` overlay (images pinned by digest, secrets as files, health checks, backups, limits) with its runbook | no Kubernetes file or step left; `docker compose config` passes in CI for development, lab and production |

Slice status (2026-10-24): M0.1 in progress, unverified (PR #24 work is recorded in `docs/agent-work/`, but no
record of its merge or of the fast-forward of `develop` is in the repository); M0.3 done (PR #37, gate tooling,
merged 2026-10-24); M0.5 in progress (PR #34 planner and contract tests merged; S4, the isolation probe and the PR
previews docs, landed in PR #39; S1a and S2 (`DEMO_LAB_PORT`) are in open PR #41, not yet merged); the other
slices have no recorded progress.

## M1 — Specification v2

`INTENT.md`, `constitution.md` (Articles 6, 15–19), `docs/ARCHITECTURE.md`, this roadmap, ADR 0014–0021,
`AGENTS.md`, `openspec/project.md` and the pricing proposal 0.2.0 with its pricification rationale (`docs/pricing/`).
Accepted when the owner approves PR #25; then it merges into `develop`.

## M2 — Render, never dump; navigation and vocabulary

Goal: no screen shows raw data; what no journey needs is gone; the navigation of `docs/ARCHITECTURE.md` §5.2; the
vocabulary of `INTENT.md` §5; names instead of digests.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M2.1 | Rendering catalogue foundations: `SourceView`, `LogPanel`, `DiagnosticsList`, `VerdictBadge`, `MetricCards` | components with unit and accessibility tests; documented in the design system |
| M2.2 | Hygiene test with a shrinking allow-list of today's offenders | test fails on any new raw rendering; allow-list lists the 15 offenders below |
| M2.3 | Run result rendered (`BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`, `LogPanel`, and `TradeOffChart` when there are several objectives) | offenders 1–4 removed from the allow-list |
| M2.4 | Retirements, screens first (ADR-0020): decision-space workspace, report editor, library catalogue and project resources, composer, sponsorship; old URLs redirect to their replacement; their endpoints answer with `Deprecation` and `Sunset` headers (CRP) | offenders 5, 7 and 11 gone with their screens; the route count drops; no link leads to a retired screen |
| M2.5 | Studies, engines, audit, registration and generator rendered; raw views moved to Source tabs | offenders 8–10 and 12–15 removed |
| M2.6 | Navigation and project tabs of ARCHITECTURE §5.2, Problem/Run vocabulary, Verify page (resolve and verifier, offender 6), system-states screen development-only | e2e route smoke green; old URLs redirect; allow-list empty; at most 45 routed screens |
| M2.7 | Names, not digests (INTENT principle 13, ARCHITECTURE §5.4): identity labels in `shared/lib`; digests, fingerprints and UUIDs removed from cards, lists, headers and badges; `CitationPanel` and `VerifyResult` | the hygiene test finds no digest-shaped text or UUID outside the allowed components |
| M2.8 | QA gallery refreshed and reviewed by ui-qa | desktop and mobile screenshots attached to the release PR |

Slice status (2026-10-25): M2.1 and M2.2 merged (PR #38); M2.4 in progress: slice 1 (decision-space workspace) is
under review in the pull request of change `m24-retire-screens`; the remaining slices follow in this order: report
editor, library catalogue and project resources, composer, sponsorship. The endpoints and their `Deprecation` and
`Sunset` headers are a separate step that needs an owner CRP. The other slices have no recorded progress.

Raw-rendering offenders at 912648c (INTENT O5):

1. `frontend/src/components/EngineReportView/EngineReportView.tsx:182,187,198` — solutions, provenance and raw report in `<pre>`
2. `frontend/src/pages/Jobs/JobResult.tsx:31` — generic JSON block; `:286` — engine log in `<pre>`
3. `frontend/src/pages/Workbench/RunPanel.tsx:28,54` — decision and solution JSON
4. `frontend/src/pages/Workbench/CheckResult.tsx:58` — diagnostic item stringified as fallback
5. `frontend/src/pages/Reports/RepDetail.tsx:77,326,329` — whole report as JSON and "Copy JSON"
6. `frontend/src/pages/Reports/Verifier.tsx:178` — canonical JSON as the result
7. `frontend/src/pages/Analysis/Inspector.tsx:79,141` — reference stringified; raw metrics and constraints
8. `frontend/src/pages/Studies/StudyCell.tsx:296` — cell metrics source
9. `frontend/src/pages/Studies/StudyDetail.tsx:277` — study definition source
10. `frontend/src/pages/Engines/EngineParts.tsx:47` — manifest JSON
11. `frontend/src/pages/Library/ContentView.tsx:196` — content source as main view
12. `frontend/src/pages/Organization/OrgAudit.tsx:88` — audit values stringified
13. `frontend/src/pages/RegisterEngine/EngineForm.tsx:179` — option schema stringified
14. `frontend/src/pages/Generator/LabAside.tsx:25` — generated text in `<pre>`
15. `frontend/src/pages/Cases/SnapshotDetail.tsx:94` — compiled form as the main view (moves to the Source tab)

## M3 — Problem repository

Goal: problems are the centre of OpenBinding, as pricings are of SPHERE.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M3.1 | Problem metrics computed when a version is sealed (tasks, service tasks, candidates per task, binding-space size, features, hard/soft constraints, objectives, workflow depth and branching, profile chain, dialects) and returned by the API | metrics are deterministic for a compiled form; stored once; exposed in list and detail payloads |
| M3.2 | Problem page: header with metrics and version selector; Overview with `WorkflowGraph`, `CandidateMatrix`, `ConstraintList`, `ObjectiveView` | the corpus examples render without raw data |
| M3.3 | Versions tab (history, compare, metric evolution with `MetricSmallMultiples`) and Source tab (files, compiled form, download) | compare shows changed resources and metric deltas; evolution charts for a problem with ≥ 3 versions |
| M3.4 | Runs tab (runs by engine with `VerdictBadge`, comparison, trade-offs) | a problem with runs of three engines shows them side by side |
| M3.5 | Explore: public problems, collections and published results with metrics, filters (profile, size, constraints, objectives, source) and permanent links `/p/{id}` and `/c/{id}` | a permanent link survives a rename or a move between projects |
| M3.6 | Problem editor (workbench and composer merged): new problem from a package, an example or another problem; live validation; compatible engines; "Try it" without an account | creating, validating and sealing a version without leaving the problem |
| M3.7 | Import and export on the problem and collection pages (package, collection ZIP, export with manifest); the project Files and Package pages go | a collection exported and imported into another project yields the same versions |
| M3.8 | Examples as the public "BIM examples" collection | the corpus examples are browsable in Explore |

## M4 — Plans: SPHERE remote, SPACE local then remote

Goal: OpenBinding behaves like the TomatoMeter host application: its pricing lives in SPHERE at `sphere.score.us.es`,
SPACE operates it, and OpenBinding adapts without redeploying. SPACE runs locally in each stack until
`space.score.us.es` runs the latest release (INTENT D5).

| Slice | Deliverable | Acceptance |
|---|---|---|
| M4.0 | Owner action: publish pricing 0.2.0 (`docs/pricing/openbinding-0.2.0.yml`) in SPHERE under the OpenBinding permanent link (INTENT D9) | SPHERE's public manifest lists 0.2.0 as the latest version |
| M4.1 | Lab `pricing` profile: a pinned SPACE 1.7.1 (`space-api`, MongoDB, Redis), `pricing-bootstrap` that creates the `openbinding` service from `https://sphere.score.us.es/p/6ab0a323697330667ccce891` (`all_last`) and contracts for the synthetic users; no local SPHERE; `tests/test_no_local_space.py` narrowed (ADR-0015) | `labctl`/`lab_compose` brings it up; SPACE shows the service `ready` on the latest public version; the lab reaches `sphere.score.us.es` over HTTPS |
| M4.2 | `plans` module over `space-python-client` (existing gate moved): entitlement map of pricing 0.2.0 verified against the active pricing, solver hours and generated instances consumed at admission, other limits (repository limits of FREE included) against the gateway's own counts, event relay, revert on failure | contract tests against the lab profile; fail-closed when SPACE is down |
| M4.3 | `GET /v1/plans/pricing` from SPHERE's public API (a recorded pricing in tests); removal of `sphere_client.py`, `pricing_catalog.py`, deprecated pricing routes, release sweeps, local metering and sponsorship capacity checks | no SPHERE key in settings; architecture test forbids SPACE/SPHERE HTTP outside `plans`; unit suites open no connection to SPACE or SPHERE |
| M4.4 | Browser: `space-react-client` in token-only mode (React 19 spike first), `FeatureGate`, Pricing and Plan pages with `pricing-renderer` | the custom pricing table is gone; UI gating matches server decisions |
| M4.5 | Lab and previews run with the local SPACE by default | seed users have contracts; previews show real plans |
| M4.6 | Switch to `space.score.us.es` once it runs the latest SPACE release (owner decision, configuration only) | previews and production use it; the local profile is off |

Slice status (2026-10-24): M4.0 done (recorded owner confirmation of 2026-10-24, owner request
own-88f5fc0a772945149100023a6a783368: the SPHERE public manifest
https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891 lists 0.2.0 as the latest version,
latestVersionId `6ada6dbd4b2b5b01c587d17f`, createdAt 2026-10-22, contentHash
`3db4ad99b33f0a591fcc71167bb7410e10a477429d48a0105afd17bf629b182c`, equal to `docs/pricing/openbinding-0.2.0.yml`); M4.1 partly merged (PR #36: optional pricing profile, static tests,
narrowed no-local-space test); the other slices have no recorded progress.

Acceptance scenario (end to end, in a preview): when a new public version of the OpenBinding pricing appears in
SPHERE (0.2.0 is the first), the stack's SPACE migrates the contracts within its synchronization cycle (five minutes,
or "Synchronize now") and OpenBinding's API and UI enforce the new values without a redeploy.

## M5 — Language extensibility

Goal: profiles that extend profiles, installable dialects, one language API and a developer kit.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M5.1 | `extends` in Profile manifests: chain resolution, merged validation, chain recorded in the IR (BIM MINOR release, CRP) | all goldens and corpus digests unchanged |
| M5.2 | Placement re-declared as `qos-binding-placement/v1` extending `qos-binding/v1`; engines declare supported profiles; placement documentation aligned (`candidateCatalog` role) | placement problems compile to the same IR; an engine without the extension yields `INCOMPATIBLE` naming the profile |
| M5.3 | `/v1/language/*` API with aliases and deprecation headers for the old routes (CRP) | contract tests for both paths |
| M5.4 | Extension lifecycle (submit, check, approve, install, deprecate, retire) generalizing dialect submission; BPMN packaged through it | lifecycle states and reports rendered in the Language hub |
| M5.5 | Tier-1 declarative adapters in bim-core, with a first dialect: QWS-style tabular candidate catalogs | a QWS CSV becomes a candidate catalog; double lowering identical |
| M5.6 | Developer kit `bim-ext` (new, test, pack, submit) and how-to | an author scaffolds, tests and submits a dialect from the template |
| M5.7 | Tier-2 adapter services (`bim-adapter/v1`), registered and verified like federated engines | determinism probes and destination policy enforced |

## M6 — Laboratory and QACOBench inside the platform

| Slice | Deliverable | Acceptance |
|---|---|---|
| M6.1 | Study results in one view: QACOBench protocol metrics, verdicts, gaps, times, ranking and, with several objectives, the trade-off set per problem; CSV/JSON export | metrics equal `evaluate_results.py` on the same inputs |
| M6.2 | Generator, in every plan, writes problems into a collection; each generation counts its instances (`generatedInstances`, `maxInstancesPerGeneration`) and the capability-checked (solver-aware) option also counts solver hours | generated suites are collections with provenance (configuration, seed, generator version); FREE stops at its monthly and per-request limits |
| M6.3 | QACOBench 1.1.1 suites imported as public collections with provenance (subset in the lab, all in production) | each suite shows instance counts and metric ranges matching the paper's table |
| M6.4 | Reference protocol as a study | a study over the icws suite reproduces its reference verdict counts (INTENT O4) |
| M6.5 | Published results (ADR-0020, ARCHITECTURE §7.4): "Publish" freezes a study run or a collection version with a permanent link, a citation and a Zenodo-ready export; existing publications become read-only published results | a published study result opens from its permanent link without an account and Verify confirms it |

## M7 — Engines

| Slice | Deliverable | Acceptance |
|---|---|---|
| M7.1 | Engine health and capability dashboard; conformance reports rendered | health history per engine; failed checks explained |
| M7.2 | Federated-engine onboarding wizard | an engine author registers, verifies and requests publication without reading raw manifests |
| M7.3 | Cancellation in `bim-engine/v1` (CRP: public contract) | a cancelled run stops the remote engine |

## M8 — Collaboration and administration completion

| Slice | Deliverable | Acceptance |
|---|---|---|
| M8.1 | Home, organization, project and admin overviews on real data | no placeholder figures; each figure links to its list |
| M8.2 | Storage and retention administration (INTENT O11, ARCHITECTURE §10) | admin sees usage per class and the next purge |
| M8.3 | Notifications for plan changes, finished studies and published results | preferences respected |

## M9 — Architecture migration (continuous)

| Slice | Deliverable | Acceptance |
|---|---|---|
| M9.1 | `app/`, `shared/`, `modules/` skeleton with import-linter contracts | contracts enforced for new modules |
| M9.2 | Modules moved in the order of ARCHITECTURE §4.3, one per change | `docs/openapi.json` unchanged by each move; ratchets shrink |
| M9.3 | Frontend feature-sliced layout; API types generated from `docs/openapi.json`; `api/client.ts` split | ESLint boundaries enforced |
| M9.4 | Repository layout of ARCHITECTURE §13 | CI, Dockerfiles and links updated in the same change |
| M9.5 | BIM toolchain extracted to `isa-group/bim-toolchain` and consumed as a pinned release (ADR-0004) | consumer contracts green on both sides |
| M9.6 | Retired endpoints, code and data (ADR-0020, after the Sunset of M2.4): endpoints removed (CRP); the `analysis` queue and worker removed; report drafts, decision-space workspaces and sponsorship proposals exported and dropped (CRP) | `docs/openapi.json` shrinks; every sealed problem version compiles to the same IR; existing publications still answer at their permanent links |

## Releases

| Release | Content | What the owner reviews |
|---|---|---|
| R1 | M0–M2 | release PR with MRP, the develop preview, the QA gallery |
| R2 | M3–M4 | repository and plans scenarios in the preview |
| R3 | M5–M6 | extensions, the QACOBench study and its published result in the preview |
| R4 | M7–M8 | engines, dashboards and administration |

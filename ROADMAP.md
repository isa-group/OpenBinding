Status: PROPOSED for owner review (2026-10-22). The factory updates the Status column; milestones change only with
the owner's approval (INTENT §11).

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
| M0 | Foundation: integration landed, gates, previews, storage | — | develop preview reachable from the Mac and the iPhone | — | in progress |
| M1 | Specification v2 (this document set) | — | — | — | in review |
| M2 | Render, never dump; navigation and vocabulary | M0 | every screen in the QA gallery, desktop and mobile | R1 = M0–M2 | planned |
| M3 | Problem repository | M2 (catalogue) | Explore → problem page → versions → runs | R2 = M3–M4 | planned |
| M4 | Plans through SPACE and SPHERE | M0 | the pricing-change scenario of M4 | R2 | planned |
| M5 | Language extensibility | M0; bim-toolchain release | placement as an extension; a tier-1 dialect installed | R3 = M5–M6 | planned |
| M6 | Laboratory and QACOBench inside the platform | M3 | a study reproducing an icws suite | R3 | planned |
| M7 | Engines | M5 (profile support) | engine health and onboarding | R4 | planned |
| M8 | Collaboration and administration completion | M2, M4 | dashboards on real data | R4 | planned |
| M9 | Architecture migration (continuous) | — | none (behaviour-preserving) | with each release | planned |

M2, M4 and the first steps of M9 can run in parallel; M3 starts when the M2 rendering components exist.

## M0 — Foundation

Goal: `develop` is green, gated and previewable, and the lab does not fill up.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M0.1 | Land PR #24 (integration of the platform on the QACOBench 1.1.1 release) | CI green; review panel approved; `develop` fast-forwarded to the reviewed head, keeping the 303 commits |
| M0.2 | OpenSpec strict validation | `openspec validate --strict --all` exits 0 (today 16 specs fail on requirement text length) |
| M0.3 | Gate tooling | OpenSpec CLI (G1) and OpenFastTrace (G6) run in CI and in the gate runner; `acceptance/api` (pytest) and `acceptance/ui` (Playwright) runners exist; import-linter and ESLint boundaries run in report-only mode (G9); a `bim-toolchain` CI job runs its tests and goldens on every change under `bim-toolchain/` until the extraction to `isa-group/bim-toolchain` |
| M0.4 | Develop preview | a lab stack follows `develop`; `https://openbinding.home.javiercavlop.com` opens from the Mac and the iPhone (homelab Caddy site and AdGuard rewrite, one owner action); its origin is in `CORS_ALLOW_ORIGINS` |
| M0.5 | PR previews | the factory brings up a preview per PR head on demand and expires it after 7 idle days |
| M0.6 | Storage and retention in the lab | stale work trees and task branches archived through the factory maintenance operations; retention jobs for reports and archives; lab disk below 70 % of the quota |
| M0.7 | Factory hygiene | local integration commits keep the Conventional Commit subject and trailers of the task |
| M0.8 | QACOBench after the integration: capability refusals get their own error code `engine_incompatible` (additive, in `docs/ERRORS.md` and the OpenAPI snapshot) instead of `campaign.py` parsing messages; `minizinc-csp` 1.1.1 gets a new frozen baseline and the `CHANGED_MANIFESTS` exception goes; `reference/1.1.1` stays the historical reference and 1.1.2 is released from a green `develop` (CRP for the release itself) | no baseline exceptions left; a `reference/1.1.2` whose provenance digests match the platform; `reference/1.1.1` unchanged |

## M1 — Specification v2

`INTENT.md`, `constitution.md` (Articles 6, 15–19), `docs/ARCHITECTURE.md`, this roadmap, ADR 0014–0019,
`AGENTS.md` and `openspec/project.md`. Accepted when the owner approves PR #25; then it merges into `develop`.

## M2 — Render, never dump; navigation and vocabulary

Goal: no screen shows raw data; the navigation of `docs/ARCHITECTURE.md` §5.2; the vocabulary of `INTENT.md` §5.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M2.1 | Rendering catalogue foundations: `SourceView`, `LogPanel`, `DiagnosticsList`, `VerdictBadge`, `MetricCards` | components with unit and accessibility tests; documented in the design system |
| M2.2 | Hygiene test with a shrinking allow-list of today's offenders | test fails on any new raw rendering; allow-list lists the 15 offenders below |
| M2.3 | Run result rendered (`BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`, `LogPanel`) | offenders 1–4 removed from the allow-list |
| M2.4 | Reports, studies and analysis rendered; raw views moved to Source tabs | offenders 5–9 removed |
| M2.5 | Engines, library, audit, registration, generator, verifier | offenders 10–15 removed; allow-list empty |
| M2.6 | Navigation, project tabs, Problem/Run vocabulary, Verify page (resolve + verifier), Analysis merged with redirects, system-states screen development-only | e2e route smoke green; old URLs redirect |
| M2.7 | QA gallery refreshed and reviewed by ui-qa | desktop and mobile screenshots attached to the release PR |

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
| M3.3 | Versions tab (history, compare) and Source tab (files, compiled form, download) | compare shows changed components and metric deltas |
| M3.4 | Runs tab (runs by engine with `VerdictBadge`, comparison, trade-offs) | a problem with runs of three engines shows them side by side |
| M3.5 | Analysis tab: `MetricSmallMultiples` across versions and `DistributionChart` | evolution charts for a problem with ≥ 3 versions |
| M3.6 | Explore: public problems and collections with metrics, filters (profile, size, constraints, objectives, source) and permanent links `/p/{id}` and `/c/{id}` | a permanent link survives a rename or a move between projects |
| M3.7 | Problem editor (workbench merged): new problem from a package, an example or components; live validation; compatible engines | creating, validating and sealing a version without leaving the problem |
| M3.8 | Components: one catalogue per organization (library, project resources and project library merged in the UI) | a component used by two problems shows both |
| M3.9 | Examples as the public "BIM examples" collection | the corpus examples are browsable in Explore |

## M4 — Plans through SPACE and SPHERE

Goal: OpenBinding behaves like the TomatoMeter host application: its pricing lives in SPHERE, SPACE operates it,
and OpenBinding adapts without redeploying.

| Slice | Deliverable | Acceptance |
|---|---|---|
| M4.1 | Lab `pricing` profile: pinned SPHERE and SPACE images, `pricing-bootstrap`, reference pricing `deploy/pricing/openbinding.yml` (Pricing2Yaml 3.1, `createdAt` as `YYYY-MM-DD`, which SPACE requires) | `labctl`/`lab_compose` brings both up; SPACE shows the service linked and synchronized |
| M4.2 | `plans` module over `space-python-client` (existing gate moved), entitlement map verified against the active pricing, event relay, revert on failure | contract tests against the lab pricing profile; fail-closed when SPACE is down |
| M4.3 | `GET /v1/plans/pricing` from SPHERE's public API; removal of `sphere_client.py`, `pricing_catalog.py`, deprecated pricing routes and release sweeps | no SPHERE key in settings; architecture test forbids SPACE/SPHERE HTTP outside `plans` |
| M4.4 | Browser: `space-react-client` in token-only mode (React 19 spike first), `FeatureGate`, Pricing and Plan pages with `pricing-renderer` | the custom pricing table is gone; UI gating matches server decisions |
| M4.5 | Lab and previews run with SPACE enabled by default | seed users have contracts; previews show real plans |

Acceptance scenario (end to end, in a preview): change a limit or feature of a plan in the lab SPHERE and publish a
new version; within two minutes SPACE migrates the contracts and OpenBinding's API and UI enforce the new value
without a redeploy.

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
| M6.1 | Study analytics with the QACOBench protocol metrics and a trade-offs tab (the decision-space analysis merged) | metrics equal `evaluate_results.py` on the same inputs |
| M6.2 | Generator writes problems and collections; capability-checked (solver-aware) generation | generated suites are collections with provenance (configuration, seed, generator version) |
| M6.3 | QACOBench 1.1.1 suites imported as public collections with provenance (subset in the lab, all in production) | each suite shows instance counts and metric ranges matching the paper's table |
| M6.4 | Reference protocol as a study | a study over the icws suite reproduces its reference verdict counts (INTENT O4) |

## M7 — Engines

| Slice | Deliverable | Acceptance |
|---|---|---|
| M7.1 | Engine health and capability dashboard; conformance reports rendered | health history per engine; failed checks explained |
| M7.2 | Federated-engine onboarding wizard | an engine author registers, verifies and requests publication without reading raw manifests |
| M7.3 | Cancellation in `bim-engine/v1` (CRP: public contract) | a cancelled run stops the remote engine |

## M8 — Collaboration and administration completion

| Slice | Deliverable | Acceptance |
|---|---|---|
| M8.1 | Dashboards on real data (home, organization, project, admin) | no placeholder figures; each figure links to its list |
| M8.2 | Storage and retention administration (INTENT O11, ARCHITECTURE §10) | admin sees usage per class and the next purge |
| M8.3 | Organization plans (decision D3) | proposal with SPACE group contracts, or sponsorship kept |
| M8.4 | Notifications for plan changes, finished studies and publications | preferences respected |

## M9 — Architecture migration (continuous)

| Slice | Deliverable | Acceptance |
|---|---|---|
| M9.1 | `app/`, `shared/`, `modules/` skeleton with import-linter contracts | contracts enforced for new modules |
| M9.2 | Modules moved in the order of ARCHITECTURE §4.3, one per change | `docs/openapi.json` unchanged by each move; ratchets shrink |
| M9.3 | Frontend feature-sliced layout; API types generated from `docs/openapi.json`; `api/client.ts` split | ESLint boundaries enforced |
| M9.4 | Repository layout of ARCHITECTURE §13 | CI, Dockerfiles and links updated in the same change |
| M9.5 | BIM toolchain extracted to `isa-group/bim-toolchain` and consumed as a pinned release (ADR-0004) | consumer contracts green on both sides |

## Releases

| Release | Content | What the owner reviews |
|---|---|---|
| R1 | M0–M2 | release PR with MRP, the develop preview, the QA gallery |
| R2 | M3–M4 | repository and plans scenarios in the preview |
| R3 | M5–M6 | extensions and the QACOBench study in the preview |
| R4 | M7–M8 | engines, dashboards and administration |

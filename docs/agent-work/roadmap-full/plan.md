# Plan: roadmap-full (ROADMAP M0 to M9, releases R1 to R4)

- Owner request: own-e9fffb04c98c44ef911bc48ca955f0cc. Scope: every slice of `ROADMAP.md`, M0 to M9, and nothing
  else. Bug fixes are the only exception. Proposals (`docs/agent-work/prop-*`) and features in no slice wait.
- Base: `develop` at `1c31b9d4` (#73). Updated 2026-10-28. Planning only: no code, no checks registered, none run.
- How this was verified. Repository files were read at the base. Merges are proven by the files they added and by the
  squash subjects on the base: #69 `9e8172dc`, #70 `03c87de1`, #71 `467e59d5`, #72 `ea5db597`, #73 `1c31b9d4`.
  The changelog `frontend/src/content/changelog.generated.json:8-40` lists PRs up to #66. CI was read with
  `ci_status`. `git log` was not available to this task, so ancestry claims are marked as such.

## 1. Summary of verified status

| Milestone | Status at the base | What is left |
|---|---|---|
| M0 | M0.2, M0.3 done. M0.9 built. M0.5 is done in the repository; the factory side is still open. M0.1 and M0.4 are almost done but unverified. M0.6, M0.7 and M0.8 are not started. | M0.1/M0.4 verification; M0.5 factory side and docs; M0.6; M0.7; M0.8; M0.9 follow-ups (CI, owner gates) |
| M1 | done (#25) | — |
| M2 | M2.1 to M2.5 done. M2.6 and M2.7 are in flight under leads, with nothing merged. M2.8 not started. | M2.6, M2.7, M2.8 |
| M3 | not started (no problem metrics: a grep for `workflowDepth`/`bindingSpaceSize` finds nothing) | all |
| M4 | M4.0 done. M4.1 rebuilt for the remote SPACE (#69), but its live run is unverified. M4.6 runbook done (#69). M4.2/M4.3 are specified (`m42`, `m43`) but not built. | M4.1 live run, M4.2, M4.3, M4.4, M4.5, M4.6 production switch |
| M5 | not started (no `extends` in `bim-toolchain/packages`) | all |
| M6 | not started; partial bases exist (generator, publications) | all |
| M7 | not started. Cancellation exists only as an optional extension (`docs/qa/ENGINE_CANCELLATION.md:28-32`). | all |
| M8 | not started; a notification API exists (`docs/openapi.json:16503`) | all |
| M9 | M9.1 skeleton done; M9.6 done | M9.1 blocking CI step, M9.2 to M9.5 |

## 2. Slices: status, evidence, what remains, CRPs, scope, dependencies, risk

Path shorthands: G = `openbinding-gateway/`, GS = `openbinding-gateway/src/openbinding_gateway/`,
F = `frontend/src/`, E = `frontend/e2e/`. "Lead scope" lists the globs the change's lead owns while it runs. Risk
follows `.agentic/project.yaml` (R1 policy/routes, R2 plans, R5 admission, R10 compose/CI/images, R11 owner files).

### M0 — Foundation

| Slice | Verified status | Evidence | What remains | Owner CRP | Lead scope · change | Depends | Risk |
|---|---|---|---|---|---|---|---|
| M0.1 | Almost done, not verified | PR #24 head `3c142aa6` CI success on 2026-10-23 (`ci_status` #24). Develop holds the integration history (changelog `:41-75`). `docs/agent-work/icsoc-ci-round*/` | Prove `3c142aa6` is an ancestor of `develop` and that the 303 commits are kept (`git merge-base --is-ancestor`, `git rev-list --count`). Record it in the ROADMAP status. | — | coordinator · `m0-verify` (no repo file) | — | low |
| M0.2 | done | `docs/agent-work/m02-openspec-strict/summary.md:40-41` (CI job `openspec` on PR 56: 26 passed, 0 failed). The file is on develop, so PR 56 merged. | The CI step is still report-only (`.github/workflows/ci.yml:254-256` `continue-on-error`): make it blocking. Re-check `--all` on the base, because 30+ changes were added since. | CRP-3 (token with Workflows: write) | `m0-infra-close` S3 | — | medium |
| M0.3 | done | #37 (changelog `:31`), archive `openspec/changes/archive/2026-10-26-m03-gate-tooling` | — | — | — | — | — |
| M0.4 | Repository side done. Rebuild-on-merge not verified. | #27 and #29 (public origin, changelog `:38-39`). ADR-0019 decision 1. ARCHITECTURE `:615`. | Coordinator evidence that the develop lab is rebuilt after each merge (the last 3 merge times against the lab rebuild times). The owner confirms it opens from the Mac and the iPhone. | — | coordinator · `m0-verify` | — | low |
| M0.5 | Repository side done except S4 docs. The factory side is not built. | #34, #39, #41 (changelog `:10,30,34`). `lab/previews/previews.py`. `docs/previews/README.md:3-9` says "PLAN … `labctl preview` not built". `openspec/changes/m05-pr-previews/tasks.md` F1, F2, 4.2, 4.3 open. | Factory: F1 (the `lab_compose` validator accepts `DEMO_LAB_PORT`) and F2 (`labctl preview`/`destroy preview`, hourly expiry). Then the live isolation probe (`lab/tests/test_preview_isolation.py`, 0 skipped). Then S4 4.2 docs ("in force", DEMO, TESTING, E2E_PLAN), 4.3 (ARCHITECTURE §10 row) and the archive. | — | factory (F1, F2). Docs: `m0-infra-close` S4 | F2 before S4 | high (R10) |
| M0.6 | not started | No retention job in the repository. ARCHITECTURE §10 is the only design. | Measure lab disk against the quota. Archive stale work trees and task branches through factory maintenance operations. Retention jobs for reports and archives. Disk must be below 70 %. | Retention rules (INTENT §11.5) if a job deletes evidence or reports | coordinator/factory · `m0-verify`; any repo part in `m0-infra-close` S6 (`docs/runbooks/lab-retention.md`) | — | medium |
| M0.7 | not started (factory side) | Develop squash subjects at the base are not Conventional Commits (`1c31b9d4` "retiredScreens test stops pinning …"). Local integration commits are not readable here. | The factory keeps the task's Conventional Commit subject and trailers on local integration commits. Then a sample of 5 integrations is checked. | — | factory · `m0-verify` | — | low |
| M0.8 | not started (planned) | `docs/agent-work/m08-qacobench-baseline/handoff.md`. The living spec still has an OPEN QUESTION (`openspec/specs/job-execution/spec.md:149`). `CHANGED_MANIFESTS` is in `bim-toolchain/tools/baseline_core.py`. | S0 spec deltas. S2 `campaign.py` classifies by code. S3 frozen `golden/bim_baseline_1_1_1/` and no `CHANGED_MANIFESTS`. S1 gateway 422 → `engine_incompatible` plus the OpenAPI/ERRORS declaration. R: the 1.1.2 release (46,350 executions, `reference/1.1.2`, Zenodo). | **CRP-M08-1** (re-coding the engine 422 changes a public error code). **CRP-M08-2** (publish QACOBench 1.1.2; O3 tolerance). Arch Q2 (copy to a new frozen directory, recommended). | `m08-qacobench-baseline`: `openspec/changes/m08-qacobench-baseline/**`, `experimentation/qacobench/**`, `bim-toolchain/{tools/baseline_core.py,golden/bim_baseline_1_1_1/**,packages/bim-core/tests/test_baseline_equivalence.py,docs/DIGESTS.md,openspec/changes/**}`. S1 adds `GS{v1/remote.py,core/public_errors.py,services/execution.py}`, `docs/ERRORS.md`, plus `GS/main.py` and `docs/openapi.json` during a lock turn. | S1 after CRP-M08-1 and an OpenAPI lock turn. R after CRP-M08-2 and a green develop. | high (S1 public contract, S3 goldens) |
| M0.9 | built | `deploy/compose/production/{compose.yaml,images.env,ci.env}`, `docs/runbooks/production.md`, `G/tests/test_no_kubernetes.py`. No `deploy/kubernetes`. | F1: CI `docker compose config` for production and every lab file. Today the CI runs only dev (`ci.yml:424-425`) and two lab files (`lab/tests/test_lab_compose_config.py:15`). F2: the `.agentic/project.yaml:82` `kustomize` gate is still there. F4: the `prod` profile of `docker-compose.yml`. F5: `bim-toolchain/docs/SERVICE.md:742,751-752`. F7: non-root and `cap_drop` for the Java engines, nginx and frontend-assets. F8: OFT paths. F9: the nginx resolver. Archive: `openspec/specs/lab-deployment/spec.md:10-11,111-121,134` still names Kustomize. | **CRP-M09-2** (standalone production file or override, fate of the `prod` profile). **CRP-M09-3** (Workflows token; `.agentic` gates; OFT paths; ADR-0021 evidence line). **CRP-M09-4** (image registry and publish workflow; `images.env` holds `gap.invalid` placeholders). **Q3** (production host facts). | `m0-infra-close` | F1 after CRP-M09-3. F4 after CRP-M09-2. | high (R10) |

`m0-infra-close` slices (one lead, high risk, panel: reviewer, test-reviewer, security-auditor, arch-reviewer):
- S0: specifier, 40 turns. Owns `openspec/changes/m0-infra-close/**`. A delta of `lab-deployment` adding
  `compose-config-in-ci`. Check: `["openspec","validate","m0-infra-close","--strict"]`.
- S1: implementer, 50 turns. Covers F5, F9 and the README pointer. Owns `nginx/**`, `bim-toolchain/docs/SERVICE.md`
  and `README.md`. F9 is tested in the lab by the coordinator.
- S2: implementer, 60 turns, after CRP-M09-2. Covers F4 and F7. Owns `docker-compose.yml`, `deploy/**`,
  `G/tests/{test_compose_production.py,test_container_hardening.py}` and `docs/runbooks/production.md`.
- S3: implementer, 60 turns, after CRP-M09-3. Owns `.github/workflows/**`, `lab/tests/test_ci_*.py` and
  `lab/tests/test_lab_compose_config.py`. It adds:
  - the compose-config job for production and every `compose.lab*.json`;
  - a blocking `openspec validate --strict --all`;
  - blocking `lint-imports --config importlinter-modules.ini` (M9.1).
- S4: doc-steward, 30 turns, after factory F2. M0.5 4.2 and 4.3. Owns `docs/previews/**`, `TESTING.md`,
  `docs/qa/E2E_PLAN.md`, `docs/DEMO.md` (the PR previews section only) and the §10 row of `docs/ARCHITECTURE.md`.
- S5: coordinator archive task, last. Archives `m09-compose-only` and `m05-pr-previews` into
  `openspec/specs/lab-deployment/spec.md`.
- S6 (optional): a doc-steward lab-retention runbook for M0.6.

### M2 — Render, never dump

| Slice | Verified status | Evidence | What remains | Owner CRP | Lead scope · change | Depends | Risk |
|---|---|---|---|---|---|---|---|
| M2.1, M2.2 | done | #38 | — | — | — | — | — |
| M2.3 | done | #70 (`03c87de1`). `F/components/rendering/{BindingTable,QoSAgainstBounds,ObjectiveBreakdown,EvaluationDiff,TradeOffChart,RunResult}.tsx`. Offenders 1-4 are off `F/test/rawRenderingAllowList.ts`. | Archive of the `m23-*` changes | — | archive task | — | — |
| M2.4 | done | Slices 1-5: #51, #53, #55, #65, #66. Route count 69 (`F/routes/routes.test.ts:63-64`). The `Deprecation`/`Sunset` step is superseded by M9.6: the owner skipped the period (`ROADMAP.md:194`, `docs/API_DEPRECATIONS.md`). | Withdraw `openspec/changes/m24-sunset/` (never built). Archive the `m24-*` changes. | — | archive task | — | — |
| M2.5 | done | #71 (`467e59d5`). The allow-list holds only offender 6 (`rawRenderingAllowList.ts:25,30-38`). | Archive `m25-studies-engines` | — | archive task | — | — |
| M2.6 | in flight (lead `m26-navigation`), nothing merged | No `F/routes/areas/`. `routes.test.ts:64` expects 69 screens. Offender 6 is still listed. Plan: `docs/agent-work/m26-navigation/handoff.md`. | Wave 0 (A1-A3), wave 1 (V, S, AC, LH, AR, PT, VP), wave 2 (N, OS, EX, RS, CD, VR), wave 3 (SP, PP, SD), then UP → UR → Z | **D-M26-1 to D-M26-7**: screen counting, problem-page shell, `/status`, Verify for visitors, Problems/Studies menus, URL renames, offender 16. Confirm they are answered. Without D-M26-1 A and D-M26-2 A, 45 screens cannot be reached in M2. | `m26-navigation`: `F/routes/**`, `F/components/{PlatformShell,Navigation,SiteFooter,NotificationDropdown}/**`, `F/components/ui/{ErrorState,SectionNav}*`, `F/pages/{Verify,Resolve,Reports,Account,Organization,Project,Profiles,Schemas,Examples,Public,Status,About,Auth,System,Studies,Cases,Workbench,Jobs,Resources,Platform,AppHome,Home}/**`, `F/pages/Engines/LangExtensions*`, `F/pages/Admin/AdminQueues*`, `F/utils/accessLevel*`, `F/test/{rawRenderingAllowList.ts,rawRenderingHygiene.test.ts,vocabulary*}`, `F/components/rendering/SourceView*` (SD only), `E/**`, `acceptance/ui/navigation/**`, `openspec/changes/m26-*/**` | — | high (routes, permanent links) |
| M2.7 | in flight (lead), nothing merged | No `F/shared/`. No `CitationPanel` or `VerifyResult` under `F/components/rendering/`. | Identity labels in `shared/lib`. Digests, fingerprints and UUIDs off cards, lists, headers and badges. `CitationPanel`, `VerifyResult`. A digest/UUID hygiene test. | none, unless a label needs an API field (then an additive OpenAPI change, CRP §11.1 only if breaking) | `m27-identity-labels`: `F/shared/lib/**` (new), `F/components/rendering/{CitationPanel,VerifyResult,IdentityLabel}*` (new), `F/test/identityHygiene*` (new), `acceptance/ui/identity/**`, `openspec/changes/m27-*/**`. Page files only by hand-over (§3). | Page edits per area after the M2.6 slice holding the area merges. `VerifyResult` on the Verify page after M2.6 V. | medium |
| M2.8 | not started | `E/qa-gallery.spec.ts` exists; there is no refreshed gallery | Refresh desktop and mobile screenshots of every routed screen. ui-qa review. Attach them to the R1 release PR. | — | `m28-qa-gallery`: `E/qa-gallery.spec.ts`, `E/helpers/gallery/**`, `docs/qa/gallery/**` (new) | M2.6 Z and M2.7 merged | medium |

### M3 — Problem repository (one intake per change before its slices; contracts first)

| Slice | Status | What remains | Owner CRP | Lead scope · change | Depends | Risk |
|---|---|---|---|---|---|---|
| M3.1 | not started | Metrics computed at sealing, stored once, exposed in list and detail payloads (additive OpenAPI) | none (additive). Migration under the alembic lock. | `m31-problem-metrics`: `GS/modules/repository/**` (new, metrics domain), `G/alembic/versions/<new>`, `GS/services/snapshots.py`, case read routes, `docs/openapi.json` (lock), `G/tests/test_problem_metrics*.py`, `acceptance/api/test_problem_metrics.py` | M4 gateway B7b merged (`services/snapshots.py`, `routes/organizations.py`). Spec S0 can start in wave B. | high (R1 routes, migration) |
| M3.2 | not started | Problem page header, metrics, version selector. Overview with `WorkflowGraph`, `CandidateMatrix`, `ConstraintList`, `ObjectiveView`. | — | `m3-problem-page`: `F/pages/Problems/**` (named by M2.6 UP), `F/components/rendering/{WorkflowGraph,CandidateMatrix,ConstraintList,ObjectiveView,MetricSmallMultiples}*` (new), `E/s5a-cases.spec.ts` | M2.6 PP and UP, M3.1 | medium |
| M3.3 | not started | Versions tab (compare, metric evolution) and Source tab | — | same change, second slice | M3.2 | medium |
| M3.4 | not started | Runs tab: runs by engine, comparison, trade-offs | — | same change, third slice | M3.2 | medium |
| M3.5 | not started; `/v1/explore/{engines,projects,publications}` exist (`docs/openapi.json:14552-14601`) | Explore with problems, collections and published results. Filters. Permanent links `/p/{id}`, `/c/{id}` that survive a rename or a move. | **CRP-M35** (new public permanent-link format and visibility of public problems, INTENT §11.1/§11.3) | `m35-explore-links`: `GS/access/public_read.py`, `GS/routes/public*`, a new permalink route, `docs/openapi.json` (lock), `F/pages/Public/Explore*`, `F/routes/areas/public.tsx` (after M2.6), `G/alembic/versions/<new>` (lock) | M3.1. M4 gateway done with `access/**`. | high (R1 visibility) |
| M3.6 | not started | Problem editor (workbench and the retired composer's role). Live validation. Compatible engines. "Try it" without an account. | **CRP-M36** (anonymous "Try it": visibility and plan rule, §11.3) | `m36-problem-editor`: `F/pages/Workbench/**`, `F/pages/Problems/editor/**`, anonymous run route if CRP-M36 = yes | M3.2. M4.2 (anonymous runs count against which plan). | high |
| M3.7 | not started | Import and export on problem and collection pages. The project Files and Package pages go. | none (ADR-0020 retirement) | `m37-import-export`: package/collection import-export routes and services, `F/pages/Collections/**`, the remaining Files/Package entries | M3.2, M2.6 PT | high |
| M3.8 | not started | Corpus examples as the public "BIM examples" collection | Publishing corpus examples as public data (§11.6) is covered by INTENT §6 if it says so; otherwise a CRP | `m38-examples-collection`: seed/import tool under `G/tools/`, `examples/**` read-only | M3.5, M3.7 | medium |

### M4 — Plans

| Slice | Verified status | Evidence | What remains | Owner CRP | Lead scope · change | Depends | Risk |
|---|---|---|---|---|---|---|---|
| M4.0 | done | `ROADMAP.md:132-136` | — | — | — | — | — |
| M4.1 | Built for the remote SPACE. The live run is unverified. | #69. `compose.lab-pricing.json` (one `pricing-bootstrap`, 96 MiB, `https://space.score.us.es`). `lab/space/` is removed. `docs/qa/PRICING_PROFILE.md:15,51,58-61` (UNVERIFIED). | Live run: the service is `ready` and the six contracts exist; a second run creates nothing. Archive `m4-remote-space`. Withdraw the superseded `m41-*` and `m45-lab-pricing-wiring` changes. | Owner applies the ROADMAP/ADR-0015/ADR-0022/INTENT D5 wording (`docs/agent-work/m4-remote-space/roadmap-m4.md`) | coordinator lab task (supervisor injects `DEMO_SPACE_MANAGEMENT_KEY`); evidence in `docs/qa/PRICING_PROFILE.md` | — | high |
| M4.2 | Specified, not built | `openspec/changes/m42-plans-module/tasks.md` S0 [x], S1-S8 [ ]. No `GS/modules/plans/`. `GS/space_client/` is still there. CRPs accepted (`m42 design.md:7-8,292-295`, own-7153cec8…). | S1 move → S2 map → S3 admission → S4 own counts (split by area) → S5 events → S6 revert → S7 fail closed → S8 contract suite against the remote SPACE (lab key) | Confirm that the accept-all covers `GET /v1/plans/events` and its `account:read` scope (`m42 design.md:346,366`) | `m4-plans-gateway` (below) | — | high (R2, R5) |
| M4.3 | Specified, not built | `openspec/changes/m43-plans-pricing-route/`. `GS/{sphere_client.py,pricing_catalog.py,routes/pricing.py,domain/usage_counters.py}` are still present. `/v1/pricing*` is in `docs/openapi.json:22704-22756`. | C1 `GET /v1/plans/pricing` (additive). C2 deprecate the old routes and remove the SPHERE key. C3 remove local metering. C4 delete `/v1/pricing*` after M4.4. | **CRP-M43-C4**: removal date of `/v1/pricing*` (breaking, §11.1) | `m4-plans-gateway` | C1 after m42 S1 and S4-settings. C4 after M4.4. | high |
| M4.4 | Partly present from the integration | `frontend/package.json:29,35` (`pricing-renderer` 0.1.0, `space-react-client` ^0.3.3). `F/pages/Pricing/Pricing.tsx:4`. `F/contexts/SpaceProviderWrapper.tsx`. The custom table still reads `/v1/pricing/catalog` (`F/api/client.ts:1177-1182`). | React 19 spike. Token-only mode. `FeatureGate`. Pricing and Plan pages on `/v1/plans/pricing`. Remove the custom table. | Any `space-react-client` or `pricing-renderer` version change (§11.4) | `m44-plans-browser`: `F/pages/{Pricing,Plan}/**`, `F/contexts/SpaceProviderWrapper*`, `F/utils/pricingToken*`, `F/components/FeatureGate/**` (new), `F/pages/EngineDetail/EngineDetail.tsx`, `F/pages/Account/AccountUsage*` (after M2.6 AC), the pricing methods of `F/api/{client.ts,auth.ts}` (lock), `frontend/{package.json,pnpm-lock.yaml}`, `acceptance/ui/plans/**` | M4.3 C1. M2.6 AC and RS merged. | medium (high if the client version changes) |
| M4.5 | not started | `compose.lab.json:193,265,381` pass `DEMO_SPACE_ENABLED` | Lab and previews with plans on by default. Seed users have contracts. Previews show real plans. | none beyond the accepted CRP-M4-4/5 | `m45-plans-lab`: `compose.lab.json`, `compose.lab-pricing.json`, `lab/previews/previews.py`, `lab/tests/{test_lab_compose.py,test_previews.py,test_lab_pricing_profile.py}`, `G/tools/seed_lab.py`, `docs/DEMO.md`, `docs/qa/PRICING_PROFILE.md` | M4.2 S7, M4.3 C1, M4.1 live run, `m0-infra-close` S4 | high (R10) |
| M4.6 | Runbook done; production not deployed | `docs/runbooks/production.md:733` "Remote SPACE" | `SPACE_URL` and the `space_api_key` secret in the production deployment at R2 | Production deployment (§11.11) | release task at R2 | M0.9 CRP-M09-4, Q3 | high |

`m4-plans-gateway` lead scope (one gateway lead, slices serial where files are shared, as in
`docs/agent-work/m4-plans-slices/handoff.md:37-62`):
- Gateway sources:
  - `GS/modules/plans/**` and `GS/space_client/**`
  - `GS/services/{entitlements.py,job_submission.py,snapshots.py}`
  - `GS/access/**`
  - `GS/domain/{entitlements.py,usage_counters.py,binding_space.py}`
  - `GS/{study_jobs.py,job_dispatch.py,collaboration.py,sphere_client.py,pricing_catalog.py}`
  - `GS/generator/**`
  - `GS/routes/{jobs,studies,organizations,users,v1,pricing,artifacts}.py` and `GS/models/pricing.py`
  - `GS/security/apikeys.py`, `GS/core/settings.py`, `GS/main.py`
- Configuration: `G/.importlinter`, `G/.env.example` and `.env.example`.
- Locked documents: `docs/openapi.json` and `docs/ERRORS.md` (lock holder).
- Tests and fixtures:
  - `G/tests/{test_plans_*,test_space_client*,_fake_space.py,test_published_pricing.py,test_pricing_public_errors.py,test_usage_counters.py,test_architecture_layers.py}`
  - `G/tests/{contract,fixtures/pricing,fixtures/sphere}/**`
  - `lab/tests/test_no_direct_space_http.py` and `acceptance/api/test_plans_*.py` (test-designer)
- Specs and docs: `openspec/changes/{m42-plans-module,m43-plans-pricing-route}/**` and `docs/ACCOUNTS_AND_PLANS.md`.

### M5 — Language extensibility (R3; one intake per change)

| Slice | Status | What remains | Owner CRP | Change · main scope | Depends | Risk |
|---|---|---|---|---|---|---|
| M5.1 | not started | `extends` in Profile manifests, chain in the IR, goldens and corpus digests unchanged | **CRP-M51 BIM MINOR release** (§11.2) | `m51-profile-extends`: `bim-toolchain/packages/bim-core/**`, `schemas/bim/v1/**` (public, additive), `GS/modules/language/**` | M9.5 or a bim-toolchain release (ROADMAP M5 "depends on bim-toolchain release"), M9.2 language move | high |
| M5.2 | not started; placement exists as a schema (`schemas/bim/v1/placement.schema.json`) | `qos-binding-placement/v1` extends `qos-binding/v1`. Engines declare profiles. `INCOMPATIBLE` names the profile. | Manifest change (§11.1 language manifests) | `m52-placement-extension`: `schemas/bim/v1/{placement.schema.json,manifests/**}`, engine manifests, docs | M5.1 | high |
| M5.3 | not started | `/v1/language/*` with aliases and deprecation headers on the old routes | **CRP-M53** (language API, §11.1) | `m53-language-api`: `GS/modules/language/adapters/http/**`, `docs/openapi.json` (lock) | M9.2 language move | high |
| M5.4 | not started | Extension lifecycle, BPMN packaged through it, Language hub states | Installing or retiring extensions in production (§11.9) | `m54-extension-lifecycle`: `GS/modules/language/**`, `F/pages/Language/**` (M2.6 LH) | M5.3 | high |
| M5.5 | not started | Tier-1 declarative adapters, QWS CSV dialect | none (behind M5.4 install) | `m55-tier1-adapters`: `bim-toolchain/packages/bim-core/src/bim_core/adapters/**` | M5.1 merged (shared bim-core) | medium |
| M5.6 | not started | `bim-ext` developer kit and how-to | Publishing a package (PyPI, §11.6) if it is published | `m56-bim-ext`: `bim-toolchain/packages/bim-ext/**` (new), `docs/howto/extensions.md` | M5.4 | medium |
| M5.7 | not started | Tier-2 adapter services `bim-adapter/v1` | **CRP-M57** (new protocol and external integration, §11.1/§11.4/§11.8) | `m57-adapter-services`: `GS/modules/language/adapters/remote/**`, `schemas/bim-adapter/**` | M5.4, M7 registry patterns | high |

### M6 — Laboratory and QACOBench (R3)

| Slice | Status | What remains | Owner CRP | Change · main scope | Depends | Risk |
|---|---|---|---|---|---|---|
| M6.1 | not started | One study-results view with protocol metrics equal to `evaluate_results.py`; CSV/JSON export | — | `m61-study-results`: `F/pages/Studies/**` (after M2.6 SP), laboratory metrics in `GS/modules/laboratory/**` | M9.2 laboratory move or new code in the module | medium |
| M6.2 | not started; the generator exists (`GS/generator/**`) | Generations write collections with provenance. Instances and solver hours are counted. | covered by the accepted CRP-M4-2 map | `m62-generator-collections`: `GS/generator/**`, `F/pages/Generator/**` | M4.2 S3/S4 (generator admission), M3.7 collections | high (R5) |
| M6.3 | not started | QACOBench 1.1.1 suites as public collections (a subset in the lab, all in production) | **CRP-M63** (publishing datasets in production, §11.6; ADR-0008 datasets outside git) | `m63-qacobench-suites`: `experimentation/qacobench/import/**` (new), import tool | M3.7, M0.8 | medium |
| M6.4 | not started | The reference protocol as a study reproduces the icws verdict counts | none (unless results differ: §11.7) | `m64-reference-study`: study definition fixtures, acceptance test | M6.1, M6.3 | medium |
| M6.5 | not started; publications exist (`F/pages/Reports/ProjPublications*`) | "Publish" freezes a study run or collection version with a permanent link, citation and Zenodo-ready export. Existing publications become read-only. | **CRP-M65** (rewriting stored publications as read-only results, Zenodo, §11.5/§11.6) | `m65-published-results`: `GS/modules/publishing/**`, `GS/routes/{resolve,verifier}.py`, publication parts of reports, `F/pages/Published/**` | M3.5 links, M6.1, M2.7 `CitationPanel` | high |

### M7 — Engines (R4)

| Slice | Status | What remains | Owner CRP | Change · main scope | Depends | Risk |
|---|---|---|---|---|---|---|
| M7.1 | not started | Engine health history, conformance reports rendered | — | `m71-engine-health`: `GS/modules/engines/**` health, `F/pages/Engines/**`, `F/pages/Admin/AdminEngine*` | M9.2 engines move | medium |
| M7.2 | not started | Federated-engine onboarding wizard | — | `m72-engine-onboarding`: `F/pages/RegisterEngine/**` | M7.1 | medium |
| M7.3 | Partly present as an optional extension | `docs/qa/ENGINE_CANCELLATION.md:28-32`. Remaining: make cancellation part of `bim-engine/v1`. | **CRP-M73** (public engine protocol, §11.1) | `m73-engine-cancellation`: `schemas/engine-contract.openapi.yaml`, `engines/*/` adapters, `GS/jobs/remote_attempts.py` | M5 profile support (ROADMAP M7 dependency) | high |

### M8 — Collaboration and administration (R4)

| Slice | Status | What remains | Owner CRP | Change · main scope | Depends | Risk |
|---|---|---|---|---|---|---|
| M8.1 | not started | Home, organization, project and admin overviews on real data | — | `m81-overviews`: `F/pages/{AppHome,Organization,Project,Admin}/*Overview*`, read endpoints | M2, M4 | medium |
| M8.2 | not started | Storage and retention administration | Retention changes (§11.5) | `m82-storage-admin`: `GS/modules/administration/**`, `F/pages/Admin/Storage*` | M0.6, M8.1 | high |
| M8.3 | not started; `/v1/notifications*` exist (`docs/openapi.json:16503-16799`) | Notifications for plan changes, finished studies and published results; preferences respected | — | `m83-notifications`: `GS/collaboration` notification producers, `F/pages/Account/notifications*` | M4.2 S5 events, M6.5 | medium |

### M9 — Architecture migration

| Slice | Verified status | Evidence | What remains | Owner CRP | Change | Depends | Risk |
|---|---|---|---|---|---|---|---|
| M9.1 | done (skeleton). The CI step is pending. | `GS/{app,modules,shared}/__init__.py`, `G/importlinter-modules.ini`, ARCHITECTURE `:159-173` | Blocking CI step and G9 entry | CRP-M09-3 (Workflows token; `.agentic` G9 entry) | `m0-infra-close` S3 | — | medium |
| M9.2 | not started (plans move inside M4.2 S1) | ARCHITECTURE §4.3 order: plans → language → engines → execution → laboratory → publishing → repository → collaboration → identity → administration | One `refactor/<id>` change per module, `docs/openapi.json` byte-identical | — | `m92-move-<module>` | Each move starts after the previous one and while no other change holds that module's files | high (R1/R2 files), behaviour-preserving |
| M9.3 | not started; ESLint boundaries exist for pages only (`frontend/eslint.config.js:29-33`) | — | Generated API types from `docs/openapi.json`; `api/client.ts` split into `entities/*/api.ts`; feature-sliced layout; boundaries enforced | New dev tool (openapi-typescript): not a runtime dependency, so no CRP | `m93-api-types` (first), then splits done inside the M3/M6 slices that touch each entity | After M2 (R1), before the M3 frontend | medium |
| M9.4 | not started | — | Repository layout of ARCHITECTURE §13 (lab files to `deploy/compose/`, `nginx/` and `up.sh` to `deploy/`) | `CODEOWNERS` and `.agentic` paths (§11.10) | `m94-repo-layout`, alone | A quiet window after R3, with no change running | high (R10) |
| M9.5 | not started | `bim-toolchain/docs/EXTRACTION_LOG.md:3-5` ("repository not created yet") | Extract to `isa-group/bim-toolchain`, consume a pinned release | **CRP-M95** (create and publish the repository and its release, §11.6; pinned BIM release, §11.2) | `m95-bim-extraction`: `bim-toolchain/**`, the gateway dependency pin | Before M5.1 | high |
| M9.6 | done | No `GS/routes/analysis.py`, `sponsor_proposals.py` or `core/deprecation.py`. `G/alembic/versions/e7f8a9b0c1d2_drop_retired_data.py`, `docs/runbooks/retired-data-export.md`, ARCHITECTURE `:177-186`. | Archive `m96-remove-retired` | — | archive task | — | — |

## 3. Shared files, locks and hand-overs

The coordinator holds these locks. One writer at a time.

- `docs/openapi.json` and `GS/main.py`:
  - `m4-plans-gateway` holds them first;
  - `m08` S1 gets a turn between m42 S4 and m43 C1;
  - after that, M3.1 and M3.5.
  - `docs/openapi.json` is regenerated by `tools/dump_openapi.py`, never edited by hand.
- `docs/ERRORS.md`: the same holder as `docs/openapi.json`.
- `G/alembic/versions/`: one new migration in flight at a time, so the head stays single.
- `GS/core/settings.py`: `m4-plans-gateway` (B4 adds every M4 setting once). Others wait.
- `F/test/rawRenderingAllowList.ts` and `F/components/rendering/SourceView*`: `m26` (V, SD, Z).
- `F/api/client.ts`: the slice that edits it holds it (`m44`, then `m93-api-types`). After `m93-api-types`, new
  calls go to `entities/*/api.ts`.
- Hand-over of page files to `m27-identity-labels`: per area, after the `m26` slice that owns the area merges.
  - Order: verify → account → language → project → problems → organizations → runs → studies.
  - Each hand-over is a coordinator note naming the files.
- `frontend/src/content/changelog.generated.json`: regenerated by the coordinator only, last in each PR.
- `ROADMAP.md` Status column: coordinator only. Milestone text belongs to the owner.
- `openspec/specs/**`: explicit archive tasks only, one at a time, at the end of each wave.
- `docs/DEMO.md`: `m0-infra-close` S4 first, then `m45-plans-lab`.
- `bim-toolchain/**`:
  - `m08` S3 in waves A-B;
  - `m95` in wave D;
  - then M5.1 → M5.5 in order;
  - `m56` owns only its new package.

## 4. Wave order (3 to 6 changes in parallel, disjoint scopes)

Waves are gates on dependencies, not dates. Inside a lead, slices follow the lead's own plan. At most two checks
run at once in the lab, so heavy suites queue.

| Wave | Parallel changes (lead or role) | Starts when | Ends with |
|---|---|---|---|
| A (now) | 1. `m26-navigation` waves 0-1 (in flight). 2. `m27-identity-labels` S0 spec, `shared/lib` and components (in flight). 3. `m4-plans-gateway` m42 S1 → S2, and test-designers T1/T5. 4. `m08-qacobench-baseline` S0, then S2 and S3 in parallel. 5. `m0-infra-close` S0, S1, and S2 if CRP-M09-2 is answered. 6. Coordinator `m0-verify`: M0.1 ancestry, M0.4 rebuild evidence, M0.6 disk measure, M0.7 sample, M4.1 live bootstrap run. | now | m42 S2 merged; M2.6 wave 1 merged; archive task 1 (`m21`, `m23-*`, `m24-*` with `m24-sunset` withdrawn, `m25`, `m96`, `m4-remote-space`; superseded `m41-*`, `m45-lab-pricing-wiring` withdrawn) |
| B | 1. `m26` waves 2-3. 2. `m27` page sweep by hand-over. 3. `m4-plans-gateway` m42 S3, S4 (by area), S5, S6, then m43 C1, C2. 4. `m08` S1 (lock turn; CRP-M08-1). 5. `m0-infra-close` S3 (CRP-M09-3) and S4 (after factory F2). 6. Specs only: `m31-problem-metrics` S0, `m93-api-types` S0. | wave A ends | M2.6 UP → UR → Z serial; m43 C1 merged |
| C (R1 close) | 1. `m28-qa-gallery`. 2. `m44-plans-browser` (after m43 C1, M2.6 AC/RS). 3. `m4-plans-gateway` m42 S7, S8 and m43 C3. 4. `m93-api-types`. 5. `m92-move-language` (gateway files outside M4's scope). 6. Release R1 (release role). | M2.6 Z and M2.7 merged | R1 release PR, lab preprod deployment, R1 report; archive task 2 (m26, m27, m0-infra-close, m05, m09) |
| D (R2 build) | 1. `m45-plans-lab`. 2. `m31-problem-metrics`. 3. `m3-problem-page` (M3.2 → M3.3 → M3.4). 4. `m35-explore-links` (CRP-M35). 5. `m95-bim-extraction` (CRP-M95). 6. `m08` R: 1.1.2 release (CRP-M08-2; lab heavy run, scheduled alone in the lab). | R1 merged into `main` by the owner | M3.2 merged |
| D2 | 1. `m36-problem-editor` (CRP-M36). 2. `m37-import-export`. 3. `m38-examples-collection`. 4. m43 C4 (CRP-M43-C4). 5. `m92-move-engines`. 6. Release R2 with the M4.6 production switch. | M3.2 and M4.4 merged | R2 release PR, deployment, R2 report |
| E1 (R3) | 1. `m51-profile-extends` (CRP-M51). 2. `m53-language-api` (CRP-M53). 3. `m61-study-results`. 4. `m62-generator-collections`. 5. `m63-qacobench-suites` (CRP-M63). 6. `m92-move-execution`. | R2 merged, M9.5 done | M5.1 and M6.1 merged |
| E2 (R3) | 1. `m52-placement-extension`. 2. `m54-extension-lifecycle`. 3. `m55-tier1-adapters`. 4. `m65-published-results` (CRP-M65). 5. `m64-reference-study`. 6. `m56-bim-ext`, then `m57-adapter-services` (CRP-M57). | E1 ends | R3 release PR, deployment, R3 report |
| F (R4) | 1. `m71-engine-health`. 2. `m72-engine-onboarding`. 3. `m73-engine-cancellation` (CRP-M73). 4. `m81-overviews`. 5. `m83-notifications`. 6. `m82-storage-admin`. The remaining M9.2 moves go one at a time in free gateway lanes. | R3 merged | R4 release PR, deployment, R4 report. Then `m94-repo-layout` alone. |

Notes on the order:
- **M9.5 before M5.** ROADMAP M5 depends on a bim-toolchain release, so M9.5 (or at least a tagged bim-toolchain
  release) moves ahead of the owner's "M5 … then M9" order. The same holds for the language and engines moves of
  M9.2, which land before M5 and M7.
- **M8 earlier.** M8 depends only on M2 and M4. It can start in wave D2 if a lane is free; that needs the owner's
  agreement to change the order.
- **R1 is cut only after M0 is closed or explicitly waived by the owner.** M0.6, M0.7 and the factory parts of M0.5
  are factory work, and M0.8 R depends on CRP-M08-2. Recommended: R1 carries M0 without the 1.1.2 release, which
  becomes its own release step in wave D.

## 5. Checks (argument arrays for the waves A-C task contracts)

Aliases:
- GS: `["uv","sync","--directory","openbinding-gateway","--locked","--extra","test"]`. Runs first in every gateway
  slice.
- GP(x…): `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","pytest","-q","-p","no:cacheprovider",x…]`.
- GALL: GP() with no paths, timeout 1800.
- GRUFF: `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","ruff","check","src","tests"]`.
- GIMP: `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","--group","lint","lint-imports","--config",".importlinter"]`.
- GMOD: `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","--group","lint","lint-imports","--no-cache","--config","importlinter-modules.ini"]`.
- OAPI: `["uv","run","--directory","openbinding-gateway","--locked","python","tools/dump_openapi.py","--check"]`.
  OAPI-W, the same without `--check`, is a separate check of the lock holder only.
- G1(c): `["openspec","validate","<c>","--strict"]`. G1ALL: `["openspec","validate","--all","--strict"]`.
- FI: `["pnpm","--dir","frontend","install","--frozen-lockfile"]`.
- FU: `["pnpm","--dir","frontend","test"]`, timeout 1200.
- FL: `["pnpm","--dir","frontend","lint"]`.
- FB: `["pnpm","--dir","frontend","build"]`, timeout 900.
- E2E(x…): `["pnpm","--dir","frontend","exec","playwright","test","--project=mocked",x…]`, timeout 1800.
- ACCAPI(f): `["openbinding-gateway/.venv/bin/python","-m","pytest","-c","acceptance/api/pytest.ini","<f>"]`, gate G4.
- RED(f): `{"argv": ACCAPI(f), "type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError","overlay":["<f>"],"gate":"G3"}`.
- LAB: GP(`../lab/tests`).
- BIMT: `["uv","run","--directory","bim-toolchain","--locked","--all-extras","pytest","-q","packages/bim-core/tests/test_baseline_equivalence.py"]`.
  The lead checks this against the bim-toolchain CI job before registering it.

Per change:
- `m4-plans-gateway`: the per-slice sets of `docs/agent-work/m4-plans-slices/handoff.md:97-129`, with ALL = GALL.
  m42 S1 also needs GMOD and GP(`../lab/tests/test_no_direct_space_http.py`).
- `m08`:
  - S0: G1(`m08-qacobench-baseline`).
  - S2: GS, GP(`../experimentation/qacobench/tests`). The lead confirms the path in the intake.
  - S3: BIMT.
  - S1: GS, GALL, OAPI-W then OAPI, GRUFF.
- `m0-infra-close`:
  - S1: GS, GP(`tests/test_compose_production.py`), LAB.
  - S2: GS, GP(`tests/test_compose_production.py`,`tests/test_container_hardening.py`,`tests/test_no_kubernetes.py`,`tests/test_no_local_space.py`),
    then `["docker","compose","-f","deploy/compose/production/compose.yaml","--env-file","deploy/compose/production/images.env","--env-file","deploy/compose/production/ci.env","config","--quiet"]`.
    The compose command is a coordinator lab check, because workers have no Docker.
  - S3: GS, LAB, G1ALL.
  - S4: LAB, `["git","diff","--check"]`.
- `m26`, `m27`, `m28`, `m44`: FI, FU, FL, FB, E2E(owned specs, `routes-smoke.spec.ts`), plus the acceptance and red
  checks of `docs/agent-work/m26-navigation/handoff.md:103-121`. `m28` runs E2E(`qa-gallery.spec.ts`), plus a ui-qa
  review.
- Every change: G1 of its change before any code, gate G2 after G1, and the preview in the lab before merge for UI
  slices.

## 6. Releases: what closes each one

At each release close the owner gets a deployment to test and an exact report. Steps for the release role:
1. Open a `release/vX.Y.Z` branch from a green develop. Keep a Changelog entry. Write the MRP.
2. Deploy preprod in the lab from that head. Run the smoke tests. Rehearse the rollback.
3. Open the release PR to `main`. Only the owner merges it.
4. Write the report in `docs/agent-work/release-rN/report.md`. It must give:
   - every slice with its PR and merge commit;
   - CI runs;
   - the preview URL;
   - what was not done, and why;
   - open CRPs.
5. Production deployment follows the runbook, when the owner orders it.
   - R1 and R2 need CRP-M09-4 (images) and Q3 (host) for production.
   - Without them, the owner tests the lab preprod only.

| Release | Content | Needs before cut |
|---|---|---|
| R1 | M0, M1, M2 | M2.6 Z, M2.7, M2.8. M0 closed or waived. CRP-REL-1 (version number and whether production is deployed). |
| R2 | M3, M4 | M4.6 switch. CRP-M43-C4 if the removal ships. CRP-M35, CRP-M36. |
| R3 | M5, M6 | CRP-M51, M53, M57, M63, M65. BIM MINOR published. |
| R4 | M7, M8 | CRP-M73. Retention rules for M8.2. |

## 7. Owner CRPs

Needed now, because they block waves A-C:
1. **CRP-M09-2**: standalone production file or override; the fate of the `prod` profile of `docker-compose.yml`.
   It blocks `m0-infra-close` S2.
2. **CRP-M09-3**: a token with Workflows: write for `.github/workflows/**`. In `.agentic/project.yaml`:
   - remove the `kustomize` gate (`:82`);
   - add the lab and production compose-config checks;
   - add the G9 entry for `importlinter-modules.ini`;
   - add `lab/` and `deploy/` to the OFT trace paths.

   Also the ADR-0021 evidence line. It blocks `m0-infra-close` S3, the M0.2 blocking step and the M9.1 CI step.
3. **CRP-M09-4** and **Q3**: image registry and publish workflow; production host facts. These block any production
   deployment at R1 and R2, and M4.6.
4. **CRP-M08-1**: engine 422 re-coded to `engine_incompatible`. Options are (a) switch, (b) expand/contract with
   `reason`, (c) switch with a note; (a) is recommended. It blocks M0.8 S1.
5. **CRP-M08-2**: release QACOBench 1.1.2 (lab re-run, `reference/1.1.2`, Zenodo upload by the owner, O3 tolerance).
   It blocks M0.8 R. The recommendation is to move it out of the R1 gate.
6. **D-M26-1 to D-M26-7** (M2.6). The `m26-navigation` lead asked for them; confirm they are answered. D-M26-1 A and
   D-M26-2 A are needed for "≤ 45 routed screens".
7. **CRP-REL-1** (release publication): the R1 version number; whether R1 is deployed to production or only to lab
   preprod; who uploads what (Zenodo, images).
8. **Owner document edits**: apply the M4 wording of `docs/agent-work/m4-remote-space/roadmap-m4.md` to `ROADMAP.md`,
   ADR-0015, ADR-0022, INTENT §8/§12 D5 and constitution 16.4/16.6, which still say "local SPACE". Also approve the
   wave order of §4, including M9.5 before M5.
9. **Confirm** that the M4 accept-all (own-7153cec8…) covers `GET /v1/plans/events` with `account:read` (m42 S5).

Needed later (raise when the wave before ends):
- CRP-M43-C4: removal date for `/v1/pricing*` (wave D2).
- CRP-M35: permanent links and public visibility (wave D).
- CRP-M36: anonymous "Try it" (wave D2).
- CRP-M95: publish `isa-group/bim-toolchain` and pin its release (wave D).
- CRP-M51: BIM MINOR release (wave E1).
- CRP-M53: language API (wave E1).
- CRP-M57: adapter protocol (wave E2).
- CRP-M63: datasets in production (wave E1).
- CRP-M65: publications become read-only results; Zenodo (wave E2).
- CRP-M73: cancellation in `bim-engine/v1` (wave F).
- Retention rules for M0.6 jobs and M8.2 (§11.5): before any job deletes reports, archives or evidence.

## 8. Corrections for the ROADMAP Status column (coordinator)

- M0: M0.2 done (PR 56). M0.5:
  - S1a and S2 merged (#41); S1b and S3 merged (#34); S4 4.1 merged (#39);
  - the factory F1/F2 and the S4 docs are open.

  M0.9 built (production compose, runbook, guard test); its CI job and owner gates are open. The "16 specs fail" text
  is stale.
- M2: M2.3 done (#70), M2.4 done (#66; the endpoint step superseded by M9.6), M2.5 done (#71). M2.6 and M2.7 are in
  progress.
- M4: M4.1 is redone for the remote SPACE (#69); its live run is pending. M4.6 runbook done (#69).
- M9: M9.1 skeleton done; its CI step is pending.

## 9. Risks

- Too many gateway changes would touch `main.py`, `core/settings.py` and `docs/openapi.json` at once. Mitigation:
  the locks of §3, with M4 as the first holder.
- The 45-screen target has no slack (m26 intake §2). Mitigation: the reserve rows and D-M26-1/2/3.
- The M2.7 page sweep could collide with M2.6 areas. Mitigation: the per-area hand-over of §3.
- R1 waits on factory-side work (M0.5 F1/F2, M0.6, M0.7) that no repository lead can do. Mitigation: owner waiver
  option in §4.
- The lab memory cap (9216 MiB) and the 1.1.2 re-run (46,350 executions). Mitigation: schedule the re-run alone in
  the lab (wave D).
- The ancestry facts (M0.1) and the PR numbers of M9.1/M9.6 were not read from git by this task. The coordinator
  confirms them with `git log` before updating the ROADMAP.

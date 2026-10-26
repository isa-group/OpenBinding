# Handoff: m4-plans-slices
- Status: waiting-review (plan for the coordinator, CRPs for the owner) · Updated: 2026-10-26T12:00:00Z
- Branch / head: task branch on 99697d7e · PR: none (planning only)

## Goal
Slice ROADMAP M4.1 (remainder), M4.2, M4.3 and M4.5 (owner request own-033e9b12c03448b28e474e292072c32c) into
mergeable changes. Each slice has disjoint owned files, a stated order and checks, and raises the CRPs that INTENT §11
requires. The facts, with file:line references, are in [intake.md](intake.md) (F1-F25, X1-X3).

## State (with evidence)
- M4.0 is done (`ROADMAP.md:129-134`).
- M4.1: the profile, bootstrap tool, Dockerfiles and ADR-0022 are merged (F8). Still open: the compose wiring
  (`compose.lab-pricing.json:40` is still the marker), the key placement (F10) and the live run S5 (F9).
- M4.2, M4.3 and M4.5: nothing is built. The gateway still reads pricing 0.1.5 names (F17), and the frontend still
  calls `/v1/pricing*` (F21).
- No check was run: this task has no registered check, and its output is two documents.

## Decisions (planner; the coordinator may override)
- The plans module goes in `openbinding_gateway/modules/plans/{domain,application,adapters}` (ARCHITECTURE §4.2). B2
  edits the allow-list at `lab/tests/test_no_direct_space_http.py:34`. Reason: one move instead of two (intake §2.2).
- B2 keeps `space_client/__init__.py` as a re-export shim, so the move edits no caller and the slice stays under
  ~300 lines.
- Flag: the new setting `plans_space_usage` (default false) guards sending consumption to SPACE. `OpenGate` grants the
  0.1.5 and 0.2.0 names together until C3. Reason: the readers switch over several slices (intake §2.1).
- Every new M4.2/M4.3 setting is added once, in B4. Reason: `core/settings.py` is shared.
- M4.3 is split into C1 (additive route), C2 (deprecate and remove the key), C3 (metering and sponsorship checks) and
  C4 (delete the routes after M4.4). Reason: F21.
- The `maxCollections` check goes in B6, because `createCollection` is in `routes/studies.py:214`. The
  `maxProblems` check goes in B7b, because `createBindingCase` is in `routes/organizations.py:887`.
- There is nothing to remove for "release sweeps", `space_client/deployments.py` or "admin pricing validation"
  (F22).

## Slices
The size limit is ≤300 non-test diff lines; renames count only their changed lines. Default models and efforts apply
unless a slice says otherwise. **Wave 0 can start now**; the other waves start when their dependencies merge.

| Id | Change · role · turns | Risk (why) | Owns (exclusive while running) | Starts after |
|---|---|---|---|---|
| A2 | m41-space-lab-profile · implementer · 60 | high (R10 compose, images, secrets) | `compose.lab-pricing.json`, `lab/tests/test_lab_pricing_profile.py`, `openbinding-gateway/tests/test_no_local_space.py`, `docs/qa/PRICING_PROFILE.md`, `docs/DEMO.md`, `openspec/changes/m41-space-lab-profile/**` | **now** |
| B0 | m42-plans-module · specifier · 40 | medium (spec only; owner content via CRP-2) | `openspec/changes/m42-plans-module/**` | **now** |
| B1 | m42-plans-module · implementer · 30 | low (tests and fixtures only) | `openbinding-gateway/tests/test_space_client_surface.py`, `openbinding-gateway/tests/fixtures/pricing/**` | **now** |
| B2 | m42-plans-module · refactorer · 80 | high (R2; behaviour-preserving move) | `openbinding-gateway/src/openbinding_gateway/modules/**` (only `__init__.py`, `plans/__init__.py`, `plans/application/ports.py`, `plans/adapters/{space,open}/**`), `…/space_client/**`, `openbinding-gateway/.importlinter`, `lab/tests/test_no_direct_space_http.py`, `openbinding-gateway/tests/test_architecture_layers.py`, `openbinding-gateway/tests/test_plans_layout.py` | **now** |
| C0 | m43-plans-pricing · specifier · 40 | medium (OpenAPI delta first, additive) | `openspec/changes/m43-plans-pricing/**` | **now** |
| D0 | m45-local-space-default · specifier · 30 | medium (design only; CRP-4/5 options) | `openspec/changes/m45-local-space-default/**` | **now** |
| A3 | m41-space-bootstrap · implementer · 50 | high (secret handling) | `lab/tools/space_lab_bootstrap.py`, `lab/tests/test_space_lab_bootstrap.py`, `compose.lab-pricing.json`, `lab/tests/test_lab_pricing_profile.py`, `docs/qa/PRICING_PROFILE.md`, `openspec/changes/m41-space-bootstrap/**` | A2, CRP-4 |
| A4 | m41 S5 · coordinator (lab) · 40 | high (live SPACE, outbound HTTPS) | `docs/qa/PRICING_PROFILE.md` (Evidence section), GAP lines in both m41 deltas | A2 (A3 if CRP-4=A), factory F1 |
| B3 | m42 · implementer · 60 | high (R2, CRP-2 content) | `…/modules/plans/domain/**`, `…/modules/plans/adapters/open/**`, `openbinding-gateway/tests/test_plans_entitlement_map.py` | B1, B2, CRP-2 |
| B4 | m42 · implementer · 60 | high (R2, new network use) | `…/modules/plans/application/**`, `…/modules/plans/adapters/space/**`, `…/core/settings.py`, `openbinding-gateway/tests/test_space_client.py`, `openbinding-gateway/tests/_fake_space.py`, `openbinding-gateway/tests/test_plans_port.py` | B1, B2, CRP-1 |
| T5 | m42 · test-designer · 40 | medium | `acceptance/api/test_plans_admission.py` | B0 (G1 green) |
| B5 | m42 · implementer · 60 | high (R5 job admission) | `…/services/job_submission.py`, `…/routes/jobs.py`, `…/job_dispatch.py`, `openbinding-gateway/tests/test_plans_run_admission.py` | B3, B4, T5 frozen |
| B6 | m42 · implementer · 60 | high (R5, R8 generator) | `…/study_jobs.py`, `…/routes/studies.py`, `…/generator/**`, `openbinding-gateway/tests/test_plans_study_generator.py` | B3, B4 |
| B7a | m42 · implementer · 60 | high (R1/R2 policy) | `…/access/policy.py`, `…/domain/entitlements.py`, `…/domain/binding_space.py`, `…/services/entitlements.py`, `openbinding-gateway/tests/test_plans_run_limits.py` | B3, B4 |
| B7b | m42 · implementer · 70 | high (R1 routes) | `…/routes/organizations.py`, `…/routes/users.py`, `…/routes/v1.py`, `…/services/snapshots.py`, `…/collaboration.py`, `openbinding-gateway/tests/test_plans_own_counts.py` | B3, B4 |
| T1 | m43 · test-designer · 40 | medium | `acceptance/api/test_plans_pricing.py` | C0 (G1 green) |
| C1 | m43 · implementer · 70 | high (R2, R3 additive, external input) | `…/modules/plans/adapters/sphere/**`, `…/modules/plans/adapters/http/**`, `…/main.py`, `docs/openapi.json`, `openbinding-gateway/tests/fixtures/sphere/**`, `openbinding-gateway/tests/test_plans_pricing_route.py` | B2, B4, C0, T1 frozen, CRP-1 |
| C2 | m43 · implementer · 60 | high (R3 deprecation, key removal) | `…/routes/pricing.py`, `…/models/pricing.py`, `…/sphere_client.py`, `…/pricing_catalog.py`, `…/core/settings.py`, `…/main.py`, `docs/openapi.json`, `lab/tests/test_no_direct_space_http.py`, `.env.example`, `openbinding-gateway/.env.example`, `openbinding-gateway/tests/test_published_pricing.py`, `openbinding-gateway/tests/test_pricing_public_errors.py` | C1, CRP-3 |
| B8 | m42 · implementer · 50 | high | `…/modules/plans/application/verify.py`, `…/access/contracts.py`, `…/main.py`, `openbinding-gateway/tests/test_plans_verify.py` | B3, C1, C2 |
| B9 | m42 · implementer · 50 | high (socket, lifespan) | `…/modules/plans/adapters/space/events.py`, `…/main.py`, `openbinding-gateway/tests/test_plans_events.py` | B4, B8, CRP-1=A |
| C3 | m43 · implementer · 60 | high (R1/R2 removal) | `…/domain/usage_counters.py`, `openbinding-gateway/tests/test_usage_counters.py`, `…/services/entitlements.py`, `…/access/policy.py`, `…/collaboration.py`, `…/routes/organizations.py`, `…/routes/artifacts.py`, `…/sponsor_proposals.py`, `…/modules/plans/adapters/open/**` | B5, B6, B7a, B7b; no M2.4 sponsorship step running |
| D1 | m45 · implementer · 70 | high (R10 lab/previews) | `compose.lab.json`, `compose.lab-pricing.json`, `lab/tests/test_lab_compose.py`, `lab/previews/previews.py`, `lab/tests/test_previews.py`, `openbinding-gateway/tools/seed_lab.py`, `docs/DEMO.md`, `.env.example` | A4, B5-B9, C1, CRP-4, CRP-5 |
| D2 | m45 · coordinator (lab) · 30 | high | `docs/qa/PRICING_PROFILE.md` (M4.5 evidence) | D1 |
| C4 | m43 · implementer | high (breaking removal) | `routes/pricing.py`, `models/pricing.py`, `main.py`, `docs/openapi.json` | M4.4 merged, Sunset passed |

`…/` stands for `openbinding-gateway/src/openbinding_gateway/`. Wave 0 owns pairwise-disjoint files. In waves 1-2 the
shared files go one writer at a time, in the order of intake §2.5. The test-designer slices (T1, T5) run before the
slices they gate. Their tests run against the app in process with a fake `PlanPort` or recorded SPHERE responses, and
never reach the network.

### What each wave-0 slice delivers
- **A2**: the wiring in `openspec/changes/m41-space-bootstrap/design.md:172-195` and tasks S2b and S4.2.
  - `space-api` is built from `lab/space` (`openbinding-lab/space-api:1.7.1`).
  - The one-shot `pricing-bootstrap` is built from `lab/tools`, with 96 MiB, `restart: "no"` and no healthcheck.
  - The sum is 1088 MiB.
  - Revisions ~2 of `pinned-images`, `isolated`, `secret-references`, `start-order` and `no-local-space`.
  - The marker rule and the runbook GAP section are removed.
  - No key volume yet: that comes in A3.
- **B0**: proposal, design and tasks, plus these deltas:
  - auth-roles-entitlements: MODIFIED `plan-reads~2` and `no-metering~2`;
  - ADDED: `plans-entitlement-map`, `plans-active-pricing-check`, `plans-consumption-at-admission`,
    `plans-revert-on-failure`, `plans-event-relay`, `plans-fail-closed` and `plans-flag`.

  Values pending a CRP are marked `PENDING CRP-M4-n`.
- **B1**: the recorded pricing `tests/fixtures/pricing/openbinding-0.2.0.yml`, a copy whose sha256 equals `3db4ad99…`.
  A test that pins the surface of the installed `space-python-client` 1.0.0: `features.evaluate`,
  `features.revert_evaluation`, `features.generate_user_pricing_token`, `on` and `remove_listener` (X2). If a name
  differs, the slice reports it instead of guessing.
- **B2**: the move described in the Decisions section. `docs/openapi.json` is byte-identical. A new `.importlinter`
  contract says that `modules.plans` imports only `core` and its own packages.
- **C0**: the OpenAPI delta for `GET /v1/plans/pricing`.
  - Descriptor fields: `permanentUrl`, `pricingId`, `versionId`, `version`, `contentHash`, `activeVersion` (nullable,
    R-d) and `yaml`.
  - Errors: `503 pricing_unavailable` (existing problem code) and a 304 on a matching ETag.
  - The deprecation headers of CRP-3 A.
- **D0**: the design of CRP-5 option A, the seed guard change (`seed_lab.py:92`), how the seed roles map to plans
  (`SPACE_BOOTSTRAP_PLAN` today gives FREE to every user), and how the `SPACE_API_KEY_FILE` wiring follows CRP-4.

## Checks (proposed argv; register per slice)
Aliases. P(x…) means
`["uv","run","--directory","openbinding-gateway","--locked","--extra","test","pytest","-q","-p","no:cacheprovider",x…]`.

| Name | argv |
|---|---|
| S | `["uv","sync","--directory","openbinding-gateway","--locked","--extra","test"]`, run first in every gateway slice |
| ALL | `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","pytest","-q","-p","no:cacheprovider"]`, timeout 1800 |
| IMP | `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","--group","lint","lint-imports","--config",".importlinter"]` |
| RUFF | `["uv","run","--directory","openbinding-gateway","--locked","--extra","test","ruff","check","src","tests"]` |
| OAPI | `["uv","run","--directory","openbinding-gateway","--locked","python","tools/dump_openapi.py","--check"]` |
| G1(c) | `["openspec","validate","<c>","--strict"]` |
| ACC(f) | `["openbinding-gateway/.venv/bin/python","-m","pytest","-c","acceptance/api/pytest.ini","<f>"]` |
| RED(f) | `{"argv": ACC(f), "type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError","overlay":["<f>"]}` |

Checks and gates for each slice:
- A2: S; P(`../lab/tests`, `tests/test_no_local_space.py`, `tests/test_container_hardening.py`,
  `tests/test_no_local_pricing.py`); G1(m41-space-lab-profile). `docker compose -f compose.lab-pricing.json config`
  and the image builds are coordinator lab checks, because workers have no Docker.
- A3: S; P(`../lab/tests/test_space_lab_bootstrap.py`, `../lab/tests/test_lab_pricing_profile.py`,
  `../lab/tests/test_no_direct_space_http.py`); G1(m41-space-bootstrap).
- B0, C0, D0: G1 of their change. Gate G2 (epic review) follows.
- B1: S; P(`tests/test_space_client_surface.py`, `tests/test_suite_is_hermetic.py`).
- B2: S; ALL; IMP; RUFF; OAPI; P(`../lab/tests/test_no_direct_space_http.py`).
- B3, B4, B6, B7a, B7b, B8, B9, C3: S; ALL; IMP; RUFF; OAPI. Add P(`../lab/tests`) where a lab test is owned.
- T5 and T1: RED(their file), gate G3.
- B5: the same set as B3 plus ACC(`acceptance/api/test_plans_admission.py`), gate G4.
- C1: the same set plus ACC(`acceptance/api/test_plans_pricing.py`) (gate G4) and
  P(`../lab/tests/test_no_direct_space_http.py`). C1 regenerates `docs/openapi.json` with `tools/dump_openapi.py`
  (write mode, as its own registered check) before OAPI.
- C2: like C1, without ACC.
- Review panel: high → reviewer, test-reviewer, security-auditor and arch-reviewer. B5 and B6 add perf-reviewer (hot
  path). Low and medium per `.agentic/project.yaml:141-147`.

## Open questions and risks
- CRP-M4-1 to CRP-M4-6: questions, options and recommendations are in intake §3. Waiting on the owner. No wave-0 slice
  waits on them.
- Factory F1 (`lab_compose file=`) and F2 (memory accounting) block A4 and D1. Waiting on the coordinator.
- Archiving the m41 changes needs `openspec/specs/**`, which another lead holds. The archive tasks wait for it.
- Risks R-a to R-f: intake §4.

## Ruled out
- Deleting `/v1/pricing*` in M4.3: it breaks the frontend pages listed in F21 (CRP-3 C).
- A flat `openbinding_gateway/plans/`: the module would move twice.
- One "vocabulary switch" slice: estimated at more than 600 lines over R1, R2 and R5 files, so it is split into B5,
  B6, B7a and B7b with the dual-vocabulary `OpenGate`.
- Starting M4.5 code now: blocked by F17 (SPACE on 0.2.0 refuses the 0.1.5 names) and by CRP-4/5.

## Next three steps
1. Coordinator: open the six wave-0 tasks (A2, B0, B1, B2, C0, D0) with the owned globs and checks above. They are
   pairwise disjoint and can run in parallel, at most two checks at a time in the lab.
2. Coordinator: send CRP-M4-1 to CRP-M4-6 (intake §3) to the owner as one decision request, with the recommended
   options.
3. When B1 and B2 merge and CRP-1/2 are answered, open B3 and B4 in parallel, then T5 and T1, then B5, B6, B7a, B7b
   and C1, keeping the order for shared files in intake §2.5.

## Evidence
- Planning task on 99697d7e. Lookups (X1-X3 in intake.md): PyPI/npm/GitHub releases; the space-python-client README;
  SPACE v1.7.1 `SphereClient.ts`.
- Checks: none registered for this task; none run.

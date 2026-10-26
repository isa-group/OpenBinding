# Intake: m4-plans-slices (ROADMAP M4.1 remainder, M4.2, M4.3, M4.5)

- Owner request: own-033e9b12c03448b28e474e292072c32c (24-10-2026). Plan the M4 slices that can start now, now that M4.0
  is done (pricing 0.2.0 is published in SPHERE). Raise a CRP wherever INTENT §11.4 requires one.
- Written: 2026-10-26, at the worktree head `99697d7e`. The planner reads and writes `docs/agent-work/m4-plans-slices/**`
  only. Slices, dependencies, checks and file scopes are in [handoff.md](handoff.md).
- Out of scope: M4.4 (browser, `frontend/**`) and M4.6. Files other leads hold, which no slice below may touch:
  `openbinding-gateway/src/openbinding_gateway/services/citations.py`, `routes/resolve.py`, `routes/verifier.py`,
  `openbinding-gateway/tools/latency_probe.py`, `frontend/**`, `openspec/specs/**`, `ROADMAP.md`.

## 1. Verified facts (file:line at 99697d7e)

### Roadmap, intent and decisions
- F1. `ROADMAP.md:122-127`: the deliverables and acceptance of M4.1 to M4.6. `ROADMAP.md:129-134`: M4.0 is done
  (`latestVersionId` `6ada6dbd4b2b5b01c587d17f`, contentHash `3db4ad99…`, equal to `docs/pricing/openbinding-0.2.0.yml`).
  M4.1 is partly merged (PR #36).
- F2. `INTENT.md:226-227` (§11.3 and §11.4): the mapping from operations to plan features and limits, any new external
  integration, and any change of SPACE/SPHERE client versions, sync policy or pricing content each need a CRP.
  `INTENT.md:232` (§11.8): so does a new runtime dependency with network access. `INTENT.md:229` (§11.1): so does a
  breaking public contract change.
- F3. `INTENT.md:249-250`: D5 is decided (local SPACE 1.7.1 linked to `sphere.score.us.es`). D6 is `all_last`.
  `INTENT.md:198-200`: SPACE is reached only through its official clients, and SPHERE only through its public
  permanent-link API.
- F4. `docs/adr/0015-plans-through-space-and-sphere-clients.md:1,5`: the status is **Proposed**. Relevant sections:
  §2 (line 23, the plans module is the only SPACE caller), §3 (line 26, SPHERE public API, no key) and §7 (lines 38-39,
  removals). `docs/adr/0022-…:1-5`: Proposed, but the owner approved the exception (own-36b6e089).
- F5. `docs/ARCHITECTURE.md:129`: module `plans` (code to move: `space_client/*`, `services/entitlements.py`,
  `access/policy.py`, `access/contracts.py`, `domain/entitlements.py`; retire `domain/usage_counters.py` and
  sponsorship). `:136-147`: layout `modules/<module>/{domain,application,adapters}`. `:174`: new capabilities land in
  modules, and `plans` is the first.
- F6. `docs/ARCHITECTURE.md:498-522` (§9.2) describes:
  - `PlanPort` over `space-python-client` 1.x with a MANAGEMENT key;
  - an entitlement map that is checked at start-up and on pricing activation;
  - `evaluate(user, feature, expected_consumption)` and `revert_evaluation`, and event relay;
  - `GET /v1/plans/pricing` (descriptor plus YAML, bounded to 5 MiB, hash-verified, ETag-cached).

  `:537-541` (§9.4): the MANAGEMENT key is "kept in the stack's secret store".
- F7. `docs/pricing/README.md:170-191` (§6): the operation → feature/limit/consumption table that is the input for
  M4.2. `:121-141`: technical ceilings (128 MiB per package, 1,000,000 iterations, binding spaces up to 10^20) become
  gateway settings.

### M4.1 state (lab)
- F8. Merged and present: `lab/space/Dockerfile`, `lab/tools/space_lab_bootstrap.py`, `lab/tools/Dockerfile`,
  `lab/tests/test_space_lab_bootstrap.py`, `lab/tests/test_no_direct_space_http.py`, ADR-0022.
  `openspec/changes/m41-space-bootstrap/tasks.md:5`: S-A to S-D are done.
- F9. `compose.lab-pricing.json:40`: `space-api` is still `gap.invalid/space-api:1.7.1`, and there is no
  `pricing-bootstrap` service. `openspec/changes/m41-space-lab-profile/tasks.md:52-58,67-73,92-95`: S2b (build from
  commit `ef4dc894…`), S4.2 (one-shot service, 1088 MiB) and S5 (live evidence) are open.
  `openspec/changes/m41-space-bootstrap/design.md:172-195` (§7) lists the exact wiring and the test revisions.
- F10. MANAGEMENT key placement is still open. `openspec/changes/m41-space-bootstrap/design.md:137-143` assumes the key
  stays inside SPACE and is reused on re-run. `docs/qa/PRICING_PROFILE.md:132` repeats that assumption. Owner question
  3 is unanswered.
- F11. `openspec/changes/m41-space-lab-profile/design.md:15,104-106`: the gateway is not wired to this SPACE. The
  question of how `SPACE_URL` reaches the gateway, and preview memory (2 × (4032 + 1088) > 9216 MiB), are left to
  M4.5. `docs/DEMO.md:195` and `openbinding-gateway/tools/seed_lab.py:92`: the seed refuses service `openbinding`, the
  name the bootstrap creates.
- F12. `lab/tests/test_no_direct_space_http.py:34`: `ALLOWED_PREFIXES = ("lab/tools/",
  "openbinding-gateway/src/openbinding_gateway/plans/")`. That is a flat `plans/` path, not ARCHITECTURE's
  `modules/plans/`. `:80-83`: the pinned deviations are `tools/_remote_common.py` and `sphere_client.py`.
- F13. Factory follow-ups outside the repository: F1, `lab_compose file=compose.lab-pricing.json`, and F2, admission and
  preview memory accounting (`openspec/changes/m41-space-lab-profile/tasks.md:76-78`). S5 cannot run without F1.

### Gateway today
- F14. `openbinding-gateway/pyproject.toml:38`: `space-python-client>=1.0,<2.0`. `uv.lock:2055-2061`: 1.0.0, which
  depends on `httpx` and `python-socketio`. `uv.lock:1606-1607`: python-socketio 5.16.3 is already locked.
- F15. `space_client/space.py:48-55`: the gate connects with `SPACE_URL` and `SPACE_API_KEY`. It reads caps from the
  pricing token (`:94-140`), and creates and novates contracts at `SPACE_PRICING_VERSION` (`:102-104,157-161`).
  `space_client/gate.py:102-142`: the protocol has no evaluate, revert or events.
- F16. `tests/test_space_client.py:152-156`: `test_no_gate_offers_to_evaluate_or_consume` forbids `usage`, `evaluat`
  and `revert` names on every gate. M4.2 must replace it.
- F17. The gateway reads pricing **0.1.5 vocabulary**. If SPACE runs on 0.2.0, every one of these lookups fails closed:
  - features `solve`/`federatedEngines` at `routes/jobs.py:146` and `services/job_submission.py:664`;
  - limits `maxTimeoutSeconds`, `maxIterations`, `maxPayloadBytes`, `storageBytes` and `maxInstanceComplexityLog10`
    at `access/policy.py:120-234`;
  - `concurrentJobs` at `domain/entitlements.py:21`;
  - `institutionalBranding`, `apiKeys` and `jobHistoryDays` at `routes/users.py:98,314,452`;
  - the `federatedEngines` limit at `routes/v1.py:853`.

  `space_client/open.py:27-57,60-77`: `OpenGate` lists the same 0.1.5 names, and a missing allowance is zero
  (`gate.py:51-59`).
- F18. Local metering port: `domain/usage_counters.py:10-13,192-194`. No source is installed (`taskStarts`,
  `federatedTaskStarts`, `solverSeconds`, `studyRuns`). Callers: `routes/jobs.py:156`,
  `services/job_submission.py:655-668`, `routes/studies.py:659`.
- F19. Sponsorship capacity checks:
  - `services/entitlements.py:146-180` and `access/policy.py:200-217`;
  - callers `collaboration.py:276-299`, `routes/organizations.py:22,583`, `sponsor_proposals.py:30,386`,
    `routes/artifacts.py:185`.
- F20. Legacy pricing:
  - `routes/pricing.py:53-78` serves `/v1/pricing/current`, `/v1/pricing` (deprecated) and `/v1/pricing/catalog` from
    `pricing_catalog.py` (114 lines) over `sphere_client.py` (231 lines, private API with key);
  - settings: `core/settings.py:349-356` (`sphere_enabled`, `sphere_api_key`, `sphere_organization_id`, …);
  - `main.py:63,106,375` imports the router, reads `sphere_api_key` and includes the router.
- F21. The frontend still calls `getPricingCatalog` and `getCurrentPricing` (`frontend/src/api/client.ts:1179-1185`).
  The callers are in Pricing, AccountUsage, AccountIdentities, Workbench, JobLaunch, JobHistory, StudyBuilder,
  CaseComposer, EngineDetail, OrgCreate, AdminSponsor, AdminUserDetail, AdminOverview and ProjectPackage. Deleting the
  routes before M4.4 breaks these pages.
- F22. Things that are already gone:
  - release (contract-renewal) sweeps and `space_client/deployments.py`, pinned by
    `tests/test_no_local_pricing.py:27-40,111-117`;
  - admin pricing validation: no match in `routes/admin.py`.

  M4.3 has none of these left to remove. Pitfall: the retired name `pricing` + `_bootstrap` is searched for in `src`
  (`test_no_local_pricing.py:30,93-100`). Gateway code must never use that identifier with an underscore.
- F23. No `modules/`, `app/` or `shared/` package exists yet (M9.1 is planned). `.importlinter` has three contracts
  (`routes -> services -> …`). CI runs `lint-imports` report-only (`.github/workflows/ci.yml:164`).
- F24. Living specs: `openspec/specs/auth-roles-entitlements/spec.md:111-128`.
  - `req~…-plan-reads~1` is the 403/503 contract.
  - `req~…-no-metering~1` says "SHALL NOT run a local SPACE stack", which conflicts with ADR-0015 and the M4.1 profile.
    It needs a MODIFIED revision in an M4.2 delta. `openspec/specs/**` is held by another lead, so only change deltas
    are written now.
- F25. `.agentic/project.yaml:109-111`: risk area R2 (plans, high) does not list a `modules/plans/**` path, and
  `.agentic/**` is owner-only. `:62`: the G6 trace paths do not include `lab/tests`.

### External facts (lookup, cited)
- X1. `space-python-client` 1.0.0 is the latest on PyPI (released 2026-07-31). SPACE: nothing newer than v1.7.1
  (released 2026-10-15). `space-react-client` 0.3.3 (peer `react ^18.3.1`). `pricing-renderer` 0.1.0. Sources:
  pypi.org/pypi/space-python-client/json, api.github.com/repos/SCORELabUS/space/releases,
  registry.npmjs.org/{space-react-client,pricing-renderer}. Confidence: medium.
- X2. Client API, as the client's README on its main branch describes it (not the 1.0.0 tag; medium confidence):
  - `client.features.evaluate(user_id, feature_id, expected_consumption=None, details=False, server=False)`;
  - `client.features.revert_evaluation(user_id, feature_id, revert_to_latest=True)`;
  - `client.features.generate_user_pricing_token(user_id)`;
  - events via `client.on(event, callback)`, named `synchronized`, `pricing_created`, `pricing_archived`,
    **`pricing_actived`** (sic, not ARCHITECTURE's `pricing_activated`), `service_disabled` and `error`;
  - no service, organization or pricing-listing operations.

  Source: github.com/Alex-GF/space-python-client (README). Slice B1 pins the surface against the installed 1.0.0.
- X3. SPACE v1.7.1 reads SPHERE at `/api/v1/public/pricings/{id}` and
  `/api/v1/public/pricings/{pricingId}/versions/{versionId}/yaml`
  (`api/src/main/services/sphere/SphereClient.ts`; high confidence). The public manifest has `pricingId`, `name`,
  `permanentUrl`, `latestVersionId` and `versions[{versionId, version, createdAt, contentHash}]` (low confidence, from a
  summarized fetch). Whether an ETag header is present is unknown. Slice C1 records the real responses before it
  relies on them.

## 2. Consequences for the plan

1. **M4.2 lands behind a flag and a dual vocabulary.** The lab runs `DEMO_SPACE_ENABLED=false` (`docs/DEMO.md:72`), so
   `OpenGate` decides today. During the transition `OpenGate` grants the 0.1.5 and 0.2.0 identifiers together, and each
   reader switches to 0.2.0 in its own slice. SPACE consumption is sent only when a new setting `plans_space_usage`
   (default `false`) is on. M4.5 turns it on with SPACE. The last slice (C3) removes the 0.1.5 names.
2. **Plans module location.** `openbinding_gateway/modules/plans/` follows ARCHITECTURE §4.1-4.2. B2 creates
   `modules/__init__.py` and `modules/plans/**`, and edits the allow-list in `lab/tests/test_no_direct_space_http.py:34`
   in the same slice. It keeps `space_client/__init__.py` as a re-export shim, so no caller changes in that slice. The
   alternative, a flat `openbinding_gateway/plans/` (which the test already allows), was rejected: M9.2 would then have
   to move the module a second time.
3. **M4.3 splits around M4.4.** The new route and source are additive (C1). The SPHERE key and the private client can go
   right away, if the deprecated routes are served from the public source (C2, CRP-3). Deleting the routes waits for
   M4.4 and the Sunset date (C4, not startable).
4. **M4.5 cannot be implemented now.** It needs M4.1 S5, the M4.2 vocabulary switch and CRP-4/CRP-5. Only its design
   (D0) starts now.
5. **A single writer for shared files, in this order:**
   - `core/settings.py`: B4 adds every new setting for M4.2/M4.3; C2 removes the SPHERE ones.
   - `main.py`: C1 → C2 → B8 → B9.
   - `services/entitlements.py` and `access/policy.py`: B7a → C3.
   - `routes/organizations.py` and `collaboration.py`: B7b → C3.
   - `routes/studies.py`: B6 only.
   - `lab/tests/test_no_direct_space_http.py`: B2 → C2.
   - `compose.lab-pricing.json`: A2 → A3 → D1.
   - `docs/openapi.json`: C1 → C2 (serial, because each regenerates it).

## 3. Change requests for the owner (CRP)

Each CRP has a recommended option. Wave-0 slices do not wait for them; the slices listed under "Blocks" do.

### CRP-M4-1: SPACE/SPHERE client versions and new integrations (INTENT §11.4, §11.8)
Question: do you approve these for M4.2 and M4.3?
- (a) Pin `space-python-client` to exactly `==1.0.0` (today `>=1.0,<2.0`; the version is unchanged, 1.0.0 is locked
  and is the latest on PyPI).
- (b) Use its feature evaluation, `revert_evaluation` and the socket.io event channel from the gateway to SPACE. This is
  new runtime network use. python-socketio 5.16.3 is already locked.
- (c) The gateway reads SPHERE's public API, `/api/v1/public/pricings/6ab0a323697330667ccce891` and
  `…/versions/{versionId}/yaml`, with no key. This replaces the private API with a key.
- (d) SPACE stays 1.7.1, commit `ef4dc894…`, already decided.

Options:
- **A, recommended:** approve (a) to (d).
- B: approve (a), (c) and (d) without the event channel. The gateway re-reads the pricing on a timer (at most
  5 minutes extra delay in the M4 scenario).
- C: keep the version range and defer.

Blocks: B4, B9, C1.

### CRP-M4-2: entitlement map (INTENT §11.3)
Question: is `docs/pricing/README.md` §6 (lines 170-191) the operation → feature/limit/consumption map of the plans
module? It includes these rules:
- feature `solve` becomes `runs`;
- `institutionalBranding` and `jobHistoryDays` are no longer read (retention follows ARCHITECTURE §10);
- the 0.1.5 technical limits become gateway settings: 128 MiB per package, 1,000,000 iterations, 10^20 binding space;
- `solverHours` consumes the run budget at admission, with no refund on early stop;
- an operation that fails after consuming is reverted;
- the repository limits apply to FREE only.

Options:
- **A, recommended:** adopt §6 as written.
- B: adopt §6, but charge actual solver time at the end of a run instead of the budget at admission. This needs a
  usage-level update path the client does not document, and the count can drift.
- C: amend the table first (the owner names the rows).

Blocks: B3, B5, B6, B7a, B7b.

### CRP-M4-3: the deprecated pricing endpoints (INTENT §11.1, ADR-0015 §7)
Question: how do `/v1/pricing`, `/v1/pricing/catalog` and `/v1/pricing/current` retire? Today about 15 frontend pages
call them (F21).

Options:
- **A, recommended:** in C2, serve them from the new public-API source, add `Deprecation`, `Sunset` and
  `Link: </v1/plans/pricing>; rel="successor-version"`, and delete `sphere_client.py`, `pricing_catalog.py` and every
  SPHERE key setting now. The routes are deleted (C4) after M4.4 stops calling them and the Sunset date passes.
  Owner input: the Sunset date. The suggestion is the R2 release date, or 90 days after C2 merges.
- B: keep the private client and key until M4.4, then delete everything at once without deprecation headers.
- C: delete now and accept broken pages in develop until M4.4 (not recommended).

Blocks: C2, C4.

### CRP-M4-4: where the SPACE MANAGEMENT key lives (open question 3 of `crp-openbinding-m41-space-image-and-16-1`)
Question: the gateway needs this key in M4.5. How does it get it, given that the bootstrap creates it?

Options:
- **A, recommended:** the bootstrap writes the key once to a file, mode 0400, on a dedicated named volume shared with
  the gateway. The gateway reads it through a new `SPACE_API_KEY_FILE` setting. The key is never printed or logged,
  and a re-run reuses it. This matches ARCHITECTURE §9.4 ("stack's secret store").
- B: after the first bootstrap, the operator copies the key from SPACE's console into the lab environment file as
  `DEMO_SPACE_API_KEY`. This is a manual step and puts a secret in an env file.
- C: keep it inside SPACE (the current assumption). The gateway can then never call SPACE, so this only works until
  M4.5.

Blocks: A3, D1.

### CRP-M4-5: lab and preview topology and memory for M4.5 (capacity; ROADMAP M4.5)
Question: how do the develop lab and the PR previews reach SPACE within the 9216 MiB cap?

Options:
- **A, recommended:** one shared SPACE per lab (the `openbinding-lab-pricing` project, 1088 MiB). The develop lab and
  the previews join it through one external network, `openbinding-pricing`, an exception to the lab's no-`networks`
  rule recorded in an ADR. Total 4032 + 4032 + 1088 = 9152 MiB. Risk: the seed users have the same deterministic ids
  (uuid5) in every stack, so previews share their synthetic contracts.
- B: fold SPACE into `compose.lab.json` as a default-on profile and keep previews on `OpenGate`. Previews would not
  show real plans, which fails the M4.5 acceptance.
- C: a SPACE per stack. 2 × (4032 + 1088) = 10240 MiB is over the cap, so at most one SPACE-enabled preview, or a
  raised cap.

Blocks: D1, D2.

### CRP-M4-6: decision statuses (INTENT §11.10)
Question: accept ADR-0015 (it supersedes ADR-0010, except "nothing is charged") and ADR-0022, both still Proposed?
Every M4 slice relies on them. Also confirm that the living requirement
`req~auth-roles-entitlements-no-metering~1` gets a MODIFIED revision ~2 in the M4.2 delta. Its text, "SHALL NOT run a
local SPACE stack", contradicts D5.

Options:
- **A, recommended:** accept both ADRs and the revision.
- B: keep them Proposed until R2.

Blocks: nothing technically. A1-level archive tasks and R2 need it.

## 4. Risks
- R-a, client surface: `evaluate`, `revert` and the events are known from the README only (X2). B1 pins them against
  the installed 1.0.0 before B4 relies on them.
- R-b, SPACE live behaviour: the HTTP sequence of the bootstrap and the pricing-token shape on 0.2.0 are unverified
  live until S5 (A4).
- R-c, vocabulary switch: a production deploy between B7 and the end of M4 with SPACE on 0.2.0 would refuse
  everything. Production is owner-only, and R2 ships all of M4 together.
- R-d, active version: `space-python-client` has no service or pricing listing (X2). The version SPACE has activated
  comes only from events or the pricing token. The descriptor field for it may be null until B9.
- R-e, cross-lead files: sponsorship code is also on the M2.4/M9.6 path, so C3 must not run concurrently with a
  sponsorship endpoint step. Archiving the m41 and m42 changes needs `openspec/specs/**`, which another lead holds.
- R-f, governance gaps: the R2 risk globs and the G6 trace paths need `.agentic/project.yaml` edits, which are
  owner-only (followups).

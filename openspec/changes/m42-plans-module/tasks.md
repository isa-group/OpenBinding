# Tasks: m42-plans-module

Slices in build order, each at most ~300 diff lines, one capability, disjoint files, tests first (tagged
`[utest->req~…~N]`). Check commands run from the repository root; pytest checks are one argv
`["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", …]`. Every slice
also runs G1 (`openspec validate m42-plans-module --strict`) and the full gateway unit suite. No unit or CI test reaches
SPACE or SPHERE (constitution 16.6); they use the recorded pricing `docs/pricing/openbinding-0.2.0.yml` and a fake
`PlanPort`. Paths below are under `openbinding-gateway/` unless they start with `docs/` or `lab/`.

## S0. Specification (this change)
- [x] 0.1 `openspec/changes/m42-plans-module/` (proposal, design, tasks, delta specs of `plans` and
  `auth-roles-entitlements`).
- Acceptance: G1 passes.

## S1. Module move (refactor, behaviour-preserving)
- [ ] 1.1 Characterization tests of today's gate (`caps`, contracts, novation, token, open gate, `build_gate`) against
  the fake, before any move.
- [ ] 1.2 Move `src/openbinding_gateway/space_client/{gate,space,open}.py` and `build_gate`/`get_gate`/`set_gate` into
  `src/openbinding_gateway/modules/plans/` (design.md §2); `PricingGate` becomes `PlanPort`; delete `space_client/`
  (with the retired `fake.py`); update the importers (`services/entitlements.py`, `access/*`, `main.py`, routes,
  `tests/conftest.py`, `tests/_fake_space.py`).
- [ ] 1.3 Architecture test: `space_client` imported only under `modules/plans/`; nothing outside the plans module calls
  the adapter's `caps` directly.
- Requirements: `plans-single-space-seam`, `auth-roles-entitlements-plan-reads` ~2.
- Acceptance: the characterization tests and the whole unit suite pass unchanged; `docs/openapi.json` is byte-identical.
- Depends on: nothing (creates `modules/__init__.py` if ARCHITECTURE §4.3 step 1 has not landed).

## S2. Entitlement map and its verification
- [ ] 2.1 Tests: the map against the recorded pricing 0.2.0 (7 features, 12 limits, one entry per gated operation,
  `feature_id` with another service name); a token missing `maxStudyCells` or with a string limit → 503
  `pricing_misconfigured`; `null` → unlimited; a recorded variant with `generator: false` → 403.
- [ ] 2.2 `modules/plans/domain/entitlements_map.py` (design.md §3) and the check on each token read (§4); the old
  identifiers of `access/policy.py` and `open.py` that pricing 0.2.0 no longer declares are mapped or retired in the
  callers that S3 and S4 touch.
- Requirements: `plans-entitlement-map`, `plans-map-verified`, `plans-feature-refusal`.
- Depends on: S1.

## S3. Admission: solver hours and generated instances
- [ ] 3.1 Tests with a recording fake `PlanPort`: a direct run of 300 000 ms evaluates `openbinding-runs` with
  300 / 3600 hours before the job row exists; a study cell (`openbinding-studies`); the clamped budget; a federated run
  sends no consumption; an idempotent replay sends nothing; a negative evaluation → 402 `usage_limit_exceeded` with the
  `quota` object and no job; a persisted generation of 40 → `generatedInstances` 40; a generation without `persist`
  (anonymous or signed in) sends nothing; a refused cell fails and the run goes on; a negative result with `error` or a
  timeout → 503 with no revert.
- [ ] 3.2 `PlanPort.evaluate` in the SPACE adapter and the open gate; `admit` in the plans application API; callers in
  `services/job_submission.py`, `study_jobs.py` and the generator route replace `usage_counters.job_start_refusal` and
  `usage_refusal("studyRuns")`; architecture test for `no-metering` ~2.
- Requirements: `plans-solver-hours-admission`, `plans-generation-admission`, `plans-usage-exhausted`,
  `auth-roles-entitlements-no-metering` ~2.
- Depends on: S2.

## S4. Other limits against the gateway's own counts
- [ ] 4.1 Tests per limit of design.md §7 on FREE and RESEARCH (`.inf`): 26th problem, 6th collection, storage at
  499 000 000 + 2 000 000 bytes, owner of record of organization work, second private project, 501 cells, 101
  instances, 900 000 ms clamped to 300 000 ms with `OPTION_CLAMPED`, a LAB budget of 7 200 000 ms clamped to the
  1800 s technical timeout without `pricing_misconfigured`, second run on FREE → 429 with limit 1, cells
  waiting, third API key on FREE → 402 `maxApiKeys`.
- [ ] 4.2 `count_limit` and `clamp_budget` in the plans application API; the repository, collection, project, study,
  generator, engine-registry and API-key routes call them inside their writing transaction with the account row locked.
- Requirements: `plans-repository-limits`, `plans-private-projects-limit`, `plans-request-size-limits`,
  `plans-run-budget-ceiling`, `plans-concurrent-runs`, `auth-roles-entitlements-api-key-quota` ~2.
- Acceptance: the `quota` object of every 402 is documented in `docs/openapi.json` (regenerated through its check).
- Depends on: S2. May be split by area (repository, laboratory, collaboration and keys) to stay under ~300 lines.

## S5. SPACE event relay
- [ ] 5.1 Tests with a fake event source: each of the five events drops the cached entitlements of the service and not
  those of another service; `plans.changed` reaches two open streams within 5 s with no account data; 401 without
  authentication; while the source is disconnected, a cached entry older than 60 s is not used.
- [ ] 5.2 `modules/plans/adapters/space/events.py` (subscription in the lifespan, reconnect with backoff) and
  `modules/plans/adapters/http/events.py` (`GET /v1/plans/events`), design.md §8; `docs/openapi.json` regenerated.
- Requirements: `plans-event-cache-invalidation`, `plans-event-relay`, `plans-cache-bound-without-events`.
- Depends on: S1. Public API addition: confirm with the lead that the CRP covered it (design.md §11, D11).

## S6. Revert on failure
- [ ] 6.1 Tests: a failing commit after a positive evaluation sends one revert and answers 500; a built-in run cancelled
  while `queued` within 120 s sends one; a run failed with `queue_timeout` under the default `QUEUE_TIMEOUT_S` (1800 s)
  sends none and logs `plans.revert_failed` with `window_expired`; a failed publication to the queue sends none (the row stays
  `queued`); a federated run cancelled while `queued` sends none; a persisted generation with no instance written sends
  one, with 10 written none; claimed runs (cancelled, engine error, early end) send none; a revert due after 150 s or
  failing in SPACE logs `plans.revert_failed` and is not retried.
- [ ] 6.2 `PlanPort.revert`, `revert_admission` in the plans application API, and the hooks in job submission, the job
  lifecycle and reconciler (terminal without a claim) and the generator.
- Requirements: `plans-revert-on-failure`, `plans-revert-failed`, `plans-no-refund-after-start`.
- Depends on: S3.

## S7. Fail closed and open gate
- [ ] 7.1 Tests: SPACE not answering → 503 `pricing_unavailable` for a run, a problem and a private project with
  nothing stored; the gateway starts with SPACE down, serves a public read, and admits after SPACE returns; with
  `SPACE_ENABLED=false` and `APP_ENV=dev` everything gated is admitted with no SPACE call; `APP_ENV=prod` refuses it.
- [ ] 7.2 Close any path S3-S6 left that writes before the SPACE answer; `OpenGate.evaluate`/`revert`/`subscribe`;
  `open_limits` and `OPEN_FEATURES` extended to every id of the map (design.md §9), so the open gate admits a 26th
  problem.
- Requirements: `plans-fail-closed`, `plans-open-gate`.
- Depends on: S3, S4, S6.

## S8. Contract tests against the lab profile
- [ ] 8.1 `tests/contract/test_plans_space_contract.py` (marker `space_contract`, skipped unless
  `PLANS_CONTRACT_SPACE_URL` and `PLANS_CONTRACT_SPACE_API_KEY` are set): contract and token, consumption and revert,
  `synchronized` event, SPACE stopped → 503 (design.md §9).
- [ ] 8.2 A registered lab check that runs the suite against the `pricing` profile; the results are recorded in
  `docs/qa/PRICING_PROFILE.md`, and every UNVERIFIED item of design.md §12 is confirmed or corrected.
- Requirements: `plans-contract-suite`.
- Depends on: S3, S5, S6, S7, and outside this change: the compose wiring of `pricing-bootstrap` and of the `space-api`
  build (m41-space-bootstrap design.md §7), and the placement of the `MANAGEMENT` key (owner question 3 of
  m41-space-bootstrap).

## Follow-ups
- At archive: update the scenario of `req~engine-registry-federated-quota~1` to `maxFederatedEngines` (design.md §1)
  and remove the "Open gate behaviour" TODO of `auth-roles-entitlements`.
- `lab/tests/test_no_direct_space_http.py`: align the allowed plans path with `openbinding_gateway/modules/plans/**`.
- `docs/ACCOUNTS_AND_PLANS.md` and `docs/architecture/gateway-as-is.md`: describe the plans module, the map and the
  consumption once S3 lands (doc-steward).
- `docs/ARCHITECTURE.md` §9.2: the map check per contract instead of at start-up, the event name `pricing_actived`,
  and generated instances counted as requested (design.md §4, §8, D3), after the lead checks D2 and D3 against the CRP.
- `docs/ACCOUNTS_AND_PLANS.md` "A plan above a technical ceiling": the time budget is now clamped to the technical
  timeout (D8); the payload rule is unchanged.
- Decide whether `SPACE_NULL_LIMIT_IS_UNKNOWN` is still needed after the contract suite (design.md §4).
- M4.3: delete `domain/usage_counters.py`, settle the owner-of-record column when sponsorship retires.

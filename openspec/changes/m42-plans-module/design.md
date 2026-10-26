# Design: m42-plans-module

Status: specification only; no slice is implemented. Fixed inputs: ROADMAP M4.2, ADR-0015 (§2, §5, §6), ADR-0010 (its
"nothing is charged" rule), ADR-0017, `docs/ARCHITECTURE.md` §4 and §9, constitution Article 16,
`docs/pricing/openbinding-0.2.0.yml`, `docs/ACCOUNTS_AND_PLANS.md`, `docs/qa/PRICING_PROFILE.md`, the M4.1 changes
`m41-space-lab-profile` and `m41-space-bootstrap`, the code under
`openbinding-gateway/src/openbinding_gateway/space_client/`, and the owner's `accept-all` answer to
`crp-ob-m4-plans-decisions` (own-7153cec8d5a447fa909601bc7ad8fe4d). The CRP text is not in the repository; §11 lists
each choice that it would have held.

## 1. Capabilities

- `plans` (new). ARCHITECTURE §4.1 makes `plans` a bounded context of its own (the SPACE port, the entitlement map,
  the pricing descriptor, plan changes and eligibility), and ADR-0015 §2 gives it the obligations of M4.2. None of the
  living capabilities owns them: `auth-roles-entitlements` is about identity and authority, `job-execution`,
  `studies-analysis`, `generator` and `engine-registry` are the callers. A new capability keeps the 22 requirements in
  one place. M4.3 does not add to it: `GET /v1/plans/pricing` gets the separate capability `plans-pricing`
  (`m43-plans-pricing-route`), because that public, keyless route reads SPHERE and has no SPACE dependency, while every
  requirement of `plans` is about the SPACE-backed gate. M4.4 decides where its own requirements go.
- `auth-roles-entitlements` (3 MODIFIED). Three living requirements contradict pricing 0.2.0 or ADR-0015:
  - `api-key-quota` ~1 names the limit `apiKeys`; pricing 0.2.0 calls it `maxApiKeys` (~2).
  - `plan-reads` ~1 reads "through the entitlement service" and also carries the 403 and the 503. ~2 keeps one
    obligation (reads only through the plans module); the 403 is `req~plans-feature-refusal~1`, the 503 is
    `req~plans-fail-closed~1`. Its living scenario "SPACE unreachable during a launch" stays: the project's
    `openspec validate --strict` refuses a MODIFIED block that drops a living scenario.
  - `no-metering` ~1 says the platform "SHALL NOT run a local SPACE stack or local pricing"; ADR-0015 §5 allows a
    pinned SPACE image in the lab and previews (the lab rule is `lab-deployment`'s, changed by M4.1), and SPACE now
    tracks two usage levels. ~2 keeps the ban on a local pricing and on SPACE logic inside the gateway (ADR-0015 §1,
    constitution 16.2), and forbids charging and any local count of credits, compute units, `solverHours` or
    `generatedInstances`.
- Not modified here, followups at archive: the scenario of `req~engine-registry-federated-quota~1` names the limit
  `federatedEngines` (now `maxFederatedEngines`; the requirement text is generic and stays true);
  `req~job-execution-concurrency-cap~1` is unchanged (the plan limit of `req~plans-concurrent-runs~1` is an
  additional, never a replacing, check); the TODO "Open gate behaviour" of `auth-roles-entitlements` is answered by
  `req~plans-open-gate~1`.

## 2. Module layout and the move

Target (ARCHITECTURE §4.2): `openbinding-gateway/src/openbinding_gateway/modules/plans/` with

| Part | Holds | Comes from |
|---|---|---|
| `domain/entitlements_map.py` | the map of §3, `feature_id`, `PlanCaps`, the limit kinds; pure Python | `space_client/gate.py` (`feature_id`, `PlanCaps`) |
| `application/ports.py` | `PlanPort` (Protocol): today's `PricingGate` methods plus `evaluate`, `revert`, `subscribe` and `active_version() -> str \| None` (§8) | `space_client/gate.py` (`PricingGate`, errors) |
| `application/__init__.py` | the public API other modules call: `require`, `admit`, `revert_admission`, `count_limit`, `clamp_budget`, `caps` | `services/entitlements.py` (later slice) |
| `adapters/space/gate.py` | `SpacePlanGate` over `space-python-client` 1.x | `space_client/space.py` |
| `adapters/space/open_gate.py` | `OpenGate` | `space_client/open.py` |
| `adapters/space/events.py` | the event subscription and relay of §8 | new |
| `adapters/http/events.py` | `GET /v1/plans/events` | new |

The move (slice S1) is behaviour-preserving: characterization tests first, then the files move, imports change,
`space_client/` is deleted (the retired `space_client/fake.py` is not moved) and `docs/openapi.json` stays
byte-identical (ADR-0017). If `modules/` with its import-linter contracts (ARCHITECTURE §4.3 step 1) does not exist when
S1 starts, S1 creates only `modules/__init__.py` and `modules/plans/**`.

The module path is `openbinding-gateway/src/openbinding_gateway/modules/plans/` in this change; `m43-plans-pricing-route`
uses the same path after its own review fix. The plans module never makes a direct HTTP call to SPACE: every SPACE call goes through
`space-python-client` (16.1). It will make direct HTTP calls to SPHERE: M4.3 reads the public pricing without a key, GET
only. The lab architecture test `lab/tests/test_no_direct_space_http.py` allows today
`openbinding-gateway/src/openbinding_gateway/plans/` in `ALLOWED_PREFIXES`, a path that does not match the module.
Aligning `ALLOWED_PREFIXES` with `openbinding-gateway/src/openbinding_gateway/modules/plans/` is therefore a
prerequisite of M4.3 slice S1 and of any slice that adds an HTTP call inside the plans module; no slice of this change
adds one, so none of S1-S8 depends on it.

## 3. Entitlement map (pricing 0.2.0)

Feature ids are `<SPACE_SERVICE_NAME>-<name>` (`feature_id`, unchanged); usage-limit ids the same
(`openbinding-solverHours`). "Consumed" limits are evaluated in SPACE; "counted" limits are plan values compared with
the gateway's own counts (§7); "ceiling" limits bound one request.

| Gated operation | Feature | Consumed in SPACE | Counted / ceiling |
|---|---|---|---|
| create a problem | `repository` | — | `maxProblems`, `maxRepositoryStorage` |
| store a problem version (import, seal) | `repository` | — | `maxRepositoryStorage` |
| create a collection (and its versions) | `repository` | — | `maxCollections`, `maxRepositoryStorage` |
| run on a built-in engine (`POST /v1/jobs`, retry) | `runs` | `solverHours` = effective budget | `maxRunMinutes` (ceiling), `maxConcurrentRuns` |
| run on a federated engine | `federatedEngines` | — | `maxConcurrentRuns` |
| launch a study run | `studies` | — | `maxStudyCells` (ceiling) |
| launch a study cell on a built-in engine | `studies` | `solverHours` = effective budget | `maxRunMinutes` (ceiling), `maxConcurrentRuns` |
| launch a study cell on a federated engine | `studies` and `federatedEngines` | — | `maxConcurrentRuns` |
| generate instances with `persist: true` | `generator` | `generatedInstances` = instances requested | `maxInstancesPerGeneration` (ceiling), `maxConcurrentRuns` |
| solver part of a solver-aware generation | `runs` | `solverHours` = effective budget | `maxRunMinutes` (ceiling) |
| register or activate a federated engine | `federatedEngines` | — | `maxFederatedEngines` |
| create a private project, make a project private | `collaboration` | — | `maxPrivateProjects` |
| create an organization | `collaboration` | — | — |
| create an API key | `apiAccess` | — | `maxApiKeys` |

These 14 rows are the gated operations, all of them and only them. Authenticating a request with an API key is not a
gated operation: `apiAccess` gates only the creation of a key (with `maxApiKeys`), so authenticating a request made
with an existing key, like serving a public read, never reads the plan and never fails because SPACE is down. A request
made with a key is gated only when its operation is one of the rows above (§11, D15). Not gated but still dependent on
SPACE, because they read or change the contract itself: the plan-administration routes (`GET /v1/users/me/pricing-token`,
contract removal, the admin subscription read and change, the CAS research upgrade and downgrade); they move with the
gate unchanged (proposal, Out of scope) and keep their 503 `pricing_unavailable` when SPACE is down, whatever the
credential.

Every feature (7) and every limit (12) of pricing 0.2.0 appears; `maxRunMinutes` and `solverHours` are linked to `runs`
and `studies` only, so a federated run is bounded by neither (the technical solve timeout still applies). In pricing 0.2.0
every plan grants all seven features; the 403 path is exercised with a recorded pricing variant.

A generation without `persist` stays ungated: the living `req~generator-pure-function~1` serves it to anyone,
anonymous callers included, and it writes no instance, so `generatedInstances` ("instances the generator writes") is not
concerned; the generator's own request bounds apply. Its solver part, if any, is a run and is gated only when the
generation is persisted.

The effective time budget of a built-in run is `min(requested or default, maxRunMinutes, ENGINE_SOLVE_TIMEOUT_S)`. Today
`access/policy.py` answers 503 `pricing_misconfigured` when a plan ceiling exceeds the technical timeout; with pricing
0.2.0 LAB (`maxRunMinutes` 1440) is above the 1800 s default, so for the time budget the plan ceiling becomes a clamp,
never a misconfiguration (D8). The payload ceiling rule is not touched.

## 4. Verification against the active pricing

SPACE is the authority for the active pricing, and `space-python-client` 1.0.0 offers no service or pricing read
(m41-space-bootstrap design.md §4), so the map is verified against the pricing context of the contract's pricing token
(`pricingContext.features` and `pricingContext.usageLimits`, the claims `SpacePricingGate.caps` already reads). With the
`all_last` policy a contract is migrated to the active version, so its token is the active pricing for that account.

- Checked when a token is read from SPACE (never from cache), before it is cached; the cache key carries the contract's
  pricing version. A token that lacks a mapped id, or has a feature that is not a boolean or a limit that is not a
  number or `null`, makes every gated operation of the contract answer 503 `pricing_misconfigured` and logs
  `plans.map_mismatch` with the missing ids and the version.
- `null` is SPACE's encoding of `.inf`. With `SPACE_NULL_LIMIT_IS_UNKNOWN=true` the adapter drops a `null` limit
  (`space.py`), so the map check sees it as missing and every gated operation of a RESEARCH or LAB contract answers 503
  `pricing_misconfigured`: fail closed, as that setting intends. Whether the setting is still needed once SPACE 1.7.1 is
  measured is a followup.
- ARCHITECTURE §9.2 says "at start-up and on `pricing_activated`". At start-up the gateway has no contract to read
  without creating one, so the start-up check is replaced by the first read per contract and version, and the event
  check by the cache invalidation of §8 (the next read re-verifies). Alternative left to the owner: a probe contract
  for a fixed synthetic id, read at start-up (§11, D2).
- Unit tests verify the map against the recorded pricing `docs/pricing/openbinding-0.2.0.yml` (16.6).

## 5. Admission

Order inside the use case, for each gated operation: (1) role and API-key checks (unchanged); (2) idempotent replay
returns the stored resource (no evaluation); (3) feature from the cached or fresh token: `false` → 403
`feature_not_entitled`; (4) ceilings and counted limits (§7) → 402 or the clamp; (5) concurrency (plan, then the
technical cap) → 429; (6) for consumed limits, `features.evaluate(user_id, feature_id, expected_consumption=
{"<service>-solverHours": hours})` (or `generatedInstances`), awaited; negative → 402 `usage_limit_exceeded`; (7) the
resource is stored and committed; (8) dispatch after commit.

- `hours = ceil(effective_budget_ms / 1000) / 3600`: the effective budget of §3 (after defaults, `maxRunMinutes` and the
  technical timeout), rounded up to whole seconds. Pricing 0.2.0: "each run counts its time budget when it starts".
- A negative result that carries SPACE's `error` field, a timeout or a transport error is not a usage refusal: it is
  503 `pricing_unavailable`, and no revert is sent (§6).
- The 402 body is the existing `usage_limit_exceeded` refusal of `domain/usage_counters.py`:
  `quota: {limit_id, state: "exhausted", unit, source: "space", limit?, used?}` (`limit` and `used` when the evaluation
  result carries them). `usage_counters.job_start_refusal` and `usage_refusal("studyRuns")` stop being called in
  S3; the module is deleted in M4.3.
- A negative evaluation without `error` on a feature the token grants is read as an exhausted usage level; the `error`
  field (UNVERIFIED shape) is logged by code only.
- Study runs: each cell is admitted when it is launched, not when the study run is created; a refused cell is recorded
  failed with `usage_limit_exceeded` and the rest of the run goes on (§11, D6). An unreadable plan at cell launch keeps
  today's behaviour (the cell waits and is retried).

## 6. Revert

- Only for an admission whose evaluation carried an expected consumption (built-in runs and cells, solver parts,
  persisted generations); federated runs and other gated operations send no consuming evaluation and never revert.
- Sent (once, `features.revert_evaluation(user_id, feature_id, revert_to_latest=True)`) when: the commit of step 7
  fails; the run reaches a terminal state with no claim (`claim_job` never succeeded: cancelled while `queued`, failed
  by the reconciler with `queue_timeout`); or a persisted generation fails with no instance written. All are subject
  to the 120 s window below: `QUEUE_TIMEOUT_S` is at least 60 s and 1800 s by default, so with the default a
  `queue_timeout` end always falls outside the window and only logs `plans.revert_failed` (`window_expired`).
- Not sent when publication to the queue fails after the commit: the row stays `queued` and the reconciler republishes
  it (`job_dispatch.py`; `req~job-execution-accepted-202~1`: "the job row exists even if Redis is unavailable"), so the run may still execute.
- Not sent when the evaluate call has no answer or answers with an error (503): SPACE may not have recorded it, and a
  revert of the latest evaluation could then undo an earlier, claimed run's consumption. Accepted risk: an evaluation
  that SPACE did record before the timeout stays consumed (at most one budget per timeout).
- Not sent once an engine has claimed the run (cancellation, engine error, early end, result): no refund, so the
  monthly count can be checked against the budgets (ARCHITECTURE §9.2).
- SPACE honours a revert within two minutes of the evaluation. The gateway keeps the evaluation time with the pending
  operation (in memory for steps 6-8; on the job row for later failures, the existing `created_at` is enough because
  evaluation and creation are seconds apart). After 120 s, or when the call fails, it logs `plans.revert_failed`
  (`user_id`, `feature`, `age_s`, `reason` `window_expired` | `space_error`, the error type) and never retries.
- Risk: `revert_to_latest` reverts the latest evaluation of that feature for that user. Two concurrent admissions of the
  same feature by one account can revert the other one's evaluation; with budgets that differ, the monthly count drifts
  by the difference. `maxConcurrentRuns` 1 on FREE makes it rare; the contract suite measures it (§12).

## 7. Counted limits

| Limit | Count | Owner of record | Refusal |
|---|---|---|---|
| `maxProblems` | problems not deleted (public, private, withdrawn) | the account, or the organization's owner of record | 402 `quota_exceeded` |
| `maxCollections` | collections not deleted | same | 402 `quota_exceeded` |
| `maxRepositoryStorage` | stored bytes of every version of those problems and collections, 1 MB = 1 000 000 bytes | same | 402 `storage_quota_exceeded` |
| `maxPrivateProjects` | private projects of the organizations whose owner of record is the account | organization's owner of record | 402 `quota_exceeded` |
| `maxFederatedEngines` | active registrations of the owner | the registering account (today's rule) | 402 `quota_exceeded` |
| `maxApiKeys` | keys not revoked | the account | 402 `quota_exceeded` |
| `maxConcurrentRuns` | runs `queued` or `running` (direct, cells, generator runs) | the submitting account | 429 `concurrency_limit_exceeded` |
| `maxStudyCells` | cells of one study run | — | 402 `quota_exceeded` |
| `maxInstancesPerGeneration` | instances of one request | — | 402 `quota_exceeded` |
| `maxRunMinutes` | budget of one run | — | clamp, `OPTION_CLAMPED` |

- Owner of record: the account itself for personal work; for organization work, the account whose plan the
  organization counts against (today `billing_sponsor_user_id`, set to the creator at creation). When M4.3 retires the
  sponsorship proposals the column stays as the owner of record; renaming it is that change's decision.
- Counts are taken in the transaction that writes, with the account row locked (`FOR UPDATE`), as for API keys and the
  technical concurrency cap; SQLite has no row locks (IDEMPOTENCY.md).
- Every 402 body is `quota: {limit_id, state: "exhausted", unit, source: "plan", limit, used}`, the shape
  `engine_registry.py` already sends; `unit` is the pricing's (`problem`, `collection`, `MB`, `project`, `engine`,
  `key`, `cell`, `instance`).
- `.inf` (token `null`) skips the count. FREE is the only plan of 0.2.0 with finite repository limits.

## 8. Events, caches and the relay

- `client.on(event, callback)` for `synchronized`, `pricing_created`, `pricing_actived` (spelled so in the client README;
  the client may also accept `pricing_activated`, UNVERIFIED), `pricing_archived` and `service_disabled`, then
  `await client.connect()` in the lifespan; `remove_all_listeners()` and close on shutdown (names checked offline, §12). An event whose service is not
  `SPACE_SERVICE_NAME` is ignored (payload shape UNVERIFIED).
- On an event: the plans caches of the service (tokens, caps; Redis cache provider of the client, plus any in-process
  memo) are dropped before the next decision, then `plans.changed` is published in process.
- Each gateway process holds its own subscription and relays to its own streams; invalidating the shared Redis cache
  twice is harmless.
- While the socket is down (not yet connected, dropped, reconnecting with backoff 1 s to 60 s), cached entries older than
  60 s are not used.
- Active version. `space-python-client` 1.0.0 has no service or pricing read (§4) and the module makes no direct HTTP
  call to SPACE (§2, 16.1), so `PlanPort.active_version() -> str | None` answers from memory only: the pricing version
  carried by the last `pricing_actived` event of `SPACE_SERVICE_NAME` that this process received on its current
  connection. The client passes the server message's `details` object to the callback as is (client source,
  `_base_client.py`); the version is read from its field `pricingVersion` (name UNVERIFIED: the client defines no shape
  for `details`; the S8 contract suite confirms or corrects it, a design fix). `synchronized` carries no payload and
  leaves the value as it is. A SPACE service can hold several active versions (m41-space-bootstrap design.md §4,
  step 6, "the newest active version"), so a `pricing_created` or `pricing_archived` of the service may change which
  one is active without a `pricing_actived`; both reset the value. The value is `None`: until the first such event
  after start-up; after a `pricing_actived` event whose `details` has no non-empty string in that field (the previous
  value is dropped, never kept or guessed); after `pricing_created`, `pricing_archived` or `service_disabled`, until the
  next `pricing_actived`;
  from the moment the connection drops until the first `pricing_actived` after it is re-established (events may have
  been missed); and always with `OpenGate`. It is synchronous, never calls SPACE, never raises and is per process, like
  the subscription. A gateway that has just started therefore reports `None` until SPACE activates a version; M4.3's
  `spaceActiveVersion` is `null` then (its "any failure gives `null`"). If the contract suite shows that `details`
  carries no version, the method keeps returning `None` until a client release offers a read, and this paragraph and
  `req~plans-active-version~1` are revised.
- `GET /v1/plans/events`: authenticated like `GET /v1/jobs/{id}/events` (session or API key; 401 otherwise). An API key
  needs the permission `account:read`; one without it gets 403 `insufficient_api_key_permission`. `required_permissions`
  in `security/apikeys.py` classifies the route by the exact path `/v1/plans/events` (`path == "/v1/plans/events"`),
  never by a `/v1/plans` prefix: a prefix branch would run before the open-path check (`apikeys.py`, the
  `OPEN_V1_PREFIXES` / `OPEN_V1_GET_PATHS` test at the end of the function) and would close the anonymous
  `GET /v1/plans/pricing` of M4.3 to keys without that permission. Without a branch the route would fall to
  `route:unclassified` and be closed to every API key. `text/event-stream`, `Cache-Control: no-store`, messages `event: plans.changed` with data
  `{"event": "<space event>", "at": "<ISO 8601>"}`, a comment heartbeat every 25 s, closed by the server after 30 minutes
  (the browser reconnects). Delivery within 5 s of the event's arrival. No per-user data.
- The 401 of `GET /v1/plans/events` is a `Problem` body (ADR-0011) with media type `application/problem+json`, as are
  the other errors of the `/v1/plans` prefix (`m43-plans-pricing-route` design.md §4.3). The first slice that adds a
  `/v1/plans` route, S5 here or S1 of M4.3, whichever lands first, adds `/v1/plans` to `_BIM_PATH_PREFIXES` in
  `main.py` (or the shared predicate M4.3 describes) and the prefix to `docs/ERRORS.md` §"Media type"; the other slice
  finds it done and only checks it.
- The contract suite of S8 exercises these subscriptions with the bootstrap's `MANAGEMENT` key
  (`PLANS_CONTRACT_SPACE_API_KEY`); where that key lives is decided by `docs/design/m45-lab-space.md` §1.4, and the suite
  runs only where the key is available (§9).

## 9. Fail closed, open gate, contract suite

- SPACE errors are already mapped to `PricingUnavailable` at one seam (`SpacePricingGate._call`); every gated
  operation (the 14 rows of §3, and only those) turns it into 503 `pricing_unavailable` before writing. The gateway
  starts while SPACE is down; public reads, the authentication of API keys and the ungated routes keep working (D15),
  except the plan-administration routes of §3, which read SPACE themselves; the next gated call retries SPACE (no
  circuit state kept).
- `OpenGate` gains `evaluate` (always positive, nothing recorded), `revert` (no-op), `subscribe` (no-op) and
  `active_version` (always `None`; it lands in S5 with the port method, the others in S7).
  `open_limits` today declares none of the 0.2.0 ids, and a missing limit reads as 0 (`PlanCaps.limit`), so S7 extends
  it: every limit of the map is `inf`, except `maxRunMinutes` = `ENGINE_SOLVE_TIMEOUT_S / 60` and `maxConcurrentRuns` =
  `MAX_CONCURRENT_JOBS_PER_USER`, and every feature of the map is listed in `OPEN_FEATURES`. Technical caps apply.
  `APP_ENV=prod` still refuses it.
- Contract suite: `openbinding-gateway/tests/contract/test_plans_space_contract.py`, marker `space_contract`, run only
  when `PLANS_CONTRACT_SPACE_URL` and `PLANS_CONTRACT_SPACE_API_KEY` are set (excluded from the default `pytest` run, so
  16.6 holds). It uses its own test account id (`uuid5(SEED_NAMESPACE, "contract:plans")`), removes its contract at
  the end and reads the usage from the token's `subscriptionContext` (UNVERIFIED claim name).
- `PLANS_CONTRACT_SPACE_API_KEY` is the bootstrap's `MANAGEMENT`-scoped key: the suite creates and removes contracts,
  evaluates and reverts, the calls for which the plans module needs a `MANAGEMENT`-scoped key (ARCHITECTURE §9.2). Where that key lives is decided by `docs/design/m45-lab-space.md`
  §1.4 (owner question 3 of m41-space-bootstrap; recommendation: a read-only volume `lab-pricing-key`), not by this
  change; the suite runs only where that key is available (a process that can read it), and the registered lab check of
  S8 is placed accordingly.
- Prerequisite outside this change: the lab `pricing` profile reachable from where the suite runs, with the bootstrap's
  `MANAGEMENT` key available to it (above); the compose wiring of
  `pricing-bootstrap` and of the `space-api` build (m41-space-bootstrap design.md §7). The SPACE-stopped scenario needs a
  gateway wired to the lab SPACE (M4.5); until then it runs with a gateway started by the suite in process.

## 10. Errors

| Situation | Status, code |
|---|---|
| feature `false` in the plan | 403 `feature_not_entitled` |
| map not satisfied by the contract's pricing | 503 `pricing_misconfigured` |
| SPACE unreachable, error, timeout | 503 `pricing_unavailable` |
| `solverHours` / `generatedInstances` spent | 402 `usage_limit_exceeded`, `quota.source` `space` |
| counted limit reached | 402 `quota_exceeded` (`storage_quota_exceeded` for storage), `quota.source` `plan` |
| plan concurrency reached | 429 `concurrency_limit_exceeded`, `Retry-After: 15` |

All codes exist; no new code is introduced. The only new route is `GET /v1/plans/events`.

## 11. Decisions taken from the accepted CRP (verify against the CRP text)

The owner accepted every proposal of `crp-ob-m4-plans-decisions`. Without its text, each choice below was made to be
consistent with ADR-0015, ARCHITECTURE §9 and ROADMAP M4; the lead checks each one against the CRP.

- D1. New capability `plans`; three MODIFIED requirements in `auth-roles-entitlements` (§1).
- D2. The map is verified per contract against its pricing token, not at start-up; no probe contract (§4).
- D3. Consumption is evaluated at admission, before the resource is stored; `solverHours` is the effective budget rounded
  up to whole seconds; `generatedInstances` is the number requested (§5). Deviation from ARCHITECTURE §9.2 ("consumes
  the instances it writes"): the two are equal for a generation that succeeds, and differ only after a partial failure
  (D4); followup to ARCHITECTURE once the lead confirms.
- D4. No refund once an engine has claimed a run; a generation that wrote any instance is not reverted, so a partial
  generation keeps the requested count (§6).
- D5. Revert only within 120 s, once, never retried; failures are logged as `plans.revert_failed`; no revert after an
  evaluation that timed out or answered with an error, and none on a dispatch failure the reconciler recovers (§6).
- D6. Study cells are admitted one by one at launch; a cell refused for usage fails with `usage_limit_exceeded` and the
  run goes on; cells over `maxConcurrentRuns` wait (§5, §7).
- D7. `maxConcurrentRuns` counts `queued` and `running` runs, like the technical cap, and both caps apply; the refusal is
  the existing 429 (§7).
- D8. `maxRunMinutes` clamps with `OPTION_CLAMPED` instead of refusing; it and `solverHours` apply to built-in engines
  only; a plan ceiling above `ENGINE_SOLVE_TIMEOUT_S` is clamped to the timeout, not answered with
  `pricing_misconfigured` (§3).
- D9. Repository and private-project limits count against the owner of record (the account, or the organization's
  `billing_sponsor_user_id`); storage counts every version, 1 MB = 10^6 bytes (§7).
- D10. Refusal codes are the existing ones, with the existing `quota` object (§10).
- D11. The relay is a new authenticated stream `GET /v1/plans/events` (§8), not the notification inbox.
- D12. While the event socket is down, cache entries live at most 60 s (§8).
- D13. Contract suite opt-in by environment, marker `space_contract`, its own synthetic account (§9).
- D14. Only generations with `persist: true` are gated; a generation that persists nothing stays open to anyone, as the
  living `generator` capability specifies (§3).
- D15. Authenticating a request with an API key is not gated by the plans module: `apiAccess` gates only the creation
  of a key, together with `maxApiKeys`. API-key authentication and public reads never depend on SPACE and never fail
  because SPACE is down; `plans-fail-closed` covers the 14 gated operations of §3 only, and the plan-administration
  routes listed in §3 keep their own SPACE dependency (§3, §9). To verify
  against the accepted CRP: if it gates every API-key request on `apiAccess`, that is a revision of
  `plans-entitlement-map` and `plans-fail-closed`.

## 12. Risks and open questions

- UNVERIFIED against SPACE 1.7.1 and `space-python-client` 1.0.0 (README of the main branch, medium confidence, lookup of
  2026-10-26; sources: `https://github.com/Alex-GF/space-python-client`, `https://pypi.org/pypi/space-python-client/1.0.0/json`):
  the keys of `expected_consumption`, decimals in `solverHours`, the evaluation result fields, the event payloads
  (among them the field `pricingVersion` of the `pricing_actived` `details` that `active_version` reads, §8, and which
  events a synchronization that adds a pricing version emits and whether they carry the version: if it emits no
  `pricing_actived`, `active_version` stays `None` after it) and the `subscriptionContext` claim. The contract suite (S8) proves or corrects them; a correction of a name is a design
  fix, of a behaviour a revision of the requirement.
- Checked offline by `openbinding-gateway/tests/test_space_client_contract.py` against the installed client (names and
  parameters only): the event name `pricing_actived`, `AsyncSpaceClient.remove_listener` and
  `AsyncSpaceClient.remove_all_listeners`, `evaluate(user_id, feature_id, expected_consumption=...)` and
  `revert_evaluation(user_id, feature_id, revert_to_latest=True)`, both bound by keyword. Payload shapes and server
  behaviour remain UNVERIFIED until the contract suite runs.
- `active_version` (§8) is `None` after every start-up and reconnection until SPACE activates a version, which can be
  weeks; M4.3 shows `spaceActiveVersion` `null` meanwhile. Accepted rather than reading SPACE over HTTP (16.1) or
  guessing from a contract's token (a token gives that contract's version, not the service's). To confirm with the
  lead, with the API-key permission `account:read` of `GET /v1/plans/events` (§8), which no CRP choice names.
- UNVERIFIED: how SPACE compares an evaluation with its limit. ARCHITECTURE §9.2 does not fix the rule, and the pricing
  expressions (`subscriptionContext['solverHours'] < pricingContext['usageLimits']['solverHours']`, the same for
  `generatedInstances`) compare the usage already recorded with a strict `<`, which admits an evaluation while
  `used < limit` even if `used + expected` exceeds the limit; SPACE may instead refuse when `used + expected` exceeds
  it. The scenarios of `plans-usage-exhausted` and `plans-generation-admission` therefore use levels already reached
  (FREE: 5 of 5 `solverHours`, 1000 of 1000 `generatedInstances`), which both readings refuse. The case "used +
  expected exceeds the limit while used is below it" is left to the contract suite (S8); its result is recorded in
  `docs/qa/PRICING_PROFILE.md`, and a rule that matters to callers becomes a scenario in a revision of those
  requirements.
- `SPACE_PRICING_VERSION` (gateway setting) versus the lab's `DEMO_SPACE_PRICING_VERSION` (the compose files map the
  second onto the first): M4.2 owns the decision whether the gateway keeps the setting, now that contracts follow the
  active version (`all_last`, §4) and M4.3's route no longer reads it, and how the lab variable follows. To check with
  it: a new version activated in SPACE does not break contracts pinned to `0.2.0` (UNVERIFIED, to confirm in the
  contract suite, S8).
- `revert_to_latest` and concurrent admissions (§6); a timed-out evaluation that SPACE recorded stays consumed (§6); a
  run that ends with `queue_timeout`, or is cancelled more than 120 s after its evaluation, keeps its budget consumed
  although it never ran (the two-minute revert window of SPACE).
- A pricing version that SPACE activates for some contracts before others: during the migration two accounts can see
  different limits for a few minutes (all_last, five-minute cycle).
- Public API: `GET /v1/plans/events` is an addition to `docs/openapi.json` (S5); the owner's accept-all is taken as its
  approval, to be confirmed with D11.
- Owner of record before M4.3 settles the sponsorship column (D9).

## 13. Requirements and slices

| Requirement | Slice |
|---|---|
| `plans-single-space-seam`, `auth-roles-entitlements-plan-reads` ~2 | S1 move |
| `plans-entitlement-map`, `plans-map-verified`, `plans-feature-refusal` | S2 map |
| `plans-solver-hours-admission`, `plans-generation-admission`, `plans-usage-exhausted`, `auth-roles-entitlements-no-metering` ~2 | S3 admission |
| `plans-repository-limits`, `plans-private-projects-limit`, `plans-request-size-limits`, `plans-run-budget-ceiling`, `plans-concurrent-runs`, `auth-roles-entitlements-api-key-quota` ~2 | S4 counts |
| `plans-event-cache-invalidation`, `plans-event-relay`, `plans-cache-bound-without-events`, `plans-active-version` | S5 events |
| `plans-revert-on-failure`, `plans-revert-failed`, `plans-no-refund-after-start` | S6 revert |
| `plans-fail-closed`, `plans-open-gate` | S7 fail-closed |
| `plans-contract-suite` | S8 contract tests |

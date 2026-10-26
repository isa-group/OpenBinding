# Change: m42-plans-module

## Why

ROADMAP M4.2: "`plans` module over `space-python-client` (existing gate moved): entitlement map of pricing 0.2.0
verified against the active pricing, solver hours and generated instances consumed at admission, other limits
(repository limits of FREE included) against the gateway's own counts, event relay, revert on failure". Acceptance:
"contract tests against the lab profile; fail-closed when SPACE is down". It serves the M4 goal (OpenBinding behaves
like the TomatoMeter host application: the pricing lives in SPHERE, SPACE operates it, OpenBinding adapts without
redeploying) and implements ADR-0015 §2 and §6, `docs/ARCHITECTURE.md` §9.2 and constitution Article 16. The owner
answered the CRP `crp-ob-m4-plans-decisions` with `accept-all` (own-7153cec8d5a447fa909601bc7ad8fe4d); design.md §11
lists the choices taken from it.

## What Changes

- The SPACE gate (`openbinding-gateway/src/openbinding_gateway/space_client/`) moves into
  `openbinding_gateway/modules/plans/`, the only gateway code that imports `space-python-client`.
- One entitlement map names, per gated operation, the pricing 0.2.0 feature and limits it is checked against, and is
  verified against the pricing context of each contract; a missing feature or limit fails closed with 503
  `pricing_misconfigured`.
- A run on a built-in engine consumes its time budget in `solverHours`, and a persisted generation consumes the
  instances it asks for in `generatedInstances`, through a SPACE evaluation at admission (402 `usage_limit_exceeded`
  when spent). An operation that is not stored, ends before an engine claims it, or writes no instance reverts its
  evaluation.
- The other ten limits of pricing 0.2.0 (`maxProblems`, `maxCollections` and `maxRepositoryStorage` for FREE among
  them) are compared with the gateway's own counts.
- SPACE events invalidate the plans caches and reach signed-in browsers as `plans.changed` on the new stream
  `GET /v1/plans/events`.
- SPACE down means 503 `pricing_unavailable` for every gated operation, and a contract suite runs the plans module
  against the lab `pricing` profile.

## Impact

- Capabilities: `plans` (new, 21 ADDED requirements) and `auth-roles-entitlements` (3 MODIFIED: `api-key-quota` ~2,
  `plan-reads` ~2, `no-metering` ~2). Two capabilities because the three living requirements contradict pricing 0.2.0
  and ADR-0015 (`apiKeys` is now `maxApiKeys`; the platform runs a pinned SPACE; SPACE now tracks two usage levels);
  leaving them would make the living specs contradict each other (design.md §1).
- Code (later slices, tasks.md): `space_client/*` moved to `modules/plans/`; `services/entitlements.py`,
  `access/policy.py`, `services/job_submission.py`, `routes/jobs.py`, `routes/studies.py`, `study_jobs.py`, the
  generator routes, the repository, project and API-key routes, `core/settings.py` and `main.py` (lifespan) adapt;
  `domain/usage_counters.py` stops being called at admission (it is deleted in M4.3).
- HTTP API: one new route, `GET /v1/plans/events` (`text/event-stream`, authenticated); every 402 carries the
  `quota` object the gateway already sends for federated engines (`limit_id`, `state`, `unit`, `source`, `limit`,
  `used`), now also for API keys and the new count limits; the codes `usage_limit_exceeded`, `quota_exceeded`, `storage_quota_exceeded`,
  `concurrency_limit_exceeded`, `feature_not_entitled`, `pricing_unavailable` and `pricing_misconfigured` already
  exist. `docs/openapi.json` changes in the slices S4 and S5 only; the module move (S1) keeps it byte-identical.
- No database migration. No compose change; wiring the gateway to the lab SPACE is a prerequisite of the contract
  suite (design.md §9).
- Risks: the SPACE 1.7.1 evaluation, revert and event shapes are UNVERIFIED until the contract suite runs (design.md
  §12); `revert_evaluation` reverts the latest evaluation of a feature, which two concurrent admissions can confuse.

## Out of scope

- `GET /v1/plans/pricing`, the SPHERE `PricingSource`, and the removal of `sphere_client.py`, `pricing_catalog.py`,
  the deprecated pricing routes, the release sweeps, `domain/usage_counters.py` and the sponsorship capacity checks
  (M4.3).
- Browser side: `space-react-client`, `FeatureGate`, the Pricing and Plan pages, and consuming `plans.changed`
  (M4.4).
- Lab and previews on the local SPACE by default (M4.5); switching to `space.score.us.es` (M4.6).
- Plan changes, registration contracts and CAS eligibility: they move with the gate unchanged.
- Any change to `docs/pricing/openbinding-0.2.0.yml` or to SPHERE.

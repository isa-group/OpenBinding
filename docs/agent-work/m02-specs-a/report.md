# M0.2 — requirement length, specs job-execution, auth-roles-entitlements, qacobench-experimentation, studies-analysis, gateway-api

## Method

- Rule: the body of each `### Requirement:` (EARS sentence, id line, Evidence line; blank lines excluded) must be at most
  500 characters; target 450.
- No `openspec` binary: lengths were counted by hand and the final state was checked with a multiline search over the
  five files (`### Requirement: …` followed by more than 450 characters before the next `#`, which covers the body plus
  six line breaks). Result after the edit: 0 requirements above 450 (before the edit: 36 of 42 above 450, 25 above 500).
- Constitution: the revision rule is article 1.3 ("a changed requirement MUST bump its revision"); articles 15–16 deal
  with rendering and external platforms and say nothing about revisions. Followed 1.3.
- Only the Evidence lines (and two lists of examples) were shortened. No requirement changed meaning, so no revision
  was bumped, nothing was split and no id changed. Hence no `[impl->…]` or `[utest->…]` tag needs to change (none of
  the ids below was renamed; the tags that exist, for `gateway-api-*-origin-*`, refer to requirements that were not touched).
- All scenarios are unchanged.
- "Before" is the class found by the search (>500 / 451–500 / ≤450); "after" is the hand count (±5).

## Table

| Requirement | Before | After | Id before = id after |
|---|---|---|---|
| job-execution: Idempotency key per account | >500 (≈730) | ≈414 | `req~job-execution-idempotency-key~1` |
| job-execution: Technical concurrency cap | >500 | ≈372 | `req~job-execution-concurrency-cap~1` |
| job-execution: Single current execution | 451–500 | ≈353 | `req~job-execution-single-claim~1` |
| job-execution: Recovery of lost workers | >500 | ≈349 | `req~job-execution-lease-recovery~1` |
| job-execution: Authoritative re-evaluation | >500 | ≈425 | `req~job-execution-authoritative-reevaluation~1` |
| job-execution: Engine evidence kept on evaluation failure | >500 | ≈334 | `req~job-execution-evidence-retention~1` |
| job-execution: Cancellation | >500 | ≈407 | `req~job-execution-cancellation~1` |
| job-execution: Failed jobs show catalog sentences only | >500 | ≈396 | `req~job-execution-failure-catalog~1` |
| job-execution: Only owners and members act on jobs | >500 | ≈430 | `req~job-execution-actor-authorization~1` |
| gateway-api: Documented operations | 451–500 | ≈307 | `req~gateway-api-documented-operations~1` |
| gateway-api: Uniform problem document | >500 | ≈370 | `req~gateway-api-problem-document~1` |
| gateway-api: Body size limits | >500 | ≈431 | `req~gateway-api-body-limit~1` |
| gateway-api: Insecure production configuration refused | >500 | ≈349 | `req~gateway-api-production-guards~1` |
| gateway-api: Login throttling | >500 | ≈365 | `req~gateway-api-login-throttle~1` |
| auth: Open registration on the default plan | >500 | ≈338 | `req~auth-roles-entitlements-registration~1` |
| auth: Rotating refresh tokens | 451–500 | ≈337 | `req~auth-roles-entitlements-refresh-rotation~1` |
| auth: API keys shown once and stored hashed | >500 | ≈303 | `req~auth-roles-entitlements-api-key-secrecy~1` |
| auth: Key permissions never widen the role | 451–500 | ≈311 | `req~auth-roles-entitlements-key-and-role~1` |
| auth: Organization roles and owner-only changes | >500 | ≈429 | `req~auth-roles-entitlements-org-roles~1` |
| auth: Platform administrators get no tenant access | 451–500 | ≈346 | `req~auth-roles-entitlements-admin-separation~1` |
| auth: CAS identities linked only explicitly | >500 | ≈304 | `req~auth-roles-entitlements-cas-linking~1` |
| auth: Entitlements from the plan service | >500 | ≈429 | `req~auth-roles-entitlements-plan-reads~1` |
| auth: No metering | 451–500 | ≈341 | `req~auth-roles-entitlements-no-metering~1` |
| studies: Deterministic, bounded study matrix | >500 | ≈340 | `req~studies-analysis-deterministic-matrix~1` |
| studies: Explicit engine choice per study | 451–500 | ≈274 | `req~studies-analysis-explicit-engine~1` |
| studies: One job per cell | 451–500 | ≈315 | `req~studies-analysis-one-job-per-cell~1` |
| studies: Cancelling a run | >500 | ≈356 | `req~studies-analysis-run-cancellation~1` |
| studies: Honest neighbourhood analysis | 451–500 | ≈322 | `req~studies-analysis-neighbourhood~1` |
| studies: Analysis work permissions and attempts | >500 | ≈414 | `req~studies-analysis-task-permissions-attempts~1` |
| qacobench: Resumable campaign by identity | 451–500 | ≈411 | `req~qacobench-experimentation-resume-identity~1` |
| qacobench: Run manifest | >500 | ≈439 | `req~qacobench-experimentation-run-manifest~1` |
| qacobench: Capability rejections are data | >500 | ≈443 | `req~qacobench-experimentation-incompatible-is-data~1` |
| qacobench: Contradicted verdicts refuse the campaign | >500 | ≈366 | `req~qacobench-experimentation-contradiction-refusal~1` |
| qacobench: Data outside Git | 451–500 | ≈404 | `req~qacobench-experimentation-data-outside-git~1` |
| qacobench: Reproducible QFBS generation | >500 | ≈417 | `req~qacobench-experimentation-qfbs-generation~1` |
| qacobench: Historical ICSOC optimum reproduced | >500 | ≈424 | `req~qacobench-experimentation-icsoc-regression~1` |

Not touched (already ≤450): job-execution accepted-202; gateway-api openapi-snapshot, cors-production, health;
auth api-key-quota; qacobench stale-registration.

## What changed besides Evidence

- `job-execution-failure-catalog`: the sentence listed five example codes; it now lists two (`engine_rejected`,
  `lease_lost`). The catalog itself is unchanged and still the source of the other codes.
- `qacobench-experimentation`: the long GAP notes of `incompatible-is-data` and `icsoc-regression` moved to the TODO
  section of the spec; the Evidence lines keep a short GAP marker.

## Evidence references dropped (documentation only; the files exist and are named in most cases at file level)

Evidence lines now cite test files instead of every test function, and dropped references were: idempotency-key
`concurrency/test_jobs_idempotency_pg.py`; concurrency-cap none (file kept); lease-recovery `jobs/reconciler.py`;
authoritative-reevaluation `services/execution.py`; cancellation `test_concurrency_limit.py::test_cancelling_a_queued_job_frees_its_slot`;
failure-catalog `core/public_errors.py`; gateway problem-document `core/public_errors.py`; auth plan-reads
`test_architecture_layers.py`; org-roles `test_collaboration_platform.py`; qacobench run-manifest `test_qacobench.py::test_release_registry_and_seed_are_stable`,
data-outside-git `reference/1.1.1/checksums.json`, contradiction-refusal `reference/1.1.1/evaluation/acceptance.json`,
qfbs-generation `design_matrix.json`, icsoc-regression `README.md` and `experimentation/icsoc/README.md` (moved to TODO).

## Not done

- Nothing was run (`openspec validate --strict` is not available here); the 500-character claim rests on the hand count
  and the regex check above.

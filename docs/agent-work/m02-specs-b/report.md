# M0.2 — requirement length, specs engine-registry, engines-java, instances-snapshots, frontend-workspace, engine-protocol

Task: archive task on `openspec/specs/**` (CRP crp-openbinding-m02-m03-governance, option a). Goal: every
`### Requirement:` body (EARS sentence + id line + `Evidence:` line; blank lines and `**Key**:` lines not counted)
at most 500 characters, aiming at 450.

## Method and limits

- No `openspec` binary was available and no shell, so lengths were counted by hand, character by character
  (spaces and backticks included). The "before" and "after" figures are therefore estimates (about ±15). Run
  `openspec validate --strict --all` to confirm; NOT EXECUTED here.
- The long part of most bodies was the `Evidence:` line, not the sentence. Where a body was too long, the evidence
  was reduced to the test file (or class) instead of each test function, and a few secondary references were dropped
  (listed below). Sentences were kept, split or lightly reworded.
- Constitution: Articles 15 and 16 are about rendering and external platforms and say nothing about revisions. The
  rule that applies is Article 1.3: "A changed requirement MUST bump its revision (`~1` → `~2`); ids are never
  reused." Rule applied: a requirement whose observable behaviour narrows or moves gets a new revision; a pure
  reformulation or an evidence-only change keeps its revision; every behaviour split off gets a new unique id at `~1`.
- Search for the old ids outside `openspec/specs/**` (`req~<id>~` in code, tests, docs, changes): no matches, so no
  `impl`/`utest` tag points to an id that changed. Nothing in code or tests was edited.

## Table (characters, estimated)

| Spec | Requirement | Before | After | Id before | Id after |
|---|---|---|---|---|---|
| engine-registry | Authenticated discovery | ~294 | ~294 | `engine-registry-authenticated-discovery~1` | same |
| engine-registry | Destination policy | ~870 | ~395 | `engine-registry-destination-policy~1` | `engine-registry-destination-policy~2` |
| engine-registry | Pinned deployment connection (split from destination policy) | — | ~433 | — | `engine-registry-pinned-connection~1` (new) |
| engine-registry | Idempotent immutable registration | ~500 | ~401 | `engine-registry-immutable-registration~1` | same |
| engine-registry | Conformance before activation | ~650 | ~407 | `engine-registry-conformance~1` | same (reworded) |
| engine-registry | Credentials never disclosed | ~640 | ~417 | `engine-registry-credential-secrecy~1` | `engine-registry-credential-secrecy~2` |
| engine-registry | Embedded secrets refused (split) | — | ~291 | — | `engine-registry-embedded-secret~1` (new) |
| engine-registry | Private until approved | ~447 | ~447 | `engine-registry-private-until-approved~1` | same |
| engine-registry | Federated engine quota | ~472 | ~263 | `engine-registry-federated-quota~1` | same |
| engines-java | Canonical evaluator parity | ~640 | ~441 | `engines-java-canonical-evaluator~1` | same |
| engines-java | Java 8 bytecode | ~272 | ~272 | `engines-java-bytecode-target~1` | same |
| engines-java | Synchronous by default, asynchronous on request | ~620 | ~448 | `engines-java-job-mode~1` | same |
| engines-java | Cooperative cancellation | ~700 | ~342 | `engines-java-cooperative-cancel~1` | same |
| engines-java | Tenant-owned jobs | ~482 | ~340 | `engines-java-tenant-tokens~1` | same |
| engines-java | Pareto modes return a canonical archive | ~502 | ~440 | `engines-java-pareto-archive~1` | `engines-java-pareto-archive~2` |
| engines-java | Empty Pareto archive is unknown (split) | — | ~262 | — | `engines-java-pareto-unknown~1` (new) |
| instances-snapshots | Packages only as ZIP archives | ~487 | ~366 | `instances-snapshots-zip-only~1` | same |
| instances-snapshots | Hostile archives refused | ~536 | ~394 | `instances-snapshots-hostile-archives~1` | same |
| instances-snapshots | Compilation diagnostics | ~456 | ~377 | `instances-snapshots-compile-diagnostics~1` | same |
| instances-snapshots | Owner-scoped snapshot deduplication | ~625 | ~436 | `instances-snapshots-owner-dedup~1` | same |
| instances-snapshots | Snapshot visibility | ~700 | ~417 | `instances-snapshots-visibility~1` | same |
| instances-snapshots | Toolchain pin of stored IR | ~670 | ~428 | `instances-snapshots-toolchain-pin~1` | same |
| instances-snapshots | Plan complexity limit | ~418 | ~418 | `instances-snapshots-plan-complexity~1` | same |
| frontend-workspace | One registry for every screen | ~512 | ~292 | `frontend-workspace-route-registry~1` | same |
| frontend-workspace | Client-side guard | ~880 | ~446 | `frontend-workspace-client-guard~1` | same |
| frontend-workspace | Session resilience | ~650 | ~389 | `frontend-workspace-session-resilience~1` | same |
| frontend-workspace | Problem documents rendered per field | ~490 | ~313 | `frontend-workspace-problem-rendering~1` | same |
| frontend-workspace | Touch targets on phones | ~394 | ~394 | `frontend-workspace-touch-targets~1` | same |
| frontend-workspace | Visual hygiene | ~317 | ~317 | `frontend-workspace-hygiene~1` | same |
| frontend-workspace | Screens measured in the browser | ~541 | ~382 | `frontend-workspace-live-screen-checks~1` | same |
| engine-protocol | IR-only solve endpoint | ~517 | ~423 | `engine-protocol-ir-only~1` | same |
| engine-protocol | Refusal before work | ~590 | ~428 | `engine-protocol-refusal-before-work~1` | same |
| engine-protocol | Catalog-qualified candidate identity | ~510 | ~438 | `engine-protocol-qualified-identity~1` | same |
| engine-protocol | Asynchronous jobs | ~539 | ~386 | `engine-protocol-async-jobs~1` | `engine-protocol-async-jobs~2` |
| engine-protocol | Job isolation between tenants (split) | — | ~332 | — | `engine-protocol-job-isolation~1` (new) |
| engine-protocol | Optional cancellation extension | ~706 | ~418 | `engine-protocol-cancellation~1` | `engine-protocol-cancellation~2` |
| engine-protocol | Cancellation confirmation (split) | — | ~396 | — | `engine-protocol-cancel-confirmation~1` (new) |
| engine-protocol | Determinism under a seed | ~465 | ~381 | `engine-protocol-seeded-determinism~1` | same |
| engine-protocol | Honest termination | ~537 | ~440 | `engine-protocol-honest-termination~1` | same |

## Ids changed and where they were referenced

All of the bumped ids were referenced only inside their own spec file (no other file in the repository mentions them,
searched as `req~<id>~`), so no `impl`/`utest` tag needs updating:

| Old id | New id(s) | Reason | Outside references |
|---|---|---|---|
| `engine-registry-destination-policy~1` | `~2` + new `engine-registry-pinned-connection~1` | address pinning and no-redirect split off | none |
| `engine-registry-credential-secrecy~1` | `~2` + new `engine-registry-embedded-secret~1` | refusal of documents with a secret split off | none |
| `engines-java-pareto-archive~1` | `~2` + new `engines-java-pareto-unknown~1` | `UNKNOWN` on an empty archive split off | none |
| `engine-protocol-async-jobs~1` | `~2` + new `engine-protocol-job-isolation~1` | identical 404 for unknown and foreign ids split off | none |
| `engine-protocol-cancellation~1` | `~2` + new `engine-protocol-cancel-confirmation~1` | 202 `cancelling` and unchanged final state split off | none |

Scenarios: all existing scenarios were kept. Five scenarios were added so each new or narrowed requirement has at
least one (redirect from a deployment, token embedded in a registration, no feasible Pareto binding, completed job
polled twice, queued job cancelled); the "Another tenant polls a job" and "Cancel races completion" scenarios moved
to the requirements that now carry that behaviour.

## Evidence references dropped or generalised

Test-function references were replaced by their file or class, so the same tests are still pointed to, only less
precisely, in every requirement of the five specs where a long `Evidence:` line existed. References removed outright:

- engine-registry: `test_registering_twice_is_idempotent` (immutable registration); `probe.py` and
  `test_registration_conformance_rejects_unpinned_openapi` (now covered by the `test_registration_conformance_*`
  wildcard); `test_private_loopback_link_local_and_reserved_destinations_are_refused` (destination policy).
- engines-java: `RandomSearchCancelTest` (job mode); `ManyHeuristicCancelTest` (cooperative cancel).
- instances-snapshots: `test_jobs_reject_json_packages_in_favour_of_snapshots_or_zip` (ZIP only).
- engine-protocol: `engines/minizinc-csp/src/conformance.test.ts` from IR-only and refusal-before-work;
  `ManySearchTest` from honest termination.

## Round 1 panel fixes (base SHA 62d2d5e, PR head dc2e263 plus develop)

Counts re-estimated by hand after each change (maximum 500):

| Requirement | Finding | Change | Count now |
|---|---|---|---|
| `engine-registry-immutable-registration~1` | R1-REV-001 | Evidence adds `test_engine_registry_service.py` (file level: idempotence and 409) | ~463 |
| `engine-protocol-async-jobs~2` | R1-REV-002 | scenario replaced by "Cancelled job whose solver later returns" (job_manager.test.ts, EngineJobsTest, EngineHttpTest) | ~386 |
| `engine-registry-destination-policy~2` | R1-REV-003 | Evidence cites `test_engine_registry_service.py` at file level (covers loopback/link-local) | ~327 |
| `engine-protocol-cancel-confirmation~1` | R1-REV-004 | Evidence adds `engines/minizinc-csp/src/cancel.test.ts` | ~440 |
| `engine-registry-embedded-secret~1` | R1-REV-005 | scenario: `spec.extensions.apiToken`, answer 422 `secret_in_document` | ~291 |
| `instances-snapshots-zip-only~1` | R1-REV-006 | Evidence restores `test_jobs_reject_json_packages_in_favour_of_snapshots_or_zip` | ~489 |

The dropped-evidence list above is superseded for `test_registering_twice_is_idempotent`, the loopback/link-local
test and the JSON-package test, which are covered again. No other clause without a test was found on re-reading.

`openspec validate --strict --all`: NOT EXECUTED (exencion del propietario 24-10-2026).

## Not done / follow-up

- Hand-counted lengths must be confirmed with `openspec validate --strict --all` (NOT EXECUTED). The tightest bodies
  (estimated 440–448): private-until-approved, job-mode, client-guard, honest-termination, canonical-evaluator.
- Diff size is about 230 lines across the five specs, within the 300-line limit; all five specs are finished.

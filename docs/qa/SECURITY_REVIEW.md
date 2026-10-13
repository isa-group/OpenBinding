# Security review (bounded, 2026-10-13)

A bounded security review of the tree at SHA `5aebc7c8` was done on 2026-10-13.
This page records the findings and what happened to each. It is a summary of the
reviewer's report, not the report itself, and it is not a penetration test: no
exploitation against the running lab is recorded here. Finding identifiers (A1, M1,
B3, ...) are the reviewer's. The reviewer's file and line references were not
supplied to this page; the file references below were found by reading the tree
now and may move.

## Fixed in this SHA

| Id | Finding | Fix |
|---|---|---|
| A1 | Denial of service by integer exponentiation in `bim-core` expressions | `Limits.max_integer_bits` (default 1_000_000, env `BIM_MAX_INTEGER_BITS`) in `bim-toolchain/packages/bim-core/src/bim_core/settings.py`; larger results raise the `integer_limit` error (`expressions.py`). Tests: `test_expression_limits.py` |
| A2 | ZIP bomb in package uploads | Compression-method allow-list (STORED / DEFLATED only) and bounded reads, in `bim-core` and also in the gateway's own `integrations/packages.py`. Tests: `test_package_bomb.py` in both projects |
| M2 | Insecure flags accepted in production | `APP_ENV=prod` now refuses `BIM_SERVICE_ALLOW_INSECURE_HTTP=true` and `FEDERATION_REQUIRE_HTTPS=false` (`core/settings.py`, around line 383). Tests: `tests/test_prod_insecure_flags.py` |
| M3 | `/v1/analysis/pareto` and `/cancel` needed only `jobs:read` | Both now also require `engines:execute`, declared in the OpenAPI contract |
| B1 | `result.error` visible to a VIEWER | Redacted for VIEWER |
| B2 | Payload ceiling bypassed with a chunked body | The ceiling is enforced with chunked bodies too |
| B7 | Lab nginx appended to a client-supplied `X-Forwarded-For` | `frontend/nginx.lab.conf` sets it to `$remote_addr` in its proxy blocks |
| M1 | A VIEWER could launch `POST /v1/jobs` with an organization-shared snapshot | Decision: VIEWER is a read role. `require_work_role` (`security/roles.py`) needs MEMBER in the organization that shares the snapshot, checked in `services/job_submission.py` before the IR is read, the idempotency key is looked up or any row is written (`403 insufficient_role`; no role at all stays `404 not_found`). The same check guards `POST /v1/jobs/{id}/retry` and `/cancel` (`routes/jobs.py`) and `POST /v1/analysis/pareto` and its `/cancel` (`routes/analysis.py`) for jobs of an organization. Study and cell creation, runs, retries and cancellations already needed MEMBER. Personal work (own snapshot, `.bim.zip` upload, job with no organization) is unchanged. An API key needs both the role of its user and the scope of the route. Tests: `test_viewer_read_only.py` |
| M5 (partial) | Legacy `lab/nginx/default.conf` | File removed. The rest of M5 is pending, see below |
| M5 (rest, image) | Gateway image ran as root and installed an unpinned `uv` | Recorded as fixed by the separate hardening change (non-root `USER`, pinned `uv`), at the instruction of the owner of this task. This change does not touch the Dockerfile, and the tree it was made on still has the old one (`openbinding-gateway/Dockerfile:13`), so this entry holds only once that change is merged. The lab points of M5 below are still pending |

Whether each fix holds is only as verified as the tests named above; the final
verification checks of this change are reported separately.

## Pending: human decision required (not fixed)

| Id | Finding | State |
|---|---|---|
| M4 | Semantic equivalence of the BIM toolchain is not proven | The `bim-toolchain` CI exits 0 with a warning when there is no corpus, so it passes green without comparing anything. Goldens are generated from directories, while production compiles ZIPs. The difference in eligibility-list order between the directory and the ZIP IR was measured on 10 demo packages out of 82 only; changing it would be a MAJOR version change. 51 of the 82 packages were evaluated with a sample of 16 bindings |
| M5 (rest) | Lab hardening | The gateway image points (non-root `USER`, pinned `uv`) are recorded as fixed above. Still pending: real `SPACE_API_KEY` / `SPHERE_API_KEY` reach the container by lab design; the bind of `tools/` in `seed` is read-only, enforced by the supervisor and not by the repository |
| B3 | Lease loss | The old holder keeps waiting for the engine, and `_requeue` (`jobs/reconciler.py:83`) does not cancel the remote job. The late result is discarded. See [IDEMPOTENCY.md](../IDEMPOTENCY.md) |
| B4 | Re-evaluation failure | If bim fails during re-evaluation the job becomes FAILED and the engine's result is lost. See [IDEMPOTENCY.md](../IDEMPOTENCY.md) |
| B5 | Per-tenant limit in `bim-service` | It can be evaded by rotating `X-BIM-Tenant`; the global ceiling still holds |
| B6 | Internal error messages reach the user | For example `Execution failed: {exc}` (`services/execution.py:357`) and the reason returned by SPACE |
| B8 | Work in the event loop of `bim-service` | Not addressed |
| T1 | The 26 compose-shape checks in `tests/concurrency/test_pg_harness.py` are skipped in the lab PostgreSQL run | The `compose` fixture skips when `compose.pgtest.json` is not found (`test_pg_harness.py:48-49`); the file is not in the container. These checks (no ports, no `cap_add`/`privileged`, no docker socket, no real secrets, memory limits) are not enforced by that run. See [PG_HARNESS.md](PG_HARNESS.md) |

## Related, from `EXTRACTION_LOG.md`

`bim-service` has never been tested under load or memory pressure.

## Not covered

Anything outside the reviewer's bounded scope (the exact scope is not recorded
on this page). The remote SPACE / SPHERE services are not part of this tree.

# Joint status

State of the work that spans OpenBinding, the remote SPACE/SPHERE services and
the BIM extraction. "Done" means the change exists in this tree; it does not mean
it was exercised end to end. Written from reading the repository; I did not run
the test suites for this page.

| Area | State | Notes |
|---|---|---|
| Consumption accounting (credits, compute units, charging) removed | **Done** | Backend, frontend and compose. `tests/test_architecture_layers.py` forbids importing a `metering` module. Leftovers are listed under Known debt in [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Automatic Engine selection removed | **Done** | No replacement; a future component is a separate, later research project and is not documented as a feature |
| Job lifecycle (`claim_job`, 60 s lease / 20 s heartbeat, one requeue, sweep, study-cell resync, reconciler) | **Done** | `openbinding_gateway/jobs/`; guarantees in [IDEMPOTENCY.md](../IDEMPOTENCY.md) |
| Technical concurrency limit | **Done** | `MAX_CONCURRENT_JOBS_PER_USER`, `429 concurrency_limit_exceeded` (`jobs/limits.py`) |
| Layer tests | **Done** | `tests/test_architecture_layers.py`; five legacy modules still import `routes` |
| Documentation aligned with the above | **Done** (this change) | `README.md`, `docs/ACCOUNTS_AND_PLANS.md`, `docs/IDEMPOTENCY.md`, `docs/ARCHITECTURE.md`, `docs/BIM_CORE.md`, `docs/SPHERE_PLATFORM_INVENTORY.md`. `docs/openapi.json` was not touched and was not checked against the code |
| `bim-core` extracted into `bim-toolchain/` | **Done, not consumed** | Copy, not move; OpenBinding still uses `openbinding_gateway/v1` |
| `bim-service` (`/bim/v1`) and `bim-client` (`BimPort`) | **Not found in this tree** | Not described as available |
| BIM cut-over (OpenBinding depends on the toolchain) | **Pending** | Requires regenerating pinned digests; see [BIM_CORE.md](../BIM_CORE.md). Remote repository `javiercavlop/bim-toolchain` not created |
| Remote private pricing (development pricing and service, private, inside the shared organizations) | **Pending** | A shared organization does not isolate credentials; the development key is high-risk |
| Gateway code left over from the pricing-release workflow (`routes/pricing.py`, `space_client/deployments.py`, renewal sweeps) | **Pending removal** | Reachability not traced |
| Docker demo (full stack with remote SPACE/SPHERE) | **Pending** | `docker compose --profile dev up` is documented but not verified end to end for this state |
| Real PostgreSQL | **Pending** | Suite runs on SQLite; the harness in [PG_HARNESS.md](PG_HARNESS.md) has never been executed |
| End-to-end (browser + gateway + engines + remote services) | **Pending** | The recorded 2026-10-10 frontend run in [`frontend-qa/README.md`](../frontend-qa/README.md) predates this documentation change and was not repeated |

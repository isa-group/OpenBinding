Status: DRAFT for owner review (2026-10-21)

# REVIEW — how changes to OpenBinding are reviewed

The review panel judges a PR against its OpenSpec change, `constitution.md` and this file. Reviewers are always a
different agent/session from the implementer (preferably another model), read-only, and work from the diff, the
spec delta and the MRP draft. Paths below are relative to the repository root;
`GW = openbinding-gateway/src/openbinding_gateway`.

## 1. Risk areas

| Id | Area | Globs | Default risk |
|---|---|---|---|
| R1 | Auth, roles, API keys, visibility | `GW/routes/{auth,cas,users,admin,organizations,sponsor_proposals}.py`, `GW/access/**`, `GW/security/**`, `GW/collaboration.py`, `GW/cas.py`, `frontend/src/contexts/**`, `frontend/src/components/ProtectedRoute.tsx`, `frontend/src/routes/**` | high |
| R2 | Plans, entitlements, pricing display | `GW/services/entitlements.py`, `GW/domain/{entitlements,usage_counters}.py`, `GW/access/policy.py`, `GW/space_client/**`, `GW/sphere_client.py`, `GW/pricing_catalog.py`, `GW/routes/pricing.py`, `frontend/src/pages/Pricing/**`, `frontend/src/content/plans.ts`, `pricings/**` | high |
| R3 | Public API and schemas | `docs/openapi.json`, `GW/models/**`, `GW/routes/**`, `GW/core/public_errors.py`, `schemas/**`, `bim-toolchain/contracts/**` | high if breaking, else medium |
| R4 | Engine numeric semantics | `engines/**`, `GW/services/{execution,engines}.py`, `GW/v1/remote.py`, `schemas/bim/v1/manifests/**`, `bim-toolchain/packages/bim-core/src/bim_core/{evaluator,reevaluate,compat,protocol,compiler,expressions}.py` | high |
| R5 | Jobs, concurrency, idempotency | `GW/jobs/**`, `GW/job_dispatch.py`, `GW/worker.py`, `GW/services/job_submission.py`, `GW/domain/idempotency.py`, `GW/study_jobs.py`, `GW/analysis_jobs.py` | high |
| R6 | Persistence and migrations | `openbinding-gateway/alembic/**`, `GW/db/**`, `GW/repositories/**` | high |
| R7 | BIM boundary | `bim-toolchain/**`, `GW/integrations/**`, `openbinding-gateway/pyproject.toml`, `openbinding-gateway/uv.lock`, `openbinding-gateway/tests/test_bim_*` | high |
| R8 | Experiment reproducibility and data | `experimentation/**`, `datasets/**`, `examples/**`, `tools/check_bim_corpus.py`, `tools/package_zenodo.sh`, `engines/minizinc-csp/Dockerfile`, `engines/bim-generator/**`, `GW/generator/**` | medium (high for reference results or solver versions) |
| R9 | Frontend UX and accessibility | `frontend/src/**/*.{tsx,css}`, `frontend/e2e/**`, `frontend/index.html` | medium |
| R10 | Infrastructure and supply chain | `docker-compose.yml`, `compose.*.json`, `**/Dockerfile*`, `deploy/**`, `nginx/**`, `.github/**`, `**/uv.lock`, `**/pnpm-lock.yaml`, `**/pom.xml`, `**/package.json`, `up.sh`, `.env.example` | high |
| R11 | Governance | `INTENT.md`, `constitution.md`, `REVIEW.md`, `openspec/specs/**`, `.github/CODEOWNERS`, `.agentic/**`, `docs/adr/**` | owner approval required |
| R0 | Docs, tests only, internal refactors outside the globs above | everything else | low |

The highest-risk area touched sets the PR risk level.

## 2. Panel by risk

| Risk | Panel |
|---|---|
| low | reviewer (Sonnet high) |
| medium | reviewer (Opus) + test-reviewer; + security-auditor if the change handles external input (uploads, URLs, headers, archives) |
| high | reviewer (Opus) + test-reviewer + security-auditor + arch-reviewer; + perf-reviewer for R4/R5/hot paths; + ui-qa for R9 |
| R11 | owner review is required; agents may comment only |

Maximum two fix rounds; then the coordinator opens a CRP.

## 3. What each specialist checks in THIS codebase

**reviewer (correctness vs spec)**
- Every requirement in the delta spec has code and a test; EARS text matches behaviour; `GAP`s are not silently closed.
- Error paths answer `application/problem+json` with a stable `code` (new codes documented in `docs/ERRORS.md` or the route's docstring); 422 has non-empty `diagnostics`.
- Hidden resources answer exactly like missing ones, same status and body (`docs/ACCESS_POLICY.md` rule 2, `docs/RESOLVER_AND_VERIFIER.md` §3).
- `docs/openapi.json` diff matches the intended contract change, and nothing else.
- No new import of `routes` from `services/`, `domain/`, `jobs/`; ratchet lists not extended.

**test-reviewer (test strength)**
- Red-before evidence exists and fails for the right reason; tests assert behaviour, not implementation details.
- Mutation score on changed lines meets the threshold in `.agentic/project.yaml` (mutmut for Python, Stryker for TS, PIT for Java when available).
- SQLite-only tests of locking/claim logic are paired with a `tests/concurrency/*_pg.py` test or the gap is declared (SQLite has no row locks/`SKIP LOCKED`).
- No new `skip`/`xfail`; strict `xfail` stay strict; goldens are not regenerated to silence a failure.
- Synthetic data only; no network in unit tests (use `httpx.MockTransport`, `_fake_space.py`).

**security-auditor**
- R1: authorization on every object and action, role checks before any compile/reserve/write (`test_viewer_read_only.py` pattern); API-key permissions intersect with the user role, never widen it; owner-only role rules.
- Secrets: never logged, echoed, serialised (registration credentials, API keys, JWT secret, `SPACE_API_KEY`, `SPHERE_API_KEY`, BIM tokens); VIEWER redaction of failed-job errors kept.
- SSRF: engine endpoints go through `validate_endpoint`/`avalidate_endpoint`, pinned address, no redirects, bounded responses.
- Uploads: ZIP/XML bounded (size, ratio, entry types, no DTD/entities); body limits not bypassed for chunked bodies.
- Production guards in `core/settings.py` not weakened; CORS closed list in prod.
- Supply chain: new deps locked and licence-compatible; images pinned by digest; Actions pinned by SHA; prompt-injection exposure of agent tooling.

**arch-reviewer**
- Constitution articles 4–7; ADRs respected or superseded by a new ADR.
- BIM: no platform concept enters `bim-toolchain`; platform reaches BIM only through `BimPort`; `compilerDigest` pinning kept.
- Engines receive only the IR; manifests and modes declare capabilities; no engine-specific logic in the gateway beyond manifests.
- Coupling: top-level legacy modules (`artifacts.py`, `reports.py`, `studies.py`, `study_jobs.py`, …) are not grown; debt in `docs/ARCHITECTURE.md` "Known debt" updated.

**perf-reviewer**
- Hot paths: compile (uniqueItems/`$ref` cost on 50k-candidate catalogs), job submission (account lock), re-evaluation, neighbourhood (2 s budget), study matrix expansion (bounded before job creation).
- Memory in the 256 MiB `bim-service` profile; no unbounded reads of request bodies or engine responses.
- Measurements attached for hot-path changes (constitution 13.2).

**ui-qa**
- Screenshots desktop 1440×900 and mobile 390×844 for each changed screen; no horizontal overflow, console errors, 5xx, clipped text.
- Keyboard navigation, focus order, accessible names, landmarks, 24 px targets (`mobileTouchTargets.test.ts`).
- States: loading, empty, error (problem document rendered per pointer), forbidden, not found.
- `hygiene.test.ts` rules (no prototype names, palette) still pass; route ids/paths in `src/routes/` unchanged unless the spec says so.

## 4. Blocking criteria (any one blocks the merge)

1. A constitution MUST violated, or an R11 file changed without owner approval.
2. Behaviour without a requirement, or a requirement without a test (unless explicitly `GAP` in an approved change).
3. Any gate G1–G10 red, or the review panel incomplete for the risk level.
4. Breaking change to a public contract or BIM semantics without an approved CRP.
5. Authorization, secret-handling or SSRF finding of severity medium or higher.
6. New flaky test, new skip/xfail, weakened assertion, or regenerated golden without a recorded semantic reason.
7. Data, screenshots, raw results or secrets added to Git.
8. A claim of a passed check without its output and SHA.

## 5. Evidence rules

- Every finding cites `path:line` (or test id) of the reviewed diff and the rule/requirement it violates.
- Every claimed check includes the exact command, exit code and the SHA it ran on; output is kept by the gate runner.
- "Not executed" is stated as such; an inference is labelled as inference.
- Findings are classified `blocking | should-fix | nit`; only blocking findings stop the merge.

## 6. Owner override

The owner may override any finding or blocking criterion by a comment on the PR that names the finding and the
reason. The override is recorded in the MRP and, if it sets a precedent, in an ADR or a constitution amendment.
Agents never infer an override from silence.

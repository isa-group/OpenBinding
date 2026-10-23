Status: DRAFT for owner review (2026-10-21)

# REVIEW — bim-toolchain

Same process as OpenBinding's `REVIEW.md` (panel by risk, blocking criteria, evidence rules, owner override). This file
lists only what is specific here. Paths are relative to `bim-toolchain/`.

## Risk areas

| Id | Area | Globs | Risk |
|---|---|---|---|
| B-R1 | Language semantics and digests | `packages/bim-core/src/bim_core/{compiler,expressions,canonical,package,evaluator,reevaluate,toolchain}.py`, `packages/bim-core/src/bim_core/resources/**`, `golden/**` | high (CRP if semantic) |
| B-R2 | Engine protocol and compatibility | `packages/bim-core/src/bim_core/{protocol,compat,conformance}.py`, `resources/schemas/engine-contract.openapi.yaml` | high |
| B-R3 | HTTP API and consumer contracts | `packages/bim-service/src/**`, `packages/bim-client/src/**`, `contracts/**` | high if breaking, else medium |
| B-R4 | Untrusted input and service security | `package.py`, `expressions.py`, `bim_service/{auth,middleware,runtime,wire}.py`, `_worker.py` | high |
| B-R5 | Packaging and supply chain | `**/pyproject.toml`, `.github/**`, `tools/{verify_release,export_repo,xsd_inventory}.py`, `licenses.json`, `NOTICE.md` | high |
| B-R6 | Governance | `INTENT.md`, `constitution.md`, `REVIEW.md`, `openspec/specs/**` | owner |

## What specialists check here

- reviewer: version bump matches `constitution.md` Article 2; `CHANGELOG.md` says whether semantic digests, evaluations,
  diagnostics, OpenAPI or protocol changed; public surface (`__all__`) changes are deliberate.
- test-reviewer: goldens untouched except `toolchain` members; equivalence battery extended for every new port method;
  no new skip of the `openbinding_corpus` tier without a guard; adversarial vectors kept.
- security-auditor: Article 6 limits not loosened; tokens and package content never logged; tenant header never authorizes.
- arch-reviewer: Article 5 purity (`test_boundary.py`), no platform concept, service stays stateless.
- perf-reviewer: memory fit of process mode (256 MiB profile), event loop not blocked (B8), compile cost on large catalogs.

## Blocking criteria (in addition to OpenBinding's)

1. A semantic digest or evaluation in a golden changes without a MAJOR bump and CRP.
2. `InProcessBim` and `HttpBim` disagree on any value or error.
3. The OpenAPI document or a consumer fixture changes without being reviewed as a contract change.
4. An unpinned GitHub Action or a non-reproducible build.

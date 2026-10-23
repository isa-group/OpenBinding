Status: DRAFT for owner review (2026-10-21)

# Handoff — spec-baseline (v2: platform baseline)

Change id: `spec-baseline` · Branch: `spec/platform-baseline` (worktree `/home/ops/work/ob-spec`) · Base:
`integration/platform` @ 912648c = owner's 014e43a (QACOBench 1.1.1) + the merged platform work (lab/feat, 182 commits)
+ ICSOC dataset moved to `data/icsoc-original-dataset` + QA gallery and design prototype removed + integration fixes.
The first version of this work (`spec/baseline`, on 9b5be00) is superseded; its commits were cherry-picked here without
conflicts and then updated to the integrated reality.

## 1. What was done

Documentation only: no source code or tests were modified; three READMEs gained links; the generated changelog is
regenerated in the last commit (`tools/generate_changelog.py`) so CI's `--check` stays green.

OpenBinding (repository root): `AGENTS.md`, `CLAUDE.md`, `INTENT.md`, `constitution.md`, `REVIEW.md`, `CONTRIBUTING.md`,
`TESTING.md`, `SECURITY.md`, `docs/DEFINITION_OF_DONE.md`, `openspec/project.md`, 16 living specs under
`openspec/specs/`, 13 ADRs under `docs/adr/`, `.agentic/project.yaml`, `.github/pull_request_template.md`,
`.github/CODEOWNERS`, this handoff.

BIM (`bim-toolchain/`, future private `isa-group/bim-toolchain`): `AGENTS.md`, `CLAUDE.md`, `INTENT.md`,
`constitution.md`, `REVIEW.md`, `openspec/project.md`, 5 living specs under `openspec/specs/`.

Updates for the integration: `engine-minizinc` rewritten for `minizinc-csp@1.1.1` (pinned MiniZinc 2.8.7 / Gecode 6.3.0
bundle, products, soft constraints, `and`, `repeat.expectedCount`, `product_constraints` option, numeric boundary slack,
per-phase process groups); new `job-execution` requirement for the job-failure catalog (engine detail only in logs);
QACOBench 1.1.1 features now evidenced in the tree; ICSOC data branch and CI materialization; retired Kubernetes overlay;
`CHANGED_MANIFESTS` golden exception; ADR-0004 accepted (owner decision), ADR-0007/0008 updated to the applied state;
owner rules "owner's commit wins" and "red CI = fast lane" in `constitution.md` 14.5 and `CONTRIBUTING.md`.

## 2. Coverage

| Project | Capability | Reqs | Scenarios | GAP evidence |
|---|---|---|---|---|
| OpenBinding | gateway-api | 8 | 8 | 1 (readiness untested) |
| | instances-snapshots | 7 | 7 | 0 |
| | job-execution | 10 | 11 | 0 |
| | engine-protocol | 7 | 7 | 1 (`DELETE`/cancellation not in the engine contract) |
| | engine-registry | 7 | 7 | 0 |
| | engine-minizinc | 9 | 9 | 0 |
| | engines-java | 6 | 6 | 1 (no shared parity vectors with bim-core) |
| | generator | 6 | 6 | 0 |
| | auth-roles-entitlements | 10 | 10 | 0 |
| | collaboration-artifacts | 7 | 7 | 0 |
| | resolver-verifier | 3 | 3 | 0 |
| | studies-analysis | 6 | 6 | 0 |
| | frontend-workspace | 7 | 7 | 0 |
| | frontend-catalog-pricing | 6 | 6 | 0 |
| | qacobench-experimentation | 8 | 8 | 2 (incompatible classification lost; ICSOC regression skips without data) |
| | lab-deployment | 7 | 7 | 0 |
| BIM | language-compiler | 7 | 7 | 0 |
| | evaluator-protocol | 8 | 8 | 0 |
| | service-api | 8 | 8 | 0 |
| | client-port | 5 | 5 | 0 |
| | schema-versioning | 6 | 6 | 2 (parity only consumer-side; actions PIN-PENDING) |
| **Total** | 21 capabilities | **148** | **149** | **7** |

## 3. Validation

- `openspec` CLI and OpenFastTrace are not installed on NiPoGi: NOT EXECUTED.
- Stand-in checker `/home/ops/work/scratch/spec-check.py` (stdlib, outside the repo) on both roots of this branch:
  **OK — 148 requirements, 149 scenarios, 7 GAPs, 0 errors**; every Evidence path exists on `spec/platform-baseline` and
  every `path::symbol` occurs in its file.
- `.agentic/project.yaml` parses with PyYAML.
- `python3 tools/check_bim_guard.py` (read-only): **95 errors** on 912648c (was 92 on 9b5be00).
- `python3 tools/generate_changelog.py --check`: current after the last commit.
- No test suite was run (no uv/node/java on the host): NOT EXECUTED.

## 4. Gaps and risks still open in the code

1. **Red CI.** (a) `tools/check_bim_guard.py`: 95 errors — expects 82 packages and finds 134, requires
   `RoutingOverlay`/`Placement` in the `application` role while the installed `qos-binding/v1` Profile (bim-core
   `compiler.py`) declares them in `candidateCatalog`, flags retired markers (the old jobs API route in 17 frontend
   files, the former language name and the old project file name). (b) `experimentation/icsoc/generator` writes
   Placement and RoutingOverlay under `application`; its validation test fails when the dataset is materialized (also
   on 014e43a). Owner decision: fast-lane fixes.
2. **QACOBench vs the job-failure catalog.** `campaign.py` classifies `INCOMPATIBLE` by the prefix
   `engine rejected BindingProblem (422)` in the job error; the gateway now stores only `engine_rejected` with a fixed
   sentence, so capability rejections are indistinguishable from other refusals in a new campaign.
3. **Provenance drift.** The run manifest now hashes bim-core sources, the compiler bundle digest moved with the ported
   validator, and the minizinc-csp manifest is 1.1.1: digests recorded in `reference/1.1.1/` differ from what the
   integrated tree produces.
4. **`bim-toolchain/CHANGELOG.md` is stale**: `[Unreleased]` says no file under `packages/*/src` changed and quotes the old
   `compilerDigest`, but `bim_core/compiler.py` changed (PATCH by the BIM constitution).
5. **Golden exception.** `baseline_core.CHANGED_MANIFESTS` removes `minizinc-csp` from every comparison with the frozen
   baseline (`docs/DIGESTS.md`); reasonable, but it is an unreviewed widening of the guard.
6. **BIM still a path dependency** (`openbinding-gateway/pyproject.toml`), README says otherwise; bim-toolchain docs still
   name `javiercavlop/bim-toolchain`.
7. **Contract drift**: engine contract lacks `DELETE`/cancellation; `/v1/resolve/*` lacks 404 in OpenAPI.
8. **Missing gates**: Actions not pinned by SHA; no secret scan, SAST, dependency audit, mutation, property tests,
   Schemathesis or a11y lint.
9. **Previously reported, not re-verified**: security items B6/B8/M5, bearer session in `localStorage`, `bim-service`
   N1 headroom ≈ 2.5 MB, Java async engines never run end to end behind the gateway.

## 5. Open questions for the owner

Decided by the owner on 2026-10-21 and removed from this list: BIM repository (private `isa-group/bim-toolchain`, pinned
tag + consumer contracts), datasets (Zenodo + `data/icsoc-original-dataset`; QA screenshots and prototype out of the
repository), conflicts (the owner's commit wins), red CI (agents may fix it as fast-lane changes).

**P1 — from the integration**
1. QACOBench needs to tell capability rejections apart: add a dedicated job failure code (e.g. `engine_incompatible` for
   an engine 422) to the catalog, or let `campaign.py` read the code instead of the message? (public error catalog change)
2. Provenance digests differ from `reference/1.1.1`: re-run 1.1.1 on the integrated tree as 1.1.2, or keep 1.1.1 as a
   historical reference produced by 014e43a?
3. Accept the `CHANGED_MANIFESTS` exception (minizinc-csp left out of the frozen-baseline comparison), or record a new
   frozen baseline for minizinc-csp 1.1.1?
4. `check_bim_guard.py` expectations: should it count only `examples/` (82) or every package in the tree (134), and
   should it keep flagging the old jobs API route, the former language name and the old project file name?
5. Placement and RoutingOverlay: `candidateCatalog` role (as the installed Profile and the examples say) or `application`
   role (as the guard and the ICSOC generator say)? The fix differs: Profile change (BIM MAJOR) vs guard + generator fix.

**P1 — still open from v1**
6. Licence: keep CC BY 4.0 for code, or a software licence for code and CC BY for docs/data?
7. OMG BPMN 2.0.2 XSDs: clear redistribution or keep the verified-download path?
8. Confirm the ADR statuses (0001–0013); 0004 now Accepted per your decision.

**P2**
9. Research instrument first or platform product first? (INTENT §1)
10. Replace placeholder targets: O3 tolerance, O4 95 %/7 days, O7 500 ms/2 s, O8 N/M; BIM B4 10 %, B5 1 s.
11. Target date or venue driving priorities?
12. Which security items must close before the first release to `main`; vulnerability-reporting contact?
13. Accessibility level (WCAG 2.2 AA assumed); Spanish UI (i18n) planned?
14. Mutation threshold, `acceptance/` layout, OpenSpec CLI version, OFT acceptance of the id-after-sentence layout.
15. Add `DELETE` + cancellation capability to `bim-engine/v1` (public contract change)?
16. Feature flags: plain settings or a registry?

**P3**
17. External institutions as users this year? 18. Expansion of the acronym BIM. 19. Translate Spanish docs?
20. Public `/engines` relies on `/v1/explore/engines` while `/v1/engines` needs auth — intended? 21. Process mode as the
default for `bim-service`; end of the SPACE hold? 22. Losing pre-cutover PostgreSQL volumes acceptable for the first release?

## 6. Next steps (proposed)

1. Fast lane after Q4/Q5: fix `check_bim_guard.py` and the ICSOC generator role.
2. After Q1: failure code for capability rejections and the matching `campaign.py` change.
3. Correct `bim-toolchain/CHANGELOG.md` and the remote name in bim-toolchain docs (doc fast lane).
4. Install OpenSpec CLI and OpenFastTrace in the gate runner; start tagging `[impl->…]`/`[utest->…]`.
5. Create `acceptance/` and the missing gates once Q12/Q14 are settled.

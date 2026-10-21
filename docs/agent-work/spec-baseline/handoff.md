Status: DRAFT for owner review (2026-10-21)

# Handoff — spec-baseline

Change id: `spec-baseline` · Branch: `spec/baseline` (worktree `/home/ops/work/ob-spec`) · Base: 9b5be00
(owner's e2fd5e3 + 182 local agent commits). The owner's latest pushed commit 014e43a (QACOBench 1.1.1,
`origin/feat-isa`) was read but is not in this branch; specs mark what exists only there.

## 1. What was done

Documentation only: no source code, test or existing doc text was modified (three READMEs gained links; the generated
changelog is regenerated in the last commit so CI's `generate_changelog.py --check` stays green).

OpenBinding (repository root): `AGENTS.md`, `CLAUDE.md`, `INTENT.md`, `constitution.md`, `REVIEW.md`, `CONTRIBUTING.md`,
`TESTING.md`, `SECURITY.md`, `docs/DEFINITION_OF_DONE.md`, `openspec/project.md`, 16 living specs under
`openspec/specs/`, 13 ADRs under `docs/adr/`, `.agentic/project.yaml`, `.github/pull_request_template.md`,
`.github/CODEOWNERS`, this handoff.

BIM (`bim-toolchain/`, future `isa-group/bim-toolchain`): `AGENTS.md`, `CLAUDE.md`, `INTENT.md`, `constitution.md`,
`REVIEW.md`, `openspec/project.md`, 5 living specs under `openspec/specs/`.

Commits (oldest first): 6fb9d2b agents guide · 7e88cb8 intent + constitution · c2abe41 review · 0ed4c79 contributing,
testing, security, DoD · b7c7d11 ADRs · b442bbc not-found rule correction · e408e97 openspec project · 9a79ce2 gateway
platform specs · 18bac2f engine/generator specs · 2987987 frontend/experiments/deployment specs · 4ed2ec3 `.agentic` +
PR template + CODEOWNERS · fb6a32e BIM governance · 2c7b406 BIM specs · f690087 README links · then this handoff and a
`chore(changelog)` regeneration.

## 2. Coverage

Requirement layout: EARS sentence first (OpenSpec strict reads the first line), OFT id on its own line, `Evidence:`
(paths, `path::test`), GIVEN/WHEN/THEN scenarios, `Out of scope`, `TODO`.

| Project | Capability | Reqs | Scenarios | GAP evidence |
|---|---|---|---|---|
| OpenBinding | gateway-api | 8 | 8 | 1 (readiness untested) |
| | instances-snapshots | 7 | 7 | 0 |
| | job-execution | 9 | 10 | 0 |
| | engine-protocol | 7 | 7 | 1 (`DELETE` not in the engine contract) |
| | engine-registry | 7 | 7 | 0 |
| | engine-minizinc | 7 | 7 | 1 (solver not pinned on baseline) |
| | engines-java | 6 | 6 | 1 (no shared parity vectors with bim-core) |
| | generator | 6 | 6 | 0 |
| | auth-roles-entitlements | 10 | 10 | 0 |
| | collaboration-artifacts | 7 | 7 | 0 |
| | resolver-verifier | 3 | 3 | 0 |
| | studies-analysis | 6 | 6 | 0 |
| | frontend-workspace | 7 | 7 | 0 |
| | frontend-catalog-pricing | 6 | 6 | 0 |
| | qacobench-experimentation | 8 | 8 | 3 (features only on feat-isa) |
| | lab-deployment | 7 | 7 | 1 (CI renders a deleted overlay) |
| BIM | language-compiler | 7 | 7 | 0 |
| | evaluator-protocol | 8 | 8 | 0 |
| | service-api | 8 | 8 | 0 |
| | client-port | 5 | 5 | 0 |
| | schema-versioning | 6 | 6 | 2 (parity only consumer-side; actions PIN-PENDING) |
| **Total** | 21 capabilities | **145** | **146** | **10** |

Every spec also lists TODO items (behaviour present in the code but not yet specified), e.g. job state machine, VIEWER
redaction, organization hierarchy, sponsorship, collections, workbench flows, conformance kit, process mode of bim-service.

## 3. Validation

- `openspec` CLI and OpenFastTrace are not installed on NiPoGi: NOT EXECUTED.
- Stand-in checker `/home/ops/work/scratch/spec-check.py` (stdlib, not in the repo): verifies status line, sections,
  EARS first line with SHALL (IF…THEN), exactly one well-formed unique OFT id per requirement prefixed by the
  capability, ≥1 scenario with WHEN/THEN, an `Evidence:` line whose paths exist and whose `::symbol` occurs in the file,
  `Out of scope`. Result on both roots: **OK, 145 requirements, 146 scenarios, 10 GAPs, 0 errors**
  (`python3 /home/ops/work/scratch/spec-check.py /home/ops/work/ob-spec /home/ops/work/ob-spec/bim-toolchain`).
- `.agentic/project.yaml` parses with PyYAML (48 gate entries).
- `python3 tools/check_bim_guard.py` was run read-only: **fails on the baseline** (see 4.1). No other suite was run
  (no uv/node/java on the host): NOT EXECUTED.
- `python3 tools/generate_changelog.py` regenerated `frontend/src/content/changelog.generated.json` for the new commits.

## 4. Gaps and risks found in the code (ordered by impact)

1. **CI is red at the baseline, independent of this change.** (a) job `engines`, step "Enforce the BIM v1 repository
   cutover": `tools/check_bim_guard.py` reports 92 errors — expects 82 packages and finds 134 (it now scans
   `datasets/sources/icws`, `experimentation/icws`, engine and frontend fixtures), flags `RoutingOverlay`/`Placement` under
   `candidateCatalog` in every example, and flags retired markers (`/api/jobs` in 17 frontend files, `bimstar` in
   `integrations/bim.py`, `project.json` in a test). (b) job `test` renders `deploy/kubernetes/overlays/with-space`, deleted
   in 9b81112. Both need an S-lane fix before `develop` can have required checks.
2. **Owner's 014e43a touches code that moved.** It edits `openbinding-gateway/src/openbinding_gateway/v1/compiler.py`
   (linear `uniqueItems`, `$ref` inlining for 50k-candidate catalogs) and `v1/remote.py`; on the baseline the compiler lives
   in `bim-toolchain/packages/bim-core`. The performance changes must be ported to bim-core (they claim identical outcomes →
   PATCH, but they change `compilerDigest`). It also changes the MiniZinc model/encoders, the `minizinc-csp` manifest
   (→ new registration digests) and pins MiniZinc 2.8.7 (baseline: apt 2.6.4). QACOBench 1.1.1 results are not reproducible
   on the baseline until this is integrated.
3. **BIM is a path dependency.** `openbinding-gateway/pyproject.toml` uses editable path sources for `bim-core`/`bim-client`;
   README still says the gateway does not depend on bim-toolchain while `docs/ARCHITECTURE.md` says it does (doc drift).
   ADR-0004 (pinned release) is Proposed.
4. **Contract drift.** The engine contract (`schemas/engine-contract.openapi.yaml`) has no `DELETE` and no cancellation
   capability although engines and gateway implement them; `/v1/resolve/*` returns 404 but OpenAPI documents only 200/422.
5. **Data still in Git** contrary to the brief: `experimentation/icsoc/original_dataset/` (1,401 files),
   `datasets/sources/**` (560 files), `docs/frontend-qa/` (20 MB, screenshots) and `docs/design-handoff/prototype/` (7.5 MB).
   `frontend/e2e/qa-gallery.spec.ts`, `frontend/src/styles/globals.css` and the route test ("82 screens of the prototype")
   depend on them.
6. **Supply chain / quality gates missing.** Actions pinned by major version (OpenBinding CI) or `PIN-PENDING`
   (bim-toolchain CI, never run; a nested `.github/` is not run by GitHub inside the monorepo). No secret scanning, SAST,
   dependency audit, mutation testing, property-based tests, Schemathesis or axe/a11y lint.
7. **Security open items** (from `docs/qa/SECURITY_REVIEW.md`, not re-verified): B6 internal error text in stored job and
   analysis errors; B8 thread-mode `bim-service` cannot interrupt CPU-bound work (3 strict xfail); M5 lab hardening by the
   supervisor; bearer session in `localStorage`.
8. **Operational fragility.** `bim-service` N1 lab headroom ≈ 2.5 MB of 256 MiB; Java engines in async mode behind the
   gateway never exercised end to end; real Redis/Dramatiq failure and crash injection never exercised; pre-cutover
   PostgreSQL volumes cannot be migrated; SPACE on hold (class B counters not applied).
9. **Consistency.** Remote name of the BIM repo (`isa-group` in the brief vs `javiercavlop` in bim-toolchain docs);
   some docs in Spanish (`docs/BIM_GENERATOR.md`, `output/zenodo/` on feat-isa); the BIM acronym is never expanded.

## 5. Open questions for the owner (grouped, highest priority first)

**P1 — needed before the factory runs on this repo**
1. Licence: keep CC BY 4.0 for code, or a software licence for code and CC BY for docs/data? (INTENT §6)
2. BIM repository owner (`isa-group` vs `javiercavlop`) and the pin channel (tag + uv git source, private index, release wheels)? (ADR-0004)
3. OMG BPMN 2.0.2 XSDs: clear redistribution or keep the verified-download path? (bim-toolchain INTENT)
4. Which tracked material leaves Git: `datasets/sources/**` (inputs or data?), `experimentation/icsoc/original_dataset/` → data branch, `docs/frontend-qa/`, `docs/design-handoff/`? (ADR-0008)
5. Approve S-lane fixes for the red CI steps (BIM guard, deleted Kustomize overlay)? (§4.1)
6. Integration of 014e43a: port the compiler performance changes into bim-core as a PATCH (new `compilerDigest`) and adopt MiniZinc 2.8.7 in develop? (ADR-0007)
7. Confirm or change ADR statuses (0001–0013); only you set Accepted.

**P2 — shape priorities and gates**
8. Research instrument first or platform product first? (INTENT §1)
9. Replace placeholder targets: O3 tolerance T, O4 95 %/7 days, O7 500 ms/2 s, O8 N/M; BIM B4 10 %, B5 1 s.
10. Target date or venue driving priorities?
11. Which security items (B6, B8, M5, localStorage session, unpinned Actions) must close before the first release to `main`; is private vulnerability reporting enabled and with which contact?
12. Accessibility level (WCAG 2.2 AA assumed) and whether a Spanish UI (i18n) is planned.
13. Mutation threshold, `acceptance/` layout, OpenSpec CLI version, and whether OFT accepts the id-after-sentence layout.
14. Engine contract: add `DELETE` + cancellation capability to `bim-engine/v1` (public contract change)?
15. Feature flags: plain settings or a registry?

**P3 — clarifications**
16. External institutions as users this year?
17. Expansion of the acronym BIM for the glossary.
18. Translate Spanish docs to English?
19. Public `/engines` screen relies on `/v1/explore/engines` while `/v1/engines` needs auth — intended?
20. Process mode as default for `bim-service`? When does SPACE leave "on hold"?
21. Is losing pre-cutover PostgreSQL volumes acceptable for the first release?

## 6. Next steps (proposed)

1. S-lane: fix `check_bim_guard.py` scope/rules and the CI Kustomize step (after Q5).
2. Install OpenSpec CLI and OpenFastTrace in the gate runner; confirm the layout on these specs; then start tagging
   `[impl->…]`/`[utest->…]` on touched code.
3. Integrate 014e43a into develop (other agent's `integration/platform` work) and re-baseline `engine-minizinc` and
   `qacobench-experimentation`.
4. Create `acceptance/` and the missing gates (secret scan, dep audit, mutation pilot) once the owner settles Q11/Q13.

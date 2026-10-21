Status: DRAFT for owner review (2026-10-21)

# INTENT — OpenBinding

Owner: Francisco Javier Cavero López (`@javiercavlop`), ISA Research Group / SCORE Lab, Universidad de Sevilla.
This is the owner's document. Agents propose edits by PR; they never change it on their own. Everything below was
inferred from the code and docs at `spec/platform-baseline` (from `integration/platform` @ 912648c, which includes the
owner's QACOBench 1.1.1 release 014e43a);
lines marked `> OPEN QUESTION:` are guesses or gaps for the owner to settle.

## 1. Purpose

Make QoS-aware service binding problems **describable once, solvable by any compatible engine, comparable fairly
and reproducible by anyone**. OpenBinding does this with one canonical problem language (BIM v1 compiled to a
digest-addressed `BindingProblem` IR), interchangeable engines behind one protocol, authoritative re-evaluation of
every engine answer, and provenance for every artifact, job, study and report.

> OPEN QUESTION: Is OpenBinding primarily a research instrument (papers, QACOBench, benchmarks) that also offers a
> collaborative platform, or a platform product with research as one use? This decides how much weight platform
> features (organizations, sponsorship, notifications) get versus experiment reproducibility.

## 2. Users

| User | Needs | Evidence in the code |
|---|---|---|
| Researchers in service composition (primary) | author/upload BIM packages, run engines, compare results, publish reports with citations | cases, collections, studies, reports, publications, verifier |
| Engine authors | register a solver once, prove conformance, reach users | `/v1/engine-registrations`, `docs/ENGINE_INTEGRATION.md` |
| Experimenters / automation (QACOBench) | stable public API, idempotent jobs, resumable campaigns | `experimentation/qacobench/`, `Idempotency-Key` |
| Universidad de Sevilla members and students | sign in with CAS, free RESEARCH plan | `routes/cas.py`, `docs/ACCOUNTS_AND_PLANS.md` |
| Public readers (reviewers, readers of a paper) | open a public project or resolve a digest without an account | `/v1/explore/*`, `/v1/resolve/*`, public projects |
| Platform administrator (the owner) | moderation, users, queues, maintenance, audit | `/v1/admin/*`, `/app/admin` |

> OPEN QUESTION: Are external (non-US) institutions a target user group for this year, or is the platform scoped to
> ISA/US and paper readers?

## 3. Value

1. One language and IR for every engine: no per-solver input formats.
2. Fair comparison: the gateway never trusts engine numbers; it re-evaluates each binding with the canonical
   evaluator and downgrades unsupported termination claims.
3. Reproducibility by construction: pinned toolchain (`compilerDigest`), immutable snapshots and revisions, exact
   engine revisions, study matrices, run manifests, datasets in Zenodo.
4. Low-friction collaboration and publication: organizations, projects, versioned library, public read, citations.

## 4. Measurable objectives

| Id | Objective | Metric and target | Today |
|---|---|---|---|
| O1 | Language stability | 100 % of the checked-in corpus compiles; IR identical across directory/ZIP/permutations | 82/82 (`tools/check_bim_corpus.py --expected 82`; `docs/qa/IR_NORMALIZATION.md`) |
| O2 | Verdict integrity | 0 contradicted verdicts per campaign (UNSAT vs validated binding; OPTIMAL beaten) | enforced by `evaluate_results.py` in QACOBench 1.1.1 |
| O3 | Experiment reproducibility | a third party re-runs the reference campaign from Zenodo + a tag and reproduces the aggregate tables within tolerance **T** | reference 1.1.1 recorded; T undefined |
| O4 | Platform reliability | develop CI green on ≥ **95 %** of days; 0 known flaky tests older than **7** days | not measured |
| O5 | Delivery flow | median change ≤ 300 diff lines merged into develop the same day | not measured |
| O6 | Security | 0 open high/critical findings at each release to `main` | `docs/qa/SECURITY_REVIEW.md` lists open B6/B8/M5 items |
| O7 | Interactive latency | p95 of `POST /v1/jobs` (accept) ≤ **500 ms** and of `POST /v1/validate` ≤ **2 s** for corpus-size packages on the lab | not measured |
| O8 | Adoption | **N** external engine registrations and **M** active research users per semester | not measured |

> OPEN QUESTION: T (O3), the 95 % / 7 days (O4), 500 ms / 2 s (O7) and N/M (O8) are placeholders invented for this
> draft. Replace or delete them.

> OPEN QUESTION: Is there a target date or venue (paper submission, defence, release) that should drive priorities?

## 5. Non-goals

- Billing, credits, compute units or metering of any kind (retired; `docs/ACCOUNTS_AND_PLANS.md`).
- Automatic engine selection (retired; a separate future research project, not this platform).
- A local SPACE stack, a pricing editor or a contract lifecycle of its own: SPACE and SPHERE are remote and
  administered in their own consoles.
- Scheduling, probabilistic QoS, risk, telemetry or runtime adaptation in `qos-binding/v1`.
- Distributed exactly-once execution (`docs/IDEMPOTENCY.md` states the real guarantees).
- Hosting datasets, raw campaign results, QA screenshots or design prototypes in Git.

After the extraction OpenBinding never edits BIM semantics directly; it bumps the pinned tag of the private
`isa-group/bim-toolchain` and runs the consumer contracts (owner decision, ADR-0004).

## 6. Hard constraints

- Repository `isa-group/OpenBinding` is public; licence CC-BY-4.0 (`LICENSE`).
  > OPEN QUESTION: CC BY 4.0 is not designed for software (`bim-toolchain/docs/LICENSING.md`). Keep it, or adopt a
  > software licence for code (e.g. Apache-2.0) while keeping CC BY for docs and data?
- Data never in Git; tests, seeds and the lab use synthetic data only.
- SPACE stays on hold (zero calls); SPHERE is read-only.
- Resources: NiPoGi (14 GiB RAM, lab cap 9 GiB; `bim-service` 256 MiB in the demo profile N1).
- Runtimes: Python ≥ 3.11, Node 20, JDK 21 in CI with `binding-core` targeting Java 8 bytecode.
- Only the owner merges into `main` and orders production deployments.

## 7. Signals the proposer must watch

- CI and nightly gate failures; flaky tests (`docs/qa/FLAKY_TESTS.md`).
- Architecture ratchets: `ALLOWED_LEGACY`, `GATE_LIFECYCLE_LEGACY`, `MAX_LINES` of `routes/v1.py` (should shrink).
- Diffs of `docs/openapi.json`, `schemas/**`, `bim-toolchain/contracts/**` (contract changes).
- `compilerDigest` changes and BIM consumer-contract failures (`tests/test_bim_consumer_contract.py`).
- MiniZinc/Gecode version drift between the image and the QACOBench run manifest.
- Items marked `NO EJECUTADO` / `NOT EXECUTED` / `Open` in `docs/qa/JOINT_STATUS.md` and `docs/qa/SECURITY_REVIEW.md`.
- Lab memory headroom (`bim-service` N1 margin ≈ 2.5 MB) and job queue timeouts.
- Dependency advisories and unpinned GitHub Actions.
- Spec drift: code paths without `[impl->req~…]` tags, specs with `GAP` evidence.

## 8. Decisions agents may NOT take without a CRP (owner decision)

1. Any change to a public contract: `docs/openapi.json` (breaking), `schemas/bim/v1/**`, `schemas/engine-contract.openapi.yaml`, `bim-service` API.
2. BIM semantics, IR digests, goldens, `compilerDigest` meaning, BIM MAJOR/MINOR bumps, the pinned BIM tag.
3. Roles, permissions, API-key scopes, visibility rules, plan/entitlement semantics.
4. Enabling any SPACE/SPHERE call or write, or any other new external integration.
5. Destructive migrations, data deletion, retention changes, rewriting stored evidence.
6. Licences, third-party redistribution (incl. the OMG BPMN XSDs), publishing (GitHub repos, Zenodo, PyPI, images).
7. The MiniZinc bundle version, engine default budgets, or anything that changes QACOBench reference results.
8. New runtime dependencies with network access, new third-party Actions/hooks/MCP servers.
9. Edits to `INTENT.md`, `constitution.md`, `REVIEW.md`, `CODEOWNERS`, `.agentic/project.yaml`, ADR status.
10. Production deployment, `main` merges or tags.

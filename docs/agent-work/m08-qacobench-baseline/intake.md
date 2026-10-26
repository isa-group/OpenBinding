# Intake: m08-qacobench-baseline, QACOBench after the integration (ROADMAP M0.8)

- Owner request `own-033e9b12c03448b28e474e292072c32c` (2026-10-24). Base: `task/079f4adf1793484e` at `99697d7e`.
- Roadmap row: `ROADMAP.md:44` (M0.8). Its acceptance: "no baseline exceptions left; a `reference/1.1.2` whose
  provenance digests match the platform; `reference/1.1.1` unchanged".
- INTENT objectives: **O2 verdict integrity** and **O3 experiment reproducibility** (`INTENT.md:163-164`).
- Living specs touched (by delta only): `openspec/specs/job-execution/spec.md` (`req~job-execution-failure-catalog~1`,
  TODO at `:149`), `openspec/specs/qacobench-experimentation/spec.md` (`req~qacobench-experimentation-incompatible-is-data~1`,
  TODO at `:120-122`, `:127-128`), `bim-toolchain/openspec/specs/schema-versioning/spec.md`
  (`req~bim-schema-versioning-goldens~1`, `:27`, TODO at `:93`).
- Open questions this closes: P1-1 and P1-3 of `docs/agent-work/spec-baseline/handoff.md:102-107`. P1-2 (re-run as
  1.1.2) is the release step R below. It is behind a CRP and is not a slice.

## 1. Objective

1. A job that an engine refuses with 422 fails with its own catalog code, `engine_incompatible`. The code is documented
   in `docs/ERRORS.md` and declared in the OpenAPI snapshot. The QACOBench runner classifies `INCOMPATIBLE` by that code
   and no longer by message text.
2. The `minizinc-csp` 1.1.1 manifest gets a frozen golden baseline of its own. `baseline_core.CHANGED_MANIFESTS` and every
   exclusion in the live golden comparison are removed.
3. `experimentation/qacobench/reference/1.1.1/**` is not touched by any slice.
4. Releasing 1.1.2 (a re-run of the campaign, `reference/1.1.2`, Zenodo) is a separate owner-approved step R.

## 2. What the code does today (verified at `99697d7e`)

| # | Fact | Evidence |
|---|---|---|
| F1 | The gateway turns every non-200/202 engine answer to `POST` BindingProblem into `RemoteEngineError(..., code="engine_rejected")`, whatever the status (422, 503, ...). The engine text goes only into the internal message | `openbinding-gateway/src/openbinding_gateway/v1/remote.py:438-459` (code at `:458`). The engine-document fetch uses the same code at `:344` and stays as it is |
| F2 | The job-failure catalog is closed. `engine_rejected` = "The engine rejected the request.". An unknown code becomes `internal_error`. `RemoteEngineError.code` is used when it is in the catalog | `openbinding-gateway/src/openbinding_gateway/core/public_errors.py:216-231`, `:240-244`, `:258-259` |
| F3 | A failed job's `result` is `{termination: UNKNOWN, solutions: [], error: <sentence>, code, correlationId, provenance, evidence?}` | `openbinding-gateway/src/openbinding_gateway/services/execution.py:76-87`; reconciler `jobs/reconciler.py:120` |
| F4 | **Contract drift.** The OpenAPI `GatewayBindingResult` declares only `termination`, `solutions`, `provenance` and `error`, with `additionalProperties: false`. `code`, `correlationId` and `evidence` are sent but not declared | `openbinding-gateway/src/openbinding_gateway/main.py:930-943`; `docs/openapi.json:7231-7261` |
| F5 | `docs/ERRORS.md` documents the 422 `Problem` and `engine_mode_incompatible` (the gateway's refusal **before** the job, at submission). It does not list the job-failure catalog at all | `docs/ERRORS.md:83-89`; no match for `engine_rejected` in `docs/ERRORS.md` |
| F6 | Engine protocol: 422 means "the IR or the options are not supported by the requested mode", before any job. It is also returned for a body that is not a BindingProblem request, but the gateway validates requests before sending them | `openspec/specs/engine-protocol/spec.md:14-36`; `engines/minizinc-csp/src/index.ts:82-86`; `engines/binding-core/src/main/java/es/us/isa/openbinding/core/EngineHttp.java:264,347` |
| F7 | `campaign.py` classifies job-level rejections by the message prefix `engine rejected BindingProblem (422)`. The gateway no longer sends that text (F1-F3), so today such a job is recorded as `ERROR`, not `INCOMPATIBLE`. The prefix branch is dead | `experimentation/qacobench/campaign.py:105-123` (prefix at `:110`, `:120`) |
| F8 | At submission, `campaign.py` treats **every** 422 of `POST /v1/jobs` as `INCOMPATIBLE`, including `validation_error`, `invalid_option`, `snapshot_not_recompilable`. The only capability refusal there is `engine_mode_incompatible` | `campaign.py:286-300`; `services/job_submission.py:335-341`; `services/engines.py:390-393` |
| F9 | Pre-job negotiation is already code-based. A mode reported `compatible: false` by `/v1/validate` becomes `INCOMPATIBLE` with structured diagnostics | `campaign.py:244-256` |
| F10 | The tests pin the dead prefix behaviour | `experimentation/qacobench/test_qacobench.py:29-33`, `:88-93` |
| F11 | The secondary analysis strips the same prefix to read the 1.1.1 diagnostics (historical records). It does not classify | `experimentation/qacobench/secondary/02_analyze.py:305-322` |
| F12 | `CHANGED_MANIFESTS = ("minizinc-csp",)` removes minizinc-csp from the comparison of `compat.json` and `protocol.json` with the frozen `golden/bim_baseline`. `MISSING_MANIFESTS = ("meta-router-csp",)` also removes an engine whose manifest is not in the repository | `bim-toolchain/tools/baseline_core.py:123-129`, `:1371-1376` |
| F13 | The same exclusion is in three tests | `bim-toolchain/packages/bim-core/tests/test_baseline_equivalence.py:17-19`, `:129-136`, `:263-280`, `:288-289` |
| F14 | `golden/bim_baseline` is frozen, and its SHA-256 is pinned twice. The rule for a golden that moves: keep the old one frozen, put the new one in a new directory, and compare the two by identifier | `baseline_core.py:111-112`, `:374-375`, `:491`; `golden/ir_previous/evidence.json`; `test_ir_previous_baseline.py:66-70`; `test_golden_toolchain_metadata.py:114-121`; `bim-toolchain/docs/DIGESTS.md:155-163`, `:265-268` |
| F15 | `golden/bim_core/{compat,protocol}.json` already hold the four-engine documents with the minizinc-csp 1.1.1 manifest. They are regression pins that can be regenerated, not frozen. `compat.json` is 2,958 lines and `protocol.json` 47 | `bim-toolchain/docs/DIGESTS.md:88-94`, `:96-105`; line counts at `99697d7e` |
| F16 | The living requirement names the exception | `bim-toolchain/openspec/specs/schema-versioning/spec.md:27,31,93` |
| F17 | CI runs the toolchain tests and `baseline_core.py --check` on every PR. They use the gateway's locked venv, and the BPMN XSDs are downloaded with `xsd_inventory.py --ensure` | `.github/workflows/ci.yml:81-124` |
| F18 | Nothing outside `bim-toolchain/` reads `CHANGED_MANIFESTS`. The frontend does not switch on job failure codes | grep at `99697d7e`: no match in `frontend/` for `engine_rejected`, `lease_lost` or `GatewayBindingResult` |
| F19 | The release artefacts default to 1.1.1 | `tools/package_zenodo.sh:22`; `output/zenodo/{software,dataset}/metadata.json:4`; `experimentation/qacobench/reference/1.1.1/` |
| F20 | Risk globs: `remote.py` is R4 (high). `public_errors.py`, `docs/openapi.json` and `schemas/**` are R3 (high if breaking). `bim-toolchain/**` is R7 (high). `experimentation/**` is R8 (medium). `reference/**` escalates to high. `openspec/specs/**` and `bim-toolchain/openspec/specs/**` are R11 (owner) | `.agentic/project.yaml:112-139` |

## 3. Scope and non-goals

In scope: F1-F4 (gateway code and contract), F7-F10 (runner), F12-F16 (goldens), and the spec deltas.

Non-goals:

- **Exposing the engine's 422 text to API clients.** `req~job-execution-failure-catalog~1` keeps it in the log
  (`job-execution/spec.md:116-126`). A new campaign therefore records job-level rejections with the code and the fixed
  sentence. Construct-level detail stays available only from pre-job negotiation (F9). This is noted as a risk for the
  capability matrix (`02_analyze.py:304-336`).
- `secondary/02_analyze.py` keeps its prefix regex, because it reads the 1.1.1 records (F11).
- `evidence` in the failed-job result (F4) is also undeclared. It is a followup and not part of this change.
- Re-running the campaign, `reference/1.1.2`, version bumps in `tools/package_zenodo.sh` and `output/zenodo/**`, and the
  Zenodo upload: these are step R (section 7).
- Files held by other leads: `services/citations.py`, `routes/resolve.py`, `routes/verifier.py`, `tools/latency_probe.py`,
  `frontend/**`, `openspec/**` and `ROADMAP.md`. No slice owns any of them, and the Status column of M0.8 is updated by
  whoever holds `ROADMAP.md`.

## 4. Slices

One capability per slice. The owned globs are disjoint. **No feature flag:** S1, S2 and S3 are each correct on their
own. The case of S2 before S1 is covered: job-level rejections are already `ERROR` today (F7), so S2 alone changes
nothing for them and tightens the submission path (F8).

| # | Slice (one capability) | Role / budget | Owned files | Read-only context | Est. diff (src+docs, tests and generated excluded) | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S0 | Spec deltas | specifier, default model, low effort, ~25 turns | `openspec/changes/m08-qacobench-baseline/**` (proposal, design from this intake, tasks, `specs/job-execution/spec.md`, `specs/qacobench-experimentation/spec.md`); `bim-toolchain/openspec/changes/m08-frozen-manifest-baseline/**` (`specs/schema-versioning/spec.md`) | this intake; the three living specs; `docs/agent-work/spec-baseline/handoff.md` | ~120 lines of spec | **low** to write. The deltas are archived into R11 paths later, in an owner-approved archive task | `openspec/**` released by its current lead (needs) |
| S1 | Gateway: engine 422 becomes `engine_incompatible` (catalog, contract, docs) | implementer, default model, medium effort, ~35 turns | `openbinding-gateway/src/openbinding_gateway/v1/remote.py` (the `!= 202` branch, `:438-459`, only); `openbinding-gateway/src/openbinding_gateway/core/public_errors.py` (`JOB_FAILURES` only); `openbinding-gateway/src/openbinding_gateway/main.py` (the `GatewayBindingResult` block `:930-943` only); `docs/openapi.json` (regenerated, never by hand); `docs/ERRORS.md`; `openbinding-gateway/tests/test_job_error_text.py`; `openbinding-gateway/tests/test_job_failure_contract.py` (new) | `services/execution.py`, `jobs/reconciler.py`, `tests/test_openapi_contract.py`, `tests/test_b4_problem_schema.py`, `tools/dump_openapi.py`, `openspec/specs/engine-protocol/spec.md` | remote.py ~6, public_errors.py ~2, main.py ~12, ERRORS.md ~40 → **~60** | **high**: R4 (`remote.py`) and R3. Re-coding the engine 422 is an error-code change for API clients (CRP-1). The schema change is additive (F4) | S0 validated; CRP-1 answered |
| S2 | QACOBench classifies capability refusals by code | implementer, default model, medium effort, ~25 turns | `experimentation/qacobench/campaign.py`; `experimentation/qacobench/test_qacobench.py`; `experimentation/qacobench/README.md` (`:52` paragraph only) | `secondary/**`, `evaluate_results.py`, `reference/1.1.1/**` (must stay byte-identical), `docs/ERRORS.md` | campaign.py ~25, README ~4 → **~30** | **medium**: R8. `reference/**` is not touched, so the escalation does not apply | S0 validated; the code name fixed by CRP-1. It can run in parallel with S1 |
| S3 | Frozen golden baseline for the minizinc-csp 1.1.1 manifest; `CHANGED_MANIFESTS` removed | implementer, default model, high effort, ~40 turns | `bim-toolchain/tools/baseline_core.py`; `bim-toolchain/golden/bim_baseline_1_1_1/**` (new: `compat.json`, `protocol.json`); `bim-toolchain/packages/bim-core/tests/test_baseline_equivalence.py`; `bim-toolchain/packages/bim-core/tests/test_frozen_manifest_baseline.py` (new); `bim-toolchain/packages/bim-core/tests/data/minizinc_1_1_1_compat_moves.json` (new); `bim-toolchain/docs/DIGESTS.md`; `bim-toolchain/CHANGELOG.md` | `golden/bim_baseline/**` (frozen, never written), `golden/bim_core/**`, `golden/ir_previous/**`, `tools/regen_normalized_metadata.py`, `test_golden_toolchain_metadata.py`, `test_ir_previous_baseline.py`, `schemas/bim/v1/manifests/minizinc-csp.json`, `openbinding-gateway/tests/golden/bim_baseline/**`, `openbinding-gateway/tests/test_bim_baseline.py` | baseline_core.py ~25, DIGESTS.md ~30, CHANGELOG ~5 → **~60**, plus a **3,005-line byte copy** of fixtures (justified below) | **high**: R7 (`bim-toolchain/**`). It is a test and golden change only, with no `bim_core` source change | S0 validated. It is parallel with S1 and S2 |

Order: S0 → (S1 ∥ S2 ∥ S3) → step R (owner).

**Shared files:** none. `docs/ERRORS.md` and `docs/openapi.json` belong to S1 only. S2 reads the code name from the
spec and does not edit the contract. `golden/bim_core/**` stays read-only for S3. S3 copies it and does not move it.

**The 300-line justification (S3).** `golden/bim_baseline_1_1_1/{compat,protocol}.json` must be byte copies of
`golden/bim_core/{compat,protocol}.json` at the S3 base (F15). They are reviewed by checksum, not by reading. The new
test asserts the SHA-256 of both files against constants and their equality with `bim_core` at creation. The
hand-written diff stays under ~150 lines with tests.

### S1 design

- `remote.py:457-459`: `code="engine_incompatible"` when `response.status_code == 422`, and `engine_rejected` for any
  other refusal. The internal message keeps the engine detail for the log (unchanged).
- `JOB_FAILURES["engine_incompatible"]`: a fixed sentence, unique, ≤ 120 characters, with no `://` or `{`
  (`test_job_error_text.py:130-137`). Proposed: "The engine does not support a construct or option of this problem."
- `GatewayBindingResult` gains `code` (`type: string`, described as "the job-failure catalog code; see docs/ERRORS.md")
  and `correlationId` (`type: string`). There is **no enum** on `code`: adding a value later to a response enum would be
  breaking. `docs/openapi.json` is regenerated with `tools/dump_openapi.py`.
- `docs/ERRORS.md`: a new section, "Why a job failed", listing every `JOB_FAILURES` code with its sentence. It says
  that `engine_mode_incompatible` (a 422 at submission, before the job) and `engine_incompatible` (a job failure: the
  engine refused at execution) are different moments of the same kind of refusal.
- The new test `test_job_failure_contract.py`: every key of `JOB_FAILURES` appears in `docs/ERRORS.md`, and the
  `GatewayBindingResult` snapshot declares `code`. `test_job_error_text.py` adds 422 → `engine_incompatible` next to
  the existing 503 → `engine_rejected` (`:194-209`).

### S2 design

- `_normalized_result`: `INCOMPATIBLE` iff `result.code == "engine_incompatible"`. Its diagnostics are
  `[{"code": "engine_incompatible", "message": result.error}]`. Any other error is `ERROR`. The prefix tests are removed
  (`campaign.py:109-121`).
- Submission 422: `INCOMPATIBLE` only when the problem `code` is `engine_mode_incompatible`, with its diagnostics.
  Any other 4xx is `ERROR` (`campaign.py:289`).
- Tests replace `test_qacobench.py:29-33` and `:88-93`. They cover a job with `code: engine_incompatible` (INCOMPATIBLE),
  a job with `code: engine_rejected` (ERROR), a submission 422 `engine_mode_incompatible` (INCOMPATIBLE), and a
  submission 422 `validation_error` (ERROR).
- README `:52`: one sentence naming the two codes.

### S3 design

- New frozen directory `golden/bim_baseline_1_1_1/` with byte copies of `golden/bim_core/{compat,protocol}.json`
  (four engines, minizinc-csp 1.1.1). It is never written by `baseline_core.py` (not in `main()` targets,
  `baseline_core.py:1423-1430`).
- `mismatches()` (`:1371-1376`) compares `compat`/`protocol` with `bim_baseline_1_1_1` **with no engine removed**.
  `CHANGED_MANIFESTS` is deleted, and `MISSING_MANIFESTS` leaves the live comparison.
- `test_frozen_manifest_baseline.py`: (a) the SHA-256 of both files equals constants in the test (the pin, like
  `evidence.json` for the 0.1.x baseline); (b) the new frozen baseline compared with the old frozen `bim_baseline` by
  identifier: every engine except minizinc-csp is identical once meta-router-csp is removed, and the minizinc-csp
  entries that moved are exactly the ones listed in `tests/data/minizinc_1_1_1_compat_moves.json`. That list is
  computed once, reviewed and pinned (the precedent is `tests/data/zip_divergent_packages.json`); (c) no
  `compatible: true` of the old baseline became `false`. 1.1.1 only widened the mode
  (`schemas/bim/v1/manifests/minizinc-csp.json:8`). If (c) fails, the slice stops and reports.
- `test_baseline_equivalence.py:129-136`, `:263-280` and `:288-289` compare against `bim_baseline_1_1_1` and no longer
  remove engines. `MISSING_MANIFESTS` stays only where the old frozen copy is read.
- The new pins stay in the new test. `regen_normalized_metadata.FROZEN` is not extended, so
  `golden/toolchain_metadata_comparison.json` and the gateway copy are not regenerated.
- `DIGESTS.md:88-94` is rewritten (the second frozen baseline and why). `CHANGELOG.md [Unreleased]` gets a "tests"
  entry (no `bim_core` code change, so no version bump).

## 5. Proposed checks (none registered; argv arrays)

**S0** (`cwd: .`): `["openspec","validate","m08-qacobench-baseline","--strict"]`.
`cwd: bim-toolchain`: `["openspec","validate","m08-frozen-manifest-baseline","--strict"]`. Whether the CLI picks up
`bim-toolchain/openspec/` as its own root is unverified; if it does not, the specifier reports it.

**S1** (`cwd: openbinding-gateway`):

0. `["uv","sync","--locked","--extra","test"]`
1. Red-before (G3): `{"argv":["uv","run","--locked","--extra","test","pytest","-q","tests/test_job_error_text.py","tests/test_job_failure_contract.py"],"type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError|assert .*engine_incompatible","overlay":["openbinding-gateway/tests/test_job_error_text.py","openbinding-gateway/tests/test_job_failure_contract.py"]}`.
   The tests must look the catalog up with `in`/`.get`, so that the base fails by assertion and not by `KeyError`.
2. Focused (G5): `["uv","run","--locked","--extra","test","pytest","-q","tests/test_job_error_text.py","tests/test_job_failure_contract.py","tests/test_remote_cancel.py","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py"]`
3. Full (G5, `gateway-unit`): `["uv","run","--locked","--extra","test","pytest"]`, timeout 1800
4. G7: `["uv","run","--locked","python","tools/dump_openapi.py","--check"]` (it must pass after regeneration; the diff is limited to `GatewayBindingResult`)
5. G7: `["uv","run","--locked","--extra","test","pytest","-q","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py","tests/test_bim_consumer_contract.py"]`
6. G9: `["uv","run","--locked","--extra","test","ruff","check","src","tests"]`

**S2** (`cwd: .`):

0. Red-before (G3): `{"argv":["python3","-m","pytest","-q","experimentation/qacobench/test_qacobench.py"],"type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError","overlay":["experimentation/qacobench/test_qacobench.py"]}`
1. G5 (`qacobench-unit`): `["python3","-m","pytest","experimentation/qacobench/test_qacobench.py"]`
2. Guard: `["bash","-c","set -euo pipefail; ! grep -n 'engine rejected BindingProblem' experimentation/qacobench/campaign.py experimentation/qacobench/test_qacobench.py"]`
3. Reference untouched: `["git","diff","--exit-code","99697d7e","--","experimentation/qacobench/reference/1.1.1"]`. The supervisor sets the base sha of the attempt.

**S3** (`cwd: .` unless noted; `env PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src` for `cwd: bim-toolchain`):

0. `["uv","sync","--locked","--project","openbinding-gateway","--extra","test"]`
1. `["python3","bim-toolchain/tools/xsd_inventory.py","--check"]`. This is a precondition: the XSDs are not in Git (F17). If it fails offline, report it (needs) and do not download.
2. Red-before (G3, `cwd: bim-toolchain`): `{"argv":["../openbinding-gateway/.venv/bin/python","-m","pytest","-q","-p","no:cacheprovider","--rootdir=.","packages/bim-core/tests/test_frozen_manifest_baseline.py"],"type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError","overlay":["bim-toolchain/packages/bim-core/tests/test_frozen_manifest_baseline.py"]}`.
   Files are read inside the test functions and not at import, and one test asserts `not hasattr(baseline_core, "CHANGED_MANIFESTS")`.
3. Focused (`cwd: bim-toolchain`): `["../openbinding-gateway/.venv/bin/python","-m","pytest","-q","-p","no:cacheprovider","--rootdir=.","packages/bim-core/tests/test_frozen_manifest_baseline.py","packages/bim-core/tests/test_baseline_equivalence.py","packages/bim-core/tests/test_ir_previous_baseline.py","packages/bim-core/tests/test_golden_toolchain_metadata.py"]`, timeout 1800
4. Full (`cwd: bim-toolchain`): the CI command of `.github/workflows/ci.yml:118` as an argv (same two `--deselect`), timeout 1800
5. Goldens (`cwd: bim-toolchain`): `["../openbinding-gateway/.venv/bin/python","tools/baseline_core.py","--check"]`, timeout 1800
6. Guard: `["bash","-c","set -euo pipefail; ! grep -rn 'CHANGED_MANIFESTS' bim-toolchain/tools bim-toolchain/packages bim-toolchain/docs"]` (the living spec keeps the name until the archive task)
7. Gateway goldens unaffected (`cwd: openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest","-q","tests/test_bim_baseline.py"]`
8. G9 (`cwd: bim-toolchain`): `["ruff","check","packages","tools"]` (registered as `ruff-bim`)
9. Frozen 0.1.x baseline untouched: `["git","diff","--exit-code","99697d7e","--","bim-toolchain/golden/bim_baseline","bim-toolchain/golden/ir_previous"]`

## 6. Gates per slice

| Gate | S0 | S1 | S2 | S3 |
|---|---|---|---|---|
| G1 spec | its checks | same change | same change | bim-toolchain change |
| G2 EPIC | spec-auditor ≥ 2/3 | n/a | n/a | n/a |
| G3 red-before | n/a | check 1 | check 0 | check 2 |
| G4 acceptance | optional test-designer task in `acceptance/api` (failed job with code `engine_incompatible` through the public API); the harness is thin, so gateway tests first | | | |
| G5 green-after | n/a | checks 2-3 | check 1 | checks 3-5, 7 |
| G6 trace | tags `[impl->req~job-execution-engine-incompatible~1]` in `remote.py`/`public_errors.py`, `[utest->...]` in the tests. `oft-trace` is `todo: true` (`project.yaml:62`), so it is reported NOT EXECUTED | | | |
| G7 contracts | n/a | checks 4-5 | n/a | n/a (no contract file) |
| G9 quality | `git diff --check` | check 6 | check 2 | checks 6, 8 |
| G10 ownership | no R11 path written | same | `reference/**` untouched (check 3) | `golden/bim_baseline/**` untouched (check 9) |
| G11 review | reviewer | **high**: reviewer, test-reviewer, security-auditor, arch-reviewer (`project.yaml:145`) | medium: reviewer, test-reviewer | **high**: the same panel. arch-reviewer decides on the copy vs pin-in-place question (Q2) |
| G12 lab | n/a | lab: submit a minizinc-csp job that its engine refuses (soft-constraint fixture), then `GET /v1/jobs/{id}` shows `code: engine_incompatible` | `run.sh pilot` (2 instances × 3 engines) against the lab, if the coordinator schedules it | n/a |
| G13 package | how-to-review | how-to-test, 2 API examples (422 → `engine_incompatible`, 503 → `engine_rejected` via a stub) | how-to-test (pilot) or how-to-review | how-to-review |

## 7. Decisions needed (CRPs) and step R

**Contract files.** Both `docs/openapi.json` and `docs/ERRORS.md` change only in S1.
- The schema delta (`code` and `correlationId` declared on `GatewayBindingResult`) is **compatible**. It is a new
  optional response field that the gateway already sends (F4). Under the owner request it needs **no CRP**.
- The new catalog entry is additive. **Re-coding the engine 422 from `engine_rejected` to `engine_incompatible` is not
  purely additive.** A client that reads `result.code == "engine_rejected"` for such a job sees a new value
  (openapi-contracts: "changing ... error codes" is breaking). This is **CRP-1**.

**CRP-1: how the engine 422 is re-coded.** Options:
(a) switch it to `engine_incompatible` and note it in the changelog and `docs/ERRORS.md`. The only known client is
QACOBench, and the frontend does not switch on job codes (F18);
(b) expand/contract: keep `code: engine_rejected` and add a field `reason: engine_incompatible` to the failed-job
result, then retire `engine_rejected` for 422 in a later release;
(c) (a) plus a one-release note in `docs/ERRORS.md` that `engine_rejected` no longer covers 422.
Recommended: **(a)**. It is what the owner asked for ("instead of `campaign.py` parsing messages"), and (b) adds a field
that only exists to be removed. If the owner counts third-party API clients, choose (c).

**CRP-2: release 1.1.2 (step R, not a slice).** After S1-S3 are merged and `develop` is green: re-run the full campaign
(46,350 executions at 5,000 ms, `openspec/specs/qacobench-experimentation/spec.md:11`) on `develop` in the lab, write
`experimentation/qacobench/reference/1.1.2/`, bump `tools/package_zenodo.sh:22` and `output/zenodo/**` to 1.1.2,
release PR to `main` (owner merges), Zenodo upload by the owner (`project.yaml:176` forbids factory calls to Zenodo).
Owner decisions: whether to release at all, the lab time budget, and the tolerance for O3 (`qacobench spec:126`, still
open). `reference/1.1.1/**` stays byte-identical, and R's own check is S2 check 3 widened to `reference/1.1.1`.

**For the coordinator (no owner decision):**
- Q1: `openspec/**` is held by another lead. S0 needs `openspec/changes/m08-qacobench-baseline/**` (a new directory, no
  shared file). Either the holder releases that subpath or S0 waits.
- Q2 (arch-reviewer in S3): byte-copy a new frozen directory (recommended; it follows the `bim_normalized` precedent,
  `DIGESTS.md:265-268`) or pin `golden/bim_core/{compat,protocol}.json` in place as frozen (no 3,005-line copy, but it
  mixes "regenerable regression pin" and "frozen" in one directory and changes `baseline_core.main()` targets).
- Q3: the `evidence` member of the failed-job result is undeclared too (F4). It is a separate followup, or S1 can take
  it if the coordinator accepts the extra contract line.

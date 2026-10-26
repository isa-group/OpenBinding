# Handoff: m08-qacobench-baseline
- Status: waiting-review (plan ready; no code written) · Updated: 2026-10-26T00:00:00Z
- Branch / head: task/079f4adf1793484e / base 99697d7e · PR: none
- Owner request: own-033e9b12c03448b28e474e292072c32c (2026-10-24) · Roadmap: `ROADMAP.md:44` (M0.8)
- Plan: `docs/agent-work/m08-qacobench-baseline/intake.md` (facts F1-F20 with file:line, slices, checks, gates, CRPs)

## Goal
Capability refusals reach API clients as their own job-failure code `engine_incompatible`, and QACOBench classifies
them by code. minizinc-csp 1.1.1 gets a frozen golden baseline and `CHANGED_MANIFESTS` is removed.
`reference/1.1.1` stays unchanged. Releasing 1.1.2 is a separate owner step.

## State (with evidence)
- Planning done, read-only, at 99697d7e. No checks are registered for this task, so none were run.
- Root cause confirmed. The gateway codes every engine refusal `engine_rejected` (`v1/remote.py:457-459`) and stores
  only the catalog sentence (`core/public_errors.py:219`, `services/execution.py:76-87`). `campaign.py` still matches
  the old message prefix (`experimentation/qacobench/campaign.py:110,120`), so job-level capability refusals are
  recorded as `ERROR` today.
- Contract drift found. The OpenAPI `GatewayBindingResult` (`main.py:930-943`, `docs/openapi.json:7231-7261`,
  `additionalProperties: false`) does not declare the `code`/`correlationId` that failed jobs already carry.
- The exception lives only in `bim-toolchain` (`tools/baseline_core.py:129,1371-1376`; `test_baseline_equivalence.py:
  17-19,129-136,263-280,288-289`; `docs/DIGESTS.md:88-94`; living spec `schema-versioning/spec.md:27`).

## Decisions
- Four units: S0 spec deltas; S1 gateway (`remote.py`, `JOB_FAILURES`, `GatewayBindingResult`, regenerated
  `docs/openapi.json`, `docs/ERRORS.md`); S2 `campaign.py`; S3 bim-toolchain frozen baseline. S1, S2 and S3 run in
  parallel after S0, with disjoint files — reason: no shared file, and each slice is correct alone (F7: the prefix
  branch is already dead, so S2 before S1 changes nothing for job-level refusals).
- No feature flag — reason as above.
- Only an engine **422** becomes `engine_incompatible`. Other refusals stay `engine_rejected` — reason:
  `engine-protocol/spec.md:27` defines 422 as "not supported by the requested mode", and the gateway validates
  requests first.
- `code` is declared as `type: string` with no enum — reason: adding a value to a response enum later is breaking.
- At submission, the campaign counts only `engine_mode_incompatible` as `INCOMPATIBLE`. Other 422s become `ERROR` —
  reason: F8, a `validation_error` must not hide as an incompatibility (verdict integrity, O2).
- S3 adds a new frozen directory `golden/bim_baseline_1_1_1/`, a byte copy of `golden/bim_core/{compat,protocol}.json`,
  pinned by SHA-256 in its own test and compared by identifier with the 0.1.x frozen baseline through a reviewed list of
  minizinc-csp moves — reason: this is the precedent in `DIGESTS.md:265-268`. `golden/bim_baseline` and
  `golden/ir_previous` are never written.
- S3 does not extend `regen_normalized_metadata.FROZEN` — reason: extending it would force regenerating
  `golden/toolchain_metadata_comparison.json` and the gateway copy, both outside S3's capability.
- The engine's 422 text stays log-only — reason: `req~job-execution-failure-catalog~1`.

## Ruled out
- Making `campaign.py` match the new catalog sentence. That is message parsing again, which is exactly what the owner
  asked to remove.
- Exposing the engine detail in the job result. It contradicts the failure-catalog requirement and the security review.
- Editing `golden/bim_baseline` or `reference/1.1.1`. Both are frozen by rule and by test.

## Open questions and risks
- CRP-1 (owner): re-coding engine 422 from `engine_rejected` to `engine_incompatible` changes an error code clients may
  read. Options (a) switch, (b) expand/contract with a `reason` field, (c) switch plus a one-release note.
  Recommended (a). It blocks S1, and S2 only for the code name.
- CRP-2 (owner): release 1.1.2 (step R): a full re-run of 46,350 executions in the lab, `reference/1.1.2`, version
  bumps in `tools/package_zenodo.sh` and `output/zenodo/**`, a release PR, and the Zenodo upload by the owner. The O3
  tolerance is still undefined.
- Coordinator Q1: `openspec/**` is held by another lead. S0 needs `openspec/changes/m08-qacobench-baseline/**`.
- Coordinator Q2 (arch-reviewer): copy the files into a new frozen directory (recommended), or pin
  `golden/bim_core/*` in place.
- Coordinator Q3: `evidence` in the failed-job result is undeclared too. It is a followup, or S1 takes it.
- Risk: S3 assumes 1.1.1 only widened minizinc-csp compatibility. Its test (c) proves it. If a pair went from
  `compatible: true` to `false`, S3 stops and reports.
- Risk: the bim-toolchain checks need the BPMN XSDs, which are not in Git. S3 check 1 detects their absence, and they
  are never downloaded from a check.
- Risk: new campaigns lose construct-level detail for job-level refusals. The capability matrix keeps the
  pre-job diagnostics (F9).
- Risk: the S3 fixture copy is 3,005 lines, over the size rule. It is justified as a byte copy pinned by checksum
  (intake §4).

## Next three steps
1. Coordinator: send CRP-1 and CRP-2 to the owner, using the options and recommendations in intake §7. Get
   `openspec/changes/m08-qacobench-baseline/**` released for S0.
2. Specifier (S0): write the OpenSpec change. In `job-execution`, modify `req~job-execution-failure-catalog~1` (the 422
   scenario becomes `engine_incompatible`) and add `req~job-execution-engine-incompatible~1`. In
   `qacobench-experimentation`, revise `req~qacobench-experimentation-incompatible-is-data~1` to classify by code. Write
   the bim-toolchain change revising `req~bim-schema-versioning-goldens~1` with no `CHANGED_MANIFESTS`. Validate with the
   S0 checks.
3. Coordinator: open S1, S2 and S3 as tasks with the owned files, read-only context, check argv arrays and panels of
   intake §4-§6. S1 waits for CRP-1. S2 and S3 can start as soon as S0 is validated.

## Evidence
- Tasks: 079f4adf1793484e (this planning task) · Heads: base 99697d7e · CI: not run (planning only, no registered checks)

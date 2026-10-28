# Proposal: m08-qacobench-baseline

## Why

ROADMAP M0.8 (`ROADMAP.md:44`, owner request own-033e9b12c03448b28e474e292072c32c). The gateway codes every engine
refusal of a running job `engine_rejected` and stores only its catalog sentence, so QACOBench, which still matches the
old message prefix, records job-level capability refusals as `ERROR` (intake F3, F7). At submission it treats every
422 as `INCOMPATIBLE`, including `validation_error` (F8).

## What changes

- `qacobench-experimentation`: `req~qacobench-experimentation-incompatible-is-data` goes to revision 2. The runner
  classifies by code only (`engine_incompatible` for a failed job, the top-level `code` `engine_mode_incompatible` of
  the RFC 7807 problem document for a submission 422) and never parses message text. This resolves in part the
  living spec's TODO on job-level rejections; the `reference/1.1.1` provenance TODO stays open.
- `job-execution`: `req~job-execution-failure-catalog` goes to revision 2 because the observable outcome of its
  engine-422 scenario changes to `engine_incompatible`, and the new `req~job-execution-engine-incompatible~1` defines
  when that code is used.
- The frozen golden baseline for minizinc-csp 1.1.1 is a separate change in the bim-toolchain root:
  `bim-toolchain/openspec/changes/m08-frozen-manifest-baseline`.

## Out of scope

- **The gateway implementation (slice S1)**: `v1/remote.py`, `core/public_errors.py`, the `GatewayBindingResult`
  schema in `main.py` and `docs/openapi.json`, and `docs/ERRORS.md`. Re-coding the engine 422 is an error-code change
  for API clients and needs the owner's decision **CRP-M08-1** (this change assumes option (a) or (c): the code is
  literally `engine_incompatible`). The `job-execution` and `qacobench-experimentation` deltas are archived
  together, after CRP-M08-1 is answered and S1 is merged, not before.
- Re-running QACOBench as 1.1.2 and changing `reference/1.1.1` (owner step, **CRP-M08-2**). `reference/1.1.1` stays
  byte-identical. The re-run needs S1: until the gateway emits `engine_incompatible`, a job coded `engine_rejected`
  is recorded `ERROR` and an `ERROR` result stops the campaign (`campaign.py` raises on `ERROR`).
- Editing the living specs; archiving is a later owner-approved task.

## Impact

- Specs: `qacobench-experimentation`, `job-execution`.
- Code (later slices): S1 gateway (after CRP-M08-1), S2 `experimentation/qacobench/campaign.py`.
- Risk: S2 before S1 changes nothing for job-level refusals (they are already `ERROR`), and tightens submissions.

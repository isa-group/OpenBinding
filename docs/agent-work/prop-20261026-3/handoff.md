# Handoff: prop-20261026-3
- Status: waiting-review (intake written; CRP-1 to raise) · Updated: 2026-10-26
- Branch / head: task/d56d175505c04128 / base 212b9662 · PR: none

## Goal
Measure INTENT O9 (`INTENT.md:170`: p95 `POST /v1/jobs` accept ≤ 500 ms, `POST /v1/validate` ≤ 2 s, corpus-size
packages, lab) and record a dated report, so the owner can confirm or change D7 (`INTENT.md:251`).

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261026-3/intake.md` (evidence F1-F16, slices, gates, questions).
- Confirmed: the only p95 measurement is `/healthz` of the bim-service (`openbinding-gateway/tools/process_probe.py:683,1408,1419`).
  Its validate calls `/bim/v1/validate`, not the gateway (`process_probe.py:71,74`).
- Corrected: the O9 row is `INTENT.md:170` (the proposal says 169). `docs/DEFINITION_OF_DONE.md` does not mention O9.
- Placement: the tool must be `openbinding-gateway/tools/latency_probe.py`. Lab tools run as `python tools/${DEMO_SEED_TOOL}`
  in the gateway image (`compose.lab.json:365`, `openbinding-gateway/Dockerfile:65`). The seed container cannot write
  `docs/qa/` (`compose.lab.json:408-421`).
- Test placement: `openbinding-gateway/tests/`, because `gateway-unit` only collects `tests`
  (`openbinding-gateway/pyproject.toml:80`).
- No code or check was written or run.

## Decisions
- D1: two slices, S1 tool + test, then S2 lab run + report. Reason: the tool runs in a container that cannot write into the repo,
  and the report needs a lab run of the merged tool.
- D2: no feature flag. Reason: no product behaviour; S1 is harmless alone.
- D3: both slices low risk. Reason: their files match no risk-area glob (`.agentic/project.yaml:105-139`).
- D4: time only the request and cancel each accepted job before the next accept. Reason: the per-account limit is
  3 in the lab (`compose.lab.json:397`), and engine time is not part of "accept".
- D5: the unit test injects durations and makes no wall-clock assertion. Reason: the B8 timing tests are recorded as
  flaky (`docs/qa/FLAKY_TESTS.md`).

## Ruled out
- Extending `process_probe.py`: it talks only to the bim-service and is already about 1700 lines.
- Timing in unit tests (the proposal's own alternative): not representative of the lab, and flaky.
- The root `tools/` folder: not copied into the gateway image, so it cannot run through `lab_compose seed`.

## Open questions and risks
- CRP-1 (owner): which accept variant (snapshot JSON, ZIP, or both), what "corpus-size packages" means, and the
  conditions (sequential, idle lab). Recommended: both variants, the top 3 examples by size, sequential.
- Q1-Q5 (coordinator): samples/warm-up, a summary-only JSON (`INTENT.md:189`), the synthetic user, importing
  `percentile`, the gateway's own concurrency value.
- Risk: SPACE in the lab answers `503 pricing_unavailable` and blocks both routes (F5/F7). Mitigation: exit 3,
  blocked as in `smoke_lab.py:10-16`, and the report says so.
- Risk: the targets are missed. That is a measurement result: report it, open a followup, change no target.

## Next three steps
1. Coordinator: raise CRP-1 with the options in `intake.md` section 7, answer Q1-Q5, and open the OpenSpec change if G1 is wanted.
2. Implementer: S1 per `intake.md` section 4 with checks 1-5 (red-before needs the loader assertion described there).
3. After S1 merges: rebuild the lab, run `latency_probe.py` through `lab_compose seed`, and give the stdout to the S2 doc-steward.

## Evidence
- Tasks: this intake (planner, no checks registered or run) · Heads: 212b9662 · CI: none run for this intake.

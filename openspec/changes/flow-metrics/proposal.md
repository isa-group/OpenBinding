# Change: flow-metrics

## Why

INTENT objectives O6 (`develop` CI green on 95 % of days or more; no flaky test older than 7 days) and O7 (median change
at most 300 diff lines, merged the day it is ready) are marked "not measured". Facts and sources:
`docs/agent-work/prop-20261102-3/intake.md`.

## What Changes

- A read-only, stdlib-only tool, `tools/flow_metrics.py`, reads the runs of `ci.yml` on `develop` from the GitHub REST
  API and the flaky register, and prints a dated page.
- Slice S1 (this change's first slice): O6 green days and flaky age. The page says O7 is "not measured yet".
- Slice S2: O7 change size and ready-to-merge lag. Slice S3: the first dated page, run by the owner (CRP-1).
- Defaults taken from the intake: a green day is a UTC day whose last completed, not-cancelled run concluded `success`
  (CRP-2); register ids E2 and E3 are left out through `--not-counted` (Q4); the window is 30 days ending yesterday
  (Q5); both size figures are reported (CRP-3).

## Impact

- Capability: `gate-tooling` only. Added: `req~flow-metrics-green-days~1`, `req~flow-metrics-flaky-age~1`,
  `req~flow-metrics-change-size~1`, `req~flow-metrics-ready-lag~1`, `req~flow-metrics-page~1`,
  `req~flow-metrics-read-only~1`.
- Code: `tools/flow_metrics.py`, `lab/tests/test_flow_metrics_o6.py` and its fixtures (S1); S2 adds O7 files.
- No workflow, API, schema, dependency or runtime change. Nothing in CI calls the tool.

## Out of scope

- Any workflow or schedule that runs the tool (`.github/**`, R10; CRP-1 is the owner's).
- Edits to `INTENT.md` or `docs/qa/FLAKY_TESTS.md`.
- O7's clause on previews of UI and runtime changes.

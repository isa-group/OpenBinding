# Tasks: flow-metrics

Slices run in series: S1 and S2 edit the same file.

## S1 O6 and the tool skeleton (implementer, medium)
- [x] 1.1 `tools/flow_metrics.py`: GET-only client pinned to `api.github.com` (pagination included, redirects refused,
      token from `GH_TOKEN` or `GITHUB_TOKEN`, never printed) (`req~flow-metrics-read-only~1`).
- [x] 1.2 O6 green days (`req~flow-metrics-green-days~1`) and flaky age with `--not-counted`
      (`req~flow-metrics-flaky-age~1`).
- [x] 1.3 Page renderer with the O6 section and "Not measured yet." for O7; `--as-of`, `--output`, default window
      (`req~flow-metrics-page~1`).
- [x] 1.4 `lab/tests/test_flow_metrics_o6.py` on synthetic fixtures in `lab/tests/fixtures/flow_metrics/o6/`.
- Files: `tools/flow_metrics.py`, `lab/tests/test_flow_metrics_o6.py`, `lab/tests/fixtures/flow_metrics/o6/**`.
  Checks: `--help` under `python3 -I`, targeted pytest, ruff, bim-guard, `git diff --check`.

## S2 O7 (implementer, medium)
- [ ] 2.1 Merged PRs into `develop`, files, both size figures and their medians (`req~flow-metrics-change-size~1`).
- [ ] 2.2 `ready_for_review` events, median hours to merge, same-day share (`req~flow-metrics-ready-lag~1`).
- [ ] 2.3 O7 section of the page; tests and fixtures in `lab/tests/test_flow_metrics_o7.py`.

## S3 First page (owner's run, doc-steward)
- [ ] 3.1 Run the tool over the agreed window and commit `docs/qa/FLOW_METRICS.md` (CRP-1).

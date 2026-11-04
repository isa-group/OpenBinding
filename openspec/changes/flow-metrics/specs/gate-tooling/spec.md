## ADDED Requirements

### Requirement: Green days of develop CI
WHEN `tools/flow_metrics.py` runs over a window of UTC days, THE tool SHALL read the runs of `ci.yml` on `develop` with event `push` or `workflow_dispatch`, ignore cancelled, skipped and unfinished runs, count a day as green IF its last remaining run by `created_at` concluded `success`, and report green days, days with runs, days without runs (left out of the denominator), the days not green and the run count per event.

`req~flow-metrics-green-days~1`

Evidence (planned, slice S1): lab/tests/test_flow_metrics_o6.py

#### Scenario: A day with a failed run followed by a success
- **GIVEN** a day with a `failure` run at 08:00 and a `success` run at 10:00
- **WHEN** the tool counts green days
- **THEN** that day is green

#### Scenario: A cancelled run does not change the day
- **GIVEN** a day with a `success` run at 09:00 and a `cancelled` run at 11:00
- **WHEN** the tool counts green days
- **THEN** that day is green

#### Scenario: A day without runs
- **GIVEN** a window day with no counted run
- **WHEN** the tool counts green days
- **THEN** it is listed under days without runs and is not in the denominator

### Requirement: Age of flaky register entries
WHEN `tools/flow_metrics.py` reads the flaky register, THE tool SHALL classify each row whose status starts with `open` or `deselected`, except the ids given in `--not-counted` (default `E2,E3`), as older than 7 days, within 7 days, or unknown date, measuring against `--as-of` (default today, UTC).

`req~flow-metrics-flaky-age~1`

Evidence (planned, slice S1): lab/tests/test_flow_metrics_o6.py

#### Scenario: Dated and undated entries
- **GIVEN** open entries first seen 12 days, 4 days and 7 days before the as-of day, and one with no date
- **WHEN** the tool classifies them
- **THEN** the first is older than 7 days, the second and third are within 7 days, and the last is unknown date

#### Scenario: Fixed and not-counted entries
- **GIVEN** a `fixed` entry and an entry listed in `--not-counted`
- **WHEN** the tool classifies the register
- **THEN** neither appears in any class

### Requirement: Size of merged changes
WHEN `tools/flow_metrics.py` measures O7, THE tool SHALL report, per pull request merged into `develop` in the window, additions plus deletions excluding generated paths, and excluding generated and test paths, with the median of each and the share at or under 300 lines.

`req~flow-metrics-change-size~1`

Evidence (planned, slice S2): lab/tests/test_flow_metrics_o7.py

#### Scenario: Two size figures
- **GIVEN** a merged pull request that changes a generated file, a test file and a source file
- **WHEN** the tool measures its size
- **THEN** the first figure excludes the generated file and the second excludes the generated and the test file

### Requirement: Ready-to-merge lag
WHEN `tools/flow_metrics.py` measures O7, THE tool SHALL take as ready time the last `ready_for_review` event before `merged_at`, or `created_at` for a pull request that was never a draft, and report the median hours to merge and the share merged on the same UTC day.

`req~flow-metrics-ready-lag~1`

Evidence (planned, slice S2): lab/tests/test_flow_metrics_o7.py

#### Scenario: A draft made ready
- **GIVEN** a pull request created as a draft, marked ready at 09:00 and merged at 15:00 the same day
- **WHEN** the tool measures the lag
- **THEN** the lag is 6 hours and the pull request counts as merged the same day

### Requirement: Dated flow metrics page
WHEN `tools/flow_metrics.py` finishes, THE tool SHALL write one Markdown page to `--output` or standard output with the repository, the window (default the 30 days ending yesterday, UTC), the as-of day, the O6 figures, and for O7 either the figures or the text "Not measured yet.", and SHALL hold counts, ids and PR numbers only, with no logins and no token.

`req~flow-metrics-page~1`

Evidence (planned, slice S1): lab/tests/test_flow_metrics_o6.py

#### Scenario: Default window
- **GIVEN** today is 2026-11-01 and no `--since` or `--until`
- **WHEN** the tool runs
- **THEN** the window is 2026-10-02 to 2026-10-31

#### Scenario: A failed request
- **GIVEN** the API answers HTTP 500
- **WHEN** the tool runs
- **THEN** it exits non-zero and writes no page

### Requirement: Read-only access to the GitHub API
THE tool `tools/flow_metrics.py` SHALL use the standard library only, send only `GET` requests to `https://api.github.com` (including pages named by a `Link` header), refuse redirects, read a token only from `GH_TOKEN` or `GITHUB_TOKEN`, and never print or write the token.

`req~flow-metrics-read-only~1`

Evidence (planned, slice S1): lab/tests/test_flow_metrics_o6.py

#### Scenario: A Link to another host
- **GIVEN** a response whose `Link` header names `rel="next"` on another host
- **WHEN** the tool paginates
- **THEN** it fails without requesting that URL

#### Scenario: A redirect
- **GIVEN** the API answers with a redirect
- **WHEN** the tool requests a page
- **THEN** it fails and does not follow the redirect

#### Scenario: Token in the environment
- **GIVEN** `GITHUB_TOKEN` is set
- **WHEN** the tool runs
- **THEN** the requests carry it and neither the page, standard output nor standard error contains it

#### Scenario: No third-party packages
- **GIVEN** the interpreter runs in isolated mode outside the gateway environment
- **WHEN** `tools/flow_metrics.py --help` runs
- **THEN** it exits 0

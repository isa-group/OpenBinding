# Flaky /healthz bound under CPU load (bim-service, B8 switch interval)

## Symptom

`test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load`
(`bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_probe.py`) failed intermittently on a shared CI
runner: `/healthz` median 44.8 ms against the absolute bound `statistics.median(latencies) < 0.03`.
The sibling `test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval`
(`bim-toolchain/packages/bim-service/tests/test_execution_in_the_pool.py`) had the same absolute bound under the same
load.

## Cause

The bound was an absolute time. The test puts 4 CPU-bound threads in the pool and measures how long the event loop
takes to answer `/healthz`. On a shared runner, CPU contention from other jobs makes every request slower
regardless of the GIL switch interval, so a fixed 30 ms is machine-dependent: loose on a quiet machine (3.6-6.4 ms
measured at 0.1 ms) and too tight on a loaded one. The switch interval still has the effect the test is meant to
pin; only the yardstick was wrong.

## Decision (superseded by the second decision; the 0.5 factor no longer applies)

Replace the absolute bound with a comparison against a baseline measured in the same run:

- A helper `median_latency(interval)` runs the same scenario (4 CPU-bound operations, 15 calls to `/healthz`) and
  returns the median.
- Baseline: the default interval (what the xfail sibling in the analysis file exercises). Short: 0.1 ms.
- 3 interleaved rounds (default, short, default, short, ...) so slow periods of the runner hit both sides; each side
  keeps its best median.
- Assertion: `best_short < 0.5 * best_default`. The failure message lists every median.
- `sys.setswitchinterval` is always restored in `finally`.

In `test_execution_in_the_pool.py` the same approach: the baseline app is created without `switch_interval_seconds`
(the lifespan leaves the interval alone), the short one with `switch_interval_seconds=0.0001`. The docstring that
referred to the old analysis bound was updated.

Why 0.5: the documented figures give about 1/15-1/30 on a quiet machine (94-118 ms against 3.6-6.4 ms), so 1/2 is a
wide margin for noise, and the test still fails if the interval has no effect.

Alternatives rejected: raising the absolute bound (still machine-dependent, looser on quiet machines); one round per
side (one noisy round still fails); best-of-N with an absolute bound (still depends on runner speed).

Cost: 6 runs per test (3 default, 3 short), an estimated 7-8 s per test (not measured), dominated by the three
default-interval runs where each `/healthz` takes about 100 ms under the load.

## Second decision: relax the comparison (CRP crp-b8-latency-threshold, answer 'relax')

CI evidence: the same-run comparison `best_short < 0.5 * best_default` failed.

- Analysis test: 0.1 ms interval 17.8 ms against 8.1 ms for the default 5 ms.
- Pool test: 16.1 ms with the configured interval against 11.6 ms without it.

On a shared runner the interval did not give the expected speed-up, so the factor 0.5 is not a reliable bound. The
owner chose to relax it. Both assertions now require only that the short interval is not worse than the default:
`best_short <= 1.5 * best_default`; the failure message still lists every median. The speed-up (94-118 ms down to
a few ms on a quiet machine) is documented in the docstrings, not enforced. The comments and docstrings that said the
interval "keeps healthz fast" now state this weaker property. Test names are unchanged because other documents refer
to them. No production code and no other test changed. Not run in the worker (no pytest); CI is the verification.

## Third decision: skip when the default interval shows no contention (review round 1, R1-REV-001)

The reviewer found that the 1.5 factor sits inside CI noise: 17.8 ms (0.1 ms interval) against 8.1 ms (5 ms), ratio
2.2, and 16.1 ms against 11.6 ms (1.39). On the runner the default median is only 8-12 ms (94-118 ms locally), so
there is no GIL contention for the short interval to relieve and the comparison says nothing there.

Both tests now call `pytest.skip` (message with all medians) when `best_default < 0.02 s`, before the assertion;
otherwise they keep `best_short <= 1.5 * best_default`. The 0.02 s threshold was chosen by the coordinator on that
evidence and is to be confirmed by the owner. The docstrings now say the speed-up is "documented here, not enforced"
(R1-REV-002; nothing is logged). Test names are unchanged.

## Scope

Test code only; no production code changed.

## Verification

Not executed in the worker (no pytest in its environment). The verification is the `bim-toolchain` job of CI: both
tests must pass or skip there (skip when the default median is under 20 ms). When the comparison runs, a failure
message lists the default and short medians of every round, which is the data needed to adjust the 1.5 factor or
the 0.02 s threshold.

#!/bin/sh
# Entry point of the `e2e` service of compose.lab.json (image: frontend/Dockerfile.e2e).
#
#   DEMO_E2E=1  run the specs of e2e/live (and their visual QA) against $BASE_URL, print a summary, then stay alive.
#   otherwise   only say so.
#
# Either way it ends by creating $E2E_RESULTS_DIR/done and sleeping: the healthcheck of the service is "done exists",
# so `docker compose up --wait` neither fails on a stopped container nor returns before the run is over.
# What is written under the results directory (a named volume the controller cannot open) is:
#   done  report.json  screenshots/<desktop|mobile>-<page>.png  visual-qa-<desktop|mobile>.json  test-output/ (traces of failures)
# The log is what reaches the controller: the `list` reporter, the lines `VQA ...` of the visual QA and, from summary.mjs and in the last
# lines (the only ones the controller is sure to see), E2E_FAILED / E2E_FAILED_DETAIL per failed test, every VQA_PROBLEM between
# VQA_PROBLEMS_BEGIN and VQA_PROBLEMS_END, and E2E_SUMMARY as the last of them.

RESULTS="${E2E_RESULTS_DIR:-/results}"
cd "$(dirname "$0")/../.." || exit 1

# A previous run leaves its files in the volume: its `done` would make this run look finished at once.
rm -f "$RESULTS/done" "$RESULTS/report.json"
rm -rf "$RESULTS/screenshots" "$RESULTS/test-output"
rm -f "$RESULTS"/visual-qa-*.json

if [ "${DEMO_E2E:-0}" = "1" ]; then
  mkdir -p "$RESULTS/screenshots"
  echo "e2e: live specs against ${BASE_URL:-http://web:8080}, results in $RESULTS"
  pnpm exec playwright test -c playwright.live.config.ts
  echo "e2e: playwright exited with code $?"
  node e2e/live/summary.mjs "$RESULTS/report.json"
else
  echo "E2E_SKIPPED reason=DEMO_E2E_is_not_1"
fi

touch "$RESULTS/done"
echo "e2e: done"

# Stay alive, and leave at once when asked to stop (a plain `sleep` as PID 1 ignores SIGTERM).
trap 'exit 0' TERM INT
sleep infinity &
wait

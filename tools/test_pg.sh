#!/bin/sh
# Run the PostgreSQL concurrency tests against a throwaway database.
#
# Usage: [DEMO_PYTEST_ARGS='-rfE --tb=short tests/concurrency'] sh tools/test_pg.sh
#
# This mirrors the official harness, lab_compose with file=compose.pgtest.json (see
# docs/qa/PG_HARNESS.md): `up` builds the `test` stage of the gateway image and waits for a
# healthy postgres, then the `seed` service (behind a profile) migrates and runs pytest, and
# its exit code is the script's. The database is in tmpfs and publishes no port.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/compose.pgtest.json"

DEMO_PYTEST_ARGS="${DEMO_PYTEST_ARGS:--rfE --tb=short tests/concurrency}"
export DEMO_PYTEST_ARGS

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

status=0
compose up --build --detach --wait postgres image-builder || status=$?
if [ "$status" -eq 0 ]; then
  compose run --rm --no-deps seed || status=$?
fi
exit "$status"

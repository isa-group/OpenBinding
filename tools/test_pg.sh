#!/bin/sh
# Run the PostgreSQL concurrency tests against a throwaway database.
#
# Usage: sh tools/test_pg.sh
#
# Everything (database, credentials, test command) lives in compose.pgtest.json;
# this only starts it, propagates pytest's exit code and removes the containers.
# The database is in tmpfs and publishes no port.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/compose.pgtest.json"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

status=0
compose up --build --abort-on-container-exit --exit-code-from runner || status=$?
exit "$status"

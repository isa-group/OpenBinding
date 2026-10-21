#!/bin/sh
# Run the PostgreSQL-only concurrency tests the way lab_compose does.
#
# Nothing here touches docker-compose.yml or any named volume: compose.pgtest.json
# keeps the database in a tmpfs, so removing the project afterwards loses nothing.
#
#   up postgres (waits for the healthcheck)  ->  run --rm seed  ->  down
#
# The `seed` service applies `alembic upgrade head` and then runs
# `pytest tests/concurrency`; its exit code is pytest's, and so is this script's.
set -u

here=$(cd "$(dirname "$0")" && pwd)
repo_root=$(dirname "$(dirname "$here")")
compose="docker compose -f $repo_root/compose.pgtest.json"

cleanup() {
    $compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

$compose up --detach --wait postgres || exit 1
$compose run --rm --no-deps seed
status=$?
exit "$status"

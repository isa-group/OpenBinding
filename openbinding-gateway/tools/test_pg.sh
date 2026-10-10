#!/bin/sh
# Run the PostgreSQL-only concurrency tests against the compose postgres.
#
# Nothing destructive: it starts the service (no volumes are removed), creates
# the openbinding_test database if missing, and runs pytest on it.
#
# NOTE: the compose `postgres` service does not publish port 5432. Either run
# this script inside the compose network (so localhost is not what reaches it),
# or, for local use, publish the port to 127.0.0.1 yourself (for example with
# a docker-compose.override.yml mapping "127.0.0.1:5432:5432"). docker-compose.yml
# is deliberately not modified by this script.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
gateway_dir=$(dirname "$here")
repo_root=$(dirname "$gateway_dir")

DB_USER=${POSTGRES_USER:-openbinding}
TEST_DB=openbinding_test

cd "$repo_root"
docker compose --profile dev up -d postgres

tries=0
until docker compose --profile dev exec -T postgres pg_isready -U "$DB_USER" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
        echo "postgres did not become ready" >&2
        exit 1
    fi
    sleep 2
done

exists=$(docker compose --profile dev exec -T postgres \
    psql -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$TEST_DB'")
if [ "$exists" != "1" ]; then
    docker compose --profile dev exec -T postgres \
        psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $TEST_DB"
fi

cd "$gateway_dir"
TEST_DATABASE_URL="postgresql+asyncpg://openbinding:openbinding@localhost:5432/$TEST_DB" \
    exec pytest -q tests/concurrency

#!/bin/sh
# Bring the schema up to date, then serve.
#
# Migrating here rather than in a separate step means a container can never be
# serving against a schema older than the code inside it. A gateway with no
# DATABASE_URL has no schema to migrate and starts exactly as it always did.
#
# It runs as the unprivileged image user (UID 10001): no chown, su or gosu, and nothing
# is written outside the paths that user owns (ARTIFACT_ROOT, /run/bim).
set -e

if [ -n "${DATABASE_URL}" ]; then
    echo "Applying database migrations..."
    alembic upgrade head
fi

exec "$@"

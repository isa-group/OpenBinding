#!/bin/sh
# Bring the schema up to date, then serve.
#
# Migrating here rather than in a separate step means a container can never be
# serving against a schema older than the code inside it. A gateway with no
# DATABASE_URL has no schema to migrate and starts exactly as it always did.
set -e

if [ -n "${DATABASE_URL}" ]; then
    echo "Applying database migrations..."
    alembic upgrade head
fi

exec "$@"

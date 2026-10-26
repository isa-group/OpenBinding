#!/bin/sh
# Bring the schema up to date, then serve.
#
# Migrating here rather than in a separate step means a container can never be
# serving against a schema older than the code inside it. A gateway with no
# DATABASE_URL has no schema to migrate and starts exactly as it always did.
#
# OPENBINDING_MIGRATE picks what happens: auto (the default) migrates when DATABASE_URL
# is set, skip never migrates, only migrates and exits without running the command.
#
# A secret can come from a file: <NAME>_FILE names a regular file whose content, without
# its trailing newline, becomes NAME. Setting both NAME and <NAME>_FILE is an error, and
# no message ever carries a value.
#
# It runs as the unprivileged image user (UID 10001): no chown, su or gosu, and nothing
# is written outside the paths that user owns (ARTIFACT_ROOT, /run/bim).
set -e

mode="${OPENBINDING_MIGRATE:-auto}"
case "$mode" in
    auto | skip | only) ;;
    *)
        echo "OPENBINDING_MIGRATE must be auto, skip or only (got: $mode)" >&2
        exit 2
        ;;
esac

for name in DATABASE_URL GATEWAY_JWT_SECRET SPACE_API_KEY SPHERE_API_KEY \
    SECRETS_FERNET_KEYS FEDERATION_SECRET_KEY BOOTSTRAP_ADMIN_PASSWORD; do
    eval "file=\${${name}_FILE:-}"
    [ -n "$file" ] || continue
    eval "value=\${${name}:-}"
    if [ -n "$value" ]; then
        echo "${name} and ${name}_FILE are both set; set only one" >&2
        exit 2
    fi
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
        echo "${name}_FILE is not a readable regular file" >&2
        exit 2
    fi
    value=$(cat "$file") || {
        echo "${name}_FILE could not be read" >&2
        exit 2
    }
    export "${name}=${value}"
done

if [ "$mode" = only ] && [ -z "${DATABASE_URL}" ]; then
    echo "OPENBINDING_MIGRATE=only needs DATABASE_URL" >&2
    exit 2
fi

if [ "$mode" != skip ] && [ -n "${DATABASE_URL}" ]; then
    echo "Applying database migrations..."
    alembic upgrade head
fi

[ "$mode" != only ] || exit 0

exec "$@"

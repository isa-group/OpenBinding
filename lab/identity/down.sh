#!/usr/bin/env bash
# Stop the SCORETech Identity lab and delete its volumes (its own `./lab down` keeps them).
set -Eeuo pipefail
docker compose -p scoretech-identity-lab down --volumes --remove-orphans

#!/usr/bin/env bash
# Wrapper to execute the development database seeder for OpenBinding.
#
# Usage:
#   ./tools/seed_dev.sh [--reset] [--verbose]
#   ./tools/seed_dev.sh --analysis-only     # additive, no engine calls
#   ./tools/seed_dev.sh --analysis-full     # live jobs + up to 100,000 unique bindings
#   Both write tools/analysis-manifest.json in the gateway directory.
#
# It automatically detects whether to run locally (if Python environment is ready)
# or via Docker Compose (executing inside the running `gateway-dev` container).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Check if Docker compose is running gateway-dev
if docker compose ps --services --filter "status=running" 2>/dev/null | grep -q "^gateway-dev$"; then
  say "Running dev seeder inside Docker container 'gateway-dev'..."
  docker compose exec -T gateway-dev python tools/seed_dev.py "$@"
elif [ -n "${DATABASE_URL:-}" ] || [ -f ".env" ]; then
  # Local Python environment attempt
  if [ -x ".venv/bin/python" ]; then
    PYTHON_BIN=".venv/bin/python"
  elif [ -x "openbinding-gateway/.venv/bin/python" ]; then
    PYTHON_BIN="openbinding-gateway/.venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi

  say "Running dev seeder via local Python ($PYTHON_BIN)..."
  GATEWAY_SITE_PACKAGES="$(ls -d "${REPO_ROOT}/openbinding-gateway/.venv/lib/python"*/site-packages 2>/dev/null | head -1 || true)"
  EXTRA_PATHS="${REPO_ROOT}/openbinding-gateway/src"
  if [ -n "$GATEWAY_SITE_PACKAGES" ]; then
    EXTRA_PATHS="${EXTRA_PATHS}:${GATEWAY_SITE_PACKAGES}"
  fi
  PYTHONPATH="${EXTRA_PATHS}:${PYTHONPATH:-}" "$PYTHON_BIN" openbinding-gateway/tools/seed_dev.py "$@"
else
  die "Could not find a running 'gateway-dev' container or local Python environment with database configuration.
Run './up.sh' first or start Docker Compose before seeding."
fi

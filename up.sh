#!/usr/bin/env bash
# Start the complete OpenBinding stack. SPACE and SPHERE are remote services
# configured through .env; nothing of them is deployed locally.
#
#   ./up.sh                 OpenBinding; contract operations wait for active pricing
#   PROFILE=prod ./up.sh    production Compose profile
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo"

profile="${PROFILE:-${COMPOSE_PROFILES:-dev}}"
if [ "$#" -gt 0 ]; then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

set_env() {
  local name="$1" value="$2" temporary
  temporary="$(mktemp "${TMPDIR:-/tmp}/openbinding-env.XXXXXX")"
  awk -F= -v key="$name" '$1 != key { print }' .env > "$temporary"
  printf '%s=%s\n' "$name" "$value" >> "$temporary"
  mv "$temporary" .env
}

ensure_secret() {
  local name="$1" current
  current="$(sed -n "s/^${name}=//p" .env | tail -1)"
  if [ -z "$current" ]; then
    set_env "$name" "$(openssl rand -hex 32)"
  fi
}

say "Configuration"
if [ ! -f .env ]; then
  cp .env.example .env
  note "created .env from the documented template."
else
  note ".env already exists; preserving its values."
fi
ensure_secret POSTGRES_PASSWORD
ensure_secret GATEWAY_JWT_SECRET

say "OpenBinding"
docker compose --profile "$profile" up -d --build

gateway="http://localhost:8000"
say "Readiness"
for _ in $(seq 1 60); do
  curl -fsS -m 3 "$gateway/health/ready" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 5 "$gateway/health/ready" >/dev/null 2>&1 \
  || die "the gateway is not ready; inspect: docker compose logs gateway-${profile}"
note "gateway, worker, engines and interface are ready."

if ! grep -Eq '^SPACE_API_KEY=.+$' .env; then
  note "SPACE is remote (https://space.score.us.es) and is not enabled yet."
  note "Set SPACE_API_KEY (MANAGEMENT scope) and SPACE_ENABLED=true in .env, then restart gateway/worker."
fi

printf '\n\033[32m✓ Ready.\033[0m\n'
note "Interface   http://localhost$([ "$profile" = dev ] && printf ':5173')"
note "API         $gateway/docs"
note "Database UI docker compose --profile db-tools up -d adminer (127.0.0.1:8082)"

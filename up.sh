#!/usr/bin/env bash
# Start the complete OpenBinding stack. SPACE is opt-in because a fresh
# checkout has no SPHERE organization key or published pricing yet.
#
#   ./up.sh                 OpenBinding; contract operations wait for active pricing
#   ./up.sh --with-space    also run the pinned SPACE 1.5 services
#   PROFILE=prod ./up.sh    production Compose profile
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo"

profile="${PROFILE:-${COMPOSE_PROFILES:-dev}}"
with_space=0
case "${1:-}" in
  "") ;;
  --with-space) with_space=1 ;;
  --no-space) ;; # retained for compatibility with the previous helper
  *) printf 'Usage: %s [--with-space|--no-space]\n' "$0" >&2; exit 2 ;;
esac

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

if [ "$with_space" -eq 1 ]; then
  ensure_secret SPACE_ADMIN_PASSWORD
  ensure_secret SPACE_DATABASE_ROOT_PASSWORD
  ensure_secret SPACE_JWT_SECRET
  ensure_secret SPACE_JWT_SALT
  say "SPACE 1.5"
  ./space/prepare.sh
  docker compose --profile space up -d --build space-mongodb space-redis space-server
  for _ in $(seq 1 60); do
    curl -fsS -m 3 "http://127.0.0.1:${SPACE_HOST_PORT:-5403}/api/v1/healthcheck" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS -m 5 "http://127.0.0.1:${SPACE_HOST_PORT:-5403}/api/v1/healthcheck" >/dev/null 2>&1 \
    || die "SPACE did not become healthy; inspect: docker compose logs space-server"
  note "SPACE is healthy on loopback."
fi

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

if [ "$with_space" -eq 1 ] && ! grep -Eq '^SPACE_API_KEY=.+$' .env; then
  note "SPACE has no gateway key yet. Mint both scoped keys with:"
  note "python space/bootstrap/bootstrap_space.py --url http://127.0.0.1:${SPACE_HOST_PORT:-5403} --include-destructive-key"
  note "Put its output in .env, enable SPACE, restart gateway/worker, then publish and deploy 0.1.0 from the pricing control room."
fi

printf '\n\033[32m✓ Ready.\033[0m\n'
note "Interface   http://localhost$([ "$profile" = dev ] && printf ':5173')"
note "API         $gateway/docs"
note "Database UI docker compose --profile db-tools up -d adminer (127.0.0.1:8082)"

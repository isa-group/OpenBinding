#!/usr/bin/env bash
# Bring up everything: SPACE, the gateway, the engines, the interface.
#
#     ./up.sh
#
# One command, from nothing, idempotent. Run it again after pulling, after
# changing the pricing, or whenever something looks disconnected.
#
# It is one script rather than a page of instructions because the order matters
# and three of the steps have silently gone wrong before: the shared network
# has to exist before either stack starts, SPACE's own database has to be up
# before SPACE means anything, and the pricing registered in SPACE has to match
# the one in this repository or every contract is refused - by a client that
# reports the refusal as success.
#
#   PROFILE=prod ./up.sh      the production profile instead of dev
#   ./up.sh --no-space        the gateway alone, without pricing enforcement
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

PROFILE="${PROFILE:-${COMPOSE_PROFILES:-dev}}"
NETWORK="${SPACE_NETWORK:-openbinding-space}"
SPACE_DIR="$REPO/space/space-src/docker/local"
WITH_SPACE=1
[ "${1:-}" = "--no-space" ] && WITH_SPACE=0

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# -- Configuration ---------------------------------------------------------

say "Configuration"
if [ ! -f .env ]; then
  # Secrets that must not be guessable, generated once and kept out of git.
  {
    echo "COMPOSE_PROFILES=$PROFILE"
    echo "POSTGRES_DB=openbinding"
    echo "POSTGRES_USER=openbinding"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "GATEWAY_JWT_SECRET=$(openssl rand -hex 32)"
    echo "FEDERATION_SECRET_KEY=$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())' 2>/dev/null || openssl rand -base64 32)"
    echo "AUTH_REQUIRED_FOR_SOLVE=true"
  } > .env
  note "wrote .env with fresh secrets."
else
  note ".env is there; leaving it alone."
fi

# SPACE signs every pricing token with these. Left at the shipped defaults,
# anyone who has read SPACE's repository can mint a token claiming anything.
for name in SPACE_JWT_SECRET SPACE_JWT_SALT SPACE_ADMIN_PASSWORD; do
  grep -q "^$name=" .env || echo "$name=$(openssl rand -hex 24)" >> .env
done
set -a; . ./.env; set +a

# -- The shared network ----------------------------------------------------

say "Shared network"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  note "$NETWORK is there."
else
  docker network create "$NETWORK" >/dev/null
  note "created $NETWORK."
fi

# -- SPACE -----------------------------------------------------------------

if [ "$WITH_SPACE" = 1 ]; then
  say "SPACE"
  [ -d "$SPACE_DIR" ] || die "space/space-src is missing. Clone it:
    git clone https://github.com/isa-group/space.git space/space-src"

  (cd "$SPACE_DIR" && docker compose -f docker-compose.yml \
      -f ../../../docker-compose.override.yml up -d >/dev/null)
  note "containers up."

  # Its API answers before its database does, and answers 401 rather than 503
  # while it waits - so this waits for the database rather than for the port.
  note "waiting for its database ..."
  for _ in $(seq 1 60); do
    body="$(docker run --rm -i --network "$NETWORK" curlimages/curl:latest \
      -s -m 5 http://space-server:3000/api/v1/services 2>/dev/null || true)"
    case "$body" in
      *"buffering timed out"*|"") sleep 2 ;;
      *) break ;;
    esac
  done
  case "${body:-}" in
    *"buffering timed out"*|"") die "SPACE never reached its database. Try: docker logs space-server" ;;
  esac
  note "SPACE is answering, database included."
fi

# -- OpenBinding -----------------------------------------------------------

say "OpenBinding"
docker compose --profile "$PROFILE" up -d --build >/dev/null
note "gateway, engines, database and interface up."

# -- Connecting the two ----------------------------------------------------

if [ "$WITH_SPACE" = 1 ]; then
  say "Connecting the gateway to SPACE"
  COMPOSE_PROFILE="$PROFILE" ./space/connect.sh 2>&1 | sed 's/^/  /'
fi

# -- Proving it ------------------------------------------------------------

say "Checking"
GATEWAY="http://localhost:8000"
for _ in $(seq 1 45); do
  curl -fsS -m 3 "$GATEWAY/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 5 "$GATEWAY/health" >/dev/null 2>&1 || die "the gateway is not answering on :8000."
note "gateway healthy."

TOKEN="$(curl -fsS -m 10 -X POST "$GATEWAY/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username_or_email":"admin","password":"4dm1n"}' 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])' 2>/dev/null || true)"

[ -n "$TOKEN" ] || die "the seeded administrator could not sign in."
note "signed in as admin."

if [ "$WITH_SPACE" = 1 ]; then
  LIMITS="$(curl -fsS -m 10 "$GATEWAY/v1/users/me/usage" -H "Authorization: Bearer $TOKEN" \
    | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("limits") or []))' 2>/dev/null || echo 0)"
  if [ "$LIMITS" -gt 0 ]; then
    note "reading $LIMITS quota limits from SPACE."
  else
    die "the gateway is up but reading no quotas from SPACE. Try: ./space/connect.sh"
  fi
fi

printf '\n\033[32m✓ Ready.\033[0m\n'
echo "  Interface   http://localhost${PROFILE:+$([ "$PROFILE" = dev ] && echo ':5173' || echo '')}"
echo "  API         $GATEWAY/docs"
echo "  Sign in     admin / 4dm1n  — create a real administrator and delete this one."

#!/usr/bin/env bash
# Connect this gateway to a SPACE instance, from nothing to a working contract.
#
#     ./space/connect.sh
#
# Idempotent. Run it after `docker compose up`, after changing the pricing, or
# whenever `/v1/users/me/usage` comes back with no limits.
#
# It does five things, and each one is a step that has silently gone wrong at
# least once:
#
#   1. makes the shared network, if it is not there;
#   2. checks SPACE can actually reach its own database - its API answers 401
#      when Mongo is down, which reads as "wrong password" and is not;
#   3. registers the pricing, or uploads it as a new version when the one in
#      SPACE differs from the one in this repository;
#   4. finds an organization key with MANAGEMENT scope, minting one if needed;
#   5. writes SPACE_* into .env and restarts the gateway.
#
# The admin password is only needed the first time, to mint the key. Set
# SPACE_ADMIN_PASSWORD, or the script asks for it without echoing.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${SPACE_NETWORK:-openbinding-space}"
SPACE_URL="${SPACE_URL:-http://space-server:3000}"
PRICING="${REPO}/space/pricing/openbinding.yml"
ENV_FILE="${REPO}/.env"
PROFILE="${COMPOSE_PROFILE:-dev}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# A throwaway container on the network, because SPACE publishes nothing on the
# host: everything below talks to it the way the gateway does.
in_network() {
  # -i, or the here-document never reaches python and every step
  # "succeeds" by running nothing at all.
  docker run --rm -i --network "$NETWORK" \
    -v "${REPO}/space:/space:ro" -w /space \
    -e SPACE_URL="$SPACE_URL" -e SPACE_KEY="${SPACE_KEY:-}" \
    -e SPACE_ADMIN_USER="${SPACE_ADMIN_USER:-admin}" \
    -e SPACE_ADMIN_PASSWORD="${SPACE_ADMIN_PASSWORD:-}" \
    python:3.12-slim sh -c 'pip install -q httpx pyyaml >/dev/null 2>&1 && python -'
}

say "1. The shared network"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "   $NETWORK is there."
else
  docker network create "$NETWORK" >/dev/null
  echo "   created $NETWORK - restart SPACE so it joins."
fi

say "2. Is SPACE actually up?"
in_network <<'PY' || die "SPACE is not answering. Is its stack running?"
import os, sys, httpx
base = os.environ["SPACE_URL"]
try:
    r = httpx.get(f"{base}/api/v1/services", timeout=10)
except Exception as error:
    sys.exit(f"   cannot reach {base}: {error}")

# A 401 whose body mentions a timeout is Mongo being unreachable, not a
# credential problem. SPACE reports both the same way, which has cost hours.
if "buffering timed out" in r.text:
    sys.exit(
        "   SPACE is running but cannot reach its database.\n"
        "   Its API answers 401 for this, which looks like a wrong password.\n"
        "   Bring its mongodb container up and restart space-server."
    )
print("   SPACE answers, and its database is reachable.")
PY

say "3. An organization key"
# Before the pricing, because reading what is registered needs the key too.
if [ -z "${SPACE_API_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  SPACE_API_KEY="$(grep -m1 '^SPACE_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
fi

key_works() {
  [ -n "${SPACE_API_KEY:-}" ] || return 1
  SPACE_KEY="$SPACE_API_KEY" in_network >/dev/null 2>&1 <<'PY'
import os, sys, httpx
r = httpx.get(f"{os.environ['SPACE_URL']}/api/v1/services",
              headers={"x-api-key": os.environ["SPACE_KEY"]}, timeout=15)
sys.exit(0 if r.status_code < 400 else 1)
PY
}

if key_works; then
  echo "   the key in .env still works."
else
  if [ -z "${SPACE_ADMIN_PASSWORD:-}" ]; then
    read -r -s -p "   SPACE admin password: " SPACE_ADMIN_PASSWORD; echo
    export SPACE_ADMIN_PASSWORD
  fi
  echo "   minting one through bootstrap_space.py ..."
  SPACE_API_KEY="$(in_network <<'PY'
import io, os, re, runpy, sys, contextlib
sys.argv = ["bootstrap_space.py", "--url", os.environ["SPACE_URL"]]
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    try:
        runpy.run_path("bootstrap/bootstrap_space.py", run_name="__main__")
    except SystemExit:
        pass
found = re.search(r"org_[A-Za-z0-9_-]+", buffer.getvalue())
if not found:
    print(buffer.getvalue()[-400:], file=sys.stderr)
else:
    print(found.group(0))
PY
)"
  SPACE_API_KEY="$(printf '%s' "$SPACE_API_KEY" | tr -d '[:space:]')"
  [ -n "$SPACE_API_KEY" ] || die "   no key came back - see the output above."
  key_works || die "   the minted key does not work."
fi

say "4. The pricing"
SPACE_KEY="$SPACE_API_KEY" in_network <<'PY' || die "   the pricing could not be registered."
import os, sys, httpx, yaml

base, key = os.environ["SPACE_URL"], os.environ["SPACE_KEY"]
with open("pricing/openbinding.yml", encoding="utf-8") as handle:
    ours = str(yaml.safe_load(handle)["version"])

with httpx.Client(base_url=f"{base}/api/v1", headers={"x-api-key": key}, timeout=30) as client:
    service = client.get("/services/openbinding")

    if service.status_code == 404:
        with open("pricing/openbinding.yml", "rb") as handle:
            created = client.post(
                "/services",
                files={"pricing": ("openbinding.yml", handle, "application/yaml")},
            )
        if created.status_code >= 400:
            sys.exit(f"   SPACE refused the service: {created.text[:200]}")
        print(f"   registered 'openbinding' with pricing {ours}.")
        sys.exit(0)

    # SPACE spells a version with underscores in some responses and dots in
    # others, so both are normalised before they are compared.
    body = service.json() if service.status_code < 400 else {}
    registered = {str(v).replace("_", ".") for v in (body.get("activePricings") or {})}
    if ours in registered:
        print(f"   version {ours} is already registered.")
        sys.exit(0)

    with open("pricing/openbinding.yml", "rb") as handle:
        added = client.post(
            "/services/openbinding/pricings",
            files={"pricing": ("openbinding.yml", handle, "application/yaml")},
        )
    if added.status_code >= 400:
        sys.exit(f"   SPACE refused version {ours}: {added.text[:200]}")
    print(f"   uploaded version {ours}; SPACE had {', '.join(sorted(registered)) or 'none'}.")
PY

say "5. Wiring the gateway"
touch "$ENV_FILE"
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    # A temporary file rather than sed -i, whose flags differ on macOS and Linux.
    grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}
set_env SPACE_ENABLED true
set_env SPACE_URL "$SPACE_URL"
set_env SPACE_API_KEY "${SPACE_API_KEY//[[:space:]]/}"
echo "   .env updated (it is gitignored; the key stays on this machine)."

docker compose --profile "$PROFILE" up -d "gateway${PROFILE:+-$PROFILE}" >/dev/null 2>&1 ||
  docker compose --profile "$PROFILE" up -d >/dev/null

say "Done. Check it:"
echo "   curl -s localhost:8000/v1/users/me/usage -H \"Authorization: Bearer \$TOKEN\""
echo "   A working connection lists eleven limits. An empty list means the"
echo "   gateway fell back to running without SPACE."

#!/usr/bin/env bash
# The SCORETech Identity walk at the gateway (lab/identity/README.md): signs disposable users in through the real
# Identity lab, provisions, renews once, logs out, rolls back and cleans every fixture.
#
#   WALK_LOGS=<dir> IDENTITY_SECRET_DIR=<private dir> BIM_TOOLCHAIN_TOKEN=... lab/identity/walk.sh
#
# Order: Identity up -> fixtures -> the OB lab (project obf5id, port 18198) on an empty database -> @bootstrap (the
# administrator by sub, before any administrator exists) -> seed_lab -> @operation-setup (three users for F4's
# operation sign in once; 04) -> psql moves lab-main's seeded owner, member and viewer memberships to them ->
# e2e/live/13-operation.spec.ts unchanged behind Identity (LAB_SIGN_IN=identity), and the combined stack's memory ->
# the main phase (the gateway, 01) -> @screens
# (OpenBinding's screens, 02) -> @signup, Keycloak's view of the native registration, @granted -> post-checks in psql ->
# @account (Settings, avatars, a key, the admin Identity tab; 03) -> member's last renewal 31 days back -> @orphan (the
# suspended key, a sign-in, the account deleted; 03) and its post-checks -> the gateway in local mode and @rollback (01
# and 02) -> cleanup, always.
# Nothing printed carries a token, a secret, a code or an address: ids, counts and booleans only.
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
LOGS=${WALK_LOGS:?set WALK_LOGS to the directory for logs and results}
SECRET_DIR=${IDENTITY_SECRET_DIR:?set IDENTITY_SECRET_DIR to a private directory for the client secret}
RUN=${WALK_RUN:-$(date +%s)}
PORT=18198
ORIGIN="http://localhost:${PORT}"
PROJECT=${OB_IDENTITY_PROJECT:-obf5id}
mkdir -p "$LOGS"

export DEMO_LAB_PORT=$PORT DEMO_PUBLIC_ORIGIN=$ORIGIN WALK_RUN=$RUN
export DEMO_PG_PASSWORD="${DEMO_PG_PASSWORD:-$(openssl rand -hex 16)}" DEMO_JWT_SECRET="${DEMO_JWT_SECRET:-$(openssl rand -hex 32)}"
export DEMO_FERNET_KEY="${DEMO_FERNET_KEY:-$(python3 -c 'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())')}"
export DEMO_SEED_PASSWORD="${DEMO_SEED_PASSWORD:-lab-$(openssl rand -hex 12)}" DEMO_SPACE_ENABLED=false DEMO_SPACE_PRICING_VERSION=0.2.0
export DEMO_SPACE_DEFAULT_PLAN=FREE DEMO_SPACE_DEV_PLAN=FREE DEMO_SPACE_DEV_SERVICE=openbinding-dev SPACE_URL= SPACE_API_KEY=
export SPACE_ORGANIZATION_ID= SPHERE_URL=https://sphere.score.us.es SPHERE_API_KEY= SPHERE_ORGANIZATION_ID= DEMO_E2E=0
export DEMO_SEED_TOOL=seed_lab.py DEMO_SEED_ARGS=
export IDENTITY_CLIENT_ID="ob-walk-${RUN}" IDENTITY_CLIENT_SECRET_PATH="$SECRET_DIR/secret"

OB="docker compose -p $PROJECT -f compose.lab.json -f compose.lab-identity.json"

identity_container() {
  docker ps -q --filter label=com.docker.compose.project=scoretech-identity-lab --filter "label=com.docker.compose.service=$1" | head -1
}

# fixtures <python expression building the request dict from `env` and `base`>: run fixtures.mjs in Identity's account-api.
fixtures() {
  local keycloak request
  keycloak=$(identity_container keycloak)
  request=$(KC_ENV="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$keycloak")" python3 -c '
import json, os, sys
env = dict(line.split("=", 1) for line in os.environ["KC_ENV"].splitlines() if "=" in line)
base = {"run": os.environ["WALK_RUN"], "origin": os.environ["WALK_ORIGIN"],
        "adminUser": env["KC_BOOTSTRAP_ADMIN_USERNAME"], "adminPassword": env["KC_BOOTSTRAP_ADMIN_PASSWORD"]}
base.update(json.loads(sys.argv[1]))
if base.pop("withSecret", False):
    base["secret"] = open(os.environ["IDENTITY_CLIENT_SECRET_PATH"]).read().strip()
print(json.dumps(base))
' "$1")
  { printf 'const REQUEST = %s;\n' "$request"; cat lab/identity/fixtures.mjs; } \
    | docker exec -i "$(identity_container account-api)" node --input-type=module -
}
export WALK_ORIGIN=$ORIGIN

email() {
  case "$1" in
    research) echo "ob-walk-${RUN}-research@research.example" ;;
    clash) echo "lab-orgadmin@example.org" ;;
    squat) echo "lab-outsider@example.org" ;;
    new) echo "ob-new-${RUN}@example.invalid" ;;
    *) echo "ob-walk-${RUN}-$1@example.invalid" ;;
  esac
}

phase() {
  echo "== phase $1"
  local status=0
  $OB --profile identity-walk run --rm -e "WALK_PHASE=$1" e2e-identity pnpm exec playwright test -c playwright.identity.config.ts "${@:2}" \
    > "$LOGS/phase-$1.log" 2>&1 || status=$?
  grep -E "✓|✘|passed|failed|skipped|flaky" "$LOGS/phase-$1.log" | tail -30
  echo "PHASE_$1=$status"
  return "$status"
}

sql() { $OB exec -T postgres psql -U openbinding -d openbinding -At -c "$1"; }

cleanup() {
  set +e
  echo "== cleanup"
  if [ -n "$(identity_container account-api)" ]; then
    fixtures "{\"action\": \"delete\", \"emails\": [\"$(email admin)\", \"$(email member)\", \"$(email research)\", \"$(email norole)\", \"$(email clash)\", \"$(email squat)\", \"$(email screens)\", \"$(email new)\", \"$(email opowner)\", \"$(email opmember)\", \"$(email opviewer)\"]}" \
      > "$LOGS/identity-fixtures-deleted.json" 2>&1
    echo "FIXTURES_DELETE=$?"
  fi
  $OB logs --no-color web gateway > "$LOGS/idlab-services.log" 2>&1
  docker run --rm -v "${PROJECT}_lab-identity-e2e:/results:ro" -v "$LOGS:/out" alpine:3.20 \
    sh -c 'cp -r /results/. /out/results/ 2>/dev/null; chmod -R a+rX /out/results 2>/dev/null' >/dev/null 2>&1
  $OB --profile identity-walk down --volumes --remove-orphans > /dev/null 2>&1
  echo "OB_DOWN=$?"
  if [ -z "${KEEP_IDENTITY_LAB:-}" ]; then lab/identity/down.sh > /dev/null 2>&1; echo "IDENTITY_DOWN=$?"; fi
  rm -f "$SECRET_DIR/secret"
}
trap cleanup EXIT

echo "== identity lab up"
lab/identity/up.sh > "$LOGS/identity-up.log" 2>&1 || { tail -20 "$LOGS/identity-up.log"; exit 1; }
echo "IDENTITY_UP=0"

umask 077
mkdir -p "$SECRET_DIR"
python3 -c 'import secrets;print(secrets.token_urlsafe(32))' > "$SECRET_DIR/secret"
chmod 0644 "$SECRET_DIR/secret"
umask 022

echo "== fixtures"
fixtures "$(python3 - "$RUN" <<'PY'
import json, sys
run = sys.argv[1]
def email(role):
    return {"research": f"ob-walk-{run}-research@research.example", "clash": "lab-orgadmin@example.org",
            "squat": "lab-outsider@example.org"}.get(role, f"ob-walk-{run}-{role}@example.invalid")
users = []
for role in ("admin", "member", "research", "norole", "clash", "squat", "screens", "opowner", "opmember", "opviewer"):
    user = {"role": role, "email": email(role), "emailVerified": role != "member", "permission": role != "norole",
            "displayName": f"Walk {role}"}
    if role == "member":
        user["avatar"] = {"kind": "icon", "assetId": "leaf", "backgroundColor": "graphite", "foregroundColor": "paper"}
    users.append(user)
print(json.dumps({"action": "create", "withSecret": True, "users": users}))
PY
)" > "$LOGS/identity-fixtures.json"
ADMIN_SUB=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["users"]["admin"]["sub"])' "$LOGS/identity-fixtures.json")
export IDENTITY_BOOTSTRAP_ADMIN_SUB=$ADMIN_SUB
echo "FIXTURES_CREATE=0"

echo "== token shape"
fixtures "{\"action\": \"claims\", \"email\": \"$(email member)\"}" > "$LOGS/identity-claims.json"
python3 - "$LOGS/identity-claims.json" <<'PY'
import json, sys
claims = json.load(open(sys.argv[1]))
id_token, access = set(claims["idToken"]), set(claims["accessToken"])
wanted = {"email", "email_verified", "scoretech_display_name", "scoretech_avatar"}
forbidden = {"email", "name", "preferred_username", "given_name", "family_name"}
print("ID_TOKEN_HAS_PROFILE", wanted <= id_token, sorted(wanted - id_token))
print("ACCESS_TOKEN_PROTOCOL_ONLY", not (access & forbidden) and not any(c.startswith("scoretech_") for c in access),
      sorted(access & forbidden))
PY

echo "== OB lab up (empty database, AUTH_PROVIDER=scoretech)"
$OB up --build -d --wait > "$LOGS/ob-up.log" 2>&1 || { tail -30 "$LOGS/ob-up.log"; exit 1; }
$OB --profile identity-walk build e2e-identity > "$LOGS/e2e-build.log" 2>&1 || { tail -30 "$LOGS/e2e-build.log"; exit 1; }
echo "OB_UP=0"
echo "ADMINS_BEFORE=$(sql "select count(*) from users where role = 'admin'")"

failed=0
phase bootstrap --grep @bootstrap || failed=1

echo "== seed_lab"
$OB run --rm --no-deps seed > "$LOGS/seed.log" 2>&1; echo "SEED_EXIT=$?"
sql "update users set email_verified = true where username = 'lab-orgadmin'" > /dev/null

phase operation-setup --grep @operation-setup || failed=1
echo "== lab-main's seeded memberships moved to the operation users (the owner moved, not duplicated)"
echo "OPERATION_MEMBERSHIPS_MOVED=$(sql "with moved as (update organization_memberships m set user_id = f.id
  from (values ('lab-owner', 'opowner'), ('lab-member', 'opmember'), ('lab-viewer', 'opviewer')) as moves(lab, role)
  join users l on l.username = moves.lab join users f on f.username = 'ob-walk-${RUN}-' || moves.role
  where m.user_id = l.id and m.organization_id = (select id from organizations where slug = 'lab-main') returning 1)
  select count(*) from moved")"
echo "LAB_MAIN_OWNERS=$(sql "select count(*) from organization_memberships m join organizations o on o.id = m.organization_id where o.slug = 'lab-main' and lower(m.role::text) = 'owner'")"
echo "== F4's operation behind Identity (e2e/live/13-operation.spec.ts, unchanged)"
operation=0
$OB --profile identity-walk run --rm e2e-identity pnpm exec playwright test -c playwright.live.config.ts --project=desktop \
  13-operation.spec.ts > "$LOGS/operation.log" 2>&1 || operation=$?
grep -E "✓|✘|passed|failed|skipped|flaky" "$LOGS/operation.log" | tail -15
echo "OPERATION=$operation"
[ "$operation" = 0 ] || failed=1
echo "COMBINED_MEM_USED_MIB=$(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | awk -v p="^${PROJECT}-|^scoretech-identity-lab-" '
  $1 ~ p { u = $2; f = 1; if (u ~ /GiB/) f = 1024; else if (u ~ /KiB/) f = 1 / 1024; gsub(/[A-Za-z]/, "", u); s += u * f }
  END { printf "%d", s }')"
echo "MEM_AVAILABLE_MIB=$(awk '/MemAvailable/ { print int($2 / 1024) }' /proc/meminfo)"

phase main --grep-invert "@bootstrap|@operation-setup|@screens|@signup|@granted|@account|@orphan|@rollback" || failed=1
phase screens --grep @screens || failed=1

phase signup --grep @signup || failed=1
fixtures "{\"action\": \"inspect\", \"email\": \"$(email new)\"}" > "$LOGS/identity-native.json"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("NATIVE_REGISTRATION_EMAIL_VERIFIED", d["found"] and d["emailVerified"])' "$LOGS/identity-native.json"
fixtures "{\"action\": \"grant\", \"email\": \"$(email new)\"}" > /dev/null && echo "NATIVE_GRANTED=1"
phase granted --grep @granted || failed=1

echo "== post-checks"
MEMBER="ob-walk-${RUN}-member"
echo "MEMBER_LOGGED_OUT_GENERATION=$(sql "select string_agg(s.refresh_generation::text, ',') from identity_sessions s join users u on u.id = s.user_id where u.username = '${MEMBER}' and s.revoked_reason = 'logout'")"
echo "SCREENS_RENEWED_GENERATION=$(sql "select max(s.refresh_generation) from identity_sessions s join users u on u.id = s.user_id where u.username = 'ob-walk-${RUN}-screens'")"
echo "SCREENS_SIGNED_OUT=$(sql "select count(*) from identity_sessions s join users u on u.id = s.user_id where u.username = 'ob-walk-${RUN}-screens' and s.revoked_reason = 'logout'")"
echo "SCORETECH_IDENTITIES=$(sql "select count(*) from auth_identities where provider = 'scoretech'")"
echo "CLASH_ACCOUNTS=$(sql "select count(*) from auth_identities i join users u on u.id = i.user_id where u.email = 'lab-orgadmin@example.org' and i.provider = 'scoretech'")"
echo "SQUAT_HOLDER_RELEASED=$(sql "select count(*) from users where username = 'lab-outsider' and email like '%@identity.openbinding.invalid'")"
echo "ADMIN_BY_SUB=$(sql "select count(*) from users u join auth_identities i on i.user_id = u.id where i.subject = '${ADMIN_SUB}' and u.role = 'admin'")"
for action in account.signed_in account.signed_out account.identity.provisioned account.identity.refused \
  account.email.released account.research.granted account.admin.bootstrapped; do
  echo "AUDIT ${action}=$(sql "select count(*) from audit_events where action = '${action}'")"
done
echo "RELEASED_UNVERIFIED_HOLDER=$(sql "select count(*) from audit_events where action = 'account.email.released' and detail->>'reason' = 'unverified_holder'")"

phase account --grep @account || failed=1
echo "== member's last Identity renewal 31 days back (and its upstream token kept, so no renewal moves it first)"
sql "update users set last_identity_refresh_at = now() - interval '31 days' where username = '${MEMBER}'" > /dev/null
sql "update identity_sessions set access_expires_at = now() + interval '1 hour' where revoked_at is null and user_id = (select id from users where username = '${MEMBER}')" > /dev/null
phase orphan --grep @orphan || failed=1
MEMBER_SUB=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["users"]["member"]["sub"])' "$LOGS/identity-fixtures.json")
echo "MEMBER_ACCOUNT_LEFT=$(sql "select count(*) from users where username = '${MEMBER}'")"
echo "MEMBER_IDENTITY_LEFT=$(sql "select count(*) from auth_identities where subject = '${MEMBER_SUB}'")"
echo "MEMBER_LIVE_KEYS=$(sql "select count(*) from api_keys where name = 'walk orphan key' and revoked_at is null")"
echo "MEMBER_LIVE_SESSIONS=$(sql "select count(*) from identity_sessions s join auth_identities i on i.id = s.identity_id where i.subject = '${MEMBER_SUB}' and s.revoked_at is null")"

echo "== rollback: the gateway in local mode"
$OB logs --no-color gateway > "$LOGS/gateway-scoretech.log" 2>&1
# Exported, so that no later compose command recreates the gateway in scoretech mode again.
export OB_AUTH_PROVIDER=local
$OB up -d --wait --no-deps gateway > "$LOGS/rollback-up.log" 2>&1 || { tail -20 "$LOGS/rollback-up.log"; failed=1; }
# nginx resolves the gateway when it starts: it follows the recreated container after a restart.
$OB restart web > "$LOGS/rollback-web.log" 2>&1 || failed=1
echo "ROLLBACK_PROVIDER=$(curl -fsS "$ORIGIN/api/v1/auth/config" | python3 -c 'import json,sys;print(json.load(sys.stdin)["provider"])')"
phase rollback --grep @rollback || failed=1

echo "WALK_FAILED=$failed"
exit "$failed"

# Federated `multi-heuristic` example

This directory contains the two immutable documents federation needs:

- `engine.json` declares the portable algorithm contract. It is deliberately
  outside `schemas/bim/v1/manifests`, so the gateway does not install it as a
  bundled engine.
- `registration.json` declares one independently deployed production HTTPS origin and
  pins the exact Engine and `bim-engine/v1` revisions.

Start the sample process for local inspection:

```bash
docker compose --profile federated-example up --build engine-multi-heuristic
curl -fsS http://localhost:8081/health
curl -fsS http://localhost:8081/openapi.json | jq '."x-bim-protocol"'
```

Before a production registration, publish that process behind TLS and replace
`https://multi-heuristic.example.org` in `registration.json`. For this local
Compose example only, the development gateway sets
`FEDERATION_REQUIRE_HTTPS=false`; submit
`http://engine-multi-heuristic:8080` as the endpoint. Production defaults to
HTTPS and refuses that private HTTP origin.

The checked-in documents belong to the bootstrapped `admin` account. Ownership
is assigned from the authenticated caller, not trusted from a free-form field;
log in as `admin` when submitting both revisions. If `engine.json` changes,
create its new private revision first and copy the returned `digest` into
`registration.json`.

```bash
gateway=https://openbinding.example.org
admin_token='ADMIN_ACCESS_TOKEN'

curl -fsS -X POST "$gateway/v1/engines" \
  -H "Authorization: Bearer $admin_token" \
  -H 'Content-Type: application/json' \
  --data-binary @engine.json

registration_reply="$(curl -fsS -X POST "$gateway/v1/engine-registrations" \
  -H "Authorization: Bearer $admin_token" \
  -H 'Content-Type: application/json' \
  --data-binary @registration.json)"
registration_digest="$(jq -r .digest <<<"$registration_reply")"

curl -fsS -X POST "$gateway/v1/engine-registrations/multi-heuristic-deployment/activate" \
  -H "Authorization: Bearer $admin_token" \
  --get \
  --data-urlencode 'namespace=admin' \
  --data-urlencode 'version=1.0.0' \
  --data-urlencode "digest=$registration_digest"

curl -fsS -X POST "$gateway/v1/engine-registrations/multi-heuristic-deployment/publication-request" \
  -H "Authorization: Bearer $admin_token" \
  --get \
  --data-urlencode 'namespace=admin' \
  --data-urlencode 'version=1.0.0' \
  --data-urlencode "digest=$registration_digest"

curl -fsS -X POST "$gateway/v1/engine-registrations/multi-heuristic-deployment/approve" \
  -H "Authorization: Bearer $admin_token" \
  --get \
  --data-urlencode 'namespace=admin' \
  --data-urlencode 'version=1.0.0' \
  --data-urlencode "digest=$registration_digest"
```

The registration embeds the exact OpenAPI document served by the deployment.
Activation compares that immutable copy with `/openapi.json`, checks the pinned
protocol schemas, health-checks the deployment, and submits a deterministic
`MULTI`/Pareto probe with two objectives. Activation remains private and is not
visible to administrators. `publication-request` is the deliberate disclosure
step; only then does an administrator receive it. Approval verifies it again,
publishes both exact revisions, and makes the deployment available to every
authenticated account. The owner may still deactivate or reactivate it for
their own account without changing publication.

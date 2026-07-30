# SPACE: where OpenBinding's quotas actually live

OpenBinding does not decide what an account may do. A [SPACE](https://github.com/isa-group/space)
instance does: it holds one contract per user, knows what each plan allows, and
decrements usage as it is spent. The gateway asks, and enforces the answer.

This directory holds our side of that arrangement:

| Path | What it is |
|---|---|
| `pricing/openbinding.yml` | The pricing document, in Pricing2Yaml. Two plans, and every limit the gateway enforces. |
| `bootstrap/bootstrap_space.py` | Registers the service and pricing with a running SPACE, and prints the key the gateway needs. |
| `docker-compose.override.yml` | Attaches SPACE to a network the gateway can reach. |
| `space-src/` | The SPACE checkout. Git-ignored; you clone it. |

Not to be confused with `pricings/` at the repository root, which holds
AWS/Azure/GCloud iPricings that experiments read as candidate cost data. Same
language, unrelated purpose.

## Running an instance

SPACE ships its own compose file, and it is cloned rather than vendored: it is
early-stage software whose services change between releases, and keeping it at
arm's length means upstream can move without editing OpenBinding's compose. It
also means SPACE can live on another host later by changing one URL.

```bash
docker network create openbinding-space
git clone https://github.com/isa-group/space.git space/space-src
cd space/space-src && docker compose up -d
```

The interface comes up at <http://localhost:5403>. The default credentials are
`admin` / `space4all`.

**Change three things before this is anything but a local experiment.** SPACE
signs every pricing token with `JWT_SECRET` and `JWT_SALT`, so leaving those at
their shipped values lets anyone mint a token claiming any entitlement. And the
default administrator password is in this file, and in SPACE's documentation,
and now in your shell history.

## Wiring it to the gateway

```bash
./space/connect.sh
```

One command, idempotent, and the one to reach for after `docker compose up`,
after changing the pricing, or whenever `/v1/users/me/usage` comes back with no
limits. It creates the shared network if it is missing, checks that SPACE can
reach its own database, registers or upgrades the pricing, finds or mints an
organization key, writes `SPACE_*` into `.env` and restarts the gateway. The
admin password is asked for only when a key has to be minted.

It talks to SPACE from a throwaway container on `openbinding-space`, because
SPACE publishes nothing on the host once it is wired this way - which is also
how the gateway reaches it.

Each step exists because it has silently gone wrong:

* **the network** — declared external by both projects, so neither owns it, and
  absent on a fresh machine;
* **the database check** — SPACE answers `401` when MongoDB is unreachable,
  which reads as a wrong password while its healthcheck keeps passing
  ([UPSTREAM.md §7](UPSTREAM.md));
* **the pricing version** — a contract names the version it is written against.
  When the plans were renamed and the registered pricing was not re-uploaded,
  SPACE refused every contract and the Python client turned that 400 into a
  silent `None` ([UPSTREAM.md §6](UPSTREAM.md)), so registration reported success
  while producing accounts entitled to nothing.

### Doing it by hand

`space/bootstrap/bootstrap_space.py` is what `connect.sh` calls to mint the key.
It authenticates, registers the `openbinding` service with
`pricing/openbinding.yml`, and prints `SPACE_ENABLED`, `SPACE_URL` and
`SPACE_API_KEY`. Running it twice is safe: an already-registered service is left
alone - which is also why it will not upload a **changed** pricing, and why
`connect.sh` compares versions itself.

### Checking it worked

```bash
curl -s localhost:8000/v1/users/me/usage -H "Authorization: Bearer $TOKEN"
```

Eleven limits means the gateway is reading entitlements from SPACE. An empty
list means it fell back to running without one - with `SPACE_FAIL_MODE=open`
that failure is deliberately quiet, so this is the thing to check.

That API key authenticates *the gateway* to SPACE. It is not an OpenBinding API
key, it is not a user's, and it must never be handed to an account holder — it
speaks for the service and can read every contract.

## Developing without it

`SPACE_ENABLED=false` is the default, and the gateway runs a fake pricing gate
instead. The fake keeps real balances rather than approving everything, so
quotas are still enforced and still refuse — they just live in memory and reset
when the process does. That is what the test suite runs against.

## When SPACE is unreachable

`SPACE_FAIL_MODE` decides:

- `closed` (production default) refuses to solve. Handing out an unmetered
  half-hour of solver time is worse than a temporary outage.
- `open` (development default) lets the request through.

Reads are gentler than writes: plan ceilings are cached, so a brief outage does
not immediately stop work in progress.

## What was learned the hard way

The gateway talks to SPACE through `space-python-client`, its official client,
wrapped by `openbinding_gateway.space_client.space`. Everything below was found
by running a real SPACE 1.0.0 and being refused, and every one of them fails
*quietly* — so they are worth re-checking whenever the pinned version moves.

**The gateway needs a `MANAGEMENT` organization key.** Signing in as an
administrator yields a *user* key (`usr_`), and a user key cannot register a
service. `MANAGEMENT` covers registering the service, creating and novating
contracts, and evaluating features; `ALL` additionally allows deleting them,
which the gateway has no code to do. The bootstrap script mints the narrower
one rather than handing over the `ALL` key every installation starts with.

**Every plan must spell its features out.** A plan that relies on inheriting
the top-level `defaultValue`s is rejected outright — "the plan must be an
object of type Plan".

**A feature with no `expression` cannot be evaluated.** Expressions read
`pricingContext` and `subscriptionContext`, and limit names inside them are
unqualified.

**Limit names are qualified in some places and plain in others.** Feature
evaluation wants `openbinding-tasksLimit`; the body of a usage-level update
wants `tasksLimit`, because the service is already the outer key. Get that
backwards and SPACE accepts the request and changes nothing.

**A contract records consumption, never allowances.** The limit lives in the
pricing, resolved against the subscribed plan. Reading only the contract gives
usage with nothing to compare it against — and reads as "no limit" rather than
as an error. The gateway takes both from the pricing token, which is also
exactly what the browser is given, so the interface and the gateway cannot
disagree about what an account may do.

**Consumption is recorded by the gateway, not by evaluation.** SPACE will apply
an `expectedConsumption` while it evaluates, but it applies the limits
concurrently, each a read-modify-write of the same contract — so with more than
one limit involved the updates race and only one survives. Refusals are
unaffected and correct; it is the writing that is unreliable. So the gateway
asks with `evaluate` and spends with `PUT .../usageLevels`, which is a single
atomic update. A related quirk: `expectedConsumption` treats `0` as "not
provided", so a limit that should be checked but not charged cannot be
expressed that way at all.

Several of these are defects rather than design, and are written up with
reproductions and suggested fixes in [UPSTREAM.md](UPSTREAM.md) so they can be
reported. None of them is worked around by patching a dependency: both SPACE and
its Python client run here unmodified.

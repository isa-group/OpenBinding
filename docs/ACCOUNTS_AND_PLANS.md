# Accounts, plans and quotas

The OpenBinding `/v1` gateway separates public validation from authenticated
job ownership. When solve authentication is enabled, every `/v1/jobs` request
resolves to an account, so concurrency and compute can be metered and limited.

Two ideas carry most of the weight:

**The web and the API share identity, not authority.** A browser session and an
API key resolve to the same account, so one plan and one ownership boundary
apply. A session controls the account; each API key is narrower, with immutable
permissions and either an exact Engine allow-list or access to all visible
Engines. Every operation remains a documented gateway endpoint.

**The gateway does not decide entitlements.** A [SPACE](https://github.com/isa-group/space)
instance does. It holds a contract per user, knows what each plan allows, and
the gateway asks and enforces the answer.

## Getting an account

Registration is open: `POST /v1/auth/register` creates an account on the free
plan and a contract to go with it. If SPACE is unreachable at that moment the
account is still created and owes a contract, which is settled the next time
that user turns up — losing a sign-up because a pricing service was restarting
would be the worse failure.

Sessions are a short-lived access token plus a refresh token that is **rotated
on every use**: presenting one spends it. That makes a stolen refresh token
survivable, because the legitimate holder and the thief cannot both keep going.

API keys are `obk_`-prefixed, shown once, and stored only as a SHA-256. Not
argon2: the secret is 256 uniformly random bits, so there is nothing to guess
and no reason to spend 100 ms of CPU per request proving it. The prefix is
stored in the clear because something has to find the row before there is
anything to compare against.

Creating a key requires an explicit, closed set of permissions. Account, key,
instance, job, Engine execution, Engine registration/publication, extension
registration and administrator operations are independently grantable. Admin
permissions never replace the account-role check: both are required. A key
that may create other keys can grant only a subset of its own permissions and
Engine revisions. Grants cannot be edited; revoke and replace the key so an
audit never has to guess which authority an old use had.

Engine access is either `all` (including future visible revisions) or a list of
exact `{namespace, name, version, digest}` references. Catalogues, compatibility
analysis, execution, deployment management, publication and job reads are
filtered, and an exact disallowed resource answers `404` so the key does not
learn that it exists. Registering a brand-new Engine revision requires an
all-Engines key because its immutable digest cannot be selected in advance.

The FREE plan permits 10 active keys. PRO has no active-key ceiling. Revoked
keys do not count. The gateway serializes each account's count-and-create in
the database so concurrent requests cannot step past the FREE limit.

## The first administrator

A circle worth naming: registration produces ordinary users, and promoting an
account is an administrator's privilege — so a fresh deployment has nobody who
can promote anybody. Two ways out.

**Configured**, and what a real deployment should use:

```
BOOTSTRAP_ADMIN_USERNAME=alice
BOOTSTRAP_ADMIN_EMAIL=alice@example.org
BOOTSTRAP_ADMIN_PASSWORD=<something nobody can guess>
```

Applied at startup. If that username already exists it is promoted rather than
recreated, so somebody who registered normally can be given the role by
restarting with their username set. Nothing happens once any administrator
exists, so leaving the variables in place is harmless.

**Seeded**, for a database with nothing in it at all:

```bash
python tools/seed_admin.py
```

Creates `admin` / `4dm1n`, and refuses if there is even one account already. The
credentials are deliberately weak and well known — sign in once, create a real
administrator, deactivate this one. They are a way in, not a login.

## What an administrator can do

List accounts, deactivate one, change its role, move it between plans, and
revoke a key. Deliberately not: change a password or an email address. Those are
the two ways to sign in, so an administrator able to change them could take an
account over without its owner noticing.

Moving between plans is the only reason the paid plan works at all. There is no
payment gateway: an upgrade is an administrator performing a **novation** on the
SPACE contract. The novation happens before the cached plan is updated, so a
failed one leaves nothing claiming otherwise.

An administrator cannot deactivate or demote themselves. It is always a mistake,
and a gateway whose last administrator locked themselves out needs database
access to recover.

## How a limit behaves

Three outcomes, and which applies is a property of the thing being limited
rather than a preference.

| Kind | Example | What happens |
|---|---|---|
| A budget you asked for | `time_budget_ms`, `iterations`, `max_evaluations` | **Reduced** to what the plan allows, with an `OPTION_CLAMPED` warning alongside the result |
| An allowance you spend | monthly solver time, job count, concurrency | **Refused** with `402` until it renews, naming the limit and the renewal date |
| A fact about the work | instance complexity | **Refused** with `402`, because there is no smaller version of an instance to run |

Clamping rather than refusing matters more than it sounds: defaults are applied
before plan ceilings, so refusing an otherwise valid default could make a new
account's first request fail. Every reduction is reported, because a solve that
quietly did a tenth of the work asked for would produce a worse answer with no
explanation.

`402` rather than `403` throughout: this is an allowance spent, not a permission
missing, and only one of those is worth retrying next month.

## Accounting

A solve costs a task and a concurrency slot up front; the solver seconds it
actually spent are reported afterwards, preferring the engine's own figure over
the clock around the call. Nobody knows how long a solve takes until it has
taken it.

Asking and spending are separate calls, deliberately. SPACE will apply an
expected consumption while it evaluates, but it applies the limits concurrently,
each one a read-modify-write of the same contract — so with more than one limit
involved the updates race and only one survives. Refusals are correct and
unaffected; it is the writing that is not, so the gateway keeps its own accounts.
See [`space/UPSTREAM.md`](../space/UPSTREAM.md).

**Jobs nobody watches** are the interesting failure. A client that stops polling,
a gateway that restarts, an engine that dies — each leaves a concurrency slot
held, and for an account allowed one that means never solving again. SPACE's own
revert expires after two minutes and these solves run for thirty, so a
reconciler sweeps for jobs that outlived their budget and settles them. They are
charged for the budget they held: an abandoned solve that costs nothing is an
invitation to abandon every solve.

Settlement flips `metered` and `concurrency_released` with a compare-and-set, so
two polls arriving together charge once and release once. When those counts drift
anyway, `POST /v1/admin/users/{id}/usage/resync` counts the jobs actually running
and corrects the difference.

## When SPACE is unreachable

`SPACE_FAIL_MODE` decides:

- **`closed`** (production default) answers `503` with `Retry-After`. Handing out
  an unmetered half-hour of solver time is worse than a temporary outage, and the
  account may well have quota — saying `402` would be a lie about the reason.
- **`open`** (development default) lets the request through uncounted.

Plan ceilings are cached, so a brief outage does not immediately stop work in
progress. `SPACE_ENABLED=false` runs a fake pricing gate with real balances, so
quotas still refuse in development — they just live in memory.

## Configuration

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Async SQLAlchemy URL. Unset means no accounts: the gateway serves anonymously, as it always did, and the account routes answer `503` explaining why. |
| `GATEWAY_JWT_SECRET` | Signs session tokens. No default on purpose — a well-known signing key is worse than a missing one. |
| `SPACE_ENABLED`, `SPACE_URL`, `SPACE_API_KEY` | The pricing service. The key must be a `MANAGEMENT`-scoped organization key; see [`space/README.md`](../space/README.md). |
| `SPACE_FAIL_MODE` | `closed` or `open`, above. |
| `BOOTSTRAP_ADMIN_*` | The first administrator, above. |
| `FEDERATION_SECRET_KEY` | Fernet key for credentials registered with federated engines. |

Every one of these is declared in `core/settings.py`, which is the answer to
"what can be configured?".

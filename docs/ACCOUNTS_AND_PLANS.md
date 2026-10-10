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

## Organization roles and owner-only changes

Within an organization the roles are VIEWER < MEMBER < ADMIN < OWNER, and a role
on an organization applies to its descendants. Managing members needs ADMIN, with
one exception: **only an OWNER may grant the OWNER role or change or remove an
existing OWNER**. An ADMIN who tries receives `403` with code
`owner_role_requires_owner`; otherwise an ADMIN could promote a second account to
OWNER and, with it, outvote the real owners. This covers
`PUT /v1/organizations/{org}/members/{user}`,
`DELETE /v1/organizations/{org}/members/{user}`,
`POST /v1/organizations/{org}/members/batch` and invitations created with
`role: "OWNER"` (`POST /v1/organizations/{org}/invitations`).

* **Batch policy** is unchanged: all-or-nothing. If any change in the batch
  grants OWNER or touches an owner and the caller is not an OWNER, the whole
  batch is refused with `403` (the body carries `index` and `user_id` of the
  first offending change) and nothing is written.
* The "last owner" protection still applies to owners: removing or demoting the
  only OWNER is `409 last_owner`.
* A platform administrator who also holds ADMIN access to the organization keeps
  the ability to manage owners. A platform role alone grants no access to a
  private organization.

`POST /v1/generator/calibrate-engine` refits a model shared by every account, so
it needs a platform administrator (`403 platform_admin_required`) and, for API
keys, the `admin:accounts:write` permission; see [the generator](BIM_GENERATOR.md).

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

`cas_verified` in the administrator's account views (`GET /v1/admin/users`, and
the user inside the `PATCH`, `/plan` and `/subscription` responses) is the real
value: the account has a linked `us-cas` identity. A page of accounts costs one
identity query, not one per row. (There is no `GET /v1/admin/users/{id}`; the
detail screen reads the list with `search`.)

### Administrator actions are audited

Every action an administrator takes on somebody else's account leaves exactly
one event in the platform audit log (`GET /v1/admin/audit`), with the actor, the
target and a before/after summary. A refused request (`401`/`403`/`404`/`409`/`503`)
leaves none, and neither does a `PATCH` that changes nothing.

| Action | `action` | target | `detail` |
|---|---|---|---|
| `PATCH /v1/admin/users/{id}` (role, active) | `admin.user.updated` | `User` | `username`, `changes: {role: {from, to}, is_active: {from, to}}` (only fields that changed) |
| `POST /v1/admin/users/{id}/plan`, `/subscription` | `contract.subscription.changed` | `User` | previous/current plan and add-ons, reason, pricing version (unchanged) |
| `DELETE /v1/admin/users/{id}/api-keys/{key}` | `admin.api_key.revoked` | `ApiKey` | `user_id`, `key: {id, name, prefix}`, `before/after: {revoked}` |
| `POST /v1/admin/users/{id}/usage/resync` | `admin.usage.resynced` | `User` | `username`, `plan`, `before/after: {concurrent_jobs_recorded}`, `slots_in_flight`, `corrected_by` |

Events never carry a secret: for a key only its id, name and public prefix are
written, never the value or the stored hash.

`GET /v1/admin/audit` returns **platform and organization events together**:
organization events (a sponsorship transfer, member changes, …) carry
`organizationId` and `organizationSlug`, platform events carry `null`. Filter
with `?action=` and `?organization_id=<uuid>`. Members of an organization still
read only their own organization's log, at `GET /v1/organizations/{org}/audit`,
which is unchanged and never shows platform events. A sponsor change that a
person makes for **themselves** through `PATCH /v1/organizations/{org}` is
recorded as `organization.updated` with `previous_sponsor_user_id` /
`new_sponsor_user_id`, and the administrator doing so for themselves through
`POST /v1/admin/organizations/{id}/sponsor` as `organization.sponsor_transferred`.
Proposing somebody else, and what happens to the proposal, are the
`organization.sponsor.*` events below.

## Billing sponsorship needs the sponsor's acceptance

The sponsor of an organization is the account whose plan pays for the
consumption of the organization **and its whole subtree**. Nobody can make
someone else pay: naming another person only creates a **proposal**, and the
sponsor changes when that person accepts.

| Who | Does | Result |
|---|---|---|
| organization OWNER | `PATCH /v1/organizations/{org}` with `billing_sponsor_user_id` = somebody else | `202` + the pending proposal. The sponsor is unchanged; the other fields of the `PATCH` (name, parent) are applied |
| platform administrator | `POST /v1/admin/organizations/{id}/sponsor` with somebody else | `202` + the pending proposal |
| either, naming **themselves** | same calls | immediate change, `200` + the organization, subject to *their own* plan limits (`402 sponsor_quota_exceeded`); a pending proposal for somebody else is closed (`decision_reason: sponsor_changed`) |
| the proposed person | `POST /v1/sponsor-proposals/{id}/accept` / `.../decline` | only that person; not even a platform administrator can answer for them (`403 sponsor_proposal_forbidden`) |
| the proposer, an OWNER of the organization, or a platform administrator | `POST /v1/sponsor-proposals/{id}/cancel` | an organization ADMIN may see the proposal but not cancel it (`403`) |

Reading: `GET /v1/users/me/sponsor-proposals?status=` (addressed to me),
`GET /v1/organizations/{org}/sponsor-proposals?status=` (organization OWNER/ADMIN
and platform administrators; a non-member gets `404`, a member below ADMIN `403`)
and `GET /v1/sponsor-proposals/{id}`. Anyone who may not see a proposal gets
`404`, never `403`, so other people's proposals are not discoverable; ids are UUIDs.

A proposal is `{id, organization_id, organization_slug, organization_name,
proposed_user_id, proposed_username, proposed_by_user_id, proposed_by_username,
status, created_at, expires_at, decided_at, decided_by_user_id, decision_reason}`
with `status` one of `pending | accepted | declined | cancelled | expired`. Every
state but `pending` is terminal.

- **One pending proposal per organization** (also a unique database index).
  Another proposal answers `409 sponsor_proposal_pending` (with `proposal_id`),
  unless it is made by *the same person who made the pending one* and sends
  `replace_pending_proposal: true` (in the `PATCH`, or in the administrator
  body), which cancels the old one with `decision_reason: replaced`. Anyone else
  must cancel it first. A pending proposal that is already due is simply expired.
- **Expiry**: `SPONSOR_PROPOSAL_TTL_DAYS` (default 14). It is evaluated lazily
  when a proposal is read, listed, answered or replaced, and the periodic
  reconciler sweeps what nobody touched. Answering a lapsed proposal is
  `409 sponsor_proposal_expired`; answering a resolved one is
  `409 sponsor_proposal_not_pending` (its `status` says which).
- **Acceptance revalidates inside one transaction**: the proposal is pending and
  unexpired, the person is still active, and their plan admits the whole
  hypothetical total (what they already sponsor plus this subtree) with the same
  errors as before: `402 sponsor_quota_exceeded`, `503 pricing_unavailable`. A
  refusal leaves the proposal **pending**, so the person can raise their plan and
  accept again. Only then does `billing_sponsor_user_id` change for the
  organization and its subtree, which moves the consumption.
- A deactivated or deleted account closes its pending proposals, those addressed
  to it and those it made (`cancelled`, `decision_reason: user_deactivated` /
  `user_deleted`).
- Existing sponsors do not change. Account deletion still hands the
  organizations a deleted sponsor paid for to the next OWNER, as it always did;
  that transfer is not a proposal.

Audit (organization events, so `GET /v1/admin/audit` shows them with
`organizationId`/`organizationSlug`, and the organization's own log too):
`organization.sponsor.proposed` (actor: proposer; `current_sponsor_user_id`,
`expires_at`), `.accepted` (actor: the new sponsor; `previous_sponsor_user_id`,
`new_sponsor_user_id`), `.declined`, `.cancelled` (`reason` when the system did it)
and `.expired` (no actor). Every one carries `proposal_id`, `organization_id`,
`proposed_user_id` and `proposed_by_user_id`.

Notifications (the existing inbox, kind = the audit action): the proposed person
when a proposal is made, and the proposer and the organization's OWNERs (except
whoever decided) when it is accepted, declined, cancelled or expires. No e-mail is
sent: the mailer only sends the notification types it already did.

API keys: the endpoints need `organizations:read` (reading) and
`organizations:write` (answering); the list of proposals addressed to *me* is an
`/v1/users/me` route and needs `account:read`.

## Public projects are readable without membership

See [`ACCESS_POLICY.md`](ACCESS_POLICY.md): a non-member (even anonymous) can read
a *public* project through a deny-by-default matrix of GET routes
(`access: "public_read"`), limited per caller by `PUBLIC_READ_RATE_PER_MINUTE`
(default 240; `0` disables) and never charged to the project's sponsor.

## Signing in with Universidad de Sevilla CAS

`GET /v1/auth/cas/start` sends the browser to the university, which sends it
back to `GET /v1/auth/cas/callback`. The callback is a browser navigation, so it
**always answers with a `303` redirect to the frontend** (`FRONTEND_URL`, from
configuration only; nothing in the request can change the destination):

- success: `{FRONTEND_URL}/auth/cas/callback?code=<one-time code>`; the frontend
  exchanges the code at `POST /v1/auth/cas/exchange` for the session.
- failure: `{FRONTEND_URL}/auth/cas/callback?error=<code>`, with a code from this
  closed list:

| `error` | Meaning |
|---|---|
| `cas_unavailable` | CAS login is disabled, or the university's validation could not be reached |
| `cas_state_invalid` | the login state is missing, already used, expired or unknown |
| `cas_ticket_invalid` | the ticket is missing or the university refused it |
| `account_inactive` | the account being signed in or linked is deactivated or gone |
| `identity_in_use` | that UVUS identity is already linked to another account |
| `account_collision` | a local account with the same username or email exists; sign in to it and link CAS explicitly (accounts are never linked by email) |
| `pricing_unavailable` | the pricing service could not be reached |
| `institutional_pricing_invalid` | the live pricing declares no `RESEARCH` plan |
| `cas_error` | anything else (the detail stays in the server log) |

The frontend today understands `identity_in_use`, `account_collision`,
`institutional_pricing_invalid`, `pricing_unavailable` and `cas_unavailable`;
the other four fall back to its generic "this code can't be used" message until
the interface is adapted to them.

### Linking CAS raises the plan to RESEARCH — automatically, at no cost

Linking a verified CAS identity (the callback of a `mode=link` start, whether it
was started with a bearer token or through `POST /v1/auth/cas/link-intent`)
moves an account that is on the default plan to `RESEARCH`. This is a product
decision, not a side effect to be confirmed: it is automatic and **has no extra
cost**. An account already on `RESEARCH`, or on any other plan, is left alone.

So that the person is told, the change is reported where the frontend can show it:

- the callback redirect adds `plan_changed=RESEARCH` next to `code`;
- `POST /v1/auth/cas/exchange` returns the tokens plus
  `plan_changed: {"from": "<previous plan>", "to": "RESEARCH", "extra_cost": false}`
  (`null` when the plan did not change);
- `GET /v1/users/me` shows the resulting `plan` and `cas_verified`;
- the platform audit log records `account.cas.linked` (provider, identity id and
  the `plan_changed` object, never the UVUS or attributes).

Creating a new account through CAS starts it on `RESEARCH`, which is not a
change, so it reports nothing. Unlinking is unchanged: removing the identity of
a `RESEARCH` account needs `?confirmation=DOWNGRADE RESEARCH` and returns it to
the default plan.

## How a limit behaves

Four outcomes, and which applies is a property of the thing being limited
rather than an arbitrary preference.

| Kind | Example | What happens |
|---|---|---|
| A budget you asked for | `time_budget_ms`, `iterations`, `max_evaluations` | **Reduced** to what the plan allows, with an `OPTION_CLAMPED` warning alongside the result |
| A periodic allowance you spend | monthly solver time, task starts, study runs, storage | **Refused** with `402 Payment Required` (`quota_exceeded`), naming the limit, allowance, current usage, and renewal date in a structured `quota` object (no `Retry-After` header) |
| In-flight execution capacity | active simultaneous solves (`concurrentJobs`) | **Throttled** with `429 Too Many Requests` (`concurrency_limit_exceeded`), naming current and max slots in a structured `concurrency` object, with a `Retry-After: 15` header |
| An unentitled capability | private federated engines, high-tier features, RBAC | **Refused** with `403 Forbidden` (`feature_not_entitled` or `forbidden`), because retrying without upgrading or authorization will never succeed |
| A fact about the work | instance complexity (`maxInstanceComplexityLog10` evaluated against $\log_{10}(|S|)$ of the Binding Space) | **Refused** with `402 Payment Required` (`instance_complexity_too_large`), because there is no smaller version of an instance to run without upgrading |


Clamping rather than refusing matters more than it sounds: defaults are applied
before plan ceilings, so refusing an otherwise valid default could make a new
account's first request fail. Every reduction is reported, because a solve that
quietly did a tenth of the work asked for would produce a worse answer with no
explanation.

When both a periodic commercial quota and concurrency are saturated simultaneously,
`402` takes precedence over `429`: telling a client to retry in 15 seconds when their
monthly account balance is exhausted would be misleading and lead to wasted retries.

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
| `CORS_ALLOW_ORIGINS` | Browser origins allowed to call the API, comma separated: a **closed list**. Default: only the local development origins `http://localhost:5173`, `http://127.0.0.1:5173` (Vite) and `http://localhost:4177`, `http://127.0.0.1:4177` (Playwright). There is no wildcard default, because session tokens live in the browser's `localStorage`. With `APP_ENV=prod`, an empty list or a `*` entry makes the gateway **refuse to start** (`CORS_ALLOW_ORIGINS … APP_ENV=prod`), so a production deployment must name its frontend origin(s) exactly. A `*` outside production still works and switches credentialed requests off. |
| `CORS_ALLOW_CREDENTIALS` | Whether credentialed cross-origin requests are allowed (default `true`; ignored when the list contains `*`). |
| `APP_ENV` | `dev` (default), `test` or `prod`; `prod` enables the startup checks above. |
| `FRONTEND_URL` | Where the CAS callback returns the browser (`/auth/cas/callback?code=…` or `?error=…`). |

Cross-origin responses expose these headers to the browser (not configurable):
`Retry-After`, `ETag`, `Location`, `Content-Disposition`, `Digest` and
`Idempotency-Key`. Without `Retry-After` the frontend cannot read the delay of a
`429`. **Upgrading:** a deployment that relied on the old `*` default must now set
`CORS_ALLOW_ORIGINS`; the provided `docker-compose.yml` and Kubernetes config
already do.

Every one of these is declared in `core/settings.py`, which is the answer to
"what can be configured?".

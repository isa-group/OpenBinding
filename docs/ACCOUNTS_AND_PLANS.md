# Accounts, plans and limits

> As implemented today (pricing 0.1.x, sponsorship, local usage counters). The target is ADR-0015,
> `docs/ARCHITECTURE.md` §9 and the pricing proposal 0.2.0 in [`docs/pricing/`](pricing/README.md).

The OpenBinding `/v1` gateway separates public validation from authenticated
job ownership: every `/v1/jobs` request resolves to an account (`401`
otherwise), which owns the job.

Three ideas carry most of the weight:

**The web and the API share identity, not authority.** A browser session and an
API key resolve to the same account, so one plan and one ownership boundary
apply. A session controls the account; each API key is narrower, with immutable
permissions and either an exact Engine allow-list or access to all visible
Engines. Every operation remains a documented gateway endpoint.

**The gateway does not decide entitlements.** A SPACE instance does. SPACE
(`https://space.score.us.es`) is a **remote** service administered in its own
console; it holds a contract per user and knows what each plan allows. The
pricing itself is published in the remote SPHERE and SPACE. OpenBinding
*shows* the plan, permissions and links, *reads* the published pricing
read-only, and delegates account creation and plan changes to the official
SPACE client (`MANAGEMENT`-scoped key, `space_client/space.py`). It has no
local SPACE stack, no pricing editor and no contract lifecycle of its own.

**Nothing is metered or charged.** There are no credits, compute units or
consumption counters. The plan decides *what* an account may do (features) and
*how big* a request may be (ceilings); the only limit on *how much at once* is
a technical concurrency cap that does not depend on the plan
([below](#how-a-limit-behaves)).

> **Retired.** The earlier consumption accounting (credits and capacity units,
> reservations, settlement, usage resynchronisation) and the automatic Engine
> selection were removed from the backend, the frontend and the compose files.
> A future automatic-selection component is a separate, later research project
> and is not a feature of this platform.

## Roles

Two independent role sets exist, both defined in the database models:

- **Account role** `UserRole` (`db/models.py`): `USER` (`"user"`) and `ADMIN`
  (`"admin"`). `ADMIN` is a platform administrator.
- **Organization role** `OrganizationRole` (`db/platform_models.py`): `OWNER`,
  `ADMIN`, `MEMBER`, `VIEWER`. See [below](#organization-roles-and-owner-only-changes).

A platform role alone grants no access to a private organization, and
organization roles grant nothing on the platform.

## Getting an account

Registration is open: `POST /v1/auth/register` creates an account on the
catalogue's default plan (the one non-institutional plan priced at zero,
`PricingCatalog.default_plan` in `pricing_catalog.py`) and a contract to go
with it. If SPACE is unreachable at that moment the account is still created
and owes a contract (`contract_pending`), which is settled the next time that
user turns up (`access/contracts.py`) — losing a sign-up because a pricing
service was restarting would be the worse failure.

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

**Analysis routes.** `jobs:read` reads analyses: `GET /v1/analysis/sources`,
`GET /v1/analysis/pareto/{task_id}`, and the `POST` routes that only read stored
evidence (`query`, `candidate`, `export`). Starting or cancelling analysis work
creates and dispatches an `AnalysisTask`, so `POST /v1/analysis/pareto` and
`POST /v1/analysis/pareto/{task_id}/cancel` additionally need
`engines:execute`, the permission `POST /v1/jobs` needs. A key with only
`jobs:read` gets `403 insufficient_api_key_permission` (`missing_permissions`
lists `engines:execute`) and no task is created or dispatched; a key outside the
analysed sources still gets `404` first. Sessions do not go through key
permissions and are unchanged, and any other `/v1/analysis` route stays closed to
a key without `jobs:read`. The generated OpenAPI document and `docs/openapi.json`
are not changed: `x-required-api-key-permissions` of these two operations still
lists `jobs:read`, the check on top of it is made by the route
(`security/apikeys.py: analysis_work_permissions`).

The number of active keys is the plan's `apiKeys` limit, read from the
contract (`routes/users.py`); exceeding it is `402 quota_exceeded`. Revoked keys
do not count. The gateway locks the account row so the count-and-create of
concurrent requests cannot step past the limit (the row lock is effective on
PostgreSQL; SQLite ignores it, see [IDEMPOTENCY.md](IDEMPOTENCY.md)).

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

**Seeded**, for a database with nothing in it at all, and only on request:

```
SEED_DEFAULT_ADMIN=true
BOOTSTRAP_ADMIN_PASSWORD=<at least 10 characters>
```

With both set, an empty database gets an `admin` account with that password at
startup, whatever `APP_ENV` is. Without the opt-in nothing is seeded, and
without a password (or with a weak one) no account is created and a warning
that never contains the password is logged. There is no built-in password.
Sign in, create a real administrator, deactivate this one.

```bash
python tools/seed_admin.py
```

Does the same by hand: it uses `BOOTSTRAP_ADMIN_PASSWORD` when set, otherwise it
generates a random password and shows it once in the terminal. It refuses if
there is even one account already.

The `dev` profile of `docker-compose.yml` passes `SEED_DEFAULT_ADMIN` through
and listens on `127.0.0.1:8000` only; it is not meant to be reachable from other
machines.

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

### What each role may do with work

VIEWER is a read role. It reads the authorized results of an organization and
never starts, repeats, cancels or deletes work. Every action below is checked
against the role in the organization that owns the snapshot, project or job,
before anything is compiled, reserved or written.

| Action | Route | Minimum role |
|---|---|---|
| Read jobs, studies, runs, cells, artifacts and results of a project | `GET` routes of `/v1/organizations/{org}/projects/{project}/…` | VIEWER (jobs redacted, see below) |
| Launch a job on a snapshot shared with the organization | `POST /v1/jobs` with `{"snapshot": …}` | MEMBER |
| Create a study, collection or case | `POST …/studies`, `…/collections`, `…/cases` | MEMBER |
| Run a study, retry a cell, cancel a run | `POST …/studies/{study}/runs`, `…/cells/{cell}/retry`, `…/runs/{run}/cancel` | MEMBER |
| Retry or cancel a job of an organization | `POST /v1/jobs/{id}/retry`, `POST /v1/jobs/{id}/cancel` | MEMBER (the job must also be the caller's) |
| Queue or cancel an analysis (Pareto) on the jobs of an organization | `POST /v1/analysis/pareto`, `POST /v1/analysis/pareto/{task}/cancel` | MEMBER |
| Delete a study | `DELETE …/studies/{study}` | ADMIN |

A refused role is `403` with the stable code `insufficient_role` for `/v1/jobs`
and `/v1/analysis` (and `organization_forbidden` on the project routes, as
before). A user who has no role at all in the organization that owns a snapshot
still gets `404 not_found`, the same as for a snapshot that does not exist.

Work that belongs to no organization is personal and needs no role: a user's own
snapshot, a `.bim.zip` upload (raw or multipart) and a job with no
`organization_id`. A VIEWER keeps that.

An API key inherits the role of its user and adds its permissions on top; neither
widens the other. A key without `engines:execute` cannot launch, retry or cancel
even when its user is a MEMBER (`403 insufficient_api_key_permission`), and a key
with `engines:execute` whose user is a VIEWER cannot either (`403 insufficient_role`).
Tests: `openbinding-gateway/tests/test_viewer_read_only.py`.

### What a VIEWER reads of a failed job

A VIEWER (and an API key that cannot write projects, in the job list and in the
project package export) reads the job redacted: options by allow-list, the
request reduced to the problem and the pinned choices, provenance without
credentials. The `error` of a failed job is also replaced. The stored message is
the text of the exception that stopped the job and can name the host or address
of a private federated endpoint, so a redacted view shows the fixed text
`The job failed. The details are visible to project members.` instead. If the
result carries a category code (`errorCode` or `error_code`, a plain name such as
`engine_error`) it is appended as `(category: engine_error)`; the free-text
message is never shown. MEMBER and above read the message as stored, as before.

## What an administrator can do

List accounts, deactivate one, change its role, move it between plans, and
revoke a key. Deliberately not: change a password or an email address. Those are
the two ways to sign in, so an administrator able to change them could take an
account over without its owner noticing.

There is no payment gateway. A plan change is performed through the SPACE
client as a **novation** of the user's contract
(`PricingGate.change_plan` / `change_subscription`, `space_client/gate.py`).
The novation happens before the cached plan (`User.plan_cache`) is updated, so a
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

The earlier usage-resynchronisation action and its audit event no longer
exist: there is no usage counter to correct.

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

## Sponsorship needs the sponsor's acceptance

The sponsor of an organization (`billing_sponsor_user_id`) is the account whose
plan limits (organizations, members, projects, studies, storage, …) the
organization **and its whole subtree** count against
(`collaboration.enforce_sponsor_capacity`). No money changes hands. Nobody can
be made to carry someone else's organization: naming another person only creates
a **proposal**, and the sponsor changes when that person accepts.

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
  organization and its subtree, which moves what counts against the limits.
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
(default 240; `0` disables) and never counted against the project's sponsor.

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

Which outcome applies is a property of the thing being limited rather than an
arbitrary preference. Every limit below is either a plan entitlement read from
the SPACE contract or the one technical cap; none of them is a consumption
counter.

| Kind | Example | What happens | Code |
|---|---|---|---|
| A budget you asked for | `time_budget_ms`, `iterations`, `max_evaluations` (ceilings `maxTimeoutSeconds`, `maxIterations`) | **Reduced** to what the plan allows, with an `OPTION_CLAMPED` warning alongside the result | `access/policy.py` |
| An unentitled capability | `solve`, `federatedEngines`, `studies` | **Refused** with `403` (`feature_not_entitled`), because retrying without a plan change will never succeed | `domain/entitlements.py` |
| A fact about the work | instance complexity (`maxInstanceComplexityLog10` against log10 of the Binding Space size) | **Refused** with `402` (`instance_complexity_too_large`): there is no smaller version of the instance to run | `access/policy.py` |
| A size or count allowance in the plan | `apiKeys`, `maxPayloadBytes`, `storageBytes`, organization/member/project counts of the sponsor | **Refused**: `402 quota_exceeded` / `storage_quota_exceeded` / `sponsor_quota_exceeded`, or a payload ceiling | `access/policy.py` (rules) through `services/entitlements.py`; `apiKeys` is still counted in `routes/users.py` |
| Technical concurrency | queued plus running jobs of one account | **Throttled** with `429 concurrency_limit_exceeded`, `Retry-After: 15` and a `concurrency: {limit, active}` object | `jobs/limits.py` |

### One reader of the plan

Every decision above starts from the account's capabilities, and they are read in
exactly one place: `services/entitlements.py` (`EntitlementService`, see
[gateway-as-is.md](architecture/gateway-as-is.md#entitlements)). It is the only module that calls
`get_gate().caps(...)` (enforced by `tests/test_architecture_layers.py`). The rules
stay in `access/policy.py` and `domain/entitlements.py`; the service names them
(`require_feature`, `payload_ceiling`, `solve_timeout`, `clamp_options`,
`complexity_too_large`, `enforce_sponsor_usage`, `enforce_storage_quota`). When the
pricing service cannot be read the answer is always `503 pricing_unavailable`
(never a refusal, never a grant); code running outside a request gets the
`EntitlementsUnavailable` exception instead, and a study cell launch treats it as
retryable: if the plan becomes unreadable after the run was accepted, the run
still answers `202` and the cell waits (an unreadable plan at the very start of
`POST .../studies/{study}/runs` is the `503`, as before). `GET /v1/users/me` and `/me/usage` keep their own wording, prefixed with
"Entitlements cannot be read right now:".

Clamping rather than refusing matters more than it sounds: defaults are applied
before plan ceilings, so refusing an otherwise valid default could make a new
account's first request fail. Every reduction is reported, because a solve that
quietly did a tenth of the work asked for would produce a worse answer with no
explanation.

Not every plan limit in the published pricing is read by this code. The ones
read at the time of writing are the identifiers found by searching the gateway
for `caps.limit(...)` and `feature_refusal(...)`: `apiKeys`, `jobHistoryDays`,
`maxTimeoutSeconds`, `maxIterations`, `maxPayloadBytes`, `storageBytes`,
`maxInstanceComplexityLog10`, the sponsor structure limits passed to
`enforce_sponsor_usage`, and the features `solve`, `federatedEngines`,
`studies` and `institutionalBranding`. Other identifiers in the pricing
fixture (`tests/fixtures/pricing_test.yml`) may be unused by the gateway.

## The technical concurrency limit

`MAX_CONCURRENT_JOBS_PER_USER` (`core/settings.py`, default `8`, minimum `1`) is
how many jobs one account may have `queued` or `running` at once. It protects
the engines and does **not** depend on the plan or on SPACE. Every entry point
that creates a job (`POST /v1/jobs`, retry, study cells) calls
`jobs/limits.enforce_concurrency_limit` inside the transaction that inserts the
job, after an idempotent replay has been ruled out, so a replay does not take a
second slot. The check locks the account row (`FOR UPDATE`) so that two
concurrent creations count each other; SQLite has no row locks, and there the
count alone is the check (see [IDEMPOTENCY.md](IDEMPOTENCY.md)). A refused
request is `429 concurrency_limit_exceeded`; a slot is released simply by the
job reaching a terminal state.

## Jobs nobody watches

A client that stops polling, a gateway that restarts or an engine that dies
leaves a job `queued` or `running` for ever, and a job in flight holds one of the
account's concurrency slots. The job lifecycle lives in
`openbinding_gateway/jobs/` and charges nothing:

- `leases.py`: a worker claims a job with `claim_job` (one conditional `UPDATE`
  from `queued` to `running`) and takes a **60 s lease**, renewed by a
  **20 s heartbeat**; at most `MAX_ATTEMPTS = 2` claims per job.
- `reconciler.py` (`sweep_abandoned`): a lapsed lease means the worker died. The
  **first** time the job goes back to `queued`; the **second** time it is
  `failed`. A job without a lease (never claimed) is failed once its requested
  budget plus a 120 s grace have passed, counted from its claim or else its
  creation. The sweep runs every 60 s, takes rows with `FOR UPDATE SKIP LOCKED`
  and writes each change with an `UPDATE` conditioned on the state it read, so a
  heartbeat or claim that lands in between wins.
- `lifecycle.py` / `reconciler._resync_study_cells`: a study cell is synchronised
  when its job changes state, and the sweep catches up the cells of terminal jobs
  that never heard of it (batches of 100).
- `limits.py`: the technical concurrency cap described above.

A worker that lost its lease cannot write a result, a failure or a cancellation
afterwards (`hold_lease` locks the row and checks the token before the outcome is
committed), so an answer arriving after the job was put back cannot overwrite the
run that replaced it. Details and what is and is not guaranteed are in
[IDEMPOTENCY.md](IDEMPOTENCY.md).

**Residual risk: clocks.** Leases are judged by the gateway's clock against
deadlines written from a worker's. Gateway and worker clocks are assumed to be
synchronised (NTP); the 60-second lease with a renewal every 20 seconds tolerates
about 40 seconds of skew before a live worker can look dead. Beyond that, a
healthy job may be put back in the queue once and its late answer is discarded.

## When SPACE is unreachable

`SPACE_FAIL_MODE` is declared in `core/settings.py` (`closed` by default;
`.env.example` sets `open` for development). SPACE being unreachable surfaces as
`PricingUnavailable` (`space_client/gate.py`), deliberately distinct from a
refusal: "your plan does not include this" and "I could not find out what your
plan includes" call for different answers. I did not trace every call site of
`SPACE_FAIL_MODE` for this document, so the exact per-endpoint behaviour is not
described here; entitlement lookups fail closed (`PlanCaps.allows` is `False` for
an unknown identifier).

### What the open gate grants (`SPACE_ENABLED=false`)

`SPACE_ENABLED=false` installs the stateless `OpenGate` (`space_client/open.py`),
for development and QacoBench only (`APP_ENV=prod` refuses to start with it). It
has no plans, contracts or counters, and its `caps()` is a regular `PlanCaps`
(`plan=""`, a `features` map and a `limits` map):

* **Features:** every identifier is allowed (`allows()` is always `True`), and the
  ones the gateway and interface evaluate are listed in `features`.
* **Allowances with a technical ceiling are finite and never above it.**
  `access.policy` fails closed when an entitlement exceeds the ceiling (below), so
  the open gate grants the ceiling itself: `maxTimeoutSeconds` =
  `ENGINE_SOLVE_TIMEOUT_S` and `maxPayloadBytes` = the smaller of
  `MAX_REQUEST_BODY_BYTES` and the 512 MiB request ceiling the routes pass to the
  policy. A time budget above the timeout is therefore clamped (with an
  `OPTION_CLAMPED` warning), as on any plan. `concurrentJobs` reports
  `MAX_CONCURRENT_JOBS_PER_USER`; the enforced concurrency limit is that setting,
  independent of the plan.
* **Allowances with no technical ceiling are unbounded** (`inf`, read as `None`
  by `PlanCaps.limit`, the same encoding as an unlimited real plan): `maxIterations`,
  `maxInstanceComplexityLog10` (no 402), `apiKeys`, `jobHistoryDays`, `storageBytes`,
  `federatedEngines` and the sponsor structure (`organizations`, `members`, `projects`,
  `privateProjects`, `collections`, `studies`).

### A plan above a technical ceiling

A real SPACE plan whose `maxTimeoutSeconds` or `maxPayloadBytes` is unlimited or
above the technical ceiling is a pricing configuration error. The gateway does not
clip it silently: `solve_timeout_s` and `payload_ceiling_bytes` deny the request
with `503` `pricing_misconfigured` (a problem, not an unhandled 500). The fix
belongs in the pricing, or in the technical setting if the plan is right.

### The payload ceiling and a chunked upload

`maxPayloadBytes` applies to a job submission whatever way the body arrives. A
`.bim.zip` sent with `Transfer-Encoding: chunked` has no `Content-Length`, so the
declared size is 0; the submission then measures the bytes actually read and
refuses an archive above the ceiling with `413 payload_too_large`, exactly as it
does for a declared size.

## Configuration

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Async SQLAlchemy URL. Unset means no accounts: the gateway serves anonymously, as it always did, and the account routes answer `503` explaining why. |
| `GATEWAY_JWT_SECRET` | Signs session tokens. No default on purpose — a well-known signing key is worse than a missing one. |
| `SPACE_ENABLED`, `SPACE_URL`, `SPACE_API_KEY`, `SPACE_TIMEOUT_MS` | The remote SPACE (`https://space.score.us.es`). The key must be a `MANAGEMENT`-scoped key created in the SPACE console. A development key lives in the same organizations as production ones and is high-risk: a shared organization does not isolate credentials. |
| `SPACE_SERVICE_NAME` | The SPACE service the gateway reads and writes contracts on, plan names, add-ons and feature identifiers included (default `openbinding`, the production service; shape `[a-z0-9][a-z0-9_-]{1,62}`, anything else stops the start). A development deployment sets its own service (for example `openbinding-dev`) so it never touches production contracts: the target is explicit per environment, because the organization does not isolate credentials. Not restricted by `APP_ENV`. The effective name (never a key) is logged at start-up. `tools/seed_lab.py --space-contracts` requires `SPACE_DEV_SERVICE_NAME` to equal it. |
| `SPHERE_ENABLED`, `SPHERE_URL`, `SPHERE_API_KEY`, `SPHERE_ORGANIZATION_ID` | The remote SPHERE, from which the published pricing is read. |
| `SPACE_FAIL_MODE` | `closed` or `open`, above. |
| `MAX_CONCURRENT_JOBS_PER_USER` | Technical cap on queued plus running jobs per account (default 8). |
| `JOB_DISPATCH_MODE` | `inline` (tests, single-process development) or `dramatiq` (Redis-backed queue). |
| `BOOTSTRAP_ADMIN_*` | The first administrator, above. |
| `SEED_DEFAULT_ADMIN` | Opt-in `admin` account for an empty database; needs `BOOTSTRAP_ADMIN_PASSWORD`. |
| `FEDERATION_SECRET_KEY` | Fernet key for credentials registered with federated engines. |
| `CORS_ALLOW_ORIGINS` | Browser origins allowed to call the API, comma separated: a **closed list**. Default: only the local development origins `http://localhost:5173`, `http://127.0.0.1:5173` (Vite) and `http://localhost:4177`, `http://127.0.0.1:4177` (Playwright). There is no wildcard default, because session tokens live in the browser's `localStorage`. With `APP_ENV=prod`, an empty list or a `*` entry makes the gateway **refuse to start** (`CORS_ALLOW_ORIGINS … APP_ENV=prod`), so a production deployment must name its frontend origin(s) exactly. A `*` outside production still works and switches credentialed requests off. |
| `CORS_ALLOW_CREDENTIALS` | Whether credentialed cross-origin requests are allowed (default `true`; ignored when the list contains `*`). |
| `APP_ENV` | `dev` (default), `test` or `prod`; `prod` enables the startup checks above. |
| `BIM_SERVICE_ALLOW_INSECURE_HTTP`, `FEDERATION_REQUIRE_HTTPS` | Plain-http switches for a trusted development or lab network (the bim-service bearer token over `http`; federated engines over `http`). With `APP_ENV=prod`, `BIM_SERVICE_ALLOW_INSECURE_HTTP=true` or `FEDERATION_REQUIRE_HTTPS=false` makes the gateway **refuse to start**, like `SPACE_ENABLED=false`. `dev`, `test` and the lab are unaffected. |
| `FRONTEND_URL` | Where the CAS callback returns the browser (`/auth/cas/callback?code=…` or `?error=…`). |

Cross-origin responses expose these headers to the browser (not configurable):
`Retry-After`, `ETag`, `Location`, `Content-Disposition`, `Digest` and
`Idempotency-Key`. Without `Retry-After` the frontend cannot read the delay of a
`429`. **Upgrading:** a deployment that relied on the old `*` default must now set
`CORS_ALLOW_ORIGINS`; the provided `docker-compose.yml`
already does.

Every one of these is declared in `core/settings.py`, which is the answer to
"what can be configured?".

# Accounts, plans and limits

> As implemented today: pricing 0.2.0 ([`docs/pricing/`](pricing/README.md)) enforced per
> account, with no billing sponsors and no subtree quotas. The target is `docs/ARCHITECTURE.md` §9.

The OpenBinding `/v1` gateway separates public validation from authenticated
work: every request to the runs of an organization (`/v1/organizations/{org}/runs`)
resolves to an account (`401` otherwise); a run belongs to the organization, and the
account that launched it is recorded and holds its concurrency slot.

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
consumption counters. The plan decides *what* an account may do (features),
*how big* a request may be (ceilings) and *how many* things the account may
hold at once (per-account quotas); concurrency is the lower of the plan's
`maxConcurrentRuns` and a technical cap ([below](#how-a-limit-behaves)).

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

**Analysis routes (removed).** The `/v1/analysis` routes (sources, query,
candidate, export, reports and the Pareto tasks) and their extra
`engines:execute` check were removed by M9.6, together with the analysis queue.
The kept neighbourhood analysis, `GET /v1/organizations/{org}/runs/{run}/neighborhood`,
is guarded by `jobs:read` like any run read. Keys that hold `engines:execute` keep working: it still
guards kept operations. The `reports:read` and `reports:write` permissions were
removed in F0a with the reports; no route needs them.

Minting a key needs the plan's `apiAccess` feature (`403 feature_not_entitled`
otherwise), and the number of active keys is the plan's `maxApiKeys` limit, read
from the contract (`routes/users.py`); exceeding it is `402 quota_exceeded`.
Revoked keys do not count. The gateway locks the account row so the count-and-create of
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
against the role in the organization that owns the problem, study or run,
before anything is compiled, reserved or written.

| Action | Route | Minimum role |
|---|---|---|
| Read the organization's studies, study runs, cells and results | `GET /v1/organizations/{org}/studies/…` | VIEWER |
| Read the organization's problems, revisions and compilations | `GET /v1/organizations/{org}/problems/…` | VIEWER |
| Read the organization's runs, whoever launched them | `GET /v1/organizations/{org}/runs/…` | VIEWER (redacted, see below) |
| Upload a problem or a revision, edit a problem | `POST …/problems`, `POST …/problems/{problem}/revisions`, `PATCH …/problems/{problem}` | MEMBER |
| Launch a run of a revision of the organization's problem | `POST /v1/organizations/{org}/runs` with `{"revision": …}` | MEMBER |
| Create a study | `POST …/studies` | MEMBER |
| Run a study, retry a cell, cancel a run | `POST …/studies/{study}/runs`, `…/cells/{cell}/retry`, `…/runs/{run}/cancel` | MEMBER |
| Retry, cancel or re-evaluate a run of the organization | `POST …/runs/{run}/retry`, `…/cancel`, `…/reevaluate` | MEMBER (any member, not only who launched it; a retry is a new run of the caller) |
| Delete a study or a problem | `DELETE …/studies/{study}`, `DELETE …/problems/{problem}` | ADMIN |

A refused role is `403` with the stable code `insufficient_role` for the runs
(and `organization_forbidden` on the other routes of the
organization). A user who has no role at all in the organization gets `404 not_found` on
its runs, the same as for one that does not exist, and a run naming a revision of
another organization is `409 revision_not_in_organization`. Retrying a teammate's
run on that teammate's private engine is refused when it is dispatched
(`registration_changed`): a private engine resolves for the caller only.

Every run belongs to the organization of its problem: there is no personal work.
Checking a package without storing it (`POST /v1/bim/validate`) needs no account.

An API key inherits the role of its user and adds its permissions on top; neither
widens the other. A key without `engines:execute` cannot launch, retry or cancel
even when its user is a MEMBER (`403 insufficient_api_key_permission`), and a key
with `engines:execute` whose user is a VIEWER cannot either (`403 insufficient_role`).
Tests: `openbinding-gateway/tests/test_viewer_read_only.py`.

### What a VIEWER reads of a failed run

A VIEWER (and an API key that cannot run engines, without `engines:execute`, in
the run list and on a run's page) reads the run redacted: options by allow-list, the
request reduced to the problem and the pinned choices, provenance without
credentials. The `error` of a failed job is also replaced. The stored message is
the text of the exception that stopped the job and can name the host or address
of a private federated endpoint, so a redacted view shows the fixed text
`The job failed. The details are visible to organization members.` instead. If the
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

### A change decided on an outdated contract is refused

Two administrators can look at the same account, and SPACE renews contracts on
its own, so a change can be decided on a contract that has moved by the time it
is applied. Applied anyway, it would silently undo whatever happened in between.
The gateway uses SPACE's optimistic concurrency against that
(`space-python-client` 1.1.0, `SpacePricingGate._novate` in `space_client/space.py`):

- The subscription is a conditional write like the others of
  [ERRORS.md](ERRORS.md#conditional-writes-if-match).
  `GET /v1/admin/users/{id}/subscription` carries an `ETag`, the revision of the
  contract (a digest of SPACE's contract version). `POST /v1/admin/users/{id}/plan`
  and `/subscription` take it as `If-Match`, and their `200` carries the new one.
  A tag that no longer names the contract is `412 precondition_failed`, with the
  current `ETag`, before anything that depends on stored state; a malformed one
  is `400 invalid_if_match`. The tag travels in headers only, never in a body.
- The novation first runs as a dry run (`preview_novation`, which writes
  nothing). A selection SPACE refuses there is the usual
  `422 invalid_subscription`, with SPACE's error codes in the log. Then it is
  written with `If-Match` set to the contract version the gateway read for this
  request (`/plan` carries the add-ons over from that read).
- A contract that moves while the request is being applied, seen by the dry run
  or refused by SPACE with `412`, is refused as well: `412 precondition_failed`
  (with the `ETag` as it is now) when the request's `If-Match` named a revision,
  `409 contract_changed` with a fixed sentence otherwise, `*` included. Nothing
  was written, so there is no audit event and no notification. Read the
  subscription again and decide again. (`409` on these two endpoints can also be
  `research_requires_us_cas`.)
- Without `If-Match` the change is computed on the contract as the gateway reads
  it, so only a change landing during the request itself is caught: a screen
  that wants its own reading protected sends the `ETag` it was given. The
  administrator's agreement screen does. When such a change is refused it says
  so in the review, reads the subscription again and draws the review again from
  it, and nothing is sent again until the administrator confirms.

Every novation keeps the current billing period (`keep_billing_period`).
OpenBinding charges nothing, so a plan change, or a novation that only moves the
contract to `SPACE_PRICING_VERSION`, no longer moves the renewal date. No
novation asks SPACE to refuse private plans (`reject_private`): an administrator
is exactly who may assign one, and the CAS upgrade must keep working should
RESEARCH be private.

The automatic plan changes follow a rule, so they decide again instead of
failing. When the contract moved between the read and the novation, linking a
`us-cas` identity (default plan to RESEARCH) and unlinking it with
`DOWNGRADE RESEARCH` (RESEARCH to the default plan) read the contract again and
apply the rule once more: an account an administrator moved meanwhile keeps its
plan. A second change in a row is the usual `pricing_unavailable`.

All of this depends on what SPACE advertises in `X-Space-Capabilities`, which
the client reads from any response or from SPACE's unauthenticated healthcheck.
The dry run and `If-Match` need `novation-preview` and `contract-version`;
keeping the billing period needs `keep-billing-period`. The remote SPACE
advertised all three on 2026-11-07. A SPACE without them gets the unconditional
novation it always got, and the gateway logs a warning for each one. A SPACE
that keeps no contract versions gives the subscription no `ETag`, and then only
`If-Match: *` matches. If SPACE
applies a novation but its answer shows a guarantee was dropped (no `ETag`, a
restarted billing period), the change is in place: the gateway records it as
made and logs which guarantee was missing.

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
organization events (member changes, edits, …) carry `organizationId` and
`organizationSlug`, platform events carry `null`. Filter with `?action=` and
`?organization_id=<uuid>`. Members of an organization still read only their own
organization's log, at `GET /v1/organizations/{org}/audit`, which never shows
platform events.

## Quotas are per account

Every plan limit is counted for the account that does the work, never for an
organization or the person who created it: organizations carry no billing
sponsor, and there are no subtree quotas. Creating organizations and adding
members are not limited by the plan, and there are no projects (`maxCollections` and `maxPrivateProjects` are in the published 0.2.0 YAML
but not enforced until 0.3.0, see [pricing/README.md](pricing/README.md)).

The per-account quotas are pure checks in `modules/plans/domain/quotas.py`
(`problems_quota`, `storage_quota`); the caller counts inside the transaction
that holds the account's row lock and asks whether one more fits. A refusal is
`402 quota_exceeded` with `quota: {limit_id, limit, used, unit, source}`.
`maxRepositoryStorage` is in MB of 10^6 bytes. Until the problems API arrives,
storage is the sum of the blobs the account uploaded (an interim count); then it
becomes the sum of the account's problem revisions.

## Deleting an account pseudonymises it

`DELETE /v1/users/me` needs the exact username as confirmation and, for a
password account, the current password; the last OWNER of an organization is
refused with `409 last_owner`. Then, in one transaction (`routes/users.py`,
`pseudonymise`), with the SPACE contract removed last, just before the commit:
if the removal fails (`503 pricing_unavailable`), or the database refuses any
step, nothing is changed and the contract stays.

- the user row **stays**, so the runs, revisions and engines the account created
  keep naming somebody; its username becomes `deleted-<12 hex>`, its email
  `deleted+<id>@users.invalid`, its password an unusable hash, `preferences`
  empty, `plan_cache` empty, `role` USER, `is_active` false and `deleted_at`
  set (so a deleted administrator no longer counts as one, and the bootstrap
  administrator is seeded again when it was the last);
- its API keys, refresh tokens, password-reset tokens, linked identities,
  notifications, memberships and the invitations it sent or received are
  deleted;
- each of its active federated engine registrations is deactivated, as the
  `deactivate` route does, so no new run selects it; the engine and registration
  revisions stay, because past runs name them in their provenance;
- `account.deleted` is audited with no personal data.

Nothing is reassigned to another person. The foreign keys that history holds on
an account (`jobs.owner_id`, engine revisions, registration revisions, manifest
publications) are `RESTRICT`, so a stray hard delete fails instead of destroying
shared history. Administration no longer lists or acts on a deleted account.

A username that names engine revisions or engine registration revisions stays
reserved: engine namespaces are the username baked into immutable manifests, so
registration and a first CAS sign-in refuse it with `409 username_unavailable`.
So is every username that starts with `deleted-`, the pseudonyms of deleted
accounts.

## No public read

Everything under an organization is for its members (see
[`ACCESS_POLICY.md`](ACCESS_POLICY.md)). Public read was a property of projects, and
projects are gone; a public showcase arrives with compositions (F1/F9). Checking a
package without storing it (`POST /v1/bim/validate`) and the templates
(`GET /v1/bim/templates*`) need no account and read no organization.

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
| `username_unavailable` | the UVUS is a reserved username: it names published engines, or is the pseudonym of a deleted account |
| `pricing_unavailable` | the pricing service could not be reached |
| `institutional_pricing_invalid` | the live pricing declares no `RESEARCH` plan |
| `cas_error` | anything else (the detail stays in the server log) |

The frontend has its own words for every code of this list; anything else falls
back to its generic "this code can't be used" message.

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
the default plan. Both changes apply to the contract version they were decided
on; if the contract moved meanwhile, the rule is applied once more to the
contract as it is now (see "A change decided on an outdated contract is
refused").

## How a limit behaves

Which outcome applies is a property of the thing being limited rather than an
arbitrary preference. Every limit below is either a plan entitlement read from
the SPACE contract or the one technical cap; none of them is a consumption
counter.

| Kind | Example | What happens | Code |
|---|---|---|---|
| A budget you asked for | `time_budget_ms` (ceiling: the plan's `maxRunMinutes` × 60 000, never above `ENGINE_SOLVE_TIMEOUT_S`), `iterations`, `max_evaluations` (ceiling: the setting `MAX_ITERATIONS`) | **Reduced** to what is allowed, with an `OPTION_CLAMPED` warning alongside the result | `access/policy.py` |
| An unentitled capability | `runs`, `federatedEngines`, `studies`, `apiAccess` | **Refused** with `403` (`feature_not_entitled`), because retrying without a plan change will never succeed | `domain/entitlements.py` |
| A fact about the work | the binding-space size against the setting `MAX_BINDING_SPACE_LOG10` (default 20) | **Refused** with `422` (`binding_space_over_technical_limit`): there is no smaller version of the instance to run, and no plan raises it | `domain/binding_space.py` |
| A package that is too large | the setting `MAX_PACKAGE_BYTES` | **Refused** with `413 payload_too_large` | `access/policy.py` |
| A count allowance in the plan | `maxApiKeys`, `maxFederatedEngines`, `maxProblems`, `maxRepositoryStorage` | **Refused**: `402 quota_exceeded` | `modules/plans/domain/quotas.py`; keys and engines are counted in their routes, problems and the bytes of their revisions in `modules/problems` |
| Cells of a study run | the lower of the plan's `maxStudyCells` and the setting `MAX_CELLS_PER_STUDY_RUN` | **Refused** whole with `422 study_run_too_large`, `quota.source` saying which limit applied | `routes/studies.py` |
| Concurrency | queued plus running jobs of one account, the lower of the plan's `maxConcurrentRuns` and `MAX_CONCURRENT_JOBS_PER_USER` | **Throttled** with `429 concurrency_limit_exceeded`, `Retry-After: 15` and a `concurrency: {limit_id, limit, used, source}` object | `jobs/limits.py` |

### One reader of the plan

Every decision above starts from the account's capabilities, and they are read in
exactly one place: `services/entitlements.py` (`EntitlementService`). It is the only module that calls
`get_gate().caps(...)` (enforced by `tests/test_architecture_layers.py`). The rules
stay in `access/policy.py` and `domain/entitlements.py`; the service names them
(`require_feature`, `payload_ceiling`, `solve_timeout`, `clamp_options`,
`binding_space_refusal`, `enforce_storage_quota`). When the
pricing service cannot be read the answer is always `503 pricing_unavailable`
(never a refusal, never a grant); code running outside a request gets the
`EntitlementsUnavailable` exception instead, and a study cell launch treats it as
retryable: if the plan becomes unreadable after the run was accepted, the run
still answers `202` and the cell waits (an unreadable plan at the very start of
`POST .../studies/{study}/runs` is the `503`, as before). `GET /v1/users/me/usage` keeps its own wording, prefixed with
"Entitlements cannot be read right now:". `GET /v1/users/me` never asks SPACE: the
plan it shows is the one recorded on the account (`plan_cache`). When a contract
is created without a plan (`SPACE_DEFAULT_PLAN` unset), the gateway reads the plan
SPACE assigned right after creating it and records it there.

Clamping rather than refusing matters more than it sounds: defaults are applied
before plan ceilings, so refusing an otherwise valid default could make a new
account's first request fail. Every reduction is reported, because a solve that
quietly did a tenth of the work asked for would produce a worse answer with no
explanation.

Every entitlement id the gateway reads is spelled in one place,
`modules/plans/domain/entitlement_map.py`: the features `runs`,
`federatedEngines`, `studies`, `repository` and `apiAccess`, and the limits
`maxRunMinutes`, `maxConcurrentRuns`, `maxStudyCells`, `maxFederatedEngines`,
`maxApiKeys`, `maxProblems` and `maxRepositoryStorage` (all `NUMERIC`).
`tests/test_entitlement_map.py` fails on a string id passed to `caps.limit`,
`caps.allows` or `feature_refusal` anywhere else. The other ids of the published
pricing (`solverHours`, `generator`, `generatedInstances`,
`maxInstancesPerGeneration`, `collaboration`, `maxCollections`,
`maxPrivateProjects`) are not read.

### The startup check

The lifespan (`main.check_pricing`) reads the published pricing through the gate
right after installing it: from SPACE (`SPACE_PRICING_VERSION`, or the version
SPACE assigns to new contracts), or the package copy
`modules/plans/pricing/openbinding-0.2.0.yml` under the open gate. A document that
lacks one of the ids above, or declares one of the limits as anything but
`NUMERIC`, stops the start (`RuntimeError: pricing <v> lacks: …`). With SPACE
enabled, `SPACE_ORGANIZATION_ID` must be set and SPACE must advertise
`pricing-token-jwks`; their absence, or a SPACE that cannot be reached, stops the
start under `APP_ENV=prod` and is a warning elsewhere.

## The technical concurrency limit

`MAX_CONCURRENT_JOBS_PER_USER` (`core/settings.py`, default `8`, minimum `1`) is
how many jobs one account may have `queued` or `running` at once. It protects
the engines and does **not** depend on the plan or on SPACE. Every entry point
that creates a job (`createRun`, `POST /v1/organizations/{org}/runs`; retry; study
cells) calls
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

SPACE being unreachable surfaces as `PricingUnavailable` (`space_client/gate.py`),
deliberately distinct from a refusal: "your plan does not include this" and "I
could not find out what your plan includes" call for different answers. Every
plan read fails closed with `503 pricing_unavailable`; there is no fail-open
switch.

### Pricing tokens are verified

The plan of an account comes from its pricing token, and the token is believed
only once it is verified (`space_client/space.py`, `_verified_claims`):
`features.verify_pricing_token` checks the ES256 signature against the keys SPACE
publishes (JWKS), `exp` (with `SPACE_TOKEN_LEEWAY_S`), `iss`
(`SPACE_TOKEN_ISSUER`) and `aud`/`organizationId` (`SPACE_ORGANIZATION_ID`);
then the gateway requires `pricing_token_user_id(payload)` to be the account (the
client does not check the user, and `sub` may be an opaque URN). A token that
fails any check, or a SPACE that does not publish its keys, is
`PricingUnavailable`: there is no unverified fallback. The token handed to the
browser (`GET /v1/users/me/pricing-token`) is verified the same way. The plan is
the token's own `subscription` claim; only a SPACE that sends none is asked for
the contract.

### What the open gate grants (`SPACE_ENABLED=false`)

`SPACE_ENABLED=false` installs the stateless `OpenGate` (`space_client/open.py`),
for development and QacoBench only (`APP_ENV=prod` refuses to start with it). It
has no plans, contracts or counters, and its `caps()` is a regular `PlanCaps`
(`plan=""`, a `features` map and a `limits` map) generated from the entitlement
map: every feature the gateway reads is granted (and `allows()` is `True` for any
identifier), and every limit it reads is unbounded (`inf`, read as `None` by
`PlanCaps.limit`, the same encoding as an unlimited real plan). Only the
deployment's technical ceilings apply: a time budget above
`ENGINE_SOLVE_TIMEOUT_S` is clamped with an `OPTION_CLAMPED` warning, and the
concurrency limit is `MAX_CONCURRENT_JOBS_PER_USER`.

### A plan that grants more than the deployment, or declares nothing

A plan whose `maxRunMinutes` is above `ENGINE_SOLVE_TIMEOUT_S` (LAB grants a day)
runs as long as the deployment waits: the time budget is clamped to the ceiling
and the warning says it is the deployment's. A plan that does not declare
`maxRunMinutes` at all is a pricing configuration error, answered with `503`
`pricing_misconfigured` rather than a zero-second run.

### The package ceiling and a chunked upload

`MAX_PACKAGE_BYTES` applies to a job submission whatever way the body arrives. A
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
| `SPACE_PRICING_VERSION`, `SPACE_DEFAULT_PLAN` | The pricing version new contracts are pinned to and the startup check reads (`0.2.0`), and the plan a sign-up starts on (`FREE`). |
| `SPACE_ORGANIZATION_ID`, `SPACE_TOKEN_ISSUER`, `SPACE_TOKEN_LEEWAY_S` | What a pricing token is verified against: its `aud`/`organizationId` (required with SPACE enabled; `APP_ENV=prod` refuses to start without it), its `iss` (default `space`) and the tolerance for its `exp` (default 30 s). |
| `SPHERE_ENABLED`, `SPHERE_URL`, `SPHERE_API_KEY`, `SPHERE_ORGANIZATION_ID` | The remote SPHERE, from which the published pricing is read. |
| `MAX_CONCURRENT_JOBS_PER_USER` | Technical cap on queued plus running jobs per account (default 8); the plan's `maxConcurrentRuns` may lower it. |
| `MAX_PACKAGE_BYTES` | Largest BIM package of one request (default 128 MiB, never above `MAX_REQUEST_BODY_BYTES`). |
| `MAX_ITERATIONS` | Ceiling on `iterations` and `max_evaluations` (default 1 000 000). |
| `MAX_BINDING_SPACE_LOG10` | Ceiling on the binding-space size, in log10 combinations (default 20). |
| `MAX_CELLS_PER_STUDY_RUN` | Technical ceiling on the cells of one study run (unset: none); the plan's `maxStudyCells` applies too. |
| `JOB_DISPATCH_MODE` | `inline` (tests, single-process development) or `dramatiq` (Redis-backed queue). |
| `BOOTSTRAP_ADMIN_*` | The first administrator, above. |
| `SEED_DEFAULT_ADMIN` | Opt-in `admin` account for an empty database; needs `BOOTSTRAP_ADMIN_PASSWORD`. |
| `FEDERATION_SECRET_KEY` | Fernet key for credentials registered with federated engines. |
| `CORS_ALLOW_ORIGINS` | Browser origins allowed to call the API, comma separated: a **closed list**. Default: only the local development origins `http://localhost:5173`, `http://127.0.0.1:5173` (Vite) and `http://localhost:4177`, `http://127.0.0.1:4177` (Playwright). There is no wildcard default, because session tokens live in the browser's `localStorage`. With `APP_ENV=prod`, an empty list or a `*` entry makes the gateway **refuse to start** (`CORS_ALLOW_ORIGINS … APP_ENV=prod`), so a production deployment must name its frontend origin(s) exactly. A `*` outside production still works and switches credentialed requests off. |
| `CORS_ALLOW_CREDENTIALS` | Whether credentialed cross-origin requests are allowed (default `true`; ignored when the list contains `*`). |
| `APP_ENV` | `dev` (default), `test` or `prod`; `prod` enables the startup checks above. |
| `FEDERATION_REQUIRE_HTTPS` | Plain-http switch for a trusted development or lab network (federated engines over `http`). With `APP_ENV=prod`, `FEDERATION_REQUIRE_HTTPS=false` makes the gateway **refuse to start**, like `SPACE_ENABLED=false`. `dev`, `test` and the lab are unaffected. |
| `FRONTEND_URL` | Where the CAS callback returns the browser (`/auth/cas/callback?code=…` or `?error=…`). It must be `scheme://host[:port]`, with no path, query, fragment or userinfo. |

Origin values (`FRONTEND_URL` and every `CORS_ALLOW_ORIGINS` entry) must be
`scheme://host[:port]` with no path, query, fragment or userinfo, and
`CORS_ALLOW_ORIGINS` entries must be written exactly as a browser sends them in
`Origin`: lower-case, no trailing `/`, default port omitted (`http://localhost`,
not `http://localhost:80`). The gateway checks the format at startup and refuses
to start, naming the variable.

Cross-origin responses expose these headers to the browser (not configurable):
`Retry-After`, `ETag`, `Location`, `Content-Disposition`, `Digest` and
`Idempotency-Key`. Without `Retry-After` the frontend cannot read the delay of a
`429`. **Upgrading:** a deployment that relied on the old `*` default must now set
`CORS_ALLOW_ORIGINS`; the provided `docker-compose.yml`
already does.

Every one of these is declared in `core/settings.py`, which is the answer to
"what can be configured?".

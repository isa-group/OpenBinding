# Access policy: the organization and its members

The organization is the only container. Everything a person works on lives under
`/v1/organizations/{org}/...`: its members, invitations and audit log, its problems
(with their revisions and compilations), its runs, its studies and its compositions. There are no
projects, and there is no public read: every route under an organization is for its
members.

## Who reaches an organization

A member of the organization, or of one of its ancestors, has a role there
(`VIEWER` < `MEMBER` < `ADMIN` < `OWNER`); the strongest of the roles held along
the chain applies (`collaboration.effective_role`). Anybody else is refused:

- a signed-in non-member gets `403 organization_forbidden`; a slug that names no
  organization is `404 not_found`; the runs routes answer `404` to a non-member too
  (below), and so do the compositions routes: a composition the caller cannot read
  answers exactly as a missing one, `404` and never `403`, on every route and before
  any `If-Match` handling;
- a caller with no credential gets `401` on every route under `/v1/organizations`;
- a platform administrator is a non-member like anybody else unless invited.

API keys keep their own rules: the permission the route needs
(`x-required-api-key-permissions` in the OpenAPI document), the Engine allow-list,
and the optional boundary (methods, organizations, resource kinds and slugs). A key
cannot be bounded to projects any more; a stored boundary that still names them is
malformed, and a malformed boundary denies everything.

## Matrix (relative to `/v1/organizations/{org}`)

| Routes | Read | Write | API key permission |
|---|---|---|---|
| `` (the organization), `/members`, `/members/batch`, `/members/{member}`, `/invitations` | VIEWER (members list) | ADMIN; owner changes need OWNER; deleting needs ADMIN (below) | `organizations:read` / `organizations:write` |
| `/audit` | ADMIN | — | `organizations:read` |
| `/problems`, `/problems/{problem}`, `/problems/{problem}/revisions/...` | VIEWER | MEMBER uploads, adds revisions and edits; ADMIN deletes | `problems:read` / `problems:write` |
| `/runs/...` | VIEWER (redacted below MEMBER) | MEMBER | `jobs:read` / `engines:execute` |
| `/studies/...` (study runs and cells included) | VIEWER | MEMBER creates, edits and runs; ADMIN deletes | `studies:read` / `studies:write` |
| `/compositions`, `/compositions/{composition}`, `/compositions/{composition}/versions/...` | VIEWER (a non-member gets `404`); VIEWER also checks a document (`POST …/versions/check`) | MEMBER creates, edits and seals versions; ADMIN deletes | `compositions:read` / `compositions:write` |

## Deleting an organization

`DELETE /v1/organizations/{org}` needs ADMIN (or OWNER) of the organization, or a
platform administrator. It takes the organization and every organization below it in
one transaction. Runs and study runs are history: a subtree that holds any is refused
with `409 historical_references`, including a run or study run that starts while the
delete is in progress (the subtree's studies, compositions, problems and organizations
are locked before the check). Otherwise its studies, compositions, problems (revisions and
compilations), blob rows, invitations, memberships and audit events go with it. The
stored files are not unlinked: they are content addressed and may back another
organization's blob.

## Reserved organization slugs

An organization slug is the first segment of its screens (`/app/<slug>`), so the
slugs of the fixed places and of the sections under an organization are refused at
creation with `422 slug_reserved`: `admin`, `account`, `engines`, `organizations`,
`invitations`, `runs`, `problems`, `studies`, `settings`, `workbench` and `new`
(`RESERVED_ORGANIZATION_SLUGS` in `models/platform.py`, mirrored by
`frontend/src/components/PlatformShell/workspacePath.ts`). A slug cannot be changed
after creation.

## The runs of an organization (`/v1/organizations/{org}/runs`)

A run belongs to the organization of the problem revision it runs. No public read
reaches it, and a non-member gets `404 not_found` on every route (the organization
reads as missing), not `403`.

| Route | Who | API key permission |
|---|---|---|
| `GET /runs`, `GET /runs/{run}`, `GET /runs/{run}/events`, `GET /runs/{run}/neighborhood` | VIEWER and up; below MEMBER the options, the request and the error text are redacted | `jobs:read` |
| `POST /runs` | MEMBER and up; the revision must be of `{org}` (`409 revision_not_in_organization`) | `engines:execute` |
| `POST /runs/{run}/cancel`, `/retry`, `/reevaluate` | MEMBER and up, whoever launched the run (`403 insufficient_role` below) | `engines:execute` |

An API key that cannot run engines (no `engines:execute`) reads redacted whatever
the role of its user, and a key only sees the runs of the Engine revisions it may
use. The `organizations:*` permissions do not reach the runs. A retry is a new run
of the caller: it takes the caller's concurrency slot and plan.

## How often: the budgets of the routes open to anybody

`POST /v1/bim/validate` needs no account and does real CPU work: it runs the
container's compiler in the gateway process. Uploading a problem or a revision, and
reading the compilation of a revision (which compiles it again after a toolchain
release), do the same work for members. The cost of one request is bounded where
the work happens, in the package's size and in what it would emit. So that one client
cannot keep the compiler busy for everybody else, every client also has a budget, in
`openbinding_gateway/access/work_limits.py`:

| Class | Routes | Anonymous, per client address | Signed in, per account |
|---|---|---|---|
| `compile` | `POST /v1/bim/validate`, `POST /v1/organizations/{org}/problems`, `POST …/problems/{problem}/revisions`, `GET …/revisions/{revision}/compilation` | `WORK_RATE_LIMIT_COMPILE_REQUESTS` (default 10) | that, times `WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER` (default 5) |
| `read` | `POST /v1/compositions/validate`, `/parse`, `/serialise`, `/diff` | `WORK_RATE_LIMIT_READ_REQUESTS` (default 60) | that, times `WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER` |
| `evaluate` | `POST /v1/organizations/{org}/compositions/{composition}/versions`, `POST …/versions/check` | `WORK_RATE_LIMIT_EVALUATE_REQUESTS` (default 30) | that, times `WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER` |

- **Per window.** A fixed window of `WORK_RATE_LIMIT_WINDOW_S` seconds (default 60)
  that starts at a client's first request of the class. `0` switches a class off.
- **Who is a client.** The address the proxy resolved (`X-Forwarded-For` counts only
  from `FORWARDED_ALLOW_IPS`), and for IPv6 the `/64`, which is what one subscriber
  holds. Signed in, the account, wherever it calls from; a key and its account are
  one caller, and a credential that names nobody is an anonymous caller.
- **Beyond it:** `429 rate_limit_exceeded` with `Retry-After`, as the problem document
  the route answers with (`application/problem+json` on `/v1/bim/validate`),
  naming `work_class`, `limit` and `window_seconds`.
- **What counts.** A request when it arrives, whatever becomes of it, so a malformed
  one is not free. A corpus is charged one per instance once its body has been
  validated; one larger than the whole budget is charged as the whole budget, so it
  can still run alone in an untouched window instead of being refused forever.
- **Where it is counted.** In Redis, shared by every replica. While Redis does not
  answer, in counters per process, so with N replicas a client gets up to N times the
  budget until it is back; it is logged and never turns into no limit.
- **`/v1/bim/validate` needs no account.** Anonymous callers are charged by address;
  a signed-in caller is charged to the account, and an API key also needs
  `problems:read` there.
- **The Composition2Yaml services need no account either.** `POST /v1/compositions/validate`,
  `/parse`, `/serialise` and `/diff` read or write one document, bounded at 262 144 bytes, and
  store nothing; an editor calls them as its author types, so the `read` class has the larger
  budget. They are counted like `/v1/bim/validate`; an API key needs `compositions:read`.
  Their concurrency is bounded apart, per process, by `COMPOSITION_LANGUAGE_SLOTS` (default 4):
  a request that finds every slot taken gets `429 composition_busy` with `Retry-After: 1`.
  `GET /v1/compositions/schema` is open, like the BIM templates, and needs no permission.
- **Sealing and checking a composition version is the `evaluate` class.** Each request has the
  toolchain evaluate the document's binding once, and compiles the linked revision only when the
  installed toolchain has no compilation of it yet (at most once per revision and release). Only
  members of the organization reach these routes, so they are charged to the account. Their
  concurrency is bounded apart, per process, by `COMPOSITION_EVALUATION_SLOTS` (default 2), with
  the same `429 composition_busy`.

## API key permissions of compositions

`compositions:read` and `compositions:write` are the composition pair, as `problems:*` and
`studies:*` are for theirs. `compositions:read` reaches the stateless services above and,
under `/v1/organizations/{org}/compositions`, every `GET` and the two operations that write
nothing (`POST …/versions/check` and `POST …/evaluate`); every other method there needs
`compositions:write`. The `organizations:*` permissions do not reach compositions, so a key
that administers organizations gains no composition write. A key boundary names a composition
by its kind (`composition`, `compositions`) and by its slug.

What an anonymous caller's failures leave behind is limited too. At most
`ANONYMOUS_ERROR_EVENTS_PER_MINUTE` of them (default 30) are recorded per client and
minute, whatever the status, and a recorded one keeps only its code, status, endpoint
and counts: how many diagnostics it listed and how many failures went unrecorded
before it, plus a 5xx's correlation id. Never a message, because a refusal quotes what
it refuses and an anonymous caller chooses that. A signed-in caller's failures are
kept whole, as before.

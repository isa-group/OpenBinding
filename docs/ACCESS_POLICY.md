# Access policy: members, and read-only visitors of public projects

Two ways reach a project under `/v1/organizations/{org}/projects/{project}/...`:

| `access` | Who | What |
|---|---|---|
| `member` | a member of the organization (or of an ancestor) | their role (`VIEWER` < `MEMBER` < `ADMIN` < `OWNER`) decides, exactly as before |
| `public_read` | **anybody else**, including a caller with no credentials | GET only, only on a project whose `visibility` is `public`, only on the routes of the matrix below |

`public_read` is an **access level, not a membership role**. It never appears as
an `OrganizationRole`, never counts as a member and never grants a write. The
project answer says which one applies:

```json
{ "slug": "open", "visibility": "public", "access": "public_read", "effective_role": null, "created_by_id": null, ... }
{ "slug": "open", "visibility": "public", "access": "member", "effective_role": "VIEWER", "created_by_id": "<uuid>", ... }
```

`access` and `effective_role` are new fields; for members every pre-existing
field is unchanged. A visitor does not get `created_by_id` (`null`).

## Rules

1. **deny-by-default.** A request is eligible for `public_read` only if its
   method is `GET` *and* its route template is listed as allowed below. A route
   that is not listed — a write, a sensitive read, or a route added tomorrow —
   is refused exactly as it is for any non-member. A test walks the real FastAPI
   route table and fails when a project route is not classified
   (`tests/test_b3_public_read.py`).
2. **Private projects do not change.** A non-member asking for a private project
   (or one that does not exist) gets `403 organization_forbidden`, the same body
   for both, so existence is not disclosed; an anonymous caller gets `401`.
3. **Anonymous reads are allowed on these routes only.** The matrix routes may be
   called without credentials, and only on public projects. A malformed or
   revoked credential is still `401`. Outside the project path, the public engine
   catalogue `GET /v1/engines` answers a visitor with the built-in and published
   Engines.
4. **API keys** keep their own rules (permission, engine and boundary checks run
   first); the key's owner is then a visitor like anybody else.
5. **Abuse limits.** Public reads are counted per *caller* — the account (a
   key and its account are one caller) or, anonymously, the client address — in a
   sliding one-minute window of `PUBLIC_READ_RATE_PER_MINUTE` (default 240, `0`
   switches it off). Beyond it: `429 rate_limit_exceeded` with `Retry-After`.
   Members are not limited by this, a refused request is not counted, and nothing
   a visitor does is ever charged to anybody's plan (a read meters nothing).
6. **Implementation.** One central layer, not per-endpoint exceptions:
   `openbinding_gateway/access/public_read.py` holds the matrix and the limiter;
   `get_current_user` binds eligibility to the request; `collaboration.require_project`
   is the single place that grants `public_read`. Handlers whose data is only
   partly public narrow what they return when `public_read.is_public_read(session)`.
   OpenAPI marks the allowed operations with `x-public-read: true`.

## Matrix of allowed reads (relative to `/v1/organizations/{org}/projects/{project}`)

| Route (GET) | What a visitor gets |
|---|---|
| `` (the project itself) | public metadata; `access: "public_read"` |
| `/resources`, `/resources/{resource}` | the project's resources |
| `/resources/{resource}/revisions`, `/resources/{resource}/revisions/{revision}` | resource revisions |
| `/library` | library associations, **only artifacts that are themselves published** |
| `/studies` | studies |
| `/studies/{study}/runs` | study runs |
| `/studies/{study}/runs/{run_id}/cells`, `/studies/{study}/runs/{run_id}/cells/{cell_id}` | cells of a run |
| `/studies/{study}/runs/{run_id}/analytics` | run analytics |

Two precisions. *Resources* are the project's own contents; an artifact of
**another** organization that the project merely associates (resources,
library) is shown to visitors only while it is itself published, so
a withdrawn one does not stay reachable through the project. *Problems* belong to
the organization, not to a project: `/v1/organizations/{org}/problems/...` is
members-only (VIEWER and up) and this policy does not open it. *Runs* belong to
the organization too (`/v1/organizations/{org}/runs/...`, below), and are never
public.

## Always denied to visitors

| Route | Why |
|---|---|
| every `POST`, `PUT`, `PATCH`, `DELETE` under the project | writes (creating or changing resources, studies, runs, cells, library associations, settings, visibility, deleting the project) |

Outside the project path nothing changes either: members, invitations,
organization settings, quota/usage/billing, API keys, library drafts, and the
private analyses under `/v1/analysis` stay members-only (or owner-only).
The refusal is the ordinary one: `403 organization_forbidden` for a signed-in
non-member, `401` without credentials.

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

## Roles at a glance

| Caller | Public project | Private project |
|---|---|---|
| anonymous | matrix routes, `access: "public_read"`; everything else `401` | `401` |
| signed-in non-member (session or API key) | the same, counted against their own allowance | `403 organization_forbidden` |
| `VIEWER` | read as a member (`access: "member"`, `effective_role: "VIEWER"`) | same |
| `MEMBER` / `ADMIN` / `OWNER` | as before | as before |

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

What an anonymous caller's failures leave behind is limited too. At most
`ANONYMOUS_ERROR_EVENTS_PER_MINUTE` of them (default 30) are recorded per client and
minute, whatever the status, and a recorded one keeps only its code, status, endpoint
and counts: how many diagnostics it listed and how many failures went unrecorded
before it, plus a 5xx's correlation id. Never a message, because a refusal quotes what
it refuses and an anonymous caller chooses that. A signed-in caller's failures are
kept whole, as before.

## Frontend notes

- `GET .../projects/{project}` is now the way to open a public project: render it
  read-only when `access === "public_read"` (there is no role to read).
- Expect `429` with `Retry-After` while browsing other people's public projects
  quickly, and from the routes above when one client asks too often; show the
  countdown the way other `429`s are shown.
- The file and library lists a visitor gets are already narrowed by
  the server; do not try to infer drafts or private files from them.

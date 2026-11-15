# Access policy: the organization and its members

The organization is the only container. Everything a person works on lives under
`/v1/organizations/{org}/...`: its members, invitations and audit log, its problems
(with their revisions and compilations), its runs and run presets, its studies and its compositions. There are no
projects, and every route under an organization is for its members, with one exception: anybody reads a
composition its organization made public, through the same routes ([Public compositions](#public-compositions)).

## Who reaches an organization

A member of the organization, or of one of its ancestors, has a role there
(`VIEWER` < `MEMBER` < `ADMIN` < `OWNER`); the strongest of the roles held along
the chain applies (`collaboration.effective_role`). Anybody else is refused:

- a signed-in non-member gets `403 organization_forbidden`; a slug that names no
  organization is `404 not_found`; the runs and run presets routes answer `404` to a
  non-member too (below), and so do the compositions routes: a composition the caller cannot read
  answers exactly as a missing one, `404` and never `403`, on every route and before
  any `If-Match` handling, as SPHERE answers a private pricing ([ADR 0046](adr/0046-compositions-module.md));
- a caller with no credential gets `401` on every route under `/v1/organizations`, except the five reads of
  a composition, where it is a visitor ([Public compositions](#public-compositions));
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
| `/presets`, `/presets/{preset}` | VIEWER (options redacted below MEMBER; a non-member gets `404`) | MEMBER creates, edits and deletes | `jobs:read` / `engines:execute` |
| `/studies/...` (study runs and cells included) | VIEWER | MEMBER creates, edits and runs; ADMIN deletes | `studies:read` / `studies:write` |
| `/compositions`, `/compositions/{composition}`, `/compositions/{composition}/versions/...`, `/compositions/{composition}/diff`, `/compositions/{composition}/fork`, `/compositions/{composition}/evaluate`, `/compositions/{composition}/neighborhood`, `/compositions/{composition}/derive` | VIEWER (a non-member gets `404`; anybody reads a public composition, redacted, below); VIEWER also checks a document (`POST …/versions/check`), compares versions, evaluates another binding of a version (`POST …/evaluate`) and explores its neighbourhood | MEMBER creates, edits, seals, re-evaluates (`POST …/versions/{version}/evaluations`) and derives versions (`POST …/derive`, from a run of the organization or a binding of one of its problems); ADMIN deletes and changes `visibility`. A fork needs read on the source (member, or the source is public) and MEMBER on the target organization, which must be another one | `compositions:read` / `compositions:write` |

## Public compositions

A composition is `private` when it is created, and a fork is too. An ADMIN of its organization makes it
`public` (`PATCH …/compositions/{composition}` with `visibility`; a MEMBER gets `403 organization_forbidden`),
since publishing exposes every version's document; the change is audited as `composition.visibility_changed`
with `{from, to}`. A public composition is read by anybody through the organization's URLs: the composition,
its versions, a version, its content and the diff (`getComposition`, `listCompositionVersions`,
`getCompositionVersion`, `getCompositionVersionContent`, `diffCompositionVersions`). This replaces, for
compositions, the members-only rule of [ADR 0034](adr/0034-no-public-read-in-f0b.md).

| Caller | Public composition | Private composition | Missing organization or composition |
|---|---|---|---|
| No credential (a visitor) | `200`, redacted | `404 not_found` | `404 not_found` |
| Signed in, not a member | `200`, redacted | `404 not_found` | `404 not_found` |
| Member (VIEWER or above) | `200`, whole | `200`, whole | `404 not_found` |

- **One body.** For a caller who is not a member, a missing organization, a missing composition and a
  private one answer the same bytes: `{"detail": {"code": "not_found", "error": "Composition not found."}}`,
  so the answer says nothing of what exists.
- **A credential that names nobody is `401`.** An expired or malformed session token, or a revoked key, gets
  `401 unauthorized` with the challenge on these reads too, never the visitor's view: a member whose session
  expired refreshes it instead of seeing their own private composition as missing.
- **Redaction follows the documents.** What a version's canonical bytes carry is public with them, because
  the bytes are served (the content, the diff): values, value status, `verified`, outcome, digests, the
  toolchain, the problem's ref (slug and revision number), the run and point the document's `evidence`
  names (`evidence_run`, and the `run` and `point` of `derivation`), and the document itself
  (`include=document`). The run itself stays unreadable to non-members, as the problem does. What the bytes
  do not carry is removed: `created_by_id`, the problem, revision and compilation ids (the derivation's
  revision id too) and the problem's name are `null`; `evaluations` holds only the current one, with no
  `diagnostics`, no `violations` and no `binding` (its `<resource>/<id>` keys name the private package's
  catalogs).
- **Lineage.** `based_on` and `forked_from` name the source only while that source is this composition or is
  public now (read when the view is built). Otherwise `based_on` is `null` and `forked_from` keeps only
  `droppedProblem`, so a fork of a private source, published later, names no source organization or
  composition.
- **The list across organizations.** `GET /v1/compositions` (`listPublicCompositions`) lists every public
  composition that is not archived and has a version, from any organization, the most recently changed first
  (filters `q`, `kind`, `organization`; `limit` up to 100). It follows the same caller rules: anybody reads it,
  a credential that names nobody is `401`, and only a visitor is charged. Its rows carry no member id and no
  lineage. An organization's own list (`GET …/{org}/compositions`) stays for its members, so an organization
  that published nothing appears nowhere, and filtering on it answers an empty page as an unknown one does.
- **Every other route stays for members**, public composition or not: `POST …/versions/check`, `evaluate`,
  `neighborhood`, `derive`, re-evaluation, sealing and every write answer `404` to a non-member and `401` to a
  visitor. A fork reads the source as these reads do: anybody signed in forks a public composition into an
  organization where they are a MEMBER, and the fork is private.
- **API keys.** The reads stay `compositions:read`. A key reads as its user: a key whose user is not a
  member reads a public composition redacted. The key's boundary is unchanged: a key bounded to its own
  organizations gets `403 api_key_boundary` on another organization's public composition, and on a fork
  from it.
- **Caching.** Every read answers `Vary: Authorization, X-API-Key`. A visitor's or a non-member's copy is
  `Cache-Control: private, no-cache`, so a composition made private again is not served from a cache; a
  member's content keeps `private, immutable`. The read rule runs before `If-None-Match`, so a composition
  made private again is `404`, never `304`.
- **Budget.** Only a visitor (no credential) is charged for these reads, one request of the `read` class
  each, against its anonymous budget (`ANONYMOUS_READ_ROUTES` in `access/work_limits.py`). A signed-in caller
  is never charged, so a member paging versions is not limited.

## Deleting an organization

`DELETE /v1/organizations/{org}` needs ADMIN (or OWNER) of the organization, or a
platform administrator. It takes the organization and every organization below it in
one transaction. Runs and study runs are history: a subtree that holds any is refused
with `409 historical_references`, including a run or study run that starts while the
delete is in progress (the subtree's studies, compositions, problems and organizations
are locked before the check). Otherwise its studies, run presets, compositions, problems (revisions and
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
after creation. `compositions` and `presets` join the list in F2, with the screens that
use them as sections.

## The runs of an organization (`/v1/organizations/{org}/runs`)

A run belongs to the organization of the problem revision it runs. No public read
reaches it, and a non-member gets `404 not_found` on every route (the organization
reads as missing), not `403`.

| Route | Who | API key permission |
|---|---|---|
| `GET /runs`, `GET /runs/{run}`, `GET /runs/{run}/events`, `GET /runs/{run}/neighborhood` | VIEWER and up; below MEMBER the options, the request and the error text are redacted | `jobs:read` |
| `POST /runs` | MEMBER and up; the revision must be of `{org}` (`409 revision_not_in_organization`) | `engines:execute` |
| `POST /runs/{run}/cancel`, `/retry`, `/reevaluate` | MEMBER and up, whoever launched the run (`403 insufficient_role` below) | `engines:execute` |
| `GET /presets`, `GET /presets/{preset}` | VIEWER and up; below MEMBER the options are redacted | `jobs:read` |
| `POST /presets`, `PATCH`/`DELETE /presets/{preset}` | MEMBER and up (`403 insufficient_role` below) | `engines:execute` |

A run preset names the settings a run starts from (`createRun {revision, preset}`). The run
copies them and records the preset as `{id, slug}`, so editing or deleting a preset never
changes a run.

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
| `read` | `POST /v1/compositions/validate`, `/parse`, `/serialise`, `/diff`; and, for a visitor only, `GET /v1/compositions` and the five reads of a public composition | `WORK_RATE_LIMIT_READ_REQUESTS` (default 60) | that, times `WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER` (not charged on the reads of a composition) |
| `evaluate` | `POST /v1/organizations/{org}/compositions/{composition}/versions`, `POST …/versions/check`, `POST …/fork`, `POST …/versions/{version}/evaluations`, `POST …/evaluate`, `GET …/neighborhood`, `POST …/derive` | `WORK_RATE_LIMIT_EVALUATE_REQUESTS` (default 30) | that, times `WORK_RATE_LIMIT_SIGNED_IN_MULTIPLIER` |

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
- **Sealing, checking, forking, evaluating and deriving a composition version is the `evaluate` class.** Each
  request has the toolchain evaluate one binding once (or, for the neighbourhood, at most 128
  alternatives within two seconds), and compiles the linked revision only when the installed
  toolchain has no compilation of it yet (at most once per revision and release). Only
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

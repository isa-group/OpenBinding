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
3. **Anonymous reads follow Explore.** `GET /v1/explore/*` is already served
   without a session, so the matrix routes may be called without credentials, and
   only those routes on public projects. A malformed or revoked credential is
   still `401`.
4. **API keys** keep their own rules (permission, engine and boundary checks run
   first); the key's owner is then a visitor like anybody else.
5. **Abuse limits.** Public reads are counted per *caller* — the account (a
   key and its account are one caller) or, anonymously, the client address — in a
   sliding one-minute window of `PUBLIC_READ_RATE_PER_MINUTE` (default 240, `0`
   switches it off). Beyond it: `429 rate_limit_exceeded` with `Retry-After`.
   Members are not limited by this, a refused request is not counted, and nothing
   a visitor does is ever charged to the project's sponsor or consumes the
   project's quota (a read meters nothing).
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
| `/cases`, `/cases/{case}` | binding cases |
| `/cases/{case}/revisions`, `/cases/{case}/revisions/{revision}` | sealed case revisions (with their source-snapshot digest) |
| `/collections`, `/collections/{collection}` | collections |
| `/collections/{collection}/revisions`, `/collections/{collection}/revisions/{revision}` | collection revisions |
| `/resources`, `/resources/{resource}` | the project's resources |
| `/resources/{resource}/revisions`, `/resources/{resource}/revisions/{revision}` | resource revisions |
| `/library` | library associations, **only artifacts that are themselves published** |
| `/studies` | studies |
| `/studies/{study}/runs` | study runs |
| `/studies/{study}/runs/{run_id}/cells`, `/studies/{study}/runs/{run_id}/cells/{cell_id}` | cells of a run |
| `/studies/{study}/runs/{run_id}/analytics` | run analytics |
| `/reports`, `/reports/{report}` | **only reports that are frozen and have a live publication**; a draft, an unpublished frozen report and a withdrawn one answer `404 not_found`, like a missing one |
| `/publications` | publications that are not withdrawn |
| `/blobs`, `/blobs/{digest_value}` | the file list and the download, **only files marked `public`**; a private file answers `404` like a missing one |

Two precisions. *Resources* are the project's own contents; an artifact of
**another** organization that the project merely associates (resources,
collections, library) is shown to visitors only while it is itself published, so
a withdrawn one does not stay reachable through the project. *Snapshots* of case
revisions are served by `/v1/snapshots/...` and `/v1/resolve/...`, which are not
under the project path and keep their own visibility rules (see
`RESOLVER_AND_VERIFIER.md`); this policy does not widen them.

## Always denied to visitors

| Route | Why |
|---|---|
| `GET /jobs` | jobs carry members' requests, options, results and history |
| `GET /package` | a full export, including private files and drafts |
| every `POST`, `PUT`, `PATCH`, `DELETE` under the project | writes (creating or changing cases, resources, collections, studies, runs, cells, reports, publications, files, library associations, settings, visibility, package import, deleting the project) |

Outside the project path nothing changes either: members, invitations,
organization settings, quota/usage/billing, API keys, library drafts, and the
private analyses under `/v1/analysis` stay members-only (or owner-only).
The refusal is the ordinary one: `403 organization_forbidden` for a signed-in
non-member, `401` without credentials.

## Roles at a glance

| Caller | Public project | Private project |
|---|---|---|
| anonymous | matrix routes, `access: "public_read"`; everything else `401` | `401` |
| signed-in non-member (session or API key) | the same, counted against their own allowance | `403 organization_forbidden` |
| `VIEWER` | read as a member (`access: "member"`, `effective_role: "VIEWER"`) | same |
| `MEMBER` / `ADMIN` / `OWNER` | as before | as before |

## Frontend notes

- `GET .../projects/{project}` is now the way to open a public project: render it
  read-only when `access === "public_read"` (there is no role to read).
- Expect `429` with `Retry-After` while browsing other people's public projects
  quickly; show the countdown the way other `429`s are shown.
- The report/publication/file/library lists a visitor gets are already narrowed by
  the server; do not try to infer drafts or private files from them.

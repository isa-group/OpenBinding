# 0047. Public compositions: visibility, the read rule, redaction by the bytes and the catalog

- Status: accepted
- Date: 2026-11-16 (F2a, decisions C1-C3, D3, D19-D22 of the F2 implementation plan; owner decision of 2026-11-15:
  compositions fork as SPHERE's pricings do, so F2 adds public visibility)
- Supersedes, for compositions: [ADR 0034](0034-no-public-read-in-f0b.md)

## Context

F1 made compositions readable by the members of their organization only, and a composition the caller cannot read
answers exactly as a missing one ([ADR 0046](0046-compositions-module.md)). The redesign wants a showcase and forks
from any organization, as SPHERE has for pricings. A public read must not turn into an oracle for what exists, must
not leak what the problem and the run keep private, and must not degrade a member whose session expired into a
visitor.

## Decision

- **Visibility.** `compositions.visibility` is `private` or `public` (check constraint `ck_compositions_visibility`).
  A composition and a fork start private. Only an ADMIN changes it (`PATCH …/compositions/{composition}` with
  `visibility`; a MEMBER gets `403 organization_forbidden`, unless the value sent is the current one, which is no
  change and writes no audit row), because publishing exposes every version's document. A change is audited as
  `composition.visibility_changed` with `{from, to}`. Publishing a composition that links a problem is allowed.
- **Who the caller is.** `get_reader` (`access/dependencies.py`) sits beside `get_optional_user`: no credential is a
  visitor; a credential that does not resolve to an active account is `401 unauthorized` with the challenge, never a
  visitor, so an expired member token is refreshed instead of reading the member's own private composition as
  missing; an API key is authorised as on every route.
- **The read rule.** `readable_composition` (`modules/compositions/application/compositions.py`) serves the five
  reads (`getComposition`, `listCompositionVersions`, `getCompositionVersion`, `getCompositionVersionContent`,
  `diffCompositionVersions`) and the source of `forkComposition`. A member reads whole. Anybody else reads a public
  composition redacted. For anybody else a missing organization, a missing composition and a private one answer one
  fixed body, `_unreadable()`: `{"detail": {"code": "not_found", "error": "Composition not found."}}`. Every other
  route keeps `organization_for` unchanged: `401` for a visitor, `404` for a non-member, also on public compositions
  (C3), so a non-member only reads and forks.
- **Redaction follows the bytes.** What a version's canonical bytes carry is public with them, because the content
  and the diff serve the bytes: values, value status, outcome, digests, the toolchain, the problem's ref, and the run
  and point the document's `evidence` names (`evidence_run`, and the `run` and `point` of `derivation`), and the
  document (`include=document`). Stripping them would change sealed bytes. What the bytes do not carry is removed:
  `created_by_id`, the problem, revision and compilation ids (the derivation's revision id too), the problem's name,
  `EvaluationView.binding` (its `<resource>/<id>` keys name the private package's catalogs), and every evaluation but
  the current one, which keeps no diagnostics and no violations. The problem and the run stay unreadable to
  non-members.
- **Lineage.** `based_on` and `forked_from` (typed `ForkedFrom`) name their source only while it is this composition
  or is public now, read with one batched query when the view is built. Otherwise `based_on` is `null` and
  `forked_from` keeps only `droppedProblem`.
- **The catalog.** `GET /v1/compositions` (`listPublicCompositions`, outside the problem+json prefixes) lists every
  public composition that is not archived and has a version, newest change first, with `q`, `kind`, `organization`
  (an unknown slug is an empty page) and `limit`/`offset`. Rows carry the organization's slug and name, the latest
  version (`label`, `ordinal`, `values_status`, `verified`) and `version_count`; no member id, no lineage, no ids. An
  organization's own list stays for its members.
- **Caching.** Every read answers `Vary: Authorization, X-API-Key`. A visitor's or non-member's copy is
  `Cache-Control: private, no-cache`; a member keeps today's headers. The read rule runs before `If-None-Match`, so a
  composition made private again is `404`, never `304`.
- **Budget.** Only a visitor is charged: `ANONYMOUS_READ_ROUTES` in `access/work_limits.py` and
  `charge_anonymous_read` spend one `read` request of the anonymous budget per read; members and every signed-in
  caller are never charged. Past it: `429 rate_limit_exceeded` with `work_class: read`. `WORK_ROUTES` stays the table
  of costly work.
- **API keys.** `allows_request` is unchanged (D21): a key bounded to its own organizations gets
  `403 api_key_boundary` on another organization's public composition and on a fork from it. Sessions and unbounded
  keys read and fork public compositions anywhere. The catalog has no `{org}` in its path, so a key bounded by
  `organizations` lists every organization's public compositions; a `resourceKinds` boundary still applies.
- **Forks.** Anybody signed in forks a public composition into an organization where they are MEMBER, never into the
  source's own. A version that links a problem forks only with `dropProblem`, which removes `problem` and `evidence`
  and declares the values. The fork is private.

## Consequences

- An outsider still cannot tell a private composition from a missing one, body included.
- The showcase (`/c/:org/:composition`) and the public list (`/compositions`) read through the same organization
  routes as the app; there is no `/v1/public/…` namespace to keep in step.
- A published version shows the run id its evidence names, which reveals nothing more than the bytes already do.
- Problems, runs and studies keep the members-only rule of ADR 0034. Whether non-members of those get `403` or `404`
  stays open (F2 Open question 7).

Where: `access/dependencies.py`, `access/work_limits.py`, `modules/compositions/application/compositions.py`,
`modules/compositions/adapters/routes.py`, `modules/compositions/adapters/public_routes.py`, `db/platform_models.py`,
`docs/ACCESS_POLICY.md`, `docs/ERRORS.md`; tests `tests/test_compositions_public.py`, `tests/test_work_limits.py`.

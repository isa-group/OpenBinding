# 0056. SCORETech Identity through a backend-for-frontend session

- Status: accepted
- Date: 2026-11-19 (F5, owner answers of 2026-11-19)
- Number: 0054 and 0055 are F4's (composition environments and the feed; margins per offering plan).

## Context

OpenBinding signs people in with SCORETech Identity, the SCORE platform's Keycloak-based single sign-on, as SPHERE and
SPACE do (plan §5). SPHERE already runs `AUTH_PROVIDER=scoretech` against the same Identity, so its backend is ported and
its frontend copied; what it lacks or gets wrong is decided here. Nothing is in production: what Identity replaces
(US CAS, the refresh tokens of local sign-in, tokens in Web Storage) is deleted rather than kept beside it.

## Decision

- **D-a. One session model in both modes.** The gateway is a confidential client and a backend for the frontend: the
  browser holds an opaque HttpOnly cookie naming a row of `identity_sessions`, and a 300-second gateway token kept in
  memory. Local sign-in moves onto the same rows (F5-B), so one transport, one revocation path and one per-request check
  serve both modes, and a production rollback does not bring Web Storage back.
- **D-b. `__Host-` cookies at `Path=/`**, not SPHERE's `Path=/api/v1/auth/identity`: OpenBinding shares `score.us.es`
  with SPHERE, SPACE and Identity, and `__Host-` forbids a sibling's `Domain` cookie. Data routes never read cookies.
- **D-c. PostgreSQL is authoritative for sessions; Redis holds only the sign-in flow, pending sign-ups and the refresh
  lock.** The refresh token is sealed with Fernet over `{sid, token, generation}`. SPHERE keeps sessions and a plain
  refresh token in Redis.
- **D-d. A missing or unverified email does not block sign-in**: the account gets `<id>@identity.openbinding.invalid`
  and no RESEARCH, and the next renewal stores the email once Identity shares it verified.
- **D-e. OpenBinding checks `openbinding:access` itself** at every sign-in and renewal, so a misconfigured client cannot
  admit everybody.
- **D-f. Logout ends the SCORE SSO session**, and `scope: "all"` every OpenBinding session of the account (owner, Q4).
- **D-g. Claims are re-synced on every sign-in and every renewal that returns an ID token**, from the verified ID token
  only. A verified email held by another account is released from it when that copy proves nothing (a stale Identity
  account of the same issuer, or an unverified holder); a holder that verified it too and has no identity of this issuer
  keeps it. **Nothing ever finds an account by email.**
- **D-h. Routes are always mounted and declare their mode** (`requires_provider`); a test enumerates them. SPHERE matches
  paths by regex.
- **D-i. The chosen username is its own screen** (`/sso/identity/username`), shaped after SPACE's pending/complete.
- **D-j. The orphan rule hangs off the owner** (`users.last_identity_refresh_at` within `API_KEY_ORPHAN_DAYS`) and
  governs personal `obk_` keys only; F4's environment-owned keys are outside it.
- **D-k. Personal organizations follow SPHERE** (owner, Q3), as their own pull request (F5-D; see the addendum).
- **D-l. RESEARCH by email is granted, never withdrawn automatically**; administrators change it.
- **Single-flight renewal** (plan §10): an in-process coalescing map, a Redis lock with an owner token and a
  compare-and-delete, a bounded wait that re-reads the row, a compare-and-swap on the generation committed before the
  lock is released, revoke-on-loss, and `invalid_grant` ending the session only when the generation did not move.
  Redis unreachable is 503: a refresh never runs without the lock, because a second use of a rotated token is refused by
  Keycloak and may end the SSO session.
- **Verification stricter than SPHERE's**: RS256 only, `use=sig` keys with a `kid`, `aud` and `azp` on both tokens,
  `typ`, the RFC 9207 `iss` parameter, an hour of discovery cache (SPHERE's lasts the process).
- **The first administrator by `sub`** (`BOOTSTRAP_ADMIN_SUB`); Identity roles never become OpenBinding roles.
- **Production keeps `AUTH_PROVIDER=local` until the Identity clients exist** (owner, Q14); the switch starts from an
  empty database.

## Consequences

- O9: Identity offers managed applications no back-channel or front-channel logout and no `offline_access`. OpenBinding
  learns that an Identity session ended at the next renewal, at most one access-token lifetime later, and a session
  cannot outlive the SSO session.
- Every request with a session token costs one joined read of the session and the user, replacing the user load it
  already made.
- Accounts created while a deployment runs in `local` mode are never linked to Identity accounts; a deployment with
  data worth keeping goes to the owner as a migration before switching.
- The CI never reaches the real issuer: an in-process fake issuer with Identity's token shapes covers the gateway, and
  the SCORETech Identity lab at a pinned revision covers the walks.

## Addendum: personal organizations (F5-D)

Open question 3 kept its default, SPHERE's shape. Every account owns an organization named `<username> PERSONAL`, its
slug the username lower-cased (`.` and `_` become `-`, since a slug holds neither), created in the account's
transaction at a first SCORETech sign-in, at local registration, for the bootstrap administrators and by the seeds.
`complete` reaches it through an account hook that `main` installs (`identity.application.AccountHook`,
implemented by `services.organizations.PersonalOrganizationHook`), so the identity module imports nothing above it;
a refusal rolls the account back and leaves the pending sign-up for a retry.

- `organizations.personal_owner_id` (unique, `RESTRICT`, a CHECK keeping the organization a root) marks it; the views
  carry `is_personal`.
- It is not transferred, left by its owner, moved, given sub-organizations, renamed or deleted on its own
  (`409 personal_organization`), as SPHERE's screens and ORBIT refuse; members and invitations work as anywhere.
- Organizations and usernames share one namespace: `complete` and registration answer `username_unavailable` for a
  name whose slug an organization holds (after `username_taken`, so an account's own name stays "taken"), and an
  organization cannot take a username's slug.
- Deletion follows SPHERE too (owner's decision, replacing the design's pseudonymisation): `DELETE /v1/users/me`
  no longer counts the personal organization in `last_owner` and deletes it with everything it holds, its runs
  included, in the transaction that pseudonymises the account. It is the one exception to runs being history; a team
  organization that holds runs is still refused. Its runs are cancelled first through the usual paths, and while one
  is still running (or an engine is still being told to stop one) the answer is `409 personal_runs_stopping`, so no
  solver is orphaned. Nothing outside it refers to what it holds, so no foreign key stops the delete, and a fork
  elsewhere keeps its `forked_from` snapshot. Settings › Danger Zone says beforehand what goes
  (`GET /v1/users/me/deletion`).

See [IDENTITY.md](../IDENTITY.md).

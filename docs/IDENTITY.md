# Signing in with SCORETech Identity

OpenBinding signs people in in one of two modes, chosen by one setting of the gateway:

```dotenv
AUTH_PROVIDER=local        # OpenBinding's own accounts: development, labs and rollback
# AUTH_PROVIDER=scoretech  # SCORETech Identity, the SCORE platform's single sign-on
```

The frontend reads `GET /api/v1/auth/config` to learn the mode; it needs no build flag and never sees a client secret.
An invalid `scoretech` configuration stops the gateway at startup and names the setting; it never falls back to local
sign-in. Production keeps `local` until the Identity clients of
[runbooks/identity-client-request.md](runbooks/identity-client-request.md) exist.

Adapted from SPHERE's `docs/scoretech-identity.md` (SCORELabUS/SPHERE@73779a8a, MIT): SPHERE already runs
`AUTH_PROVIDER=scoretech` against the same Identity, and OpenBinding ports its backend logic (see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), "Code ported from SPHERE"). What SPHERE lacks, OpenBinding adds: a
chosen username, RESEARCH by a verified institutional email, the first administrator by `sub`, orphan API keys, an
encrypted refresh token, a waiting cross-worker lock and the in-memory token. The decision record is
[ADR 0056](adr/0056-identity-bff-session.md).

## The client

The gateway is a **confidential** OIDC client of the Identity realm: a backend for the frontend. The browser holds only
an opaque HttpOnly cookie; Identity's tokens never reach it.

| Setting | Default | Meaning |
|---|---|---|
| `AUTH_PROVIDER` | `local` | `local` or `scoretech`; `local` in production starts with one `auth_provider_local_in_production` warning (the documented rollback) |
| `SCORETECH_IDENTITY_ISSUER` | — | the realm's issuer, e.g. `https://sphere.score.us.es/identity/auth/realms/score`; https (http only on a loopback host), no trailing `/` |
| `SCORETECH_IDENTITY_CLIENT_ID` | — | the application's client id (`score-app-<uuid>`) |
| `SCORETECH_IDENTITY_CLIENT_SECRET` (`_FILE`) | — | its secret, as a mounted file; redacted from every log |
| `SCORETECH_IDENTITY_CALLBACK_URL` | `PUBLIC_BASE_URL` + `/api/v1/auth/identity/callback` | on `FRONTEND_URL`'s origin; the browser starts sign-in at its sibling `…/login` |
| `SCORETECH_IDENTITY_ACCOUNT_URL` | the issuer with `/auth/realms/<realm>` replaced by `/account/` | where Settings sends people to edit their profile |
| `SCORETECH_IDENTITY_TRANSPORT_URL` | none | labs: where the gateway reaches the realm when that is not the issuer's host (`http://keycloak:8080/identity/auth/realms/score`); only the issuer prefix of each endpoint is rewritten, tokens are still checked against the issuer |
| `SCORETECH_IDENTITY_REQUIRED_PERMISSION` | `openbinding:access` | checked in the access token at every sign-in and renewal; empty switches the check off |
| `IDENTITY_STORE_BACKEND` | `redis` | where sign-in flows, pending sign-ups and the refresh lock live; `memory` is refused in production |
| `SESSION_MAX_S` / `SESSION_IDLE_S` | 604800 / 43200 | a session lives seven days at most and twelve hours without a renewal (Identity's own SSO limits) |
| `ACCESS_TOKEN_TTL_S` | 300 | lifetime of the gateway token the browser keeps in memory |
| `RESEARCH_EMAIL_DOMAINS` | `us.es,alum.us.es` | domains whose verified emails entitle an account to RESEARCH |
| `BOOTSTRAP_ADMIN_SUB` | none | the Identity `sub` promoted to administrator while no administrator exists |
| `API_KEY_ORPHAN_DAYS` | 30 | days a person's API keys keep working after their last Identity sign-in |
| `AUTH_TRUSTED_ORIGINS` | empty | extra exact browser origins the sign-in routes accept besides `FRONTEND_URL`'s (the ordinary lab's `http://web:8080`) |

In `scoretech` mode `FRONTEND_URL`, `PUBLIC_BASE_URL` and the callback share one origin (the session cookie is
same-origin), a Fernet key must be configured (`SECRETS_FERNET_KEYS`, or the legacy `FEDERATION_SECRET_KEY`: the refresh
token is stored encrypted with it), `SEED_DEFAULT_ADMIN` is refused, and the `BOOTSTRAP_ADMIN_USERNAME`/`PASSWORD`/`EMAIL`
settings are ignored with one `bootstrap_admin_ignored` warning (production compose keeps mounting that secret, so the
switch stays one variable). `EXPOSE_RECOVERY_TOKENS` is refused in production in every mode.

## Signing in

```
browser                       gateway                                       Identity
  GET /api/v1/auth/identity/login?returnTo=/x
                              flow {nonce, PKCE verifier, sha256(binding)} → Redis (600 s)
  ◀── 302 authorize?…S256…state, cookie __Host-ob_flow_<state>=binding
  ──────────────────────────────────────────────────────────────────────▶ email code, admission
  ◀───────────────────────────────── 302 /api/v1/auth/identity/callback?state&code&iss
                              compare the binding, consume the flow once, POST token, verify both tokens,
                              find (scoretech, issuer, sub)
  ◀── 303 /sso/identity/callback?returnTo=/x     with __Host-ob_session (known account)
  ◀── 303 /sso/identity/username?returnTo=/x     with __Host-ob_pending (first sign-in)
  POST /api/v1/auth/identity/session (Origin) → {access_token (300 s, sid, prv)}   kept in memory
```

- **PKCE, state, nonce and a browser binding.** The flow's `state` is 32 random bytes; its record holds the nonce, the
  PKCE verifier and the sha256 of a binding the browser holds in a cookie of its own. The binding is compared in constant
  time *before* the flow is consumed, so a forged callback without it cannot burn the legitimate one. The RFC 9207 `iss`
  parameter must name the issuer.
- **Verification is RS256 only**: `RS256` pinned and checked in the header before any key lookup; keys only from
  discovery's `jwks_uri`, `kty=RSA`, `use=sig`, with a `kid`; `iss`; `aud` containing the client and `azp` naming it on
  both tokens; `typ`; `exp` and `iat` with 30 s of leeway; the nonce and the same `sub` on the ID token; the required
  permission in the access token. Profile claims are read only from a verified ID token: Identity's policy mapper strips
  them from access tokens.
- **Never by email.** An account is found only by `(provider, issuer, subject)`. An email Identity verified that another
  account holds is released from that account when its copy proves nothing (a stale Identity account of the same issuer,
  or an account whose own email is unverified: every local or seeded account); held by an account that verified it
  too and has no identity of this issuer, the first sign-in is refused (`account_not_linked`) and a known account keeps
  its old email. Nothing is ever merged.
- **A chosen username.** A first sign-in becomes a pending sign-up (15 minutes); the person chooses a username at
  `/sso/identity/username` (`GET /api/v1/auth/identity/pending`, `POST /api/v1/auth/identity/complete`). Usernames are
  unique whatever their case; reserved names and engine namespaces are refused.
- **Claims.** Each sign-in and each renewal that returns an ID token stores the verified email (or
  `<id>@identity.openbinding.invalid` when Identity verified none), `email_verified`, the display name and the avatar
  descriptor; nothing else (no names, phone, bio, links or birthdate). Identity roles never become OpenBinding roles.
- **Refusals end the Identity session** they obtained (`account_not_linked`, `account_disabled`, `access_denied`), so
  "Try again" can choose another account. The closed `identity_error` codes are in [ERRORS.md](ERRORS.md).

## Sessions

- A session is a PostgreSQL row (`identity_sessions`); the cookie holds 32 random bytes and the row only their sha256.
  Cookies are `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` (on a loopback http lab: no prefix and no
  `Secure`). Every sign-in route that changes state requires an `Origin` of the frontend.
- The Identity refresh token is sealed with Fernet over `{sid, refresh token, generation}`; it is never in Redis, a log
  or a response, and the ID token is not stored.
- `POST /api/v1/auth/identity/session` mints a 300-second gateway token carrying the session id (`sid`) and the provider
  (`prv`), and keeps the session from going idle. Every request checks the session behind its token in the same read
  that loads the user, so signing out, deactivation, deletion and a change of `AUTH_PROVIDER` act on the next request.
  Notification and run event streams re-check every 30 seconds and end with `event: session-ended`.
- **Single-flight renewal.** Identity's refresh tokens are single use. A renewal runs only when the upstream access has
  less than 30 s left, once per session in the process, under the shared Redis lock `identity:refresh:<sid>` (owner
  token, compare-and-delete); another worker's renewal is waited for (up to 5 s) and used; the new token is written with a
  compare-and-swap on the generation, committed before the lock is released; a write that loses revokes the token it
  obtained. **Redis unreachable means 503 and the session survives: a refresh never runs without the lock.**
- **Logout** (`POST /api/v1/auth/identity/logout`, `{"scope": "this" | "all"}`) revokes the session (or all of the
  account's), ends the SCORE SSO session behind each (so signing in again asks for a code) and any sign-up waiting for its
  username, and clears the cookies.
- Identity offers managed applications no back-channel logout: OpenBinding learns that an Identity session ended at the
  next renewal, at most one access-token lifetime later.
- **In the browser** the gateway token lives in memory only, never in Web Storage (nor does the SPACE pricing token): the
  SPA asks the session route for a token when the page loads, renews it when under a minute is left, on focus, when the
  page is shown again and every 30 s, and once more on a `401`. Tabs follow each other's sign-in and sign-out through the
  `openbinding-auth` BroadcastChannel; a renewal whose token names another account loads that account. The account menu
  offers **Sign out** and **End every session** (`scope: "all"`).
- **Signing up** uses the same sign-in URL as signing in: SCORETech Identity registers an unknown email from its sign-in
  page (a code, then its registration stage). Its `/registrations` endpoint is Keycloak's stock form, so
  `GET /v1/auth/config` names only `login_url` (and `account_url`).

## RESEARCH, administrators and API keys

- **RESEARCH** comes from a verified email whose domain (the part after the last `@`, exactly) is in
  `RESEARCH_EMAIL_DOMAINS`, at the first sign-in or the next one, for an account on the default plan; it is never
  withdrawn automatically. Otherwise an administrator grants it to any account. A person who signs in to Identity only
  through its US CAS broker has an unverified email until they verify a mailbox in Identity.
- **The first administrator** is the account whose Identity `sub` (of the configured issuer) is `BOOTSTRAP_ADMIN_SUB`, at
  its first sign-in while no active administrator exists. Afterwards administrators promote whom they choose.
- **Orphan keys.** A person's API keys (`obk_`) work only while the person signed in or renewed a session with Identity
  within `API_KEY_ORPHAN_DAYS`; otherwise they answer `401 api_key_suspended` until the next sign-in (the keys are not
  revoked; `UserProfile.api_keys_suspended_at` says when they stop). Environment-owned feed keys have no owning person
  and are outside the rule.

## What people see

- **Settings › Account** in `scoretech` mode is "Your SCORETech account": **Open my SCORETech profile** opens Identity's
  account page (`account_url`, ending in `#public-profile`) in a new tab with `return_to` set to Settings › Account, and
  Identity's "Back to application" comes back. There is no email or password form: both are Identity's (`PATCH
  /v1/users/me` answers `409 managed_by_identity`).
- **Settings › Public profile** shows the display name and the avatar. In `scoretech` mode both come from the last
  verified ID token (`scoretech_display_name` or `name`, and `scoretech_avatar`), read-only, with **Edit in SCORETech
  Identity**. In `local` mode the person sets them (`PATCH /v1/users/me` with `display_name` and `avatar`, no password);
  the avatar editor offers exactly Identity's shapes (initials, an icon or a preset, Identity's colours), so an account
  keeps the same kind of avatar across a change of mode. There is no photo upload.
- **Avatars.** `UserRef`, organization members and the profile carry `display_name` and `avatar`, the stored descriptor
  with colours as hex (Identity's named colours are converted when the token is read); anything else is served as null and
  drawn as initials. The frontend draws it with Identity's own renderer.
- **The Danger Zone** says that deleting the OpenBinding account leaves the SCORETech account and access to other SCORE
  services, and asks for the current password only when the account has one (`UserProfile.password_enabled`).
- **API keys.** In `scoretech` mode the keys page says on which day the keys stop working unless the person signs in again
  (`api_keys_suspended_at`), and warns once they are suspended.
- **Administration.** The admin user's Identity tab shows how the account signs in (SCORETech Identity or a password),
  the issuer and subject, the last sign-in or renewal with Identity, the live browser sessions and the basis of its last
  RESEARCH grant (its verified institutional e-mail, or an administrator). None of it is in a user reference.

## Local mode and rollback

`AUTH_PROVIDER=local` keeps registration, password sign-in and the password reset of OpenBinding's own accounts, for
development, labs and rollback. **Local mode uses the same cookie session**: `POST /v1/auth/login` and `/register` open an
`identity_sessions` row with provider `local` (no refresh token, the same limits), set the session cookie and answer a
token bound to it; the SPA renews and ends it at the same `/v1/auth/identity/session` and `/logout`. A present `Origin`
outside the frontend's (`FRONTEND_URL` and `AUTH_TRUSTED_ORIGINS`) is refused; an absent one passes, for scripts. There
are no refresh tokens: one session model holds in every mode, a production rollback included. In `scoretech` mode those routes answer `409 local_auth_disabled`, and changing the email
or password answers `409 managed_by_identity`; in `local` mode the Identity routes answer `409 identity_disabled` (the
browser ones redirect to `/authentication?identity_error=unavailable`).

To roll back, set `AUTH_PROVIDER=local` and restart the gateway. Sessions and tokens of the other mode are refused, so
everybody signs in again. Identity-only accounts have no password: they set one through the reset mail (their verified
email is real) and keep their account. Switching forward again refuses the local sessions; the same Identity sign-in
reaches the same account. Accounts created while a deployment runs in `local` mode are never linked to an Identity
account, so a switch starts from an empty database ([the runbook](runbooks/identity-client-request.md)).

## Threats and their controls

| Threat | Control |
|---|---|
| Code interception or injection | PKCE S256; `state` bound to the browser; the flow consumed once, 600 s; the exact `redirect_uri` |
| Login CSRF, cookie tossing | the binding; `__Host-` cookies; `Origin` checks |
| Mix-up, issuer confusion | discovery must name the issuer; endpoints under it; the `iss` callback parameter |
| Algorithm confusion | `RS256` pinned; `sig` RSA keys with a `kid` only; `crit` refused |
| Token substitution | `iss`, `aud`, `azp`, `typ`, `nonce`, the same `sub`, 30 s of leeway |
| JWKS rotation and poisoning | keys only from `jwks_uri`; an unknown `kid` refetched at most every 30 s; no redirects |
| Session or token theft | HttpOnly cookie; the gateway token in memory only, 300 s; `Cache-Control: no-store` on every auth answer |
| CSRF on the session routes | `Origin` in the trusted set; `SameSite=Lax`; data routes never read cookies |
| Session fixation | a session id only after authentication; a presented session is replaced |
| Refresh token at rest | Fernet bound to the row and its generation |
| Single-use refresh races | coalescing, the Redis lock, the generation compare-and-swap, revoke on loss, 503 without Redis |
| Stale admission | renewal every 300 s at most; `invalid_grant` and a removed permission end the session |
| Logout that does not log out | the session checked on every request and every 30 s in streams; the SSO session ended |
| Takeover by email | lookup only by `(provider, issuer, subject)`; the release rule above |
| Username squatting | `lower(username)` unique; reserved names; one account per identity |
| Privilege from claims | Identity roles ignored; administrator only by `sub` or by an administrator |
| Orphan machine credentials | `API_KEY_ORPHAN_DAYS` on the owner |
| Open redirect | `returnTo` limited to frontend paths (not `/api` or `/sso/`), 512 characters |
| Secret leakage | `SecretStr`, `*_FILE`, log redaction; access logs drop the callback's and the reset link's query |
| Mode confusion after rollback | `prv` in tokens, `provider` on sessions; local routes 409 in `scoretech` mode |

## Verification

- The gateway suite runs every Identity case against an in-process fake issuer (`openbinding-gateway/tests/identity`);
  CI never reaches a real issuer.
- [lab/identity/README.md](../lab/identity/README.md) runs the SCORETech Identity lab at its pinned revision and walks
  the real issuer at the gateway level: first sign-in, renewal, logout, the email rules, RESEARCH, native registration
  and the rollback leg (`frontend/e2e/identity/01-gateway.spec.ts`), then through OpenBinding's screens: a first sign-in
  from the header with the username screen, the renewal past the access lifespan, two tabs signing out, the error pages
  and the local form after the rollback (`frontend/e2e/identity/02-screens.spec.ts`), and Settings, avatars, an orphaned
  key and the deletion of an account (`frontend/e2e/identity/03-account.spec.ts`), with visual stops in both palettes at
  1440 and 390 px.
- The ordinary lab (`AUTH_PROVIDER=local`) runs every `e2e/live` walk over the same cookie session.

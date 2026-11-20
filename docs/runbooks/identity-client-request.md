# Request to SCORETech Identity: the OpenBinding OIDC clients

OpenBinding will sign people in through SCORETech Identity, the same way SPHERE and SPACE do (`AUTH_PROVIDER=scoretech`,
issuer `https://sphere.score.us.es/identity/auth/realms/score`, authorization code with PKCE S256, `state` and `nonce`).
The gateway is the confidential client (a backend for the frontend): the browser never holds an Identity token. Nothing
in OpenBinding needs to change for this request; it is configuration on the Identity side only. Local development uses
the SCORETech Identity lab (`./lab up`) and needs nothing from this request.

F5 outcome: OpenBinding signs in with SCORETech Identity when `AUTH_PROVIDER=scoretech` ([IDENTITY.md](../IDENTITY.md));
the US CAS sign-in is gone, and local accounts remain for development, labs and rollback (with the same cookie
session).

## The request (ready to send)

> Hello, OpenBinding (SCORE Lab) would like to sign its users in with SCORETech Identity, as SPHERE does. Could you
> configure the following? It is configuration only.
>
> 1. A **confidential managed OIDC application** for production:
>    - origin: `https://openbinding.score.us.es`
>    - redirect (callback) URI: `https://openbinding.score.us.es/api/v1/auth/identity/callback`
>    - post-logout redirect URI: `https://openbinding.score.us.es/`
> 2. A second confidential managed OIDC application for the develop preview, with the same paths:
>    - origin: `https://openbinding.home.javiercavlop.com`
>    - redirect (callback) URI: `https://openbinding.home.javiercavlop.com/api/v1/auth/identity/callback`
>    - post-logout redirect URI: `https://openbinding.home.javiercavlop.com/`
> 3. The permission `openbinding:access` in the default registration role, as `sphere:access` is there for SPHERE.
> 4. Both origins, `https://openbinding.score.us.es` and `https://openbinding.home.javiercavlop.com`, added to
>    `IDENTITY_ACCOUNT_RETURN_ORIGINS`, so the account pages can send people back to OpenBinding.
> 5. For each application, as managed applications need:
>    - (a) the permission `openbinding:access` declared first (Admin → Permissions);
>    - (b) `openbinding:access` set as the application's required permission (at least one is mandatory, and it is the
>      admission gate);
>    - (c) the shared user fields `email` (it carries `email_verified` too), `name`, `display_name` and `avatar`
>      (panel applications share nothing by default; OpenBinding never reads `preferred_username`);
>    - (d) generated `score-app-<uuid>` client ids are fine; we know a secret rotation has no grace period and will
>      coordinate the redeploy;
>    - (e) `openbinding:access` added to the **current** default registration role (editing `member` covers the existing
>      members).
>
> Please send each application's client id and client secret through the usual secure channel; we will keep them as
> mounted secrets, never in an image or a repository.

## What we are not asking for

These have alternatives already designed, so they are left out of the request:

- an OAuth scope to read SPHERE's REST API (OpenBinding uses a VIEW API key of its organization instead);
- a claim linking the US CAS account in Identity (a verified institutional email is used instead);
- webhooks or threshold events from SPHERE or SPACE (OpenBinding polls with ETags);
- SPHERE's service tree (not used).

## Owner checklist

Sending the request is an owner action (Q5 of the F0b plan). It is tracked at the F0b closing review and gates no
block.

- [ ] Sent on ____-__-__, by ____________________
- [ ] To (Identity contact or tracker): ____________________, ticket or thread: ____________________
- [ ] Production application received (client id recorded in the deployment's secrets; never here)
- [ ] Develop preview application received
- [ ] `openbinding:access` in the default registration role confirmed
- [ ] Both origins in `IDENTITY_ACCOUNT_RETURN_ORIGINS` confirmed
- [ ] `openbinding:access` declared and set as each application's required permission
- [ ] Shared user fields `email`, `name`, `display_name` and `avatar` selected for each application
- [ ] `openbinding:access` in the current default registration role confirmed

## A caveat about US CAS inside Identity

Identity can broker the University's CAS, but the emails it receives that way stay unverified (by Identity's design).
OpenBinding grants RESEARCH only to a verified institutional email, so a person who signs in to Identity only through
its CAS broker gets RESEARCH after verifying a mailbox in Identity (an email code), or from an administrator.

## Switching a deployment to Identity

1. **The data rule first.** The switch starts from an empty database: accounts created while the deployment ran in
   `local` mode cannot sign in once it runs in `scoretech` mode (local sign-in is refused) and are never linked to an
   Identity account. A deployment whose data must be kept is a migration and goes back to the owner before anything
   else.
2. Put the client secret in `secrets/scoretech_identity_client_secret`, declare it as a compose secret of the gateway
   and uncomment `SCORETECH_IDENTITY_ISSUER`, `SCORETECH_IDENTITY_CLIENT_ID` and
   `SCORETECH_IDENTITY_CLIENT_SECRET_FILE` in `deploy/compose/production/compose.yaml`.
3. Set `AUTH_PROVIDER=scoretech` and `BOOTSTRAP_ADMIN_SUB` (the Identity `sub` of the first administrator; it becomes
   administrator at its first sign-in while there is none). Keep `SCORETECH_IDENTITY_REQUIRED_PERMISSION` at
   `openbinding:access`. The `bootstrap_admin_password` secret stays mounted and is ignored (one
   `bootstrap_admin_ignored` warning).
4. Recreate the gateway (and restart nginx after it, as for every gateway recreate). The gateway refuses to start on
   an invalid Identity configuration and names the setting.
5. A secret rotation has no grace period in Identity: rotate it and redeploy the gateway in the same window.

## Rollback

Set `AUTH_PROVIDER=local` and recreate the gateway: every session and token of the Identity mode is refused, so everybody
signs in again. Identity-only accounts have no password; they set one through the password reset mail (their verified
email is real) and keep their account. `EXPOSE_RECOVERY_TOKENS` stays false in production (the gateway refuses it): the
reset mail is the way back. Switching forward again refuses the local sessions, and Identity sign-ins reach the same
accounts.

## Local development

The SCORETech Identity lab runs locally at its pinned revision and needs nothing from this request:
[lab/identity/README.md](../../lab/identity/README.md).

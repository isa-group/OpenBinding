# Request to SCORETech Identity: the OpenBinding OIDC clients

OpenBinding will sign people in through SCORETech Identity, the same way SPHERE and SPACE do (`AUTH_PROVIDER=scoretech`,
issuer `https://sphere.score.us.es/identity/auth/realms/score`, authorization code with PKCE S256, `state` and `nonce`).
The gateway is the confidential client (a backend for the frontend): the browser never holds an Identity token. Nothing
in OpenBinding needs to change for this request; it is configuration on the Identity side only. Local development uses
the SCORETech Identity lab (`./lab up`) and needs nothing from this request.

CAS and local accounts stay until the Identity work (F5) replaces them.

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

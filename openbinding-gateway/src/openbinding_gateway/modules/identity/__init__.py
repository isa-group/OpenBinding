"""Identity: who a person is, how they sign in, and the browser sessions that prove it.

The gateway is the backend-for-frontend of SCORETech Identity (``AUTH_PROVIDER=scoretech``): it runs the
OIDC authorization-code flow with PKCE, keeps the Identity refresh token encrypted on the server and gives the
browser only an opaque HttpOnly cookie. ``AUTH_PROVIDER=local`` keeps OpenBinding's own accounts for
development, labs and rollback. See docs/IDENTITY.md.
"""

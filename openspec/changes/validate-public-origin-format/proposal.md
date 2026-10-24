# Change: validate-public-origin-format

## Why

The lab deployments now take their public origin from one operator setting (`DEMO_PUBLIC_ORIGIN`, commit 98c82b9)
and pass it to the gateway as `PUBLIC_BASE_URL`, `FRONTEND_URL` and an entry of `CORS_ALLOW_ORIGINS`. Today the
gateway reads all three as free text: a typo such as a path (`https://host/app`), a trailing `/` on a CORS entry or a
wildcard sub-domain (`https://*.example.org`) starts without complaint, and the failure shows up later as broken CAS
redirects, broken password-reset links or browsers silently refused by CORS. A value carrying credentials
(`https://user:password@host`) would also be echoed wherever the value is logged.

Owner request (task brief): "at startup the gateway validates PUBLIC_BASE_URL, FRONTEND_URL … and every entry of
CORS_ALLOW_ORIGINS … On a malformed value the gateway MUST refuse to start with an error that names the variable and
the offending value, with any userinfo masked … so a password never reaches the logs."

This supports the production start-up guards already specified in `gateway-api` (`req~gateway-api-cors-production~1`,
`req~gateway-api-production-guards~1`): misconfiguration is refused at start-up with a message that names the
variable, instead of degrading at run time.

## What Changes

- The gateway refuses to start, in every `APP_ENV`, when `PUBLIC_BASE_URL` or `FRONTEND_URL` is not
  `scheme://host[:port]` (http or https, optional bracketed IPv6 host, port 1–65535, no userinfo, path, query or
  fragment), with at most one trailing `/`.
- The gateway refuses to start, in every `APP_ENV`, when an entry of `CORS_ALLOW_ORIGINS` is not exactly `*` and not
  an origin as a browser sends it in `Origin` (same shape, no trailing `/`, no `*`, no whitespace).
- A bare `*` CORS entry stays allowed in `dev` and `test`; `prod` keeps refusing it (`req~gateway-api-cors-production~1`,
  unchanged).
- The start-up error names the variable and the offending value, with any userinfo replaced by `***`
  (`https://***@example.org`).

New requirements (delta `specs/gateway-api/spec.md`):
`req~gateway-api-public-origin-format~1`, `req~gateway-api-cors-origin-format~1`,
`req~gateway-api-origin-error-masking~1`.

## Impact

- Capability: `gateway-api` only (start-up guards). No HTTP endpoint, OpenAPI document, schema or database change.
- Code: `openbinding-gateway/src/openbinding_gateway/core/settings.py` (a shared origin check, `_require_origin`, used by
  the settings validators); tests in `openbinding-gateway/tests/`. Implemented by separate tasks (see `tasks.md`).
- Operators: a deployment whose values were malformed but happened to work (for example `FRONTEND_URL` with a path)
  now stops at start-up with an explicit error. The defaults (`http://localhost:8000`, `http://localhost:5173`, the
  development CORS list) and the lab compose files (`compose.lab*.json`, including an empty `DEMO_PUBLIC_ORIGIN`
  that leaves an empty CORS part) remain valid.
- Risk: low. The check is pure parsing at start-up; the only failure mode is refusing a value that should be accepted,
  which is visible immediately and named in the error.

## Out of scope

- Canonicalising CORS entries (lower-casing, dropping default ports): entries are still compared as exact strings by
  the CORS middleware; see the known limitation in `design.md`.
- Masking credentials in other settings (`DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `SPACE_URL`, …) and in log lines
  outside the start-up error.
- Reachability or DNS checks of the configured hosts, and checks that `PUBLIC_BASE_URL` uses `https` in production.
- The production rules for CORS (`req~gateway-api-cors-production~1`) and the other production guards, which are
  unchanged.

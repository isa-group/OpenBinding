# Design: validate-public-origin-format

## Context

`Settings` (`openbinding-gateway/src/openbinding_gateway/core/settings.py`) holds `public_base_url`, `frontend_url`
and `cors_allow_origins` as plain strings. `public_base_url` builds the CAS callback (`routes/cas.py`), `frontend_url`
builds the CAS return and password-reset links (`routes/cas.py`, `routes/auth.py`, both after `rstrip('/')`), and
`cors_origin_list` (comma split, entries stripped, empty parts dropped) feeds Starlette's `CORSMiddleware`. Start-up
guards are `@model_validator(mode="after")` methods raising `ValueError` with a message that names the variable.

## Decisions

1. **One shared check, `_require_origin(name, value, *, trailing_slash)`.** It parses the value against the grammar of
   `req~gateway-api-public-origin-format~1` and raises `ValueError` naming `name` and the masked value. Called with
   `trailing_slash=True` for `PUBLIC_BASE_URL` and `FRONTEND_URL`, and with `trailing_slash=False` for each CORS entry
   other than a bare `*`.
   - Considered: Pydantic `AnyHttpUrl`/`HttpUrl` field types. Rejected: they normalise the value (add a trailing `/`,
     lower-case the host), accept paths, queries and userinfo, and print the raw input in their errors.
   - Considered: `urllib.parse.urlsplit` alone. Usable as a helper, but it accepts empty hosts, splits ambiguous input
     leniently and raises its own `ValueError` for bad ports; the explicit grammar is what the spec pins, so the
     implementation validates every component itself (a regular expression plus a numeric port check, and
     `ipaddress.IPv6Address` for bracketed hosts, is sufficient).
2. **Every `APP_ENV`.** A malformed origin is never useful in development either (CAS and reset links break the same
   way), so the format check is not limited to `prod`. Only the bare `*` CORS entry is environment-dependent, and
   that rule stays in `closed_cors_in_production` (`req~gateway-api-cors-production~1`, unchanged).
3. **One trailing `/` for URLs, none for CORS entries.** URLs are joined after `rstrip('/')`, so a single `/` is
   harmless and common in operator input; two or more are refused because they usually mean a pasted path. A CORS entry
   is compared with the browser's `Origin` header, which never ends in `/`, so an entry with a `/` could never match.
4. **Host grammar.** A name is one or more ASCII letters, digits, `.` and `-` (DNS names and IPv4 addresses); an IPv6
   address must be bracketed. Internationalised names must be written in their ASCII (punycode) form, which is also
   what browsers send in `Origin`. Underscores and `*` are refused.
5. **Masking rule.** Everything between `://` (or the start of the value) and the *last* `@` of the value becomes `***`.
   Using the last `@` of the whole value rather than of the authority means a password containing `/`, `?` or `#`
   (`https://u:p/ss@host`) is still fully masked; the cost is over-masking a malformed value whose path contains `@`,
   which only shortens an error message.
6. **The whole error text is covered.** Pydantic's `ValidationError` renders `input_value=` next to each error; for a
   settings model that is the raw input and would reprint the unmasked value. The implementation must stop that
   (for example `hide_input_in_errors=True` in `model_config`, or raising the masked error in a way that does not echo
   the input); the masking tests assert on `str()` of the raised exception, not only on the message.

## Known limitation: CORS entries are compared as exact strings

Starlette's `CORSMiddleware` compares the request's `Origin` header with each configured entry as an exact string.
Browsers send the serialised origin: lower-case scheme and host, no default port, no leading zeros in the port. The
format check accepts non-canonical entries that have the right shape, for example `HTTPS://OpenBinding.example.org`,
`https://openbinding.example.org:443` or `http://localhost:05173`; such entries pass start-up but never match any
request. Operators must write CORS entries canonically (lower case, no default port, no zero-padded port). Refusing or
normalising them is a possible follow-up; it is not part of this change because it alters accepted configuration
beyond a format check.

## Risks

- A deployment that relied on a malformed value now stops at start-up. Mitigation: the error names the variable and the
  (masked) value; the defaults and the lab compose files stay valid (an empty `DEMO_PUBLIC_ORIGIN` produces an empty CORS
  part, which is ignored).
- Leaking credentials through another path (for example a log line that prints the settings). Out of scope here; the
  requirement covers the start-up error only.

## Migration

None: no data or API change. Operators correct malformed values when the gateway reports them.

## Open questions

None.

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
   - Chosen: `urllib.parse.urlsplit` as the parser, with explicit checks on top because it alone is lenient. The check
     requires scheme `http` or `https` (`urlsplit` lower-cases it, so case is not significant); a host matched whole by
     `HOST_PATTERN` (`[A-Za-z0-9.-]+` or `\[[0-9A-Fa-f:.]+\]`; a bracketed host must also be an IPv6 literal that
     urllib accepts, and only an optional `:port` may follow the `]`); a port from `urlsplit(...).port` (which raises `ValueError` for a non-number or a
     value out of range) that is not `0`; no empty port (`host:`); no more than one `:` outside brackets (an
     unbracketed IPv6 address); no `@` in the netloc; no path, query or fragment; and none of whitespace, `*`, `,`, `?`
     or `#` anywhere in the value. Any `ValueError` from `urlsplit` counts as malformed. For a URL, one trailing `/` is
     removed before the check.
2. **Every `APP_ENV`.** A malformed origin is never useful in development either (CAS and reset links break the same
   way), so the format check is not limited to `prod`. Only the bare `*` CORS entry is environment-dependent, and
   that rule stays in `closed_cors_in_production` (`req~gateway-api-cors-production~1`, unchanged). Validator order
   matters: `closed_cors_in_production` is declared first and runs first, so a bare `*` in `prod` keeps its own
   message; the new validator `well_formed_public_origins` then skips a bare `*` outside `prod` and accepts an empty
   list (an empty list is refused only in `prod`, by the first validator). A `*` next to a malformed entry is still
   refused, because the other entry is checked.
3. **One trailing `/` for URLs, none for CORS entries.** URLs are joined after `rstrip('/')`, so a single `/` is
   harmless and common in operator input; two or more are refused because they usually mean a pasted path. A CORS entry
   is compared with the browser's `Origin` header, which never ends in `/`, so an entry with a `/` could never match.
4. **Host grammar.** A name is one or more ASCII letters, digits, `.` and `-` (DNS names and IPv4 addresses); an IPv6
   address must be bracketed, and a bracketed host consists of hex digits, `:` and `.` and is an IPv6 literal that urllib accepts. Internationalised
   names must be written in their ASCII (punycode) form, which is also what browsers send in `Origin`. Underscores
   and `*` are refused.
5. **Masking rule.** `_mask_userinfo` takes the text before the *last* `@` of the value; from the first `://` of that
   part (or from the start when it has none) up to the `@`, it becomes `***`. The error shows the masked value with
   `repr()`. Using the last `@` of the whole value rather than of the authority means a password containing `/`, `?` or `#`
   (`https://u:p/ss@host`) is still fully masked; the cost is over-masking a malformed value whose path contains `@`,
   which only shortens an error message.
6. **The whole error text is covered.** Pydantic's `ValidationError` renders `input_value=` next to each error; for a
   settings model that is the raw input and would reprint the unmasked value. `Settings.model_config` sets
   `hide_input_in_errors=True` to stop that; the masking tests assert on `str()` of the raised exception, not only on
   the message.
7. **Dev CORS default in `docker-compose.yml`.** The `:80` entries (`http://localhost:80`, `http://127.0.0.1:80`) were
   dropped from the default of `CORS_ALLOW_ORIGINS_DEV`, which is now
   `http://localhost,http://localhost:5173,http://127.0.0.1,http://127.0.0.1:5173`: a browser omits the default port in
   `Origin`, so the `:80` entries could never match (see the known limitation below).

## Known limitation: CORS entries are compared as exact strings

Starlette's `CORSMiddleware` compares the request's `Origin` header with each configured entry as an exact string.
Browsers send the serialised origin: lower-case scheme and host, no default port, no leading zeros in the port. The
format check accepts non-canonical entries that have the right shape, for example `HTTPS://OpenBinding.example.org`,
`https://openbinding.example.org:443`, `http://localhost:80` or `http://localhost:05173`; such entries pass start-up
but never match any request. The tests do not assert this behaviour. Operators must write CORS entries canonically
(lower case, no default port, no zero-padded port); `docs/ACCOUNTS_AND_PLANS.md` and
`openbinding-gateway/.env.example` describe the accepted shapes. Refusing or
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

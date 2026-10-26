## ADDED Requirements

### Requirement: Public origin format
IF `PUBLIC_BASE_URL` or `FRONTEND_URL` is not a public origin, that is `http` or `https`, `://`, a host, an optional `:port` and an optional single `/`, with no userinfo, path, query or fragment, THEN THE gateway SHALL refuse to start, in every `APP_ENV`.

`req~gateway-api-public-origin-format~1`

Needs: impl, utest

#### Scenario: The public origin shape is exact
- **GIVEN** the value of `PUBLIC_BASE_URL` or `FRONTEND_URL`
- **WHEN** the gateway process reads its settings
- **THEN** the value is a public origin only if it is the whole variable value, with nothing trimmed, made of, in this order:
  1. a scheme `http` or `https` (letter case not significant), followed by `://`;
  2. a host: either a name of one or more ASCII letters, digits, `.` and `-`, or a bracketed host, that is `[`, one or more of the characters `0-9`, `A-F`, `a-f`, `:` and `.`, and `]` (for example `[::1]`); a bracketed host must also be an IPv6 literal that urllib accepts (so `[1.2.3.4]` is refused), and only an optional `:port` may follow the `]` (so `http://[::1]x` is refused);
  3. optionally `:` followed by a port of ASCII digits whose decimal value is between 1 and 65535 inclusive;
  4. optionally one single `/`.
- **AND** consequently a value with userinfo (`@` in the authority), a path other than the single `/`, a query (`?`), a fragment (`#`), two or more trailing `/`, an empty host, an empty port (`host:`), port `0`, a port above 65535 or not a number, an unbracketed IPv6 address (more than one `:` outside brackets), a missing scheme or a scheme other than `http`/`https`, a `*`, a `,` or any whitespace is refused
- **AND** names containing other characters (for example `_`) are refused

#### Scenario: Malformed public base URL refused
- **GIVEN** `APP_ENV=dev` and `PUBLIC_BASE_URL=https://openbinding.example.org/api`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `PUBLIC_BASE_URL`

#### Scenario: Frontend URL with a non-http scheme refused
- **GIVEN** `APP_ENV=test` and `FRONTEND_URL=ftp://openbinding.example.org`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `FRONTEND_URL`

#### Scenario: Port out of range refused
- **GIVEN** `APP_ENV=dev` and `PUBLIC_BASE_URL=http://localhost:65536`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `PUBLIC_BASE_URL`

#### Scenario: Two trailing slashes refused
- **GIVEN** `APP_ENV=dev` and `FRONTEND_URL=https://openbinding.example.org//`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `FRONTEND_URL`

#### Scenario: URL with one trailing slash accepted
- **GIVEN** `APP_ENV=prod`, an otherwise valid production configuration and `PUBLIC_BASE_URL=https://openbinding.example.org/`
- **WHEN** the gateway process reads its settings
- **THEN** start-up succeeds

#### Scenario: Bracketed IPv6 literal with a port accepted
- **GIVEN** `APP_ENV=dev` and `FRONTEND_URL=http://[::1]:5173`
- **WHEN** the gateway process reads its settings
- **THEN** start-up succeeds

#### Scenario: Unbracketed IPv6 address refused
- **GIVEN** `APP_ENV=dev` and `FRONTEND_URL=http://::1:8000`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `FRONTEND_URL`

#### Scenario: URL without a scheme refused
- **GIVEN** `APP_ENV=dev` and `PUBLIC_BASE_URL=openbinding.example.org`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `PUBLIC_BASE_URL`

Evidence: `openbinding-gateway/src/openbinding_gateway/core/settings.py` (`_require_origin`, tagged `[impl->req~gateway-api-public-origin-format~1]`); `openbinding-gateway/tests/test_public_origin.py` (tagged `[utest->req~gateway-api-public-origin-format~1]`)

### Requirement: CORS origin entry format
IF an entry of `CORS_ALLOW_ORIGINS` is neither exactly `*` nor a browser origin, that is `http` or `https`, `://`, a host and an optional `:port`, with no userinfo, path, query, fragment or trailing `/`, THEN THE gateway SHALL refuse to start, in every `APP_ENV`.

`req~gateway-api-cors-origin-format~1`

Needs: impl, utest

#### Scenario: The CORS entry shape is exact
- **GIVEN** the value of `CORS_ALLOW_ORIGINS`
- **WHEN** the gateway process reads its settings
- **THEN** its entries are the comma-separated parts with surrounding whitespace removed; empty parts are ignored, so an empty list passes this check
- **AND** a browser origin has the shape of a public origin (requirement `req~gateway-api-public-origin-format~1`, items 1 to 3) as a browser sends it in the `Origin` request header: it ends after the host or the port, so a trailing `/` is refused, and it contains no `*` and no whitespace
- **AND** the format check does not canonicalise: an entry in upper case, with a default port (`:443`, `:80`) or with a zero-padded port has the right shape and is accepted, but never matches a request (see the known limitation in `design.md`)
- **AND** a bare `*` entry is skipped by this format check outside `prod`; in `prod` the validator `closed_cors_in_production` runs first and refuses it with its own message (`req~gateway-api-cors-production~1`); a `*` next to a malformed entry is refused because the other entry is checked

#### Scenario: CORS entry with a trailing slash refused
- **GIVEN** `APP_ENV=dev` and `CORS_ALLOW_ORIGINS=http://localhost:5173,https://openbinding.example.org/`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `CORS_ALLOW_ORIGINS` and `https://openbinding.example.org/`

#### Scenario: CORS entry containing a wildcard refused in every environment
- **GIVEN** `CORS_ALLOW_ORIGINS=https://*.example.org`
- **WHEN** the gateway process reads its settings with `APP_ENV` set to `dev`, to `test` and to `prod` in turn
- **THEN** start-up fails each time with an error that contains `CORS_ALLOW_ORIGINS`

#### Scenario: CORS entry with a path refused
- **GIVEN** `APP_ENV=test` and `CORS_ALLOW_ORIGINS=https://openbinding.example.org/app`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `CORS_ALLOW_ORIGINS`

#### Scenario: Bare wildcard accepted outside production
- **GIVEN** `CORS_ALLOW_ORIGINS=*`
- **WHEN** the gateway process reads its settings with `APP_ENV` set to `dev` and to `test` in turn
- **THEN** start-up succeeds each time

#### Scenario: Bare wildcard in production keeps its own refusal
- **GIVEN** `APP_ENV=prod`, an otherwise valid production configuration and `CORS_ALLOW_ORIGINS=*`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `CORS_ALLOW_ORIGINS contains '*' while APP_ENV=prod`

#### Scenario: Wildcard next to a malformed entry refused
- **GIVEN** `APP_ENV=dev` and `CORS_ALLOW_ORIGINS=*,https://example.org/app`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `CORS_ALLOW_ORIGINS`

#### Scenario: Empty list accepted outside production
- **GIVEN** `APP_ENV=dev` and `CORS_ALLOW_ORIGINS=` (empty)
- **WHEN** the gateway process reads its settings
- **THEN** start-up succeeds

#### Scenario: Exact origins with surrounding spaces and an empty part accepted
- **GIVEN** `APP_ENV=dev` and `CORS_ALLOW_ORIGINS=http://localhost:5173, http://[::1]:5173,`
- **WHEN** the gateway process reads its settings
- **THEN** start-up succeeds

Evidence: `openbinding-gateway/src/openbinding_gateway/core/settings.py` (`_require_origin`, `well_formed_public_origins`, tagged `[impl->req~gateway-api-cors-origin-format~1]`); `openbinding-gateway/tests/test_public_origin.py` (tagged `[utest->req~gateway-api-cors-origin-format~1]`)

### Requirement: Origin error names the value with userinfo masked
WHEN the gateway refuses to start because `PUBLIC_BASE_URL`, `FRONTEND_URL` or an entry of `CORS_ALLOW_ORIGINS` is malformed, THE gateway SHALL report an error that names the variable and the offending value with the userinfo (the text between `://` and the last `@`) replaced by `***`.

`req~gateway-api-origin-error-masking~1`

Needs: impl, utest

#### Scenario: The masked value and the reported error are exact
- **GIVEN** a malformed `PUBLIC_BASE_URL`, `FRONTEND_URL` or entry of `CORS_ALLOW_ORIGINS`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains the variable name and the offending value in which every character between `://` (or the start of the value when it contains no `://`) and the last `@` of the value is replaced by `***`, and that contains those replaced characters nowhere else
- **AND** the offending value is the whole variable value for `PUBLIC_BASE_URL` and `FRONTEND_URL`, and the malformed entry for `CORS_ALLOW_ORIGINS` (with several malformed entries, the first in list order)
- **AND** the value is shown with `repr()`, so it appears between quotes; a value without `@` is reported unchanged
- **AND** "error" means the complete text of the start-up failure as raised and as printed, not only its first line; pydantic does not echo the input because `Settings` sets `hide_input_in_errors=True`

#### Scenario: Userinfo masked in the error
- **GIVEN** `APP_ENV=dev` and `PUBLIC_BASE_URL=https://admin:s3cr3t-pw@example.org`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `PUBLIC_BASE_URL` and `https://***@example.org`
- **AND** the error text does not contain `s3cr3t-pw`
- **AND** the error text does not contain `admin`

#### Scenario: Userinfo masked in a CORS entry
- **GIVEN** `APP_ENV=dev` and `CORS_ALLOW_ORIGINS=http://localhost:5173,https://ops:hunter2@openbinding.example.org`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `CORS_ALLOW_ORIGINS` and `https://***@openbinding.example.org`
- **AND** the error text does not contain `hunter2`

#### Scenario: Userinfo with reserved characters masked completely
- **GIVEN** `APP_ENV=dev` and `PUBLIC_BASE_URL=https://zed:pa/ss?w@example.org` (the same value as `FRONTEND_URL` or as a CORS entry behaves alike)
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `PUBLIC_BASE_URL` and `https://***@example.org`
- **AND** the error text does not contain `zed`
- **AND** the error text does not contain `pa/ss`

#### Scenario: Value without userinfo reported unchanged
- **GIVEN** `APP_ENV=dev` and `FRONTEND_URL=https://openbinding.example.org/app?x=1`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `FRONTEND_URL` and `https://openbinding.example.org/app?x=1`

Evidence: `openbinding-gateway/src/openbinding_gateway/core/settings.py` (`_mask_userinfo`, `_require_origin`, `hide_input_in_errors=True` in `Settings.model_config`, tagged `[impl->req~gateway-api-origin-error-masking~1]`); `openbinding-gateway/tests/test_public_origin.py` (tagged `[utest->req~gateway-api-origin-error-masking~1]`)

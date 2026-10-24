## ADDED Requirements

### Requirement: Public origin format
IF `PUBLIC_BASE_URL` or `FRONTEND_URL` is not a public origin of the form defined below, THEN THE gateway SHALL refuse to start, in every `APP_ENV`.

`req~gateway-api-public-origin-format~1`

Needs: impl, utest

Evidence: GAP: implemented by a later task in `openbinding-gateway/src/openbinding_gateway/core/settings.py` (`_require_origin`); tests to be tagged `[utest->req~gateway-api-public-origin-format~1]`

A public origin is the whole variable value, with nothing trimmed, made of, in this order:
1. a scheme `http` or `https` (letter case not significant), followed by `://`;
2. a host: either a name of one or more ASCII letters, digits, `.` and `-`, or an IPv6 address enclosed in `[` and `]` (for example `[::1]`);
3. optionally `:` followed by a port of one or more ASCII digits whose decimal value is between 1 and 65535 inclusive;
4. optionally one single `/`.

Consequently a value with userinfo (`user:password@` before the host), a path other than the single `/`, a query (`?`), a fragment (`#`), two or more trailing `/`, an empty host, an empty port, port `0`, a port above 65535 or any whitespace is refused.

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

### Requirement: CORS origin entry format
IF an entry of `CORS_ALLOW_ORIGINS` is neither exactly `*` nor a browser origin of the form defined below, THEN THE gateway SHALL refuse to start, in every `APP_ENV`.

`req~gateway-api-cors-origin-format~1`

Needs: impl, utest

Evidence: GAP: implemented by a later task in `openbinding-gateway/src/openbinding_gateway/core/settings.py` (`_require_origin`); tests to be tagged `[utest->req~gateway-api-cors-origin-format~1]`

Entries are the comma-separated parts of `CORS_ALLOW_ORIGINS` with surrounding whitespace removed; empty parts are ignored. A browser origin has the shape of a public origin (requirement `req~gateway-api-public-origin-format~1`, items 1 to 3) exactly as a browser sends it in the `Origin` request header: it ends after the host or the port, so a trailing `/` is refused, and it contains no `*` and no whitespace. A bare `*` entry passes this format check in every `APP_ENV`; while `APP_ENV` is `prod` it is still refused by `req~gateway-api-cors-production~1`.

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

#### Scenario: Exact origins with surrounding spaces and an empty part accepted
- **GIVEN** `APP_ENV=dev` and `CORS_ALLOW_ORIGINS=http://localhost:5173, http://[::1]:5173,`
- **WHEN** the gateway process reads its settings
- **THEN** start-up succeeds

### Requirement: Origin error names the value with userinfo masked
WHEN the gateway refuses to start because `PUBLIC_BASE_URL`, `FRONTEND_URL` or an entry of `CORS_ALLOW_ORIGINS` is malformed, THE gateway SHALL report an error that contains the variable name and the offending value in which every character between `://` (or the start of the value when it contains no `://`) and the last `@` of the value is replaced by `***`, and that contains those replaced characters nowhere else.

`req~gateway-api-origin-error-masking~1`

Needs: impl, utest

Evidence: GAP: implemented by a later task in `openbinding-gateway/src/openbinding_gateway/core/settings.py` (`_require_origin`); tests to be tagged `[utest->req~gateway-api-origin-error-masking~1]`

The offending value is the whole variable value for `PUBLIC_BASE_URL` and `FRONTEND_URL`, and the malformed entry for `CORS_ALLOW_ORIGINS` (with several malformed entries, the first in list order). A value without `@` is reported unchanged. "Error" means the complete text of the start-up failure as raised and as printed, not only its first line.

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

#### Scenario: Value without userinfo reported unchanged
- **GIVEN** `APP_ENV=dev` and `FRONTEND_URL=https://openbinding.example.org/app?x=1`
- **WHEN** the gateway process reads its settings
- **THEN** start-up fails with an error that contains `FRONTEND_URL` and `https://openbinding.example.org/app?x=1`
